-- Личные планы: is_private=1 видит только создатель (created_by уже писался
-- у всех планов). В уведомлениях бота такие планы показываются автору как
-- «Скрытый» под спойлером.
-- Колонки добавляются если их нет (ensureSchema в worker.js тоже проверяет наличие).
ALTER TABLE tasks ADD COLUMN is_private INTEGER NOT NULL DEFAULT 0;
