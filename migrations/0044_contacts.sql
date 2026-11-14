-- Контакты («Дневник → Контакты»): телефонная книга пары, у каждого партнёра
-- своя. Списки обоих читаются, редактировать можно только свой (owner_id).
-- Номера — отдельной таблицей: до 3 на контакт, порядок задаёт sort;
-- формат хранения единый «+7 ХХХ ХХХ ХХ ХХ».
CREATE TABLE IF NOT EXISTS contacts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  pair_id INTEGER NOT NULL REFERENCES pairs(id) ON DELETE CASCADE,
  owner_id INTEGER NOT NULL,
  name TEXT NOT NULL,
  surname TEXT,
  comment TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_contacts_pair_owner ON contacts(pair_id, owner_id);
CREATE TABLE IF NOT EXISTS contact_phones (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  contact_id INTEGER NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  phone TEXT NOT NULL,
  sort INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_contact_phones_contact ON contact_phones(contact_id, sort);
