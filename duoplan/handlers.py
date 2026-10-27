from __future__ import annotations

from datetime import date

from aiogram import F
from aiogram import Router
from aiogram.filters import Command
from aiogram.filters import CommandStart
from aiogram.filters import StateFilter
from aiogram.fsm.context import FSMContext
from aiogram.fsm.state import State
from aiogram.fsm.state import StatesGroup
from aiogram.types import CallbackQuery
from aiogram.types import InlineKeyboardMarkup
from aiogram.types import Message

from duoplan.game.levels import level_for
from duoplan.game.levels import title_for
from duoplan.services import DuoPlanService
from duoplan.ui import GAME_MENU
from duoplan.ui import HOME_MENU
from duoplan.ui import MAIN_MENU
from duoplan.ui import PAIR_MENU
from duoplan.ui import START_MENU
from duoplan.ui import button
from duoplan.ui import section_menu

router = Router()
router.message.filter(F.chat.type == "private")
router.callback_query.filter(F.message.chat.type == "private")


class Form(StatesGroup):
    join_code = State()
    task = State()
    date_title = State()
    date_day = State()
    memory = State()
    wish = State()


def name_of(user) -> str:
    return user.full_name or user.first_name or "Без имени"


async def register(message: Message, service: DuoPlanService) -> None:
    await service.ensure_user(message.from_user.id, message.from_user.username, name_of(message.from_user))


async def register_callback(call: CallbackQuery, service: DuoPlanService) -> None:
    await service.ensure_user(call.from_user.id, call.from_user.username, name_of(call.from_user))


def welcome_text() -> str:
    return (
        "DuoPlan · пространство для двоих\n\n"
        "Здесь живут ваши общие планы, важные даты, воспоминания и желания. "
        "А небольшой ритуал дня помогает не терять друг друга в буднях.\n\n"
        "Создайте пространство и пригласите партнёра или войдите по его коду."
    )


def home_text(pair, user) -> str:
    level, next_xp, missing = level_for(user["points"])
    title, symbol = title_for(level)
    return (
        f"Наше пространство · {pair['name1']} и {pair['name2']}\n\n"
        f"{symbol} Статус: {title}\n"
        f"Ваши очки: {user['points']} XP · серия {user['streak']} дн.\n"
        f"До уровня {level + 1}: {missing} XP (отметка на {next_xp} XP)\n\n"
        "Что добавим в ваш общий ритм сегодня?"
    )


async def send_home(message: Message, service: DuoPlanService, user_id: int) -> None:
    pair = await service.pair_for(user_id)
    if not pair:
        await message.answer(welcome_text(), reply_markup=START_MENU)
        return
    user = await service.user(user_id)
    await message.answer(home_text(pair, user), reply_markup=MAIN_MENU)


async def edit_home(call: CallbackQuery, service: DuoPlanService) -> None:
    pair = await service.pair_for(call.from_user.id)
    if not pair:
        await call.message.edit_text(welcome_text(), reply_markup=START_MENU)
        return
    user = await service.user(call.from_user.id)
    await call.message.edit_text(home_text(pair, user), reply_markup=MAIN_MENU)


@router.message(CommandStart())
async def start(message: Message, service: DuoPlanService, state: FSMContext) -> None:
    await state.clear()
    await register(message, service)
    code = message.text.partition(" ")[2].strip() if message.text else ""
    if code:
        joined = await service.join_pair(message.from_user.id, name_of(message.from_user), code)
        if joined:
            await message.answer("Готово — теперь у вас одно пространство на двоих.")
        else:
            await message.answer("Этот код недоступен. Проверьте его или попросите партнёра прислать приглашение ещё раз.")
    await send_home(message, service, message.from_user.id)


@router.message(Command("menu"))
async def menu(message: Message, service: DuoPlanService, state: FSMContext) -> None:
    await state.clear()
    await register(message, service)
    await send_home(message, service, message.from_user.id)


