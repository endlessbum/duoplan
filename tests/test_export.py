import sqlite3
from pathlib import Path

import pytest

from duoplan.db.schema import SCHEMA
from scripts.export_sqlite_to_d1 import TABLES, dump


def _make_db(path: Path) -> None:
    """Схема с дополнительными колонками (timezone, tasks.day/time, dates.time)."""
    con = sqlite3.connect(path)
    con.executescript(
        """
        CREATE TABLE pairs (id INTEGER PRIMARY KEY, code TEXT, name1 TEXT, name2 TEXT, user_a INTEGER, user_b INTEGER, started_at TEXT, together_pts INTEGER, timezone TEXT, created_at INTEGER, updated_at INTEGER);
        CREATE TABLE users (tg_id INTEGER PRIMARY KEY, username TEXT, display_name TEXT, role TEXT, pair_id INTEGER, points INTEGER, streak INTEGER, last_activity TEXT, best_streak INTEGER, timezone TEXT, gender TEXT, created_at INTEGER, updated_at INTEGER);
        CREATE TABLE tasks (id INTEGER PRIMARY KEY, pair_id INTEGER, title TEXT, status TEXT, day TEXT, time TEXT, created_by INTEGER, created_at INTEGER, completed_by INTEGER, completed_at INTEGER);
        CREATE TABLE dates (id INTEGER PRIMARY KEY, pair_id INTEGER, title TEXT, day TEXT, time TEXT, recurs INTEGER, monthly INTEGER, is_private INTEGER, created_by INTEGER, kind TEXT, created_at INTEGER);
        CREATE TABLE memories (id INTEGER PRIMARY KEY, pair_id INTEGER, author_id INTEGER, body TEXT, day TEXT, created_at INTEGER);
        CREATE TABLE wishes (id INTEGER PRIMARY KEY, pair_id INTEGER, owner_id INTEGER, body TEXT, done INTEGER, created_at INTEGER);
        CREATE TABLE daily_rolls (pair_id INTEGER, day TEXT, daily_value TEXT, done_by INTEGER, done_at INTEGER, PRIMARY KEY(pair_id,day));
        CREATE TABLE app_meta (key TEXT PRIMARY KEY, value TEXT);
        """
    )
    con.execute(
        "INSERT INTO pairs(id,code,name1,name2,user_a,user_b,started_at,together_pts,timezone,created_at,updated_at) "
        "VALUES(1,'ABC','Owner','',10,0,'2026-01-01',0,'Australia/Sydney',1,1)"
    )
    con.execute(
        "INSERT INTO users(tg_id,display_name,role,points,streak,best_streak,timezone,created_at,updated_at) "
        "VALUES(10,'Owner','a',0,0,0,'Pacific/Auckland',1,1)"
    )
    con.execute(
        "INSERT INTO tasks(id,pair_id,title,status,day,time,created_by,created_at) "
        "VALUES(1,1,'Поездка','open','2026-10-04','09:30',10,1)"
    )
    con.execute(
        "INSERT INTO dates(id,pair_id,title,day,time,recurs,created_at) "
        "VALUES(1,1,'Знакомство','2020-05-17','18:00',1,1)"
    )
    con.commit()
    con.close()


