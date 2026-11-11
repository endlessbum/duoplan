from __future__ import annotations

import asyncio

import pytest

from duoplan.db.base import connect_database
from duoplan.services import DuoPlanService, ValidationError


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
            return_exceptions=True,
        )

        # Проигравший гонку получает либо False (конфликт UPDATE), либо
        # ValidationError «пространство уже соединено» — зависит от того,
        # увидел ли он user_b победителя в своём SELECT.
        winners = [r for r in results if r is True]
        losers = [r for r in results if r is not True]
        assert len(winners) == 1
        assert len(losers) == 1
        assert losers[0] is False or isinstance(losers[0], ValidationError)
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

    # Владелец уже состоит в паре — вход в чужую отклоняется с объяснением,
    # а не молчаливым False (parity с различимыми ошибками worker.joinPair).
    with pytest.raises(ValidationError, match="уже состоите"):
        await service.join_pair(10, "Владелец", empty_code)

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
    # Уже в паре — точная причина, а не молчаливый False.
    with pytest.raises(ValidationError, match="уже состоите"):
        await service.join_pair(1, "A", code)
    # Свой код при «потерянном» членстве (pair_id обнулён напрямую) —
    # OWN_CODE-ветка parity с worker.joinPair.
    await db.execute_row("UPDATE users SET pair_id = NULL WHERE tg_id = 1")
    with pytest.raises(ValidationError, match="собственный код"):
        await service.join_pair(1, "A", code)
    assert await service.join_pair(2, "B", "NOPE") is False


async def test_reserved_code_requires_exact_last_partner(db):
    """Паритет worker.joinPair: awaiting_return=1 открывает код только
    аккаунту last_partner — в том числе при повреждённом last_partner=0,
    который не должен пропускать чужой вход."""
    service = DuoPlanService(db)
    await service.ensure_user(1, "a", "Владелец")
    await service.ensure_user(2, "b", "Партнёр")
    await service.ensure_user(3, "c", "Посторонний")
    code = await service.create_pair(1, "Владелец")
    assert await service.join_pair(2, "Партнёр", code) is True
    assert await service.leave_pair(2)

    # Партнёр вернулся — резерв снят, третий войти не может: пара уже полная.
    assert await service.join_pair(2, "Партнёр", code) is True
    with pytest.raises(ValidationError, match="уже соединено"):
        await service.join_pair(3, "Посторонний", code)

    # Симулируем повреждённое состояние: awaiting_return=1, last_partner=0.
    # Строгое сравнение с worker'ом отклоняет вход любому, включая ex-партнёра.
    await db.execute_row(
        "UPDATE pairs SET user_b = 0, awaiting_return = 1, last_partner = 0"
    )
    await db.execute_row("UPDATE users SET pair_id = NULL WHERE tg_id = 2")
    with pytest.raises(ValidationError):
        await service.join_pair(2, "Партнёр", code)
    with pytest.raises(ValidationError):
        await service.join_pair(3, "Посторонний", code)
