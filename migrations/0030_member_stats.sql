-- Статистика «Ваша история» (XP, серии, последняя активность) живёт в users
-- и описывает ТЕКУЩУЮ пару, а не аккаунт. member_stats хранит снимок этих
-- полей участника на момент выхода из пространства:
--  * вход в новую пару обнуляет статистику (новая совместная история);
--  * возвращение прежнего партнёра по зарезервированному коду
--    (awaiting_return=1 + last_partner) восстанавливает снимок — история
--    пары сохраняется, даже если партнёр успел побывать в другом пространстве.
CREATE TABLE IF NOT EXISTS member_stats (
  pair_id INTEGER NOT NULL REFERENCES pairs(id) ON DELETE CASCADE,
  tg_id INTEGER NOT NULL,
  points INTEGER NOT NULL DEFAULT 0,
  streak INTEGER NOT NULL DEFAULT 0,
  best_streak INTEGER NOT NULL DEFAULT 0,
  last_activity TEXT,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (pair_id, tg_id)
);

-- Бэкфилл для пар, где партнёр вышел до появления таблицы: его строка в
-- users ещё хранит статистику этого пространства (если он не вступал в
-- другую пару — историческое смешение здесь уже не исправить).
INSERT OR IGNORE INTO member_stats(pair_id,tg_id,points,streak,best_streak,last_activity,updated_at)
SELECT p.id, p.last_partner, u.points, u.streak, u.best_streak, u.last_activity,
       CAST(strftime('%s','now') AS INTEGER)
FROM pairs p JOIN users u ON u.tg_id = p.last_partner
WHERE p.awaiting_return = 1 AND p.last_partner != 0;
