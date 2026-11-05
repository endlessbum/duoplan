-- Кино: защита от дублей при гонке. POST /api/movies проверяет дубликат
-- SELECT'ом, но два партнёра, тапнувшие одну подсказку одновременно, оба
-- проходили проверку до INSERT. UNIQUE(pair_id, imdb_id) делает второй
-- INSERT ошибкой — воркер отвечает 409 ALREADY_ADDED.
CREATE UNIQUE INDEX IF NOT EXISTS idx_movies_pair_imdb ON movies(pair_id, imdb_id);