def _make_plain_db(path: Path) -> None:
    """Схема без дополнительных колонок — как текущая data/duoplan.db."""
    con = sqlite3.connect(path)
    con.executescript(
        """
        CREATE TABLE pairs (id INTEGER PRIMARY KEY, code TEXT, name1 TEXT, name2 TEXT, user_a INTEGER, user_b INTEGER, started_at TEXT, together_pts INTEGER, created_at INTEGER, updated_at INTEGER);
        CREATE TABLE users (tg_id INTEGER PRIMARY KEY, username TEXT, display_name TEXT, role TEXT, pair_id INTEGER, points INTEGER, streak INTEGER, last_activity TEXT, best_streak INTEGER, created_at INTEGER, updated_at INTEGER);
        CREATE TABLE tasks (id INTEGER PRIMARY KEY, pair_id INTEGER, title TEXT, status TEXT, created_by INTEGER, created_at INTEGER, completed_by INTEGER, completed_at INTEGER);
        CREATE TABLE dates (id INTEGER PRIMARY KEY, pair_id INTEGER, title TEXT, day TEXT, recurs INTEGER, created_at INTEGER);
        CREATE TABLE memories (id INTEGER PRIMARY KEY, pair_id INTEGER, author_id INTEGER, body TEXT, day TEXT, created_at INTEGER);
        CREATE TABLE wishes (id INTEGER PRIMARY KEY, pair_id INTEGER, owner_id INTEGER, body TEXT, done INTEGER, created_at INTEGER);
        CREATE TABLE daily_rolls (pair_id INTEGER, day TEXT, daily_value TEXT, done_by INTEGER, done_at INTEGER, PRIMARY KEY(pair_id,day));
        """
    )
    con.execute(
        "INSERT INTO pairs(id,code,name1,name2,user_a,user_b,started_at,together_pts,created_at,updated_at) "
        "VALUES(1,'ABC','Owner','',10,0,'2026-01-01',0,1,1)"
    )
    con.execute(
        "INSERT INTO users(tg_id,display_name,role,points,streak,best_streak,created_at,updated_at) "
        "VALUES(10,'Owner','a',0,0,0,1,1)"
    )
    con.execute(
        "INSERT INTO tasks(id,pair_id,title,status,created_by,created_at) VALUES(1,1,'Поездка','open',10,1)"
    )
    con.commit()
    con.close()


def test_export_includes_owner_for_empty_pair(tmp_path):
    db = tmp_path / "source.db"
    _make_db(db)
    sql = dump(db)
    assert "INSERT OR IGNORE INTO pair_members(tg_id,pair_id,role,joined_at) VALUES(10,1,'a',1);" in sql


def test_export_keeps_extended_schema_values(tmp_path):
    db = tmp_path / "source.db"
    _make_db(db)
    sql = dump(db)
    assert "'Australia/Sydney'" in sql  # pairs.timezone
    assert "'Pacific/Auckland'" in sql  # users.timezone
    assert "'2026-10-04'" in sql and "'09:30'" in sql  # tasks.day, tasks.time
    assert "'18:00'" in sql  # dates.time
    assert (
        "INSERT OR REPLACE INTO tasks(id, pair_id, title, status, day, time, monthly, yearly, is_private, "
        "created_by, created_at, completed_by, completed_at)"
    ) in sql


def test_export_substitutes_defaults_for_plain_schema(tmp_path):
    db = tmp_path / "source.db"
    _make_plain_db(db)
    sql = dump(db)
    # timezone в D1 — NOT NULL DEFAULT 'Europe/Moscow': вместо NULL подставляется дефолт.
    assert "INSERT OR REPLACE INTO pairs(id, code, name1, name2, user_a, user_b, started_at, together_pts, timezone, awaiting_return, last_partner, created_at, updated_at) VALUES(1, 'ABC', 'Owner', '', 10, 0, '2026-01-01', 0, 'Europe/Moscow', 0, 0, 1, 1);" in sql
    assert (
        "INSERT OR REPLACE INTO users(tg_id, username, display_name, role, gender, pair_id, "
        "points, streak, last_activity, best_streak, timezone, digest_time, digest_enabled, "
        "dates_digest_time, dates_digest_enabled, weekly_digest_enabled, weekly_digest_time, "
        "weekly_digest_day, accent_color, photo_url, show_avatar, "
        "partner_custom_name, custom_name, created_at, updated_at) "
        "VALUES(10, NULL, 'Owner', 'a', NULL, NULL, 0, 0, NULL, 0, 'Europe/Moscow', NULL, 1, "
        "NULL, 1, 0, NULL, 'sun', NULL, NULL, 1, NULL, NULL, 1, 1);"
    ) in sql
    # Nullable колонки без источника остаются NULL, а NOT NULL с DEFAULT —
    # получают дефолт (is_private не должен молча раскрыть личную запись).
    assert (
        "INSERT OR REPLACE INTO tasks(id, pair_id, title, status, day, time, monthly, yearly, is_private, "
        "created_by, created_at, completed_by, completed_at) "
        "VALUES(1, 1, 'Поездка', 'open', NULL, NULL, 0, 0, 0, 10, 1, NULL, NULL);"
    ) in sql


