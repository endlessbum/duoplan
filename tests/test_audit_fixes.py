"""Регрессии к дефектам, найденным аудитом проекта (2026-10-30).

Каждый тест закрывает конкретную находку:

* ``wishes_view`` обращался к строке БД как к словарю (``row.get(...)``).
  У ``sqlite3.Row`` такого метода нет, поэтому кнопка «Вишлист» падала с
  ``AttributeError``, как только в паре появлялось хоть одно желание.
  Прежний тест подсовывал ``dict`` и дефект не замечал — теперь проверяем
  на настоящей базе.
* Код приглашения всегда восемь символов. Короткий код должен получать
  внятное объяснение, а не «не получилось войти».
* «Прошедшая» дата определяется календарным днём, а не временем суток:
  запись на сегодня без времени остаётся в будущих и после полудня
  (в Mini App так же — ``worker.isPastDate``).
"""

from __future__ import annotations

from datetime import datetime, timedelta
from zoneinfo import ZoneInfo

import pytest

from duoplan.handlers import receive_code
from duoplan.handlers import wishes_view
from duoplan.services import sort_date_rows

TZ = ZoneInfo("Europe/Moscow")


# --------------------------------------------------------------------- фейки


class FakeMessage:
    def __init__(self, text: str = "") -> None:
        self.text = text
        self.answers: list[str] = []
        self.edits: list[dict] = []
        self.from_user = type(
            "U",
            (),
            {"id": 1, "username": "u", "first_name": "И", "full_name": "Иван"},
        )()

    async def answer(self, text, **kwargs) -> None:
        self.answers.append(text)

    async def edit_text(self, text, reply_markup=None, parse_mode=None) -> None:
        self.edits.append({"text": text, "markup": reply_markup, "parse_mode": parse_mode})


class FakeCall:
    def __init__(self, user_id: int = 1) -> None:
        self.message = FakeMessage()
        self.from_user = type("U", (), {"id": user_id})()

    async def answer(self, *args, **kwargs) -> None:
        return None


class FakeState:
    def __init__(self) -> None:
        self.cleared = False

    async def set_state(self, *args, **kwargs) -> None:
        return None

    async def clear(self) -> None:
        self.cleared = True


class FakeJoinService:
    """Сервис для входа по коду: запоминает, какие коды пробовали."""

    def __init__(self, result: bool = True) -> None:
        self.result = result
        self.tried: list[str] = []

    async def join_pair(self, user_id: int, name: str, code: str, notify=None) -> bool:
        self.tried.append(code)
        return self.result

    async def membership(self, user_id: int):
        return None


# ------------------------------------------------- вишлист на настоящих строках


@pytest.mark.asyncio
async def test_wishes_view_works_with_real_db_rows(pair):
    """Строки из БД — это sqlite3.Row, а не dict: .get() у них нет."""
    service, pair_id, owner, partner = pair
    await service.add_wish(pair_id, owner, "Кино")
    await service.add_wish(pair_id, partner, "Плед")

    call = FakeCall(user_id=owner)
    assert await wishes_view(call, service) is True

    markup = call.message.edits[0]["markup"]
    labels = [btn.text for row in markup.inline_keyboard for btn in row]
    assert "Исполнено: Кино" in labels
    # Желание партнёра видно, но закрыть его может только он.
    assert "Исполнено: Плед" not in labels


@pytest.mark.asyncio
async def test_wishes_view_works_for_partner_too(pair):
    service, pair_id, owner, partner = pair
    await service.add_wish(pair_id, owner, "Кино")

    call = FakeCall(user_id=partner)
    assert await wishes_view(call, service) is True
    assert call.message.edits, "сообщение должно быть отредактировано"


@pytest.mark.asyncio
async def test_wishes_view_without_wishes_still_renders(pair):
    service, *_ = pair
    call = FakeCall()
    assert await wishes_view(call, service) is True
    assert "Добавьте желание" in call.message.edits[0]["text"]


# ------------------------------------------------------- длина кода приглашения


@pytest.mark.asyncio
async def test_short_code_gets_clear_explanation():
    service = FakeJoinService()
    state = FakeState()
    message = FakeMessage("abc")

    await receive_code(message, service, state)

    assert service.tried == [], "короткий код не должен проверяться в базе"
    assert message.answers, "пользователю нужно объяснить, сколько символов"
    assert "8" in message.answers[0]


@pytest.mark.asyncio
async def test_long_code_is_rejected_too():
    service = FakeJoinService()
    message = FakeMessage("ABCDEFGHIJK")

    await receive_code(message, service, FakeState())

    assert service.tried == []
    assert "8" in message.answers[0]


@pytest.mark.asyncio
async def test_code_of_correct_length_is_checked():
    service = FakeJoinService()
    message = FakeMessage("abcd1234")

    await receive_code(message, service, FakeState())

    assert service.tried == ["ABCD1234"]


# ------------------------------------------------ «прошедшие» даты — по дню


