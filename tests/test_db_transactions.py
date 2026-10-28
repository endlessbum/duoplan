from __future__ import annotations


async def test_nested_rollback_rolls_back_outer(db):
    """tx.rollback() во вложенном блоке должен откатить и внешнюю транзакцию.

    Раньше вложенный transaction() отдавал одноразовый Transaction, флаг
    которого внешняя транзакция не видела, и выполняла COMMIT.
    """
    await db.execute("CREATE TABLE tx_probe (v TEXT)")
    await db.execute("INSERT INTO tx_probe VALUES ('before')")

    async with db.transaction():
        await db.execute("INSERT INTO tx_probe VALUES ('outer')")
        async with db.transaction() as inner_tx:
            await db.execute("INSERT INTO tx_probe VALUES ('inner')")
            inner_tx.rollback()
        # Вложенный блок завершился без исключения — это не должно спасать запись.

    rows = await db.query("SELECT v FROM tx_probe")
    assert [row["v"] for row in rows] == ["before"]


async def test_nested_transactions_commit_together(db):
    await db.execute("CREATE TABLE tx_probe (v TEXT)")

    async with db.transaction():
        await db.execute("INSERT INTO tx_probe VALUES ('outer')")
        async with db.transaction():
            await db.execute("INSERT INTO tx_probe VALUES ('inner')")

    rows = await db.query("SELECT v FROM tx_probe")
    assert sorted(row["v"] for row in rows) == ["inner", "outer"]


async def test_nested_exception_rolls_back_outer(db):
    await db.execute("CREATE TABLE tx_probe (v TEXT)")
    await db.execute("INSERT INTO tx_probe VALUES ('before')")

    try:
        async with db.transaction():
            await db.execute("INSERT INTO tx_probe VALUES ('outer')")
            async with db.transaction():
                await db.execute("INSERT INTO tx_probe VALUES ('inner')")
                raise RuntimeError("boom")
    except RuntimeError:
        pass

    rows = await db.query("SELECT v FROM tx_probe")
    assert [row["v"] for row in rows] == ["before"]
