"""Паритет Python-прогноза Фло с worker.js: те же фикстуры, что в test_cycle_forecast.test.mjs."""

from datetime import date

from duoplan.cycle import (
    bulk_mark_periods,
    close_open_period,
    cycle_forecast,
    cycle_reminder_kinds,
    cycle_text,
    load_periods,
    mark_period,
    partner_view_text,
)

PERIODS = [
    (date(2026, 1, 1), date(2026, 1, 5)),
    (date(2026, 1, 29), date(2026, 2, 2)),
    (date(2026, 2, 26), date(2026, 3, 2)),
]


def test_empty_history_has_no_forecast():
    assert cycle_forecast([], date(2026, 3, 10)) is None
    assert cycle_text(None, None).startswith("Фло:")


def test_regular_cycles_average_and_phase():
    f = cycle_forecast(PERIODS, date(2026, 3, 10))
    assert f["avg_cycle_length"] == 28
    assert f["irregular"] is False
    assert f["next_period_start"] == date(2026, 3, 26)
    assert f["ovulation_date"] == date(2026, 3, 12)
    assert f["next_period_in"] == 16
    assert f["phase"] == "fertile"


def test_open_period_is_menstruation():
    f = cycle_forecast([(date(2026, 3, 1), None)], date(2026, 3, 3))
    assert f["phase"] == "menstruation"


def test_open_period_stays_menstruation_beyond_two_weeks():
    # Паритет с worker.js (аудит 3.1.E): незакрытый период не «сгорает»
    # через 14 дней — фаза остаётся менструацией, задержка не показывается.
    f = cycle_forecast([(date(2026, 1, 29), None)], date(2026, 3, 1))
    assert f["phase"] == "menstruation"


def test_late_period_is_delay():
    # Задержка считается только при закрытом последнем периоде.
    f = cycle_forecast(
        [(date(2026, 1, 1), date(2026, 1, 5)), (date(2026, 1, 29), date(2026, 2, 2))],
        date(2026, 3, 1),
    )
    assert f["phase"] == "delay"
    assert f["delay_days"] > 0


def test_forecast_quality_fields_match_worker():
    # Те же поля, что у cycleForecast в worker.js: based_on/quality/диапазон.
    f = cycle_forecast(PERIODS, date(2026, 3, 10))
    assert f["based_on"] == "history"
    assert f["quality"] == "few"  # 2 пригодных интервала
    assert f["ovulation_estimated"] is True
    assert f["next_period_early"] < f["next_period_start"] < f["next_period_late"]
    one = cycle_forecast([(date(2026, 1, 1), date(2026, 1, 5))], date(2026, 2, 1), cycle_known=0)
    assert one["based_on"] == "default"
    assert one["quality"] == "insufficient"


def test_unknown_end_period_is_not_open():
    # Паритет с worker.js: end_unknown=1 — историческая запись «конец не
    # помним», а не идущая менструация.
    f = cycle_forecast([(date(2026, 1, 1), None, True)], date(2026, 2, 1))
    assert f["phase"] != "menstruation"


def test_three_tuple_periods_give_history_forecast():
    # 3 старта → 2 интервала → based_on="history" (паритет worker.js).
    periods = [
        (date(2026, 1, 1), date(2026, 1, 5), False),
        (date(2026, 1, 29), None, True),
        (date(2026, 2, 26), date(2026, 3, 2), False),
    ]
    f = cycle_forecast(periods, date(2026, 3, 10))
    assert f["based_on"] == "history"
    assert f["usable_cycles"] == 2


async def test_end_unknown_lifecycle_in_db(db):
    # end_unknown=1 не считается открытым: close_open_period его не трогает,
    # а bulk_mark_periods не перезаписывает существующие старты.
    await bulk_mark_periods(
        db, 1,
        [
            (date(2026, 1, 1), date(2026, 1, 5), False),
            (date(2026, 1, 29), None, True),
        ],
        1000,
    )
    periods = await load_periods(db, 1)
    assert len(periods) == 2
    # DESC по дате: первой идёт запись с неизвестным концом.
    assert periods[0][2] is True and periods[1][2] is False

    # «Закрытие» открытого периода не задевает запись с неизвестным концом.
    await mark_period(db, 1, date(2026, 2, 26), None, 2000)
    assert await close_open_period(db, 1, date(2026, 3, 2), 3000)
    rows = await db.query(
        "SELECT start_date, end_date, end_unknown FROM cycle_periods WHERE tg_id=1 ORDER BY start_date"
    )
    by_start = {r["start_date"]: r for r in rows}
    assert by_start["2026-01-29"]["end_date"] is None
    assert by_start["2026-01-29"]["end_unknown"] == 1
    assert by_start["2026-02-26"]["end_date"] == "2026-03-02"

    # Повторная вставка того же старта — skipped, запись не перезаписана.
    inserted, skipped = await bulk_mark_periods(
        db, 1, [(date(2026, 1, 29), date(2026, 2, 1), False)], 4000
    )
    assert (inserted, skipped) == (0, 1)
    rows = await db.query("SELECT end_unknown FROM cycle_periods WHERE tg_id=1 AND start_date='2026-01-29'")
    assert rows[0]["end_unknown"] == 1


