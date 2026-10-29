from datetime import date

from duoplan.handlers import display_streak


def user(streak=7, last_activity="2026-10-29"):
    return {"streak": streak, "last_activity": last_activity}


TODAY = date(2026, 10, 29)


def test_streak_kept_when_activity_today():
    assert display_streak(user(), TODAY) == 7


def test_streak_kept_when_activity_yesterday():
    assert display_streak(user(last_activity="2026-10-28"), TODAY) == 7


def test_streak_reset_after_missed_day():
    assert display_streak(user(last_activity="2026-10-27"), TODAY) == 0


def test_streak_reset_without_activity():
    assert display_streak(user(last_activity=None), TODAY) == 0


def test_zero_streak_stays_zero():
    assert display_streak(user(streak=0, last_activity=None), TODAY) == 0


def test_streak_reset_on_invalid_date():
    assert display_streak(user(last_activity="not-a-date"), TODAY) == 0


def test_missing_user_is_zero():
    assert display_streak(None, TODAY) == 0
