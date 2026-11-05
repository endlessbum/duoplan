-- Дата и время плана (необязательные): отсчёт до назначенного момента в Mini App.
-- SQLite (и D1) не поддерживает IF NOT EXISTS в ALTER TABLE ADD COLUMN —
-- на чистой базе миграция падала бы с синтаксической ошибкой. Колонки добавляет
-- ровно эта миграция после 0001, поэтому защита от дубля не нужна.
ALTER TABLE tasks ADD COLUMN day TEXT;
ALTER TABLE tasks ADD COLUMN time TEXT;
