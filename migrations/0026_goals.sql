-- Цели: задача с описанием и пунктами выполнения (вкладка «Планы»,
-- сегмент «Цели»). Цель считается выполненной, когда все её пункты
-- отмечены done; личные цели (is_private) партнёр не видит совсем —
-- тот же фильтр, что у личных планов.
CREATE TABLE IF NOT EXISTS goals (id INTEGER PRIMARY KEY AUTOINCREMENT,pair_id INTEGER NOT NULL REFERENCES pairs(id) ON DELETE CASCADE,created_by INTEGER NOT NULL,title TEXT NOT NULL,is_private INTEGER NOT NULL DEFAULT 0,created_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS goal_items (id INTEGER PRIMARY KEY AUTOINCREMENT,goal_id INTEGER NOT NULL REFERENCES goals(id) ON DELETE CASCADE,pair_id INTEGER NOT NULL REFERENCES pairs(id) ON DELETE CASCADE,created_by INTEGER NOT NULL,title TEXT NOT NULL,done INTEGER NOT NULL DEFAULT 0,done_at INTEGER,done_by INTEGER,created_at INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS idx_goals_pair ON goals(pair_id,is_private);
CREATE INDEX IF NOT EXISTS idx_goal_items_goal ON goal_items(goal_id,done);
