-- Личные планы: is_private=1 видит только создатель (created_by уже писался
-- у всех планов). В уведомлениях бота такие планы показываются автору как
-- «Скрытый» под спойлером.
-- Колонка уже есть в schema.py, поэтому добавляем с IF NOT EXISTS.
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS is_private INTEGER NOT NULL DEFAULT 0;
