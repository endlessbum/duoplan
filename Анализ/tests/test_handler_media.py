from __future__ import annotations

from duoplan import handlers


class FakeUser:
    def __init__(self, user_id: int) -> None:
        self.id = user_id


class FakeMessage:
    """Минимальная замена Message: без текста, как фото или стикер."""

    def __init__(self, user_id: int) -> None:
        self.text = None
        self.from_user = FakeUser(user_id)
        self.answers: list[str] = []

    async def answer(self, text: str, reply_markup=None) -> None:
        self.answers.append(text)


class FakeState:
    def __init__(self) -> None:
        self.cleared = False

    async def clear(self) -> None:
        self.cleared = True


async def test_media_in_task_state_gets_reply_instead_of_crash(pair):
    service, _, owner_id, _ = pair
    message = FakeMessage(owner_id)
    state = FakeState()

    await handlers.receive_task(message, service, state)

    assert message.answers
    assert "текст" in message.answers[0].lower()
    assert state.cleared is False


async def test_media_in_date_state_does_not_crash():
    message = FakeMessage(1)
    state = FakeState()

    await handlers.receive_date_title(message, state)

    assert message.answers
    assert state.cleared is False


async def test_media_in_any_form_state_gets_hint():
    message = FakeMessage(1)
    await handlers.receive_non_text(message)
    assert "текст" in message.answers[0].lower()