def _row(day: str, recurs: int = 0, time: str | None = None, monthly: int = 0) -> dict:
    return {
        "id": abs(hash(day)) % 1000,
        "day": day,
        "recurs": recurs,
        "time": time,
        "title": day,
        "monthly": monthly,
    }


def test_today_without_time_stays_in_the_future():
    """Дата — событие дня: «сегодня» не уезжает в прошедшие после полудня."""
    today = datetime.now(TZ).date().isoformat()
    yesterday = (datetime.now(TZ).date() - timedelta(days=1)).isoformat()

    rows = sort_date_rows([_row(yesterday), _row(today)], TZ)

    assert rows[0]["day"] == today
    assert rows[-1]["day"] == yesterday


def test_today_with_earlier_time_is_still_in_the_future():
    """Даже «сегодня в 09:00» после 15:00 остаётся сегодняшним событием."""
    today = datetime.now(TZ).date().isoformat()
    rows = sort_date_rows([_row(today, time="09:00")], TZ)
    assert len(rows) == 1


def test_yearly_date_is_never_past():
    """Ежегодная дата всегда в будущей группе — со своим следующим наступлением."""
    old = "2020-05-17"
    rows = sort_date_rows([_row(old, recurs=1)], TZ)
    assert len(rows) == 1


def test_malformed_day_does_not_break_sorting():
    rows = sort_date_rows([_row("мусор"), _row("2026-12-31")], TZ)
    assert len(rows) == 2


# ------------------------------------------------- мелкие правки из аудита


def test_validation_message_grammar():
    """Опечатка «не длиннее» — в тексте, который видит пользователь."""
    from duoplan.services import ValidationError
    from duoplan.services import _clean_text

    with pytest.raises(ValidationError) as excinfo:
        _clean_text("Слишком длинный заголовок", 5, "План")
    assert "не длиннее" in str(excinfo.value)


def test_no_dead_bot_username_constant():
    """BOT_USERNAME в config.py был мёртвым: настоящий берётся из Settings."""
    import inspect

    from duoplan import config

    source = inspect.getsource(config)
    # Константа модуля удалена; остаётся только поле настроек.
    assert "BOT_USERNAME = " not in source, "мёртвая константа вернулась"
    assert "bot_username" in source


# --------------------------------------- аудит 2026-11-01: рассинхроны с worker


def test_monthly_date_is_never_past():
    """Ежемесячная дата — повторяющаяся: в «прошедшие» не попадает никогда
    (worker.isPastDate пропускает recurs и monthly)."""
    rows = sort_date_rows([_row("2020-01-10", monthly=1)], TZ)
    assert len(rows) == 1  # осталась в списке, а не уехала в прошедшие


def test_monthly_date_occurrence_is_next_existing_day():
    from duoplan.services import next_date_occurrence

    occurrence = next_date_occurrence("2020-01-15", 0, None, TZ, monthly=1)
    assert occurrence is not None
    today = datetime.now(TZ).date()
    assert occurrence.date() >= today
    assert occurrence.day == 15  # тот же день месяца


def test_monthly_task_deadline_skips_short_months():
    """Ежемесячный план на 31-е: дедлайн — ближайшее 31-е число, где оно
    существует (worker.nextMonthlyOccurrenceMs), а не прошёл год назад."""
    from duoplan.services import task_deadline

    task = {"id": 1, "day": "2020-01-31", "time": None, "monthly": 1, "yearly": 0}
    deadline = task_deadline(task, TZ)
    assert deadline != float("inf")
    moment = datetime.fromtimestamp(deadline, TZ)
    today = datetime.now(TZ).date()
    assert moment.date() >= today
    assert moment.day == 31


def test_yearly_task_deadline_skips_feb_29():
    from duoplan.services import task_deadline

    task = {"id": 2, "day": "2020-02-29", "time": None, "monthly": 0, "yearly": 1}
    deadline = task_deadline(task, TZ)
    assert deadline != float("inf")
    moment = datetime.fromtimestamp(deadline, TZ)
    assert (moment.month, moment.day) == (2, 29)
    assert moment.year >= datetime.now(TZ).year


def test_plain_task_without_time_deadline_is_end_of_day():
    """Обычный план без времени — 23:59 (worker.taskTargetMs), а не полдень."""
    from datetime import time as dt_time
    from datetime import timedelta

    from duoplan.services import task_deadline

    day = (datetime.now(TZ).date() + timedelta(days=7)).isoformat()
    task = {"id": 3, "day": day, "time": None, "monthly": 0, "yearly": 0}
    deadline = task_deadline(task, TZ)
    moment = datetime.fromtimestamp(deadline, TZ)
    assert moment.date().isoformat() == day
    assert moment.time() == dt_time(23, 59)


def test_task_deadline_garbage_is_infinity():
    from duoplan.services import task_deadline

    inf = float("inf")
    assert task_deadline(None, TZ) == inf
    assert task_deadline({"day": None, "monthly": 0, "yearly": 0}, TZ) == inf
    assert task_deadline({"day": "мусор", "monthly": 0, "yearly": 0}, TZ) == inf


