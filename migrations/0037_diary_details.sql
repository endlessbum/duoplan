-- Фло, этап 4/P1 (добивка дневника): протекание, шкала боли 0–10 с
-- локализацией и влияние симптомов на жизнь. Все поля опциональны:
-- NULL/дефолт означает «не отмечено», выдуманных значений нет.
ALTER TABLE cycle_logs ADD COLUMN leakage TEXT;
ALTER TABLE cycle_logs ADD COLUMN pain_score INTEGER;
ALTER TABLE cycle_logs ADD COLUMN pain_locations TEXT;
ALTER TABLE cycle_logs ADD COLUMN life_impact TEXT;
