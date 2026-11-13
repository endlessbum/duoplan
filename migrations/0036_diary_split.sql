-- Фло, этап 4 (P1): разделение дневника. Сгустки — не вариант интенсивности
-- (отдельный признак дня), энергия — не эмоция и не симптом (своя колонка),
-- явная отметка «симптомов не было» отличается от пропуска дня.
ALTER TABLE cycle_logs ADD COLUMN clots INTEGER NOT NULL DEFAULT 0;
ALTER TABLE cycle_logs ADD COLUMN energy TEXT;
ALTER TABLE cycle_logs ADD COLUMN symptoms_clear INTEGER NOT NULL DEFAULT 0;

-- Сгустки были вариантом интенсивности: переносим в признак честно —
-- интенсивность остаётся неизвестной, владелица уточнит её в календаре.
UPDATE cycle_logs SET clots = 1, flow = NULL WHERE flow = 'clots';

-- Энергия жила кодами «настроения»: переезжает в свою колонку.
UPDATE cycle_logs SET energy = 'high', mood = NULL WHERE mood = 'energetic';
UPDATE cycle_logs SET energy = 'low', mood = NULL WHERE energy IS NULL AND mood = 'low_energy';
-- Эмоциональные коды в физических симптомах (дубли настроения) убираются
-- на чтении: cycleState/cycleStats фильтруют список по актуальному каталогу.
