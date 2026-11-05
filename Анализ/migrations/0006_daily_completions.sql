CREATE TABLE IF NOT EXISTS daily_completions (
  pair_id INTEGER NOT NULL REFERENCES pairs(id) ON DELETE CASCADE,
  tg_id INTEGER NOT NULL,
  day TEXT NOT NULL,
  completed_at INTEGER NOT NULL,
  PRIMARY KEY (pair_id, tg_id, day)
);

CREATE INDEX IF NOT EXISTS idx_daily_completions_pair_day ON daily_completions(pair_id, day);
