-- Журнал уведомлений и индекс очистки дедупликации webhook. Раньше они
-- создавались только в ensureSchema (worker.js), поэтому база, поднятая
-- исключительно миграциями, отличалась от базы после /api/setup
-- (аудит 2026-11-01: расхождение ловит tests/test_schema_parity.py).
CREATE TABLE IF NOT EXISTS notification_log (
  tg_id INTEGER NOT NULL,
  day TEXT NOT NULL,
  kind TEXT NOT NULL,
  sent_at INTEGER NOT NULL,
  PRIMARY KEY (tg_id, day, kind)
);

CREATE INDEX IF NOT EXISTS idx_telegram_updates_received_at ON telegram_updates(received_at);
