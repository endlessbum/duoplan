from __future__ import annotations

import sqlite3

from duoplan.db.base import SCHEMA_VERSION, connect_database
from duoplan.services import DuoPlanService


async def test_fresh_database_has_current_version(tmp_path):
    db = await connect_database(tmp_path / "fresh.db")
    try:
        row = await db.one("PRAGMA user_version")
        assert int(row["user_version"]) == SCHEMA_VERSION
        table = await db.one(
            "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'fsm_states'"
        )
        assert table is not None
        index = await db.one(
            "SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'idx_users_pair'"
        )
        assert index is not None
    finally:
        await db.close()


async def test_legacy_meta_version_is_migrated_without_data_loss(tmp_path):
    path = tmp_path / "legacy.db"
    db = await connect_database(path)
    service = DuoPlanService(db)
    await service.ensure_user(1, "owner", "Владелец")
    code = await service.create_pair(1, "Владелец")
    await db.close()

    # Эмулируем базу, созданную старой версией бота: версия только в meta,
    # новых таблицы и индексов ещё нет.
    conn = sqlite3.connect(path)
    conn.execute("PRAGMA user_version = 0")
    conn.execute("UPDATE meta SET value = '1' WHERE key = 'schema_version'")
    conn.execute("DROP TABLE IF EXISTS fsm_states")
    conn.execute("DROP INDEX IF EXISTS idx_users_pair")
    conn.execute("DROP INDEX IF EXISTS idx_pairs_user_a")
    conn.execute("DROP INDEX IF EXISTS idx_pairs_user_b")
    conn.commit()
    conn.close()

    db = await connect_database(path)
    try:
        row = await db.one("PRAGMA user_version")
        assert int(row["user_version"]) == SCHEMA_VERSION
        pair = await db.one("SELECT code FROM pairs")
        assert pair["code"] == code
        user = await db.one("SELECT pair_id FROM users WHERE tg_id = 1")
        assert user["pair_id"] is not None
        for name in ("idx_users_pair", "idx_pairs_user_a", "idx_pairs_user_b", "fsm_states"):
            found = await db.one(
                "SELECT name FROM sqlite_master WHERE name = ?", (name,)
            )
            assert found is not None
    finally:
        await db.close()


def test_schema_version_covers_all_migrations():
    """Защита от PY-DB-01: версия схемы обязана покрывать последний шаг
    MIGRATIONS — иначе существующая база никогда не добежит до миграции."""
    from duoplan.db.base import MIGRATIONS

    assert SCHEMA_VERSION == max(MIGRATIONS), (
        f"SCHEMA_VERSION={SCHEMA_VERSION}, но в MIGRATIONS есть шаг {max(MIGRATIONS)}"
    )


async def test_legacy_v12_database_gets_show_cycle_calendar(tmp_path):
    """PY-DB-01: база user_version=12 без колонки show_cycle_calendar
    обязана домигрировать до v13 при первом старте, данные — сохраниться."""
    import sqlite3

    path = tmp_path / "legacy-v12.db"
    # Собираем «старую» базу: свежая схема минус колонка миграции 13,
    # версия зафиксирована на 12 — ровно состояние базы прошлого релиза.
    conn = sqlite3.connect(path)
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)")
    conn.execute("INSERT INTO meta(key, value) VALUES('schema_version', '12')")
    conn.execute(
        "CREATE TABLE users (tg_id INTEGER PRIMARY KEY, username TEXT, "
        "display_name TEXT NOT NULL DEFAULT '', role TEXT NOT NULL DEFAULT 'a', "
        "gender TEXT, pair_id INTEGER, points INTEGER NOT NULL DEFAULT 0, "
        "streak INTEGER NOT NULL DEFAULT 0, last_activity TEXT, "
        "best_streak INTEGER NOT NULL DEFAULT 0, "
        "timezone TEXT NOT NULL DEFAULT 'Europe/Moscow', digest_time TEXT, "
        "digest_enabled INTEGER NOT NULL DEFAULT 1, dates_digest_time TEXT, "
        "dates_digest_enabled INTEGER NOT NULL DEFAULT 1, "
        "weekly_digest_enabled INTEGER NOT NULL DEFAULT 0, weekly_digest_time TEXT, "
        "weekly_digest_day TEXT NOT NULL DEFAULT 'sun', accent_color TEXT, "
        "photo_url TEXT, show_avatar INTEGER NOT NULL DEFAULT 1, "
        "partner_custom_name TEXT, custom_name TEXT, "
        "created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)"
    )
    conn.execute(
        "INSERT INTO users(tg_id, display_name, created_at, updated_at) "
        "VALUES(42, 'Владелец', 1, 1)"
    )
    conn.execute("PRAGMA user_version = 12")
    conn.commit()
    conn.close()

    db = await connect_database(path)
    try:
        row = await db.one("PRAGMA user_version")
        assert int(row["user_version"]) == SCHEMA_VERSION
        cols = await db.query("PRAGMA table_info(users)")
        names = {c["name"] for c in cols}
        assert "show_cycle_calendar" in names, "миграция 13 не применилась"
        # Миграция 14 (группы фильмов) и 15 (resume_position) тоже доехали
        # по цепочке v12 → v15.
        groups = await db.query(
            "SELECT name FROM sqlite_master WHERE type='table' "
            "AND name IN ('movie_groups','movie_group_items') ORDER BY name"
        )
        assert [r["name"] for r in groups] == ["movie_group_items", "movie_groups"]
        movie_cols = await db.query("PRAGMA table_info(movies)")
        assert "resume_position" in {c["name"] for c in movie_cols}, "миграция 15 не применилась"
        user = await db.one("SELECT display_name FROM users WHERE tg_id = 42")
        assert user["display_name"] == "Владелец", "данные пользователя потеряны"
        # Повторное открытие — идемпотентно, duplicate column не роняет старт.
        await db.close()
        db = await connect_database(path)
        row = await db.one("PRAGMA user_version")
        assert int(row["user_version"]) == SCHEMA_VERSION
    finally:
        await db.close()
