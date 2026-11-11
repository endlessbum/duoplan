from __future__ import annotations

from datetime import UTC, datetime
from zoneinfo import ZoneInfo

from duoplan.services import DuoPlanService


async def test_local_day_follows_configured_timezone(db):
    service = DuoPlanService(db, tz=ZoneInfo("Europe/Moscow"))

    # 22:30 UTC 1 марта = 01:30 2 марта по Москве.
    assert service.local_today(datetime(2026, 3, 1, 22, 30, tzinfo=UTC)).isoformat() == (
        "2026-03-02"
    )
    # 20:00 UTC 1 марта = 23:00 1 марта по Москве.
    assert service.local_today(datetime(2026, 3, 1, 20, 0, tzinfo=UTC)).isoformat() == (
        "2026-03-01"
    )


async def test_naive_datetime_is_treated_as_utc(db):
    service = DuoPlanService(db, tz=ZoneInfo("Europe/Moscow"))
    assert service.local_today(datetime(2026, 3, 1, 22, 30)).isoformat() == "2026-03-02"
