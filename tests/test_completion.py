from __future__ import annotations


async def test_task_completion_is_idempotent_and_keeps_author(pair):
    service, pair_id, owner_id, partner_id = pair
    task_id = await service.add_task(pair_id, "Сходить в кино", owner_id)

    assert await service.complete_task(task_id, pair_id, owner_id) is True
    first = await service.db.one("SELECT * FROM tasks WHERE id = ?", (task_id,))
    assert first["status"] == "done"
    assert first["completed_by"] == owner_id

    # Повторный тап партнёра не перезаписывает completed_by.
    assert await service.complete_task(task_id, pair_id, partner_id) is False
    second = await service.db.one("SELECT * FROM tasks WHERE id = ?", (task_id,))
    assert second["completed_by"] == owner_id


async def test_task_from_other_pair_cannot_be_completed(pair):
    service, pair_id, owner_id, _ = pair
    await service.ensure_user(99, "stranger", "Чужой")
    await service.create_pair(99, "Чужой")
    stranger_pair = await service.membership(99)
    task_id = await service.add_task(pair_id, "Наш план", owner_id)

    assert await service.complete_task(task_id, stranger_pair["id"], 99) is False


async def test_wish_completion_is_idempotent(pair):
    service, pair_id, owner_id, _ = pair
    wish_id = await service.add_wish(pair_id, owner_id, "Поехать к морю")

    assert await service.complete_wish(wish_id, pair_id) is True
    assert await service.complete_wish(wish_id, pair_id) is False
