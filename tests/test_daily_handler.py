from __future__ import annotations

from datetime import date

from duoplan.handlers import game
from duoplan.handlers import game_done
from duoplan.services import DAILY_XP
from duoplan.ui import HOME_MENU
from duoplan.ui import GAME_MENU

# Репорт 2026-10-29: сервис начислял XP каждому партнёру, но до пользователя
# это не доходило — game() показывал HOME_MENU по парному done, и у второго
# партнёра пропадала кнопка «Мы это сделали». Сервисные тесты этого не ловили,
# поэтому здесь вызываются сами обработчики с поддельным CallbackQuery.


class FakeMessage:
    def __init__(self) -> None:
        self.edits: list[tuple[str, object]] = []

    async def edit_text(self, text: str, reply_markup=None) -> None:
        self.edits.append((text, reply_markup))


class FakeUser:
    def __init__(self, user_id: int) -> None:
        self.id = user_id


class FakeCallback:
    def __init__(self, user_id: int, data: str = "") -> None:
        self.from_user = FakeUser(user_id)
        self.data = data
        self.message = FakeMessage()
        self.answers: list[str | None] = []

    async def answer(self, text: str | None = None, **kwargs) -> None:
        self.answers.append(text)

    @property
    def text(self) -> str:
        return self.message.edits[-1][0]

    @property
    def markup(self):
        return self.message.edits[-1][1]


def callbacks(markup) -> list[str]:
    return [button.callback_data for row in markup.inline_keyboard for button in row]


async def test_partner_keeps_done_button_after_owner_marks(pair, monkeypatch):
    service, pair_id, owner_id, partner_id = pair
    monkeypatch.setattr(service, "local_today", lambda at=None: date(2026, 3, 2))
    assert await service.complete_daily(pair_id, owner_id) is True

    call = FakeCallback(partner_id, "menu:game")
    await game(call, service)

    assert "game:done" in callbacks(call.markup), "у партнёра должна остаться кнопка отметки"
    assert call.markup is GAME_MENU
    assert "уже отмечен" not in call.text
    # Формулировка совпадает с Mini App (public/app.js), чтобы поверхности не расходились.
    assert "отметьте и вы" in call.text


async def test_partner_press_awards_xp(pair, monkeypatch):
    service, pair_id, owner_id, partner_id = pair
    monkeypatch.setattr(service, "local_today", lambda at=None: date(2026, 3, 2))
    assert await service.complete_daily(pair_id, owner_id) is True

    call = FakeCallback(partner_id, "game:done")
    await game_done(call, service)

    assert (await service.user(partner_id))["points"] == DAILY_XP
    assert call.answers[-1] == "+10 XP · ритуал отмечен"
    assert call.markup is HOME_MENU
    assert "game:done" not in callbacks(call.markup)


async def test_owner_sees_marked_state(pair, monkeypatch):
    service, pair_id, owner_id, _ = pair
    monkeypatch.setattr(service, "local_today", lambda at=None: date(2026, 3, 2))
    assert await service.complete_daily(pair_id, owner_id) is True

    call = FakeCallback(owner_id, "menu:game")
    await game(call, service)

    assert call.markup is HOME_MENU
    assert "уже отмечен" in call.text


async def test_second_press_does_not_double_xp(pair, monkeypatch):
    service, pair_id, owner_id, partner_id = pair
    monkeypatch.setattr(service, "local_today", lambda at=None: date(2026, 3, 2))

    first = FakeCallback(partner_id, "game:done")
    await game_done(first, service)
    second = FakeCallback(partner_id, "game:done")
    await game_done(second, service)

    assert (await service.user(partner_id))["points"] == DAILY_XP
    assert second.answers[-1] == "Сегодня уже отмечено"
    assert "game:done" not in callbacks(second.markup)


async def test_both_partners_can_mark_and_both_get_xp(pair, monkeypatch):
    """Полный сценарий бага: владелец отметил, партнёр открыл меню и отметил."""
    service, pair_id, owner_id, partner_id = pair
    monkeypatch.setattr(service, "local_today", lambda at=None: date(2026, 3, 2))

    owner_call = FakeCallback(owner_id, "game:done")
    await game_done(owner_call, service)

    partner_menu = FakeCallback(partner_id, "menu:game")
    await game(partner_menu, service)
    assert "game:done" in callbacks(partner_menu.markup)

    partner_call = FakeCallback(partner_id, "game:done")
    await game_done(partner_call, service)

    assert (await service.user(owner_id))["points"] == DAILY_XP
    assert (await service.user(partner_id))["points"] == DAILY_XP
    assert (await service.pair_for(owner_id))["together_pts"] == DAILY_XP * 2
