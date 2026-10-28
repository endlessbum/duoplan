from datetime import date

from duoplan.services import DAILY_XP
from duoplan.services import DuoPlanService


async def test_daily_same_day_press_preserves_streak(pair, monkeypatch):
    service, pair_id, owner_id, _ = pair
    monkeypatch.setattr(service, "local_today", lambda at=None: date(2026, 3, 2))

    assert await service.complete_daily(pair_id, owner_id) is True
    first = await service.user(owner_id)
    assert first["streak"] == 1

    # Повторное нажатие в тот же день не должно сбрасывать серию.
    assert await service.complete_daily(pair_id, owner_id) is False
    second = await service.user(owner_id)
    assert second["streak"] == 1
    assert second["points"] == DAILY_XP
