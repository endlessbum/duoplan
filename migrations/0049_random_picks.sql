-- Рандом мест и фильмов: выбранное место/фильм сохраняется в паре,
-- чтобы оба участника видели один и тот же результат до нажатия «Закрыть».
-- NULL — рандом не активен. Закрытие карточки сбрасывает поле.
ALTER TABLE pairs ADD COLUMN place_pick_id INTEGER;
ALTER TABLE pairs ADD COLUMN movie_pick_id INTEGER;
