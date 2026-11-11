"""Выход из пространства и резерв кода за ушедшим (бот, parity worker.js).

Репорт 2026-11-06: у бота не было выхода из пары вовсе — присоединившийся
через бота не мог покинуть пространство; join_pair не знал про
awaiting_return/last_partner и не уведомлял оставшегося о возврате.

Репорт аудита 2026-11-11 (P1): чтение состояния до транзакции оставляло
«зомби»-пару при двух одновременных выходах.
"""

from __future__ import annotations

import asyncio

import pytest

from duoplan.services import DuoPlanService, ValidationError


class Notifier:
    def __init__(self) -> None:
        self.calls: list[tuple[int, str]] = []

    async def __call__(self, chat_id: int, text: str) -> None:
        self.calls.append((chat_id, text))


async def _fill(service: DuoPlanService, pair_id: int, user_id: int) -> None:
    """Минимальный контент, который должен пережить выход одного из пары."""
    await service.add_task(pair_id, "Общий план", user_id)
    await service.add_memory(pair_id, user_id, "Общая запись")


async def test_last_holder_leaves_deletes_everything(db):
    """Одинокий владелец (партнёр не приходил) удаляет пространство целиком."""
    service = DuoPlanService(db)
    await service.ensure_user(1, "owner", "Владелец")
    await service.create_pair(1, "Владелец")
    member = await service.membership(1)
    pair_id = int(member["id"])
    await _fill(service, pair_id, 1)

    assert await service.leave_pair(1) is True
    assert await service.membership(1) is None
    for sql, params in [
        ("SELECT COUNT(*) AS n FROM tasks WHERE pair_id = ?", (pair_id,)),
        ("SELECT COUNT(*) AS n FROM memories WHERE pair_id = ?", (pair_id,)),
        ("SELECT COUNT(*) AS n FROM pairs WHERE id = ?", (pair_id,)),
    ]:
        row = await service.db.one(sql, params)
        assert row["n"] == 0


async def test_partner_leaves_space_stays_and_code_is_reserved(pair):
    service, pair_id, owner_id, partner_id = pair
    await _fill(service, pair_id, partner_id)

    assert await service.leave_pair(partner_id) is True
    row = await service.db.one("SELECT * FROM pairs WHERE id = ?", (pair_id,))
    assert row["user_b"] == 0
    assert row["awaiting_return"] == 1
    assert row["last_partner"] == partner_id
    # Контент остался у владельца.
    tasks = await service.tasks(pair_id, viewer_id=owner_id)
    assert len(tasks) == 1
    # Ушедший отвязан, у оставшегося сброшено личное имя партнёра.
    leaver = await service.user(partner_id)
    assert leaver["pair_id"] is None


async def test_owner_leaves_hands_space_to_partner(pair):
    service, pair_id, owner_id, partner_id = pair
    assert await service.leave_pair(owner_id) is True
    row = await service.db.one("SELECT * FROM pairs WHERE id = ?", (pair_id,))
    assert row["user_a"] == partner_id
    assert row["user_b"] == 0
    assert row["awaiting_return"] == 1
    assert row["last_partner"] == owner_id
    member = await service.user(partner_id)
    assert member["role"] == "a"


async def test_rejoin_by_same_account_notifies_and_clears_reservation(pair):
    service, pair_id, owner_id, partner_id = pair
    await service.leave_pair(partner_id)

    notifier = Notifier()
    assert await service.join_pair(partner_id, "Аня", await _code(service, pair_id), notify=notifier)
    row = await service.db.one("SELECT * FROM pairs WHERE id = ?", (pair_id,))
    assert row["user_b"] == partner_id
    assert row["awaiting_return"] == 0
    assert row["last_partner"] == 0
    assert notifier.calls and notifier.calls[0][0] == owner_id
    assert "снова в вашем пространстве" in notifier.calls[0][1]


async def test_rejoin_by_other_account_is_rejected(pair):
    service, pair_id, _owner_id, partner_id = pair
    await service.leave_pair(partner_id)

    await service.ensure_user(999_999, "other", "Чужой")
    with pytest.raises(ValidationError):
        await service.join_pair(999_999, "Чужой", await _code(service, pair_id))
    # Пространство по-прежнему ждёт прежнего партнёра.
    row = await service.db.one("SELECT awaiting_return, last_partner FROM pairs WHERE id = ?", (pair_id,))
    assert row["awaiting_return"] == 1
    assert row["last_partner"] == partner_id


async def test_first_join_sends_no_notification(db):
    """Первый вход по коду (партнёр не выходил) уведомления не шлёт."""
    service = DuoPlanService(db)
    await service.ensure_user(1, "owner", "Владелец")
    code = await service.create_pair(1, "Владелец")
    await service.ensure_user(777, "guest", "Гость")
    notifier = Notifier()
    assert await service.join_pair(777, "Гость", code, notify=notifier)
    assert notifier.calls == []


async def test_leave_notifies_remaining_partner(pair):
    service, _pair_id, owner_id, partner_id = pair
    notifier = Notifier()
    assert await service.leave_pair(partner_id, notify=notifier)
    assert notifier.calls and notifier.calls[0][0] == owner_id
    assert "больше не в вашем пространстве" in notifier.calls[0][1]


async def _code(service: DuoPlanService, pair_id: int) -> str:
    row = await service.db.one("SELECT code FROM pairs WHERE id = ?", (pair_id,))
    assert row is not None, f"пара {pair_id} не найдена"
    return row["code"]


