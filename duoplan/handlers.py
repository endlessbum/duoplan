from __future__ import annotations

def _utf16_len(s: str) -> int:
    """Длина строки в UTF-16 единицах, как считает Telegram API."""
    return len(s.encode("utf-16-le")) // 2


from datetime import date

from aiogram import F
from aiogram import Router
from aiogram.exceptions import TelegramBadRequest
from aiogram.filters import Command
from aiogram.filters import CommandStart
from aiogram.filters import StateFilter
from aiogram.fsm.context import FSMContext
from aiogram.fsm.state import State
from aiogram.fsm.state import StatesGroup
from aiogram.types import CallbackQuery
from aiogram.types import InlineKeyboardMarkup
from aiogram.types import Message

from duoplan.config import Settings
from duoplan.game.levels import level_for
from duoplan.game.levels import title_for
from duoplan.richtext import escape_html
from duoplan.richtext import rich_to_html
from duoplan.richtext import rich_to_plain
from duoplan.services import DATE_TITLE_MAX
from duoplan.services import DuoPlanService
from duoplan.services import ValidationError
from duoplan.services import normalize_code
from duoplan.ui import GAME_MENU
from duoplan.ui import HOME_MENU
from duoplan.ui import MAIN_MENU
from duoplan.ui import PAIR_MENU
from duoplan.ui import START_MENU
from duoplan.ui import button
from duoplan.ui import pager_row
from duoplan.ui import section_menu

router = Router()
router.message.filter(F.chat.type == "private")
router.callback_query.filter(F.message.chat.type == "private")

PAGE_SIZE = 8
# Код приглашения — 4 байта в hex (worker.createPair).
CODE_LENGTH = 8
PAGE_TEXT_LIMIT = 3900
# full_name складывается из имени и фамилии и длиннее «максимума Telegram»
# для одного имени (64 символа ~ 128 UTF-16 единиц, если там эмодзи),
# поэтому memory_entries обрезает имя до этой длины в UTF-16 единицах.
MEMORY_NAME_VIEW_MAX = 64

# Строка записи дневника в бот-вью: "<YYYY-MM-DD> · <имя>\n<тело>", между
# записями "\n\n". Дата — 10 символов, имя — не больше MEMORY_NAME_VIEW_MAX.
_MEMORY_ENTRY_OVERHEAD = 10 + _utf16_len(" · ") + 1 + 2 + _utf16_len("X" * MEMORY_NAME_VIEW_MAX)
MEMORY_BODY_VIEW_MAX = (
    PAGE_TEXT_LIMIT - _utf16_len("Общий дневник") - 2 - PAGE_SIZE * _MEMORY_ENTRY_OVERHEAD
) // PAGE_SIZE


def fit_entries(header: str, entries: list[str], limit: int = PAGE_TEXT_LIMIT) -> list[str]:
    """Возвращает записи, которые помещаются в лимит вместе с заголовком.

    Полный текст сообщения собирается только из вошедших записей, поэтому
    наличие следующей страницы можно определять по реально выведенным записям.
    """
    rendered: list[str] = []
    used = _utf16_len(header) + 2  # "\n\n" между заголовком и первой записью
    for entry in entries:
        need = _utf16_len(entry) + (2 if rendered else 0)
        if used + need > limit:
            break
        rendered.append(entry)
        used += need
    return rendered


def rich_list_item(prefix: str, title: object, suffix: str = "") -> str:
    """Пункт списка отдельным блоком.

    Разметка рендерится для заголовка целиком, поэтому цитата с первой строки
    становится ``<blockquote>``, а не текстом «> » (в нумерованном списке
    префикс занимал начало строки, и цитата не распознавалась). Префикс и
    суффикс — обычный текст (номер, дата, имя автора) и экранируются.
    """
    return escape_html(prefix) + rich_to_html(title) + escape_html(suffix)


