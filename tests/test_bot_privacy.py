"""Приватность личных планов и дат в списках Telegram-бота.

Веб-клиент умеет помечать план/дату личными (is_private=1, автор — created_by).
Бот показывает те же строки в списках, поэтому фильтр должен стоять и здесь:
иначе партнёр прочитает сюрприз в обычном списке.
"""

from __future__ import annotations

import pytest

pytestmark = pytest.mark.asyncio


async def _add_task(service, pair_id: int, title: str, author: int, private: int) -> int:
    return await service.db.execute(
        "INSERT INTO tasks(pair_id, title, created_by, created_at, is_private) VALUES(?, ?, ?, ?, ?)",
        (pair_id, title, author, 1_700_000_000, private),
    )


async def _add_date(service, pair_id: int, title: str, author: int, private: int) -> int:
    return await service.db.execute(
        "INSERT INTO dates(pair_id, title, day, recurs, created_at, created_by, is_private) "
        "VALUES(?, ?, ?, ?, ?, ?, ?)",
        (pair_id, title, "2026-03-02", 1, 1_700_000_000, author, private),
    )


async def test_tasks_list_hides_partner_private_plan(pair):
    service, pair_id, owner, partner = pair
    await _add_task(service, pair_id, "Общий план", owner, 0)
    await _add_task(service, pair_id, "Купить кольцо", owner, 1)

    owner_titles = [row["title"] for row in await service.tasks(pair_id, viewer_id=owner)]
    partner_titles = [row["title"] for row in await service.tasks(pair_id, viewer_id=partner)]

    assert "Купить кольцо" in owner_titles
    assert "Общий план" in partner_titles
    assert "Купить кольцо" not in partner_titles


async def test_dates_list_hides_partner_private_date(pair):
    service, pair_id, owner, partner = pair
    await _add_date(service, pair_id, "Годовщина", owner, 0)
    await _add_date(service, pair_id, "Сюрприз", owner, 1)

    owner_titles = [row["title"] for row in await service.dates(pair_id, viewer_id=owner)]
    partner_titles = [row["title"] for row in await service.dates(pair_id, viewer_id=partner)]

    assert "Сюрприз" in owner_titles
    assert "Годовщина" in partner_titles
    assert "Сюрприз" not in partner_titles


async def test_partner_cannot_complete_private_task(pair):
    service, pair_id, owner, partner = pair
    task_id = await _add_task(service, pair_id, "Купить кольцо", owner, 1)

    assert await service.complete_task(task_id, pair_id, partner) is False
    assert await service.complete_task(task_id, pair_id, owner) is True


async def test_without_viewer_filter_keeps_legacy_behaviour(pair):
    """Служебные вызовы без viewer_id видят всё — старый контракт не сломан."""
    service, pair_id, owner, _ = pair
    await _add_task(service, pair_id, "Купить кольцо", owner, 1)

    assert [row["title"] for row in await service.tasks(pair_id)] == ["Купить кольцо"]
