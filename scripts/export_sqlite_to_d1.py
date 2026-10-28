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

TABLES = {
    "pairs": (
        "id, code, name1, name2, user_a, user_b, started_at, together_pts, "
        "created_at, updated_at"
    ),
    "users": (
        "tg_id, username, display_name, role, gender, pair_id, points, streak, "
        "last_activity, best_streak, created_at, updated_at"
    ),
    "tasks": (
        "id, pair_id, title, status, created_by, created_at, completed_by, completed_at"
    ),
    "dates": "id, pair_id, title, day, recurs, created_at",
    "memories": "id, pair_id, author_id, body, day, created_at",
    "wishes": "id, pair_id, owner_id, body, done, created_at",
    "daily_rolls": "pair_id, day, daily_value, done_by, done_at",
}


def quote(value: object) -> str:
    if value is None:
        return "NULL"
    if isinstance(value, (int, float)):
        return str(value)
    return "'" + str(value).replace("'", "''") + "'"


def table_columns(db: sqlite3.Connection, table: str) -> set[str]:
    try:
        rows = db.execute(f"PRAGMA table_info({table})").fetchall()
    except sqlite3.Error as exc:
        raise RuntimeError(f"Не удалось прочитать структуру таблицы {table}: {exc}") from exc
    return {str(row["name"]) for row in rows}


def build_select(db: sqlite3.Connection, table: str, columns: str) -> tuple[str, list[str]]:
    actual = table_columns(db, table)
    if not actual:
        raise RuntimeError(f"Таблица {table} отсутствует в SQLite-базе")
    names = [part.strip() for part in columns.split(",") if part.strip()]
    expressions = []
    for name in names:
        if name in actual:
            expressions.append(name)
        else:
            expressions.append(f"NULL AS {name}")
    return ", ".join(expressions), names


def dump(source: Path) -> str:
    db = sqlite3.connect(f"file:{source}?mode=ro", uri=True)
    db.row_factory = sqlite3.Row
    lines = ["PRAGMA foreign_keys=ON;", "BEGIN;"]
    try:
        for table, columns in TABLES.items():
            select_columns, names = build_select(db, table, columns)
            rows = db.execute(f"SELECT {select_columns} FROM {table}").fetchall()
            for row in rows:
                values = ", ".join(quote(row[name]) for name in names)
                lines.append(f"INSERT OR REPLACE INTO {table}({columns}) VALUES({values});")

        # pair_members — новый единственный источник членства в D1.
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
