from __future__ import annotations

import random
import secrets
from datetime import date

from duoplan.db.base import Database
from duoplan.db.schema import now

DAILY_ACTIONS = (
    "Выделите сегодня 15 минут только друг для друга — без телефонов и дел.",
    "Назовите друг другу три вещи, за которые вы благодарны этой неделе.",
    "Запланируйте маленькое совместное удовольствие на ближайшие выходные.",
    "Поделитесь воспоминанием, к которому хочется возвращаться.",
    "Сделайте друг другу неожиданный комплимент — конкретный и честный.",
    "Выберите общее дело и сделайте первый маленький шаг вместе.",
    "Устройте мини-свидание: чай, прогулка или любимый фильм.",
)


class DuoPlanService:
    def __init__(self, db: Database) -> None:
        self.db = db

    async def ensure_user(self, tg_id: int, username: str | None, display_name: str) -> None:
        timestamp = now()
        await self.db.execute(
            "INSERT INTO users(tg_id, username, display_name, created_at, updated_at) "
            "VALUES(?, ?, ?, ?, ?) ON CONFLICT(tg_id) DO UPDATE SET "
            "username = excluded.username, display_name = excluded.display_name, "
            "updated_at = excluded.updated_at",
            (tg_id, username, display_name, timestamp, timestamp),
        )

    async def user(self, tg_id: int):
        return await self.db.one("SELECT * FROM users WHERE tg_id = ?", (tg_id,))

    async def membership(self, tg_id: int):
        return await self.db.one(
            "SELECT p.* FROM pairs p JOIN users u ON u.pair_id = p.id WHERE u.tg_id = ?",
            (tg_id,),
        )

    async def pair_for(self, tg_id: int):
        return await self.db.one(
            "SELECT p.* FROM pairs p JOIN users u ON u.pair_id = p.id "
            "WHERE u.tg_id = ? AND p.user_b != 0",
            (tg_id,),
        )

    async def create_pair(self, tg_id: int, display_name: str) -> str:
        code = secrets.token_hex(4).upper()
        timestamp = now()
        await self.db.execute(
            "INSERT INTO pairs(code, name1, name2, user_a, user_b, started_at, created_at, updated_at) "
            "VALUES(?, ?, '', ?, 0, ?, ?, ?)",
            (code, display_name, tg_id, date.today().isoformat(), timestamp, timestamp),
        )
        pair_id = await self.db.one("SELECT id FROM pairs WHERE code = ?", (code,))
        await self.db.execute(
            "UPDATE users SET pair_id = ?, role = 'a', updated_at = ? WHERE tg_id = ?",
            (pair_id["id"], timestamp, tg_id),
        )
        return code

    async def join_pair(self, tg_id: int, display_name: str, code: str) -> bool:
        pair = await self.db.one("SELECT * FROM pairs WHERE code = ?", (code.strip().upper(),))
        if not pair or pair["user_b"] or pair["user_a"] == tg_id:
            return False
        current = await self.pair_for(tg_id)
        if current:
            return False
        timestamp = now()
        await self.db.execute(
            "UPDATE pairs SET user_b = ?, name2 = ?, updated_at = ? WHERE id = ? AND user_b = 0",
            (tg_id, display_name, timestamp, pair["id"]),
        )
        await self.db.execute(
            "UPDATE users SET pair_id = ?, role = 'b', updated_at = ? WHERE tg_id = ?",
            (pair["id"], timestamp, tg_id),
        )
        return True

    async def add_task(self, pair_id: int, title: str, created_by: int) -> int:
        return await self.db.execute(
            "INSERT INTO tasks(pair_id, title, created_by, created_at) VALUES(?, ?, ?, ?)",
            (pair_id, title.strip(), created_by, now()),
        )

    async def tasks(self, pair_id: int):
        return await self.db.query(
            "SELECT * FROM tasks WHERE pair_id = ? AND status = 'open' "
            "ORDER BY created_at DESC LIMIT 20",
            (pair_id,),
        )

    async def complete_task(self, task_id: int, pair_id: int, user_id: int) -> bool:
        row = await self.db.one(
            "SELECT id FROM tasks WHERE id = ? AND pair_id = ? AND status = 'open'",
            (task_id, pair_id),
        )
        if not row:
            return False
        await self.db.execute(
            "UPDATE tasks SET status = 'done', completed_by = ?, completed_at = ? WHERE id = ?",
            (user_id, now(), task_id),
        )
        return True

    async def add_date(self, pair_id: int, title: str, day: str, recurs: int) -> int:
        return await self.db.execute(
            "INSERT INTO dates(pair_id, title, day, recurs, created_at) VALUES(?, ?, ?, ?, ?)",
            (pair_id, title.strip(), day, recurs, now()),
        )

    async def dates(self, pair_id: int):
        return await self.db.query(
            "SELECT * FROM dates WHERE pair_id = ? ORDER BY day LIMIT 30", (pair_id,)
        )

    async def add_memory(self, pair_id: int, author_id: int, body: str) -> int:
        timestamp = now()
        return await self.db.execute(
            "INSERT INTO memories(pair_id, author_id, body, day, created_at) VALUES(?, ?, ?, ?, ?)",
            (pair_id, author_id, body.strip(), date.today().isoformat(), timestamp),
        )

    async def memories(self, pair_id: int):
        return await self.db.query(
            "SELECT m.*, u.display_name FROM memories m LEFT JOIN users u ON u.tg_id = m.author_id "
            "WHERE m.pair_id = ? ORDER BY m.created_at DESC LIMIT 12",
            (pair_id,),
        )

    async def add_wish(self, pair_id: int, owner_id: int, body: str) -> int:
        return await self.db.execute(
            "INSERT INTO wishes(pair_id, owner_id, body, created_at) VALUES(?, ?, ?, ?)",
            (pair_id, owner_id, body.strip(), now()),
        )

    async def wishes(self, pair_id: int):
        return await self.db.query(
            "SELECT w.*, u.display_name FROM wishes w LEFT JOIN users u ON u.tg_id = w.owner_id "
            "WHERE w.pair_id = ? AND w.done = 0 ORDER BY w.created_at DESC LIMIT 20",
            (pair_id,),
        )

    async def complete_wish(self, wish_id: int, pair_id: int) -> bool:
        row = await self.db.one(
            "SELECT id FROM wishes WHERE id = ? AND pair_id = ? AND done = 0", (wish_id, pair_id)
        )
        if not row:
            return False
        await self.db.execute("UPDATE wishes SET done = 1 WHERE id = ?", (wish_id,))
        return True

    async def daily(self, pair_id: int) -> dict[str, object]:
        today = date.today().isoformat()
        row = await self.db.one(
            "SELECT * FROM daily_rolls WHERE pair_id = ? AND day = ?", (pair_id, today)
        )
        if row:
            return {"action": row["daily_value"], "done": bool(row["done_by"]), "day": today}
        seed = f"{pair_id}:{today}"
        action = DAILY_ACTIONS[random.Random(seed).randrange(len(DAILY_ACTIONS))]
        await self.db.execute(
            "INSERT INTO daily_rolls(pair_id, day, daily_kind, daily_value) "
            "VALUES(?, ?, 'moment', ?) ON CONFLICT(pair_id, day) DO NOTHING",
            (pair_id, today, action),
        )
        return {"action": action, "done": False, "day": today}

    async def complete_daily(self, pair_id: int, user_id: int) -> bool:
        today = date.today().isoformat()
        row = await self.db.one(
            "SELECT * FROM daily_rolls WHERE pair_id = ? AND day = ?", (pair_id, today)
        )
        if not row or row["done_by"]:
            return False
        user = await self.user(user_id)
        today_date = date.today()
        streak = 1
        if user and user["last_activity"]:
            previous = date.fromisoformat(user["last_activity"])
            if previous == today_date:
                streak = user["streak"]
            elif (today_date - previous).days == 1:
                streak = user["streak"] + 1
        await self.db.execute(
            "UPDATE daily_rolls SET done_by = ?, done_at = ? WHERE pair_id = ? AND day = ?",
            (user_id, now(), pair_id, today),
        )
        await self.db.execute(
            "UPDATE users SET points = points + 10, streak = ?, best_streak = MAX(best_streak, ?), "
            "last_activity = ?, updated_at = ? WHERE tg_id = ?",
            (streak, streak, today, now(), user_id),
        )
        await self.db.execute(
            "UPDATE pairs SET together_pts = together_pts + 10, updated_at = ? WHERE id = ?",
            (now(), pair_id),
        )
        return True
