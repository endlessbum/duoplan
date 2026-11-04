-- Цитаты: сегмент «Цитаты» на вкладке «Дневник».
-- Общая коллекция фраз пары — править и удалять может любой из двоих, автор
-- хранится только для подписи карточки (как author_id у дневника).
CREATE TABLE IF NOT EXISTS quotes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  pair_id INTEGER NOT NULL REFERENCES pairs(id) ON DELETE CASCADE,
  author_id INTEGER NOT NULL,
  body TEXT NOT NULL,
  source TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_quotes_pair ON quotes(pair_id, created_at);

-- Места: вкладка «Места» — список «куда сходить» с отметкой посещения.
-- visited=1 выводит место из колоды «Рандома»; visited_by/visited_at — кто и
-- когда отметил (место общее, отметку ставит любой из партнёров).
CREATE TABLE IF NOT EXISTS places (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  pair_id INTEGER NOT NULL REFERENCES pairs(id) ON DELETE CASCADE,
  created_by INTEGER NOT NULL,
  title TEXT NOT NULL,
  note TEXT,
  url TEXT,
  visited INTEGER NOT NULL DEFAULT 0,
  visited_at INTEGER,
  visited_by INTEGER,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_places_pair ON places(pair_id, visited);

-- Дни рождения: сегмент «Дни рождения» на вкладке «Даты».
-- Это те же значимые даты с ежегодным повтором (recurs=1, monthly=0), поэтому
-- приватность (is_private/created_by), отсчёт, календарь, сводки и экспорт
-- работают без отдельного конвейера. У существующих записей kind='date'.
ALTER TABLE dates ADD COLUMN kind TEXT NOT NULL DEFAULT 'date';
