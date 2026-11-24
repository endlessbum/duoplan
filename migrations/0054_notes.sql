-- Личные заметки Mini App («Дневник → Записи → Заметки»): персональные
-- записи автора, ключ — tg_id. Пароль на просмотр живёт только на устройстве
-- клиента (как пароль на вход) и сервером не хранится; заметки не попадают
-- в /api/state и отдаются только владельцу через /api/notes.
CREATE TABLE IF NOT EXISTS notes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tg_id INTEGER NOT NULL,
  title TEXT NOT NULL,
  body TEXT,
  comment TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_notes_tg ON notes(tg_id, updated_at);
