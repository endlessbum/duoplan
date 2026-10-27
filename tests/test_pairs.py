from __future__ import annotations

import asyncio

from duoplan.db.base import connect_database
from duoplan.services import DuoPlanService


async def test_concurrent_join_has_exactly_one_winner(tmp_path):
    path = tmp_path / "race.db"
    first = await connect_database(path)
    second = await connect_database(path)
    try:
        owner = DuoPlanService(first)
        guest = DuoPlanService(second)
        await owner.ensure_user(1, "owner", "Владелец")
        await guest.ensure_user(2, "b", "Гость Б")
        await guest.ensure_user(3, "c", "Гость В")
        code = await owner.create_pair(1, "Владелец")

        results = await asyncio.gather(
            guest.join_pair(2, "Гость Б", code),
            guest.join_pair(3, "Гость В", code),
        )

        assert sorted(results) == [False, True]
        pair = await owner.pair_for(1)
        assert pair["user_b"] in (2, 3)
        members = [await guest.user(2), await guest.user(3)]
        joined = [row for row in members if row["pair_id"] is not None]
        assert len(joined) == 1
        assert joined[0]["tg_id"] == pair["user_b"]
    finally:
        await first.close()
        await second.close()


async def test_empty_pair_owner_cannot_join_another_pair(db):
    service = DuoPlanService(db)
    await service.ensure_user(10, "owner", "Владелец")
    await service.ensure_user(20, "other", "Другой")
    await service.ensure_user(21, "guest", "Гость")

    own_code = await service.create_pair(10, "Владелец")
    other_code = await service.create_pair(20, "Другой")
    assert await service.join_pair(21, "Гость", other_code) is True

    # Вторая (пустая) пара, в которую владелец попытается войти.
    await service.ensure_user(30, "third", "Третий")
    empty_code = await service.create_pair(30, "Третий")

    assert await service.join_pair(10, "Владелец", empty_code) is False

    own = await service.membership(10)
    assert own["code"] == own_code
    assert own["user_b"] == 0
    # Чужая пустая пара осталась без второго участника.
    untouched = await service.membership(30)
    assert untouched["code"] == empty_code
    assert untouched["user_b"] == 0


async def test_create_pair_is_idempotent(db):
    service = DuoPlanService(db)
    await service.ensure_user(1, "a", "A")
    first = await service.create_pair(1, "A")
    second = await service.create_pair(1, "A")
    assert first == second
    rows = await db.query("SELECT id FROM pairs")
    assert len(rows) == 1


async def test_join_rejects_unknown_code_and_own_pair(db):
    service = DuoPlanService(db)
    await service.ensure_user(1, "a", "A")
    code = await service.create_pair(1, "A")
    assert await service.join_pair(1, "A", code) is False
    assert await service.join_pair(2, "B", "NOPE") is False