def test_export_replaces_null_timezone_with_default(tmp_path):
    db = tmp_path / "source.db"
    _make_db(db)
    con = sqlite3.connect(db)
    con.execute("UPDATE pairs SET timezone = NULL")
    con.execute("UPDATE users SET timezone = NULL")
    con.commit()
    con.close()
    sql = dump(db)
    assert "'Australia/Sydney'" not in sql and "'Pacific/Auckland'" not in sql
    assert "'Europe/Moscow'" in sql


def _make_current_db(path: Path) -> None:
    """Боевая схема бота: приватность, done_at/url у желаний, daily_completions."""
    con = sqlite3.connect(path)
    for sql in SCHEMA:
        con.execute(sql)
    con.commit()
    con.close()


def test_export_keeps_private_flags_and_new_columns(tmp_path):
    """Приватность и новые поля обязаны пережить перенос в D1.

    Раньше списки колонок отставали от схемы, и личные планы/даты после
    импорта становились общими (DEFAULT 0), а звёзды календаря и настройки
    пользователей просто терялись.
    """
    db = tmp_path / "source.db"
    _make_current_db(db)
    con = sqlite3.connect(db)
    con.execute(
        "INSERT INTO pairs(id,code,name1,name2,user_a,user_b,started_at,created_at,updated_at) "
        "VALUES(1,'ABC','Владелец','',10,0,'2026-01-01',1,1)"
    )
    con.execute(
        "INSERT INTO users(tg_id,username,display_name,role,points,streak,best_streak,"
        "digest_time,digest_enabled,dates_digest_time,dates_digest_enabled,accent_color,"
        "created_at,updated_at) VALUES(10,'u','Владелец','a',0,0,0,'08:00',1,'09:00',1,'#ff00ff',1,1)"
    )
    con.execute(
        "INSERT INTO tasks(id,pair_id,title,status,day,time,is_private,created_by,created_at) "
        "VALUES(1,1,'Сюрприз','open','2026-12-01','18:00',1,10,1)"
    )
    con.execute(
        "INSERT INTO dates(id,pair_id,title,day,time,recurs,is_private,created_by,created_at) "
        "VALUES(1,1,'Годовщина','2026-12-01','18:00',0,1,10,1)"
    )
    con.execute(
        "INSERT INTO wishes(id,pair_id,owner_id,body,done,done_at,url,comment,created_at) "
        "VALUES(1,1,10,'Билеты',1,'2026-12-02','https://example.com/tickets',"
        "'В партере, не дальше 5 ряда',1)"
    )
    con.execute(
        "INSERT INTO daily_completions(pair_id,tg_id,day,completed_at) VALUES(1,10,'2026-12-02',5)"
    )
    con.commit()
    con.close()

    sql = dump(db)

    # Личный план остаётся личным.
    assert "INSERT OR REPLACE INTO tasks(id, pair_id, title, status, day, time, monthly, yearly, is_private, created_by, created_at, completed_by, completed_at) VALUES(1, 1, 'Сюрприз', 'open', '2026-12-01', '18:00', 0, 0, 1, 10, 1, NULL, NULL);" in sql
    # Личная дата остаётся личной; kind по умолчанию — обычная дата.
    assert "INSERT OR REPLACE INTO dates(id, pair_id, title, day, time, recurs, monthly, is_private, created_by, kind, created_at) VALUES(1, 1, 'Годовщина', '2026-12-01', '18:00', 0, 0, 1, 10, 'date', 1);" in sql
    # Звёздочка в календаре (done_at), ссылка и уточнение к желанию не теряются.
    assert "INSERT OR REPLACE INTO wishes(id, pair_id, owner_id, body, done, done_at, url, comment, created_at) VALUES(1, 1, 10, 'Билеты', 1, '2026-12-02', 'https://example.com/tickets', 'В партере, не дальше 5 ряда', 1);" in sql
    # Настройки пользователя (время сводок, акцент) переезжают вместе с ним.
    assert "'08:00'" in sql and "'09:00'" in sql and "'#ff00ff'" in sql
    # Ежедневные отметки — отдельная таблица, её тоже нужно переносить.
    assert "INSERT OR REPLACE INTO daily_completions(pair_id, tg_id, day, completed_at) VALUES(1, 10, '2026-12-02', 5);" in sql


