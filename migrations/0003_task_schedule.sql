-- Дата и время плана (необязательные): отсчёт до назначенного момента в Mini App.
-- Колонки уже есть в schema.py, поэтому добавляем с IF NOT EXISTS.
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS day TEXT;
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS time TEXT;
