"""Сквозные middleware для сообщений и callback-кнопок."""

from __future__ import annotations

import logging
from typing import Any, Awaitable, Callable

from aiogram import BaseMiddleware
from aiogram.types import TelegramObject
from aiogram.types import User

from duoplan.services import DuoPlanService

log = logging.getLogger(__name__)


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
            except Exception:  # pragma: no cover - защита от падения апдейта
                log.exception("Не удалось зарегистрировать пользователя %s", user.id)
        return await handler(event, data)
