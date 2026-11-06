-- Ожидание возвращения партнёра: после выхода одного из пары контент
-- пространства замораживается (403 PARTNER_ABSENT), а вход
-- вернувшегося по тому же коду уведомляет оставшегося.
ALTER TABLE pairs ADD COLUMN awaiting_return INTEGER NOT NULL DEFAULT 0;
-- Коды пространств, закрытых полным выходом: вход по такому коду получает
-- 410 PAIR_CLOSED вместо 404 CODE_NOT_FOUND.
CREATE TABLE IF NOT EXISTS closed_codes (code TEXT PRIMARY KEY,closed_at INTEGER NOT NULL);
