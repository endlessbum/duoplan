-- Фло, этап P3: настраиваемое напоминание о незаполненном дневнике.
-- notify_diary=1 — раз в день напоминать, если вчерашний день без записи.
ALTER TABLE cycle_profiles ADD COLUMN notify_diary INTEGER NOT NULL DEFAULT 0;
