from __future__ import annotations

from duoplan.game.levels import level_for
from duoplan.game.levels import title_for
from duoplan.game.levels import xp_needed


def test_xp_math_is_unchanged():
    assert xp_needed(1) == 100
    assert xp_needed(2) == 400
    assert level_for(0) == (1, 100, 100)
    assert level_for(99) == (1, 100, 1)
    assert level_for(100) == (2, 400, 300)
    assert level_for(399) == (2, 400, 1)


def test_title_for_does_not_lose_high_levels():
    base = title_for(1)
    assert title_for(0) == base
    high = title_for(9)
    assert high != base
    assert "круг" in high[0]
    assert title_for(20)[0] != title_for(9)[0]
