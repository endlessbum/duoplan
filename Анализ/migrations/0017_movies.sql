-- Кино: сегмент «Кино» на вкладке «Планы» — избранное к просмотру.
-- Карточка приходит из IMDb целиком (поиск по подсказкам, тап — добавление):
-- imdb_id/title/year/kind/rating/genres/runtime/seasons/episodes — снимок
-- данных на момент добавления, url — страница тайтла. watched=1 выводит
-- фильм из колоды «Рандома»; watched_by/watched_at — кто и когда отметил
-- (фильм общий, отметку ставит любой из партнёров).
CREATE TABLE IF NOT EXISTS movies (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  pair_id INTEGER NOT NULL REFERENCES pairs(id) ON DELETE CASCADE,
  created_by INTEGER NOT NULL,
  imdb_id TEXT NOT NULL,
  title TEXT NOT NULL,
  year INTEGER,
  kind TEXT NOT NULL DEFAULT 'movie',
  rating REAL,
  genres TEXT,
  runtime INTEGER,
  seasons INTEGER,
  episodes INTEGER,
  url TEXT,
  watched INTEGER NOT NULL DEFAULT 0,
  watched_at INTEGER,
  watched_by INTEGER,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_movies_pair ON movies(pair_id, watched);
