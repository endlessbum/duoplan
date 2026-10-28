-- Дата и время плана (необязательные): отсчёт до назначенного момента в Mini App.
ALTER TABLE tasks ADD COLUMN day TEXT;
ALTER TABLE tasks ADD COLUMN time TEXT;
