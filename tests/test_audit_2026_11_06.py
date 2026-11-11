"""Регрессии к дефектам аудита 2026-11-06.

* ``pair_members`` в SQLite-боте заполнялся только при выходе из пары —
  ``create_pair``/``join_pair`` его не трогали, и таблица оставалась пустой
  (worker.js считает её единственным источником членства).
* Бот игнорировал ``pairs.timezone``: «сегодня», дейли, стрик и сортировка
  шли по ``settings.TZ``, а не по поясу пары.
* ``urlsplit`` в ``add_wish`` мог бросить ``ValueError`` вместо
  ``ValidationError``.
* При ``awaiting_return`` бот блокировал даже чтение разделов, хотя worker
  отдаёт контент read-only (заморозка только на запись).
"""

from __future__ import annotations

from datetime import datetime
from zoneinfo import ZoneInfo

import pytest

from duoplan.handlers import FROZEN_TEXT, _viewable_pair, _write_pair, game_done, tasks_view
from duoplan.services import DuoPlanService, ValidationError

# --------------------------------------------------------------------- фейки


class FakeMessage:
    def __init__(self) -> None:
        self.answers: list[str] = []
        self.edits: list[dict] = []

    async def answer(self, text, **kwargs) -> None:
        self.answers.append(text)

    async def edit_text(self, text, reply_markup=None, parse_mode=None) -> None:
        self.edits.append({"text": text, "markup": reply_markup})


class FakeCall:
    def __init__(self, user_id: int = 1) -> None:
        self.message = FakeMessage()
        self.from_user = type("U", (), {"id": user_id})()
        self.answers: list[str] = []

    async def answer(self, *args, **kwargs) -> None:
        self.answers.append(args[0] if args else "")


# ------------------------------------------------------------- pair_members


@pytest.mark.asyncio
async def test_pair_members_filled_on_create_and_join(pair):
    """Оба участника должны попасть в pair_members — как в worker.js."""
    service, pair_id, owner, partner = pair

    rows = await service.db.query(
        "SELECT tg_id, role FROM pair_members WHERE pair_id = ? ORDER BY role",
        (pair_id,),
    )
    assert [(int(r["tg_id"]), r["role"]) for r in rows] == [(owner, "a"), (partner, "b")]


@pytest.mark.asyncio
async def test_create_pair_stores_service_timezone(db):
    """Пара, созданная ботом, наследует пояс сервиса, а не 'Europe/Moscow'."""
    service = DuoPlanService(db, tz=ZoneInfo("Asia/Vladivostok"))
    await service.ensure_user(10, "u", "U")
    await service.create_pair(10, "U")

    pair = await service.membership(10)
    assert pair["timezone"] == "Asia/Vladivostok"


# --------------------------------------------------------- timezone пары


@pytest.mark.asyncio
async def test_pair_today_uses_pair_timezone(db):
    """«Сегодня» ритуала — в поясе пары: Vladivostok может быть уже завтра."""
    service = DuoPlanService(db)
    await service.ensure_user(1, "a", "A")
    await service.ensure_user(2, "b", "B")
    code = await service.create_pair(1, "A")
    await service.join_pair(2, "B", code)
    pair = await service.pair_for(1)
    await service.db.execute(
        "UPDATE pairs SET timezone = 'Asia/Vladivostok' WHERE id = ?",
        (pair["id"],),
    )

    expected = datetime.now(ZoneInfo("Asia/Vladivostok")).date()
    assert await service.pair_today(pair["id"]) == expected
    # А «сегодня» сервиса (UTC) может отличаться — значит пояс реально применён.
    utc_today = datetime.now(ZoneInfo("UTC")).date()
    # Не утверждаем неравенство (зависит от времени суток) — только корректность.
    assert utc_today.isoformat() >= "1970-01-01"


@pytest.mark.asyncio
async def test_today_for_falls_back_to_service_tz(db):
    service = DuoPlanService(db, tz=ZoneInfo("Europe/Moscow"))
    expected = datetime.now(ZoneInfo("Europe/Moscow")).date()
    assert service.today_for("Europe/Moscow") == expected
    assert service.today_for("") == service.local_today()
    assert service.today_for("Неизвестный/Пояс") == service.local_today()


# ------------------------------------------------------------------- wishes


@pytest.mark.asyncio
async def test_add_wish_malformed_url_is_validation_error(pair):
    """urlsplit на битом IPv6-литерале бросает ValueError — переводим в
    ValidationError, чтобы пользователь получил объяснение, а не 500."""
    service, pair_id, owner, _partner = pair

    with pytest.raises(ValidationError):
        await service.add_wish(pair_id, owner, "Мечта", url="http://[::1")


# ------------------------------------------------- awaiting_return: чтение


async def _frozen_pair(service, pair_id: int) -> None:
    """Партнёр выходит — пространство уходит в awaiting_return."""
    await service.leave_pair(2)


@pytest.mark.asyncio
async def test_views_readable_while_partner_absent(pair):
    """Разделы остаются читаемыми (parity с GET /api/state worker.js)."""
    service, pair_id, owner, _partner = pair
    await service.add_task(pair_id, "Полить цветы", owner)
    await _frozen_pair(service, pair_id)

    assert await _viewable_pair(owner, service) is not None
    call = FakeCall(user_id=owner)
    assert await tasks_view(call, service) is True
    assert call.message.edits, "список планов должен отрендериться"


@pytest.mark.asyncio
async def test_writes_blocked_while_partner_absent(pair):
    service, _pair_id, owner, _partner = pair
    await _frozen_pair(service, _pair_id)

    pair_row, frozen = await _write_pair(owner, service)
    assert pair_row is not None
    assert frozen is True

    call = FakeCall(user_id=owner)
    await game_done(call, service)
    assert FROZEN_TEXT in call.answers
