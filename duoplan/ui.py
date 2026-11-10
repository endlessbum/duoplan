from aiogram.types import InlineKeyboardButton
from aiogram.types import InlineKeyboardMarkup

from duoplan.services import DAILY_XP


def button(text: str, data: str) -> InlineKeyboardButton:
    return InlineKeyboardButton(text=text, callback_data=data)


MAIN_MENU = InlineKeyboardMarkup(
    inline_keyboard=[
        [button("Наши планы", "menu:tasks"), button("Значимые даты", "menu:dates")],
        [button("Общий дневник", "menu:memories"), button("Вишлист", "menu:wishes")],
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

# Меню уже созданного пространства: вход по чужому коду запрещён, поэтому
# вместо «Ввести другой код» — возврат в своё пространство.
PAIR_MENU = InlineKeyboardMarkup(
    inline_keyboard=[
        [button("Пригласить ещё раз", "pair:invite")],
        [button("В наше пространство", "menu:home")],
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


def pager_row(section: str, page: int, has_prev: bool, has_next: bool) -> list[InlineKeyboardButton]:
    row: list[InlineKeyboardButton] = []
    if has_prev:
        row.append(button("← Назад", f"list:{section}:{max(0, page - 1)}"))
    if has_next:
        row.append(button("Дальше →", f"list:{section}:{page + 1}"))
    return row


HOME_MENU = InlineKeyboardMarkup(
    inline_keyboard=[[button("В наше пространство", "menu:home")]]
)

# Меню карточки «Наша пара» у соединённой пары: выход — с подтверждением.
PAIRED_MENU = InlineKeyboardMarkup(
    inline_keyboard=[
        [button("Выйти из пространства", "pair:leave")],
        [button("В наше пространство", "menu:home")],
    ]
)

# Подтверждение выхода: случайный тап по кнопке не должен рвать пространство.
LEAVE_CONFIRM_MENU = InlineKeyboardMarkup(
    inline_keyboard=[
        [button("Да, выйти", "pair:leave:yes")],
        [button("Остаться", "pair:leave:no")],
    ]
)


GAME_MENU = InlineKeyboardMarkup(
    inline_keyboard=[
        # XP из DAILY_XP: захардкоженное «+10» разошлось бы с начислением
        # при изменении константы.
        [button(f"Мы это сделали · +{DAILY_XP} XP", "game:done")],
        [button("В наше пространство", "menu:home")],
    ]
)
