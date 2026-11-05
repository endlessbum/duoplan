-- Копилки: сегмент «Копилка» на вкладке «Наша пара».
-- kind='personal' — личная копилка, видна только автору (фильтр created_by
-- в выдаче, как у личных дат); kind='shared' — общая копилка пары.
-- target — сколько нужно накопить, collected — сколько собрано (поддерживается
-- при пополнении той же транзакцией, что пишет запись в историю).
CREATE TABLE IF NOT EXISTS savings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  pair_id INTEGER NOT NULL REFERENCES pairs(id) ON DELETE CASCADE,
  created_by INTEGER NOT NULL,
  kind TEXT NOT NULL DEFAULT 'personal',
  title TEXT NOT NULL,
  target INTEGER NOT NULL,
  collected INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_savings_pair ON savings(pair_id, kind);

-- История пополнений: кто (tg_id), сколько (amount) и когда. collected в
-- savings всегда равен SUM(amount) по этой таблице для той же копилки.
CREATE TABLE IF NOT EXISTS savings_deposits (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  saving_id INTEGER NOT NULL REFERENCES savings(id) ON DELETE CASCADE,
  tg_id INTEGER NOT NULL,
  amount INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_savings_deposits_saving ON savings_deposits(saving_id, created_at);
