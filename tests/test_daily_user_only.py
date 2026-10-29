import asyncio
from datetime import date

from duoplan.db.base import connect_database
from duoplan.services import DAILY_XP
from duoplan.services import DuoPlanService


async def test_daily_awards_only_pressing_user(pair, monkeypatch):
    service, pair_id, owner_id, partner_id = pair
    monkeypatch.setattr(service, "local_today", lambda at=None: date(2026, 3, 2))

    assert await service.complete_daily(pair_id, owner_id) is True

    owner = await service.user(owner_id)
    partner = await service.user(partner_id)
    current = await service.pair_for(owner_id)

    assert owner["points"] == DAILY_XP
    assert partner["points"] == 0
    assert current["together_pts"] == DAILY_XP

    # Партнёр тоже может отметить ритуал в тот же день — и получает XP.
    assert await service.complete_daily(pair_id, partner_id) is True
    partner_after = await service.user(partner_id)
    assert partner_after["points"] == DAILY_XP
    assert (await service.pair_for(owner_id))["together_pts"] == DAILY_XP * 2


async def test_daily_done_is_per_user_not_per_pair(pair, monkeypatch):
    """done относится к пользователю: у второго партнёра кнопка должна остаться.

    Репорт 2026-10-29: daily() считал done по паре, поэтому после отметки
    первого партнёра второй видел «уже отмечено» и не мог забрать свои XP,
    хотя complete_daily() начисляет их каждому.
    """
    service, pair_id, owner_id, partner_id = pair
    monkeypatch.setattr(service, "local_today", lambda at=None: date(2026, 3, 2))

    empty = await service.daily(pair_id, partner_id)
    assert empty["done"] is False
    assert empty["partner_done"] is False
    assert empty["completed_count"] == 0

    assert await service.complete_daily(pair_id, owner_id) is True

    owner_view = await service.daily(pair_id, owner_id)
    partner_view = await service.daily(pair_id, partner_id)
    assert owner_view["done"] is True
    assert owner_view["partner_done"] is False
    assert partner_view["done"] is False, "второй партнёр ещё не отмечал"
    assert partner_view["partner_done"] is True
    assert partner_view["completed_count"] == 1
    # Действие дня общее для пары, различается только отметка.
    assert owner_view["action"] == partner_view["action"]
