import pathlib
import sys

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))

from duoplan.config import load_settings, parse_admin_ids, parse_env_file  # noqa: E402

env_text = "\n".join(
    [
        "A=1",
        "# comment",
        'B="2 3"',
        "export C=4  # note",
        "garbage line",
        "D='x'",
    ]
)
print(parse_env_file(env_text))
print(sorted(parse_admin_ids("1, 2 3;x\n-5")))
s = load_settings()
print(s.bot_name, s.tz_name, s.is_configured, s.db_path, s.tz)
print(s.is_admin(1))
