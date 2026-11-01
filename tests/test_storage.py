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


async def test_storage_transition_keeps_form_data(db):
    """Контракт флоу даты: данные переживают переход set_state.

    receive_date_day пишет day, затем делает set_state(Form.date_recurs),
    и receive_date_recurs читает title+day из данных. «Воскрешение»
    просроченной строки при этом не проблема: каждый шаг флоу перезаписывает
    своё поле до чтения (аудит 2026-11-01 — поведение зафиксировано как есть).
    """
    storage = SQLiteStorage(db, ttl=600)
    key = make_key()

    await storage.set_state(key, "Form:date_title")
    # update_data в хендлерах мержит (aiogram-прокси), set_data заменяет целиком.
    await storage.set_data(key, {"title": "Годовщина"})
    await storage.set_state(key, "Form:date_day")  # переход после update_data(title)
    stored = await storage.get_data(key)
    await storage.set_data(key, {**stored, "day": "2027-03-08"})
    await storage.set_state(key, "Form:date_recurs")

    assert await storage.get_data(key) == {"title": "Годовщина", "day": "2027-03-08"}
    assert await storage.get_state(key) == "Form:date_recurs"