def render_list_items(
    items: list[tuple[str, object, str]], limit: int = PAGE_TEXT_LIMIT
) -> str:
    """Склеить пункты, не выходя за лимит сообщения.

    Считаем видимую длину: теги в лимит Telegram не входят, а экранированный
    символ остаётся одним видимым. Обрезаем «сырой» заголовок ДО рендера —
    срез готового HTML разрубил бы тег и уронил editMessageText.
    """
    blocks: list[str] = []
    used = 0
    for prefix, title, suffix in items:
        raw = "" if title is None else str(title)
        need = _utf16_len(prefix) + _utf16_len(raw) + _utf16_len(suffix)
        if used + need > limit:
            room = limit - used - _utf16_len(prefix) - _utf16_len(suffix)
            if room <= 0:
                break
            blocks.append(rich_list_item(prefix, raw[:room], suffix))
            break
        blocks.append(rich_list_item(prefix, raw, suffix))
        used += need
    return "\n".join(blocks)


def memory_entries(rows: list) -> list[str]:
    """Форматирует записи дневника, ограничивая тело и имя лимитом страницы.

    Имя обрезается до MEMORY_NAME_VIEW_MAX: full_name длиннее 64 символов
    раздувало бы запись, fit_entries выводил бы меньше восьми строк, а
    фиксированный offset следующей страницы навсегда терял недопоказанную.
    """
    def _truncate_utf16(s: str, max_len: int) -> str:
        """Обрезает строку до max_len UTF-16 единиц."""
        if _utf16_len(s) <= max_len:
            return s
        # Кодируем в UTF-16 и обрезаем
        encoded = s.encode("utf-16-le")
        truncated = encoded[: max_len * 2].decode("utf-16-le", errors="ignore")
        return truncated.rstrip() + "…"

    entries: list[str] = []
    for row in rows:
        body = row["body"] or ""
        if _utf16_len(body) > MEMORY_BODY_VIEW_MAX:
            body = _truncate_utf16(body, MEMORY_BODY_VIEW_MAX - 1)
        display_name = row["display_name"] or "Один из вас"
        if _utf16_len(display_name) > MEMORY_NAME_VIEW_MAX:
            display_name = _truncate_utf16(display_name, MEMORY_NAME_VIEW_MAX - 1)
        entries.append(f"{row['day']} · {display_name}\n{body}")
    return entries


class Form(StatesGroup):
    join_code = State()
    task = State()
    date_title = State()
    date_day = State()
    memory = State()
    wish = State()


ALL_FORMS = StateFilter(
    Form.join_code,
    Form.task,
    Form.date_title,
    Form.date_day,
    Form.memory,
    Form.wish,
)


# --------------------------------------------------------------------- утилиты


def name_of(user) -> str:
    return user.full_name or user.first_name or "Без имени"


async def safe_edit(
    message: Message | None,
    text: str,
    markup: InlineKeyboardMarkup | None = None,
    *,
    html: bool = False,
) -> None:
    """Редактировать сообщение, не падая на «message is not modified».

    ``html=True`` включает разбор разметки: текст должен быть уже собран через
    :func:`duoplan.richtext.rich_to_html` (там же экранирование), иначе
    Telegram вернёт 400 на первом же «<» из пользовательского ввода.
    """
    if message is None:
        return
    kwargs: dict = {"reply_markup": markup}
    # parse_mode передаём только для HTML-текстов: обычные сообщения остаются
    # plain-текстом, и «<» в них не ломает отправку.
    if html:
        kwargs["parse_mode"] = "HTML"
    try:
        await message.edit_text(text, **kwargs)
    except TelegramBadRequest as exc:
        if "message is not modified" in str(exc).lower():
            return
        raise


def parse_tail(data: str | None, prefix: str) -> tuple[int, int] | None:
    """Безопасно разобрать ``prefix:<id>[:<page>]`` из callback_data."""
    if not data or not data.startswith(prefix):
        return None
    parts = data[len(prefix):].split(":")
    try:
        values = [int(part) for part in parts]
    except (TypeError, ValueError):
        return None
    if any(value < 0 for value in values):
        return None
    if len(values) == 1:
        return values[0], 0
    if len(values) == 2:
        return values[0], values[1]
    return None