@router.message(Command("help"))
async def help_command(message: Message) -> None:
    await message.answer(
        "DuoPlan работает в личном чате с ботом.\n\n"
        "Создайте пространство, передайте партнёру код или ссылку-приглашение. "
        "После соединения вам станут доступны планы, даты, дневник, вишлист и ритуал дня.\n\n"
        "Команды: /menu — главное меню, /cancel — отменить ввод, /help — помощь."
    )


@router.message(Command("cancel"))
async def cancel(message: Message, state: FSMContext) -> None:
    if await state.get_state() is None:
        await message.answer("Сейчас ничего не вводится.")
        return
    await state.clear()
    await message.answer("Ввод отменён.", reply_markup=HOME_MENU)


@router.callback_query(F.data == "pair:create")
async def create_pair(call: CallbackQuery, service: DuoPlanService) -> None:
    await register_callback(call, service)
    pair = await service.membership(call.from_user.id)
    if pair and pair["user_b"]:
        await call.answer("Пространство уже настроено")
        await edit_home(call, service)
        return
    code = pair["code"] if pair else await service.create_pair(call.from_user.id, name_of(call.from_user))
    me = await call.bot.get_me()
    await call.message.edit_text(
        f"Пространство создано. Код для партнёра:\n\n{code}\n\n"
        f"Или отправьте ссылку: https://t.me/{me.username}?start={code}\n\n"
        "После входа партнёра откройте /menu.",
        reply_markup=PAIR_MENU,
    )
    await call.answer()


@router.callback_query(F.data == "pair:invite")
async def invite(call: CallbackQuery, service: DuoPlanService) -> None:
    pair = await service.membership(call.from_user.id)
    if not pair:
        await call.answer("Сначала создайте пространство")
        return
    me = await call.bot.get_me()
    await call.message.edit_text(
        f"Код приглашения: {pair['code']}\n\nhttps://t.me/{me.username}?start={pair['code']}",
        reply_markup=PAIR_MENU,
    )
    await call.answer()


@router.callback_query(F.data == "pair:join")
async def join_pair(call: CallbackQuery, state: FSMContext) -> None:
    await state.set_state(Form.join_code)
    await call.message.edit_text("Введите код приглашения из восьми символов. Для отмены: /cancel")
    await call.answer()


@router.message(StateFilter(Form.join_code))
async def receive_code(message: Message, service: DuoPlanService, state: FSMContext) -> None:
    await register(message, service)
    joined = await service.join_pair(message.from_user.id, name_of(message.from_user), message.text)
    await state.clear()
    if not joined:
        await message.answer("Не получилось войти по этому коду. Проверьте код и попробуйте ещё раз.", reply_markup=START_MENU)
        return
    await message.answer("Вы на связи. Пространство теперь общее!")
    await send_home(message, service, message.from_user.id)


@router.callback_query(F.data == "menu:home")
async def home(call: CallbackQuery, service: DuoPlanService) -> None:
    await edit_home(call, service)
    await call.answer()


@router.callback_query(F.data == "menu:pair")
async def pair_info(call: CallbackQuery, service: DuoPlanService) -> None:
    pair = await service.pair_for(call.from_user.id)
    if not pair:
        await call.answer("Сначала соедините пространство")
        return
    user = await service.user(call.from_user.id)
    level, _, _ = level_for(pair["together_pts"])
    title, symbol = title_for(level)
    await call.message.edit_text(
        f"{pair['name1']} и {pair['name2']}\n\n"
        f"Вместе в DuoPlan с {pair['started_at']}\n"
        f"Общий запас: {pair['together_pts']} XP\n"
        f"{symbol} Общий уровень: {level} · {title}\n"
        f"Личная серия: {user['streak']} дн.",
        reply_markup=HOME_MENU,
    )
    await call.answer()


