from __future__ import annotations

import random
import secrets
import sqlite3
from datetime import date
from datetime import datetime
from datetime import timezone
from datetime import tzinfo

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

# Лимиты совпадают с Worker/Mini App, чтобы обе поверхности обрезали текст одинаково.
TASK_TITLE_MAX = 180
DATE_TITLE_MAX = 120
MEMORY_MAX = 2000
WISH_MAX = 300

DAILY_XP = 10

MAX_LIMIT = 100


class ValidationError(ValueError):
    """Пользовательский ввод не прошёл проверку; текст безопасно показать в чате."""


def _clean_text(value: object, limit: int, label: str) -> str:
    if value is None:
        raise ValidationError(f"{label}: пришлите текст сообщением.")
    text = str(value).strip()
    if not text:
        raise ValidationError(f"{label}: текст не может быть пустым.")
    if len(text) > limit:
        raise ValidationError(f"{label}: не длиннее {limit} символов (сейчас {len(text)}).")
    return text


def _page(limit: int, offset: int) -> tuple[int, int]:
    try:
        limit = int(limit)
        offset = int(offset)
    except (TypeError, ValueError) as exc:
        raise ValidationError("Некорректные параметры страницы.") from exc
    return max(1, min(limit, MAX_LIMIT)), max(0, offset)


def normalize_code(raw: object) -> str:
    """Код приглашения: без пробелов, в верхнем регистре. Пустой -> ``""``."""
    if raw is None:
        return ""
    return "".join(str(raw).split()).upper()[:32]


