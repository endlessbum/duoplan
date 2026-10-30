-- Личные даты: is_private=1 видит в списках и уведомлениях только создатель
-- (created_by). created_by пишется у всех дат — без него приватность не
-- привязать к автору; существующим строкам проставляется 0 (дата без автора),
-- такие записи остаются общими, пока владелец не переопределит приватность.
-- Колонки уже есть в schema.py, поэтому добавляем с IF NOT EXISTS.
ALTER TABLE dates ADD COLUMN IF NOT EXISTS created_by INTEGER NOT NULL DEFAULT 0;
ALTER TABLE dates ADD COLUMN IF NOT EXISTS is_private INTEGER NOT NULL DEFAULT 0;