async def invite_link(bot, code: str) -> str:
    try:
        me = await bot.me()
    except Exception:  # pragma: no cover - сеть/Telegram
        return ""
    username = getattr(me, "username", None)
    return f"https://t.me/{username}?start={code}" if username else ""


# ---------------------------------------------------------------------- тексты


def welcome_text() -> str:
    return (
        "DuoPlan · пространство для двоих\n\n"
        "Здесь живут ваши общие планы, важные даты, воспоминания и желания. "
        "А небольшой ритуал дня помогает не терять друг друга в буднях.\n\n"
        "Создайте пространство и пригласите партнёра или войдите по его коду."
    )


def display_streak(user, today: date) -> int:
    """Серия для вывода: пропущенный день уже её прервал.

    ``users.streak`` хранит последнее достигнутое значение до следующей
    отметки ритуала, поэтому при ``last_activity`` старше вчерашнего дня
    показываем 0, а не устаревшее число.
    """
    if user is None:
        return 0
    streak = int(user["streak"] or 0)
    if streak <= 0:
        return 0
    try:
        last = date.fromisoformat(str(user["last_activity"]))
    except (TypeError, ValueError):
        return 0
    return streak if (today - last).days in (0, 1) else 0


def home_text(pair, user, today: date) -> str:
    points = user["points"] if user is not None else 0
    streak = display_streak(user, today)
    level, next_xp, missing = level_for(points)
    title, symbol = title_for(level)
    return (
        f"Наше пространство · {pair['name1']} и {pair['name2']}\n\n"
        f"{symbol} Статус: {title}\n"
        f"Ваши очки: {points} XP · серия {streak} дн.\n"
        f"До уровня {level + 1}: {missing} XP (отметка на {next_xp} XP)\n\n"
        "Что добавим в ваш общий ритм сегодня?"
    )


def waiting_text(pair, link: str) -> str:
    text = (
        "Ваше пространство готово и ждёт партнёра.\n\n"
        f"Код для партнёра: {pair['code']}"
    )
    if link:
        text += f"\nИли отправьте ссылку: {link}"
    return text + "\n\nПосле входа партнёра откройте /menu."


# ------------------------------------------------------------------ навигация


async def send_home(message: Message, service: DuoPlanService, user_id: int) -> None:
    pair = await service.membership(user_id)
    if pair is None:
        await message.answer(welcome_text(), reply_markup=START_MENU)
        return
    if not pair["user_b"]:
        # Владелец пустой пары видит своё пространство и код, а не приветствие.
        await message.answer(
            waiting_text(pair, await invite_link(message.bot, pair["code"])),
            reply_markup=PAIR_MENU,
        )
        return
    user = await service.user(user_id)
    await message.answer(home_text(pair, user, service.local_today()), reply_markup=MAIN_MENU)


async def edit_home(call: CallbackQuery, service: DuoPlanService) -> None:
    pair = await service.membership(call.from_user.id)
    if pair is None:
        await safe_edit(call.message, welcome_text(), START_MENU)
        return
    if not pair["user_b"]:
        await safe_edit(
            call.message,
            waiting_text(pair, await invite_link(call.bot, pair["code"])),
            PAIR_MENU,
        )
        return
    user = await service.user(call.from_user.id)
    await safe_edit(call.message, home_text(pair, user, service.local_today()), MAIN_MENU)


# -------------------------------------------------------------------- команды


@router.message(CommandStart())
async def start(message: Message, service: DuoPlanService, state: FSMContext) -> None:
    await state.clear()
    code = message.text.partition(" ")[2].strip() if message.text else ""
    if code:
        member = await service.membership(message.from_user.id)
        if member is not None:
            await message.answer(
                "Вы уже в пространстве. Выйти из пары пока нельзя, "
                "поэтому новый код не применяю.",
            )
        elif await service.join_pair(message.from_user.id, name_of(message.from_user), code):
            await message.answer("Готово — теперь у вас одно пространство на двоих.")
        else:
            await message.answer(
                "Этот код недоступен. Проверьте его или попросите партнёра "
                "прислать приглашение ещё раз."
            )
    await send_home(message, service, message.from_user.id)


