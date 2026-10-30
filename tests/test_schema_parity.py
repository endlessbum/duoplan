from __future__ import annotations

import re
from pathlib import Path

from duoplan.db.schema import SCHEMA

ROOT = Path(__file__).resolve().parents[1]
MIGRATIONS = ROOT / "migrations"
WORKER = ROOT / "worker.js"

# Локальные таблицы, которых нет в D1 по замыслу: FSM-состояния хранит только
# Python-бот (SQLite), в Worker они не нужны.
LOCAL_ONLY_TABLES = {"fsm_states"}


def _split_columns(body: str) -> list[tuple[str, bool]]:
    """Колонки из тела CREATE TABLE: (имя, NOT NULL), без табличных ограничений."""
    parts: list[str] = []
    depth = 0
    current = ""
    for char in body:
        if char == "(":
            depth += 1
        elif char == ")":
            depth -= 1
        if char == "," and depth == 0:
            parts.append(current)
            current = ""
            continue
        current += char
    parts.append(current)

    columns: list[tuple[str, bool]] = []
    for part in parts:
        part = part.strip()
        if not part:
            continue
        head = part.split()[0].upper()
        if head in {"PRIMARY", "UNIQUE", "CHECK", "FOREIGN", "CONSTRAINT"}:
            continue
        name = part.split()[0].strip('"`[]')
        columns.append((name, "NOT NULL" in part.upper()))
    return columns


def _create_blocks(sql: str) -> dict[str, str]:
    """Тела всех CREATE TABLE из текста SQL (последнее определение выигрывает)."""
    blocks: dict[str, str] = {}
    for match in re.finditer(r"CREATE TABLE IF NOT EXISTS\s+(\w+)\s*\(", sql, re.IGNORECASE):
        name = match.group(1)
        depth = 0
        start = match.end() - 1
        for index in range(start, len(sql)):
            if sql[index] == "(":
                depth += 1
            elif sql[index] == ")":
                depth -= 1
                if depth == 0:
                    blocks[name] = sql[start + 1:index]
                    break
    return blocks


def _python_schema() -> dict[str, list[tuple[str, bool]]]:
    return {name: _split_columns(body) for name, body in _create_blocks("\n".join(SCHEMA)).items()}


def _d1_migrations() -> dict[str, list[tuple[str, bool]]]:
    """Итоговая схема D1: CREATE из миграций + последующие ALTER ... ADD COLUMN."""
    tables: dict[str, list[tuple[str, bool]]] = {}
    for path in sorted(MIGRATIONS.glob("*.sql")):
        sql = path.read_text(encoding="utf-8")
        for name, body in _create_blocks(sql).items():
            tables[name] = _split_columns(body)
        for match in re.finditer(r"ALTER TABLE\s+(\w+)\s+ADD COLUMN\s+([^;]+);", sql, re.IGNORECASE):
            table, definition = match.group(1), match.group(2)
            if table in tables:
                tables[table].append(_split_columns(definition)[0])
    return tables


def _worker_schema() -> dict[str, list[tuple[str, bool]]]:
    return {name: _split_columns(body) for name, body in _create_blocks(WORKER.read_text(encoding="utf-8")).items()}


def test_daily_rolls_has_no_column_outside_d1():
    """Регресс 2026-10-29: daily_kind был только в Python-схеме.

    Колонка нигде не читалась, но писалась в INSERT'ах, поэтому локальная база
    и D1 описывали одну таблицу по-разному, а экспорт в D1 молча терял значение.
    """
    local = _python_schema()
    assert "daily_rolls" in local
    assert [name for name, _ in local["daily_rolls"]] == [
        "pair_id", "day", "daily_value",
    ]


def test_daily_rolls_matches_between_python_migrations_and_worker():
    local = _python_schema()["daily_rolls"]
    d1 = _d1_migrations()["daily_rolls"]
    worker = _worker_schema()["daily_rolls"]
    assert local == d1, f"Python {local} != migrations {d1}"
    assert local == worker, f"Python {local} != worker {worker}"


def test_shared_tables_have_same_columns_everywhere():
    """Одна таблица — одна схема: локальная база не обрастает своими колонками.

    Порядок колонок не сравниваем: D1 добирает их через ALTER ... ADD COLUMN,
    поэтому порядок там исторический. Важен состав — лишняя колонка в локальной
    схеме (как daily_kind) означает, что Python пишет то, чего нет в production.
    """
    local = _python_schema()
    d1 = _d1_migrations()
    worker = _worker_schema()

    mismatches: list[str] = []
    for table in sorted(set(local) & set(d1) & set(worker)):
        if table in LOCAL_ONLY_TABLES:
            continue
        local_columns = {name for name, _ in local[table]}
        for label, other in (("migrations", d1[table]), ("worker.js", worker[table])):
            other_columns = {name for name, _ in other}
            if local_columns != other_columns:
                extra = sorted(local_columns - other_columns)
                missing = sorted(other_columns - local_columns)
                mismatches.append(f"{table}: лишние в python={extra}, нет в python={missing} ({label})")
    assert not mismatches, "\n".join(mismatches)


def test_no_daily_kind_anywhere():
    """Колонка удалена из всех источников, включая SQL в сервисах."""
    for path in [WORKER, *MIGRATIONS.glob("*.sql"), *ROOT.glob("duoplan/**/*.py")]:
        assert "daily_kind" not in path.read_text(encoding="utf-8"), path
