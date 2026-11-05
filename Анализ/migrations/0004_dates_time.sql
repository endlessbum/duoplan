-- Время значимой даты (необязательное): уточняет отсчёт до события.
-- Колонки добавляются если их нет (ensureSchema в worker.js тоже проверяет наличие).
ALTER TABLE dates ADD COLUMN time TEXT;
