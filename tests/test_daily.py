from __future__ import annotations

import asyncio
from datetime import date

from duoplan.db.base import connect_database
from duoplan.services import DAILY_XP
from duoplan.services import DuoPlanService


async def test_concurrent_daily_charges_xp_once(tmp_path, monkeypatch):
    path = tmp_path / "daily.db"
    first = await connect_database(path)
    second = await connect_database(path)
    fixed = date(2026, 3, 2)
    try:
        owner = DuoPlanService(first)
        partner = DuoPlanService(second)
        monkeypatch.setattr(owner, "local_today", lambda at=None: fixed)
        monkeypatch.setattr(partner, "local_today", lambda at=None: fixed)

        await owner.ensure_user(1, "a", "A")
        await owner.ensure_user(2, "b", "B")
        code = await owner.create_pair(1, "A")
        assert await owner.join_pair(2, "B", code)
        pair = await owner.pair_for(1)

        results = await asyncio.gather(
            owner.complete_daily(pair["id"], 1),
            partner.complete_daily(pair["id"], 1),
        )

        assert sorted(results) == [False, True]
        user = await owner.user(1)
        pair_after = await owner.pair_for(1)
        assert user["points"] == DAILY_XP
        assert pair_after["together_pts"] == DAILY_XP
        roll = await owner.db.one(
            "SELECT done_by FROM daily_rolls WHERE pair_id = ? AND day = ?",
            (pair["id"], fixed.isoformat()),
        )
        assert roll["done_by"] == 1
    finally:
        await first.close()
        await second.close()


async def test_daily_sees_completion_that_landed_during_race(tmp_path, monkeypatch):
    """Гонка: пока daily() вставляет запись, другой обработчик завершает ритуал.

    Раньше обратное чтение брало только daily_value и жёстко возвращало
    done=False, даже если done_by уже выставлен.
    """
    path = tmp_path / "daily-race.db"
    first = await connect_database(path)
    second = await connect_database(path)
    fixed = date(2026, 3, 2)
    try:
        owner = DuoPlanService(first)
        partner = DuoPlanService(second)
        monkeypatch.setattr(owner, "local_today", lambda at=None: fixed)
        monkeypatch.setattr(partner, "local_today", lambda at=None: fixed)

        await owner.ensure_user(1, "a", "A")
        await owner.ensure_user(2, "b", "B")
        code = await owner.create_pair(1, "A")
        assert await owner.join_pair(2, "B", code)
        pair = await owner.pair_for(1)

        original_execute = owner.db.execute

        async def execute_with_completion(sql, params=()):
            result = await original_execute(sql, params)
            if "INSERT INTO daily_rolls" in sql:
                # Ровно между вставкой daily() и её обратным чтением
                # другой обработчик завершает ритуал.
                assert await partner.complete_daily(pair["id"], 2) is True
            return result

        monkeypatch.setattr(owner.db, "execute", execute_with_completion)

        daily = await owner.daily(pair["id"])
        assert daily["done"] is True
        assert daily["action"]
    finally:
        await first.close()
        await second.close()


async def test_second_daily_tap_does_not_double_xp(pair, monkeypatch):
    service, pair_id, owner_id, _ = pair
    monkeypatch.setattr(service, "local_today", lambda at=None: date(2026, 3, 2))

    assert await service.complete_daily(pair_id, owner_id) is True
    assert await service.complete_daily(pair_id, owner_id) is False

    user = await service.user(owner_id)
    current = await service.pair_for(owner_id)
    assert user["points"] == DAILY_XP
    assert current["together_pts"] == DAILY_XP


async def test_daily_uses_local_day_and_streak(pair, monkeypatch):
    service, pair_id, owner_id, _ = pair

    monkeypatch.setattr(service, "local_today", lambda at=None: date(2026, 3, 1))
    daily = await service.daily(pair_id)
    assert daily["day"] == "2026-03-01"
    assert await service.complete_daily(pair_id, owner_id) is True
    assert (await service.user(owner_id))["streak"] == 1

    monkeypatch.setattr(service, "local_today", lambda at=None: date(2026, 3, 2))
    assert await service.complete_daily(pair_id, owner_id) is True
    user = await service.user(owner_id)
    assert user["streak"] == 2
    assert user["best_streak"] == 2
    assert user["points"] == DAILY_XP * 2
