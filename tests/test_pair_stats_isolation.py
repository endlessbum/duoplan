"""Регрессионные тесты изоляции статистики «Ваша история» между парами.

Пользовательские XP, серия и рекорд серии хранятся в users и должны:
  * обнуляться при входе в новую пару (новая совместная история);
  * сохраняться при возвращении прежнего партнёра по зарезервированному коду
    (awaiting_return=1 + last_partner), даже если он успел побывать в третьем
    пространстве — снимок member_stats делается при выходе.

Сценарии (см. раздел 6 ТЗ):
  - Тест 1: создание пространства пользователем с ненулевой статистикой;
  - Тест 2: вступление партнёра с ненулевой статистикой в новую пару;
  - Тест 3: новая пара из двух пользователей с историей;
  - Тест 4: возвращение прежней пары по зарезервированному коду;
  - Тест 5: возвращение после третьего пространства (снимокmember_stats);
  - Тест 6: повторное создание пространства после выхода.
"""
from __future__ import annotations

import pytest

from duoplan.services import DuoPlanService


@pytest.mark.asyncio
async def test_create_pair_resets_stats(db):
    """Тест 1: создание пространства пользователем с ненулевой статистикой."""
    service = DuoPlanService(db)
    await service.ensure_user(1, "owner", "Владелец")
    # Устанавливаем ненулевую статистику.
    await db.execute(
        "UPDATE users SET points = 500, streak = 10, best_streak = 20, "
        "last_activity = '2026-11-10' WHERE tg_id = ?",
        (1,),
    )
    user_before = await service.user(1)
    assert user_before["points"] == 500
    assert user_before["streak"] == 10
    assert user_before["best_streak"] == 20
    assert user_before["last_activity"] == "2026-11-10"

    # Создаём новую пару — статистика должна обнулиться.
    await service.create_pair(1, "Владелец")
    user_after = await service.user(1)
    assert user_after["points"] == 0
    assert user_after["streak"] == 0
    assert user_after["best_streak"] == 0
    assert user_after["last_activity"] is None


@pytest.mark.asyncio
async def test_join_new_pair_resets_stats(db):
    """Тест 2: вступление партнёра с ненулевой статистикой в новую пару."""
    service = DuoPlanService(db)
    await service.ensure_user(1, "owner", "Владелец")
    await service.ensure_user(2, "partner", "Партнёр")
    code = await service.create_pair(1, "Владелец")

    # У партнёра ненулевая статистика из прежнего пространства.
    await db.execute(
        "UPDATE users SET points = 800, streak = 15, best_streak = 30, "
        "last_activity = '2026-11-09' WHERE tg_id = ?",
        (2,),
    )
    user_before = await service.user(2)
    assert user_before["points"] == 800
    assert user_before["streak"] == 15

    # Вступает в новую пару — статистика обнуляется.
    assert await service.join_pair(2, "Партнёр", code)
    user_after = await service.user(2)
    assert user_after["points"] == 0
    assert user_after["streak"] == 0
    assert user_after["best_streak"] == 0
    assert user_after["last_activity"] is None


@pytest.mark.asyncio
async def test_new_pair_both_reset_stats(db):
    """Тест 3: новая пара из двух пользователей с историей."""
    service = DuoPlanService(db)
    await service.ensure_user(1, "a", "A")
    await service.ensure_user(2, "b", "B")
    # Оба имеют ненулевую статистику.
    await db.execute(
        "UPDATE users SET points = 300, streak = 5, best_streak = 10 "
        "WHERE tg_id IN (?, ?)",
        (1, 2),
    )

    code = await service.create_pair(1, "A")
    assert await service.join_pair(2, "B", code)

    # Оба начинают с нуля.
    user_a = await service.user(1)
    user_b = await service.user(2)
    assert user_a["points"] == 0 and user_a["streak"] == 0
    assert user_b["points"] == 0 and user_b["streak"] == 0


@pytest.mark.asyncio
async def test_reunion_restores_stats(db):
    """Тест 4: возвращение прежней пары по зарезервированному коду."""
    service = DuoPlanService(db)
    await service.ensure_user(1, "a", "A")
    await service.ensure_user(2, "b", "B")
    code = await service.create_pair(1, "A")
    assert await service.join_pair(2, "B", code)

    # Накапливаем статистику.
    await db.execute(
        "UPDATE users SET points = 100, streak = 7, best_streak = 15, "
        "last_activity = '2026-11-10' WHERE tg_id = ?",
        (2,),
    )
    stats_before = await service.user(2)

    # Партнёр выходит — снимок member_stats сохраняется.
    assert await service.leave_pair(2)
    pair = await service.membership(1)
    snapshot = await db.one(
        "SELECT * FROM member_stats WHERE pair_id = ? AND tg_id = ?",
        (pair["id"], 2),
    )
    assert snapshot is not None
    assert snapshot["points"] == 100
    assert snapshot["streak"] == 7
    assert snapshot["best_streak"] == 15

    # Возвращается по тому же коду — статистика восстанавливается.
    assert await service.join_pair(2, "B", code)
    stats_after = await service.user(2)
    assert stats_after["points"] == stats_before["points"]
    assert stats_after["streak"] == stats_before["streak"]
    assert stats_after["best_streak"] == stats_before["best_streak"]
    assert stats_after["last_activity"] == stats_before["last_activity"]


@pytest.mark.asyncio
async def test_reunion_after_third_space(db):
    """Тест 5: возвращение после третьего пространства (снимок member_stats)."""
    service = DuoPlanService(db)
    await service.ensure_user(1, "a", "A")
    await service.ensure_user(2, "b", "B")
    await service.ensure_user(3, "c", "C")

    # A и B — прежняя пара с накопленной статистикой.
    code_ab = await service.create_pair(1, "A")
    assert await service.join_pair(2, "B", code_ab)
    await db.execute(
        "UPDATE users SET points = 200, streak = 8, best_streak = 12 "
        "WHERE tg_id = ?",
        (2,),
    )
    assert await service.leave_pair(2)

    # B вступает в пространство с C — его статистика обнуляется.
    code_c = await service.create_pair(3, "C")
    assert await service.join_pair(2, "B", code_c)
    user_with_c = await service.user(2)
    assert user_with_c["points"] == 0
    assert user_with_c["streak"] == 0

    # B выходит из пространства с C.
    assert await service.leave_pair(2)

    # B возвращается к A по старому зарезервированному коду — должна
    # восстановиться статистика из member_stats пары AB, а не обнулиться.
    assert await service.join_pair(2, "B", code_ab)
    user_reunited = await service.user(2)
    assert user_reunited["points"] == 200
    assert user_reunited["streak"] == 8
    assert user_reunited["best_streak"] == 12


@pytest.mark.asyncio
async def test_recreate_space_resets_stats(db):
    """Тест 6: повторное создание пространства после выхода."""
    service = DuoPlanService(db)
    await service.ensure_user(1, "a", "A")
    code1 = await service.create_pair(1, "A")
    await db.execute(
        "UPDATE users SET points = 100, streak = 5, best_streak = 10 "
        "WHERE tg_id = ?",
        (1,),
    )

    # Выходит (последний держатель — пара удаляется).
    assert await service.leave_pair(1)

    # Создаёт новое пространство — статистика обнулена.
    code2 = await service.create_pair(1, "A")
    user = await service.user(1)
    assert user["points"] == 0
    assert user["streak"] == 0
    assert user["best_streak"] == 0
    assert user["last_activity"] is None
    assert code1 != code2  # коды различаются.
