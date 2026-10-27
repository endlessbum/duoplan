from aiogram.types import InlineKeyboardButton
from aiogram.types import InlineKeyboardMarkup


def button(text: str, data: str) -> InlineKeyboardButton:
    return InlineKeyboardButton(text=text, callback_data=data)


MAIN_MENU = InlineKeyboardMarkup(
    inline_keyboard=[
        [button("Наши планы", "menu:tasks"), button("Значимые даты", "menu:dates")],
        [button("Дневник двоих", "menu:memories"), button("Вишлист", "menu:wishes")],
        [button("Ритуал дня", "menu:game")],
        [button("Наша пара", "menu:pair")],
    ]
)

START_MENU = InlineKeyboardMarkup(
    inline_keyboard=[
        [button("Создать пространство", "pair:create")],
        [button("Войти по коду", "pair:join")],
    ]
)

PAIR_MENU = InlineKeyboardMarkup(
    inline_keyboard=[
        [button("Пригласить ещё раз", "pair:invite")],
        [button("Ввести другой код", "pair:join")],
    ]
)


def section_menu(section: str) -> InlineKeyboardMarkup:
    labels = {
        "tasks": "Добавить план",
        "dates": "Добавить дату",
        "memories": "Добавить запись",
        "wishes": "Добавить желание",
    }
    return InlineKeyboardMarkup(
        inline_keyboard=[
            [button(labels[section], f"add:{section}")],
            [button("В наше пространство", "menu:home")],
        ]
    )


HOME_MENU = InlineKeyboardMarkup(
    inline_keyboard=[[button("В наше пространство", "menu:home")]]
)


GAME_MENU = InlineKeyboardMarkup(
    inline_keyboard=[
        [button("Мы это сделали · +10 XP", "game:done")],
        [button("В наше пространство", "menu:home")],
    ]
)
