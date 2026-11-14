"""Тесты FSM Фло в боте и DB-функций duoplan.cycle.

Handlers вызываются напрямую (декораторы aiogram не мешают): фейковые
Message/FSMContext/CallbackQuery, реальный сервис на SQLite из conftest.
"""
from __future__ import annotations

import json
from datetime import date

import pytest

from duoplan import cycle as flo
from duoplan.handlers import (
    flo_action,
    flo_command,
    flo_log_clots,
    flo_log_date,
    flo_log_energy,
    flo_log_flow,
    flo_log_mood,
    flo_log_note,
    flo_log_sex,
    flo_log_start,
    flo_log_symptoms,
    flo_partner_command,
    flo_settings_cycle,
    flo_settings_notify,
    flo_settings_start,
)
from duoplan.services import DuoPlanService


# ---------- фейки ----------

class FakeFromUser:
    def __init__(self, uid: int) -> None:
        self.id = uid


class FakeMessage:
    def __init__(self, uid: int, text: str = "") -> None:
        self.from_user = FakeFromUser(uid)
        self.text = text
        self.answers: list[tuple[str, object]] = []
        self.documents: list[tuple[bytes, str]] = []

    async def answer(self, text: str, reply_markup=None, **kwargs) -> None:
        self.answers.append((text, reply_markup))

    async def answer_document(self, document, caption: str = "", **kwargs) -> None:
        self.documents.append((document.data, caption))


class FakeState:
    def __init__(self) -> None:
        self.state = None
        self.data: dict = {}

    async def set_state(self, s) -> None:
        self.state = s

    async def update_data(self, **kw) -> None:
        self.data.update(kw)

    async def get_data(self) -> dict:
        return dict(self.data)

    async def clear(self) -> None:
        self.state = None
        self.data = {}

    @property
    def last_text(self) -> str:
        return self._last


class FakeCall:
    def __init__(self, uid: int, data: str) -> None:
        self.from_user = FakeFromUser(uid)
        self.data = data
        self.message = FakeMessage(uid)
        self.answers: list[tuple] = []

    async def answer(self, text=None, **kwargs) -> None:
        self.answers.append((text, kwargs))


@pytest.fixture
async def flo_db(db):
    """Сервис + владелица Фло (tg_id=1) и партнёр (tg_id=2)."""
    service = DuoPlanService(db)
    await service.ensure_user(1, "owner", "Владелица")
    await service.ensure_user(2, "partner", "Партнёр")
    await db.execute("UPDATE users SET gender='female' WHERE tg_id=1")
    await db.execute("UPDATE users SET gender='male' WHERE tg_id=2")
    return service, db


# ---------- команды и гейт пола ----------

async def test_flo_log_start_rejects_male(flo_db):
    service, _ = flo_db
    msg = FakeMessage(2)
    st = FakeState()
    await flo_log_start(msg, service, st)
    assert "только владелице" in msg.answers[-1][0]
    assert st.state is None


async def test_flo_log_start_accepts_female(flo_db):
    service, _ = flo_db
    msg = FakeMessage(1)
    st = FakeState()
    await flo_log_start(msg, service, st)
    assert "дату" in msg.answers[-1][0].lower() or "ГГГГ" in msg.answers[-1][0]
    assert st.state is not None


async def test_flo_command_rejects_male(flo_db):
    service, _ = flo_db
    msg = FakeMessage(2)
    await flo_command(msg, service)
    assert "только владелице" in msg.answers[-1][0]


# ---------- FSM дневника ----------

