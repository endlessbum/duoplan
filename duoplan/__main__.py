from __future__ import annotations

import asyncio
import logging

from aiogram import Bot
from aiogram import Dispatcher
from aiogram.types import BotCommand
from aiogram.types import ErrorEvent

from duoplan.config import load_settings
from duoplan.db.base import connect_database
from duoplan.fsm import SQLiteStorage
from duoplan.handlers import router
from duoplan.middlewares import EnsureUserMiddleware
from duoplan.services import DuoPlanService

log = logging.getLogger(__name__)

WEBHOOK_HINT = (
    "Для этого BOT_TOKEN уже установлен webhook ({url}).\n"
    "Long polling не запускаю: одновременно webhook и polling конфликтуют (Telegram 409) "
    "и ломают Cloudflare Worker / Mini App.\n"
    "Если бот должен работать локально, сначала снимите webhook (deleteWebhook), "
    "иначе используйте Worker."
)


async def on_error(event: ErrorEvent) -> bool:
    log.exception("Ошибка обработки обновления", exc_info=event.exception)
    return True


async def main() -> int:
    settings = load_settings()
    if not settings.is_configured:
        raise RuntimeError("Укажите BOT_TOKEN в файле .env")

    bot = Bot(token=settings.bot_token)
    db = None
    try:
        db = await connect_database(settings.db_path)
        service = DuoPlanService(db, tz=settings.tz)
        storage = SQLiteStorage(db, ttl=settings.fsm_ttl)
        await storage.cleanup()

        dp = Dispatcher(storage=storage)
        dp["service"] = service
        dp["settings"] = settings
        dp.message.outer_middleware(EnsureUserMiddleware())
        dp.callback_query.outer_middleware(EnsureUserMiddleware())
        dp.include_router(router)
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
            ]
        )
        log.info(
            "DuoPlan запущен · зона %s · база %s",
            settings.tz_name,
            settings.db_path,
        )
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
