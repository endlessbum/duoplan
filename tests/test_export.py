import sqlite3
import tempfile
from pathlib import Path

from scripts.export_sqlite_to_d1 import dump


def _make_db(path: Path) -> None:
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
        "INSERT INTO pairs(id,code,name1,name2,user_a,user_b,started_at,together_pts,created_at,updated_at) "
        "VALUES(1,'ABC','Owner','',10,0,'2026-01-01',0,1,1)"
    )
    con.execute(
        "INSERT INTO users(tg_id,display_name,role,points,streak,best_streak,created_at,updated_at) "
        "VALUES(10,'Owner','a',0,0,0,1,1)"
    )
    con.commit()
    con.close()


def test_export_includes_owner_for_empty_pair(tmp_path):
    db = tmp_path / "source.db"
    _make_db(db)
    sql = dump(db)
    assert "INSERT OR IGNORE INTO pair_members(tg_id,pair_id,role,joined_at) VALUES(10,1,'a',1);" in sql
