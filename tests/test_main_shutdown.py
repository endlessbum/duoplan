"""Регресс P2: порядок остановки в duoplan/__main__.py.

Фоновая задача cycle_reminder_loop должна быть отменена и дождаться
завершения ДО закрытия bot.session и db — иначе тик может обратиться
к уже закрытым ресурсам. Тест прогоняет main() с фейковыми зависимостями
и проверяет порядок событий.
"""

from __future__ import annotations

import asyncio
from types import SimpleNamespace
from unittest.mock import AsyncMock
from zoneinfo import ZoneInfo

import pytest

from duoplan import __main__ as main_mod


class _FakeStorage:
    def __init__(self, *_args, **_kwargs):
        pass

    async def cleanup(self):
        pass


class _FakeDispatcher:
    def __init__(self, **_kwargs):
        self._items = {}
        self.message = SimpleNamespace(outer_middleware=lambda _m: None)
        self.callback_query = SimpleNamespace(outer_middleware=lambda _m: None)
        self.errors = SimpleNamespace(register=lambda _f: None)

    def __setitem__(self, key, value):
        self._items[key] = value

    def __getitem__(self, key):
        return self._items[key]

    def include_router(self, _router):
        pass

    async def start_polling(self, _bot):
        # Даём фоновой задаче шанс стартовать, как реальный polling.
        await asyncio.sleep(0)
        return None


async def test_shutdown_cancels_reminder_task_before_closing_resources(
    monkeypatch, tmp_path
):
    events: list[str] = []

    settings = SimpleNamespace(
        is_configured=True,
        bot_token="test-token",
        db_path=str(tmp_path / "test.db"),
        tz=ZoneInfo("Europe/Moscow"),
        tz_name="Europe/Moscow",
        fsm_ttl=3600,
        admin_chat_id=None,
    )
    monkeypatch.setattr(main_mod, "load_settings", lambda: settings)

    class FakeBot:
        def __init__(self, *, token):
            self.token = token
            self.session = SimpleNamespace(
                close=AsyncMock(side_effect=lambda: events.append("session-closed"))
            )

        async def get_webhook_info(self):
            return SimpleNamespace(url=None)

        async def set_my_commands(self, _commands):
            pass

    class FakeDB:
        async def close(self):
            events.append("db-closed")

    async def fake_connect(_path):
        return FakeDB()

    async def fake_reminder_loop(_db, _bot, _service):
        events.append("reminder-started")
        try:
            await asyncio.sleep(3600)
        except asyncio.CancelledError:
            events.append("reminder-cancelled")
            raise

    monkeypatch.setattr(main_mod, "Bot", FakeBot)
    monkeypatch.setattr(main_mod, "connect_database", fake_connect)
    monkeypatch.setattr(main_mod, "DuoPlanService", lambda *a, **k: object())
    monkeypatch.setattr(main_mod, "SQLiteStorage", _FakeStorage)
    monkeypatch.setattr(main_mod, "Dispatcher", _FakeDispatcher)
    monkeypatch.setattr(main_mod, "cycle_reminder_loop", fake_reminder_loop)

    assert await main_mod.main() == 0

    # Задача запущена, отменена и остановлена до закрытия session и db.
    assert events.index("reminder-started") < events.index("reminder-cancelled")
    assert events.index("reminder-cancelled") < events.index("session-closed")
    assert events.index("session-closed") < events.index("db-closed")