def test_export_covers_every_column_of_current_schema():
    """Список колонок обязан совпадать с production-схемой D1.

    Источник истины — миграции + ensureSchema (worker.js), а не legacy-схема
    бота: колонка, добавленная в D1 и пропущенная в экспортёре, молча теряется
    при импорте (для is_private — тихая смена приватности). Сверка с Python
    SCHEMA не ловила этот класс регрессии (аудит 2026-11-01).
    """
    from test_schema_parity import _d1_migrations, _worker_schema

    merged: dict[str, set[str]] = {}
    for source in (_d1_migrations(), _worker_schema()):
        for table, columns in source.items():
            merged.setdefault(table, set()).update(name for name, _ in columns)

    problems: list[str] = []
    for table, columns in TABLES.items():
        listed = {part.strip() for part in columns.split(",") if part.strip()}
        actual = merged.get(table)
        if actual is None:
            problems.append(f"{table}: таблицы нет в схеме D1 (миграции + ensureSchema)")
        elif actual != listed:
            problems.append(
                f"{table}: в схеме есть {sorted(actual - listed)}, "
                f"в списке экспорта лишние {sorted(listed - actual)}"
            )
    assert not problems, "\n".join(problems)


# Таблицы локальной схемы, которые осознанно НЕ переносятся в D1. Любая новая
# таблица с пользовательскими данными обязана либо попасть в TABLES, либо
# получить здесь документированное исключение — иначе тест упадёт (P1-03).
EXPORT_EXCLUDED_TABLES = {
    # FSM-состояния локального Python-бота: в D1 их нет по замыслу
    # (LOCAL_ONLY_TABLES в test_schema_parity).
    "fsm_states",
    # Служебные ключ-значение локального бота (версия схемы и т.п.).
    "meta",
    # Member-ship в D1 пересоздаётся дампером из pairs.user_a/user_b —
    # отдельный экспорт дал бы дубли.
    "pair_members",
    # Счётчики защиты от перебора: к пользовательским данным не относятся.
    "rate_limits",
}


def test_export_covers_every_local_business_table():
    """Каждая таблица локальной схемы — в экспорте или в исключениях.

    Регресс P1-03: шесть таблиц Фло отсутствовали в TABLES, и перенос
    локальной базы в D1 молча терял настройки цикла, периоды, дневник,
    измерения, препараты и журнал приёма.
    """
    from test_schema_parity import _python_schema

    local = set(_python_schema())
    missing = local - set(TABLES) - EXPORT_EXCLUDED_TABLES
    assert not missing, f"таблицы без решения об экспорте: {sorted(missing)}"
    # И наоборот: запись в TABLES для несуществующей локально таблицы —
    # мёртвая строка, которая будет молча пропускаться с warning.
    unknown = set(TABLES) - local
    assert not unknown, f"в TABLES есть таблицы вне локальной схемы: {sorted(unknown)}"


