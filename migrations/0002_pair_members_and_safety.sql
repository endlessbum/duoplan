-- Колонки уже есть в schema.py, поэтому добавляем с IF NOT EXISTS.
ALTER TABLE users ADD COLUMN IF NOT EXISTS timezone TEXT NOT NULL DEFAULT 'Europe/Moscow';
ALTER TABLE pairs ADD COLUMN IF NOT EXISTS timezone TEXT NOT NULL DEFAULT 'Europe/Moscow';

CREATE TABLE IF NOT EXISTS pair_members (
  tg_id INTEGER PRIMARY KEY,
  pair_id INTEGER NOT NULL REFERENCES pairs(id) ON DELETE CASCADE,
  role TEXT NOT NULL DEFAULT 'a',
  joined_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS rate_limits (
  bucket_key TEXT PRIMARY KEY,
  count INTEGER NOT NULL,
  expires_at INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS telegram_updates (
  update_id INTEGER PRIMARY KEY,
  received_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS app_meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

INSERT OR IGNORE INTO pair_members(tg_id, pair_id, role, joined_at)
SELECT user_a, id, 'a', created_at FROM pairs
WHERE user_a != 0 AND EXISTS(SELECT 1 FROM users WHERE users.tg_id = pairs.user_a);

INSERT OR IGNORE INTO pair_members(tg_id, pair_id, role, joined_at)
SELECT user_b, id, 'b', created_at FROM pairs
WHERE user_b != 0 AND EXISTS(SELECT 1 FROM users WHERE users.tg_id = pairs.user_b);

CREATE INDEX IF NOT EXISTS idx_pair_members_pair ON pair_members(pair_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_pair_members_role ON pair_members(pair_id, role);
