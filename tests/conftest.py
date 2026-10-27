from __future__ import annotations

import pytest

from duoplan.db.base import connect_database
from duoplan.services import DuoPlanService


@pytest.fixture
async def db(tmp_path):
    database = await connect_database(tmp_path / "duoplan-test.db")
    yield database
    await database.close()


@pytest.fixture
async def pair(db):
    """Готовая пара: сервис, id пары, владелец, партнёр."""
    service = DuoPlanService(db)
    await service.ensure_user(1, "owner", "Владелец")
    await service.ensure_user(2, "partner", "Партнёр")
    code = await service.create_pair(1, "Владелец")
    assert await service.join_pair(2, "Партнёр", code)
    created = await service.pair_for(1)
    return service, int(created["id"]), 1, 2
