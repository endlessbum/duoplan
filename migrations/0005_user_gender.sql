-- Пол пользователя для корректных подписей в разделе желаний (Мои / Его / Её).
-- Колонка уже есть в schema.py, поэтому добавляем с IF NOT EXISTS.
ALTER TABLE users ADD COLUMN IF NOT EXISTS gender TEXT;