async def test_partner_view_respects_share_level(db):
    # Паритет с cycleViewForPartner: категории + подтверждение состава.
    # Симптомы, заметки и флоу не отдаются ни на какой конфигурации.
    await db.execute("INSERT INTO users(tg_id, display_name, gender, created_at, updated_at) VALUES(1,'А', 'female',1,1)")
    await db.execute(
        "INSERT INTO cycle_profiles(tg_id, share_enabled, share_level, share_sex, share_mood, share_sleep, share_bbt, share_confirmed, onboarded, created_at, updated_at) "
        "VALUES(1,1,'phases',1,1,1,1,1,1,1,1)"
    )
    await bulk_mark_periods(db, 1, [(date(2026, 1, 1), date(2026, 1, 5), False)], 1000)
    await db.execute(
        "INSERT INTO cycle_logs(tg_id,date,flow,symptoms,symptoms_clear,note,sex,mood,sleep_quality,created_at,updated_at) "
        "VALUES(1,'2026-03-10','light','[\"cramps\"]',0,'секрет','protected','calm','good',1,1)"
    )
    text = await partner_view_text(db, 1, date(2026, 3, 10))
    assert "Фаза:" in text
    assert "2026-01-01" in text, "календарь показывает даты месячных"
    assert "Секс: с защитой" in text
    assert "Настроение: спокойствие" in text
    assert "Сон: хорошо" in text
    # Симптомы, флоу, заметки — никогда.
    assert "судороги" not in text
    assert "секрет" not in text

    # Без подтверждения состава — только календарная оценка.
    await db.execute("UPDATE cycle_profiles SET share_confirmed=0 WHERE tg_id=1")
    text = await partner_view_text(db, 1, date(2026, 3, 10))
    assert "Фаза:" in text
    assert "Месячные:" not in text
    assert "Секс:" not in text
    assert "Настроение:" not in text
    assert "Сон:" not in text

    # Категории выключены — дневниковых строк нет, календарь остаётся.
    await db.execute("UPDATE cycle_profiles SET share_confirmed=1, share_sex=0, share_mood=0, share_sleep=0, share_bbt=0 WHERE tg_id=1")
    text = await partner_view_text(db, 1, date(2026, 3, 10))
    assert "Секс:" not in text and "Настроение:" not in text
    assert "Месячные:" in text


def test_reminders_respect_prefs():
    f = cycle_forecast(PERIODS, date(2026, 3, 10))
    assert cycle_reminder_kinds(f, {"fertile": False}) == []
    assert cycle_reminder_kinds({**f, "ovulation_in": 0, "phase": "luteal"}, {}) == [
        ("cycle_ovulation", "Сегодня вероятный день овуляции — календарная оценка, не подтверждение")
    ]
    assert cycle_reminder_kinds({**f, "next_period_in": 3, "phase": "luteal"}, {"period_days": 3}) == [
        ("cycle_period", "Через 3 дн. ожидаются месячные")
    ]


def test_reminders_quality_gating():
    """Гейтинг 4.2: овуляция/окно не анонсируются при недостаточных данных."""
    base = {"empty": False, "phase": "luteal", "next_period_in": 5, "ovulation_in": 0, "delay_days": 0}
    assert cycle_reminder_kinds(base, {}) == [], "нет quality/based_on — как insufficient"
    insufficient = {**base, "quality": "insufficient", "based_on": "default"}
    assert cycle_reminder_kinds(insufficient, {}) == []
    few = {**base, "quality": "few", "based_on": "history"}
    assert [kind for kind, _ in cycle_reminder_kinds(few, {})] == ["cycle_ovulation"]
    stale = {**few, "data_stale": True}
    assert cycle_reminder_kinds(stale, {}) == []


