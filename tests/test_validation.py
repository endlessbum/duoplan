from __future__ import annotations

import pytest

from duoplan.services import DATE_TITLE_MAX
from duoplan.services import MEMORY_MAX
from duoplan.services import TASK_TITLE_MAX
from duoplan.services import WISH_MAX
from duoplan.services import WISH_URL_MAX
from duoplan.services import ValidationError
from duoplan.services import normalize_code


async def test_task_validation_limits(pair):
    service, pair_id, owner_id, _ = pair

    with pytest.raises(ValidationError):
        await service.add_task(pair_id, None, owner_id)
    with pytest.raises(ValidationError):
        await service.add_task(pair_id, "   ", owner_id)
    with pytest.raises(ValidationError):
        await service.add_task(pair_id, "x" * (TASK_TITLE_MAX + 1), owner_id)

    task_id = await service.add_task(pair_id, "x" * TASK_TITLE_MAX, owner_id)
    assert task_id > 0


async def test_memory_and_wish_validation(pair):
    service, pair_id, owner_id, _ = pair

    with pytest.raises(ValidationError):
        await service.add_memory(pair_id, owner_id, None)
    with pytest.raises(ValidationError):
        await service.add_memory(pair_id, owner_id, "x" * (MEMORY_MAX + 1))
    assert await service.add_memory(pair_id, owner_id, "x" * MEMORY_MAX) > 0

    with pytest.raises(ValidationError):
        await service.add_wish(pair_id, owner_id, "")
    with pytest.raises(ValidationError):
        await service.add_wish(pair_id, owner_id, "x" * (WISH_MAX + 1))
    assert await service.add_wish(pair_id, owner_id, "x" * WISH_MAX) > 0

    wish_id = await service.add_wish(pair_id, owner_id, "Поехать к морю", "https://example.com/tickets")
    wish = await service.db.one("SELECT url FROM wishes WHERE id = ?", (wish_id,))
    assert wish["url"] == "https://example.com/tickets"

    with pytest.raises(ValidationError):
        await service.add_wish(pair_id, owner_id, "Поехать к морю", "x" * (WISH_URL_MAX + 1))


async def test_date_validation_and_recurs_default(pair):
    service, pair_id, _, _ = pair

    with pytest.raises(ValidationError):
        await service.add_date(pair_id, "Годовщина", "31.02.2026", 1)
    with pytest.raises(ValidationError):
        await service.add_date(pair_id, "x" * (DATE_TITLE_MAX + 1), "2026-02-01", 1)
    with pytest.raises(ValidationError):
        await service.add_date(pair_id, "Годовщина", None, 1)

    date_id = await service.add_date(pair_id, "Годовщина", "2026-02-01")
    row = await service.db.one("SELECT * FROM dates WHERE id = ?", (date_id,))
    assert row["day"] == "2026-02-01"
    assert row["recurs"] == 1

    once_id = await service.add_date(pair_id, "Разово", "2026-02-02", 0)
    once = await service.db.one("SELECT recurs FROM dates WHERE id = ?", (once_id,))
    assert once["recurs"] == 0


async def test_pagination_returns_all_items(pair):
    service, pair_id, owner_id, _ = pair
    for index in range(5):
        await service.add_task(pair_id, f"План {index}", owner_id)

    first_page = await service.tasks(pair_id, limit=2, offset=0)
    second_page = await service.tasks(pair_id, limit=2, offset=2)
    third_page = await service.tasks(pair_id, limit=2, offset=4)

    assert len(first_page) == 2
    assert len(second_page) == 2
    assert len(third_page) == 1
    ids = {row["id"] for row in (*first_page, *second_page, *third_page)}
    assert len(ids) == 5


def test_normalize_code_handles_media_and_spaces():
    assert normalize_code(None) == ""
    assert normalize_code(" ab cd 12 ") == "ABCD12"