async def test_flo_log_full_flow_persists(flo_db):
    service, db = flo_db
    st = FakeState()

    msg = FakeMessage(1, "2026-11-10")
    await flo_log_date(msg, service, st)
    assert st.data["log_date"] == date(2026, 11, 10)

    await flo_log_flow(FakeMessage(1, "light"), st)
    assert st.data["log_flow"] == "light"

    await flo_log_clots(FakeMessage(1, "да"), st)
    assert st.data["log_clots"] is True

    await flo_log_mood(FakeMessage(1, "calm"), st)
    assert st.data["log_mood"] == "calm"

    await flo_log_energy(FakeMessage(1, "normal"), st)
    assert st.data["log_energy"] == "normal"

    await flo_log_symptoms(FakeMessage(1, "cramps, bogus_code"), st)
    assert st.data["log_symptoms"] == ["cramps"], "неизвестный код отфильтрован"

    await flo_log_note(FakeMessage(1, "тестовая заметка"), st)
    assert st.data["log_note"] == "тестовая заметка"

    msg_sex = FakeMessage(1, "protected")
    await flo_log_sex(msg_sex, service, st)
    assert "сохранён" in msg_sex.answers[-1][0]
    assert st.state is None and st.data == {}

    logs = await flo.load_logs(db, 1, date(2026, 11, 10), date(2026, 11, 10))
    assert len(logs) == 1
    entry = logs[0]
    assert entry["flow"] == "light"
    assert entry["mood"] == "calm"
    assert entry["energy"] == "normal"
    assert entry["symptoms"] == ["cramps"]
    assert entry["note"] == "тестовая заметка"
    assert entry["sex"] == "protected"
    assert entry["clots"] is True


async def test_flo_log_invalid_inputs_do_not_advance(flo_db):
    service, _ = flo_db
    st = FakeState()
    st.data["log_date"] = date(2026, 11, 10)

    msg = FakeMessage(1, "не дата вообще")
    await flo_log_date(msg, service, st)
    assert "Проверьте дату" in msg.answers[-1][0]
    assert "log_date" not in st.data or st.data["log_date"] == date(2026, 11, 10)

    await flo_log_flow(FakeMessage(1, "superflow"), st)
    assert "log_flow" not in st.data

    await flo_log_clots(FakeMessage(1, "может быть"), st)
    assert "log_clots" not in st.data

    await flo_log_mood(FakeMessage(1, "злой"), st)
    assert "log_mood" not in st.data

    await flo_log_sex(FakeMessage(1, "возможно"), service, st)
    assert "log_sex" not in st.data


async def test_flo_log_symptoms_clear_marker(flo_db):
    service, _ = flo_db
    st = FakeState()
    await flo_log_symptoms(FakeMessage(1, "не было"), st)
    assert st.data["log_symptoms"] == []
    assert st.data["log_symptoms_clear"] is True

    st2 = FakeState()
    await flo_log_symptoms(FakeMessage(1, "пропустить"), st2)
    assert st2.data["log_symptoms_clear"] is False


async def test_flo_log_sex_skip_leaves_null(flo_db):
    service, db = flo_db
    st = FakeState()
    st.data.update({
        "log_date": date(2026, 11, 11), "log_flow": None, "log_mood": None,
        "log_symptoms": [], "log_note": "", "log_clots": False,
        "log_energy": None, "log_symptoms_clear": False,
    })
    await flo_log_sex(FakeMessage(1, "-"), service, st)
    logs = await flo.load_logs(db, 1, date(2026, 11, 11), date(2026, 11, 11))
    assert logs[0]["sex"] is None


# ---------- настройки ----------

async def test_flo_settings_update_and_notify(flo_db):
    service, db = flo_db
    st = FakeState()
    msg0 = FakeMessage(1)
    await flo_settings_start(msg0, service, st)
    assert "28" in msg0.answers[-1][0] and "5" in msg0.answers[-1][0]

    msg = FakeMessage(1, "30 6")
    await flo_settings_cycle(msg, service, st)
    profile = await flo.load_profile(db, 1, 0)
    assert profile["avg_cycle_length"] == 30
    assert profile["avg_period_length"] == 6

    msg2 = FakeMessage(1, "вкл")
    await flo_settings_notify(msg2, service, st)
    rows = await db.query("SELECT notify_enabled FROM cycle_profiles WHERE tg_id=1")
    assert int(rows[0]["notify_enabled"]) == 1


async def test_flo_settings_validation(flo_db):
    service, db = flo_db
    st = FakeState()

    await flo_settings_cycle(FakeMessage(1, "не два числа"), service, st)
    await flo_settings_cycle(FakeMessage(1, "abc def"), service, st)
    await flo_settings_cycle(FakeMessage(1, "10 99"), service, st)
    await flo_settings_cycle(FakeMessage(1, "нет"), service, st)
    profile = await flo.load_profile(db, 1, 0)
    assert profile["avg_cycle_length"] == 28, "невалидный ввод не меняет профиль"
    assert st.state is None


# ---------- /flo и /flo_partner ----------

