-- Время значимой даты (необязательное): уточняет отсчёт до события.
-- Колонка уже есть в schema.py, поэтому добавляем с IF NOT EXISTS.
ALTER TABLE dates ADD COLUMN IF NOT EXISTS time TEXT;
