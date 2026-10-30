"""Конфигурация бота: читается из переменных окружения и файла ``.env`` рядом с проектом.

Секретов в коде нет — токен берётся только из окружения.
Формат ``.env``: строки ``KEY=value``, ``#`` — комментарий, кавычки опциональны.
Комментарий после значения в кавычках тоже поддерживается: ``TZ="Europe/Moscow" # зона``.
Уже выставленные переменные окружения приоритетнее значений из файла.
"""

from __future__ import annotations

import logging
import os
from dataclasses import dataclass
from dataclasses import field
from datetime import timezone
from datetime import tzinfo
from pathlib import Path
from zoneinfo import ZoneInfo
from zoneinfo import ZoneInfoNotFoundError

PROJECT_ROOT = Path(__file__).resolve().parent.parent
DEFAULT_ENV_FILE = PROJECT_ROOT / ".env"
DEFAULT_TZ = "Europe/Moscow"
DEFAULT_FSM_TTL = 7 * 24 * 60 * 60

log = logging.getLogger(__name__)


BOT_USERNAME = "duoplanbot"  # Telegram username без @, например duoplanbot, задается в .env


def parse_env_file(text: str) -> dict[str, str]:
    """Разобрать содержимое ``.env``. Мусорные строки молча пропускаются."""
    values: dict[str, str] = {}
    for raw_line in text.splitlines():
        line = raw_line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, _, value = line.partition("=")
        key = key.strip()
        if key.startswith("export "):
            key = key[len("export "):].strip()
        if not key:
            continue
        value = value.strip()
        if value[:1] in {"'", '"'}:
            quote = value[0]
            end = value.find(quote, 1)
            # Значение в кавычках: всё после закрывающей кавычки — комментарий.
            value = value[1:end] if end != -1 else value[1:]
        else:
            for marker in (" #", "\t#"):
                if marker in value:
                    value = value.split(marker, 1)[0]
            value = value.strip()
        values[key] = value
    return values


def resolve_timezone(name: str) -> tuple[tzinfo, str]:
    """Вернуть (зона, фактическое имя). Невалидное имя не подменяется молча."""
    for candidate in (name, DEFAULT_TZ):
        if not candidate:
            continue
        try:
            return ZoneInfo(candidate), candidate
        except (ZoneInfoNotFoundError, ValueError):
            log.warning("Неизвестный часовой пояс %r, пробую %r", candidate, DEFAULT_TZ)
    log.warning("Часовой пояс недоступен, использую UTC")
    return timezone.utc, "UTC"


def _parse_ttl(raw: str) -> int:
    try:
        return max(0, int(raw))
    except (TypeError, ValueError):
        return DEFAULT_FSM_TTL


@dataclass(slots=True)
class Settings:
    bot_token: str
    admin_chat_id: int | None
    db_path: Path
    bot_name: str
    bot_username: str  # Telegram username без @, для ссылок в Mini App
    tz_name: str
    tz: tzinfo = field(default=timezone.utc)
    # Добавлено в конец, чтобы не сдвигать позиционные аргументы старого API.
    fsm_ttl: int = DEFAULT_FSM_TTL

    @property
    def is_configured(self) -> bool:
        return bool(self.bot_token)


def load_settings(env_file: Path | str | None = None) -> Settings:
    path = Path(env_file) if env_file is not None else DEFAULT_ENV_FILE
    file_values: dict[str, str] = {}
    if path.is_file():
        file_values = parse_env_file(path.read_text(encoding="utf-8", errors="replace"))

    def get(key: str, default: str = "") -> str:
        return os.environ.get(key, file_values.get(key, default)).strip()

    raw_chat = get("ADMIN_CHAT_ID")
    admin_chat_id: int | None = None
    if raw_chat.lstrip("-").isdigit():
        admin_chat_id = int(raw_chat)

    bot_username = get("BOT_USERNAME", "duoplanbot")

    db_raw = get("DB_PATH", str(PROJECT_ROOT / "data" / "duoplan.db"))
    db_path = Path(db_raw)
    if not db_path.is_absolute():
        db_path = PROJECT_ROOT / db_path

    tz, tz_name = resolve_timezone(get("TZ", DEFAULT_TZ) or DEFAULT_TZ)
    return Settings(
        bot_token=get("BOT_TOKEN"),
        admin_chat_id=admin_chat_id,
        db_path=db_path,
        bot_name=get("BOT_NAME", "DuoPlan") or "DuoPlan",
        bot_username=bot_username,
        tz_name=tz_name,
        fsm_ttl=_parse_ttl(get("FSM_TTL", str(DEFAULT_FSM_TTL))),
        tz=tz,
    )
