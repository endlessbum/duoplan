from __future__ import annotations

from duoplan.config import DEFAULT_TZ
from duoplan.config import load_settings
from duoplan.config import parse_env_file
from duoplan.config import resolve_timezone


def test_parse_env_file_supports_quoted_values_with_comments():
    text = "\n".join(
        [
            'B="2 3" # заметка',
            "C='x y' # заметка",
            "D=4  # note",
            'E="a # b" # note',
            "F=",
            "export G=7",
            "garbage line",
        ]
    )
    values = parse_env_file(text)
    assert values["B"] == "2 3"
    assert values["C"] == "x y"
    assert values["D"] == "4"
    assert values["E"] == "a # b"
    assert values["F"] == ""
    assert values["G"] == "7"


def test_resolve_timezone_falls_back_to_valid_name():
    tz, name = resolve_timezone("Mars/Olympus")
    assert name == DEFAULT_TZ
    assert tz is not None


def test_load_settings_reads_file_and_validates_timezone(tmp_path, monkeypatch):
    for key in ("BOT_TOKEN", "DB_PATH", "TZ", "BOT_NAME", "FSM_TTL"):
        monkeypatch.delenv(key, raising=False)

    env = tmp_path / ".env"
    env.write_text(
        "\n".join(
            [
                "BOT_TOKEN=123:test-token",
                'TZ="Europe/Moscow" # столица',
                "DB_PATH=data/test.db",
                "FSM_TTL=60",
            ]
        ),
        encoding="utf-8",
    )
    settings = load_settings(env)
    assert settings.bot_token == "123:test-token"
    assert settings.tz_name == "Europe/Moscow"
    assert settings.db_path.name == "test.db"
    assert settings.fsm_ttl == 60
    assert settings.is_configured is True


def test_load_settings_reports_honest_timezone(tmp_path, monkeypatch):
    for key in ("BOT_TOKEN", "DB_PATH", "TZ", "BOT_NAME", "FSM_TTL"):
        monkeypatch.delenv(key, raising=False)

    env = tmp_path / ".env"
    env.write_text("TZ=Nowhere/Special\n", encoding="utf-8")
    settings = load_settings(env)
    assert settings.tz_name == DEFAULT_TZ
    assert settings.tz is not None
