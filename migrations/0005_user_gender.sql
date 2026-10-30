-- Пол пользователя для корректных подписей в разделе желаний (Мои / Его / Её).
-- Колонки добавляются если их нет (ensureSchema в worker.js тоже проверяет наличие).
ALTER TABLE users ADD COLUMN gender TEXT;
