-- Пользовательские настройки (карточка «Настройки» на вкладке «Наша пара»):
-- время утренней сводки и сводки о датах за сутки — персональные (NULL = 09:00),
-- флаги включённости, персональный акцентный цвет интерфейса.
-- Колонки добавляются если их нет (ensureSchema в worker.js тоже проверяет наличие).
ALTER TABLE users ADD COLUMN digest_time TEXT;
ALTER TABLE users ADD COLUMN digest_enabled INTEGER NOT NULL DEFAULT 1;
ALTER TABLE users ADD COLUMN dates_digest_time TEXT;
ALTER TABLE users ADD COLUMN dates_digest_enabled INTEGER NOT NULL DEFAULT 1;
ALTER TABLE users ADD COLUMN accent_color TEXT;
