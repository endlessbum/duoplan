"""Фло для Python-бота: паритет с worker.js (cycleForecast, cycleState, запись периодов).

Чистые функции (прогноз) не трогают БД; async-функции работают с объектом Database
через query/execute. Правила прогноза и фаз совпадают с worker.js.
"""

from __future__ import annotations

import json
import math
from datetime import UTC, date, datetime, timedelta
from typing import Any, Awaitable, Callable, Sequence
from zoneinfo import ZoneInfo

CYCLE_PHASE_LABELS = {
    "menstruation": "Менструация",
    "follicular": "Фолликулярная",
    "fertile": "Фертильное окно",
    "ovulation": "Овуляция",
    "luteal": "Лютеиновая",
    "delay": "Задержка",
    "stale": "Данные устарели",
}


# Коды значений — паритет с CYCLE_* в worker.js. Сгустки — отдельный признак
# дня (clots), не вариант интенсивности; эмоции не входят в симптомы.
FLOW_CODES = ("spotting", "light", "medium", "heavy")
MOOD_CODES = ("happy", "calm", "sensitive", "irritable", "anxious", "sad", "mood_swings")
ENERGY_CODES = ("very_low", "low", "normal", "high")
SEX_CODES = ("protected", "unprotected", "none")
# Добивка дневника (этап 4/P1): протекание, локализация боли, влияние на жизнь.
LEAKAGE_CODES = ("day", "night")
PAIN_LOCATION_CODES = (
    "lower_abdomen", "pelvis", "left_side", "right_side", "lower_back", "breasts", "other",
)
LIFE_IMPACT_CODES = ("none", "little", "limited", "gave_up")
SYMPTOM_CODES = (
    "cramps", "headache", "bloating", "breast_tenderness", "fatigue", "acne", "nausea",
    "back_pain", "dizziness", "constipation", "diarrhea",
    "exercise", "good_sleep", "poor_sleep", "water",
)
CYCLE_LEVELS = ("phases", "periods", "symptoms", "full")
CYCLE_LEVEL_RANK = {level: i for i, level in enumerate(CYCLE_LEVELS)}

# Категории общего доступа (переработка P0): паритет с CYCLE_SHARE_CATEGORIES
# в worker.js. Календарь — базовая часть (share_enabled), прочие — флаги.
CYCLE_SHARE_CATEGORIES = ("sex", "mood", "sleep", "bbt")

# Контекст цикла (переработка 5.1): паритет с CYCLE_CONTEXT_KEYS в worker.js.
CYCLE_CONTEXT_KEYS = (
    "pregnancy", "postpartum", "breastfeeding", "perimenopause",
    "hormonal_contraception", "cycle_affecting_meds", "very_irregular", "unusual_bleeding",
)

# Короткие русские подписи для партнёрского вида (паритет CYCLE_*_LABELS
# в worker.js): flow и симптомы на уровне symptoms/full.
FLOW_LABELS = {"spotting": "мажь", "light": "слабые", "medium": "средние", "heavy": "сильные"}
MOOD_LABELS = {
    "happy": "радость", "calm": "спокойствие", "sensitive": "чувствительность",
    "irritable": "раздражительность", "anxious": "тревожность", "sad": "грусть",
    "mood_swings": "перепады",
}
SYMPTOM_LABELS = {
    "cramps": "судороги", "headache": "голова", "bloating": "вздутие",
    "breast_tenderness": "грудь", "fatigue": "усталость", "acne": "акне",
    "nausea": "тошнота", "back_pain": "спина", "dizziness": "головокружение",
    "constipation": "запор", "diarrhea": "диарея",
    "exercise": "спорт", "good_sleep": "хороший сон", "poor_sleep": "плохой сон",
    "water": "вода",
}

# Короткие уведомления партнёру при смене фазы (как CYCLE_PARTNER_NOTICES в worker.js).
PARTNER_NOTICES = {
    "menstruation": "Сегодня фаза менструации. Возможны усталость и перепады настроения.",
    "ovulation": "Сегодня фаза овуляции. Обычно энергии больше.",
    "delay": "Сегодня возможна задержка. Спокойная поддержка помогает.",
}

# Колонки cycle_profiles, которые разрешено менять через update_profile.
_PROFILE_FIELDS = {
    "avg_cycle_length", "avg_period_length", "share_enabled", "share_level",
    "share_sex", "share_mood", "share_sleep", "share_bbt", "share_confirmed",
    "context",
    "onboarded", "notify_enabled", "notify_period", "notify_ovulation",
    "notify_fertile", "notify_delay", "notify_period_days", "notify_delay_days",
    "notify_diary", "share_notify",
}


def _tz_for(name: object):
    try:
        return ZoneInfo(str(name) or "Europe/Moscow")
    except Exception:
        return ZoneInfo("Europe/Moscow")


def today_in_tz(tz_name: object, at: datetime | None = None) -> date:
    """«Сегодня» в поясе пользователя (users.timezone)."""
    moment = at or datetime.now(UTC)
    if moment.tzinfo is None:
        moment = moment.replace(tzinfo=UTC)
    return moment.astimezone(_tz_for(tz_name)).date()


async def user_today(db: Any, tg_id: int, fallback: date | None = None) -> date:
    row = await db.one("SELECT timezone FROM users WHERE tg_id=?", (tg_id,))
    if row and row.get("timezone"):
        return today_in_tz(row["timezone"])
    return fallback or date.today()


def _round_half_up(value: float) -> int:
    # Как Math.round в JS: .5 округляется вверх, а не к чётному.
    return math.floor(value + 0.5)


CYCLE_INTERVAL_MIN = 15
CYCLE_INTERVAL_MAX = 60
CYCLE_INTERVAL_USABLE = 6
# Дней после ожидаемого старта без открытого периода → «данные устарели»
# (паритет CYCLE_STALE_GRACE в worker.js).
CYCLE_STALE_GRACE = 21


def _d(s: str) -> int:
    """Дата ГГГГ-ММ-ДД → номер дня (как cycleDayNum в worker.js)."""
    y, m, d = (int(x) for x in s.split("-"))
    return (date(y, m, d) - date(1970, 1, 1)).days


