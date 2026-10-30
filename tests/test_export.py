import sqlite3
import tempfile
from pathlib import Path

from duoplan.db.schema import SCHEMA
from scripts.export_sqlite_to_d1 import TABLES
from scripts.export_sqlite_to_d1 import dump


def _make_db(path: Path) -> None:
    """Схема с дополнительными колонками (timezone, tasks.day/time, dates.time)."""
    con = sqlite3.connect(path)
    con.executescript(
        """
        CREATE TABLE pairs (id INTEGER PRIMARY KEY, code TEXT, name1 TEXT, name2 TEXT, user_a INTEGER, user_b INTEGER, started_at TEXT, together_pts INTEGER, timezone TEXT, created_at INTEGER, updated_at INTEGER);
        CREATE TABLE users (tg_id INTEGER PRIMARY KEY, username TEXT, display_name TEXT, role TEXT, pair_id INTEGER, points INTEGER, streak INTEGER, last_activity TEXT, best_streak INTEGER, timezone TEXT, gender TEXT, created_at INTEGER, updated_at INTEGER);
        CREATE TABLE tasks (id INTEGER PRIMARY KEY, pair_id INTEGER, title TEXT, status TEXT, day TEXT, time TEXT, created_by INTEGER, created_at INTEGER, completed_by INTEGER, completed_at INTEGER);
        CREATE TABLE dates (id INTEGER PRIMARY KEY, pair_id INTEGER, title TEXT, day TEXT, time TEXT, recurs INTEGER, created_at INTEGER);
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
        "INSERT OR REPLACE INTO tasks(id, pair_id, title, status, day, time, is_private, "
        "created_by, created_at, completed_by, completed_at)"
    ) in sql


def test_export_substitutes_defaults_for_plain_schema(tmp_path):
    db = tmp_path / "source.db"
    _make_plain_db(db)
    sql = dump(db)
    # timezone в D1 — NOT NULL DEFAULT 'Europe/Moscow': вместо NULL подставляется дефолт.
    assert "INSERT OR REPLACE INTO pairs(id, code, name1, name2, user_a, user_b, started_at, together_pts, timezone, created_at, updated_at) VALUES(1, 'ABC', 'Owner', '', 10, 0, '2026-01-01', 0, 'Europe/Moscow', 1, 1);" in sql
    assert (
        "INSERT OR REPLACE INTO users(tg_id, username, display_name, role, gender, pair_id, "
        "points, streak, last_activity, best_streak, timezone, digest_time, digest_enabled, "
        "dates_digest_time, dates_digest_enabled, accent_color, created_at, updated_at) "
        "VALUES(10, NULL, 'Owner', 'a', NULL, NULL, 0, 0, NULL, 0, 'Europe/Moscow', NULL, 1, "
        "NULL, 1, NULL, 1, 1);"
    ) in sql
    # Nullable колонки без источника остаются NULL, а NOT NULL с DEFAULT —
    # получают дефолт (is_private не должен молча раскрыть личную запись).
    assert (
        "INSERT OR REPLACE INTO tasks(id, pair_id, title, status, day, time, is_private, "
        "created_by, created_at, completed_by, completed_at) "
        "VALUES(1, 1, 'Поездка', 'open', NULL, NULL, 0, 10, 1, NULL, NULL);"
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
        "INSERT INTO wishes(id,pair_id,owner_id,body,done,done_at,url,created_at) "
        "VALUES(1,1,10,'Билеты',1,'2026-12-02','https://example.com/tickets',1)"
    )
    con.execute(
        "INSERT INTO daily_completions(pair_id,tg_id,day,completed_at) VALUES(1,10,'2026-12-02',5)"
    )
    con.commit()
    con.close()

    sql = dump(db)

    # Личный план остаётся личным.
    assert "INSERT OR REPLACE INTO tasks(id, pair_id, title, status, day, time, is_private, created_by, created_at, completed_by, completed_at) VALUES(1, 1, 'Сюрприз', 'open', '2026-12-01', '18:00', 1, 10, 1, NULL, NULL);" in sql
    # Личная дата остаётся личной.
    assert "INSERT OR REPLACE INTO dates(id, pair_id, title, day, time, recurs, is_private, created_by, created_at) VALUES(1, 1, 'Годовщина', '2026-12-01', '18:00', 0, 1, 10, 1);" in sql
    # Звёздочка в календаре (done_at) и ссылка на желание не теряются.
    assert "INSERT OR REPLACE INTO wishes(id, pair_id, owner_id, body, done, done_at, url, created_at) VALUES(1, 1, 10, 'Билеты', 1, '2026-12-02', 'https://example.com/tickets', 1);" in sql
    # Настройки пользователя (время сводок, акцент) переезжают вместе с ним.
    assert "'08:00'" in sql and "'09:00'" in sql and "'#ff00ff'" in sql
    # Ежедневные отметки — отдельная таблица, её тоже нужно переносить.
    assert "INSERT OR REPLACE INTO daily_completions(pair_id, tg_id, day, completed_at) VALUES(1, 10, '2026-12-02', 5);" in sql


def test_export_covers_every_column_of_current_schema():
    """Список колонок обязан совпадать со схемой бота.

    Любая колонка вне списка молча теряется при импорте: для is_private это
    ещё и тихая смена приватности, для остальных — потеря данных.
    """
    con = sqlite3.connect(":memory:")
    for sql in SCHEMA:
        con.execute(sql)
    for table, columns in TABLES.items():
        listed = {part.strip() for part in columns.split(",") if part.strip()}
        actual = {str(row[1]) for row in con.execute(f"PRAGMA table_info({table})")}
        assert actual == listed, (
            f"{table}: в схеме есть {sorted(actual - listed)}, "
            f"в списке экспорта лишние {sorted(listed - actual)}"
        )
    con.close()