@router.message(Command("menu"))
async def menu(message: Message, service: DuoPlanService, state: FSMContext) -> None:
    await state.clear()
    await send_home(message, service, message.from_user.id)


@router.message(Command("help"))
async def help_command(message: Message, settings: Settings) -> None:
    name = settings.bot_name or "DuoPlan"
    await message.answer(
        f"{name} работает в личном чате с ботом.\n\n"
        "Создайте пространство, передайте партнёру код или ссылку-приглашение. "
        "После соединения вам станут доступны планы, даты, дневник, вишлист и ритуал дня.\n\n"
        "Команды: /menu — главное меню, /cancel — отменить ввод, /help — помощь."
    )


@router.message(Command("cancel"))
async def cancel(message: Message, service: DuoPlanService, state: FSMContext) -> None:
    if await state.get_state() is None:
        await message.answer("Сейчас ничего не вводится.")
        return
    await state.clear()
    pair = await service.membership(message.from_user.id)
    markup = MAIN_MENU if pair and pair["user_b"] else (PAIR_MENU if pair else START_MENU)
    await message.answer("Ввод отменён.", reply_markup=markup)


# ----------------------------------------------------------------------- пара


@router.callback_query(F.data == "pair:create")
async def create_pair(call: CallbackQuery, service: DuoPlanService) -> None:
    pair = await service.membership(call.from_user.id)
    if pair and pair["user_b"]:
        await call.answer("Пространство уже настроено")
        await edit_home(call, service)
        return
    try:
        code = pair["code"] if pair else await service.create_pair(
            call.from_user.id, name_of(call.from_user)
        )
    except ValidationError as exc:
        await call.answer(str(exc))
        return
    link = await invite_link(call.bot, code)
    await safe_edit(
        call.message,
        f"Пространство создано. Код для партнёра:\n\n{code}"
        + (f"\n\nИли отправьте ссылку: {link}" if link else "")
        + "\n\nПосле входа партнёра откройте /menu.",
        PAIR_MENU,
    )
    await call.answer()


@router.callback_query(F.data == "pair:invite")
async def invite(call: CallbackQuery, service: DuoPlanService) -> None:
    pair = await service.membership(call.from_user.id)
    if pair is None:
        await call.answer("Сначала создайте пространство")
        return
    if pair["user_b"]:
        # Заполненной паре код уже не нужен.
        await call.answer("Партнёр уже с вами — код не нужен")
        await edit_home(call, service)
        return
    link = await invite_link(call.bot, pair["code"])
    await safe_edit(
        call.message,
        f"Код приглашения: {pair['code']}" + (f"\n\n{link}" if link else ""),
        PAIR_MENU,
    )
    await call.answer()


@router.callback_query(F.data == "pair:join")
async def join_pair(call: CallbackQuery, service: DuoPlanService, state: FSMContext) -> None:
    if await service.membership(call.from_user.id) is not None:
        await call.answer("Вы уже в пространстве")
        await edit_home(call, service)
        return
    await state.set_state(Form.join_code)
    await safe_edit(call.message, "Введите код приглашения из восьми символов. Для отмены: /cancel")
    await call.answer()


@router.message(StateFilter(Form.join_code), F.text)
async def receive_code(message: Message, service: DuoPlanService, state: FSMContext) -> None:
    code = normalize_code(message.text)
    if len(code) != CODE_LENGTH:
        await message.answer(
            f"Код состоит из {CODE_LENGTH} символов. Пришлите код из приглашения или /cancel."
        )
        return
    if await service.join_pair(message.from_user.id, name_of(message.from_user), code):
        await state.clear()
        await message.answer("Вы на связи. Пространство теперь общее!")
        await send_home(message, service, message.from_user.id)
        return
    if await service.membership(message.from_user.id) is not None:
        await state.clear()
        await message.answer(
            "Вы уже участник пространства — второй код не применяю. "
            "Показать ваше пространство: /menu."
        )
        await send_home(message, service, message.from_user.id)
        return
    await message.answer(
        "Не получилось войти по этому коду. Проверьте код и попробуйте ещё раз "
        "или отправьте /cancel."
    )


