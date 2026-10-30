"""Экспорт локальной SQLite DuoPlan в SQL для Cloudflare D1.

Скрипт ничего не удаляет и не отправляет в сеть. Он создаёт файл с
``INSERT OR REPLACE`` и служебными строками ``pair_members``, который можно
применить командой:

    wrangler d1 execute duoplan --remote --file data/duoplan-d1-import.sql

Перед импортом сделайте резервную копию D1.
"""

from __future__ import annotations

import argparse
import sqlite3
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parent.parent

# Список колонок обязан совпадать с текущей схемой: если колонки нет в списке,
# она не попадает в INSERT, и D1 подставит DEFAULT. Для is_private это означало
# бы, что личные планы и даты после переноса становятся общими (миграции
# 0007-0011 добавляли их уже после того, как список был написан).
TABLES = {
    "pairs": (
        "id, code, name1, name2, user_a, user_b, started_at, together_pts, timezone, "
        "created_at, updated_at"
    ),
    "users": (
        "tg_id, username, display_name, role, gender, pair_id, points, streak, "
        "last_activity, best_streak, timezone, digest_time, digest_enabled, "
        "dates_digest_time, dates_digest_enabled, accent_color, created_at, updated_at"
    ),
    "tasks": (
        "id, pair_id, title, status, day, time, is_private, created_by, created_at, "
        "completed_by, completed_at"
    ),
    "dates": "id, pair_id, title, day, time, recurs, is_private, created_by, created_at",
    "memories": "id, pair_id, author_id, body, day, created_at",
    "wishes": "id, pair_id, owner_id, body, done, done_at, url, created_at",
    "daily_rolls": "pair_id, day, daily_value",
    "daily_completions": "pair_id, tg_id, day, completed_at",
}

# Колонки, которые в схеме D1 объявлены NOT NULL с DEFAULT. Если в исходной
# SQLite колонки нет или значение NULL, вместо NULL подставляется DEFAULT,
# иначе INSERT нарушит ограничение NOT NULL при импорте.
NOT_NULL_FALLBACKS = {
    "timezone": "'Europe/Moscow'",
    # NOT NULL DEFAULT 0/1 в D1: NULL из старой базы нарушил бы ограничение,
    # а для is_private ещё и молча раскрыл бы личную запись партнёру.
    "is_private": "0",
    "created_by": "0",
    "digest_enabled": "1",
    "dates_digest_enabled": "1",
}


def quote(value: object) -> str:
    if value is None:
        return "NULL"
    # bool перед int, т.к. bool — подкласс int
    if isinstance(value, bool):
        return "1" if value else "0"
    if isinstance(value, float):
        import math

        if math.isnan(value):
            return "NULL"  # NaN невалиден в SQL
        return str(value)
    if isinstance(value, int):
        return str(value)
    if isinstance(value, bytes):
        # BLOB в SQLite сохраняем как hex-литерал
        return "X'" + value.hex() + "'"
    return "'" + str(value).replace("'", "''") + "'"


def table_columns(db: sqlite3.Connection, table: str) -> set[str]:
    try:
        rows = db.execute(f"PRAGMA table_info({table})").fetchall()
    except sqlite3.Error as exc:
        raise RuntimeError(f"Не удалось прочитать структуру таблицы {table}: {exc}") from exc
    return {str(row["name"]) for row in rows}


def build_select(db: sqlite3.Connection, table: str, columns: str) -> tuple[str, list[str], bool]:
    """Возвращает (SELECT выражение, список колонок, есть_ли_таблица)."""
    actual = table_columns(db, table)
    if not actual:
        return "", [], False
    names = [part.strip() for part in columns.split(",") if part.strip()]
    expressions = []
    for name in names:
        fallback = NOT_NULL_FALLBACKS.get(name)
        if name in actual and fallback is None:
            expressions.append(name)
        elif name in actual:
            expressions.append(f"COALESCE({name}, {fallback}) AS {name}")
        elif fallback is not None:
            expressions.append(f"{fallback} AS {name}")
        else:
            expressions.append(f"NULL AS {name}")
    return ", ".join(expressions), names, True


