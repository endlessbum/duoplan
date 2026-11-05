-- Личное имя пользователя: приоритет над display_name из Telegram.
-- IF NOT EXISTS у ALTER TABLE ADD COLUMN в SQLite нет — D1 применяет каждую
-- миграцию один раз, повторный прогон невозможен.
ALTER TABLE users ADD COLUMN custom_name TEXT;
