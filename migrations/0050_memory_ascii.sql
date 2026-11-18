-- ASCII-представление изображения, прикреплённого к записи дневника.
-- Оригинальный файл изображения не хранится.
ALTER TABLE memories ADD COLUMN ascii_art TEXT;
