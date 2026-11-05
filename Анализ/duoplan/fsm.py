"""Persistent FSM-хранилище на SQLite.

Раньше использовался ``MemoryStorage``: после рестарта бот терял ввод, а старые
состояния не истекали. Здесь состояние и данные лежат в таблице ``fsm_states``
той же базы, что и остальные данные бота, с TTL и очисткой просроченных строк.
"""

from __future__ import annotations

import json
import logging
from typing import Any, Mapping

from aiogram.fsm.state import State
from aiogram.fsm.storage.base import BaseStorage, StorageKey

from duoplan.db.base import Database
from duoplan.db.schema import now

log = logging.getLogger(__name__)

_EMPTY = "{}"


class SQLiteStorage(BaseStorage):
    """FSM-состояния в SQLite с необязательным TTL (в секундах)."""

    def __init__(self, db: Database, ttl: int = 7 * 24 * 60 * 60) -> None:
        self.db = db
        self.ttl = max(0, int(ttl))

    # ------------------------------------------------------------------ ключи

    @staticmethod
    def _key(key: StorageKey) -> str:
        parts = (
            key.bot_id,
            key.chat_id,
            key.user_id,
            key.destiny,
            key.thread_id,
            key.business_connection_id,
        )
        return ":".join("" if part is None else str(part) for part in parts)

    def _fresh_after(self) -> int:
        return now() - self.ttl if self.ttl else 0

    # --------------------------------------------------------------- запись

    async def set_state(self, key: StorageKey, state: State | str | None = None) -> None:
        value = state.state if isinstance(state, State) else state
        await self.db.execute_row(
            "INSERT INTO fsm_states(key, state, data, updated_at) VALUES(?, ?, ?, ?) "
            "ON CONFLICT(key) DO UPDATE SET state = excluded.state, "
            "updated_at = excluded.updated_at",
            (self._key(key), value, _EMPTY, now()),
        )

    async def set_data(self, key: StorageKey, data: Mapping[str, Any]) -> None:
        try:
            payload = json.dumps(dict(data), ensure_ascii=False)
        except (TypeError, ValueError):
            log.warning("FSM-данные не сериализуются в JSON, сохраняю пустой объект")
            payload = _EMPTY
        await self.db.execute_row(
            "INSERT INTO fsm_states(key, state, data, updated_at) VALUES(?, NULL, ?, ?) "
            "ON CONFLICT(key) DO UPDATE SET data = excluded.data, "
            "updated_at = excluded.updated_at",
            (self._key(key), payload, now()),
        )

    # ---------------------------------------------------------------- чтение

    async def get_state(self, key: StorageKey) -> str | None:
        row = await self.db.one(
            "SELECT state FROM fsm_states WHERE key = ? AND updated_at >= ?",
            (self._key(key), self._fresh_after()),
        )
        return row["state"] if row is not None else None

    async def get_data(self, key: StorageKey) -> dict[str, Any]:
        row = await self.db.one(
            "SELECT data FROM fsm_states WHERE key = ? AND updated_at >= ?",
            (self._key(key), self._fresh_after()),
        )
        if row is None or not row["data"]:
            return {}
        try:
            data = json.loads(row["data"])
        except (TypeError, ValueError):
            log.warning("Повреждённые FSM-данные, сбрасываю состояние")
            return {}
        return data if isinstance(data, dict) else {}

    # -------------------------------------------------------------- служебное

    async def cleanup(self) -> int:
        """Удалить просроченные состояния. Возвращает число удалённых строк."""
        if not self.ttl:
            return 0
        _, changes = await self.db.execute_row(
            "DELETE FROM fsm_states WHERE updated_at < ?", (self._fresh_after(),)
        )
        return changes

    async def close(self) -> None:
        # Соединение принадлежит Database и закрывается в __main__.
        return None
