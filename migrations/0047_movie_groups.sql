-- Группы фильмов/сериалов («Кино»): визуальная стопка связанных записей.
-- Группа — только метаданные и связи; каждая часть остаётся самостоятельной
-- строкой movies со своими рейтингами, датой просмотра и деталями.
CREATE TABLE IF NOT EXISTS movie_groups (
  id TEXT PRIMARY KEY,
  pair_id INTEGER NOT NULL REFERENCES pairs(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  group_type TEXT NOT NULL DEFAULT 'collection',
  created_by INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE(id, pair_id)
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_movies_id_pair
  ON movies(id, pair_id);

CREATE TABLE IF NOT EXISTS movie_group_items (
  pair_id INTEGER NOT NULL,
  group_id TEXT NOT NULL,
  movie_id INTEGER NOT NULL,
  position INTEGER NOT NULL DEFAULT 0,
  added_by INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (group_id, movie_id),
  UNIQUE(movie_id),
  FOREIGN KEY (group_id, pair_id)
    REFERENCES movie_groups(id, pair_id) ON DELETE CASCADE,
  FOREIGN KEY (movie_id, pair_id)
    REFERENCES movies(id, pair_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_movie_group_items_order
  ON movie_group_items(pair_id, group_id, position, movie_id);