def test_export_cycle_tracker_tables_end_to_end(tmp_path):
    """Все шесть таблиц Фло попадают в дамп и переживают импорт в SQLite.

    Проверяется реальный путь: INSERT'ы в локальной схеме → dump() →
    executescript в чистую базу с той же схемой → строки на месте.
    """
    source = tmp_path / "source.db"
    _make_current_db(source)
    con = sqlite3.connect(source)
    con.execute(
        "INSERT INTO cycle_profiles(tg_id, avg_cycle_length, avg_period_length, "
        "share_enabled, onboarded, notify_enabled, created_at, updated_at) "
        "VALUES(10,30,5,1,1,1,1,1)"
    )
    con.execute(
        "INSERT INTO cycle_periods(tg_id,start_date,end_date,end_unknown,created_at,updated_at) "
        "VALUES(10,'2026-11-01','2026-11-05',0,1,1)"
    )
    con.execute(
        "INSERT INTO cycle_logs(tg_id,date,flow,mood,note,created_at,updated_at) "
        "VALUES(10,'2026-11-10','medium','ok','тестовая запись',1,1)"
    )
    con.execute(
        "INSERT INTO cycle_measurements(tg_id,date,kind,value,unit,created_at,updated_at) "
        "VALUES(10,'2026-11-10','bbt',36.6,'C',1,1)"
    )
    con.execute(
        "INSERT INTO cycle_meds(tg_id,name,start_date,status,created_at,updated_at) "
        "VALUES(10,'Магний','2026-11-01','active',1,1)"
    )
    con.execute(
        "INSERT INTO cycle_med_logs(med_id,tg_id,date,status,dose_taken,created_at,updated_at) "
        "VALUES(1,10,'2026-11-10','taken','1 таблетка',1,1)"
    )
    con.commit()
    con.close()

    sql = dump(source)
    for table in (
        "cycle_profiles", "cycle_periods", "cycle_logs",
        "cycle_measurements", "cycle_meds", "cycle_med_logs",
    ):
        assert f"INSERT OR REPLACE INTO {table}(" in sql, f"{table} не экспортирована"
    assert "'Магний'" in sql and "'bbt'" in sql and "'taken'" in sql
    assert "'2026-11-10'" in sql and "36.6" in sql

    # Импорт в чистую базу с боевой локальной схемой.
    target = tmp_path / "target.db"
    _make_current_db(target)
    con = sqlite3.connect(target)
    con.executescript(sql)
    for table in (
        "cycle_profiles", "cycle_periods", "cycle_logs",
        "cycle_measurements", "cycle_meds", "cycle_med_logs",
    ):
        count = con.execute(f"SELECT COUNT(*) FROM {table}").fetchone()[0]
        assert count == 1, f"{table}: после импорта {count} строк, ожидалась 1"
    med_log = con.execute(
        "SELECT dose_taken FROM cycle_med_logs WHERE tg_id=10 AND date='2026-11-10'"
    ).fetchone()
    assert med_log == ("1 таблетка",)
    profile = con.execute("SELECT avg_cycle_length, share_enabled FROM cycle_profiles WHERE tg_id=10").fetchone()
    assert profile == (30, 1)
    con.close()


def test_export_refuses_duplicate_pair_codes(tmp_path):
    """Дубли code в источнике — признак повреждённой базы.

    INSERT OR REPLACE на импорте при конфликте уникального code удаляет
    строку pairs, и ON DELETE CASCADE сносит её планы, даты, дневник и
    желания. Экспорт обязан упасть с ясной ошибкой, а не молча терять данные.
    """
    db_path = tmp_path / "dupe.db"
    _make_db(db_path)
    con = sqlite3.connect(db_path)
    # Вторая пара с тем же кодом (в рабочей схеме code UNIQUE, здесь — нет:
    # проверяем поведение дампера, а не constraint источника).
    con.execute(
        "INSERT INTO pairs(id,code,name1,name2,user_a,user_b,started_at,together_pts,timezone,created_at,updated_at) "
        "VALUES(2,'ABC','Second','',20,0,'2026-01-02',0,'Europe/Moscow',2,2)"
    )
    con.commit()
    con.close()
    with pytest.raises(RuntimeError, match="дублируются коды"):
        dump(db_path)
