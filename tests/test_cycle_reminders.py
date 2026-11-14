"""Тесты доставки напоминаний Фло (send_cycle_reminders).

Проверяют весь путь: выбор onboarded-владелиц, прогноз, дедуп через
notification_log и — главное — уведомление партнёру при смене фазы.
Регресс: раньше Python считал «вчерашнюю» фазу по today, а не по yesterday,
поэтому phase != before_phase всегда было ложным и партнёр никогда не
получал уведомление о смене фазы (в worker.js было правильно).
"""

from datetime import UTC, datetime

from duoplan.cycle import send_cycle_reminders

# 2026-11-12 10:00 UTC = 13:00 MSK — «сегодня» в Europe/Moscow.
NOW = datetime(2026, 11, 12, 10, 0, tzinfo=UTC)


def _ts() -> int:
    return int(NOW.timestamp())


async def _setup(pair, *, notify_enabled=1, share_enabled=1, share_notify=1):
    service, pair_id, owner, partner = pair
    db = service.db
    ts = _ts()
    await db.execute("UPDATE users SET gender='female', timezone='Europe/Moscow' WHERE tg_id=?", (owner,))
    await db.execute("UPDATE users SET gender='male', timezone='Europe/Moscow' WHERE tg_id=?", (partner,))
    await db.execute(
        "INSERT INTO cycle_profiles(tg_id, avg_cycle_length, avg_period_length, "
        "share_enabled, share_notify, onboarded, notify_enabled, created_at, updated_at) "
        "VALUES(?,?,?,?,?,1,?,?,?)",
        (owner, 28, 5, 1 if share_enabled else 0, 1 if share_notify else 0, 1 if notify_enabled else 0, ts, ts),
    )
    await db.execute(
        "INSERT INTO cycle_periods(tg_id, start_date, end_date, created_at, updated_at) VALUES(?,?,?,?,?)",
        (owner, "2026-10-29", "2026-11-02", ts, ts),
    )
    # История из четырёх пригодных интервалов по 28 дней: качество «full»,
    # based_on «history» — уведомления об овуляции проходят гейтинг (4.2).
    # Последний старт 2026-10-29 → овуляция 2026-11-12 (сегодня в NOW).
    # «Конец не помним» (end_unknown=1) — не открытые периоды.
    for start, end in (
        ("2026-10-01", "2026-10-05"),
        ("2026-09-03", "2026-09-07"),
        ("2026-08-06", "2026-08-10"),
        ("2026-07-09", "2026-07-13"),
    ):
        await db.execute(
            "INSERT INTO cycle_periods(tg_id, start_date, end_date, end_unknown, created_at, updated_at) VALUES(?,?,?,1,?,?)",
            (owner, start, end, ts, ts),
        )
    return db, owner, partner


class _Recorder:
    def __init__(self):
        self.sent = []

    async def send(self, tg_id, text):
        self.sent.append((tg_id, text))


# При avg_cycle=28 и старте 2026-10-29 овуляция приходится на 2026-11-12:
# today — овуляция, yesterday (2026-11-11) — фертильное окно → смена фазы.
async def test_partner_gets_notice_on_phase_change(pair):
    db, owner, partner = await _setup(pair)
    rec = _Recorder()
    await send_cycle_reminders(db, rec.send, lambda _tg: "Europe/Moscow", now=NOW)

    owner_msgs = [t for tid, t in rec.sent if tid == owner]
    partner_msgs = [t for tid, t in rec.sent if tid == partner]
    # Владелице — напоминание об овуляции.
    assert any("овуляци" in t for t in owner_msgs)
    # Партнёру — уведомление о смене фазы на овуляцию (регресс: раньше не приходило).
    assert any("овуляци" in t for t in partner_msgs)


async def test_no_phase_change_no_partner_notice(pair):
    db, owner, partner = await _setup(pair)
    # 2026-11-20 — глубокая лютеиновая, вчера (11-19) тоже лютеиновая: смены фазы нет.
    rec = _Recorder()
    await send_cycle_reminders(db, rec.send, lambda _tg: "Europe/Moscow", now=datetime(2026, 11, 20, 10, 0, tzinfo=UTC))

    partner_msgs = [t for tid, t in rec.sent if tid == partner]
    assert partner_msgs == []


async def test_insufficient_history_no_ovulation_notices(pair):
    """Гейтинг 4.2: без пригодной истории уверенных уведомлений об овуляции нет.

    Один период → usable=0 → based_on=profile → quality=insufficient:
    ни владелице, ни партнёру овуляция не анонсируется.
    """
    db, owner, _partner = await _setup(pair, notify_enabled=0, share_enabled=1)
    await db.execute("UPDATE cycle_profiles SET notify_enabled=1 WHERE tg_id=?", (owner,))
    await db.execute("DELETE FROM cycle_periods WHERE tg_id=? AND start_date<>'2026-10-29'", (owner,))
    rec = _Recorder()
    await send_cycle_reminders(db, rec.send, lambda _tg: "Europe/Moscow", now=NOW)

    all_msgs = [t for _, t in rec.sent]
    assert not any("овуляци" in t for t in all_msgs), "при недостаточных данных овуляция не анонсируется"


async def test_notify_disabled_no_owner_reminder(pair):
    db, owner, partner = await _setup(pair, notify_enabled=0, share_enabled=0)
    rec = _Recorder()
    await send_cycle_reminders(db, rec.send, lambda _tg: "Europe/Moscow", now=NOW)

    owner_msgs = [t for tid, t in rec.sent if tid == owner]
    assert owner_msgs == []


async def test_reminders_dedup_across_runs(pair):
    db, owner, partner = await _setup(pair)
    rec = _Recorder()
    await send_cycle_reminders(db, rec.send, lambda _tg: "Europe/Moscow", now=NOW)
    first_count = len(rec.sent)
    # Второй прогон в тот же день — notification_log уже отмечен, повторов нет.
    await send_cycle_reminders(db, rec.send, lambda _tg: "Europe/Moscow", now=NOW)
    assert len(rec.sent) == first_count
