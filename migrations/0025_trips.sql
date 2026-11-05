-- Поездки: желанные путешествия в другие города и страны (вкладка «Места»,
-- сегмент «Путешествие»). Структура повторяет places, но без url: поездке
-- достаточно названия и заметки. Посещение отмечается так же, как у мест.
CREATE TABLE IF NOT EXISTS trips (id INTEGER PRIMARY KEY AUTOINCREMENT,pair_id INTEGER NOT NULL REFERENCES pairs(id) ON DELETE CASCADE,created_by INTEGER NOT NULL,title TEXT NOT NULL,note TEXT,visited INTEGER NOT NULL DEFAULT 0,visited_at INTEGER,visited_by INTEGER,created_at INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS idx_trips_pair ON trips(pair_id,visited);
