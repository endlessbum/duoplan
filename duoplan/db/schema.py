import time


def now() -> int:
    return int(time.time())


# Базовая схема (версия 1). Держим её идемпотентной: ``CREATE ... IF NOT EXISTS``
# позволяет открывать уже существующую ``data/duoplan.db`` без пересоздания таблиц.
# Единственный источник истины для общих с D1 таблиц — ``migrations/`` и
# ``ensureSchema`` в ``worker.js``: локальная схема обязана совпадать с ними по
# колонкам, расхождение ловит ``tests/test_schema_parity.py``.
SCHEMA: list[str] = [
    "CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)",
    "CREATE TABLE IF NOT EXISTS pairs (id INTEGER PRIMARY KEY AUTOINCREMENT, code TEXT NOT NULL UNIQUE, name1 TEXT NOT NULL, name2 TEXT NOT NULL, user_a INTEGER NOT NULL, user_b INTEGER NOT NULL, started_at TEXT NOT NULL, together_pts INTEGER NOT NULL DEFAULT 0, timezone TEXT NOT NULL DEFAULT 'Europe/Moscow', created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)",
    "CREATE TABLE IF NOT EXISTS users (tg_id INTEGER PRIMARY KEY, username TEXT, display_name TEXT NOT NULL DEFAULT '', role TEXT NOT NULL DEFAULT 'a', gender TEXT, pair_id INTEGER REFERENCES pairs(id) ON DELETE SET NULL, points INTEGER NOT NULL DEFAULT 0, streak INTEGER NOT NULL DEFAULT 0, last_activity TEXT, best_streak INTEGER NOT NULL DEFAULT 0, timezone TEXT NOT NULL DEFAULT 'Europe/Moscow', created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)",
    "CREATE TABLE IF NOT EXISTS tasks (id INTEGER PRIMARY KEY AUTOINCREMENT, pair_id INTEGER NOT NULL REFERENCES pairs(id) ON DELETE CASCADE, title TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'open', day TEXT, time TEXT, created_by INTEGER NOT NULL, created_at INTEGER NOT NULL, completed_by INTEGER, completed_at INTEGER)",
    "CREATE TABLE IF NOT EXISTS dates (id INTEGER PRIMARY KEY AUTOINCREMENT, pair_id INTEGER NOT NULL REFERENCES pairs(id) ON DELETE CASCADE, title TEXT NOT NULL, day TEXT NOT NULL, time TEXT, recurs INTEGER NOT NULL DEFAULT 1, created_at INTEGER NOT NULL)",
    "CREATE TABLE IF NOT EXISTS memories (id INTEGER PRIMARY KEY AUTOINCREMENT, pair_id INTEGER NOT NULL REFERENCES pairs(id) ON DELETE CASCADE, author_id INTEGER NOT NULL, body TEXT NOT NULL, day TEXT NOT NULL, created_at INTEGER NOT NULL)",
    "CREATE TABLE IF NOT EXISTS wishes (id INTEGER PRIMARY KEY AUTOINCREMENT, pair_id INTEGER NOT NULL REFERENCES pairs(id) ON DELETE CASCADE, owner_id INTEGER NOT NULL, body TEXT NOT NULL, done INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL)",
    "CREATE TABLE IF NOT EXISTS daily_rolls (pair_id INTEGER NOT NULL REFERENCES pairs(id) ON DELETE CASCADE, day TEXT NOT NULL, daily_value TEXT NOT NULL, done_by INTEGER, done_at INTEGER, PRIMARY KEY (pair_id, day))",
"CREATE TABLE IF NOT EXISTS daily_completions (pair_id INTEGER NOT NULL REFERENCES pairs(id) ON DELETE CASCADE, tg_id INTEGER NOT NULL, day TEXT NOT NULL, completed_at INTEGER NOT NULL, PRIMARY KEY (pair_id, tg_id, day))",
    "CREATE TABLE IF NOT EXISTS fsm_states (key TEXT PRIMARY KEY, state TEXT, data TEXT NOT NULL DEFAULT '{}', updated_at INTEGER NOT NULL)",
    "CREATE INDEX IF NOT EXISTS idx_tasks_pair ON tasks(pair_id, status)",
    "CREATE INDEX IF NOT EXISTS idx_dates_pair ON dates(pair_id, recurs)",
    "CREATE INDEX IF NOT EXISTS idx_memories_pair ON memories(pair_id, day)",
    "CREATE INDEX IF NOT EXISTS idx_memories_created ON memories(pair_id, created_at)",
    "CREATE INDEX IF NOT EXISTS idx_wishes_pair ON wishes(pair_id, done)",
    "CREATE INDEX IF NOT EXISTS idx_wishes_created ON wishes(pair_id, created_at)",
    "CREATE INDEX IF NOT EXISTS idx_users_pair ON users(pair_id)",
    "CREATE INDEX IF NOT EXISTS idx_pairs_user_a ON pairs(user_a)",
    "CREATE INDEX IF NOT EXISTS idx_pairs_user_b ON pairs(user_b)",
]
