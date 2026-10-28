from __future__ import annotations

from duoplan.handlers import (
    MEMORY_BODY_VIEW_MAX,
    MEMORY_NAME_VIEW_MAX,
    PAGE_SIZE,
    PAGE_TEXT_LIMIT,
    fit_entries,
    memory_entries,
)
from duoplan.services import MEMORY_MAX


def _rows(count: int, name_len: int = 64) -> list[dict]:
    """Худший случай: максимально длинные тела и имена."""
    return [
        {"day": "2026-10-28", "display_name": "И" * name_len, "body": "Б" * MEMORY_MAX}
        for _ in range(count)
    ]


def test_eight_long_entries_fit_into_one_page():
    # Раньше готовый текст обрезался до PAGE_TEXT_LIMIT и записи молча
    # пропадали, а кнопки следующей страницы не было: записей всего 8.
    rendered = fit_entries("Дневник двоих", memory_entries(_rows(PAGE_SIZE)))
    assert len(rendered) == PAGE_SIZE
    text = "Дневник двоих\n\n" + "\n\n".join(rendered)
    assert len(text) <= PAGE_TEXT_LIMIT


def test_long_bodies_are_capped_with_ellipsis():
    entries = memory_entries(_rows(1))
    body = entries[0].split("\n", 1)[1]
    assert len(body) == MEMORY_BODY_VIEW_MAX
    assert body.endswith("…")


def test_short_bodies_pass_through_untouched():
    rows = [{"day": "2026-10-28", "display_name": None, "body": "Маленькая история"}]
    assert memory_entries(rows) == ["2026-10-28 · Один из вас\nМаленькая история"]


def test_fit_entries_stops_before_exceeding_limit():
    entries = ["x" * 100 for _ in range(50)]
    rendered = fit_entries("Заголовок", entries, limit=500)
    assert rendered and len(rendered) < 50
    total = len("Заголовок") + 2 + sum(len(e) + 2 for e in rendered) - 2
    assert total <= 500
    # Следующая запись действительно не поместилась бы.
    assert total + 2 + len(entries[len(rendered)]) > 500


def test_worst_case_page_with_next_is_within_limit():
    # Страница из 8 длинных записей при наличии девятой: кнопка "Дальше"
    # появляется по числу записей, и весь текст обязан влезать в лимит.
    rows = _rows(PAGE_SIZE + 1)
    has_next = len(rows) > PAGE_SIZE
    rendered = fit_entries("Дневник двоих", memory_entries(rows[:PAGE_SIZE]))
    assert has_next
    assert len(rendered) == len(rows[:PAGE_SIZE])
    text = "Дневник двоих\n\n" + "\n\n".join(rendered)
    assert len(text) <= PAGE_TEXT_LIMIT


def test_long_full_name_is_capped_with_ellipsis():
    # full_name = имя + фамилия и длиннее «максимума Telegram» для одного
    # имени: отображаемое имя обязано уложиться в MEMORY_NAME_VIEW_MAX.
    rows = [{"day": "2026-10-28", "display_name": "И" * 129, "body": "Привет"}]
    entry = memory_entries(rows)[0]
    head = entry.split("\n", 1)[0]
    assert len(head) == 10 + len(" · ") + MEMORY_NAME_VIEW_MAX
    assert head.endswith("…")
    # Короткое имя не трогается.
    short = memory_entries([{"day": "2026-10-28", "display_name": "Аня", "body": "х"}])[0]
    assert short.startswith("2026-10-28 · Аня\n")


def test_eight_entries_with_overlong_names_fit_into_one_page():
    # Раньше имя длиннее 64 символов сжимало страницу до 7 записей,
    # а фиксированный offset=page*PAGE_SIZE следующей страницы навсегда
    # терял недопоказанную восьмую запись.
    rendered = fit_entries("Дневник двоих", memory_entries(_rows(PAGE_SIZE, name_len=129)))
    assert len(rendered) == PAGE_SIZE
    text = "Дневник двоих\n\n" + "\n\n".join(rendered)
    assert len(text) <= PAGE_TEXT_LIMIT
    # Восьмая запись страницы остаётся на ней же, а не «переезжает» на следующую.
    assert rendered[-1].startswith("2026-10-28 · ")