@router.callback_query(F.data == "menu:home")
async def home(call: CallbackQuery, service: DuoPlanService) -> None:
    await edit_home(call, service)
    await call.answer()


@router.callback_query(F.data == "menu:pair")
async def pair_info(call: CallbackQuery, service: DuoPlanService) -> None:
    pair = await service.membership(call.from_user.id)
    if not pair:
        await call.answer("Сначала создайте пространство")
        return
    if not pair["user_b"]:
        await safe_edit(
            call.message,
            waiting_text(pair, await invite_link(call.bot, pair["code"])),
            PAIR_MENU,
        )
        await call.answer()
        return
    user = await service.user(call.from_user.id)
    level, _, _ = level_for(pair["together_pts"])
    title, symbol = title_for(level)
    streak = display_streak(user, service.local_today())
    await safe_edit(
        call.message,
        f"{pair['name1']} и {pair['name2']}\n\n"
        f"Вместе в DuoPlan с {pair['started_at']}\n"
        f"Общий запас: {pair['together_pts']} XP\n"
        f"{symbol} Общий уровень: {level} · {title}\n"
        f"Личная серия: {streak} дн.",
        HOME_MENU,
    )
    await call.answer()


# ------------------------------------------------------------------- разделы


async def _guard_pair(call: CallbackQuery, service: DuoPlanService):
    pair = await service.pair_for(call.from_user.id)
    if pair is None:
        await safe_edit(call.message, "Сначала соедините пространство.", START_MENU)
        return None
    return pair


async def tasks_view(call: CallbackQuery, service: DuoPlanService, page: int = 0) -> bool:
    pair = await _guard_pair(call, service)
    if pair is None:
        return False
    rows = await service.tasks(
        pair["id"], limit=PAGE_SIZE + 1, offset=page * PAGE_SIZE, viewer_id=call.from_user.id
    )
    has_next = len(rows) > PAGE_SIZE
    rows = rows[:PAGE_SIZE]

    if rows:
        items = [
            (f"{index + 1 + page * PAGE_SIZE}. ", row["title"], "")
            for index, row in enumerate(rows)
        ]
        text = "Наши планы\n\n" + render_list_items(items)
    elif page == 0:
        text = "Наши планы\n\nПока свободно. Добавьте первый общий шаг."
    else:
        text = "Наши планы\n\nНа этой странице планов нет."

    buttons = [
        [button(f"Готово: {rich_to_plain(row['title'])[:22]}", f"task:done:{row['id']}:{page}")]
        for row in rows
    ]
    buttons.append([button("Добавить план", "add:tasks")])
    pager = pager_row("tasks", page, page > 0, has_next)
    if pager:
        buttons.append(pager)
    buttons.append([button("В наше пространство", "menu:home")])
    await safe_edit(
        call.message,
        text,
        InlineKeyboardMarkup(inline_keyboard=buttons),
        html=True,
    )
    return True


async def dates_view(call: CallbackQuery, service: DuoPlanService, page: int = 0) -> bool:
    pair = await _guard_pair(call, service)
    if pair is None:
        return False
    rows = await service.dates(
        pair["id"], limit=PAGE_SIZE + 1, offset=page * PAGE_SIZE, viewer_id=call.from_user.id
    )
    has_next = len(rows) > PAGE_SIZE
    rows = rows[:PAGE_SIZE]

    if rows:
        items = [(f"{row['day']} · ", row["title"], "") for row in rows]
        text = "Значимые даты\n\n" + render_list_items(items)
    elif page == 0:
        text = "Значимые даты\n\nДобавьте дату, которую хочется беречь."
    else:
        text = "Значимые даты\n\nНа этой странице дат нет."

    buttons = [[button("Добавить дату", "add:dates")]]
    pager = pager_row("dates", page, page > 0, has_next)
    if pager:
        buttons.append(pager)
    buttons.append([button("В наше пространство", "menu:home")])
    await safe_edit(
        call.message,
        text,
        InlineKeyboardMarkup(inline_keyboard=buttons),
        html=True,
    )
    return True


