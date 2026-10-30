-- Заголовок записи дневника: поле над текстом воспоминания в Mini App.
-- У старых записей и записей из бота заголовка нет — NULL, карточка
-- показывается без заголовка. Колонку также добавляет ensureSchema в
-- worker.js (список ALTER), локальная схема — duoplan/db/schema.py.
ALTER TABLE memories ADD COLUMN title TEXT;
