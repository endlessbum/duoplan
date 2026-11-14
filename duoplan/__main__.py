from __future__ import annotations

import asyncio
import logging
import traceback
from datetime import datetime

from aiogram import Bot, Dispatcher
from aiogram.exceptions import TelegramAPIError
from aiogram.types import BotCommand, ErrorEvent

from duoplan.config import load_settings
from duoplan.db.base import connect_database
from duoplan.fsm import SQLiteStorage
from duoplan.handlers import router
from duoplan.middlewares import EnsureUserMiddleware, PrivateBotMiddleware
from duoplan.services import DuoPlanService

# Фло: напоминания по расписанию.
from duoplan import cycle as flo  # noqa: E402

log = logging.getLogger(__name__)


async def cycle_reminder_tick(db, bot, service) -> None:
    """Один тик напоминаний Фло: текущее время в поясе сервиса → отправка → чистка."""
    now = datetime.now(service.tz)
    await flo.send_cycle_reminders(
        db,
        lambda tg_id, text: bot.send_message(tg_id, text),
        # owners уже несут u.timezone из JOIN — отдельный запрос не нужен.
        lambda tg_id: None,
        now,
    )
    await flo.prune_old_notifications(db, days=7)


async def cycle_reminder_loop(db, bot, service) -> None:
    while True:
        try:
            await cycle_reminder_tick(db, bot, service)
        except Exception:
            log.exception("cycle_reminder_loop failed")
        await asyncio.sleep(60)

WEBHOOK_HINT = (
    "Для этого BOT_TOKEN уже установлен webhook ({url}).\n"
    "Long polling не запускаю: одновременно webhook и polling конфликтуют (Telegram 409) "
    "и ломают Cloudflare Worker / Mini App.\n"
    "Если бот должен работать локально, сначала снимите webhook (deleteWebhook), "
    "иначе используйте Worker."
)


async def main() -> int:
    settings = load_settings()
    if not settings.is_configured:
        raise RuntimeError("Укажите BOT_TOKEN в файле .env")

    bot = Bot(token=settings.bot_token)
    db = None
    try:
        db = await connect_database(settings.db_path)
        service = DuoPlanService(db, tz=settings.tz, tz_name=settings.tz_name)
        storage = SQLiteStorage(db, ttl=settings.fsm_ttl)
        await storage.cleanup()

        dp = Dispatcher(storage=storage)
        dp["service"] = service
        dp["settings"] = settings
        # Приватный гейт (OWNER_IDS + код приглашения) — первым: отказ уже
        # не доходит до ensure_user, т.е. чужие не пишут в users.
        dp.message.outer_middleware(PrivateBotMiddleware())
        dp.callback_query.outer_middleware(PrivateBotMiddleware())
        dp.message.outer_middleware(EnsureUserMiddleware())
        dp.callback_query.outer_middleware(EnsureUserMiddleware())
        dp.include_router(router)

        async def on_error(event: ErrorEvent) -> bool:
            log.exception("Ошибка обработки обновления", exc_info=event.exception)
            chat_id = settings.admin_chat_id
            if chat_id is not None:
                try:
                    tb = "".join(
                        traceback.format_exception(
                            type(event.exception), event.exception, event.exception.__traceback__
                        )
                    )
                    text = "⚠️ Ошибка обработки обновления:\n" + tb
                    if len(text) > 4000:
                        text = text[:4000] + "…"
                    await bot.send_message(chat_id, text)
                except TelegramAPIError:
                    # Ошибка отправки отчёта не должна порождать новый цикл
                    # обработки ошибок — только запись в лог.
                    log.exception("Не удалось отправить ошибку в админ-чат")
            return True

        dp.errors.register(on_error)

        info = await bot.get_webhook_info()
        if info.url:
            log.error(WEBHOOK_HINT.format(url=info.url))
            return 2

        await bot.set_my_commands(
            [
                BotCommand(command="menu", description="Наше пространство"),
                BotCommand(command="cancel", description="Отменить ввод"),
                BotCommand(command="help", description="Как работает DuoPlan"),
                BotCommand(command="flo", description="Фло — трекер цикла"),
                BotCommand(command="flo_log", description="Дневник дня Фло"),
                BotCommand(command="flo_settings", description="Настройки Фло"),
                BotCommand(command="flo_partner", description="Вид партнёра Фло"),
            ]
        )
        log.info(
            "DuoPlan запущен · зона %s · база %s",
            settings.tz_name,
            settings.db_path,
        )
        # Фоновая задача: напоминания Фло раз в минуту (аналог cron в worker.js).
        asyncio.create_task(cycle_reminder_loop(db, bot, service))
        await dp.start_polling(bot)
        return 0
    finally:
        # Сессия и база закрываются всегда: и при ошибке, и при остановке polling.
        await bot.session.close()
        if db is not None:
            await db.close()


def run() -> int:
    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s %(levelname)s %(name)s: %(message)s",
    )
    return asyncio.run(main())


if __name__ == "__main__":
    raise SystemExit(run())
