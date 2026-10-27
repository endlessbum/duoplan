"""Конфигурация бота: читается из переменных окружения и файла ``.env`` рядом с проектом.

Секретов в коде нет — токен и список админов берутся только из окружения.
Формат ``.env``: строки ``KEY=value``, ``#`` — комментарий, кавычки опциональны.
Уже выставленные переменные окружения приоритетнее значений из файла.
"""

from __future__ import annotations

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
        if len(value) >= 2 and value[0] == value[-1] and value[0] in {"'", '"'}:
            value = value[1:-1]
        else:
            value = value.split(" #", 1)[0].strip()
        values[key] = value
    return values


def parse_admin_ids(raw: str) -> frozenset[int]:
    """``"1, 2 3"`` -> ``{1, 2, 3}``. Нечисловые токены игнорируются."""
    ids: set[int] = set()
    for token in raw.replace(";", ",").replace(",", " ").split():
        if token.lstrip("-").isdigit():
            ids.add(int(token))
    return frozenset(ids)


def load_timezone(name: str) -> tzinfo:
    try:
        return ZoneInfo(name)
    except (ZoneInfoNotFoundError, ValueError):
        return timezone.utc


@dataclass(slots=True)
class Settings:
    bot_token: str
    admin_ids: frozenset[int]
    admin_chat_id: int | None
    db_path: Path
    bot_name: str
    tz_name: str
    tz: tzinfo = field(default=timezone.utc)

    @property
    def is_configured(self) -> bool:
        return bool(self.bot_token)

    def is_admin(self, user_id: int | None) -> bool:
        return user_id is not None and user_id in self.admin_ids


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

    db_raw = get("DB_PATH", str(PROJECT_ROOT / "data" / "duoplan.db"))
    db_path = Path(db_raw)
    if not db_path.is_absolute():
        db_path = PROJECT_ROOT / db_path

    tz_name = get("TZ", DEFAULT_TZ) or DEFAULT_TZ
    return Settings(
        bot_token=get("BOT_TOKEN"),
        admin_ids=parse_admin_ids(get("ADMIN_IDS")),
        admin_chat_id=admin_chat_id,
        db_path=db_path,
        bot_name=get("BOT_NAME", "DuoPlan") or "DuoPlan",
        tz_name=tz_name,
        tz=load_timezone(tz_name),
    )
