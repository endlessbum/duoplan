-- Фло, фаза 2: дневник дня (интенсивность, симптомы, заметка). Только владелица.
CREATE TABLE IF NOT EXISTS cycle_logs (id INTEGER PRIMARY KEY AUTOINCREMENT,tg_id INTEGER NOT NULL,date TEXT NOT NULL,flow TEXT,symptoms TEXT,note TEXT,sex TEXT,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL,UNIQUE(tg_id,date));
CREATE INDEX IF NOT EXISTS idx_cycle_logs_tg_date ON cycle_logs(tg_id,date);