async def memories_view(call: CallbackQuery, service: DuoPlanService, page: int = 0) -> bool:
    pair = await _guard_pair(call, service)
    if pair is None:
        return False
    rows = await service.memories(pair["id"], limit=PAGE_SIZE + 1, offset=page * PAGE_SIZE)
    has_next = len(rows) > PAGE_SIZE
    rows = rows[:PAGE_SIZE]

    header = "Общий дневник"
    rendered = fit_entries(header, memory_entries(rows))
    has_next = has_next or len(rendered) < len(rows)
    if rendered:
        # Каждая запись — отдельный блок: незакрытый маркер в одной записи
        # не «протекает» в следующую, а цитата в теле остаётся цитатой.
        text = header + "\n\n" + "\n\n".join(rich_to_html(entry) for entry in rendered)
    elif page == 0:
        text = (
            "Общий дневник\n\n"
            "Здесь появятся ваши маленькие истории и важные моменты."
        )
    else:
        text = "Общий дневник\n\nНа этой странице записей нет."

    buttons = [[button("Добавить запись", "add:memories")]]
    pager = pager_row("memories", page, page > 0, has_next)
    if pager:
        buttons.append(pager)
    buttons.append([button("В наше пространство", "menu:home")])
    await safe_edit(
        call.message,
        text,
        InlineKeyboardMarkup(inline_keyboard=buttons),
        html=True,
    )
    return True


async def wishes_view(call: CallbackQuery, service: DuoPlanService, page: int = 0) -> bool:
    pair = await _guard_pair(call, service)
    if pair is None:
        return False
    rows = await service.wishes(pair["id"], limit=PAGE_SIZE + 1, offset=page * PAGE_SIZE)
    has_next = len(rows) > PAGE_SIZE
    rows = rows[:PAGE_SIZE]

    if rows:
        items = [
            ("• ", row["body"], f" — {row['display_name'] or 'Один из вас'}")
            for row in rows
        ]
        text = "Вишлист\n\n" + render_list_items(items)
    elif page == 0:
        text = "Вишлист\n\nДобавьте желание — большое или совсем маленькое."
    else:
        text = "Вишлист\n\nНа этой странице желаний нет."

    buttons = [
        [button(f"Исполнено: {rich_to_plain(row['body'])[:19]}", f"wish:done:{row['id']}:{page}")]
        for row in rows
        if row["owner_id"] == call.from_user.id
    ]
    buttons.append([button("Добавить желание", "add:wishes")])
    pager = pager_row("wishes", page, page > 0, has_next)
    if pager:
        buttons.append(pager)
    buttons.append([button("В наше пространство", "menu:home")])
    await safe_edit(
        call.message,
        text,
        InlineKeyboardMarkup(inline_keyboard=buttons),
        html=True,
    )
    return True


LIST_VIEWS = {
    "tasks": tasks_view,
    "dates": dates_view,
    "memories": memories_view,
    "wishes": wishes_view,
}


@router.callback_query(F.data.in_({"menu:tasks", "menu:dates", "menu:memories", "menu:wishes"}))
async def sections(call: CallbackQuery, service: DuoPlanService) -> None:
    handled = await LIST_VIEWS[call.data.split(":", 1)[1]](call, service, 0)
    await call.answer(None if handled else "Сначала соедините пространство")


@router.callback_query(F.data.startswith("list:"))
async def paginate(call: CallbackQuery, service: DuoPlanService) -> None:
    parts = (call.data or "").split(":")
    if len(parts) != 3 or parts[1] not in LIST_VIEWS:
        await call.answer("Кнопка устарела")
        return
    try:
        page = int(parts[2])
    except ValueError:
        await call.answer("Кнопка устарела")
        return
    if page < 0:
        await call.answer("Кнопка устарела")
        return
    handled = await LIST_VIEWS[parts[1]](call, service, page)
    await call.answer(None if handled else "Сначала соедините пространство")


# --------------------------------------------------------------------- ритуал


