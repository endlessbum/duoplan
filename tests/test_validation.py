from __future__ import annotations

import pytest

from duoplan.services import (
    DATE_TITLE_MAX,
    MEMORY_MAX,
    TASK_TITLE_MAX,
    WISH_COMMENT_MAX,
    WISH_MAX,
    WISH_URL_MAX,
    ValidationError,
    normalize_code,
)


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


async def test_wish_comment_is_optional_and_limited(pair):
    """Уточнение к подарку сохраняется, пустое пишется NULL, лимит 500."""
    service, pair_id, owner_id, _ = pair

    wish_id = await service.add_wish(pair_id, owner_id, "Плед", comment="Серый, 150×200")
    row = await service.db.one("SELECT comment FROM wishes WHERE id = ?", (wish_id,))
    assert row["comment"] == "Серый, 150×200"

    empty_id = await service.add_wish(pair_id, owner_id, "Плед", comment="   ")
    row = await service.db.one("SELECT comment FROM wishes WHERE id = ?", (empty_id,))
    assert row["comment"] is None

    with pytest.raises(ValidationError, match="Уточнение"):
        await service.add_wish(
            pair_id, owner_id, "Плед", comment="x" * (WISH_COMMENT_MAX + 1)
        )
    assert await service.add_wish(
        pair_id, owner_id, "Плед", comment="x" * WISH_COMMENT_MAX
    ) > 0
    # Список желаний отдаёт уточнение клиенту без отдельного запроса.
    wishes = await service.wishes(pair_id)
    assert any(w["comment"] == "Серый, 150×200" for w in wishes)


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


def test_normalize_code_trims_and_uppercases_only():
    assert normalize_code(None) == ""
    assert normalize_code(" abcd1234 ") == "ABCD1234"
    # Внутренние пробелы больше не склеиваются: worker такой код отклонит,
    # и бот должен вести себя так же (см. normalize_code).
    assert normalize_code("AB CD EFGH") == "AB CD EFGH"


async def test_wish_url_requires_parseable_http(pair):
    """Паритет с worker (wishUrl): корректный http(s) адрес, не просто префикс."""
    service, pair_id, owner_id, _ = pair

    with pytest.raises(ValidationError):
        await service.add_wish(pair_id, owner_id, "Желание", "http://")
    with pytest.raises(ValidationError):
        await service.add_wish(pair_id, owner_id, "Желание", "https:// нет хоста")
    with pytest.raises(ValidationError):
        await service.add_wish(pair_id, owner_id, "Желание", "javascript:alert(1)")

    wish_id = await service.add_wish(pair_id, owner_id, "Желание", "http://example.com/a?b=1")
    row = await service.db.one("SELECT url FROM wishes WHERE id = ?", (wish_id,))
    assert row["url"] == "http://example.com/a?b=1"


async def test_add_date_stores_creator(pair):
    """created_by обязателен: без него бот-дата навсегда created_by=0 —
    ни приватность в приложении, ни авторство, ни экспорт «только мои»."""
    service, pair_id, owner_id, _ = pair
    date_id = await service.add_date(pair_id, "Годовщина", "2026-02-01", 1, owner_id)
    row = await service.db.one("SELECT created_by FROM dates WHERE id = ?", (date_id,))
    assert row["created_by"] == owner_id
