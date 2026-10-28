"""Подключение к SQLite: один коннект на процесс, WAL, схема и миграции.

Бот однопоточный по событиям, поэтому держим один ``aiosqlite`` коннект и
защищаем все записи ``asyncio.Lock`` (коннект не потокобезопасен для ``execute``).

Для операций, которые должны быть атомарными (вход в пару, ритуал дня),
используется :meth:`Database.transaction` — он выполняет ``BEGIN IMMEDIATE`` и
коммитит только при успешном выходе. Вложенные вызовы ``execute``/``query``
внутри транзакции не пытаются повторно взять блокировку.

Версия схемы хранится в ``PRAGMA user_version``. Старые базы, где версия
лежала только в ``meta.schema_version``, читаются без потери данных и
переводятся на новую дисциплину миграций.
"""

from __future__ import annotations

import asyncio
from contextlib import asynccontextmanager
from pathlib import Path
from typing import AsyncIterator, Sequence

import aiosqlite

from duoplan.db.schema import SCHEMA

SCHEMA_VERSION = 3

# Миграции вида {версия: [sql]}. Версия 1 — базовая схема из ``SCHEMA``,
# поэтому здесь описаны только шаги начиная с 2. Все statements идемпотентны,
# чтобы повторный запуск после сбоя не ломал базу.
MIGRATIONS: dict[int, Sequence[str]] = {
    2: (
        "CREATE TABLE IF NOT EXISTS fsm_states (key TEXT PRIMARY KEY, state TEXT, "
        "data TEXT NOT NULL DEFAULT '{}', updated_at INTEGER NOT NULL)",
        "CREATE INDEX IF NOT EXISTS idx_users_pair ON users(pair_id)",
        "CREATE INDEX IF NOT EXISTS idx_pairs_user_a ON pairs(user_a)",
        "CREATE INDEX IF NOT EXISTS idx_pairs_user_b ON pairs(user_b)",
        "CREATE INDEX IF NOT EXISTS idx_memories_created ON memories(pair_id, created_at)",
        "CREATE INDEX IF NOT EXISTS idx_wishes_created ON wishes(pair_id, created_at)",
    ),
    3: (
        "ALTER TABLE users ADD COLUMN gender TEXT",
    ),
}


class Transaction:
    """Хэндл активной транзакции: позволяет откатить её без исключения."""

    __slots__ = ("_rolled_back",)

    def __init__(self) -> None:
        self._rolled_back = False

    def rollback(self) -> None:
        """Пометить транзакцию как откатываемую при выходе из контекста."""
        self._rolled_back = True

    @property
    def rolled_back(self) -> bool:
        return self._rolled_back


