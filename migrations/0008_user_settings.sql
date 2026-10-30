-- Пользовательские настройки (карточка «Настройки» на вкладке «Наша пара»):
-- время утренней сводки и сводки о датах за сутки — персональные (NULL = 09:00),
-- флаги включённости, персональный акцентный цвет интерфейса.
-- Колонки уже есть в schema.py, поэтому добавляем с IF NOT EXISTS.
ALTER TABLE users ADD COLUMN IF NOT EXISTS digest_time TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS digest_enabled INTEGER NOT NULL DEFAULT 1;
ALTER TABLE users ADD COLUMN IF NOT EXISTS dates_digest_time TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS dates_digest_enabled INTEGER NOT NULL DEFAULT 1;
ALTER TABLE users ADD COLUMN IF NOT EXISTS accent_color TEXT;
