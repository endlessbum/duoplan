from __future__ import annotations

import logging
import re
import secrets
import sqlite3
from collections.abc import Awaitable, Callable
from datetime import date
from datetime import datetime
from datetime import timedelta
from datetime import timezone
from datetime import tzinfo
from urllib.parse import urlsplit
from zoneinfo import ZoneInfo

from duoplan.db.base import Database
from duoplan.db.schema import now

log = logging.getLogger(__name__)

# Канонический список — tests/fixtures/daily_actions.json (источник истины
# worker.js): тексты и порядок обязаны совпадать с Mini App, иначе одна и та же
# пара видит разные формулировки на двух поверхностях.
DAILY_ACTIONS = (
    "Выделите 15 минут только друг для друга — без телефонов и дел",
    "Назовите друг другу три вещи, за которые вы благодарны этой неделе",
    "Запланируйте маленькое совместное удовольствие на ближайшие выходные",
    "Поделитесь воспоминанием, к которому хочется возвращаться",
    "Сделайте друг другу неожиданный комплимент — конкретный и честный",
    "Выберите общее дело и сделайте первый маленький шаг вместе",
    "Устройте мини-свидание: чай, прогулка или любимый фильм",
    "Отправьте партнёру пять эмодзи, которые описывают ваш день, — пусть угадает",
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


def _utf16_len(text: str) -> int:
    """Длина в UTF-16 единицах — так меряет validateSchema в worker.js.

    Заголовки планов и дат worker проверяет дважды: validateSchema по UTF-16
    и textField по кодпоинтам, эффективный лимит — UTF-16. Бот обязан применять
    тот же лимит, иначе запишет заголовок, который PATCH в приложении отклонит.
    """
    return sum(2 if ord(ch) > 0xFFFF else 1 for ch in text)


def _clean_text(value: object, limit: int, label: str, utf16: bool = False) -> str:
    if value is None:
        raise ValidationError(f"{label}: пришлите текст сообщением.")
    text = str(value).strip()
    if not text:
        raise ValidationError(f"{label}: текст не может быть пустым.")
    length = _utf16_len(text) if utf16 else len(text)
    if length > limit:
        raise ValidationError(f"{label}: не длиннее {limit} символов (сейчас {length}).")
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


def _time_parts(value: object, default: tuple[int, int] = (12, 0)) -> tuple[int, int]:
    """``"HH:MM"`` -> ``(часы, минуты)``; без корректного времени — дефолт.

    12:00 — для событий-дат и повторяющихся планов (worker.nextDateOccurrence /
    nextMonthlyOccurrenceMs); 23:59 — для обычного плана без времени
    (worker.taskTargetMs, worker.js:624)."""
    raw = "" if value is None else str(value)
    if len(raw) != 5 or raw.count(":") != 1:
        return default
    try:
        hours, minutes = int(raw[:2]), int(raw[3:])
    except ValueError:
        return default
    return (hours, minutes) if 0 <= hours <= 23 and 0 <= minutes <= 59 else default


def _zoned_local(year: int, month: int, day: int, hour: int, minute: int,
                 tz: tzinfo) -> datetime:
    """Локальное время в поясе с коррекцией DST-gap (parity с
    worker.makeDateInTimeZone): naive→aware; если round-trip через UTC
    сместил локальные поля — время не существовало (перевод часов вперёд) —
    пересчитываем через offset, действовавший за сутки до перехода."""
    naive = datetime(year, month, day, hour, minute)
    aware = naive.replace(tzinfo=tz)
    roundtrip = aware.astimezone(timezone.utc).astimezone(tz).replace(tzinfo=None)
    if roundtrip == naive:
        return aware
    pre_offset = (naive - timedelta(hours=24)).replace(tzinfo=tz).utcoffset() or timedelta(0)
    return (naive - pre_offset).replace(tzinfo=timezone.utc).astimezone(tz)


def _monthly_occurrence(day: object, time: object, tz: tzinfo) -> datetime | None:
    """Ближайшее ежемесячное наступление (worker.nextMonthlyOccurrenceMs):
    первый месяц, где такой день месяца существует и локальная дата не раньше
    сегодняшней. 31-е пропускает короткие месяцы, время без значения — 12:00."""
    parts = str(day or "").split("-")
    if len(parts) != 3:
        return None
    try:
        day_of_month = int(parts[2])
    except ValueError:
        return None
    if not 1 <= day_of_month <= 31:
        return None
    now_local = datetime.now(tz)
    today = now_local.date()
    for offset in range(25):
        month_index = now_local.month - 1 + offset
        year = now_local.year + month_index // 12
        month = month_index % 12 + 1
        try:
            hours, minutes = _time_parts(time)
            candidate = _zoned_local(year, month, day_of_month, hours, minutes, tz)
        except ValueError:
            continue
        if candidate.date() >= today:
            return candidate
    return None


def _yearly_occurrence(day: object, time: object, tz: tzinfo) -> datetime | None:
    """Ближайшее ежегодное наступление (worker.nextYearlyOccurrenceMs): тот же
    месяц-день в текущем или следующем году; 29 февраля пропускается."""
    parts = str(day or "").split("-")
    if len(parts) != 3:
        return None
    try:
        month, day_of_month = int(parts[1]), int(parts[2])
    except ValueError:
        return None
    now_local = datetime.now(tz)
    today = now_local.date()
    for offset in range(10):
        try:
            hours, minutes = _time_parts(time)
            candidate = _zoned_local(now_local.year + offset, month, day_of_month, hours, minutes, tz)
        except ValueError:
            continue
        if candidate.date() >= today:
            return candidate
    return None


def task_deadline(task: object, tz: tzinfo) -> float:
    """Ближайший дедлайн задачи в UTC-метках (worker.taskTargetMs).

    Повторяющийся план сортируется по ближайшему наступлению (worker.js:616–617),
    обычный — по дню со временем или 23:59; без корректного ``day`` возвращается
    ``inf`` — как ``Number.MAX_SAFE_INTEGER`` у worker'а, поэтому такие задачи
    после сортировки по дедлайну оказываются в конце.
    """
    if task is None:
        return float("inf")
    day = task["day"]
    if not day:
        return float("inf")
    if int(task["monthly"] or 0) == 1:
        occurrence = _monthly_occurrence(day, task["time"], tz)
        return occurrence.timestamp() if occurrence is not None else float("inf")
    if int(task["yearly"] or 0) == 1:
        occurrence = _yearly_occurrence(day, task["time"], tz)
        return occurrence.timestamp() if occurrence is not None else float("inf")
    parts = str(day).split("-")
    if len(parts) != 3:
        return float("inf")
    try:
        year, month, day_of_month = int(parts[0]), int(parts[1]), int(parts[2])
    except ValueError:
        return float("inf")
    hours, minutes = _time_parts(task["time"], default=(23, 59))
    try:
        return _zoned_local(year, month, day_of_month, hours, minutes, tz).timestamp()
    except ValueError:
        return float("inf")


def next_date_occurrence(
    day: object, recurs: object, time: object, tz: tzinfo, monthly: object = 0
) -> datetime | None:
    """Следующее наступление даты (worker.nextDateOccurrence).

    Ежемесячная — ближайший месяц, где день существует; у ежегодной — ближайший
    год из текущего..текущий+8, у разовой — сама дата. У «невозможной» даты
    возвращается ``None`` (worker — ``Number.MAX_SAFE_INTEGER``).
    """
    raw_day = day if day is not None else None
    if not raw_day:
        return None
    if int(monthly or 0) == 1:
        return _monthly_occurrence(raw_day, time, tz)
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
        monthly = int(row["monthly"] or 0) == 1
        occurrence = next_date_occurrence(row["day"], row["recurs"], row["time"], tz, monthly)
        occurrence_ts = occurrence.timestamp() if occurrence is not None else float("inf")
        # Дата — событие дня, а не момента (worker.isPastDate): не-ежегодная
        # запись прошедшая только когда прошёл её календарный день. Сравнение
        # по времени отправляло «сегодня» в прошедшие уже после полудня.
        # Ежемесячная — повторяющаяся: в «прошедшие» не попадает никогда.
        day_text = str(row["day"] or "")
        past = (
            not recurs
            and not monthly
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
    """Код приглашения: пробелы по краям срезаны, верхний регистр. Пустой -> ``""``.

    Внутренние пробелы НЕ вырезаются: worker коды с пробелами не принимает
    (паттерн 8 hex-символов), и склеенный здесь «AB CD EFGH» прошёл бы в боте,
    но был бы отклонён приложением. Выравниваем валидацию в сторону отказа —
    код с внутренними пробелами просто не найдётся.
    """
    if raw is None:
        return ""
    return str(raw).strip().upper()[:32]


class DuoPlanService:
    def __init__(self, db: Database, tz: tzinfo | None = None, tz_name: str = "") -> None:
        self.db = db
        self.tz: tzinfo = tz or timezone.utc
        # Имя пояса для новых пар: ZoneInfo.key у настроенной зоны, иначе UTC.
        self.tz_name = tz_name or getattr(self.tz, "key", "") or "UTC"
        # Кэш ZoneInfo по имени: pairs.timezone читается на каждую операцию.
        self._tz_cache: dict[str, tzinfo] = {}

    def _resolve_tz(self, name: object) -> tzinfo:
        """ZoneInfo по имени с откатом на пояс бота; кэширует по строке."""
        text = str(name or "").strip()
        if not text:
            return self.tz
        cached = self._tz_cache.get(text)
        if cached is not None:
            return cached
        try:
            resolved = ZoneInfo(text)
        except Exception:
            resolved = self.tz
        self._tz_cache[text] = resolved
        return resolved

    async def pair_tz(self, pair_id: int) -> tzinfo:
        """Часовой пояс конкретной пары (parity с pairs.timezone в worker.js)."""
        row = await self.db.one("SELECT timezone FROM pairs WHERE id = ?", (pair_id,))
        return self._resolve_tz(row["timezone"] if row else None)

    def today_for(self, tz_name: object, at: datetime | None = None) -> date:
        """«Сегодня» в поясе, заданном именем (pairs.timezone или fallback).

        Имя, совпадающее с поясом сервиса (или пустое), идёт через
        ``local_today`` — так сохраняется единая точка подмены «сегодня»
        в тестах и у вызовов без пары.
        """
        text = str(tz_name or "").strip()
        if not text or text == self.tz_name:
            return self.local_today(at)
        moment = at if at is not None else datetime.now(timezone.utc)
        if moment.tzinfo is None:
            moment = moment.replace(tzinfo=timezone.utc)
        return moment.astimezone(self._resolve_tz(text)).date()

    async def pair_today(self, pair_id: int, at: datetime | None = None) -> date:
        row = await self.db.one("SELECT timezone FROM pairs WHERE id = ?", (pair_id,))
        return self.today_for(row["timezone"] if row else None, at)

    # ------------------------------------------------------------------ время

    def local_today(self, at: datetime | None = None) -> date:
        """Локальная дата пары (по часовому поясу из настроек), а не дата сервера."""
        moment = at if at is not None else datetime.now(timezone.utc)
        if moment.tzinfo is None:
            moment = moment.replace(tzinfo=timezone.utc)
        return moment.astimezone(self.tz).date()

    async def _ensure_pair_open(self, pair_id: int) -> None:
        """Заморозка контента, пока партнёр не вернулся (parity worker.js 403).

        После выхода одного из пары (awaiting_return=1) мутации содержимого
        запрещены — остаётся только чтение и личные настройки.
        """
        row = await self.db.one("SELECT awaiting_return FROM pairs WHERE id = ?", (pair_id,))
        if row is not None and int(row["awaiting_return"] or 0) == 1:
            raise ValidationError(
                "Партнёр вышел из пространства — изменения будут доступны после его возвращения."
            )

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

    async def together_points(self, pair_id: int) -> int:
        """«Вместе XP»: сумма личных очков обоих партнёров.

        Отдельный счётчик pairs.together_pts больше не начисляется — общий
        запас всегда считается по факту, чтобы не расходиться с личными.
        """
        row = await self.db.one(
            "SELECT COALESCE(SUM(points), 0) AS total FROM users WHERE pair_id = ?",
            (pair_id,),
        )
        return int(row["total"] or 0)

    async def open_pair_for_code(self, code: object, tg_id: int | None = None):
        """Открытая пара по коду приглашения — для гейта приватного бота.

        Возвращает пару только если она ещё не завершилась (user_b = 0):
        наличие такой пары — это действенный код для входа. Зарезервированный
        код (партнёр вышел, awaiting_return=1) действителен только для его
        аккаунта (last_partner) — посторонний гейт не проходит и в users
        не регистрируется (parity webhook-гейта worker.js).
        """
        normalized = normalize_code(code)
        if not normalized:
            return None
        if tg_id is not None:
            return await self.db.one(
                "SELECT * FROM pairs WHERE code = ? AND user_b = 0 "
                "AND (awaiting_return = 0 OR last_partner = ?)",
                (normalized, tg_id),
            )
        return await self.db.one(
            "SELECT * FROM pairs WHERE code = ? AND user_b = 0 AND awaiting_return = 0",
            (normalized,),
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
                        "timezone, created_at, updated_at) VALUES(?, ?, '', ?, 0, ?, ?, ?, ?)",
                        (
                            code,
                            display_name,
                            tg_id,
                            self.local_today().isoformat(),
                            self.tz_name,
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
                # pair_members — источник членства в worker.js; без строки
                # таблица в SQLite оставалась бы пустой (parity с D1).
                await self.db.execute_row(
                    "INSERT INTO pair_members(tg_id, pair_id, role, joined_at) VALUES(?, ?, 'a', ?)",
                    (tg_id, pair_id, timestamp),
                )
                return code

            tx.rollback()
            raise ValidationError("Не удалось подобрать код приглашения. Попробуйте ещё раз.")

    async def join_pair(self, tg_id: int, display_name: str, code: object,
                        notify: Callable[[int, str], Awaitable[object]] | None = None) -> bool:
        """Войти в пару по коду. Ровно один успешный вход даже при гонке.

        ``notify(chat_id, text)`` вызывается после фиксации входа, если партнёр
        возвращался (``awaiting_return``): оставшемуся уходит уведомление —
        parity с joinPair в worker.js. Сбой уведомления вход не отменяет.
        """
        normalized = normalize_code(code)
        if not normalized:
            return False

        timestamp = now()
        was_awaiting = False
        owner_id = 0
        async with self.db.transaction() as tx:
            user = await self.db.one("SELECT pair_id FROM users WHERE tg_id = ?", (tg_id,))
            if user is None:
                tx.rollback()
                return False
            # Уже есть членство (в том числе пустая пара владельца) — вход запрещён,
            # иначе пользователь окажется в двух парах одновременно.
            if user["pair_id"] is not None:
                tx.rollback()
                raise ValidationError(
                    "Вы уже состоите в пространстве. Чтобы войти в другое, "
                    "сначала выйдите из текущего."
                )

            pair = await self.db.one("SELECT * FROM pairs WHERE code = ?", (normalized,))
            if pair is None:
                closed = await self.db.one("SELECT code FROM closed_codes WHERE code = ?", (normalized,))
                if closed is not None:
                    raise ValidationError(
                        "Это пространство закрыто: последний участник вышел. "
                        "Создайте новое или попросите новый код."
                    )
                tx.rollback()
                return False
            # Различимые причины, как в worker.joinPair: свой код и занятое
            # пространство — не «код недоступен», а точное объяснение.
            if pair["user_a"] == tg_id:
                tx.rollback()
                raise ValidationError("Это ваш собственный код — поделитесь им с партнёром.")
            if pair["user_b"]:
                tx.rollback()
                raise ValidationError("Это пространство уже соединено с партнёром.")

            # Резерв кода за ушедшим (parity с worker.js): пока партнёр не
            # вернулся, тот же код не открывает пространство другому аккаунту.
            if int(pair["awaiting_return"] or 0) == 1:
                reserved_for = int(pair["last_partner"] or 0)
                # Строгое сравнение, как в worker.joinPair (last_partner === tg_id):
                # last_partner=0 при awaiting_return=1 — повреждённое состояние,
                # и вход по нему отклоняем, а не пропускаем любого.
                if reserved_for != tg_id:
                    raise ValidationError(
                        "Это пространство ждёт возвращения прежнего партнёра — "
                        "войти по старому коду может только он."
                    )
                was_awaiting = True
                owner_id = int(pair["user_a"] or 0)

            _, pair_changes = await self.db.execute_row(
                "UPDATE pairs SET user_b = ?, name2 = ?, awaiting_return = 0, "
                "last_partner = 0, updated_at = ? WHERE id = ? AND user_b = 0",
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
            # Источник членства parity с worker.js: без этой строки
            # pair_members в SQLite оставалась бы пустой.
            await self.db.execute_row(
                "INSERT INTO pair_members(tg_id, pair_id, role, joined_at) VALUES(?, ?, 'b', ?)",
                (tg_id, pair["id"], timestamp),
            )

        # Уведомление после фиксации транзакции: сбой Telegram вход не отменяет.
        if was_awaiting and owner_id and notify is not None:
            try:
                await notify(
                    owner_id,
                    "«" + (display_name or "Партнёр") + "» снова в вашем пространстве.\n\n"
                    "Общие планы, даты и воспоминания на месте — можно продолжать.",
                )
            except Exception:
                log.info("join_pair: не удалось уведомить владельца %s", owner_id)
        return True

    async def leave_pair(self, tg_id: int,
                         notify: Callable[[int, str], Awaitable[object]] | None = None) -> bool:
        """Выйти из пространства. Владелец передаёт его партнёру — parity worker.js.

        Пространство без второго участника удаляется целиком. При выходе одного
        из пары контент остаётся, код резервируется за ушедшим
        (``awaiting_return=1``, ``last_partner``), а оставшемуся уходит
        уведомление (``notify``); сбой уведомления сам выход не отменяет.
        """
        member = await self.membership(tg_id)
        if member is None:
            return False
        # Роли в pairs нет: users.role — собственная роль пользователя.
        user = await self.db.one("SELECT display_name, role FROM users WHERE tg_id = ?", (tg_id,))
        role = user["role"] if user else "a"
        leaver_name = ((user["display_name"] if user else "")
                       or (member["name2"] if role == "b" else member["name1"])
                       or "Партнёр")
        partner_id = int((member["user_b"] if role == "a" else member["user_a"]) or 0)
        timestamp = now()
        async with self.db.transaction() as tx:
            if not partner_id:
                # Последний держатель: данные пары удаляются полностью.
                # movie_ratings/savings_deposits не несут pair_id — дети
                # movies/savings, удаляются по подзапросу (parity CASCADE в worker).
                for table in ("tasks", "dates", "memories", "wishes", "daily_rolls",
                              "daily_completions", "quotes", "places", "trips",
                              "goal_items", "goals", "movies", "savings", "pair_members"):
                    await self.db.execute_row(f"DELETE FROM {table} WHERE pair_id = ?", (member["id"],))
                await self.db.execute_row(
                    "DELETE FROM movie_ratings WHERE movie_id IN (SELECT id FROM movies WHERE pair_id = ?)",
                    (member["id"],),
                )
                await self.db.execute_row(
                    "DELETE FROM savings_deposits WHERE saving_id IN (SELECT id FROM savings WHERE pair_id = ?)",
                    (member["id"],),
                )
                # Код остаётся в closed_codes: вход по нему скажет «пространство
                # закрыто», а не «код не найден» (parity worker.js).
                await self.db.execute_row(
                    "INSERT OR IGNORE INTO closed_codes(code, closed_at) VALUES(?, ?)",
                    (str(member["code"]).upper(), timestamp),
                )
                await self.db.execute_row("DELETE FROM pairs WHERE id = ?", (member["id"],))
            elif role == "a":
                await self.db.execute_row(
                    "DELETE FROM pair_members WHERE tg_id = ? AND pair_id = ?",
                    (tg_id, member["id"]),
                )
                await self.db.execute_row(
                    "UPDATE pairs SET user_a = user_b, "
                    "name1 = (SELECT display_name FROM users WHERE tg_id = ?), "
                    "user_b = 0, name2 = '', awaiting_return = 1, last_partner = ?, "
                    "updated_at = ? WHERE id = ?",
                    (partner_id, tg_id, timestamp, member["id"]),
                )
                await self.db.execute_row(
                    "UPDATE pair_members SET role = 'a' WHERE tg_id = ? AND pair_id = ?",
                    (partner_id, member["id"]),
                )
                # Личное имя оставшегося относилось к ушедшему — сбрасываем.
                await self.db.execute_row(
                    "UPDATE users SET role = 'a', partner_custom_name = NULL, updated_at = ? WHERE tg_id = ?",
                    (timestamp, partner_id),
                )
            else:
                await self.db.execute_row(
                    "UPDATE pairs SET user_b = 0, name2 = '', awaiting_return = 1, "
                    "last_partner = ?, updated_at = ? WHERE id = ?",
                    (tg_id, timestamp, member["id"]),
                )
                await self.db.execute_row(
                    "DELETE FROM pair_members WHERE tg_id = ? AND pair_id = ?",
                    (tg_id, member["id"]),
                )
                await self.db.execute_row(
                    "UPDATE users SET partner_custom_name = NULL, updated_at = ? WHERE tg_id = ?",
                    (timestamp, partner_id),
                )
            await self.db.execute_row(
                "UPDATE users SET pair_id = NULL, role = 'a', partner_custom_name = NULL, updated_at = ? WHERE tg_id = ?",
                (timestamp, tg_id),
            )
        if partner_id and notify is not None:
            try:
                await notify(
                    partner_id,
                    leaver_name + " больше не в вашем пространстве.\n\n"
                    "Общие планы, даты и воспоминания остались у вас. "
                    "Чтобы позвать партнёра снова, отправьте ему код приглашения.",
                )
            except Exception:
                log.info("leave_pair: не удалось уведомить партнёра %s", partner_id)
        return True

    # ------------------------------------------------------------------- планы

    async def add_task(self, pair_id: int, title: object, created_by: int) -> int:
        await self._ensure_pair_open(pair_id)
        text = _clean_text(title, TASK_TITLE_MAX, "План", utf16=True)
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
        # Без SQL LIMIT осознанно: сортировка по дедлайнам (sort_task_rows)
        # считается по всему набору в Python — срез до сортировки дал бы
        # произвольные, а не ближайшие строки страницы. У memories (created_at
        # DESC) лимит уходит в SQL, здесь порядок вычисляемый.
        rows = await self.db.query(
            "SELECT * FROM tasks WHERE pair_id = ? AND status = 'open'"
            f"{private_clause}",
            params,
        )
        sorted_rows = sort_task_rows(rows, await self.pair_tz(pair_id))
        return sorted_rows[offset : offset + limit]

    async def complete_task(self, task_id: int, pair_id: int, user_id: int) -> bool:
        """Условное завершение: повторный тап не перезаписывает ``completed_by``."""
        await self._ensure_pair_open(pair_id)
        _, changes = await self.db.execute_row(
            "UPDATE tasks SET status = 'done', completed_by = ?, completed_at = ? "
            "WHERE id = ? AND pair_id = ? AND status = 'open' "
            "AND (is_private = 0 OR created_by = ?)",
            (user_id, now(), task_id, pair_id, user_id),
        )
        return changes == 1

    # -------------------------------------------------------------------- даты

    async def add_date(self, pair_id: int, title: object, day: object, recurs: int = 1, created_by: int = 0) -> int:
        await self._ensure_pair_open(pair_id)
        text = _clean_text(title, DATE_TITLE_MAX, "Дата", utf16=True)
        raw_day = _clean_text(day, 10, "Дата события")
        try:
            parsed = date.fromisoformat(raw_day)
        except ValueError as exc:
            raise ValidationError("Дата события: нужен формат ГГГГ-ММ-ДД.") from exc
        try:
            recurs_value = 1 if int(recurs or 0) else 0
        except (TypeError, ValueError) as exc:
            raise ValidationError("Признак ежегодной даты должен быть 0 или 1.") from exc
        # created_by обязателен: без него дата навсегда остаётся created_by=0 —
        # ни приватность в приложении (PATCH меняет is_private только автору),
        # ни авторство, ни экспорт «только мои» её не привяжут ни к кому.
        return await self.db.execute(
            "INSERT INTO dates(pair_id, title, day, recurs, created_by, created_at) VALUES(?, ?, ?, ?, ?, ?)",
            (pair_id, text, parsed.isoformat(), recurs_value, created_by, now()),
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
        # Без SQL LIMIT — та же причина, что в tasks(): порядок страниц
        # вычисляет sort_date_rows по всему набору.
        sorted_rows = sort_date_rows(rows, await self.pair_tz(pair_id))
        return sorted_rows[offset : offset + limit]

    # ------------------------------------------------------------------ дневник

    async def add_memory(self, pair_id: int, author_id: int, body: object) -> int:
        await self._ensure_pair_open(pair_id)
        text = _clean_text(body, MEMORY_MAX, "Запись")
        timestamp = now()
        return await self.db.execute(
            "INSERT INTO memories(pair_id, author_id, body, day, created_at) VALUES(?, ?, ?, ?, ?)",
            (pair_id, author_id, text, (await self.pair_today(pair_id)).isoformat(), timestamp),
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
        await self._ensure_pair_open(pair_id)
        text = _clean_text(body, WISH_MAX, "Желание")
        link = _clean_optional_text(url, WISH_URL_MAX, "Ссылка")
        # Схему проверяет и worker (wishUrl, worker.js:144–158): new URL плюс
        # http(s). Голого startswith("http://") мало — «http://» без хоста бот
        # записал бы, а приложение потом не смогло бы ни открыть, ни
        # отредактировать такое желание (PATCH упал бы с INVALID_URL).
        # Пробелы запрещены явно: urlsplit их прощает в netloc, WHATWG URL — нет.
        if link:
            try:
                parts = urlsplit(link)
            except ValueError as exc:
                # Часть malformed-вводов (битый IPv6-литерал и т.п.) роняет
                # urlsplit исключением — для пользователя это невалидная
                # ссылка, а не сбой обработчика.
                raise ValidationError("Ссылка: только корректные адреса http или https") from exc
            if (
                parts.scheme not in ("http", "https")
                or not parts.netloc
                or re.search(r"\s", link)
            ):
                raise ValidationError("Ссылка: только корректные адреса http или https")
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
        await self._ensure_pair_open(pair_id)
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
        today = (await self.pair_today(pair_id)).isoformat()
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
        await self._ensure_pair_open(pair_id)
        today_date = await self.pair_today(pair_id)
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
            # Отдельного счётчика у пары больше нет: «Вместе XP» — это сумма
            # личных XP обоих партнёров (суммируется на вывод), поэтому здесь
            # меняется только личный счётчик отметившего.
            return True
