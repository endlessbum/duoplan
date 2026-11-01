"""Сквозные middleware для сообщений и callback-кнопок."""

from __future__ import annotations

import logging
import re
from typing import Any, Awaitable, Callable

from aiogram import BaseMiddleware
from aiogram.types import CallbackQuery
from aiogram.types import Message
from aiogram.types import TelegramObject
from aiogram.types import User

from duoplan.config import Settings
from duoplan.services import DuoPlanService

log = logging.getLogger(__name__)

PRIVATE_BOT_DENIED_TEXT = (
    "Это приватный бот DuoPlan — доступ по приглашению.\n\n"
    "Попросите владельца прислать ссылку-приглашение (t.me/<бот>?start=КОД) "
    "и откройте её: через неё вы войдёте в общее пространство."
)

_START_WITH_PAYLOAD_RE = re.compile(r"^/start(?:\s+(.*))?$", re.IGNORECASE)


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

        if not payload or await service.open_pair_for_code(payload) is None:
            bot: object = data.get("bot")
            chat = getattr(event, "chat", None)
            chat_id = getattr(chat, "id", None)
            if bot is not None and isinstance(chat_id, int):
                try:
                    await bot.send_message(chat_id, PRIVATE_BOT_DENIED_TEXT)
                except Exception:
                    log.info("PrivateBotMiddleware: не удалось отправить отказ пользователю %s", user.id)
            return None

        return await handler(event, data)


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
