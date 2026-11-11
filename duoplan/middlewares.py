"""Сквозные middleware для сообщений и callback-кнопок."""

from __future__ import annotations

import logging
import re
from collections.abc import Awaitable, Callable
from typing import Any

from aiogram import BaseMiddleware, Bot
from aiogram.exceptions import TelegramAPIError
from aiogram.types import TelegramObject, User

from duoplan.config import Settings
from duoplan.services import DuoPlanService

log = logging.getLogger(__name__)

PRIVATE_BOT_DENIED_TEXT = (
    "Это приватный бот DuoPlan — доступ по приглашению.\n\n"
    "Попросите владельца прислать ссылку-приглашение (t.me/<бот>?start=КОД) "
    "и откройте её: через неё вы войдёте в общее пространство."
)

# /start@botname тоже несёт код приглашения: Telegram доставляет упоминание
# и в личке (например, при ответе из группы), и без ветки с @ код терялся.
_START_WITH_PAYLOAD_RE = re.compile(r"^/start(?:@[A-Za-z0-9_]+)?(?:\s+(.*))?$", re.IGNORECASE)


class PrivateBotMiddleware(BaseMiddleware):
    """Гейт приватного бота: OWNER_IDS + вход по приглашению.

    Активен только когда в настройках задан ``OWNER_IDS`` (Telegram-ID
    владельца, через запятую — несколько). Пока переменная пуста, бот работает
    как раньше: без гейта.

    Разрешённые пути:
    - владелец из ``OWNER_IDS`` — полный доступ;
    - уже зарегистрированный пользователь (есть в ``users``) — полный доступ
      (пришёл через свою собственную ссылку-приглашение ранее);
    - незарегистрированный — только ``/start <код>`` с кодом открытой пары
      (это и есть ссылка-приглашение, которую отправляет владелец партнёру).

    Для незарегистрированного валидный код проверяется через
    ``service.open_pair_for_code``; пока код не подтвердил вход, пользователь
    НЕ регистрируется (``EnsureUserMiddleware`` после него не доходит), поэтому
    посторонний не оставляет записей в базе.

    Аудит 2026-11-11 (P2): между проверкой кода здесь и ``join_pair`` в
    обработчике пара могла заполниться (гонка). Тогда ``EnsureUserMiddleware``
    уже создавал строку в ``users``, и пользователь навсегда проходил гейт как
    «известный», не будучи в паре. Теперь после обработчика строка удаляется,
    если вход так и не состоялся. Политика «зарегистрирован = доступ»
    сохраняется: вышедшие из пары и владельцы доступа не теряют.
    """

    async def __call__(
        self,
        handler: Callable[[TelegramObject, dict[str, Any]], Awaitable[Any]],
        event: TelegramObject,
        data: dict[str, Any],
    ) -> Any:
        settings: Settings | None = data.get("settings")
        service: DuoPlanService | None = data.get("service")
        user: User | None = data.get("event_from_user")
        if (
            settings is None
            or not settings.owner_ids
            or user is None
            or user.is_bot
            or user.id in settings.owner_ids
        ):
            return await handler(event, data)
        # Групповые чаты игнорируем молча: бот для пар, приватный гейт
        # группового флуда не касается, а отказ в общий чат — спам.
        chat = data.get("event_chat")
        if chat is not None and getattr(chat, "type", None) != "private":
            return None
        if service is None:
            return await handler(event, data)

        known = await service.user(user.id)
        if known is not None:
            return await handler(event, data)

        payload = ""
        text = getattr(event, "text", None)
        if isinstance(text, str):
            match = _START_WITH_PAYLOAD_RE.match(text.strip())
            if match and match.group(1):
                payload = match.group(1).strip()

        if not payload or await service.open_pair_for_code(payload, tg_id=user.id) is None:
            bot: Bot | None = data.get("bot")
            chat = getattr(event, "chat", None)
            chat_id = getattr(chat, "id", None)
            if bot is not None and isinstance(chat_id, int):
                try:
                    await bot.send_message(chat_id, PRIVATE_BOT_DENIED_TEXT)
                except TelegramAPIError as exc:
                    # Отказ — лучшая попытка: пользователь мог заблокировать бота.
                    log.info(
                        "PrivateBotMiddleware: не удалось отправить отказ пользователю %s: %s",
                        user.id,
                        exc,
                    )
            return None

        # Допустили по валидному коду. EnsureUserMiddleware создаст строку в
        # users, но если join_pair проиграл гонку, она не должна остаться:
        # иначе следующий апдейт пройдёт гейт по ветке «уже известный».
        try:
            return await handler(event, data)
        finally:
            await self._drop_unconfirmed(service, user.id)

    @staticmethod
    async def _drop_unconfirmed(service: DuoPlanService, tg_id: int) -> None:
        """Убрать users-строку, созданную при несостоявшемся входе по коду.

        Удаляем только если пользователь так и не стал участником пары —
        успешно вошедшие, вышедшие из пары и владельцы не затрагиваются.
        """
        await service.db.execute_row(
            "DELETE FROM users WHERE tg_id = ? AND pair_id IS NULL "
            "AND NOT EXISTS(SELECT 1 FROM pair_members WHERE tg_id = ?)",
            (tg_id, tg_id),
        )


class EnsureUserMiddleware(BaseMiddleware):
    """Гарантирует строку ``users`` до входа в обработчик.

    Раньше регистрация вызывалась вручную и не покрывала старые кнопки после
    очистки базы: обработчик получал ``None`` вместо пользователя.
    """

    async def __call__(
        self,
        handler: Callable[[TelegramObject, dict[str, Any]], Awaitable[Any]],
        event: TelegramObject,
        data: dict[str, Any],
    ) -> Any:
        service: DuoPlanService | None = data.get("service")
        user: User | None = data.get("event_from_user")
        # Сторонние участники групповых чатов в users не попадают:
        # регистрируются только владельцы/приглашённые в личке.
        chat = data.get("event_chat")
        if chat is not None and getattr(chat, "type", None) != "private":
            return await handler(event, data)
        if service is not None and user is not None and not user.is_bot:
            name = user.full_name or user.first_name or "Без имени"
            try:
                await service.ensure_user(user.id, user.username, name)
            except Exception:
                # Сбой регистрации не глотаем: обработчик апдейта не выполняется
                # без записи пользователя, а исключение уходит в единый
                # обработчик ошибок (dp.errors), который залогирует причину
                # и сообщит в админ-чат — вторичная ошибка в бизнес-логике
                # не маскирует исходный сбой БД.
                log.exception("Не удалось зарегистрировать пользователя %s", user.id)
                raise
        return await handler(event, data)