def _date_str(num: int) -> str:
    return (date(1970, 1, 1) + timedelta(days=num)).isoformat()


def _from_d(num: int) -> date:
    return date(1970, 1, 1) + timedelta(days=num)


def _period_parts(p: tuple) -> tuple[date, date | None, bool]:
    """Нормализация записи периода: (start, end) или (start, end, end_unknown).

    Двухэлементный кортеж — старый формат без флага (end_unknown=0).
    """
    return p[0], (p[1] if len(p) > 1 else None), bool(len(p) > 2 and p[2])


def cycle_intervals(
    periods: Sequence[tuple],
) -> dict[str, Any]:
    """Единый модуль расчётов (паритет с cycleIntervals в worker.js).

    Все интервалы между стартами сохраняются: в расчёт входят только
    интервалы 15–60 дней (правило качества данных, не медицинский порог),
    остальные помечаются unusual. Последние 6 пригодных — в прогноз.
    """
    parts = [_period_parts(p) for p in periods]
    starts = sorted(_d(start.isoformat()) for start, _, _ in parts)
    intervals = []
    for i in range(1, len(starts)):
        length = starts[i] - starts[i - 1]
        intervals.append({
            "start": _date_str(starts[i - 1]),
            "end": _date_str(starts[i]),
            "length": length,
            "unusual": length < CYCLE_INTERVAL_MIN or length > CYCLE_INTERVAL_MAX,
        })
    usable = [iv["length"] for iv in intervals if not iv["unusual"]][-CYCLE_INTERVAL_USABLE:]
    closed_lengths = [
        (_d(end.isoformat()) - _d(start.isoformat()) + 1)
        for start, end, _ in parts
        if end
    ]
    closed_lengths = [d for d in closed_lengths if 1 <= d <= 14]
    sorted_u = sorted(usable)
    median = None
    if sorted_u:
        n = len(sorted_u)
        median = sorted_u[(n - 1) // 2] if n % 2 else _round_half_up((sorted_u[n // 2 - 1] + sorted_u[n // 2]) / 2)
    return {
        "starts": starts,
        "intervals": intervals,
        "unusual": [iv for iv in intervals if iv["unusual"]],
        "usable": usable,
        "closed_lengths": closed_lengths,
        "mean": _round_half_up(sum(usable) / len(usable)) if usable else None,
        "median": median,
        "min": min(usable) if usable else None,
        "max": max(usable) if usable else None,
        "spread": max(usable) - min(usable) if len(usable) >= 2 else None,
    }


def _cycle_data_quality(usable_count: int, cycle_known: Any) -> str:
    """Уровень качества выборки (паритет с cycleDataQuality в worker.js)."""
    if usable_count >= 4:
        return "full"
    if usable_count >= 2:
        return "few"
    return "few" if cycle_known else "insufficient"


def _ovulation_estimates(
    measurements: Sequence[dict[str, Any]] | None,
    last: int,
    nxt: int,
    today_num: int,
    sick_days: set[int] | None = None,
) -> list[dict[str, Any]]:
    """Независимые оценки овуляции внутри цикла (паритет cycleOvulationEstimates).

    Положительный тест ЛГ предшествует овуляции ~24–36 ч → +1 день;
    устойчивый подъём БТ ≥0.2°C три дня → овуляция ~за день до подъёма.
    sick_days — дни «болезнь/температура» в дневнике: искажают БТ и ЛГ,
    исключаются целиком (6). Оценки считаются по отдельности (§4/§6: при
    расхождении показываются обе); календарная привязка (≤7 дней) — в
    вызывающем коде. Также используется самообучением по всей истории.
    """
    if not measurements:
        return []
    sick = sick_days or set()
    estimates: list[dict[str, Any]] = []

    def in_window(d: int) -> bool:
        return last + 5 <= d <= nxt - 7 and d <= today_num

    def day_num(s: str) -> int | None:
        try:
            return _d(s)
        except (ValueError, AttributeError):
            return None

    lh_days = sorted(
        d for m in measurements
        if m.get("kind") == "lh" and m.get("result") == "positive"
        for d in [day_num(str(m.get("date") or ""))]
        if d is not None and in_window(d) and d not in sick
    )
    if lh_days:
        estimates.append({"source": "lh", "day": lh_days[-1] + 1})
    # БТ: средняя температура по дню, F → C. Дни болезни исключаются целиком.
    temps: dict[int, list[float]] = {}
    for m in measurements:
        if m.get("kind") != "bbt":
            continue
        try:
            v = float(m.get("value"))
        except (TypeError, ValueError):
            continue
        d = day_num(str(m.get("date") or ""))
        if d is None or not in_window(d) or d in sick:
            continue
        celsius = (v - 32) * 5 / 9 if m.get("unit") == "F" else v
        temps.setdefault(d, []).append(celsius)
    days = [
        {"d": d, "t": sum(ts) / len(ts)}
        for d, ts in sorted(temps.items())
    ]
    for i in range(len(days) - 2):
        a, b, c = days[i], days[i + 1], days[i + 2]
        if b["d"] != a["d"] + 1 or c["d"] != a["d"] + 2:
            continue
        base = [x["t"] for x in days if a["d"] - 6 <= x["d"] < a["d"]]
        if len(base) < 3:
            continue
        baseline = sum(base) / len(base)
        if min(a["t"], b["t"], c["t"]) >= baseline + 0.2:
            ov = a["d"] - 1
            if last + 8 <= ov <= nxt - 7:
                estimates.append({"source": "bbt", "day": ov})
                break
    return estimates


# Санити-границы личного смещения овуляции (продуктовое правило, паритет с
# worker.js): овуляция в 9–17 день цикла от старта; вне — наблюдение не
# считается пригодным для самообучения.
CYCLE_OVULATION_OFFSET_MIN = 9
CYCLE_OVULATION_OFFSET_MAX = 17


def _learned_ovulation_offset(
    periods: Sequence[tuple],
    measurements: Sequence[dict[str, Any]] | None,
    today_num: int,
    sick_days: set[int] | None = None,
) -> dict[str, int] | None:
    """Самообучение смещения овуляции (паритет cycleLearnedOvulationOffset).

    Для каждого завершённого цикла LH+/БТ дают смещение от старта цикла.
    При ≥2 наблюдениях из ≥2 разных циклов медиана заменяет фиксированные
    «−14 дней» в календарной оценке — прогноз уточняется сам по мере ведения
    дневника. Границы 9–17 — санити, не клиническая норма; результат всегда
    остаётся оценкой (ovulation_estimated).
    """
    parts = [_period_parts(p) for p in periods]
    starts = sorted(_d(start.isoformat()) for start, _, _ in parts)
    offsets: list[int] = []
    for i in range(len(starts) - 1):
        ests = _ovulation_estimates(measurements, starts[i], starts[i + 1], today_num, sick_days)
        if not ests:
            continue
        offset = ests[0]["day"] - starts[i]
        if CYCLE_OVULATION_OFFSET_MIN <= offset <= CYCLE_OVULATION_OFFSET_MAX:
            offsets.append(offset)
    if len(offsets) < 2:
        return None
    sorted_o = sorted(offsets)
    n = len(sorted_o)
    median = sorted_o[(n - 1) // 2] if n % 2 else (
        _round_half_up((sorted_o[n // 2 - 1] + sorted_o[n // 2]) / 2)
    )
    return {"offset": median, "cycles": len(offsets)}


def cycle_forecast(
    periods: Sequence[tuple],
    today: date,
    avg_cycle: int = 28,
    avg_period: int = 5,
    cycle_known: Any = 0,
    measurements: Sequence[dict[str, Any]] | None = None,
    sick_dates: Sequence[str] | None = None,
) -> dict[str, Any] | None:
    """Прогноз по периодам (старт, конец|None). None, если периодов нет.

    Паритет с cycleForecast в worker.js: пригодные интервалы 15–60,
    медиана последних циклов, based_on/quality, диапазон
    next_period_early/late, ovulation_estimated, data_stale, LH/БТ.
    sick_dates — даты «YYYY-MM-DD» с отметкой болезни в дневнике: из
    температурных наблюдений исключаются (переработка 6).
    """
    if not periods:
        return None
    info = cycle_intervals(periods)
    starts = info["starts"]
    # Длина месячных — по последним закрытым (паритет с worker.js).
    closed_all = info["closed_lengths"]
    closed_recent = closed_all[-CYCLE_INTERVAL_USABLE:] or closed_all
    cycle_known_flag = bool(cycle_known)
    usable_count = len(info["usable"])
    # Медиана робастнее среднего; один пригодный интервал — тоже evidence.
    cycle = (info["median"] if info["median"] is not None else info["mean"]) if usable_count >= 1 else avg_cycle
    period_len = _round_half_up(sum(closed_recent) / len(closed_recent)) if closed_recent else avg_period
    irregular = usable_count >= 2 and info["spread"] is not None and info["spread"] > 7
    based_on = "history" if usable_count >= 1 else ("profile" if cycle_known_flag else "default")
    today_num = _d(today.isoformat())
    sick_days = set()
    for s in sick_dates or []:
        try:
            sick_days.add(_d(s))
        except (ValueError, AttributeError):
            continue
    if not starts:
        return {
            "phase": None, "empty": True, "avg_cycle_length": cycle, "avg_period_length": period_len,
            "irregular": False, "based_on": based_on, "quality": "insufficient",
            "ovulation_estimated": True, "ovulation_source": "calendar",
        }
    last = starts[-1]
    nxt = last + cycle
    # Календарная оценка овуляции: по умолчанию «ожидаемый старт − 14 дней»,
    # при накопленных наблюдениях — личное смещение (самообучение, §4).
    learned = _learned_ovulation_offset(periods, measurements, today_num, sick_days)
    calendar_ov = last + learned["offset"] if learned and usable_count >= 1 else nxt - 14
    # Оценки по каждому признаку отдельно; расхождение показывается (§6).
    estimates = [
        e for e in _ovulation_estimates(measurements, last, nxt, today_num, sick_days)
        if abs(e["day"] - calendar_ov) <= 7
    ]
    lh_est = next((e for e in estimates if e["source"] == "lh"), None)
    bbt_est = next((e for e in estimates if e["source"] == "bbt"), None)
    observed = lh_est or bbt_est
    ovulation = observed["day"] if observed else calendar_ov
    ovulation_conflict = None
    if lh_est and bbt_est and lh_est["day"] != bbt_est["day"]:
        ovulation_conflict = {
            "lh": _date_str(lh_est["day"]),
            "bbt": _date_str(bbt_est["day"]),
        }
    # Открытый период — end=None и end_unknown=0; «конец не помним»
    # (end_unknown=1) открытой записью не считается (паритет с worker.js).
    open_start = next((s for s, e, u in (_period_parts(p) for p in periods) if e is None and not u), None)
    # «Данные устарели»: нет открытого периода и прошёл ожидаемый цикл + запас.
    data_stale = open_start is None and today_num - last > cycle + CYCLE_STALE_GRACE

    # Незакрытый период — факт «менструация идёт» без ограничения по дням
    # (паритет с worker.js, аудит 3.1.E).
    if open_start and today_num >= _d(open_start.isoformat()):
        phase = "menstruation"
    elif data_stale:
        phase = "stale"
    elif today_num > nxt:
        phase = "delay"
    elif today_num == ovulation:
        phase = "ovulation"
    elif ovulation - 5 <= today_num <= ovulation + 1:
        phase = "fertile"
    elif today_num < ovulation - 5:
        phase = "follicular"
    else:
        phase = "luteal"

    rng = max(3, info["spread"]) if info["spread"] is not None else 3
    return {
        "phase": phase,
        "empty": False,
        "cycle_day": today_num - last + 1,
        "avg_cycle_length": cycle,
        "avg_period_length": period_len,
        "irregular": irregular,
        "last_period_start": _from_d(last),
        "next_period_start": _from_d(nxt),
        "next_period_end": _from_d(nxt + period_len - 1),
        "next_period_early": _from_d(nxt - rng),
        "next_period_late": _from_d(nxt + rng),
        "next_period_in": nxt - today_num,
        "delay_days": max(0, today_num - nxt),
        "ovulation_date": _from_d(ovulation),
        "ovulation_in": ovulation - today_num,
        "ovulation_estimated": True,
        "ovulation_source": observed["source"] if observed else "calendar",
        # Самообучение и расхождение признаков (паритет с worker.js).
        "ovulation_offset_learned": learned["offset"] if learned else None,
        "ovulation_offset_observations": learned["cycles"] if learned else 0,
        "ovulation_conflict": ovulation_conflict,
        "based_on": based_on,
        "quality": _cycle_data_quality(usable_count, cycle_known),
        "usable_cycles": usable_count,
        "unusual_intervals": len(info["unusual"]),
        "data_stale": data_stale,
    }


def cycle_reminder_kinds(forecast: dict[str, Any] | None, prefs: dict[str, Any] | None = None) -> list[tuple[str, str]]:
    """Те же правила и тексты, что cycleReminderKinds в worker.js.

    Овуляция и фертильное окно не анонсируются при недостаточном качестве
    данных (прогноз по дефолтным 28 дням) или устаревшей истории —
    уверенное уведомление по календарной оценке вводит в заблуждение (4.2).
    """
    if not forecast:
        return []
    prefs = prefs or {}

    def on(key: str) -> bool:
        # В БД флаги — 0/1: приводим к bool, иначе `0 is not False` включал
        # бы выключенные напоминания.
        return bool(prefs.get(key, True))

    period_days = prefs.get("period_days", 2)
    delay_days = prefs.get("delay_days", 3)
    out: list[tuple[str, str]] = []
    if on("period") and forecast["phase"] not in ("menstruation", "delay") and forecast["next_period_in"] == period_days:
        text = "Завтра ожидаются месячные" if period_days == 1 else f"Через {period_days} дн. ожидаются месячные"
        out.append(("cycle_period", text))
    # Fail-safe: отсутствие quality/based_on трактуется как недостаточные
    # данные, не как достаточные (паритет с worker.js).
    ovulation_trustworthy = (
        forecast.get("quality") is not None
        and forecast.get("quality") != "insufficient"
        and forecast.get("data_stale") is not True
        and forecast.get("based_on") is not None
        and forecast.get("based_on") != "default"
    )
    if on("ovulation") and forecast["ovulation_in"] == 0 and ovulation_trustworthy:
        out.append(("cycle_ovulation", (
            "Сегодня вероятный день овуляции — календарная оценка, не подтверждение"
        )))
    if on("fertile") and forecast["ovulation_in"] == 5 and ovulation_trustworthy:
        out.append(("cycle_fertile", (
            "Начинается календарное фертильное окно — приблизительная оценка"
        )))
    if on("delay") and forecast["phase"] == "delay" and forecast["delay_days"] == delay_days:
        out.append(("cycle_delay", "Возможна задержка, загляни в календарь Фло"))
    return out


def cycle_text(forecast: dict[str, Any] | None, open_start: date | None) -> str:
    """Короткий текст для бота: день цикла, фаза и ближайший прогноз."""
    if not forecast:
        return "Фло: отметьте первые месячные, и появится прогноз."
    lines = [f"<b>День {forecast['cycle_day']} цикла</b> · {CYCLE_PHASE_LABELS.get(forecast['phase'], '')}"]
    if forecast["phase"] == "stale":
        lines.append("Давно не было новых записей — данные могли устареть. Отметь прошедшие месячные.")
    elif forecast["phase"] == "delay":
        lines.append(f"Задержка {forecast['delay_days']} дн.")
    elif open_start:
        lines.append(f"Месячные идут с {open_start.isoformat()}")
    else:
        lines.append(f"Месячные примерно через {forecast['next_period_in']} дн.")
    if forecast["phase"] not in ("delay", "stale") and forecast["ovulation_in"] > 0:
        lines.append(f"Овуляция примерно через {forecast['ovulation_in']} дн.")
    if forecast["irregular"]:
        lines.append("Цикл нерегулярный, прогнозы приблизительные.")
    lines.append("<i>Прогноз приблизительный и не заменяет консультацию врача</i>")
    return "\n".join(lines)


async def is_female(db: Any, tg_id: int) -> bool:
    rows = await db.query("SELECT gender FROM users WHERE tg_id=?", (tg_id,))
    return bool(rows) and rows[0].get("gender") == "female"


async def load_measurements(db: Any, tg_id: int) -> list[dict[str, Any]]:
    """Измерения БТ/ЛГ для уточнения прогноза (паритет с measurements в cycleState)."""
    return await db.query(
        "SELECT date, kind, value, unit, result FROM cycle_measurements WHERE tg_id=? ORDER BY date ASC, id ASC",
        (tg_id,),
    )


async def load_periods(db: Any, tg_id: int) -> list[tuple[date, date | None, bool]]:
    rows = await db.query(
        "SELECT start_date, end_date, end_unknown FROM cycle_periods WHERE tg_id=? ORDER BY start_date DESC, id DESC LIMIT 36",
        (tg_id,),
    )
    return [
        (
            date.fromisoformat(r["start_date"]),
            date.fromisoformat(r["end_date"]) if r.get("end_date") else None,
            bool(r.get("end_unknown")),
        )
        for r in rows
    ]


async def load_profile(db: Any, tg_id: int, now_ts: int) -> dict[str, int]:
    await db.execute(
        "INSERT OR IGNORE INTO cycle_profiles(tg_id, created_at, updated_at) VALUES(?,?,?)",
        (tg_id, now_ts, now_ts),
    )
    rows = await db.query(
        "SELECT avg_cycle_length, avg_period_length, cycle_length_known FROM cycle_profiles WHERE tg_id=?", (tg_id,)
    )
    row = rows[0] if rows else {}
    return {
        "avg_cycle_length": int(row.get("avg_cycle_length") or 28),
        "avg_period_length": int(row.get("avg_period_length") or 5),
        "cycle_length_known": int(row.get("cycle_length_known") or 0),
    }


async def mark_period(db: Any, tg_id: int, start: date, end: date | None, now_ts: int, end_unknown: bool = False) -> None:
    await db.execute(
        """INSERT INTO cycle_periods(tg_id, start_date, end_date, end_unknown, created_at, updated_at) VALUES(?,?,?,?,?,?)
        ON CONFLICT(tg_id, start_date) DO UPDATE SET end_date=excluded.end_date, end_unknown=0, updated_at=excluded.updated_at""",
        (tg_id, start.isoformat(), end.isoformat() if end else None, 1 if end_unknown else 0, now_ts, now_ts),
    )


async def bulk_mark_periods(
    db: Any, tg_id: int, items: Sequence[tuple[date, date | None, bool]], now_ts: int
) -> tuple[int, int]:
    """Пакетная вставка прошлых периодов (паритет с POST /api/cycle/periods).

    items: (start, end|None, end_unknown). Конфликт по (tg_id,start_date)
    пропускается — существующая запись не перезаписывается.
    Возвращает (inserted, skipped).
    """
    inserted = skipped = 0
    for start, end, unknown in items:
        _, changes = await db.execute_row(
            """INSERT INTO cycle_periods(tg_id, start_date, end_date, end_unknown, created_at, updated_at)
               VALUES(?,?,?,?,?,?) ON CONFLICT(tg_id, start_date) DO NOTHING""",
            (tg_id, start.isoformat(), end.isoformat() if end else None, 1 if unknown else 0, now_ts, now_ts),
        )
        if changes:
            inserted += 1
        else:
            skipped += 1
    return inserted, skipped


async def close_open_period(db: Any, tg_id: int, end: date, now_ts: int) -> bool:
    _, changes = await db.execute_row(
        "UPDATE cycle_periods SET end_date=?, updated_at=? WHERE tg_id=? AND end_date IS NULL AND end_unknown=0",
        (end.isoformat(), now_ts, tg_id),
    )
    return bool(changes)


# Подсказки партнёру (как в Mini App): нейтральные фразы о фазе. Без
# стереотипов о самочувствии — фаза его не определяет (переработка 11.2).
PARTNER_TIPS = {
    "menstruation": "Сейчас месячные: спроси, какая поддержка нужна — она знает лучше.",
    "follicular": "Календарная фаза — фолликулярная. Не делай вывод о самочувствии только по фазе.",
    "fertile": "Календарная оценка фертильного окна. Обсудите планы между собой.",
    "ovulation": "Календарная оценка дня овуляции, не подтверждённое наблюдение.",
    "luteal": "Календарная фаза — лютеиновая. Персональных данных о самочувствии нет — просто спроси.",
    "delay": "Месячные не начались к ожидаемой дате. Спокойно поддержи и не дави.",
}

# Короткие уведомления партнёру при смене фазы: нейтральные, без
# стереотипов о самочувствии (переработка 11.2, паритет с worker.js).
PARTNER_NOTICES = {
    "menstruation": "У партнёрши начались месячные. Спроси, какая поддержка сейчас нужна.",
    "ovulation": "Календарная оценка дня овуляции — приблизительный расчёт, не подтверждение.",
    "delay": "Месячные не начались к ожидаемой дате. Спокойная поддержка помогает.",
}


async def share_state(db: Any, tg_id: int) -> dict[str, Any]:
    rows = await db.query(
        "SELECT share_enabled, share_level, share_notify, share_sex, share_mood,"
        " share_sleep, share_bbt, share_confirmed"
        " FROM cycle_profiles WHERE tg_id=?",
        (tg_id,),
    )
    row = rows[0] if rows else {}
    return {
        "enabled": int(row.get("share_enabled") or 0) == 1,
        "level": row.get("share_level") or "phases",
        "notify": int(row.get("share_notify") if row.get("share_notify") is not None else 1) == 1,
        "categories": {
            "sex": int(row.get("share_sex") or 0) == 1,
            "mood": int(row.get("share_mood") or 0) == 1,
            "sleep": int(row.get("share_sleep") or 0) == 1,
            "bbt": int(row.get("share_bbt") or 0) == 1,
        },
        "confirmed": int(row.get("share_confirmed") or 0) == 1,
    }


async def set_share(db: Any, tg_id: int, enabled: bool, now_ts: int) -> None:
    await db.execute("UPDATE cycle_profiles SET share_enabled=?, updated_at=? WHERE tg_id=?", (1 if enabled else 0, now_ts, tg_id))


async def set_share_notify(db: Any, tg_id: int, enabled: bool, now_ts: int) -> None:
    await db.execute("UPDATE cycle_profiles SET share_notify=?, updated_at=? WHERE tg_id=?", (1 if enabled else 0, now_ts, tg_id))


async def partner_ids(db: Any, tg_id: int) -> list[int]:
    rows = await db.query(
        "SELECT pm2.tg_id FROM pair_members pm1 JOIN pair_members pm2 ON pm2.pair_id=pm1.pair_id AND pm2.tg_id<>pm1.tg_id WHERE pm1.tg_id=?",
        (tg_id,),
    )
    return [int(r["tg_id"]) for r in rows]


async def partner_view_text(db: Any, owner_id: int, today: date) -> str | None:
    """Что видит партнёр в боте — белый список по категориям, как в Mini App.

    Календарь (фаза + подсказка + даты месячных) — базовая часть включённого
    шеринга. Секс, настроение, качество сна (только good/ok/poor) и
    базальная температура — только по включённым категориям и после
    подтверждения состава. Симптомы, заметки и прочие личные поля не
    отдаются никогда; при отсутствии подтверждения передаётся только
    календарная оценка (паритет с cycleViewForPartner в worker.js).
    """
    share = await share_state(db, owner_id)
    if not share["enabled"] or not await is_female(db, owner_id):
        return None
    cats = share["categories"] if share["confirmed"] else {}
    periods = await load_periods(db, owner_id)
    measurements = await load_measurements(db, owner_id)
    rows = await db.query(
        "SELECT avg_cycle_length, avg_period_length, cycle_length_known FROM cycle_profiles WHERE tg_id=?", (owner_id,)
    )
    row = rows[0] if rows else {}
    today_logs = await load_logs(db, owner_id, today, today)
    sick_dates = [entry["date"] for entry in today_logs if entry.get("sick")]
    forecast = cycle_forecast(
        periods, today,
        int(row.get("avg_cycle_length") or 28), int(row.get("avg_period_length") or 5),
        row.get("cycle_length_known"), measurements, sick_dates,
    )
    if not forecast:
        return "Партнёрша делится календарём, но данных пока мало."
    label = CYCLE_PHASE_LABELS.get(forecast["phase"], "")
    lines = [f"Фаза: <b>{label}</b>. {PARTNER_TIPS.get(forecast['phase'], '')}"]
    # Даты месячных — часть календарной категории (после подтверждения).
    if share["confirmed"]:
        recent = periods[:6]
        if recent:
            parts = []
            for start, end, unknown in recent:
                if end:
                    parts.append(f"{start.isoformat()} — {end.isoformat()}")
                elif unknown:
                    parts.append(f"{start.isoformat()} (конец неизвестен)")
                else:
                    parts.append(f"{start.isoformat()} (идут)")
            lines.append("Месячные: " + "; ".join(parts))
        lines.append("Прогноз приблизительный и не является методом контрацепции.")
    if cats.get("sex"):
        for day_log in today_logs:
            if day_log.get("sex") in ("protected", "unprotected"):
                lines.append("Секс: " + ("с защитой" if day_log["sex"] == "protected" else "без защиты"))
            elif day_log.get("sex") == "none":
                lines.append("Секс: без секса (отмечено)")
    if cats.get("mood"):
        for day_log in today_logs:
            if day_log.get("mood"):
                lines.append(f"Настроение: {MOOD_LABELS.get(day_log['mood'], day_log['mood'])}")
    if cats.get("sleep"):
        sleep_labels = {"good": "хорошо", "ok": "средне", "poor": "плохо"}
        for day_log in today_logs:
            if day_log.get("sleep_quality") in sleep_labels:
                lines.append(f"Сон: {sleep_labels[day_log['sleep_quality']]}")
    if cats.get("bbt"):
        for m in measurements:
            if m.get("date") == today.isoformat() and m.get("kind") == "bbt":
                unit = m.get("unit") or "C"
                lines.append(f"БТ: {m.get('value')}°{unit}")
    if not share["confirmed"]:
        lines.append("Подробные отметки появятся после подтверждения состава данных.")
    lines.append("Без симптомов, заметок и препаратов.")
    return "\n".join(lines)


async def export_json(db: Any, tg_id: int, now_ts: int) -> bytes:
    """Выгрузка владелицы: тот же формат, что у Mini App (duoplan-cycle v1)."""
    profile_rows = await db.query(
        "SELECT avg_cycle_length, avg_period_length, share_enabled, share_level FROM cycle_profiles WHERE tg_id=?", (tg_id,)
    )
    profile = profile_rows[0] if profile_rows else {}
    periods = await db.query(
        "SELECT start_date, end_date, end_unknown FROM cycle_periods WHERE tg_id=? ORDER BY start_date ASC, id ASC", (tg_id,)
    )
    logs = await db.query(
        "SELECT date, flow, clots, energy, mood, symptoms, symptoms_clear, note, sex, leakage, pain_score, pain_locations, life_impact, mucus, sleep_hours, sleep_quality, stress, sick, travel, weight_kg, bleeding_details FROM cycle_logs WHERE tg_id=? ORDER BY date ASC, id ASC", (tg_id,)
    )
    meds = await db.query(
        "SELECT id, name, category, dosage, form, schedule, start_date, end_date, status, note FROM cycle_meds WHERE tg_id=? ORDER BY start_date ASC, id ASC", (tg_id,)
    )
    med_logs = await db.query(
        "SELECT med_id, date, time, status, dose_taken, note FROM cycle_med_logs WHERE tg_id=? ORDER BY date ASC, id ASC", (tg_id,)
    )
    measurements = await db.query(
        "SELECT id, date, time, kind, value, unit, result, note FROM cycle_measurements WHERE tg_id=? ORDER BY date ASC, id ASC", (tg_id,)
    )
    payload = {
        "format": "duoplan-cycle",
        "version": 1,
        "exported_at": datetime.fromtimestamp(now_ts, UTC).isoformat(),
        "profile": {
            "avg_cycle_length": int(profile.get("avg_cycle_length") or 28),
            "avg_period_length": int(profile.get("avg_period_length") or 5),
            "share_enabled": int(profile.get("share_enabled") or 0) == 1,
            "share_level": profile.get("share_level") or "phases",
        },
        "periods": [
            {
                "start_date": r["start_date"],
                "end_date": r.get("end_date"),
                "end_unknown": bool(r.get("end_unknown")),
            }
            for r in periods
        ],
        "logs": [
            {
                "date": r["date"],
                "flow": r.get("flow"),
                "mood": r.get("mood"),
                "symptoms": json.loads(r.get("symptoms") or "[]"),
                "note": r.get("note") or "",
                "sex": r.get("sex"),
                "leakage": r.get("leakage"),
                "pain_score": r.get("pain_score"),
                "pain_locations": json.loads(r.get("pain_locations") or "[]"),
                "life_impact": r.get("life_impact"),
                "mucus": json.loads(r.get("mucus")) if r.get("mucus") else None,
                "sleep_hours": r.get("sleep_hours"),
                "sleep_quality": r.get("sleep_quality"),
                "stress": r.get("stress"),
                "sick": bool(r.get("sick")),
                "travel": bool(r.get("travel")),
                "weight_kg": r.get("weight_kg"),
                "bleeding_details": (
                    json.loads(r["bleeding_details"]) if r.get("bleeding_details") else None
                ),
            }
            for r in logs
        ],
        "meds": [
            {
                "id": m["id"],
                "name": m["name"],
                "category": m.get("category"),
                "dosage": m.get("dosage"),
                "form": m.get("form"),
                "schedule": m.get("schedule"),
                "start_date": m["start_date"],
                "end_date": m.get("end_date"),
                "status": m.get("status") or "active",
                "note": m.get("note") or "",
            }
            for m in meds
        ],
        "med_logs": [
            {
                "med_id": ml["med_id"],
                "date": ml["date"],
                "time": ml.get("time"),
                "status": ml["status"],
                "dose_taken": ml.get("dose_taken"),
                "note": ml.get("note") or "",
            }
            for ml in med_logs
        ],
        "measurements": [
            {
                "id": mm["id"],
                "date": mm["date"],
                "time": mm.get("time"),
                "kind": mm["kind"],
                "value": mm.get("value"),
                "unit": mm.get("unit"),
                "result": mm.get("result"),
                "note": mm.get("note") or "",
            }
            for mm in measurements
        ],
    }
    return json.dumps(payload, ensure_ascii=False, indent=2).encode("utf-8")


# ---------------------------------------------------------------------------
# Запись дневника дня (cycle_logs): один код настроения, список симптомов.
# ---------------------------------------------------------------------------


async def load_logs(db: Any, tg_id: int, from_date: date | None = None, to_date: date | None = None) -> list[dict[str, Any]]:
    where = "WHERE tg_id=?"
    params = [tg_id]
    if from_date:
        where += " AND date>=?"
        params.append(from_date.isoformat())
    if to_date:
        where += " AND date<=?"
        params.append(to_date.isoformat())
    rows = await db.query(
        f"SELECT date, flow, clots, energy, mood, symptoms, symptoms_clear, note, sex, leakage, pain_score, pain_locations, life_impact, mucus, sleep_hours, sleep_quality, stress, sick, travel, weight_kg, bleeding_details FROM cycle_logs {where} ORDER BY date ASC, id ASC",
        tuple(params),
    )
    return [
        {
            "date": r["date"],
            "flow": r.get("flow"),
            "clots": bool(r.get("clots")),
            "energy": r.get("energy"),
            "mood": r.get("mood"),
            "symptoms": json.loads(r.get("symptoms") or "[]"),
            "symptoms_clear": bool(r.get("symptoms_clear")),
            "note": r.get("note") or "",
            "sex": r.get("sex"),
            "leakage": r.get("leakage"),
            "pain_score": r.get("pain_score"),
            "pain_locations": json.loads(r.get("pain_locations") or "[]"),
            "life_impact": r.get("life_impact"),
            "mucus": json.loads(r.get("mucus")) if r.get("mucus") else None,
            "sleep_hours": r.get("sleep_hours"),
            "sleep_quality": r.get("sleep_quality"),
            "stress": r.get("stress"),
            "sick": bool(r.get("sick")),
            "travel": bool(r.get("travel")),
            "weight_kg": r.get("weight_kg"),
            "bleeding_details": (
                json.loads(r["bleeding_details"]) if r.get("bleeding_details") else None
            ),
        }
        for r in rows
    ]


async def upsert_log(
    db: Any,
    tg_id: int,
    day: date,
    flow: str | None = None,
    mood: str | None = None,
    symptoms: Sequence[str] | None = None,
    note: str | None = None,
    sex: str | None = None,
    clots: bool | None = None,
    energy: str | None = None,
    symptoms_clear: bool | None = None,
    leakage: str | None = None,
    pain_score: int | None = None,
    pain_locations: Sequence[str] | None = None,
    life_impact: str | None = None,
    mucus: dict[str, Any] | None = None,
    sleep_hours: float | None = None,
    sleep_quality: str | None = None,
    stress: str | None = None,
    sick: bool | None = None,
    travel: bool | None = None,
    weight_kg: float | None = None,
    bleeding_details: dict[str, Any] | None = None,
    now_ts: int | None = None,
) -> None:
    """Записать или обновить дневник дня. Валидация кодов — в handlers.py."""
    if now_ts is None:
        now_ts = int(datetime.now(UTC).timestamp())
    await db.execute(
        """INSERT INTO cycle_logs(tg_id, date, flow, clots, energy, mood, symptoms, symptoms_clear, note, sex, leakage, pain_score, pain_locations, life_impact, mucus, sleep_hours, sleep_quality, stress, sick, travel, weight_kg, bleeding_details, created_at, updated_at)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
        ON CONFLICT(tg_id, date) DO UPDATE SET
        flow=excluded.flow, clots=excluded.clots, energy=excluded.energy, mood=excluded.mood,
        symptoms=excluded.symptoms, symptoms_clear=excluded.symptoms_clear,
        note=excluded.note, sex=excluded.sex, leakage=excluded.leakage,
        pain_score=excluded.pain_score, pain_locations=excluded.pain_locations,
        life_impact=excluded.life_impact, mucus=excluded.mucus,
        sleep_hours=excluded.sleep_hours, sleep_quality=excluded.sleep_quality,
        stress=excluded.stress, sick=excluded.sick, travel=excluded.travel,
        weight_kg=excluded.weight_kg, bleeding_details=excluded.bleeding_details,
        updated_at=excluded.updated_at""",
        (
            tg_id,
            day.isoformat(),
            flow,
            int(bool(clots)),
            energy,
            mood,
            json.dumps(symptoms or []),
            int(bool(symptoms_clear)),
            note,
            sex,
            leakage,
            pain_score,
            json.dumps(list(pain_locations or [])),
            life_impact,
            json.dumps(mucus) if mucus else None,
            sleep_hours,
            sleep_quality,
            stress,
            int(bool(sick)),
            int(bool(travel)),
            weight_kg,
            json.dumps(bleeding_details) if bleeding_details else None,
            now_ts,
            now_ts,
        ),
    )


# ---------------------------------------------------------------------------
# Настройки профиля (avg_cycle_length, avg_period_length, notify_*, share_*).
# ---------------------------------------------------------------------------


async def update_profile(db: Any, tg_id: int, updates: dict[str, Any], now_ts: int | None = None) -> None:
    """Обновить поля cycle_profiles. Валидация значений — в handlers.py."""
    if not updates:
        return
    if now_ts is None:
        now_ts = int(datetime.now(UTC).timestamp())
    fields = [f"{k}=?" for k in updates if k in _PROFILE_FIELDS]
    values = [updates[k] for k in updates if k in _PROFILE_FIELDS]
    if not fields:
        return
    fields.append("updated_at=?")
    values.append(now_ts)
    values.append(tg_id)
    await db.execute(f"UPDATE cycle_profiles SET {', '.join(fields)} WHERE tg_id=?", tuple(values))


# ---------------------------------------------------------------------------
# Дедуп уведомлений через notification_log (как в worker.js).
# ---------------------------------------------------------------------------


async def notification_already_sent(db: Any, tg_id: int, day: date, kind: str) -> bool:
    row = await db.one(
        "SELECT 1 FROM notification_log WHERE tg_id=? AND day=? AND kind=?",
        (tg_id, day.isoformat(), kind),
    )
    return row is not None


async def mark_notification_sent(db: Any, tg_id: int, day: date, kind: str, now_ts: int | None = None) -> None:
    if now_ts is None:
        now_ts = int(datetime.now(UTC).timestamp())
    await db.execute(
        "INSERT OR IGNORE INTO notification_log(tg_id, day, kind, sent_at) VALUES(?,?,?,?)",
        (tg_id, day.isoformat(), kind, now_ts),
    )


async def prune_old_notifications(db: Any, days: int = 7) -> int:
    """Удалить записи старше N дней. Возвращает число удалённых строк."""
    cutoff = (date.today() - timedelta(days=days)).isoformat()
    row_id, _ = await db.execute_row("DELETE FROM notification_log WHERE day < ?", (cutoff,))
    return row_id


# ---------------------------------------------------------------------------
# Отправка уведомлений через Telegram. Коллбек для интеграции с handlers.py.
# ---------------------------------------------------------------------------


SendNotification = Callable[[int, str], Awaitable[None]]


async def send_cycle_reminders(
    db: Any,
    send_fn: SendNotification,
    tz_getter: Callable[[int], str | None],
    now: datetime | None = None,
) -> None:
    """Напоминания владелице и партнёру (аналог sendCycleReminders в worker.js).

    tz_getter(tg_id) возвращает имя пояса пользователя (users.timezone) или None.
    send_fn(tg_id, text) отправляет сообщение в личный чат пользователя.
    """
    now = now or datetime.now(UTC)
    today = now.date()
    now_ts = int(now.timestamp())

    # Владелицы: только gender='female' + onboarded + notify_enabled или share_notify.
    owners = await db.query(
        """SELECT p.tg_id, u.timezone, p.notify_enabled, p.notify_period, p.notify_ovulation,
        p.notify_fertile, p.notify_delay, p.notify_period_days, p.notify_delay_days,
        p.notify_diary, p.share_enabled, p.share_notify FROM cycle_profiles p
        JOIN users u ON u.tg_id=p.tg_id
        WHERE p.onboarded=1 AND u.gender='female' AND (p.notify_enabled=1 OR (p.share_enabled=1 AND p.share_notify=1))"""
    )

    for owner in owners:
        tg_id = int(owner["tg_id"])
        tz_name = owner.get("timezone") or tz_getter(tg_id) or "Europe/Moscow"
        today_local = today_in_tz(tz_name, now)

        # Прогноз и профиль.
        periods = await load_periods(db, tg_id)
        measurements = await load_measurements(db, tg_id)
        profile = await load_profile(db, tg_id, now_ts)
        recent_logs = await load_logs(db, tg_id, today_local - timedelta(days=400), today_local)
        sick_dates = [entry["date"] for entry in recent_logs if entry.get("sick")]
        forecast = cycle_forecast(
            periods, today_local,
            profile["avg_cycle_length"], profile["avg_period_length"],
            profile.get("cycle_length_known", 0), measurements, sick_dates,
        )

        # Напоминания владелице.
        if int(owner.get("notify_enabled", 0)) == 1:
            prefs = {
                "period": int(owner.get("notify_period", 1)) == 1,
                "ovulation": int(owner.get("notify_ovulation", 1)) == 1,
                "fertile": int(owner.get("notify_fertile", 1)) == 1,
                "delay": int(owner.get("notify_delay", 1)) == 1,
                "period_days": int(owner.get("notify_period_days", 2)),
                "delay_days": int(owner.get("notify_delay_days", 3)),
                "diary": int(owner.get("notify_diary", 0)) == 1,
            }
            for kind, text in cycle_reminder_kinds(forecast, prefs):
                if not await notification_already_sent(db, tg_id, today_local, kind):
                    await send_fn(tg_id, text)
                    await mark_notification_sent(db, tg_id, today_local, kind, now_ts)
            # Напоминание о дневнике (P3): вчера без записи — одна
            # нейтральная подсказка в день, дедуп через notification_log.
            if prefs["diary"]:
                yesterday = today_local - timedelta(days=1)
                logs = await load_logs(db, tg_id, yesterday, yesterday)
                kind = "cycle_diary"
                if not logs and not await notification_already_sent(db, tg_id, today_local, kind):
                    await send_fn(tg_id, "Вчерашний день не записан в дневнике Фло — если хочешь, отметь его.")
                    await mark_notification_sent(db, tg_id, today_local, kind, now_ts)

        # Напоминания партнёру (только при смене фазы, без дат и подробностей).
        # Уведомление об овуляции — только при достаточном качестве данных:
        # календарная оценка по дефолту не повод для уверенного сообщения
        # (переработка 4.2, паритет с worker.js).
        if int(owner.get("share_enabled", 0)) == 1 and int(owner.get("share_notify", 1)) == 1 and not forecast.get("empty"):
            yesterday = today_local - timedelta(days=1)
            before = cycle_forecast(
                periods, yesterday,
                profile["avg_cycle_length"], profile["avg_period_length"],
                profile.get("cycle_length_known", 0), measurements, sick_dates,
            )
            before_phase = before.get("phase") if before else None
            phase = forecast.get("phase")
            ovulation_trustworthy = (
                forecast.get("quality") is not None
                and forecast.get("quality") != "insufficient"
                and forecast.get("data_stale") is not True
                and forecast.get("based_on") is not None
                and forecast.get("based_on") != "default"
            )
            text = PARTNER_NOTICES.get(phase)
            if phase == "ovulation" and not ovulation_trustworthy:
                text = None
            if text and phase != before_phase:
                partners = await partner_ids(db, tg_id)
                for partner_id in partners:
                    partner_kind = f"cycle_partner_{phase}"
                    if not await notification_already_sent(db, partner_id, today_local, partner_kind):
                        await send_fn(partner_id, text)
                        await mark_notification_sent(db, partner_id, today_local, partner_kind, now_ts)

