from __future__ import annotations

import json
from pathlib import Path

from duoplan.services import DAILY_ACTIONS
from duoplan.services import DuoPlanService

ROOT = Path(__file__).resolve().parents[1]
CONTRACT = json.loads((ROOT / "tests" / "fixtures" / "daily_actions.json").read_text(encoding="utf-8"))


def test_action_list_matches_contract():
    """Тексты и порядок действий совпадают с Worker/Mini App."""
    assert list(DAILY_ACTIONS) == CONTRACT["actions"]


def test_action_list_matches_worker_source():
    """Список в worker.js — источник истины, а не только JSON-контракт.

    Если кто-то поправит текст в Worker, не обновив контракт и Python,
    тест падает здесь, а не в продакшене.
    """
    source = (ROOT / "worker.js").read_text(encoding="utf-8")
    start = source.index("const DAILY_ACTIONS = [")
    end = source.index("];", start)
    block = source[start:end]
    worker_actions = [
        json.loads(line.strip().rstrip(","))
        for line in block.splitlines()
        if line.strip().startswith('"')
    ]
    assert list(DAILY_ACTIONS) == worker_actions


def test_daily_action_reproduces_shared_vectors():
    """Тот же хеш, что dailyAction() в worker.js: одна пара — одно задание."""
    for vector in CONTRACT["vectors"]:
        expected = CONTRACT["actions"][vector["index"]]
        actual = DuoPlanService._daily_action(None, vector["pair_id"], vector["day"])
        assert actual == expected, f"pair={vector['pair_id']} day={vector['day']}"


def test_daily_action_is_deterministic_and_in_range():
    first = DuoPlanService._daily_action(None, 5, "2026-10-29")
    second = DuoPlanService._daily_action(None, 5, "2026-10-29")
    assert first == second
    assert first in DAILY_ACTIONS


def test_daily_action_differs_across_days_and_pairs():
    """Хеш не вырождается: разные дни дают не одно и то же действие подряд."""
    values = {
        DuoPlanService._daily_action(None, pair_id, day)
        for pair_id in (1, 2, 3)
        for day in ("2026-10-29", "2026-10-30", "2026-10-31", "2026-11-01")
    }
    assert len(values) > 1
