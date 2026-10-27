from __future__ import annotations

import sqlite3

from duoplan.db.base import SCHEMA_VERSION
from duoplan.db.base import connect_database
from duoplan.services import DuoPlanService


async def test_fresh_database_has_current_version(tmp_path):
    db = await connect_database(tmp_path / "fresh.db")
    try:
        row = await db.one("PRAGMA user_version")
        assert int(row[0]) == SCHEMA_VERSION
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
        assert int(row[0]) == SCHEMA_VERSION
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
