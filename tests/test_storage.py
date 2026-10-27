from __future__ import annotations

from aiogram.fsm.storage.base import StorageKey

from duoplan.fsm import SQLiteStorage


def make_key() -> StorageKey:
    return StorageKey(
        bot_id=1,
        chat_id=2,
        user_id=3,
        thread_id=None,
        business_connection_id=None,
        destiny="default",
    )


async def test_storage_roundtrip(db):
    storage = SQLiteStorage(db, ttl=600)
    key = make_key()

    assert await storage.get_state(key) is None
    assert await storage.get_data(key) == {}

    await storage.set_state(key, "Form:task")
    assert await storage.get_state(key) == "Form:task"

    await storage.set_data(key, {"title": "План"})
    assert await storage.get_data(key) == {"title": "План"}

    # Сброс состояния не должен стирать данные формы.
    await storage.set_state(key, None)
    assert await storage.get_state(key) is None
    assert await storage.get_data(key) == {"title": "План"}


async def test_storage_ttl_expires_state(db):
    storage = SQLiteStorage(db, ttl=60)
    key = make_key()
    await storage.set_state(key, "Form:wish")
    await storage.set_data(key, {"body": "Море"})

    await db.execute_row("UPDATE fsm_states SET updated_at = 0")

    assert await storage.get_state(key) is None
    assert await storage.get_data(key) == {}

    assert await storage.cleanup() == 1