class Database:
    def __init__(self, path: Path | str) -> None:
        self.path = Path(path)
        self.conn: aiosqlite.Connection | None = None
        self._lock = asyncio.Lock()
        self._tx_owner: asyncio.Task[object] | None = None

    async def connect(self) -> None:
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self.conn = await aiosqlite.connect(self.path)
        self.conn.row_factory = aiosqlite.Row
        await self.conn.execute("PRAGMA journal_mode=WAL")
        await self.conn.execute("PRAGMA foreign_keys=ON")
        await self.conn.execute("PRAGMA busy_timeout=5000")
        await self.conn.commit()
        await self._init_schema()

    # ------------------------------------------------------------------ схема

    async def _init_schema(self) -> None:
        conn = self._require_conn()
        for sql in SCHEMA:
            await conn.execute(sql)
        await conn.commit()

        current = await self._read_version()
        if current > SCHEMA_VERSION:
            raise RuntimeError(f"База создана более новой версией бота: {current} > {SCHEMA_VERSION}")

        if current == SCHEMA_VERSION:
            await self._store_meta_version(current)
            return

        for version in range(current + 1, SCHEMA_VERSION + 1):
            statements = MIGRATIONS.get(version, ())
            await conn.execute("BEGIN IMMEDIATE")
            try:
                for sql in statements:
                    try:
                        await conn.execute(sql)
                    except aiosqlite.OperationalError as exc:
                        # Повторное применение миграции на уже актуальной схеме:
                        # игнорируем только «duplicate column name», остальные ошибки пробрасываем.
                        if "duplicate column name" not in str(exc).lower():
                            raise
                # Версия фиксируется в той же транзакции, что и миграция:
                # при сбое откатываются и изменения схемы, и номер версии.
                await conn.execute(f"PRAGMA user_version = {version}")
                await conn.execute(
                    "INSERT INTO meta(key, value) VALUES('schema_version', ?) "
                    "ON CONFLICT(key) DO UPDATE SET value = excluded.value",
                    (str(version),),
                )
                await conn.commit()
            except BaseException:
                await conn.rollback()
                raise

    async def _read_version(self) -> int:
        conn = self._require_conn()
        cur = await conn.execute("PRAGMA user_version")
        row = await cur.fetchone()
        await cur.close()
        version = int(row[0]) if row else 0
        if version:
            return version

        # Старые базы писали версию только в meta.schema_version.
        cur = await conn.execute("SELECT value FROM meta WHERE key = 'schema_version'")
        row = await cur.fetchone()
        await cur.close()
        if row is None:
            return 0
        try:
            return int(row["value"])
        except (TypeError, ValueError):
            return 0

    async def _store_meta_version(self, version: int) -> None:
        """Держим meta.schema_version в актуальном состоянии для старых читателей."""
        conn = self._require_conn()
        cur = await conn.execute("SELECT value FROM meta WHERE key = 'schema_version'")
        row = await cur.fetchone()
        await cur.close()
        if row is not None and str(row["value"]) == str(version):
            return
        await conn.execute(
            "INSERT INTO meta(key, value) VALUES('schema_version', ?) "
            "ON CONFLICT(key) DO UPDATE SET value = excluded.value",
            (str(version),),
        )
        await conn.commit()

    # ------------------------------------------------------------ транзакции

    def _require_conn(self) -> aiosqlite.Connection:
        assert self.conn is not None, "Database.connect() не вызван"
        return self.conn

    def _owns_transaction(self) -> bool:
        return self._tx_owner is not None and self._tx_owner is asyncio.current_task()

    @asynccontextmanager
    async def transaction(self) -> AsyncIterator[Transaction]:
        """Атомарный блок: ``BEGIN IMMEDIATE`` ... ``COMMIT`` / ``ROLLBACK``.

        Вложенный вызов возвращает управление внешней транзакции и не открывает
        новую — так сервисные методы можно безопасно комбинировать.
        """
        conn = self._require_conn()
        if self._owns_transaction():
            yield Transaction()
            return

        async with self._lock:
            await conn.execute("BEGIN IMMEDIATE")
            self._tx_owner = asyncio.current_task()
            tx = Transaction()
            try:
                yield tx
            except BaseException:
                await conn.rollback()
                raise
            else:
                if tx.rolled_back:
                    await conn.rollback()
                else:
                    await conn.commit()
            finally:
                self._tx_owner = None

    # ------------------------------------------------------------------ чтение

    async def query(self, sql: str, params: Sequence[object] = ()) -> list[aiosqlite.Row]:
        conn = self._require_conn()
        if self._owns_transaction():
            cur = await conn.execute(sql, params)
            rows = await cur.fetchall()
            await cur.close()
            return list(rows)
        async with self._lock:
            cur = await conn.execute(sql, params)
            rows = await cur.fetchall()
            await cur.close()
        return list(rows)

    async def one(self, sql: str, params: Sequence[object] = ()) -> aiosqlite.Row | None:
        rows = await self.query(sql, params)
        return rows[0] if rows else None

    # ------------------------------------------------------------------ запись

    async def execute_row(self, sql: str, params: Sequence[object] = ()) -> tuple[int, int]:
        """Выполнить запись и вернуть ``(lastrowid, rowcount)``.

        ``rowcount`` — число фактически изменённых строк; по нему сервисы
        проверяют, что условный ``UPDATE`` действительно сработал.
        """
        conn = self._require_conn()
        if self._owns_transaction():
            cur = await conn.execute(sql, params)
            row_id = cur.lastrowid or 0
            changes = cur.rowcount if cur.rowcount is not None else 0
            await cur.close()
            return int(row_id), int(changes)

        async with self._lock:
            cur = await conn.execute(sql, params)
            row_id = cur.lastrowid or 0
            changes = cur.rowcount if cur.rowcount is not None else 0
            await cur.close()
            await conn.commit()
        return int(row_id), int(changes)

    async def execute(self, sql: str, params: Sequence[object] = ()) -> int:
        """Совместимый со старым кодом вызов: вернуть id последней строки."""
        row_id, _ = await self.execute_row(sql, params)
        return row_id

    async def close(self) -> None:
        if self.conn is not None:
            if self._tx_owner is not None:
                await self.conn.rollback()
                self._tx_owner = None
            await self.conn.close()
            self.conn = None


async def connect_database(path: Path | str) -> Database:
    db = Database(path)
    await db.connect()
    return db
