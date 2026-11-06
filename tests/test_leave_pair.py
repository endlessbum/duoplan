"""Выход из пространства и резерв кода за ушедшим (бот, parity worker.js).

Репорт 2026-11-06: у бота не было выхода из пары вовсе — присоединившийся
через бота не мог покинуть пространство; join_pair не знал про
awaiting_return/last_partner и не уведомлял оставшегося о возврате.
"""

from __future__ import annotations

import pytest

from duoplan.services import DuoPlanService
from duoplan.services import ValidationError


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
    code = await service.create_pair(1, "Владелец")
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
    service, pair_id, owner_id, partner_id = pair
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
    service, pair_id, owner_id, partner_id = pair
    notifier = Notifier()
    assert await service.leave_pair(partner_id, notify=notifier)
    assert notifier.calls and notifier.calls[0][0] == owner_id
    assert "больше не в вашем пространстве" in notifier.calls[0][1]


async def _code(service: DuoPlanService, pair_id: int) -> str:
    row = await service.db.one("SELECT code FROM pairs WHERE id = ?", (pair_id,))
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
    member = await service.membership(1)
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