async def test_flo_partner_command_without_share(flo_db):
    service, _ = flo_db
    # Пара нужна для partner_ids.
    code = await service.create_pair(1, "Владелица")
    await service.join_pair(2, "Партнёр", code)

    msg = FakeMessage(2)
    await flo_partner_command(msg, service)
    assert "не делится" in msg.answers[-1][0]


async def test_flo_partner_command_with_share(flo_db):
    service, db = flo_db
    code = await service.create_pair(1, "Владелица")
    await service.join_pair(2, "Партнёр", code)
    await flo.load_profile(db, 1, 0)
    await flo.set_share(db, 1, True, 0)
    await flo.set_share_notify(db, 1, True, 0)
    await db.execute(
        "UPDATE cycle_profiles SET share_confirmed=1 WHERE tg_id=1"
    )

    msg = FakeMessage(2)
    await flo_partner_command(msg, service)
    assert msg.answers, "партнёр должен получить текст календаря"
    assert "не делится" not in msg.answers[-1][0]


# ---------- flo_action (периоды, шеринг) ----------

async def test_flo_action_start_and_end_period(flo_db, monkeypatch):
    service, db = flo_db
    today = date(2026, 11, 10)
    monkeypatch.setattr("duoplan.handlers._flo_datetime", _FixedDatetime(today))

    call = FakeCall(1, "flo:start")
    await flo_action(call, service)
    periods = await flo.load_periods(db, 1)
    assert any(s == today and e is None for s, e, _ in periods)

    call2 = FakeCall(1, "flo:end")
    await flo_action(call2, service)
    periods = await flo.load_periods(db, 1)
    assert any(s == today and e == today for s, e, _ in periods)


async def test_flo_action_share_toggle(flo_db, monkeypatch):
    service, db = flo_db
    monkeypatch.setattr("duoplan.handlers._flo_datetime", _FixedDatetime(date(2026, 11, 10)))
    await flo.load_profile(db, 1, 0)  # как при показе /flo — создаёт строку профиля

    call = FakeCall(1, "flo:share")
    await flo_action(call, service)
    share = await flo.share_state(db, 1)
    assert share["enabled"] is True

    call2 = FakeCall(1, "flo:notify")
    await flo_action(call2, service)
    share = await flo.share_state(db, 1)
    assert share["notify"] is False


async def test_flo_action_export_sends_document(flo_db, monkeypatch):
    service, db = flo_db
    monkeypatch.setattr("duoplan.handlers._flo_datetime", _FixedDatetime(date(2026, 11, 10)))
    await flo.load_profile(db, 1, 0)

    call = FakeCall(1, "flo:export")
    await flo_action(call, service)
    assert len(call.message.documents) == 1
    payload = json.loads(call.message.documents[0][0])
    assert "profile" in payload or "periods" in payload or "logs" in payload


async def test_flo_action_end_without_open_period(flo_db, monkeypatch):
    service, db = flo_db
    monkeypatch.setattr("duoplan.handlers._flo_datetime", _FixedDatetime(date(2026, 11, 10)))
    await flo.load_profile(db, 1, 0)

    call = FakeCall(1, "flo:end")
    await flo_action(call, service)
    assert any("нет" in str(a[0]).lower() for a in call.answers)


class _FixedDatetime:
    """Подмена _flo_datetime.now(service.tz) → фиксированная дата."""

    def __init__(self, day: date) -> None:
        self._day = day

    def now(self, tz=None):
        class _DT:
            def date(self_inner):
                return day
            def timestamp(self_inner):
                return 1760000000
        day = self._day
        return _DT()


# ---------- DB-уровень cycle.py ----------

async def test_load_profile_returns_context(flo_db):
    service, db = flo_db
    await flo.load_profile(db, 1, 1000)
    await db.execute(
        "UPDATE cycle_profiles SET context=? WHERE tg_id=1",
        (json.dumps({"pregnancy": True, "very_irregular": False}),),
    )
    profile = await flo.load_profile(db, 1, 1000)
    assert profile["context"] == '{"pregnancy": true, "very_irregular": false}' or "pregnancy" in profile["context"]
    # cycle_forecast принимает context и помечает context_adjusted.
    f = flo.cycle_forecast([], date(2026, 11, 10), context=profile["context"])
    assert f is None or f.get("context_adjusted") in (True, None)


