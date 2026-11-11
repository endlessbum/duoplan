-- Недельная сводка (настройки на вкладке «Наша пара»): планы и даты на
-- предстоящую неделю одним сообщением. Персональные настройки — как у
-- утренней сводки, но по умолчанию выключена; день отправки — вс или пн.
-- Колонки добавляются если их нет (ensureSchema в worker.js тоже проверяет наличие).
ALTER TABLE users ADD COLUMN weekly_digest_enabled INTEGER NOT NULL DEFAULT 0;
ALTER TABLE users ADD COLUMN weekly_digest_time TEXT;
ALTER TABLE users ADD COLUMN weekly_digest_day TEXT NOT NULL DEFAULT 'sun';
