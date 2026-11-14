-- Здоровье (вкладка «Дневник → Здоровье»): личный журнал препаратов каждого
-- партнёра. Данные строго персональные (tg_id из сессии), партнёр чужой
-- список не видит. Факт приёма — один итог за день (UNIQUE(med_id, date)),
-- как во Фло; напоминание бота — по remind_enabled/remind_time через крон.
CREATE TABLE IF NOT EXISTS health_meds (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tg_id INTEGER NOT NULL,
  name TEXT NOT NULL,
  dosage TEXT,
  form TEXT,
  schedule TEXT,
  remind_enabled INTEGER NOT NULL DEFAULT 0,
  remind_time TEXT,
  start_date TEXT NOT NULL,
  end_date TEXT,
  status TEXT NOT NULL DEFAULT 'active',
  note TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_health_meds_tg ON health_meds(tg_id, status);
CREATE TABLE IF NOT EXISTS health_med_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  med_id INTEGER NOT NULL,
  tg_id INTEGER NOT NULL,
  date TEXT NOT NULL,
  time TEXT,
  status TEXT NOT NULL,
  note TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE(med_id, date)
);
CREATE INDEX IF NOT EXISTS idx_health_med_logs_tg_date ON health_med_logs(tg_id, date);