if __name__ == "__main__":
    for name, fn in list(globals().items()):
        if name.startswith("test_") and callable(fn):
            fn()
            print("ok", name)


# ---- P1: точность прогноза (паритет с worker.js) ----

def test_forecast_median_robust_and_single_interval():
    periods = [
        (date(2026, 1, 1), date(2026, 1, 5), False),
        (date(2026, 1, 16), date(2026, 1, 20), False),   # +15
        (date(2026, 3, 17), date(2026, 3, 21), False),   # +60
        (date(2026, 4, 14), date(2026, 4, 18), False),   # +28
        (date(2026, 5, 12), date(2026, 5, 16), False),   # +28
        (date(2026, 6, 9), date(2026, 6, 13), False),    # +28
    ]
    f = cycle_forecast(periods, date(2026, 6, 20), 28, 5, 0)
    assert f["avg_cycle_length"] == 28  # медиана, не среднее 32
    assert f["irregular"] is True

    one = [(date(2026, 10, 1), date(2026, 10, 5), False), (date(2026, 10, 31), date(2026, 11, 4), False)]
    f1 = cycle_forecast(one, date(2026, 11, 10), 28, 5, 0)
    assert f1["based_on"] == "history"
    assert f1["usable_cycles"] == 1
    assert f1["next_period_start"] == date(2026, 11, 30)


def test_forecast_stale_phase():
    periods = [(date(2026, 7, 1), date(2026, 7, 5), False)]
    f = cycle_forecast(periods, date(2026, 10, 15), 28, 5, 0)
    assert f["phase"] == "stale"
    assert f["data_stale"] is True
    delay = [(date(2026, 9, 20), date(2026, 9, 24), False)]
    f2 = cycle_forecast(delay, date(2026, 11, 5), 28, 5, 0)
    assert f2["phase"] == "delay"
    assert f2["data_stale"] is False


def test_forecast_lh_and_bbt_observations():
    periods = [
        (date(2026, 8, 4), date(2026, 8, 8), False),
        (date(2026, 9, 1), date(2026, 9, 5), False),  # цикл 28 → ov 15.09
    ]
    lh = [{"kind": "lh", "result": "positive", "date": "2026-09-13"}]
    f = cycle_forecast(periods, date(2026, 9, 14), 28, 5, 0, lh)
    assert f["ovulation_source"] == "lh"
    assert f["ovulation_date"] == date(2026, 9, 14)
    assert f["next_period_start"] == date(2026, 9, 29)

    # ЛГ вне окна — игнорируется.
    f_out = cycle_forecast(periods, date(2026, 9, 14), 28, 5, 0,
                           [{"kind": "lh", "result": "positive", "date": "2026-10-20"}])
    assert f_out["ovulation_source"] == "calendar"

    bbt = [
        *[{"kind": "bbt", "value": 36.5, "unit": "C", "date": d}
          for d in ("2026-09-06", "2026-09-07", "2026-09-08", "2026-09-09")],
        *[{"kind": "bbt", "value": 36.9, "unit": "C", "date": d}
          for d in ("2026-09-11", "2026-09-12", "2026-09-13")],
    ]
    fb = cycle_forecast(periods, date(2026, 9, 14), 28, 5, 0, bbt)
    assert fb["ovulation_source"] == "bbt"
    assert fb["ovulation_date"] == date(2026, 9, 10)


# ---- Самообучение прогноза (паритет с cycleLearnedOvulationOffset) ----

def test_learned_ovulation_offset_applies_from_two_cycles():
    periods = [
        (date(2026, 1, 1), date(2026, 1, 5), False),
        (date(2026, 1, 29), date(2026, 2, 2), False),
        (date(2026, 2, 26), date(2026, 3, 2), False),
        (date(2026, 3, 26), None, False),
    ]
    meas = [
        {"kind": "lh", "result": "positive", "date": "2026-01-16"},
        {"kind": "lh", "result": "positive", "date": "2026-02-13"},
        {"kind": "lh", "result": "positive", "date": "2026-03-13"},
    ]
    f = cycle_forecast(periods, date(2026, 4, 5), measurements=meas)
    assert f["ovulation_offset_learned"] == 16
    assert f["ovulation_offset_observations"] == 3
    # 26.03 + 16 = 11.04 (без обучения было бы 11.04 тоже при 28-дневном цикле
    # и −14: 26.03 + 28 − 14 = 11.04 — проверяем реальное отличие на неравных
    # циклах ниже), источник остаётся календарным и оценочным.
    assert f["ovulation_source"] == "calendar"
    assert f["ovulation_estimated"] is True


