-- Фло: отдельное поле настроения в дневнике дня ( mood — один код или NULL ).
-- Раньше настроение жило только кодами внутри symptoms; колонка нужна для
-- экспорта и статистики. IF NOT EXISTS у ALTER TABLE ADD COLUMN в SQLite нет —
-- D1 применяет каждую миграцию один раз, повторный прогон невозможен.
ALTER TABLE cycle_logs ADD COLUMN mood TEXT;