async def tasks_view(call: CallbackQuery, service: DuoPlanService) -> None:
    pair = await service.pair_for(call.from_user.id)
    rows = await service.tasks(pair["id"])
    text = "Наши планы\n\n" + ("\n".join(f"• {row['title']}" for row in rows) if rows else "Пока свободно. Добавьте первый общий шаг.")
    buttons = [[button(f"Готово: {row['title'][:22]}", f"task:done:{row['id']}")] for row in rows[:8]]
    buttons.extend([[button("Добавить план", "add:tasks")], [button("В наше пространство", "menu:home")]])
    await call.message.edit_text(text, reply_markup=InlineKeyboardMarkup(inline_keyboard=buttons))


async def dates_view(call: CallbackQuery, service: DuoPlanService) -> None:
    pair = await service.pair_for(call.from_user.id)
    rows = await service.dates(pair["id"])
    text = "Значимые даты\n\n" + ("\n".join(f"{row['day']} · {row['title']}" for row in rows) if rows else "Добавьте дату, которую хочется беречь.")
    await call.message.edit_text(text, reply_markup=section_menu("dates"))


async def memories_view(call: CallbackQuery, service: DuoPlanService) -> None:
    pair = await service.pair_for(call.from_user.id)
    rows = await service.memories(pair["id"])
    entries = [f"{row['day']} · {row['display_name'] or 'Один из вас'}\n{row['body']}" for row in rows]
    text = "Дневник двоих\n\n" + ("\n\n".join(entries) if entries else "Здесь появятся ваши маленькие истории и важные моменты.")
    await call.message.edit_text(text[:3900], reply_markup=section_menu("memories"))


async def wishes_view(call: CallbackQuery, service: DuoPlanService) -> None:
    pair = await service.pair_for(call.from_user.id)
    rows = await service.wishes(pair["id"])
    text = "Вишлист\n\n" + ("\n".join(f"• {row['body']} — {row['display_name']}" for row in rows) if rows else "Добавьте желание — большое или совсем маленькое.")
    buttons = [[button(f"Исполнено: {row['body'][:19]}", f"wish:done:{row['id']}")] for row in rows[:8]]
    buttons.extend([[button("Добавить желание", "add:wishes")], [button("В наше пространство", "menu:home")]])
    await call.message.edit_text(text, reply_markup=InlineKeyboardMarkup(inline_keyboard=buttons))


@router.callback_query(F.data.in_({"menu:tasks", "menu:dates", "menu:memories", "menu:wishes"}))
async def sections(call: CallbackQuery, service: DuoPlanService) -> None:
    pair = await service.pair_for(call.from_user.id)
    if not pair:
        await call.answer("Сначала соедините пространство")
        return
    views = {"menu:tasks": tasks_view, "menu:dates": dates_view, "menu:memories": memories_view, "menu:wishes": wishes_view}
    await views[call.data](call, service)
    await call.answer()


@router.callback_query(F.data == "menu:game")
async def game(call: CallbackQuery, service: DuoPlanService) -> None:
    pair = await service.pair_for(call.from_user.id)
    if not pair:
        await call.answer("Сначала соедините пространство")
        return
    daily = await service.daily(pair["id"])
    text = f"Ритуал дня · {daily['day']}\n\n{daily['action']}"
    if daily["done"]:
        text += "\n\nСегодняшний ритуал уже отмечен. До завтра!"
    await call.message.edit_text(text, reply_markup=HOME_MENU if daily["done"] else GAME_MENU)
    await call.answer()


@router.callback_query(F.data == "game:done")
async def game_done(call: CallbackQuery, service: DuoPlanService) -> None:
    pair = await service.pair_for(call.from_user.id)
    if not pair:
        await call.answer("Сначала соедините пространство")
        return
    completed = await service.complete_daily(pair["id"], call.from_user.id)
    await call.answer("+10 XP · ритуал отмечен" if completed else "Сегодня уже отмечено")
    daily = await service.daily(pair["id"])
    await call.message.edit_text(
        f"Ритуал дня · {daily['day']}\n\n{daily['action']}\n\nСегодняшний ритуал отмечен. До завтра!",
        reply_markup=HOME_MENU,
    )


