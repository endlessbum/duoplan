from __future__ import annotations

from duoplan.handlers import parse_tail


def test_parse_tail_handles_current_and_legacy_callbacks():
    assert parse_tail("task:done:5:2", "task:done:") == (5, 2)
    assert parse_tail("task:done:5", "task:done:") == (5, 0)
    assert parse_tail("wish:done:12:0", "wish:done:") == (12, 0)


def test_parse_tail_rejects_garbage():
    assert parse_tail(None, "task:done:") is None
    assert parse_tail("task:done:abc", "task:done:") is None
    assert parse_tail("task:done:-1:0", "task:done:") is None
    assert parse_tail("task:done:1:2:3", "task:done:") is None
    assert parse_tail("wish:done:1", "task:done:") is None
