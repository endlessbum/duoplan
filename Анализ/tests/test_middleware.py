"""Behavior EnsureUserMiddleware при сбое ``ensure_user``.

Внешний аудит (2026-10-31, п. 3.2): middleware глотал исключение регистрации
и всё равно выполнял обработчик — тот падал вторичной ошибкой без записи
пользователя, маскируя исходный сбой БД. Теперь исключение пробрасывается в
единый обработчик ошибок (dp.errors), обработчик апдейта не выполняется.
"""

from __future__ import annotations

import asyncio
from types import SimpleNamespace

import pytest

from duoplan.middlewares import EnsureUserMiddleware


class FlakyService:
    def __init__(self, fail: bool) -> None:
        self.fail = fail
        self.calls = 0

    async def ensure_user(self, tg_id, username, display_name):
        self.calls += 1
        if self.fail:
            raise RuntimeError("disk I/O error")


async def _run(middleware, service, expect_error: bool):
    calls = []

    async def handler(event, data):
        calls.append(event)

    user = SimpleNamespace(is_bot=False, id=111, username="misha", full_name="Миша")
    if expect_error:
        with pytest.raises(RuntimeError):
            await middleware(handler, "event", {"service": service, "event_from_user": user})
    else:
        await middleware(handler, "event", {"service": service, "event_from_user": user})
    return calls


def test_ensure_user_failure_skips_handler_and_reraises():
    """Сбой регистрации: обработчик не выполняется, исключение уходит выше."""
    middleware = EnsureUserMiddleware()
    service = FlakyService(fail=True)
    calls = asyncio.run(_run(middleware, service, expect_error=True))
    assert service.calls == 1
    assert calls == []


def test_successful_registration_runs_handler():
    """Штатная регистрация: обработчик выполняется как раньше."""
    middleware = EnsureUserMiddleware()
    service = FlakyService(fail=False)
    calls = asyncio.run(_run(middleware, service, expect_error=False))
    assert service.calls == 1
    assert calls == ["event"]


def test_missing_service_or_user_passes_through():
    """Нет service/user (служебные апдейты) — middleware прозрачен."""
    middleware = EnsureUserMiddleware()
    calls = []

    async def handler(event, data):
        calls.append(event)

    asyncio.run(middleware(handler, "event", {"service": None, "event_from_user": None}))
    assert calls == ["event"]
