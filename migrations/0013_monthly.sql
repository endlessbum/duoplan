-- Повторы: tasks.monthly/tasks.yearly и dates.monthly (0/1); ежегодность
-- дат остаётся в dates.recurs. Ежегодные планы — tasks.yearly. Прежний текст:
-- остаётся в dates.recurs; monthly=1 у даты старше recurs (сервер приводит).
-- Колонки также добавляет ensureSchema в worker.js; локальная схема —
-- duoplan/db/schema.py; экспорт — scripts/export_sqlite_to_d1.py.
ALTER TABLE tasks ADD COLUMN monthly INTEGER NOT NULL DEFAULT 0;
ALTER TABLE tasks ADD COLUMN yearly INTEGER NOT NULL DEFAULT 0;
ALTER TABLE dates ADD COLUMN monthly INTEGER NOT NULL DEFAULT 0;
