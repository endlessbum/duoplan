-- Оценки фильмов парой (RAofP — rating assessment of the pair).
-- Каждый пользователь ставит одну целую оценку 1..10; RAofP — среднее
-- арифметическое голосов. Оценка ставится при отметке «Просмотрено» и
-- обязательна: без неё карточка не уходит в «Просмотренные».
CREATE TABLE IF NOT EXISTS movie_ratings (
  movie_id INTEGER NOT NULL REFERENCES movies(id) ON DELETE CASCADE,
  tg_id INTEGER NOT NULL,
  rating INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (movie_id, tg_id)
);
CREATE INDEX IF NOT EXISTS idx_movie_ratings_movie ON movie_ratings(movie_id);
