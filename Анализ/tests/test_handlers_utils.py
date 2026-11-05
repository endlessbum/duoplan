from __future__ import annotations

import pytest

from duoplan.handlers import PAGE_TEXT_LIMIT
from duoplan.handlers import _truncate_utf16
from duoplan.handlers import _utf16_len
from duoplan.handlers import parse_date_input
from duoplan.handlers import parse_tail
from duoplan.handlers import render_list_items


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


def test_truncate_utf16_caps_length_for_astral_characters():
    # Эмодзи — астральные символы: 1 кодопоинт = 2 UTF-16 единицы.
    text = "🎄" * 300  # 300 кодопоинтов = 600 единиц
    truncated = _truncate_utf16(text, 598)
    assert _utf16_len(truncated) <= 598
    # Уложившаяся в лимит строка возвращается как есть.
    assert _truncate_utf16("abc", 10) == "abc"


def test_render_list_items_emoji_tail_stays_within_page_limit():
    # Регрессия: бюджет считался в UTF-16 единицах, а обрезка шла по
    # кодопоинтам — «обрезка» эмодзи-тяжёлого пункта превращалась в no-op,
    # и страница вылезала за PAGE_TEXT_LIMIT (репорт аудита 2026-10-30).
    items = [("1. ", "A" * 3286, ""), ("2. ", "🎄" * 300, " — Партнёр")]
    text = render_list_items(items)
    assert _utf16_len(text) <= PAGE_TEXT_LIMIT


def test_render_list_items_worst_case_cannot_exceed_telegram_4096():
    # Худший случай для Telegram: страница почти заполнена ASCII-пунктами,
    # хвост — желание из 300 эмодзи (600 UTF-16 единиц). Лимит Telegram 4096;
    # раньше страница дотягивалась до ~4200 и editMessageText падал с 400.
    items = [("1. ", "A" * 3286, ""), ("2. ", "🎄" * 300, "")]
    assert _utf16_len(render_list_items(items)) <= 4096


def test_parse_yes_no_recognizes_answers():
    from duoplan.handlers import parse_yes_no

    assert parse_yes_no("да") is True
    assert parse_yes_no("  ДА ") is True
    assert parse_yes_no("давай") is True
    assert parse_yes_no("yes") is True
    assert parse_yes_no("нет") is False
    assert parse_yes_no("No") is False
    assert parse_yes_no("0") is False
    # Не распознанный ответ — None: обработчик переспросит.
    assert parse_yes_no("может быть") is None
    assert parse_yes_no("") is None
    assert parse_yes_no(None) is None
