from __future__ import annotations

import re
import secrets
import sqlite3
from datetime import date
from datetime import datetime
from datetime import timezone
from datetime import tzinfo

from duoplan.db.base import Database
from duoplan.db.schema import now

# Канонический список — tests/fixtures/daily_actions.json (источник истины
# worker.js): тексты и порядок обязаны совпадать с Mini App, иначе одна и та же
# пара видит разные формулировки на двух поверхностях.
DAILY_ACTIONS = (
    "Выделите 15 минут только друг для друга — без телефонов и дел.",
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
WISH_URL_MAX = 2048

DAILY_XP = 10

_DAY_RE = re.compile(r"^\d{4}-\d{2}-\d{2}$")

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


def _clean_optional_text(value: object, limit: int, label: str) -> str:
    text = "" if value is None else str(value).strip()
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


# Стабильный солвер ключей сортировки (worker: byRowId — сравнивает как строки).
def _sort_key(value: object) -> object:
    return value if isinstance(value, (int, float)) else str(value)


MAX_DATE_TIME = datetime.max.replace(tzinfo=timezone.utc)


def _time_parts(value: object) -> tuple[int, int]:
    """``"HH:MM"`` -> ``(часы, минуты)``; иначе дефолт для даты — 12:00."""
    raw = "" if value is None else str(value)
    if len(raw) != 5 or raw.count(":") != 1:
        return 12, 0
    try:
        return int(raw[:2]), int(raw[3:])
    except ValueError:
        return 12, 0


def task_deadline(task: object, tz: tzinfo) -> float:
    """Ближайший дедлайн задачи в UTC-метках (worker.taskTargetMs).

    ``day`` + ``time`` задачи в часовом поясе пары; без корректного ``day``
    возвращается ``inf`` — как ``Number.MAX_SAFE_INTEGER`` у worker'а, поэтому
    такие задачи после сортировки по дедлайну оказываются в конце.
    """
    day = task["day"] if task is not None else None
    if not day:
        return float("inf")
    parts = str(day).split("-")
    if len(parts) != 3:
        return float("inf")
    try:
        year, month, day_of_month = int(parts[0]), int(parts[1]), int(parts[2])
    except ValueError:
        return float("inf")
    hours, minutes = _time_parts(task["time"] if task is not None else None)
    try:
        return datetime(year, month, day_of_month, hours, minutes, tzinfo=tz).timestamp()
    except ValueError:
        return float("inf")


def next_date_occurrence(day: object, recurs: object, time: object, tz: tzinfo) -> datetime | None:
    """Следующее наступление даты (worker.nextDateOccurrence).

    У ежегодной даты — ближайший год из текущего..текущий+8, у разовой — сама
    дата. У «невозможной» даты возвращается ``None`` (worker — ``Number.MAX_SAFE_INTEGER``).
    """
    raw_day = day if day is not None else None
    if not raw_day:
        return None
    parts = str(raw_day).split("-")
    if len(parts) != 3:
        return None
    try:
        year, month, day_of_month = int(parts[0]), int(parts[1]), int(parts[2])
        first = datetime(year, month, day_of_month, *_time_parts(time))
        first = first.replace(tzinfo=tz)
    except ValueError:
        return None
    if int(recurs or 0) == 0:
        return first
    today = datetime.now(tz).date()
    for offset in range(9):
        candidate_year = today.year + offset
        try:
            candidate = datetime(candidate_year, month, day_of_month, *_time_parts(time)).replace(tzinfo=tz)
        except ValueError:
            continue
        if candidate.date() >= today:
            return candidate
    return None


def sort_task_rows(rows: list[object], tz: tzinfo) -> list[object]:
    """Сортировка планов по дедлайну (worker.sortByTaskDeadline): ближайший
    дедлайн раньше, равные ключи — по id."""
    decorated = sorted(
        ((task_deadline(row, tz), row) for row in rows),
        key=lambda item: (item[0], _sort_key(item[1]["id"])),
    )
    return [row for _, row in decorated]


def sort_date_rows(rows: list[object], tz: tzinfo) -> list[object]:
    """Сортировка дат для списка (worker.sortDateRows): будущие — по ближайшему
    наступлению, затем прошедшие не-ежегодные от свежих к старым. Ежегодные
    всегда попадают в будущую группу со своим следующим наступлением, поэтому
    «одна и та же дата в году на несколько лет вперёд» не спамит — каждая запись
    держит ровно одно следующее наступление."""
    now_local = datetime.now(tz)
    today = now_local.date().isoformat()
    decorated: list[tuple[bool, float, object, object]] = []
    for row in rows:
        recurs = int(row["recurs"] or 0) == 1
        occurrence = next_date_occurrence(row["day"], row["recurs"], row["time"], tz)
        occurrence_ts = occurrence.timestamp() if occurrence is not None else float("inf")
        # Дата — событие дня, а не момента (worker.isPastDate): не-ежегодная
        # запись прошедшая только когда прошёл её календарный день. Сравнение
        # по времени отправляло «сегодня» в прошедшие уже после полудня.
        day_text = str(row["day"] or "")
        past = (
            not recurs
            and bool(_DAY_RE.match(day_text))
            and day_text < today
        )
        # В будущей группе — по возрастанию наступления (ближайшее раньше);
        # в прошедшей (не ежегодной) — от свежих к старым, т.е. убывание.
        sort_ts = -occurrence_ts if past else occurrence_ts
        decorated.append((past, sort_ts, _sort_key(row["id"]), row))
    decorated.sort(key=lambda item: (item[0], item[1], item[2]))
    return [item[3] for item in decorated]


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

    async def tasks(self, pair_id: int, limit: int = 20, offset: int = 0, viewer_id: int | None = None):
        limit, offset = _page(limit, offset)
        # Личный план (is_private=1) видит только автор — иначе партнёр прочитал
        # бы сюрприз прямо в списке бота.
        private_clause = " AND (is_private = 0 OR created_by = ?)" if viewer_id is not None else ""
        params: tuple = (pair_id, viewer_id) if viewer_id is not None else (pair_id,)
        rows = await self.db.query(
            "SELECT * FROM tasks WHERE pair_id = ? AND status = 'open'"
            f"{private_clause}",
            params,
        )
        sorted_rows = sort_task_rows(rows, self.tz)
        return sorted_rows[offset : offset + limit]

    async def complete_task(self, task_id: int, pair_id: int, user_id: int) -> bool:
        """Условное завершение: повторный тап не перезаписывает ``completed_by``."""
        _, changes = await self.db.execute_row(
            "UPDATE tasks SET status = 'done', completed_by = ?, completed_at = ? "
            "WHERE id = ? AND pair_id = ? AND status = 'open' "
            "AND (is_private = 0 OR created_by = ?)",
            (user_id, now(), task_id, pair_id, user_id),
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

    async def dates(self, pair_id: int, limit: int = 30, offset: int = 0, viewer_id: int | None = None):
        limit, offset = _page(limit, offset)
        # Личная дата — зеркально личному плану: чужая не попадает в список.
        private_clause = " AND (is_private = 0 OR created_by = ?)" if viewer_id is not None else ""
        params: tuple = (pair_id, viewer_id) if viewer_id is not None else (pair_id,)
        rows = await self.db.query(
            f"SELECT * FROM dates WHERE pair_id = ?{private_clause}",
            params,
        )
        sorted_rows = sort_date_rows(rows, self.tz)
        return sorted_rows[offset : offset + limit]

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

    async def add_wish(self, pair_id: int, owner_id: int, body: object, url: object = "") -> int:
        text = _clean_text(body, WISH_MAX, "Желание")
        link = _clean_optional_text(url, WISH_URL_MAX, "Ссылка") if url is not None else ""
        return await self.db.execute(
            "INSERT INTO wishes(pair_id, owner_id, body, url, created_at) VALUES(?, ?, ?, ?, ?)",
            (pair_id, owner_id, text, link, now()),
        )

    async def wishes(self, pair_id: int, limit: int = 20, offset: int = 0):
        limit, offset = _page(limit, offset)
        return await self.db.query(
            "SELECT w.*, u.display_name FROM wishes w LEFT JOIN users u ON u.tg_id = w.owner_id "
            "WHERE w.pair_id = ? AND w.done = 0 ORDER BY w.created_at DESC, w.id DESC "
            "LIMIT ? OFFSET ?",
            (pair_id, limit, offset),
        )

    async def complete_wish(self, wish_id: int, pair_id: int, owner_id: int) -> bool:
        _, changes = await self.db.execute_row(
            # done_at нужен календарю Mini App: звезда ставится в день вручения.
            # Закрытие — личное дело каждого: только владелец желания закрывает
            # его, UPDATE проверяет owner_id, иначе партнёр мог бы «исполнить»
            # чужое желание вместо своего.
            "UPDATE wishes SET done = 1, done_at = ? WHERE id = ? AND pair_id = ? AND owner_id = ? AND done = 0",
            (now(), wish_id, pair_id, owner_id),
        )
        return changes == 1

    # ------------------------------------------------------------------- ритуал

    def _daily_action(self, pair_id: int, day: str) -> str:
        """Действие дня — та же функция, что ``dailyAction()`` в ``worker.js``.

        Детерминированный полиномиальный хеш по строке ``pair:day`` (база 31,
        переполнение по 32 битам) вместо ``random.Random(seed)``: Mersenne
        Twister в Python и хеш в Worker давали разные задания одной и той же
        паре в один день, поэтому бот и Mini App расходились. Строка всегда
        ASCII (число и ISO-дата), так что ``ord()`` и ``charCodeAt()`` совпадают.
        """
        seed = 0
        for char in f"{pair_id}:{day}":
            seed = (seed * 31 + ord(char)) & 0xFFFFFFFF
        return DAILY_ACTIONS[seed % len(DAILY_ACTIONS)]

    async def daily(self, pair_id: int, user_id: int) -> dict[str, object]:
        """Ритуал дня с отметкой конкретного пользователя.

        ``done`` — отметил ли ритуал именно этот пользователь, ``partner_done`` —
        второй участник. Раньше ``done`` считался по паре (``COUNT(*) > 0``),
        поэтому после отметки одного партнёра у второго пропадала кнопка
        «Мы это сделали»: он видел «уже отмечено» и не мог забрать свои XP,
        хотя ``complete_daily()`` начисляет их каждому. Та же семантика, что
        ``dailyFor(..., userId)`` в worker.js: done/partnerDone на пользователя.
        """
        today = self.local_today().isoformat()
        row = await self.db.one(
            "SELECT * FROM daily_rolls WHERE pair_id = ? AND day = ?", (pair_id, today)
        )
        if not row:
            action = self._daily_action(pair_id, today)
            await self.db.execute(
                "INSERT INTO daily_rolls(pair_id, day, daily_value) "
                "VALUES(?, ?, ?) ON CONFLICT(pair_id, day) DO NOTHING",
                (pair_id, today, action),
            )
            row = await self.db.one(
                "SELECT * FROM daily_rolls WHERE pair_id = ? AND day = ?", (pair_id, today)
            )
        completed = await self.db.query(
            "SELECT tg_id FROM daily_completions WHERE pair_id = ? AND day = ?",
            (pair_id, today),
        )
        completed_by = {int(record["tg_id"]) for record in completed}
        me = int(user_id)
        return {
            "action": (row["daily_value"] if row else None),
            "day": today,
            "done": me in completed_by,
            "partner_done": bool(completed_by - {me}),
            "completed_count": len(completed_by),
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
                "INSERT INTO daily_rolls(pair_id, day, daily_value) "
                "VALUES(?, ?, ?) ON CONFLICT(pair_id, day) DO NOTHING",
                (pair_id, today, action),
            )

            # Каждый партнёр отмечает ритуал сам: daily_completions хранит
            # факты отметок, поэтому второй участник тоже может получить XP.
            _, changes = await self.db.execute_row(
                "INSERT INTO daily_completions(pair_id, tg_id, day, completed_at) "
                "VALUES(?, ?, ?, ?) ON CONFLICT(pair_id, tg_id, day) DO NOTHING",
                (pair_id, user_id, today, timestamp),
            )
            if changes != 1:
                # Уже отмечено этим пользователем — повтор ничего не начисляет.
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
