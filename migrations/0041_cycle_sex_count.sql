-- Фло: несколько актов за день. sex остаётся типом защиты последней/общей
-- отметки, sex_count — сколько раз отмечено (1..20). Паритет с
-- duoplan/db/schema.py и worker.js ensureSchema.
ALTER TABLE cycle_logs ADD COLUMN sex_count INTEGER NOT NULL DEFAULT 1;
