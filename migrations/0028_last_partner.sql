-- tg_id ушедшего партнёра: код резервируется за ним до возвращения,
-- другой аккаунт по тому же коду войти не может (PAIR_RESERVED).
ALTER TABLE pairs ADD COLUMN last_partner INTEGER NOT NULL DEFAULT 0;
