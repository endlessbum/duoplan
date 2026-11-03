"""Гейт приватного бота: доступ только у владельца и у приглашённых."""

from __future__ import annotations


from duoplan.config import Settings
from duoplan.db.base import connect_database
from duoplan.middlewares import PrivateBotMiddleware
from duoplan.services import DuoPlanService


class FakeUser:
    def __init__(self, id: int = 42) -> None:
        self.id = id
        self.is_bot = False


class FakeChat:
    id = 42


class FakeMessage:
    def __init__(self, text: str) -> None:
        self.chat = FakeChat()
        self.text = text


class FakeBot:
    sent: list[str] = []

    async def send_message(self, chat_id: int, text: str) -> None:
        self.sent.append(text)


def _middleware(service: DuoPlanService, owner_ids: tuple[int, ...]) -> PrivateBotMiddleware:
    middleware = PrivateBotMiddleware()
    middleware.settings = Settings(
        bot_token="TEST_TOKEN",
        admin_chat_id=None,
        db_path=None,
        bot_name="DuoPlan",
        bot_username="duoplanbot",
        tz_name="UTC",
        owner_ids=owner_ids,
    )
    middleware.service = service
    return middleware


async def _run(middleware: PrivateBotMiddleware, event: object, data: dict) -> bool:
    """False — событие гасится (возвращено None), True — прошло дальше."""
    handled = False

    async def handler(_event: object, _data: dict) -> bool:
        nonlocal handled
        handled = True
        return True

    result = await middleware(handler, event, data)
    return result is True and handled


async def test_open_bot_when_owner_ids_empty(tmp_path) -> None:
    db = await connect_database(tmp_path / "gate.db")
    service = DuoPlanService(db)
    middleware = _middleware(service, owner_ids=())
    allowed = await _run(middleware, FakeMessage("/menu"), {"service": service, "event_from_user": FakeUser()})
    assert allowed
    await db.close()


async def test_owner_is_allowed(tmp_path) -> None:
    db = await connect_database(tmp_path / "gate.db")
    service = DuoPlanService(db)
    middleware = _middleware(service, owner_ids=(42,))
    allowed = await _run(middleware, FakeMessage("/start ABCDEFGH"), {"service": service, "event_from_user": FakeUser(42)})
    assert allowed
    await db.close()


async def test_known_user_is_allowed(tmp_path) -> None:
    db = await connect_database(tmp_path / "gate.db")
    service = DuoPlanService(db)
    await service.ensure_user(42, "u", "User")
    middleware = _middleware(service, owner_ids=(99,))
    allowed = await _run(middleware, FakeMessage("/menu"), {"service": service, "event_from_user": FakeUser(42)})
    assert allowed
    await db.close()


async def test_stranger_without_invite_is_denied(tmp_path) -> None:
    db = await connect_database(tmp_path / "gate.db")
    service = DuoPlanService(db)
    middleware = _middleware(service, owner_ids=(99,))

    handled = False

    async def handler(_event: object, _data: dict) -> None:
        nonlocal handled
        handled = True

    bot = FakeBot()
    result = await middleware(
        handler,
        FakeMessage("/menu"),
        {"service": service, "bot": bot, "settings": middleware.settings, "event_from_user": FakeUser(777)},
    )
    assert not handled
    assert result is None
    assert bot.sent, "чужому пользователю должно отправляться вежливый отказ"
    await db.close()


async def test_stranger_with_open_invite_code_is_allowed(tmp_path) -> None:
    """Вход через /start <код открытой пары> разрешён гейтом."""
    db = await connect_database(tmp_path / "gate.db")
    service = DuoPlanService(db)
    # Пара ещё не закрыта вторым участником — код приглашения действителен.
    await service.ensure_user(7, None, "Owner")
    code = await service.create_pair(7, "Owner")
    assert await service.open_pair_for_code(code) is not None

    middleware = _middleware(service, owner_ids=(99,))
    handled = False

    async def handler(_event: object, _data: dict) -> bool:
        nonlocal handled
        handled = True
        return True

    bot = FakeBot()
    result = await middleware(
        handler,
        FakeMessage(f"/start {code}"),
        {"service": service, "bot": bot, "settings": middleware.settings, "event_from_user": FakeUser(777)},
    )
    assert handled
    assert result is True
    await db.close()


async def test_stranger_with_closed_or_bad_code_is_denied(tmp_path) -> None:
    """Код, которого пары ещё нет (или она уже занята), не открывает вход."""
    db = await connect_database(tmp_path / "gate.db")
    service = DuoPlanService(db)
    # Пара уже получила второго участника: user_b не равен 0.
    await service.ensure_user(7, None, "Owner")
    await service.ensure_user(8, None, "Partner")
    code = await service.create_pair(7, "Owner")
    assert await service.join_pair(8, "Partner", code)

    middleware = _middleware(service, owner_ids=(99,))
    handled = False

    async def handler(_event: object, _data: dict) -> None:
        nonlocal handled
        handled = True

    bot = FakeBot()
    result = await middleware(
        handler,
        FakeMessage(f"/start {code}"),
        {"service": service, "bot": bot, "settings": middleware.settings, "event_from_user": FakeUser(9)},
    )
    assert not handled
    assert result is None
    await db.close()