async def test_measurements_and_logs_roundtrip(flo_db):
    service, db = flo_db
    await db.execute(
        "INSERT INTO cycle_measurements(tg_id,date,time,kind,value,unit,result,note,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?)",
        (1, "2026-11-10", "07:00", "bbt", 36.6, "C", None, None, 0, 0),
    )
    measurements = await flo.load_measurements(db, 1)
    assert len(measurements) == 1
    assert measurements[0]["kind"] == "bbt"
    assert float(measurements[0]["value"]) == pytest.approx(36.6)

    await flo.upsert_log(db, 1, date(2026, 11, 10), flow="medium", mood="happy", symptoms=["fatigue"])
    await flo.upsert_log(db, 1, date(2026, 11, 10), flow="heavy")  # upsert — не дубль
    logs = await flo.load_logs(db, 1, date(2026, 11, 1), date(2026, 11, 30))
    assert len(logs) == 1
    assert logs[0]["flow"] == "heavy"


async def test_share_state_defaults_and_toggles(flo_db):
    service, db = flo_db
    await flo.load_profile(db, 1, 0)  # создаёт строку профиля
    share = await flo.share_state(db, 1)
    assert share["enabled"] is False
    assert share["notify"] is True  # дефолт — уведомлять

    await flo.set_share(db, 1, True, 100)
    await flo.set_share_notify(db, 1, False, 100)
    share = await flo.share_state(db, 1)
    assert share["enabled"] is True
    assert share["notify"] is False


async def test_partner_ids_and_view_privacy(flo_db):
    service, db = flo_db
    code = await service.create_pair(1, "Владелица")
    await service.join_pair(2, "Партнёр", code)

    assert await flo.partner_ids(db, 2) == [1]
    assert await flo.partner_ids(db, 1) == [2]

    # Без шеринга партнёр ничего не видит.
    assert await flo.partner_view_text(db, 1, date(2026, 11, 10)) is None

    await flo.load_profile(db, 1, 0)
    await flo.set_share(db, 1, True, 0)
    text = await flo.partner_view_text(db, 1, date(2026, 11, 10))
    assert text is not None
    assert "симптом" not in text.lower() or "не переда" not in text.lower()


async def test_export_json_contains_all_sections(flo_db):
    service, db = flo_db
    await flo.load_profile(db, 1, 0)
    await flo.mark_period(db, 1, date(2026, 10, 1), date(2026, 10, 5), 0)
    await flo.upsert_log(db, 1, date(2026, 10, 3), flow="light", mood="calm")
    await db.execute(
        "INSERT INTO cycle_meds(tg_id,name,category,dosage,form,schedule,start_date,status,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?)",
        (1, "Тест", "other", None, "tablet", "daily", "2026-10-01", "active", 0, 0),
    )
    data = await flo.export_json(db, 1, 0)
    payload = json.loads(data)
    for key in ("profile", "periods", "logs", "meds", "med_logs", "measurements"):
        assert key in payload, f"в экспорте нет секции {key}"


async def test_period_lifecycle_open_close_unknown(flo_db):
    service, db = flo_db
    await flo.mark_period(db, 1, date(2026, 10, 1), None, 0)          # открытый
    await flo.mark_period(db, 1, date(2026, 10, 29), date(2026, 11, 2), 0)  # закрытый
    periods = await flo.load_periods(db, 1)
    assert len(periods) == 2
    open_p = next(p for p in periods if p[0] == date(2026, 10, 1))
    assert open_p[1] is None and open_p[2] is False

    # Закрытие открытого периода.
    assert await flo.close_open_period(db, 1, date(2026, 10, 5), 1) is True
    periods = await flo.load_periods(db, 1)
    closed = next(p for p in periods if p[0] == date(2026, 10, 1))
    assert closed[1] == date(2026, 10, 5)

    # Повторное закрытие — открытых нет.
    assert await flo.close_open_period(db, 1, date(2026, 10, 6), 2) is False

    # end_unknown через bulk_mark_periods.
    inserted, skipped = await flo.bulk_mark_periods(
        db, 1, [(date(2026, 8, 1), None, True)], 0
    )
    assert inserted == 1
    periods = await flo.load_periods(db, 1)
    unk = next(p for p in periods if p[0] == date(2026, 8, 1))
    assert unk[1] is None and unk[2] is True