def test_learned_offset_shifts_uneven_cycles():
    # Циклы 30 дней, ЛГ+ на 12-й день → овуляция на 13-й (offset 12).
    # Стандартная оценка дала бы старт+30−14 = день 16; обученная — день 12.
    periods = [
        (date(2026, 1, 1), date(2026, 1, 5), False),
        (date(2026, 1, 31), date(2026, 2, 4), False),
        (date(2026, 3, 2), date(2026, 3, 6), False),
        (date(2026, 4, 1), None, False),
    ]
    meas = [
        {"kind": "lh", "result": "positive", "date": "2026-01-12"},
        {"kind": "lh", "result": "positive", "date": "2026-02-11"},
    ]
    f = cycle_forecast(periods, date(2026, 4, 15), measurements=meas)
    assert f["ovulation_offset_learned"] == 12
    assert f["ovulation_date"] == date(2026, 4, 13), "старт 01.04 + обученное смещение 12"


def test_single_observation_keeps_default_offset():
    periods = [
        (date(2026, 1, 1), date(2026, 1, 5), False),
        (date(2026, 1, 29), date(2026, 2, 2), False),
        (date(2026, 2, 26), None, False),
    ]
    meas = [{"kind": "lh", "result": "positive", "date": "2026-01-16"}]
    f = cycle_forecast(periods, date(2026, 3, 10), measurements=meas)
    assert f["ovulation_offset_learned"] is None
    assert f["ovulation_date"] == date(2026, 3, 12)


def test_bbt_conflict_reported_separately():
    periods = [
        (date(2026, 8, 4), date(2026, 8, 8), False),
        (date(2026, 9, 1), date(2026, 9, 5), False),
    ]
    meas = [
        {"kind": "lh", "result": "positive", "date": "2026-09-13"},
        {"kind": "bbt", "value": 36.5, "unit": "C", "date": "2026-09-05"},
        {"kind": "bbt", "value": 36.5, "unit": "C", "date": "2026-09-06"},
        {"kind": "bbt", "value": 36.5, "unit": "C", "date": "2026-09-07"},
        {"kind": "bbt", "value": 36.5, "unit": "C", "date": "2026-09-08"},
        {"kind": "bbt", "value": 36.9, "unit": "C", "date": "2026-09-10"},
        {"kind": "bbt", "value": 36.9, "unit": "C", "date": "2026-09-11"},
        {"kind": "bbt", "value": 36.9, "unit": "C", "date": "2026-09-12"},
    ]
    f = cycle_forecast(periods, date(2026, 9, 14), measurements=meas)
    assert f["ovulation_source"] == "lh"
    assert f["ovulation_date"] == date(2026, 9, 14)
    assert f["ovulation_conflict"]["lh"] == "2026-09-14"
    assert f["ovulation_conflict"]["bbt"] == "2026-09-09"


def test_sick_day_blocks_bbt_shift():
    periods = [
        (date(2026, 8, 4), date(2026, 8, 8), False),
        (date(2026, 9, 1), date(2026, 9, 5), False),
    ]
    meas = [
        {"kind": "bbt", "value": 36.5, "unit": "C", "date": "2026-09-05"},
        {"kind": "bbt", "value": 36.5, "unit": "C", "date": "2026-09-06"},
        {"kind": "bbt", "value": 36.5, "unit": "C", "date": "2026-09-07"},
        {"kind": "bbt", "value": 36.5, "unit": "C", "date": "2026-09-08"},
        {"kind": "bbt", "value": 36.9, "unit": "C", "date": "2026-09-10"},
        {"kind": "bbt", "value": 36.9, "unit": "C", "date": "2026-09-11"},
        {"kind": "bbt", "value": 36.9, "unit": "C", "date": "2026-09-12"},
    ]
    ok_f = cycle_forecast(periods, date(2026, 9, 14), measurements=meas)
    assert ok_f["ovulation_source"] == "bbt"
    sick_f = cycle_forecast(periods, date(2026, 9, 14), measurements=meas, sick_dates=["2026-09-11"])
    assert sick_f["ovulation_source"] == "calendar"
    assert sick_f["ovulation_date"] == date(2026, 9, 15)
