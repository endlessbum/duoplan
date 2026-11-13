-- Фло, этап 6/P2: расширенные наблюдения.
-- 1) Дневные факторы и слизь в cycle_logs (все опциональны, NULL = не отмечено).
-- 2) cycle_measurements — серия измерений (базальная температура, тесты на ЛГ):
--    несколько записей в день возможны, поэтому отдельная таблица, а не колонки.
-- 3) cycle_meds — справочник препаратов/курсов; cycle_med_logs — факт приёма
--    (назначенная дозировка в cycle_meds.dosage не равна фактической в
--    cycle_med_logs.dose_taken).

ALTER TABLE cycle_logs ADD COLUMN mucus TEXT;
ALTER TABLE cycle_logs ADD COLUMN sleep_hours REAL;
ALTER TABLE cycle_logs ADD COLUMN sleep_quality TEXT;
ALTER TABLE cycle_logs ADD COLUMN stress TEXT;
ALTER TABLE cycle_logs ADD COLUMN sick INTEGER NOT NULL DEFAULT 0;
ALTER TABLE cycle_logs ADD COLUMN travel INTEGER NOT NULL DEFAULT 0;
ALTER TABLE cycle_logs ADD COLUMN weight_kg REAL;

CREATE TABLE IF NOT EXISTS cycle_measurements (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tg_id INTEGER NOT NULL,
  date TEXT NOT NULL,
  time TEXT,
  kind TEXT NOT NULL,
  value REAL,
  unit TEXT,
  result TEXT,
  note TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_cycle_measurements_tg_date ON cycle_measurements(tg_id, date);

CREATE TABLE IF NOT EXISTS cycle_meds (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tg_id INTEGER NOT NULL,
  name TEXT NOT NULL,
  category TEXT,
  dosage TEXT,
  form TEXT,
  schedule TEXT,
  start_date TEXT NOT NULL,
  end_date TEXT,
  status TEXT NOT NULL DEFAULT 'active',
  note TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_cycle_meds_tg ON cycle_meds(tg_id, status);

CREATE TABLE IF NOT EXISTS cycle_med_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  med_id INTEGER NOT NULL,
  tg_id INTEGER NOT NULL,
  date TEXT NOT NULL,
  time TEXT,
  status TEXT NOT NULL,
  dose_taken TEXT,
  note TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE(med_id,date)
);
CREATE INDEX IF NOT EXISTS idx_cycle_med_logs_tg_date ON cycle_med_logs(tg_id, date);
