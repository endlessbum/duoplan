from __future__ import annotations

import pytest

from duoplan.handlers import parse_date_input, parse_tail


def test_parse_tail_handles_current_and_legacy_callbacks():
    assert parse_tail("task:done:5:2", "task:done:") == (5, 2)
    assert parse_tail("task:done:5", "task:done:") == (5, 0)
    assert parse_tail("wish:done:12:0", "wish:done:") == (12, 0)


def test_parse_tail_rejects_garbage():
    assert parse_tail(None, "task:done:") is None
    assert parse_tail("task:done:abc", "task:done:") is None
    assert parse_tail("task:done:-1:0", "task:done:") is None
    assert parse_tail("task:done:1:2:3", "task:done:") is None
    assert parse_tail("wish:done:1", "task:done:") is None


def test_parse_date_input_two_components_use_current_year():
    assert parse_date_input("31.12", 2026) == "2026-12-31"
    # Однозначные день и месяц остаются допустимыми.
    assert parse_date_input("1.5", 2026) == "2026-05-01"


def test_parse_date_input_feb29_picks_next_leap_year():
    assert parse_date_input("29.02", 2026) == "2028-02-29"
    assert parse_date_input("29.02", 2027) == "2028-02-29"
    assert parse_date_input("29.02", 2028) == "2028-02-29"


def test_parse_date_input_full_date():
    assert parse_date_input("31.12.2024", 2026) == "2024-12-31"


def test_parse_date_input_rejects_short_year():
    # Раньше "31.12.24" сохранялся как 24 год нашей эры.
    with pytest.raises(ValueError):
        parse_date_input("31.12.24", 2026)
    with pytest.raises(ValueError):
        parse_date_input("31.12.202", 2026)
    with pytest.raises(ValueError):
        parse_date_input("31.12.20244", 2026)


def test_parse_date_input_rejects_garbage_and_invalid_dates():
    for raw in ("abc", "31", "31.12.2024.5", "1.1.абвг", "32.01.2026", "31.13.2026", ""):
        with pytest.raises(ValueError):
            parse_date_input(raw, 2026)
