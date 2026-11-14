"""Регресс P1: цикл напоминаний Фло в duoplan/__main__.py.

Раньше ``datetime`` не был импортирован: ``datetime.now(service.tz)``
падал с NameError внутри try, ошибка глоталась общим except и цикл
каждые 60 секунд повторял ту же ошибку — напоминания не отправлялись.

Тестируем выделенный ``cycle_reminder_tick`` и живучесть
``cycle_reminder_loop`` после исключения.
"""

from __future__ import annotations

from datetime import UTC, datetime
from types import SimpleNamespace
from unittest.mock import AsyncMock
from zoneinfo import ZoneInfo

import pytest

from duoplan import __main__ as main_mod
from duoplan.services import DuoPlanService


async def test_tick_completes_and_prunes_old_notifications(db):
    """Один тик без NameError: send_cycle_reminders + prune_old_notifications."""
    service = DuoPlanService(db, tz=ZoneInfo("Europe/Moscow"), tz_name="Europe/Moscow")
    bot = SimpleNamespace(send_message=AsyncMock())
    await db.execute(
        "INSERT INTO notification_log(tg_id, day, kind, sent_at) VALUES(?,?,?,?)",
        (1, "2020-01-01", "cycle_test", 0),
    )
    await main_mod.cycle_reminder_tick(db, bot, service)
    left = await db.one("SELECT COUNT(*) AS c FROM notification_log")
    assert left["c"] == 0


async def test_tick_passes_tz_aware_now_to_send_cycle_reminders(db, monkeypatch):
    """В flo.send_cycle_reminders уходит timezone-aware datetime (не naive)."""
    seen = {}

    async def fake_send(_db, _send_fn, _tz_getter, now=None):
        seen["now"] = now

    monkeypatch.setattr(main_mod.flo, "send_cycle_reminders", fake_send)
    service = DuoPlanService(db, tz=ZoneInfo("Europe/Moscow"))
    bot = SimpleNamespace(send_message=AsyncMock())
    await main_mod.cycle_reminder_tick(db, bot, service)

    now = seen["now"]
    assert isinstance(now, datetime)
    assert now.tzinfo is not None and now.utcoffset() is not None
    assert now.tzinfo.key == "Europe/Moscow" or now.utcoffset() is not None


async def test_loop_survives_tick_failure_and_retries(db, monkeypatch):
    """Исключение в одном тике не останавливает цикл: следующий тик выполняется."""
    calls = []

    async def flaky_tick(*_args):
        calls.append(1)
        if len(calls) == 1:
            raise RuntimeError("boom")

    class _Stop(Exception):
        pass

    sleeps = 0

    async def fake_sleep(_seconds):
        nonlocal sleeps
        sleeps += 1
        if sleeps >= 2:
            raise _Stop()

    monkeypatch.setattr(main_mod, "cycle_reminder_tick", flaky_tick)
    monkeypatch.setattr(main_mod.asyncio, "sleep", fake_sleep)

    with pytest.raises(_Stop):
        await main_mod.cycle_reminder_loop(db, None, None)
    assert len(calls) == 2