@router.callback_query(F.data == "menu:game")
async def game(call: CallbackQuery, service: DuoPlanService) -> None:
    pair = await service.pair_for(call.from_user.id)
    if not pair:
        await call.answer("Сначала соедините пространство")
        return
    daily = await service.daily(pair["id"], call.from_user.id)
    text = f"Ритуал дня · {daily['day']}\n\n{daily['action']}"
    if daily["done"]:
        text += "\n\nСегодняшний ритуал уже отмечен. До завтра!"
    elif daily["partner_done"]:
        # Партнёр отметил, а этот пользователь — нет: кнопка остаётся, иначе
        # он видит «уже отмечено» и теряет свои +10 XP.
        text += "\n\nПартнёр уже отметил ритуал — отметьте и вы."
    await safe_edit(call.message, text, HOME_MENU if daily["done"] else GAME_MENU)
    await call.answer()


@router.callback_query(F.data == "game:done")
async def game_done(call: CallbackQuery, service: DuoPlanService) -> None:
    pair = await service.pair_for(call.from_user.id)
    if not pair:
        await call.answer("Сначала соедините пространство")
        return
    completed = await service.complete_daily(pair["id"], call.from_user.id)
    daily = await service.daily(pair["id"], call.from_user.id)
    if completed:
        # Кнопка и текст отражают фактический результат, а не ожидание.
        await call.answer("+10 XP · ритуал отмечен")
        tail = "Сегодняшний ритуал отмечен. +10 XP в личную копилку и в общий запас."
    else:
        await call.answer("Сегодня уже отмечено")
        tail = "Сегодняшний ритуал уже отмечен. До завтра!"
    await safe_edit(
        call.message,
        f"Ритуал дня · {daily['day']}\n\n{daily['action']}\n\n{tail}",
        HOME_MENU,
    )


# ------------------------------------------------------------- завершение дел


@router.callback_query(F.data.startswith("task:done:"))
async def task_done(call: CallbackQuery, service: DuoPlanService) -> None:
    pair = await service.pair_for(call.from_user.id)
    if not pair:
        await call.answer("Сначала соедините пространство")
        return
    parsed = parse_tail(call.data, "task:done:")
    if parsed is None or parsed[0] <= 0:
        await call.answer("Кнопка устарела")
        return
    task_id, page = parsed
    done = await service.complete_task(task_id, pair["id"], call.from_user.id)
    await call.answer("План завершён" if done else "План уже закрыт")
    await tasks_view(call, service, page)


@router.callback_query(F.data.startswith("wish:done:"))
async def wish_done(call: CallbackQuery, service: DuoPlanService) -> None:
    pair = await service.pair_for(call.from_user.id)
    if not pair:
        await call.answer("Сначала соедините пространство")
        return
    parsed = parse_tail(call.data, "wish:done:")
    if parsed is None or parsed[0] <= 0:
        await call.answer("Кнопка устарела")
        return
    wish_id, page = parsed
    done = await service.complete_wish(wish_id, pair["id"], call.from_user.id)
    await call.answer("Желание исполнено" if done else "Желание уже закрыто")
    await wishes_view(call, service, page)


# ----------------------------------------------------------------------- ввод


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
    await safe_edit(call.message, prompt + "\n\nДля отмены: /cancel")
    await call.answer()


@router.message(StateFilter(Form.task), F.text)
async def receive_task(message: Message, service: DuoPlanService, state: FSMContext) -> None:
    pair = await service.pair_for(message.from_user.id)
    if not pair:
        await state.clear()
        await message.answer("Сначала соедините пространство.", reply_markup=START_MENU)
        return
    try:
        await service.add_task(pair["id"], message.text, message.from_user.id)
    except ValidationError as exc:
        await message.answer(f"{exc}\n\nПопробуйте ещё раз или /cancel.")
        return
    await state.clear()
    await message.answer("План добавлен в ваше пространство.", reply_markup=section_menu("tasks"))


