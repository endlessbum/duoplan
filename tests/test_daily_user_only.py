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

    # Повторное нажатие партнёром не начисляет очки.
    assert await service.complete_daily(pair_id, partner_id) is False
    partner_after = await service.user(partner_id)
    assert partner_after["points"] == 0
    assert (await service.pair_for(owner_id))["together_pts"] == DAILY_XP