async def test_frozen_space_rejects_mutations(pair):
    """После выхода партнёра мутации контента отклоняются (parity worker 403)."""
    service, pair_id, owner_id, partner_id = pair
    task_id = await service.add_task(pair_id, "План", owner_id)
    await service.leave_pair(partner_id)

    for operation in (
        lambda: service.add_task(pair_id, "Ещё план", owner_id),
        lambda: service.add_date(pair_id, "Дата", "2026-12-01", 1, owner_id),
        lambda: service.add_memory(pair_id, owner_id, "Запись"),
        lambda: service.add_wish(pair_id, owner_id, "Желание"),
        lambda: service.complete_task(task_id, pair_id, owner_id),
        lambda: service.complete_daily(pair_id, owner_id),
    ):
        with pytest.raises(ValidationError, match="возвращения"):
            await operation()
    # Чтение работает.
    assert len(await service.tasks(pair_id, viewer_id=owner_id)) == 1


async def test_last_holder_writes_closed_code(db):
    """Код удалённого пространства остаётся в closed_codes (parity worker)."""
    service = DuoPlanService(db)
    await service.ensure_user(1, "owner", "Владелец")
    code = await service.create_pair(1, "Владелец")
    assert await service.leave_pair(1)

    closed = await service.db.one("SELECT code FROM closed_codes WHERE code = ?", (code,))
    assert closed is not None

    # Вход по закрытому коду — внятный отказ, а не «код не найден».
    await service.ensure_user(2, "other", "Другой")
    with pytest.raises(ValidationError, match="закрыто"):
        await service.join_pair(2, "Другой", code)


def test_waiting_text_marks_reserved_code():
    from duoplan.handlers import waiting_text

    reserved = waiting_text({"awaiting_return": 1, "code": "ABCD1234"}, "https://t.me/b?start=ABCD1234")
    assert "код действует только для его аккаунта" in reserved
    assert "заморожены" in reserved

    fresh = waiting_text({"awaiting_return": 0, "code": "ABCD1234"}, "")
    assert "Код для партнёра" in fresh
    assert "заморожены" not in fresh


# ------------------------------------------------------- конкуренция (P1 аудита)

async def _assert_links_consistent(service: DuoPlanService) -> None:
    """Нет «зомби»-пар и висячих users.pair_id после конкурирующих выходов."""
    pairs = await service.db.query("SELECT id, user_a, user_b, awaiting_return, last_partner FROM pairs")
    users = await service.db.query("SELECT tg_id, pair_id FROM users")
    member_rows = await service.db.query("SELECT tg_id, pair_id FROM pair_members")
    linked = {int(u["tg_id"]): int(u["pair_id"]) for u in users if u["pair_id"] is not None}
    by_id = {int(p["id"]): p for p in pairs}

    for tg_id, pair_id in linked.items():
        assert pair_id in by_id, f"users.pair_id={pair_id} указывает на несуществующую пару"
        pair = by_id[pair_id]
        assert int(pair["user_a"]) != 0, "пара без владельца"
        assert tg_id in (int(pair["user_a"]), int(pair["user_b"])), (
            f"пользователь {tg_id} привязан к чужой паре {pair_id}"
        )
    for pair_id, pair in by_id.items():
        owner = int(pair["user_a"])
        partner = int(pair["user_b"])
        assert linked.get(owner) == pair_id, "владелец пары не связан с ней"
        if partner:
            assert linked.get(partner) == pair_id, "партнёр пары не связан с ней"
        assert not (int(pair["awaiting_return"]) == 1
                    and int(pair["last_partner"]) == owner), (
            "пара ждёт возвращения собственного владельца"
        )
    for row in member_rows:
        assert linked.get(int(row["tg_id"])) == int(row["pair_id"]), (
            "pair_members расходится с users.pair_id"
        )


@pytest.mark.parametrize(
    ("first", "second"),
    [(1, 2), (2, 1), (1, 1), (2, 2)],
    ids=["владелец+партнёр", "партнёр+владелец", "дважды владелец", "дважды партнёр"],
)
async def test_concurrent_leave_keeps_links_consistent(pair, first, second):
    """Два одновременных выхода не оставляют расхождений users/pairs/pair_members."""
    service, _pair_id, owner_id, partner_id = pair
    leavers = {1: owner_id, 2: partner_id}
    results = await asyncio.gather(
        service.leave_pair(leavers[first]),
        service.leave_pair(leavers[second]),
        return_exceptions=True,
    )
    assert all(result is True or result is False for result in results), results
    await _assert_links_consistent(service)


@pytest.mark.parametrize("who", [1, 2], ids=["владелец", "партнёр"])
async def test_double_leave_of_same_user_succeeds_once(pair, who):
    """Один и тот же пользователь не может выйти из пары дважды."""
    service, _pair_id, owner_id, partner_id = pair
    tg_id = {1: owner_id, 2: partner_id}[who]
    results = await asyncio.gather(service.leave_pair(tg_id), service.leave_pair(tg_id))
    assert sorted(results) == [False, True]
    await _assert_links_consistent(service)


async def test_leave_again_after_finished_returns_false(pair):
    """Повторный выход после завершившейся операции не сообщает об успехе."""
    service, _pair_id, owner_id, _partner_id = pair
    assert await service.leave_pair(owner_id) is True
    assert await service.leave_pair(owner_id) is False
    await _assert_links_consistent(service)
