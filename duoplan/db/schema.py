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
    (
        "CREATE TABLE IF NOT EXISTS pairs (id INTEGER PRIMARY KEY AUTOINCREMENT, "
        "code TEXT NOT NULL UNIQUE, name1 TEXT NOT NULL, name2 TEXT NOT NULL DEFAULT '', "
        "user_a INTEGER NOT NULL, user_b INTEGER NOT NULL DEFAULT 0, started_at TEXT NOT NULL, "
        "together_pts INTEGER NOT NULL DEFAULT 0, timezone TEXT NOT NULL DEFAULT 'Europe/Moscow', "
        "awaiting_return INTEGER NOT NULL DEFAULT 0, last_partner INTEGER NOT NULL DEFAULT 0, "
        "created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)"
    ),
    # Коды закрытых пространств (последний участник вышел): parity с D1.
    # Бот не умеет выходить из пары, таблица заполняется только Worker'ом.
    "CREATE TABLE IF NOT EXISTS closed_codes (code TEXT PRIMARY KEY, closed_at INTEGER NOT NULL)",
    # Счётчики rate limit: parity с D1 (migrations/0002 + ensureSchema). Бот
    # пишет сюда неудачные попытки входа по коду (перебор, как в worker.js).
    (
        "CREATE TABLE IF NOT EXISTS rate_limits (bucket_key TEXT PRIMARY KEY, "
        "count INTEGER NOT NULL, expires_at INTEGER NOT NULL DEFAULT 0)"
    ),
    (
        "CREATE TABLE IF NOT EXISTS users (tg_id INTEGER PRIMARY KEY, username TEXT, "
        "display_name TEXT NOT NULL DEFAULT '', role TEXT NOT NULL DEFAULT 'a', gender TEXT, "
        "pair_id INTEGER REFERENCES pairs(id) ON DELETE SET NULL, "
        "points INTEGER NOT NULL DEFAULT 0, streak INTEGER NOT NULL DEFAULT 0, last_activity TEXT, "
        "best_streak INTEGER NOT NULL DEFAULT 0, timezone TEXT NOT NULL DEFAULT 'Europe/Moscow', "
        "digest_time TEXT, digest_enabled INTEGER NOT NULL DEFAULT 1, dates_digest_time TEXT, "
        "dates_digest_enabled INTEGER NOT NULL DEFAULT 1, "
        "weekly_digest_enabled INTEGER NOT NULL DEFAULT 0, weekly_digest_time TEXT, "
        "weekly_digest_day TEXT NOT NULL DEFAULT 'sun', accent_color TEXT, photo_url TEXT, "
        "show_avatar INTEGER NOT NULL DEFAULT 1, partner_custom_name TEXT, custom_name TEXT, "
        "created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)"
    ),
    (
        "CREATE TABLE IF NOT EXISTS pair_members (tg_id INTEGER PRIMARY KEY, "
        "pair_id INTEGER NOT NULL REFERENCES pairs(id) ON DELETE CASCADE, "
        "role TEXT NOT NULL DEFAULT 'a', joined_at INTEGER NOT NULL)"
    ),
    # Снимок личной статистики участника на момент выхода из пары: parity с D1
    # (migrations/0030). Восстанавливается при возвращении по резерваному коду.
    (
        "CREATE TABLE IF NOT EXISTS member_stats (pair_id INTEGER NOT NULL REFERENCES pairs(id) "
        "ON DELETE CASCADE, tg_id INTEGER NOT NULL, points INTEGER NOT NULL DEFAULT 0, "
        "streak INTEGER NOT NULL DEFAULT 0, best_streak INTEGER NOT NULL DEFAULT 0, "
        "last_activity TEXT, updated_at INTEGER NOT NULL, PRIMARY KEY (pair_id, tg_id))"
    ),
    (
        "CREATE TABLE IF NOT EXISTS tasks (id INTEGER PRIMARY KEY AUTOINCREMENT, "
        "pair_id INTEGER NOT NULL REFERENCES pairs(id) ON DELETE CASCADE, title TEXT NOT NULL, "
        "status TEXT NOT NULL DEFAULT 'open', day TEXT, time TEXT, "
        "monthly INTEGER NOT NULL DEFAULT 0, yearly INTEGER NOT NULL DEFAULT 0, "
        "is_private INTEGER NOT NULL DEFAULT 0, created_by INTEGER NOT NULL, "
        "created_at INTEGER NOT NULL, completed_by INTEGER, completed_at INTEGER)"
    ),
    (
        "CREATE TABLE IF NOT EXISTS dates (id INTEGER PRIMARY KEY AUTOINCREMENT, "
        "pair_id INTEGER NOT NULL REFERENCES pairs(id) ON DELETE CASCADE, title TEXT NOT NULL, "
        "day TEXT NOT NULL, time TEXT, recurs INTEGER NOT NULL DEFAULT 1, "
        "monthly INTEGER NOT NULL DEFAULT 0, is_private INTEGER NOT NULL DEFAULT 0, "
        "created_by INTEGER NOT NULL DEFAULT 0, kind TEXT NOT NULL DEFAULT 'date', "
        "created_at INTEGER NOT NULL)"
    ),
    (
        "CREATE TABLE IF NOT EXISTS memories (id INTEGER PRIMARY KEY AUTOINCREMENT, "
        "pair_id INTEGER NOT NULL REFERENCES pairs(id) ON DELETE CASCADE, "
        "author_id INTEGER NOT NULL, title TEXT, body TEXT NOT NULL, day TEXT NOT NULL, "
        "created_at INTEGER NOT NULL)"
    ),
    (
        "CREATE TABLE IF NOT EXISTS wishes (id INTEGER PRIMARY KEY AUTOINCREMENT, "
        "pair_id INTEGER NOT NULL REFERENCES pairs(id) ON DELETE CASCADE, "
        "owner_id INTEGER NOT NULL, body TEXT NOT NULL, done INTEGER NOT NULL DEFAULT 0, "
        "done_at INTEGER, created_at INTEGER NOT NULL, url TEXT, "
        "comment TEXT)"
    ),
    (
        "CREATE TABLE IF NOT EXISTS quotes (id INTEGER PRIMARY KEY AUTOINCREMENT, "
        "pair_id INTEGER NOT NULL REFERENCES pairs(id) ON DELETE CASCADE, "
        "author_id INTEGER NOT NULL, body TEXT NOT NULL, source TEXT, "
        "created_at INTEGER NOT NULL)"
    ),
    (
        "CREATE TABLE IF NOT EXISTS places (id INTEGER PRIMARY KEY AUTOINCREMENT, "
        "pair_id INTEGER NOT NULL REFERENCES pairs(id) ON DELETE CASCADE, "
        "created_by INTEGER NOT NULL, title TEXT NOT NULL, note TEXT, url TEXT, "
        "visited INTEGER NOT NULL DEFAULT 0, visited_at INTEGER, visited_by INTEGER, "
        "created_at INTEGER NOT NULL)"
    ),
    (
        "CREATE TABLE IF NOT EXISTS trips (id INTEGER PRIMARY KEY AUTOINCREMENT, "
        "pair_id INTEGER NOT NULL REFERENCES pairs(id) ON DELETE CASCADE, "
        "created_by INTEGER NOT NULL, title TEXT NOT NULL, note TEXT, "
        "visited INTEGER NOT NULL DEFAULT 0, visited_at INTEGER, visited_by INTEGER, "
        "created_at INTEGER NOT NULL)"
    ),
    (
        "CREATE TABLE IF NOT EXISTS goals (id INTEGER PRIMARY KEY AUTOINCREMENT, "
        "pair_id INTEGER NOT NULL REFERENCES pairs(id) ON DELETE CASCADE, "
        "created_by INTEGER NOT NULL, title TEXT NOT NULL, is_private INTEGER NOT NULL DEFAULT 0, "
        "created_at INTEGER NOT NULL)"
    ),
    (
        "CREATE TABLE IF NOT EXISTS goal_items (id INTEGER PRIMARY KEY AUTOINCREMENT, "
        "goal_id INTEGER NOT NULL REFERENCES goals(id) ON DELETE CASCADE, "
        "pair_id INTEGER NOT NULL REFERENCES pairs(id) ON DELETE CASCADE, "
        "created_by INTEGER NOT NULL, title TEXT NOT NULL, done INTEGER NOT NULL DEFAULT 0, "
        "done_at INTEGER, done_by INTEGER, created_at INTEGER NOT NULL)"
    ),
    (
        "CREATE TABLE IF NOT EXISTS movies (id INTEGER PRIMARY KEY AUTOINCREMENT, "
        "pair_id INTEGER NOT NULL REFERENCES pairs(id) ON DELETE CASCADE, "
        "created_by INTEGER NOT NULL, imdb_id TEXT NOT NULL, title TEXT NOT NULL, year INTEGER, "
        "kind TEXT NOT NULL DEFAULT 'movie', rating REAL, rating_source TEXT, "
        "rating_checked_at INTEGER, details TEXT, genres TEXT, runtime INTEGER, seasons INTEGER, "
        "episodes INTEGER, url TEXT, watched INTEGER NOT NULL DEFAULT 0, watched_at INTEGER, "
        "watched_by INTEGER, created_at INTEGER NOT NULL)"
    ),
    (
        "CREATE TABLE IF NOT EXISTS movie_ratings (movie_id INTEGER NOT NULL REFERENCES "
        "movies(id) ON DELETE CASCADE, tg_id INTEGER NOT NULL, rating INTEGER NOT NULL, "
        "created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, PRIMARY KEY (movie_id, tg_id))"
    ),
    (
        "CREATE TABLE IF NOT EXISTS savings (id INTEGER PRIMARY KEY AUTOINCREMENT, "
        "pair_id INTEGER NOT NULL REFERENCES pairs(id) ON DELETE CASCADE, "
        "created_by INTEGER NOT NULL, kind TEXT NOT NULL DEFAULT 'personal', title TEXT NOT NULL, "
        "target INTEGER NOT NULL, collected INTEGER NOT NULL DEFAULT 0, "
        "created_at INTEGER NOT NULL)"
    ),
    (
        "CREATE TABLE IF NOT EXISTS savings_deposits (id INTEGER PRIMARY KEY AUTOINCREMENT, "
        "saving_id INTEGER NOT NULL REFERENCES savings(id) ON DELETE CASCADE, "
        "tg_id INTEGER NOT NULL, amount INTEGER NOT NULL, created_at INTEGER NOT NULL)"
    ),
    # done_by/done_at removed: relic of pre-daily_completions schema
    (
        "CREATE TABLE IF NOT EXISTS daily_rolls (pair_id INTEGER NOT NULL REFERENCES pairs(id) ON "
        "DELETE CASCADE, day TEXT NOT NULL, daily_value TEXT NOT NULL, PRIMARY KEY (pair_id, "
        "day))"
    ),
    (
        "CREATE TABLE IF NOT EXISTS daily_completions (pair_id INTEGER NOT NULL REFERENCES "
        "pairs(id) ON DELETE CASCADE, tg_id INTEGER NOT NULL, day TEXT NOT NULL, "
        "completed_at INTEGER NOT NULL, PRIMARY KEY (pair_id, tg_id, day))"
    ),
    (
        "CREATE TABLE IF NOT EXISTS fsm_states (key TEXT PRIMARY KEY, state TEXT, "
        "data TEXT NOT NULL DEFAULT '{}', updated_at INTEGER NOT NULL)"
    ),
    # Журнал дедупликации уведомлений: то же, что notification_log в D1
    # (migrations/0014). Нужен Python-боту для напоминаний Фло.
    (
        "CREATE TABLE IF NOT EXISTS notification_log (tg_id INTEGER NOT NULL, "
        "day TEXT NOT NULL, kind TEXT NOT NULL, sent_at INTEGER NOT NULL, "
        "PRIMARY KEY (tg_id, day, kind))"
    ),
    "CREATE INDEX IF NOT EXISTS idx_tasks_pair ON tasks(pair_id, status)",
    "CREATE INDEX IF NOT EXISTS idx_dates_pair ON dates(pair_id, day)",
    "CREATE INDEX IF NOT EXISTS idx_memories_pair ON memories(pair_id, created_at)",
    "CREATE INDEX IF NOT EXISTS idx_wishes_pair ON wishes(pair_id, done)",
    "CREATE INDEX IF NOT EXISTS idx_wishes_created ON wishes(pair_id, created_at)",
    "CREATE INDEX IF NOT EXISTS idx_quotes_pair ON quotes(pair_id, created_at)",
    "CREATE INDEX IF NOT EXISTS idx_places_pair ON places(pair_id, visited)",
    "CREATE INDEX IF NOT EXISTS idx_trips_pair ON trips(pair_id, visited)",
    "CREATE INDEX IF NOT EXISTS idx_goals_pair ON goals(pair_id, is_private)",
    "CREATE INDEX IF NOT EXISTS idx_goal_items_goal ON goal_items(goal_id, done)",
    "CREATE INDEX IF NOT EXISTS idx_movies_pair ON movies(pair_id, watched)",
    "CREATE INDEX IF NOT EXISTS idx_movie_ratings_movie ON movie_ratings(movie_id)",
    "CREATE UNIQUE INDEX IF NOT EXISTS idx_movies_pair_imdb ON movies(pair_id, imdb_id)",
    "CREATE INDEX IF NOT EXISTS idx_savings_pair ON savings(pair_id, kind)",
    (
        "CREATE INDEX IF NOT EXISTS idx_savings_deposits_saving ON savings_deposits(saving_id, "
        "created_at)"
    ),
    "CREATE INDEX IF NOT EXISTS idx_pair_members_pair ON pair_members(pair_id)",
    "CREATE UNIQUE INDEX IF NOT EXISTS idx_pair_members_role ON pair_members(pair_id, role)",
    "CREATE INDEX IF NOT EXISTS idx_users_pair ON users(pair_id)",
    "CREATE INDEX IF NOT EXISTS idx_pairs_user_a ON pairs(user_a)",
    "CREATE INDEX IF NOT EXISTS idx_pairs_user_b ON pairs(user_b)",
    (
        "CREATE TABLE IF NOT EXISTS cycle_profiles (tg_id INTEGER PRIMARY KEY, "
        "avg_cycle_length INTEGER NOT NULL DEFAULT 28, avg_period_length INTEGER NOT NULL DEFAULT 5, "
        "cycle_length_known INTEGER NOT NULL DEFAULT 0, "
        "share_enabled INTEGER NOT NULL DEFAULT 0, share_level TEXT NOT NULL DEFAULT 'phases', "
        "share_sex INTEGER NOT NULL DEFAULT 0, share_mood INTEGER NOT NULL DEFAULT 0, "
        "share_sleep INTEGER NOT NULL DEFAULT 0, share_bbt INTEGER NOT NULL DEFAULT 0, "
        "share_confirmed INTEGER NOT NULL DEFAULT 0, context TEXT, "
        "onboarded INTEGER NOT NULL DEFAULT 0, notify_enabled INTEGER NOT NULL DEFAULT 0, "
        "notify_period INTEGER NOT NULL DEFAULT 1, notify_ovulation INTEGER NOT NULL DEFAULT 1, "
        "notify_fertile INTEGER NOT NULL DEFAULT 1, notify_delay INTEGER NOT NULL DEFAULT 1, "
        "notify_period_days INTEGER NOT NULL DEFAULT 2, "
        "notify_delay_days INTEGER NOT NULL DEFAULT 3, "
        "notify_diary INTEGER NOT NULL DEFAULT 0, share_notify INTEGER NOT NULL DEFAULT 1, "
        "created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)"
    ),
    (
        "CREATE TABLE IF NOT EXISTS cycle_periods (id INTEGER PRIMARY KEY AUTOINCREMENT, "
        "tg_id INTEGER NOT NULL, start_date TEXT NOT NULL, end_date TEXT, "
        "end_unknown INTEGER NOT NULL DEFAULT 0, "
        "created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, UNIQUE(tg_id,start_date))"
    ),
    "CREATE INDEX IF NOT EXISTS idx_cycle_periods_tg_start ON cycle_periods(tg_id, start_date)",
    (
        "CREATE TABLE IF NOT EXISTS cycle_logs (id INTEGER PRIMARY KEY AUTOINCREMENT, "
        "tg_id INTEGER NOT NULL, date TEXT NOT NULL, flow TEXT, clots INTEGER NOT NULL DEFAULT 0, "
        "energy TEXT, mood TEXT, symptoms TEXT, symptoms_clear INTEGER NOT NULL DEFAULT 0, note TEXT, sex TEXT, sex_count INTEGER NOT NULL DEFAULT 1, "
        "leakage TEXT, pain_score INTEGER, pain_locations TEXT, life_impact TEXT, "
        "mucus TEXT, sleep_hours REAL, sleep_quality TEXT, stress TEXT, "
        "sick INTEGER NOT NULL DEFAULT 0, travel INTEGER NOT NULL DEFAULT 0, weight_kg REAL, "
        "bleeding_details TEXT, "
        "created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, UNIQUE(tg_id,date))"
    ),
    "CREATE INDEX IF NOT EXISTS idx_cycle_logs_tg_date ON cycle_logs(tg_id, date)",
    # Этап 6/P2: измерения (BBT/ЛГ), препараты и факт приёма.
    # Паритет с migrations/0038_p2_measurements.sql и worker.js ensureSchema.
    (
        "CREATE TABLE IF NOT EXISTS cycle_measurements (id INTEGER PRIMARY KEY AUTOINCREMENT, "
        "tg_id INTEGER NOT NULL, date TEXT NOT NULL, time TEXT, kind TEXT NOT NULL, "
        "value REAL, unit TEXT, result TEXT, note TEXT, "
        "created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)"
    ),
    "CREATE INDEX IF NOT EXISTS idx_cycle_measurements_tg_date ON cycle_measurements(tg_id, date)",
    (
        "CREATE TABLE IF NOT EXISTS cycle_meds (id INTEGER PRIMARY KEY AUTOINCREMENT, "
        "tg_id INTEGER NOT NULL, name TEXT NOT NULL, category TEXT, dosage TEXT, form TEXT, "
        "schedule TEXT, start_date TEXT NOT NULL, end_date TEXT, "
        "status TEXT NOT NULL DEFAULT 'active', note TEXT, "
        "created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)"
    ),
    "CREATE INDEX IF NOT EXISTS idx_cycle_meds_tg ON cycle_meds(tg_id, status)",
    (
        "CREATE TABLE IF NOT EXISTS cycle_med_logs (id INTEGER PRIMARY KEY AUTOINCREMENT, "
        "med_id INTEGER NOT NULL, tg_id INTEGER NOT NULL, date TEXT NOT NULL, time TEXT, "
        "status TEXT NOT NULL, dose_taken TEXT, note TEXT, "
        "created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, UNIQUE(med_id,date))"
    ),
    "CREATE INDEX IF NOT EXISTS idx_cycle_med_logs_tg_date ON cycle_med_logs(tg_id, date)",
]
