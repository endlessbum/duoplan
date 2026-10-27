from __future__ import annotations


def xp_needed(level: int) -> int:
    """Суммарный XP, при котором уровень ``level`` сменяется на ``level + 1``.

    Математика прежняя: порог растёт квадратично, ``100 * level ** 2``.
    То есть 100 XP — это уже второй уровень, 400 XP — третий.
    """
    return 100 * max(1, int(level)) ** 2


def level_for(xp: int) -> tuple[int, int, int]:
    """-> (уровень, XP для следующего, сколько XP ещё не хватает до него)."""
    xp = max(0, int(xp))
    level = 1
    while xp >= xp_needed(level):
        level += 1
    return level, xp_needed(level), xp_needed(level) - xp


def title_for(level: int) -> tuple[str, str]:
    """Звание для уровня. Уровни выше таблицы не теряются, а идут по кругу."""
    value = max(1, int(level))
    if value <= len(LEVEL_TITLES):
        return LEVEL_TITLES[value - 1]
    title, symbol = LEVEL_TITLES[(value - 1) % len(LEVEL_TITLES)]
    cycle = (value - 1) // len(LEVEL_TITLES) + 1
    return f"{title} · круг {cycle}", symbol


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