@router.callback_query(F.data.startswith("task:done:"))
async def task_done(call: CallbackQuery, service: DuoPlanService) -> None:
    pair = await service.pair_for(call.from_user.id)
    task_id = int(call.data.rsplit(":", 1)[1])
    done = await service.complete_task(task_id, pair["id"], call.from_user.id)
    await call.answer("План завершён" if done else "План уже закрыт")
    await tasks_view(call, service)


@router.callback_query(F.data.startswith("wish:done:"))
async def wish_done(call: CallbackQuery, service: DuoPlanService) -> None:
    pair = await service.pair_for(call.from_user.id)
    wish_id = int(call.data.rsplit(":", 1)[1])
    done = await service.complete_wish(wish_id, pair["id"])
    await call.answer("Желание исполнено" if done else "Желание уже закрыто")
    await wishes_view(call, service)


@router.callback_query(F.data.in_({"add:tasks", "add:dates", "add:memories", "add:wishes"}))
async def add_item(call: CallbackQuery, service: DuoPlanService, state: FSMContext) -> None:
    if not await service.pair_for(call.from_user.id):
        await call.answer("Сначала соедините пространство")
        return
    prompts = {
        "add:tasks": (Form.task, "Какой план добавим? Одно понятное действие."),
        "add:dates": (Form.date_title, "Как называется эта дата?"),
        "add:memories": (Form.memory, "Запишите момент, который хочется сохранить."),
        "add:wishes": (Form.wish, "Чего вы хотите? Запишите одно желание."),
    }
    next_state, prompt = prompts[call.data]
    await state.set_state(next_state)
    await call.message.edit_text(prompt + "\n\nДля отмены: /cancel")
    await call.answer()


@router.message(StateFilter(Form.task))
async def receive_task(message: Message, service: DuoPlanService, state: FSMContext) -> None:
    pair = await service.pair_for(message.from_user.id)
    await service.add_task(pair["id"], message.text, message.from_user.id)
    await state.clear()
    await message.answer("План добавлен в ваше пространство.", reply_markup=section_menu("tasks"))


@router.message(StateFilter(Form.date_title))
async def receive_date_title(message: Message, state: FSMContext) -> None:
    await state.update_data(title=message.text.strip())
    await state.set_state(Form.date_day)
    await message.answer("Введите дату в формате ДД.ММ или ДД.ММ.ГГГГ.")


@router.message(StateFilter(Form.date_day))
async def receive_date_day(message: Message, service: DuoPlanService, state: FSMContext) -> None:
    try:
        parts = [int(part) for part in message.text.strip().split(".")]
        if len(parts) == 2:
            parts.append(date.today().year)
        if len(parts) != 3:
            raise ValueError
        day = date(parts[2], parts[1], parts[0]).isoformat()
    except ValueError:
        await message.answer("Не распознал дату. Попробуйте ещё раз: ДД.ММ или ДД.ММ.ГГГГ.")
        return
    data = await state.get_data()
    pair = await service.pair_for(message.from_user.id)
    await service.add_date(pair["id"], data["title"], day, 1)
    await state.clear()
    await message.answer("Дата сохранена.", reply_markup=section_menu("dates"))


@router.message(StateFilter(Form.memory))
async def receive_memory(message: Message, service: DuoPlanService, state: FSMContext) -> None:
    pair = await service.pair_for(message.from_user.id)
    await service.add_memory(pair["id"], message.from_user.id, message.text)
    await state.clear()
    await message.answer("Момент сохранён в дневнике.", reply_markup=section_menu("memories"))


@router.message(StateFilter(Form.wish))
async def receive_wish(message: Message, service: DuoPlanService, state: FSMContext) -> None:
    pair = await service.pair_for(message.from_user.id)
    await service.add_wish(pair["id"], message.from_user.id, message.text)
    await state.clear()
    await message.answer("Желание добавлено.", reply_markup=section_menu("wishes"))


@router.message()
async def fallback(message: Message) -> None:
    await message.answer("Откройте пространство через /menu или используйте /cancel, чтобы выйти из текущего ввода.")
