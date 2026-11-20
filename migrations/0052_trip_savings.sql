-- Поездка может быть прикреплена к общей активной копилке пары.
-- Копилка удаляется — связь сбрасывается, сама поездка остаётся.
ALTER TABLE trips ADD COLUMN saving_id INTEGER REFERENCES savings(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_trips_saving ON trips(saving_id);