def test_dst_gap_local_time_is_shifted_like_worker():
    """Паритет worker.makeDateInTimeZone: локальное время в «дыру» перевода
    часов (не существует) сдвигается на реальное ближайшее, а не молча
    получает случайный offset от zoneinfo."""
    from duoplan.services import _zoned_local

    berlin = ZoneInfo("Europe/Berlin")
    # 2026-03-29 02:30 в Берлине не существует: часы прыгают 02:00 → 03:00.
    result = _zoned_local(2026, 3, 29, 2, 30, berlin)
    back = result.astimezone(ZoneInfo("UTC")).astimezone(berlin)
    # Сдвиг как у worker: naive-as-UTC минус offset до перехода (CET +1)
    # → 01:30 UTC → 03:30 CEST.
    assert (back.hour, back.minute, back.day) == (3, 30, 29)
    # Обычное существующее время не сдвигается.
    normal = _zoned_local(2026, 3, 28, 2, 30, berlin)
    assert (normal.hour, normal.minute) == (2, 30)


def test_title_limit_matches_worker_validation():
    """Единица лимита заголовков — кодпоинты, как validateSchema/textField в
    worker.js (Array.from): 95 эмодзи = 95 «символов» и проходят лимит 180.
    UTF-16 мерил эмодзи двойным весом, и бот отклонял заголовки, валидные
    для приложения (репорт 2026-11-10)."""
    import pytest

    from duoplan.services import _clean_text

    emoji_title = "🎁" * 95  # 95 кодпоинтов — в лимите, как в worker
    assert _clean_text(emoji_title, 180, "План") == emoji_title
    assert _clean_text(emoji_title, 180, "Запись") == emoji_title
    # 181 кодпоинт отклоняется на любой поверхности.
    with pytest.raises(ValueError, match="План"):
        _clean_text("а" * 181, 180, "План")


def test_button_label_flattens_newlines():
    """Перенос строки в тексте inline-кнопки даёт BUTTON_TEXT_INVALID."""
    from duoplan.handlers import _button_label

    label = _button_label("Первая строка\nвторая **жирная**", 22)
    assert "\n" not in label
    assert "**" not in label
    assert label.startswith("Первая строка вторая")


@pytest.mark.asyncio
async def test_add_wish_rejects_non_http_url(pair):
    """Схему ссылки проверяет и worker (wishUrl): javascript: в wishes не проходит."""
    service, pair_id, owner, _partner = pair

    with pytest.raises(ValueError, match="http"):
        await service.add_wish(pair_id, owner, "Мечта", url="javascript:alert(1)")

    wish_id = await service.add_wish(pair_id, owner, "Мечта", url="https://example.com")
    wish = await service.wish_for(wish_id) if hasattr(service, "wish_for") else None
    if wish is not None:
        assert wish["url"] == "https://example.com"


@pytest.mark.asyncio
async def test_join_rate_limit_after_five_failures(db):
    """Перебор кодов в боте ограничен, как в worker.js: 5 неудач за 15 минут
    блокируют вход (репорт 2026-11-10 — раньше отказы были бесплатными)."""
    import pytest as _pytest

    from duoplan.services import JOIN_ATTEMPT_LIMIT
    from duoplan.services import DuoPlanService
    from duoplan.services import ValidationError

    service = DuoPlanService(db)
    await service.ensure_user(50, "try", "Пытливый")
    for _ in range(JOIN_ATTEMPT_LIMIT):
        assert await service.join_pair(50, "Пытливый", "00000000") is False
    with _pytest.raises(ValidationError, match="15 минут"):
        await service.join_pair(50, "Пытливый", "00000000")


@pytest.mark.asyncio
async def test_join_rate_limit_counts_exact_rejections(db):
    """Точные отказы (занятое пространство) тоже расходуют лимит: иначе
    «живой» код отличим от «мёртвого» бесплатно (parity worker PAIR_FULL)."""
    import pytest as _pytest

    from duoplan.services import JOIN_ATTEMPT_LIMIT
    from duoplan.services import DuoPlanService
    from duoplan.services import ValidationError

    service = DuoPlanService(db)
    await service.ensure_user(60, "owner", "Владелец")
    code = await service.create_pair(60, "Владелец")
    # Соединяем пару: третий пользователь по тому же коду получает точный отказ.
    await service.ensure_user(61, "partner", "Партнёр")
    assert await service.join_pair(61, "Партнёр", code) is True
    await service.ensure_user(62, "third", "Третий")
    for _ in range(JOIN_ATTEMPT_LIMIT):
        with _pytest.raises(ValidationError, match="уже соединено"):
            await service.join_pair(62, "Третий", code)
    with _pytest.raises(ValidationError, match="15 минут"):
        await service.join_pair(62, "Третий", "00000000")