def dump(source: Path) -> str:
    # Экранируем путь для SQLite URI: пробелы, ?, #, % и кириллица
    # превращаются в %XX. Импортируем под своим именем: голый `quote` затенял
    # модульную функцию SQL-квотирования и ронял dump() на первом же значении.
    from urllib.parse import quote as urlquote

    resolved = Path(source).resolve()
    # Windows: C:\path -> /c:/path и экранируем
    posix_path = str(resolved).replace(chr(92), "/")
    if posix_path[1:3] == ":/":
        posix_path = "/" + posix_path  # /c:/path
    source_uri = "file:" + urlquote(posix_path, safe="/\\:") + "?mode=ro"
    db = sqlite3.connect(source_uri, uri=True)
    db.row_factory = sqlite3.Row
    lines = ["PRAGMA foreign_keys=ON;", "BEGIN;"]
    try:
        for table, columns in TABLES.items():
            select_columns, names, table_exists = build_select(db, table, columns)
            if not table_exists:
                continue  # Пропускаем таблицы, которых нет в пустой базе
            rows = db.execute(f"SELECT {select_columns} FROM {table}").fetchall()
            for row in rows:
                values = ", ".join(quote(row[name]) for name in names)
                lines.append(f"INSERT OR REPLACE INTO {table}({columns}) VALUES({values});")

        # pair_members — новый единственный источник членства в D1.
        # Проверяем, есть ли таблица pairs (может не быть в пустой базе).
        _, _, pairs_exists = build_select(db, "pairs", "id")
        if pairs_exists:
            # INSERT OR REPLACE ниже при конфликте уникального code удаляет
            # строку, а ON DELETE CASCADE сносит её планы, даты, дневник и
            # желания. В здоровой базе коды уникальны по constraint, поэтому
            # дубли — признак повреждённого источника: останавливаемся с ясной
            # ошибкой вместо тихой потери данных на импорте.
            duplicates = db.execute(
                "SELECT code, COUNT(*) AS n FROM pairs GROUP BY code HAVING n > 1"
            ).fetchall()
            if duplicates:
                shown = ", ".join(f"{row['code']}×{row['n']}" for row in duplicates)
                raise RuntimeError(
                    "В исходной базе дублируются коды пространств "
                    f"({shown}): импорт INSERT OR REPLACE удалил бы данные "
                    "по каскаду. Восстановите базу и повторите экспорт."
                )
            for role, owner, guest in (("a", "user_a", None), ("b", "user_b", None)):
                condition = f"{owner} != 0"
                if guest:
                    condition += f" AND {guest} != 0"
                rows = db.execute(
                    f"SELECT {owner} AS tg_id, id AS pair_id, created_at FROM pairs WHERE {condition}"
                ).fetchall()
                for row in rows:
                    lines.append(
                        "INSERT OR IGNORE INTO pair_members(tg_id,pair_id,role,joined_at) "
                        f"VALUES({quote(row['tg_id'])},{quote(row['pair_id'])},{quote(role)},"
                        f"{quote(row['created_at'])});"
                    )
        lines.append("COMMIT;")
    finally:
        db.close()
    return "\n".join(lines) + "\n"


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source", type=Path, default=PROJECT_ROOT / "data" / "duoplan.db")
    parser.add_argument(
        "--output", type=Path, default=PROJECT_ROOT / "data" / "duoplan-d1-import.sql"
    )
    args = parser.parse_args()
    if not args.source.is_file():
        parser.error(f"SQLite не найден: {args.source}")
    sql = dump(args.source)
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(sql, encoding="utf-8")
    print(f"Экспортировано в {args.output} ({len(sql.splitlines())} строк).")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
