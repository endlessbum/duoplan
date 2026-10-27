from __future__ import annotations

import asyncio
import logging

from aiogram import Bot
from aiogram import Dispatcher
from aiogram.types import BotCommand

from duoplan.config import load_settings
from duoplan.db.base import connect_database
from duoplan.handlers import router
from duoplan.services import DuoPlanService


async def main() -> None:
    settings = load_settings()
    if not settings.is_configured:
        raise RuntimeError("Укажите BOT_TOKEN в файле .env")

    db = await connect_database(settings.db_path)
    service = DuoPlanService(db)
    bot = Bot(token=settings.bot_token)
    dp = Dispatcher()
    dp.include_router(router)
    dp["service"] = service
    await bot.set_my_commands(
        [
            BotCommand(command="menu", description="Наше пространство"),
            BotCommand(command="cancel", description="Отменить ввод"),
            BotCommand(command="help", description="Как работает DuoPlan"),
        ]
    )
    logging.info("DuoPlan запущен")
    try:
        await dp.start_polling(bot)
    finally:
        await db.close()


if __name__ == "__main__":
    logging.basicConfig(level=logging.INFO)
    asyncio.run(main())
