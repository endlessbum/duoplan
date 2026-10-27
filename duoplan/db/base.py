"""Подключение к SQLite: один коннект на процесс, WAL, схема и простые миграции.

Бот однопоточный по событиям, поэтому держим один ``aiosqlite`` коннект и
защищаем все записи ``asyncio.Lock`` (коннект не потокобезопасен для ``execute``).
"""

from __future__ import annotations

import asyncio
from pathlib import Path
from typing import Sequence

import aiosqlite

from duoplan.db.schema import SCHEMA

SCHEMA_VERSION = 1

# миграции вида (версия, [sql]) — дописываются по мере развития
MIGRATIONS: dict[int, Sequence[str]] = {}


class Database:
    def __init__(self, path: Path | str) -> None:
        self.path = Path(path)
        self.conn: aiosqlite.Connection | None = None
        self._lock = asyncio.Lock()

    async def connect(self) -> None:
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self.conn = await aiosqlite.connect(self.path)
        self.conn.row_factory = aiosqlite.Row
        await self.conn.execute("PRAGMA journal_mode=WAL")
        await self.conn.execute("PRAGMA foreign_keys=ON")
        await self.conn.execute("PRAGMA busy_timeout=5000")
        await self.conn.commit()
        await self._init_schema()

    async def _init_schema(self) -> None:
        assert self.conn is not None
        for sql in SCHEMA:
            await self.conn.execute(sql)
        await self.conn.commit()

        cur = await self.conn.execute("SELECT value FROM meta WHERE key = 'schema_version'")
        row = await cur.fetchone()
        await cur.close()
        current = int(row["value"]) if row else SCHEMA_VERSION - 1
        if current > SCHEMA_VERSION:
            raise RuntimeError(f"База создана более новой версией бота: {current} > {SCHEMA_VERSION}")
        while current < SCHEMA_VERSION:
            current += 1
            for sql in MIGRATIONS.get(current, ()):
                await self.conn.execute(sql)
        await self.conn.execute(
            "INSERT INTO meta(key, value) VALUES('schema_version', ?) "
            "ON CONFLICT(key) DO UPDATE SET value = excluded.value",
            (str(current),),
        )
        await self.conn.commit()

    # Коммит после каждой транзакции приложения
    async def query(self, sql: str, params: Sequence[object] = ()) -> list[aiosqlite.Row]:
        assert self.conn is not None, "Database.connect() не вызван"
        async with self._lock:
            cur = await self.conn.execute(sql, params)
            rows = await cur.fetchall()
            await cur.close()
        return list(rows)

    async def one(self, sql: str, params: Sequence[object] = ()) -> aiosqlite.Row | None:
        rows = await self.query(sql, params)
        return rows[0] if rows else None

    async def execute(self, sql: str, params: Sequence[object] = ()) -> int:
        """Выполнить запись и вернуть id последней добавленной строки."""
        assert self.conn is not None, "Database.connect() не вызван"
        async with self._lock:
            cur = await self.conn.execute(sql, params)
            row_id = cur.lastrowid or 0
            await cur.close()
            await self.conn.commit()
        return row_id

    async def close(self) -> None:
        if self.conn is not None:
            await self.conn.close()
            self.conn = None


async def connect_database(path: Path | str) -> Database:
    db = Database(path)
    await db.connect()
    return db

