"""FSM-поток добавления даты в боте: шаг «ежегодная?» и подсказка про 29 февраля.

Поток: date_title → date_day → date_recurs → add_date(recurs). До ответа
«да/нет» дата в базе не появляется; нераспознанный ответ переспрашивает.
"""

from __future__ import annotations

from duoplan import handlers
from duoplan.handlers import Form


class FakeUser:
    def __init__(self, user_id: int) -> None:
        self.id = user_id


class FakeMessage:
    def __init__(self, user_id: int, text: str | None = None) -> None:
        self.text = text
        self.from_user = FakeUser(user_id)
        self.answers: list[str] = []

    async def answer(self, text: str, reply_markup=None) -> None:
        self.answers.append(text)


class FakeState:
    """Минимальный FSM-контекст с хранением данных в памяти."""

    def __init__(self) -> None:
        self.data: dict = {}
        self.state = None
        self.cleared = False

    async def update_data(self, **kwargs) -> None:
        self.data.update(kwargs)

    async def get_data(self) -> dict:
        return dict(self.data)

    async def set_state(self, state) -> None:
        self.state = state

    async def clear(self) -> None:
        self.data = {}
        self.state = None
        self.cleared = True


async def _run_title_day_flow(service, user_id: int, day: str = "17.05"):
    state = FakeState()
    await handlers.receive_date_title(FakeMessage(user_id, "Годовщина"), state)
    day_msg = FakeMessage(user_id, day)
    await handlers.receive_date_day(day_msg, service, state)
    return state, day_msg


async def test_date_flow_yes_saves_annual_date(pair):
    service, pair_id, owner_id, _ = pair
    state, day_msg = await _run_title_day_flow(service, owner_id)
    assert state.state == Form.date_recurs
    assert "ежегодно" in day_msg.answers[-1].lower()
    # Дата ещё не сохранена: ждём ответ про ежегодность.
    assert await service.dates(pair_id) == []
    done = FakeMessage(owner_id, "да")
    await handlers.receive_date_recurs(done, service, state)
    assert state.cleared is True
    rows = await service.dates(pair_id)
    assert len(rows) == 1
    assert int(rows[0]["recurs"]) == 1
    assert "Напомню каждый год" in done.answers[-1]


async def test_date_flow_no_saves_one_time_date(pair):
    service, pair_id, owner_id, _ = pair
    state, _ = await _run_title_day_flow(service, owner_id)
    done = FakeMessage(owner_id, "Нет")
    await handlers.receive_date_recurs(done, service, state)
    assert state.cleared is True
    rows = await service.dates(pair_id)
    assert len(rows) == 1
    assert int(rows[0]["recurs"]) == 0
    assert "ежегодного напоминания не будет" in done.answers[-1]


async def test_unrecognized_answer_reasks_without_saving(pair):
    service, pair_id, owner_id, _ = pair
    state, _ = await _run_title_day_flow(service, owner_id)
    maybe = FakeMessage(owner_id, "не знаю")
    await handlers.receive_date_recurs(maybe, service, state)
    assert "да" in maybe.answers[-1].lower() and "нет" in maybe.answers[-1].lower()
    assert state.cleared is False
    assert await service.dates(pair_id) == []
    # После внятного ответа поток завершается успешно.
    done = FakeMessage(owner_id, "да")
    await handlers.receive_date_recurs(done, service, state)
    assert len(await service.dates(pair_id)) == 1


async def test_feb29_gets_leap_year_hint(pair):
    service, _, owner_id, _ = pair
    state, day_msg = await _run_title_day_flow(service, owner_id, day="29.02")
    # В тексте вопроса — предупреждение про високосный год (п.3 улучшений).
    assert "високосный" in day_msg.answers[-1]
    done = FakeMessage(owner_id, "да")
    await handlers.receive_date_recurs(done, service, state)
    assert "Напомню каждый год" in done.answers[-1]


async def test_date_flow_without_pair_clears_state(tmp_path):
    """Пользователь без пары: receive_date_day очищает FSM и отказывает."""
    from duoplan.db.base import connect_database
    from duoplan.services import DuoPlanService

    db = await connect_database(tmp_path / "db.sqlite")
    try:
        service = DuoPlanService(db)
        state, day_msg = await _run_title_day_flow(service, 99)
        # receive_date_title прошёл (пара проверяется позже), но receive_date_day
        # должен был очистить состояние и отказать.
        assert state.cleared is True
        assert "Сначала соедините пространство" in day_msg.answers[-1]
    finally:
        await db.close()
