from __future__ import annotations

def xp_needed(level: int) -> int:
    """Сколько XP нужно, чтобы достичь ``level``."""
    return 100 * max(1, int(level)) ** 2


def level_for(xp: int) -> tuple[int, int, int]:
    """-> (уровень, XP для следующего, сколько XP ещё не хватает до него)."""
    xp = max(0, int(xp))
    level = 1
    while xp >= xp_needed(level):
        level += 1
    return level, xp_needed(level), xp_needed(level) - xp


def title_for(level: int) -> tuple[str, str]:
    return LEVEL_TITLES[min(max(1, level), len(LEVEL_TITLES)) - 1]


LEVEL_TITLES: tuple[tuple[str, str], ...] = (
    ("Искры", "✦"),
    ("Тёплый свет", "✦✦"),
    ("Своё гнездо", "✦✦✦"),
    ("Синхрон", "✦✦✦✦"),
    ("Команда", "✦✦✦✦✦"),
    ("Верные союзники", "☆✦✦✦✦✦"),
    ("Дом", "☆✦✦✦✦✦✦"),
    ("Штиль", "☆✦✦✦✦✦✦✦"),
)