class DuoPlanService:
    def __init__(self, db: Database, tz: tzinfo | None = None) -> None:
        self.db = db
        self.tz: tzinfo = tz or timezone.utc

    # ------------------------------------------------------------------ время

    def local_today(self, at: datetime | None = None) -> date:
        """Локальная дата пары (по часовому поясу из настроек), а не дата сервера."""
        moment = at if at is not None else datetime.now(timezone.utc)
        if moment.tzinfo is None:
            moment = moment.replace(tzinfo=timezone.utc)
        return moment.astimezone(self.tz).date()

    # -------------------------------------------------------------- пользователи

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
        """Пара, в которой пользователь числится, даже если партнёр ещё не вошёл."""
        return await self.db.one(
            "SELECT p.* FROM pairs p JOIN users u ON u.pair_id = p.id WHERE u.tg_id = ?",
            (tg_id,),
        )

    async def pair_for(self, tg_id: int):
        """Только полностью соединённая пара (есть оба участника)."""
        return await self.db.one(
            "SELECT p.* FROM pairs p JOIN users u ON u.pair_id = p.id "
            "WHERE u.tg_id = ? AND p.user_b != 0",
            (tg_id,),
        )

    # --------------------------------------------------------------------- пара

    async def create_pair(self, tg_id: int, display_name: str) -> str:
        """Идемпотентно создать пространство и вернуть его код."""
        timestamp = now()
        async with self.db.transaction() as tx:
            user = await self.db.one("SELECT pair_id FROM users WHERE tg_id = ?", (tg_id,))
            if user is None:
                tx.rollback()
                raise ValidationError("Сначала зарегистрируйтесь: отправьте /start.")
            if user["pair_id"] is not None:
                existing = await self.db.one("SELECT * FROM pairs WHERE id = ?", (user["pair_id"],))
                if existing is not None:
                    return existing["code"]

            for _ in range(5):
                code = secrets.token_hex(4).upper()
                try:
                    pair_id, _ = await self.db.execute_row(
                        "INSERT INTO pairs(code, name1, name2, user_a, user_b, started_at, "
                        "created_at, updated_at) VALUES(?, ?, '', ?, 0, ?, ?, ?)",
                        (
                            code,
                            display_name,
                            tg_id,
                            self.local_today().isoformat(),
                            timestamp,
                            timestamp,
                        ),
                    )
                except sqlite3.IntegrityError:
                    continue

                _, changes = await self.db.execute_row(
                    "UPDATE users SET pair_id = ?, role = 'a', updated_at = ? "
                    "WHERE tg_id = ? AND pair_id IS NULL",
                    (pair_id, timestamp, tg_id),
                )
                if changes != 1:
                    # Не оставляем пару без владельца.
                    tx.rollback()
                    raise ValidationError("Не удалось создать пространство. Попробуйте ещё раз.")
                return code

            tx.rollback()
            raise ValidationError("Не удалось подобрать код приглашения. Попробуйте ещё раз.")

    async def join_pair(self, tg_id: int, display_name: str, code: object) -> bool:
        """Войти в пару по коду. Ровно один успешный вход даже при гонке."""
        normalized = normalize_code(code)
        if not normalized:
            return False

        timestamp = now()
        async with self.db.transaction() as tx:
            user = await self.db.one("SELECT pair_id FROM users WHERE tg_id = ?", (tg_id,))
            if user is None:
                tx.rollback()
                return False
            # Уже есть членство (в том числе пустая пара владельца) — вход запрещён,
            # иначе пользователь окажется в двух парах одновременно.
            if user["pair_id"] is not None:
                tx.rollback()
                return False

            pair = await self.db.one("SELECT * FROM pairs WHERE code = ?", (normalized,))
            if pair is None or pair["user_b"] or pair["user_a"] == tg_id:
                tx.rollback()
                return False

            _, pair_changes = await self.db.execute_row(
                "UPDATE pairs SET user_b = ?, name2 = ?, updated_at = ? "
                "WHERE id = ? AND user_b = 0",
                (tg_id, display_name, timestamp, pair["id"]),
            )
            if pair_changes != 1:
                tx.rollback()
                return False

            _, user_changes = await self.db.execute_row(
                "UPDATE users SET pair_id = ?, role = 'b', updated_at = ? "
                "WHERE tg_id = ? AND pair_id IS NULL",
                (pair["id"], timestamp, tg_id),
            )
            if user_changes != 1:
                # Пара уже получила user_b — откатываем, чтобы не оставить половинку.
                tx.rollback()
                return False

            return True

    # ------------------------------------------------------------------- планы

    async def add_task(self, pair_id: int, title: object, created_by: int) -> int:
        text = _clean_text(title, TASK_TITLE_MAX, "План")
        return await self.db.execute(
            "INSERT INTO tasks(pair_id, title, created_by, created_at) VALUES(?, ?, ?, ?)",
            (pair_id, text, created_by, now()),
        )

    async def tasks(self, pair_id: int, limit: int = 20, offset: int = 0):
        limit, offset = _page(limit, offset)
        return await self.db.query(
            "SELECT * FROM tasks WHERE pair_id = ? AND status = 'open' "
            "ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?",
            (pair_id, limit, offset),
        )

    async def complete_task(self, task_id: int, pair_id: int, user_id: int) -> bool:
        """Условное завершение: повторный тап не перезаписывает ``completed_by``."""
        _, changes = await self.db.execute_row(
            "UPDATE tasks SET status = 'done', completed_by = ?, completed_at = ? "
            "WHERE id = ? AND pair_id = ? AND status = 'open'",
            (user_id, now(), task_id, pair_id),
        )
        return changes == 1

    # -------------------------------------------------------------------- даты

    async def add_date(self, pair_id: int, title: object, day: object, recurs: int = 1) -> int:
        text = _clean_text(title, DATE_TITLE_MAX, "Дата")
        raw_day = _clean_text(day, 10, "Дата события")
        try:
            parsed = date.fromisoformat(raw_day)
        except ValueError as exc:
            raise ValidationError("Дата события: нужен формат ГГГГ-ММ-ДД.") from exc
        try:
            recurs_value = 1 if int(recurs or 0) else 0
        except (TypeError, ValueError) as exc:
            raise ValidationError("Признак ежегодной даты должен быть 0 или 1.") from exc
        return await self.db.execute(
            "INSERT INTO dates(pair_id, title, day, recurs, created_at) VALUES(?, ?, ?, ?, ?)",
            (pair_id, text, parsed.isoformat(), recurs_value, now()),
        )

    async def dates(self, pair_id: int, limit: int = 30, offset: int = 0):
        limit, offset = _page(limit, offset)
        return await self.db.query(
            "SELECT * FROM dates WHERE pair_id = ? ORDER BY day, id LIMIT ? OFFSET ?",
            (pair_id, limit, offset),
        )

    # ------------------------------------------------------------------ дневник

    async def add_memory(self, pair_id: int, author_id: int, body: object) -> int:
        text = _clean_text(body, MEMORY_MAX, "Запись")
        timestamp = now()
        return await self.db.execute(
            "INSERT INTO memories(pair_id, author_id, body, day, created_at) VALUES(?, ?, ?, ?, ?)",
            (pair_id, author_id, text, self.local_today().isoformat(), timestamp),
        )

    async def memories(self, pair_id: int, limit: int = 12, offset: int = 0):
        limit, offset = _page(limit, offset)
        return await self.db.query(
            "SELECT m.*, u.display_name FROM memories m LEFT JOIN users u ON u.tg_id = m.author_id "
            "WHERE m.pair_id = ? ORDER BY m.created_at DESC, m.id DESC LIMIT ? OFFSET ?",
            (pair_id, limit, offset),
        )

    # ------------------------------------------------------------------ вишлист

    async def add_wish(self, pair_id: int, owner_id: int, body: object) -> int:
        text = _clean_text(body, WISH_MAX, "Желание")
        return await self.db.execute(
            "INSERT INTO wishes(pair_id, owner_id, body, created_at) VALUES(?, ?, ?, ?)",
            (pair_id, owner_id, text, now()),
        )

    async def wishes(self, pair_id: int, limit: int = 20, offset: int = 0):
        limit, offset = _page(limit, offset)
        return await self.db.query(
            "SELECT w.*, u.display_name FROM wishes w LEFT JOIN users u ON u.tg_id = w.owner_id "
            "WHERE w.pair_id = ? AND w.done = 0 ORDER BY w.created_at DESC, w.id DESC "
            "LIMIT ? OFFSET ?",
            (pair_id, limit, offset),
        )

    async def complete_wish(self, wish_id: int, pair_id: int) -> bool:
        _, changes = await self.db.execute_row(
            "UPDATE wishes SET done = 1 WHERE id = ? AND pair_id = ? AND done = 0",
            (wish_id, pair_id),
        )
        return changes == 1

    # ------------------------------------------------------------------- ритуал

    def _daily_action(self, pair_id: int, day: str) -> str:
        seed = f"{pair_id}:{day}"
        return DAILY_ACTIONS[random.Random(seed).randrange(len(DAILY_ACTIONS))]

    async def daily(self, pair_id: int) -> dict[str, object]:
        today = self.local_today().isoformat()
        row = await self.db.one(
            "SELECT * FROM daily_rolls WHERE pair_id = ? AND day = ?", (pair_id, today)
        )
        if row:
            return {"action": row["daily_value"], "done": bool(row["done_by"]), "day": today}

        action = self._daily_action(pair_id, today)
        await self.db.execute(
            "INSERT INTO daily_rolls(pair_id, day, daily_kind, daily_value) "
            "VALUES(?, ?, 'moment', ?) ON CONFLICT(pair_id, day) DO NOTHING",
            (pair_id, today, action),
        )
        stored = await self.db.one(
            "SELECT daily_value FROM daily_rolls WHERE pair_id = ? AND day = ?", (pair_id, today)
        )
        return {
            "action": stored["daily_value"] if stored else action,
            "done": False,
            "day": today,
        }

    async def complete_daily(self, pair_id: int, user_id: int) -> bool:
        """Отметить ритуал ровно один раз и начислить XP в той же транзакции."""
        today_date = self.local_today()
        today = today_date.isoformat()
        action = self._daily_action(pair_id, today)
        timestamp = now()

        async with self.db.transaction() as tx:
            # Ритуал мог ещё не открываться — создаём детерминированную запись.
            await self.db.execute_row(
                "INSERT INTO daily_rolls(pair_id, day, daily_kind, daily_value) "
                "VALUES(?, ?, 'moment', ?) ON CONFLICT(pair_id, day) DO NOTHING",
                (pair_id, today, action),
            )

            _, changes = await self.db.execute_row(
                "UPDATE daily_rolls SET done_by = ?, done_at = ? "
                "WHERE pair_id = ? AND day = ? AND done_by IS NULL",
                (user_id, timestamp, pair_id, today),
            )
            if changes != 1:
                # Уже отмечено (второй тап или гонка) — ничего не начисляем.
                tx.rollback()
                return False

            user = await self.db.one("SELECT * FROM users WHERE tg_id = ?", (user_id,))
            if user is None:
                tx.rollback()
                return False

            streak = 1
            if user["last_activity"]:
                try:
                    previous = date.fromisoformat(str(user["last_activity"]))
                except ValueError:
                    previous = None
                if previous is not None:
                    if previous == today_date:
                        streak = max(1, int(user["streak"] or 0))
                    elif (today_date - previous).days == 1:
                        streak = int(user["streak"] or 0) + 1

            await self.db.execute_row(
                "UPDATE users SET points = points + ?, streak = ?, "
                "best_streak = MAX(best_streak, ?), last_activity = ?, updated_at = ? "
                "WHERE tg_id = ?",
                (DAILY_XP, streak, streak, today, timestamp, user_id),
            )
            await self.db.execute_row(
                "UPDATE pairs SET together_pts = together_pts + ?, updated_at = ? WHERE id = ?",
                (DAILY_XP, timestamp, pair_id),
            )
            return True