@router.message(StateFilter(Form.date_title), F.text)
async def receive_date_title(message: Message, state: FSMContext) -> None:
    title = (message.text or "").strip()
    if not title:
        await message.answer("Название не может быть пустым. Попробуйте ещё раз или /cancel.")
        return
    if len(title) > DATE_TITLE_MAX:
        await message.answer(
            f"Название длиннее {DATE_TITLE_MAX} символов. Сократите его или /cancel."
        )
        return
    await state.update_data(title=title)
    await state.set_state(Form.date_day)
    await message.answer("Введите дату в формате ДД.ММ или ДД.ММ.ГГГГ.")


def parse_date_input(raw: str, current_year: int) -> str:
    """Разобрать ``ДД.ММ`` или ``ДД.ММ.ГГГГ`` в ISO-дату; иначе ValueError.

    Год в трёхкомпонентном вводе принимается только четырьмя цифрами:
    ``31.12.24`` — это не 2024 год, и молча превращать его в 24 год
    нашей эры нельзя.
    """
    raw_parts = raw.split(".")
    parts = [int(part) for part in raw_parts]
    if len(parts) == 2:
        year = current_year
        if parts[0] == 29 and parts[1] == 2:
            while not (year % 4 == 0 and (year % 100 != 0 or year % 400 == 0)):
                year += 1
        parts.append(year)
    if len(parts) != 3:
        raise ValueError
    if len(raw_parts) == 3 and len(raw_parts[2]) != 4:
        raise ValueError
    return date(parts[2], parts[1], parts[0]).isoformat()


@router.message(StateFilter(Form.date_day), F.text)
async def receive_date_day(message: Message, service: DuoPlanService, state: FSMContext) -> None:
    raw = (message.text or "").strip()
    try:
        day = parse_date_input(raw, service.local_today().year)
    except ValueError:
        await message.answer(
            "Не распознал дату. Попробуйте ещё раз: ДД.ММ или ДД.ММ.ГГГГ (год — четырьмя цифрами)."
        )
        return

    data = await state.get_data()
    pair = await service.pair_for(message.from_user.id)
    if not pair:
        await state.clear()
        await message.answer("Сначала соедините пространство.", reply_markup=START_MENU)
        return
    try:
        await service.add_date(pair["id"], data.get("title", ""), day, 1)
    except ValidationError as exc:
        await message.answer(f"{exc}\n\nПопробуйте ещё раз или /cancel.")
        return
    await state.clear()
    await message.answer("Дата сохранена.", reply_markup=section_menu("dates"))


@router.message(StateFilter(Form.memory), F.text)
async def receive_memory(message: Message, service: DuoPlanService, state: FSMContext) -> None:
    pair = await service.pair_for(message.from_user.id)
    if not pair:
        await state.clear()
        await message.answer("Сначала соедините пространство.", reply_markup=START_MENU)
        return
    try:
        await service.add_memory(pair["id"], message.from_user.id, message.text)
    except ValidationError as exc:
        await message.answer(f"{exc}\n\nПопробуйте ещё раз или /cancel.")
        return
    await state.clear()
    await message.answer("Момент сохранён в дневнике.", reply_markup=section_menu("memories"))


@router.message(StateFilter(Form.wish), F.text)
async def receive_wish(message: Message, service: DuoPlanService, state: FSMContext) -> None:
    pair = await service.pair_for(message.from_user.id)
    if not pair:
        await state.clear()
        await message.answer("Сначала соедините пространство.", reply_markup=START_MENU)
        return
    try:
        await service.add_wish(pair["id"], message.from_user.id, message.text)
    except ValidationError as exc:
        await message.answer(f"{exc}\n\nПопробуйте ещё раз или /cancel.")
        return
    await state.clear()
    await message.answer("Желание добавлено.", reply_markup=section_menu("wishes"))


@router.message(ALL_FORMS)
async def receive_non_text(message: Message) -> None:
    """Фото, стикер или голосовое в FSM больше не роняют обработчик."""
    await message.answer(
        "Сейчас жду текст сообщением. Отправьте текст или /cancel, чтобы выйти из ввода."
    )


@router.message()
async def fallback(message: Message) -> None:
    await message.answer(
        "Откройте пространство через /menu или используйте /cancel, "
        "чтобы выйти из текущего ввода."
    )
