-- Кино: защита от дублей при гонке. POST /api/movies проверяет дубликат
-- SELECT'ом, но два партнёра, тапнувшие одну подсказку одновременно, оба
-- проходили проверку до INSERT. UNIQUE(pair_id, imdb_id) делает второй
-- INSERT ошибкой — воркер отвечает 409 ALREADY_ADDED.
--
-- До создания индекса убираем дубли, накопленные такой гонкой (без этого
-- CREATE UNIQUE INDEX упал бы на старой базе и миграция не применилась).
-- Оставляем самую «продвинутую» строку: отмеченную просмотренной, а при
-- равенстве — самую раннюю.
DELETE FROM movies WHERE id NOT IN (
  SELECT id FROM (
    SELECT id, ROW_NUMBER() OVER (
      PARTITION BY pair_id, imdb_id ORDER BY watched DESC, id ASC
    ) AS rn FROM movies
  ) WHERE rn = 1
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_movies_pair_imdb ON movies(pair_id, imdb_id);
