from __future__ import annotations

import logging
import re
from datetime import date

from aiogram import Bot, F, Router
from aiogram.exceptions import TelegramAPIError, TelegramBadRequest
from aiogram.filters import Command, CommandStart, StateFilter
from aiogram.fsm.context import FSMContext
from aiogram.fsm.state import State, StatesGroup
from aiogram.types import (
    CallbackQuery,
    InaccessibleMessage,
    InlineKeyboardMarkup,
    Message,
    User,
)

from duoplan.config import Settings
from duoplan.game.levels import level_for, title_for
from duoplan.richtext import escape_html, rich_to_html, rich_to_plain
from duoplan.services import (
    DAILY_XP,
    DATE_TITLE_MAX,
    WISH_MAX,
    DuoPlanService,
    ValidationError,
    normalize_code,
)
from duoplan.ui import (
    GAME_MENU,
    HOME_MENU,
    LEAVE_CONFIRM_MENU,
    MAIN_MENU,
    PAIR_MENU,
    PAIRED_MENU,
    START_MENU,
    button,
    pager_row,
    section_menu,
)


def _utf16_len(s: str) -> int:
    """Длина строки в UTF-16 единицах, как считает Telegram API."""
    return len(s.encode("utf-16-le")) // 2


def _truncate_utf16(s: str, max_len: int) -> str:
    """Обрезать строку до max_len UTF-16 единиц; к усечённой добавляется «…».

    Срез по кодопоинтам здесь нельзя: при астральных символах (эмодзи) он
    укорачивает строку вдвое медленнее, чем растёт её UTF-16 длина, и
    «обрезка» превращается в no-op. Режем байты UTF-16-LE с errors="ignore":
    срез может попасть в середину суррогатной пары — обрубок отбрасывается,
    и результат гарантированно не длиннее ``max_len`` единиц.
    """
    if _utf16_len(s) <= max_len:
        return s
    # Срез до max_len - 1 единицы: appended «…» занимает ещё одну,
    # и результат гарантированно укладывается ровно в max_len.
    encoded = s.encode("utf-16-le")
    truncated = encoded[: (max_len - 1) * 2].decode("utf-16-le", errors="ignore")
    return truncated.rstrip() + "…"

log = logging.getLogger(__name__)

router = Router()
router.message.filter(F.chat.type == "private")
router.callback_query.filter(F.message.chat.type == "private")

PAGE_SIZE = 8
# Код приглашения — 4 байта в hex (worker.createPair).
CODE_LENGTH = 8
# Паритет с worker /api/pair/join (/^[A-F0-9]{8}$/): код — только hex, чтобы
# текст ошибки «код недоступен» не расходился между ботом и Mini App.
CODE_RE = re.compile(f"^[A-F0-9]{{{CODE_LENGTH}}}$")
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
    срез готового HTML разрубил бы тег и уронил editMessageText. Обрезка
    обязана идти по UTF-16 единицам (через _truncate_utf16), а не по
    кодопоинтам: иначе эмодзи-тяжёлый пункт не укорачивался бы и страница
    вылезала бы за лимит Telegram в 4096 единиц.
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
            blocks.append(rich_list_item(prefix, _truncate_utf16(raw, room), suffix))
            break
        blocks.append(rich_list_item(prefix, raw, suffix))
        used += need
    return "\n".join(blocks)


def format_day(value: object) -> str:
    """дд.мм.гггг для вывода дат, которые хранятся как гггг-мм-дд.

    Всё, что не похожее на ISO-дату (пустота, мусор), проходит как есть —
    как и formatDay в worker'е, чтобы в сообщении не всплыли «None/NaN».
    """
    text = str(value or "")
    if len(text) == 10 and text[4] == "-" and text[7] == "-":
        return f"{text[8:]}.{text[5:7]}.{text[:4]}"
    return text


def memory_entries(rows: list) -> list[str]:
    """Форматирует записи дневника, ограничивая тело и имя лимитом страницы.

    Имя обрезается до MEMORY_NAME_VIEW_MAX: full_name длиннее 64 символов
    раздувало бы запись, fit_entries выводил бы меньше восьми строк, а
    фиксированный offset следующей страницы навсегда терял недопоказанную.
    Обрезка — по UTF-16 единицам (_truncate_utf16), как считает Telegram.
    """
    entries: list[str] = []
    for row in rows:
        body = row["body"] or ""
        if _utf16_len(body) > MEMORY_BODY_VIEW_MAX:
            body = _truncate_utf16(body, MEMORY_BODY_VIEW_MAX)
        display_name = row["display_name"] or "Один из вас"
        if _utf16_len(display_name) > MEMORY_NAME_VIEW_MAX:
            display_name = _truncate_utf16(display_name, MEMORY_NAME_VIEW_MAX)
        entries.append(f"{format_day(row['day'])} · {display_name}\n{body}")
    return entries


class Form(StatesGroup):
    join_code = State()
    task = State()
    date_title = State()
    date_day = State()
    date_recurs = State()
    memory = State()
    wish = State()
    wish_comment = State()  # необязательное уточнение к желанию
    # Фло: логирование дня (интенсивность, сгустки, настроение, энергия,
    # симптомы, заметка, секс).
    flo_log_date = State()
    flo_log_flow = State()
    flo_log_clots = State()
    flo_log_mood = State()
    flo_log_energy = State()
    flo_log_symptoms = State()
    flo_log_note = State()
    flo_log_sex = State()
    # Фло: настройки (avg_cycle_length, avg_period_length, notify_*).
    flo_settings_cycle = State()
    flo_settings_period = State()
    flo_settings_notify = State()


ALL_FORMS = StateFilter(
    Form.join_code,
    Form.task,
    Form.date_title,
    Form.date_day,
    Form.date_recurs,
    Form.memory,
    Form.wish,
    Form.wish_comment,
    Form.flo_log_date,
    Form.flo_log_flow,
    Form.flo_log_clots,
    Form.flo_log_mood,
    Form.flo_log_energy,
    Form.flo_log_symptoms,
    Form.flo_log_note,
    Form.flo_log_sex,
    Form.flo_settings_cycle,
    Form.flo_settings_period,
    Form.flo_settings_notify,
)


# --------------------------------------------------------------------- утилиты


def _button_label(text: object, limit: int) -> str:
    """Подпись inline-кнопки: плоский текст без переносов строк.

    Telegram отклоняет ``\n`` в тексте кнопки (BUTTON_TEXT_INVALID), а название
    записи перевод строк содержать может — иначе весь экран списка падал бы
    неисправимо (аудит 2026-11-01).
    """
    return " ".join(rich_to_plain(text).split())[:limit]


def name_of(user: User) -> str:
    return user.full_name or user.first_name or "Без имени"


def _sender(message: Message) -> User:
    """Автор сообщения.

    В личном чате ``from_user`` есть всегда, но в типах aiogram он Optional —
    без явной проверки mypy считает каждое обращение к ``.id`` ошибкой.
    """
    if message.from_user is None:
        raise RuntimeError("Сообщение без отправителя")
    return message.from_user


def _require_bot(bot: Bot | None) -> Bot:
    """Бот из апдейта (в типах aiogram — Optional)."""
    if bot is None:
        raise RuntimeError("Апдейт без бота")
    return bot


def _bot(message: Message) -> Bot:
    """Бот, доставивший сообщение (в типах aiogram — Optional)."""
    return _require_bot(message.bot)


async def safe_edit(
    message: Message | InaccessibleMessage | None,
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
    # InaccessibleMessage — заглушка Telegram для недоступного сообщения:
    # редактировать нечего, но и падать незачем.
    if message is None or isinstance(message, InaccessibleMessage):
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


def parse_yes_no(raw: object) -> bool | None:
    """«Да/нет» для уточняющих вопросов FSM; ``None`` — ответ не распознан."""
    text = str(raw or "").strip().lower()
    if text in {"да", "давай", "конечно", "yes", "y", "д", "1", "+"}:
        return True
    if text in {"нет", "no", "n", "0", "-"}:
        return False
    return None


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


async def invite_link(bot: Bot, code: str) -> str:
    try:
        me = await bot.me()
    except TelegramAPIError as exc:
        # Сеть/Telegram недоступны: ссылка не критична, показываем только код,
        # но причину логируем — иначе пустая строка выглядит как «нет username».
        log.warning("invite_link: не удалось получить данные бота: %s", exc)
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
    if int(pair["awaiting_return"] or 0) == 1:
        # Код зарезервирован за вышедшим партнёром (last_partner): рассылать
        # его третьим лицам бессмысленно.
        text = (
            "Партнёр вышел из пространства. Оно ждёт его возвращения: "
            "код действует только для его аккаунта.\n\n"
            f"Код для возврата партнёра: {pair['code']}"
        )
        if link:
            text += f"\nСсылка: {link}"
        return text + "\n\nИзменения в пространстве заморожены до его возвращения."
    text = (
        "Ваше пространство готово и ждёт партнёра.\n\n"
        f"Код для партнёра: {pair['code']}"
    )
    if link:
        text += f"\nИли отправьте ссылку: {link}"
    return text + "\n\nПосле входа партнёра откройте /menu."

# ------------------------------------------------------------------ навигация


async def _home_content(event, user_id: int, service: DuoPlanService):
    """Текст и клавиатура главного экрана для send/edit вариантов.

    ``event`` — Message или CallbackQuery: ``bot`` нужен только для
    ссылки-приглашения, поэтому достаётся лениво в ветке пустой пары.
    """
    pair = await service.membership(user_id)
    if pair is None:
        return welcome_text(), START_MENU
    if not pair["user_b"]:
        # Владелец пустой пары видит своё пространство и код, а не приветствие.
        return waiting_text(
            pair, await invite_link(_require_bot(getattr(event, "bot", None)), pair["code"])
        ), PAIR_MENU
    user = await service.user(user_id)
    # «Сегодня» — в поясе пары (parity с worker displayStreak/dailyFor),
    # а не в поясе сервера бота.
    return home_text(pair, user, service.today_for(pair["timezone"])), MAIN_MENU


async def send_home(message: Message, service: DuoPlanService, user_id: int) -> None:
    text, markup = await _home_content(message, user_id, service)
    await message.answer(text, reply_markup=markup)


async def edit_home(call: CallbackQuery, service: DuoPlanService) -> None:
    text, markup = await _home_content(call, call.from_user.id, service)
    await safe_edit(call.message, text, markup)


# -------------------------------------------------------------------- команды


async def _try_join(message: Message, service: DuoPlanService, code: str) -> bool:
    """Войти по коду от имени автора сообщения; ValidationError — ответом."""
    return await service.join_pair(
        _sender(message).id,
        name_of(_sender(message)),
        code,
        notify=lambda chat_id, text: _bot(message).send_message(chat_id, text),
    )


@router.message(CommandStart())
async def start(message: Message, service: DuoPlanService, state: FSMContext) -> None:
    await state.clear()
    # split(None, 1) режет по любым пробелам (включая таб): partition(" ") на
    # «/start\tCODE» отдавал бы в код весь хвост с мусором.
    parts = message.text.split(None, 1) if message.text else []
    code = parts[1].strip() if len(parts) > 1 else ""
    if code:
        member = await service.membership(_sender(message).id)
        if member is not None:
            await message.answer(
                "Вы уже в пространстве, поэтому новый код не применяю. "
                "Если нужно сменить пару, сначала выйдите из текущей в "
                "приложении: «Наша пара» → «Выйти из пространства».",
            )
        else:
            try:
                joined = await _try_join(message, service, code)
            except ValidationError as exc:
                # Резерв кода за ушедшим: чужой аккаунт получает объяснение,
                # а не общий «код недоступен». Без return — send_home ниже
                # отдаёт клавиатуру: новичок с протухшей ссылкой оставался
                # без кнопок и был вынужден вторично отправлять /start.
                joined = False
                await message.answer(str(exc))
            if joined:
                await message.answer("Готово — теперь у вас одно пространство на двоих.")
            else:
                await message.answer(
                    "Этот код недоступен. Проверьте его или попросите партнёра "
                    "прислать приглашение ещё раз."
                )
    await send_home(message, service, _sender(message).id)


@router.message(Command("menu"))
async def menu(message: Message, service: DuoPlanService, state: FSMContext) -> None:
    await state.clear()
    await send_home(message, service, _sender(message).id)


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
    pair = await service.membership(_sender(message).id)
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
    link = await invite_link(_require_bot(call.bot), code)
    if pair and int(pair["awaiting_return"] or 0) == 1:
        # Код зарезервирован за ушедшим партнёром: generic-текст «Код для
        # партнёра» провоцировал рассылку его третьим лицам — waiting_text
        # честно объясняет, что код действует только для его аккаунта.
        await safe_edit(call.message, waiting_text(pair, link), PAIR_MENU)
        await call.answer()
        return
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
    link = await invite_link(_require_bot(call.bot), pair["code"])
    # Зарезервированный код не рассылаем как открытый: waiting_text объясняет
    # резерв (parity с _home_content, который это уже делает).
    text = waiting_text(pair, link) if int(pair["awaiting_return"] or 0) == 1 \
        else f"Код приглашения: {pair['code']}" + (f"\n\n{link}" if link else "")
    await safe_edit(call.message, text, PAIR_MENU)
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
    if not CODE_RE.fullmatch(code):
        await message.answer(
            f"Код должен состоять из {CODE_LENGTH} символов (A–F, 0–9). "
            "Пришлите код из приглашения или /cancel."
        )
        return
    try:
        joined = await _try_join(message, service, code)
    except ValidationError as exc:
        # Резерв кода за ушедшим: без обёртки исключение уходило бы в on_error,
        # пользователь молчал, а состояние FSM зависало до /cancel.
        await state.clear()
        await message.answer(str(exc))
        await send_home(message, service, _sender(message).id)
        return
    if joined:
        await state.clear()
        await message.answer("Вы на связи. Пространство теперь общее!")
        await send_home(message, service, _sender(message).id)
        return
    if await service.membership(_sender(message).id) is not None:
        await state.clear()
        await message.answer(
            "Вы уже участник пространства — второй код не применяю. "
            "Показать ваше пространство: /menu."
        )
        await send_home(message, service, _sender(message).id)
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
            waiting_text(pair, await invite_link(_require_bot(call.bot), pair["code"])),
            PAIR_MENU,
        )
        await call.answer()
        return
    user = await service.user(call.from_user.id)
    together = await service.together_points(pair["id"])
    level, _, _ = level_for(together)
    title, symbol = title_for(level)
    streak = display_streak(user, service.today_for(pair["timezone"]))
    await safe_edit(
        call.message,
        f"{pair['name1']} и {pair['name2']}\n\n"
        f"Вместе в DuoPlan с {format_day(pair['started_at'])}\n"
        f"Общий запас: {together} XP\n"
        f"{symbol} Общий уровень: {level} · {title}\n"
        f"Личная серия: {streak} дн.",
        PAIRED_MENU,
    )
    await call.answer()


# --------------------------------------------------------------- выход из пары

@router.callback_query(F.data == "pair:leave")
async def leave_ask(call: CallbackQuery, service: DuoPlanService) -> None:
    pair = await service.membership(call.from_user.id)
    if not pair:
        await call.answer("Сначала создайте пространство")
        return
    if not pair["user_b"]:
        # Ожидание партнёра: выходящий — единственный держатель, пространство
        # будет удалено целиком.
        await safe_edit(
            call.message,
            "Выйти и удалить пространство целиком? "
            "Все общие планы, даты, записи и списки будут удалены безвозвратно.",
            LEAVE_CONFIRM_MENU,
        )
    else:
        await safe_edit(
            call.message,
            "Выйти из пространства? Контент останется у партнёра, "
            "а код приглашения будет зарезервирован за вами.",
            LEAVE_CONFIRM_MENU,
        )
    await call.answer()


@router.callback_query(F.data == "pair:leave:no")
async def leave_no(call: CallbackQuery, service: DuoPlanService) -> None:
    await edit_home(call, service)
    await call.answer("Остались в пространстве")


@router.callback_query(F.data == "pair:leave:yes")
async def leave_yes(call: CallbackQuery, service: DuoPlanService) -> None:
    left = await service.leave_pair(
        call.from_user.id,
        notify=lambda chat_id, text: _require_bot(call.bot).send_message(chat_id, text),
    )
    if not left:
        await safe_edit(call.message, "Сначала соедините пространство.", START_MENU)
        await call.answer()
        return
    await safe_edit(
        call.message,
        "Вы вышли из пространства. Код можно применить снова — только этим же аккаунтом.",
        START_MENU,
    )
    await call.answer()


# ------------------------------------------------------------------- разделы


FROZEN_TEXT = (
    "Партнёр вышел из пространства — изменения будут доступны "
    "после его возвращения."
)


async def _viewable_pair(user_id: int, service: DuoPlanService):
    """Пара для чтения разделов.

   Parity с GET /api/state в worker.js: при awaiting_return контент
    остаётся читаемым, запись отсекают сервисные _ensure_pair_open.
    Свежая пара без второго участника (user_b=0, awaiting_return=0)
    по-прежнему считается «не соединённой».
    """
    member = await service.membership(user_id)
    if member is None:
        return None
    if not member["user_b"] and not int(member["awaiting_return"] or 0):
        return None
    return member


async def _write_pair(user_id: int, service: DuoPlanService):
    """Пара для записи: (pair|None, frozen). frozen отличает заморозку
    awaiting_return от «нет пары», чтобы не показывать неверный текст."""
    member = await service.membership(user_id)
    if member is None:
        return None, False
    if not member["user_b"] and not int(member["awaiting_return"] or 0):
        return None, False
    if int(member["awaiting_return"] or 0):
        return member, True
    return member, False


async def _guard_pair(call: CallbackQuery, service: DuoPlanService):
    pair = await _viewable_pair(call.from_user.id, service)
    if pair is None:
        await safe_edit(call.message, "Сначала соедините пространство.", START_MENU)
        return None
    return pair


async def _list_page(call: CallbackQuery, service: DuoPlanService, fetch):
    """Общий каркас списка: guard пары, страница ``PAGE_SIZE + 1`` строк,
    флаг ``has_next``. ``fetch(pair)`` — корутина выборки сервиса."""
    pair = await _guard_pair(call, service)
    if pair is None:
        return None, [], False
    rows = await fetch(pair)
    has_next = len(rows) > PAGE_SIZE
    return pair, rows[:PAGE_SIZE], has_next


# Заголовок, подсказка пустого первого экрана, существительное для
# «На этой странице … нет» и подпись кнопки добавления — у каждого раздела свои.
_SECTION_TEXT = {
    "tasks": ("Наши планы", "Пока свободно. Добавьте первый общий шаг.", "планов", "Добавить план"),
    "dates": ("Значимые даты", "Добавьте дату, которую хочется беречь.", "дат", "Добавить дату"),
    "memories": (
        "Общий дневник",
        "Здесь появятся ваши маленькие истории и важные моменты.",
        "записей",
        "Добавить запись",
    ),
    "wishes": (
        "Вишлист",
        "Добавьте желание — большое или совсем маленькое.",
        "желаний",
        "Добавить желание",
    ),
}


def _section_text(section: str, page: int, body: str | None) -> str:
    """Текст страницы раздела: тело списка или пустое состояние."""
    title, hint, noun, _add_label = _SECTION_TEXT[section]
    if body is not None:
        return f"{title}\n\n{body}"
    if page == 0:
        return f"{title}\n\n{hint}"
    return f"{title}\n\nНа этой странице {noun} нет."


async def _render_section(
    call: CallbackQuery,
    section: str,
    page: int,
    has_next: bool,
    text: str,
    action_rows: list[list] | None = None,
) -> bool:
    """Клавиатура и отправка страницы раздела: действия над строками,
    «Добавить», пейджер и возврат в пространство."""
    buttons = [row for row in (action_rows or []) if row]
    buttons.append([button(_SECTION_TEXT[section][3], f"add:{section}")])
    pager = pager_row(section, page, page > 0, has_next)
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


async def tasks_view(call: CallbackQuery, service: DuoPlanService, page: int = 0) -> bool:
    pair, rows, has_next = await _list_page(call, service, lambda pair: service.tasks(
        pair["id"], limit=PAGE_SIZE + 1, offset=page * PAGE_SIZE, viewer_id=call.from_user.id
    ))
    if pair is None:
        return False

    body = None
    if rows:
        items = [
            (f"{index + 1 + page * PAGE_SIZE}. ", row["title"], "")
            for index, row in enumerate(rows)
        ]
        body = render_list_items(items)
    action_rows = [
        [button(f"Готово: {_button_label(row['title'], 22)}", f"task:done:{row['id']}:{page}")]
        for row in rows
    ]
    return await _render_section(
        call, "tasks", page, has_next, _section_text("tasks", page, body), action_rows
    )


async def dates_view(call: CallbackQuery, service: DuoPlanService, page: int = 0) -> bool:
    pair, rows, has_next = await _list_page(call, service, lambda pair: service.dates(
        pair["id"], limit=PAGE_SIZE + 1, offset=page * PAGE_SIZE, viewer_id=call.from_user.id
    ))
    if pair is None:
        return False

    body = None
    if rows:
        # Косметический паритет с приложением: время, повтор и приватность.
        items = []
        for row in rows:
            keys = set(row.keys())
            prefix = f"{format_day(row['day'])}"
            if keys.issuperset({'time', 'monthly', 'recurs', 'is_private'}):
                if row["time"]:
                    prefix += f" {row['time']}"
                marks = []
                if int(row["monthly"] or 0) == 1:
                    marks.append("ежемесячная")
                elif int(row["recurs"] or 0) == 1:
                    marks.append("ежегодная")
                if int(row["is_private"] or 0) == 1:
                    marks.append("личное")
            else:
                marks = []
            suffix = f" · {', '.join(marks)}" if marks else ""
            items.append((f"{prefix} · ", row["title"], suffix))
        body = render_list_items(items)
    return await _render_section(
        call, "dates", page, has_next, _section_text("dates", page, body)
    )


async def memories_view(call: CallbackQuery, service: DuoPlanService, page: int = 0) -> bool:
    pair, rows, has_next = await _list_page(call, service, lambda pair: service.memories(
        pair["id"], limit=PAGE_SIZE + 1, offset=page * PAGE_SIZE
    ))
    if pair is None:
        return False

    header = _SECTION_TEXT["memories"][0]
    rendered = fit_entries(header, memory_entries(rows))
    has_next = has_next or len(rendered) < len(rows)
    body = None
    if rendered:
        # Каждая запись — отдельный блок: незакрытый маркер в одной записи
        # не «протекает» в следующую, а цитата в теле остаётся цитатой.
        body = "\n\n".join(rich_to_html(entry) for entry in rendered)
    return await _render_section(
        call, "memories", page, has_next, _section_text("memories", page, body)
    )


async def wishes_view(call: CallbackQuery, service: DuoPlanService, page: int = 0) -> bool:
    pair, rows, has_next = await _list_page(call, service, lambda pair: service.wishes(
        pair["id"], limit=PAGE_SIZE + 1, offset=page * PAGE_SIZE
    ))
    if pair is None:
        return False

    body = None
    if rows:
        items = [
            ("• ", row["body"], f" — {row['display_name'] or 'Один из вас'}")
            for row in rows
        ]
        body = render_list_items(items)
    action_rows = [
        [button(f"Исполнено: {_button_label(row['body'], 19)}", f"wish:done:{row['id']}:{page}")]
        for row in rows
        if row["owner_id"] == call.from_user.id
    ]
    return await _render_section(
        call, "wishes", page, has_next, _section_text("wishes", page, body), action_rows
    )


LIST_VIEWS = {
    "tasks": tasks_view,
    "dates": dates_view,
    "memories": memories_view,
    "wishes": wishes_view,
}


@router.callback_query(F.data.in_({"menu:tasks", "menu:dates", "menu:memories", "menu:wishes"}))
async def sections(call: CallbackQuery, service: DuoPlanService) -> None:
    # Фильтр выше гарантирует одно из значений; ``or ""`` — только для типа.
    section = (call.data or "").split(":", 1)[1]
    handled = await LIST_VIEWS[section](call, service, 0)
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
    # Подделанный callback с гигантским номером не должен уводить OFFSET в
    # миллионы (и сортировать весь набор пары ради пустой страницы).
    if page < 0 or page > 10000:
        await call.answer("Кнопка устарела")
        return
    handled = await LIST_VIEWS[parts[1]](call, service, page)
    await call.answer(None if handled else "Сначала соедините пространство")


# --------------------------------------------------------------------- ритуал


@router.callback_query(F.data == "menu:game")
async def game(call: CallbackQuery, service: DuoPlanService) -> None:
    pair = await _viewable_pair(call.from_user.id, service)
    if not pair:
        await call.answer("Сначала соедините пространство")
        return
    daily = await service.daily(pair["id"], call.from_user.id)
    text = f"Ритуал дня · {format_day(daily['day'])}\n\n{daily['action']}"
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
    pair, frozen = await _write_pair(call.from_user.id, service)
    if frozen:
        await call.answer(FROZEN_TEXT)
        return
    if not pair:
        await call.answer("Сначала соедините пространство")
        return
    completed = await service.complete_daily(pair["id"], call.from_user.id)
    daily = await service.daily(pair["id"], call.from_user.id)
    if completed:
        # Кнопка и текст отражают фактический результат, а не ожидание; XP —
        # из константы DAILY_XP, чтобы текст не разошёлся с начислением.
        await call.answer(f"+{DAILY_XP} XP · ритуал отмечен")
        tail = f"Сегодняшний ритуал отмечен. +{DAILY_XP} XP в вашу личную копилку."
    else:
        await call.answer("Сегодня уже отмечено")
        tail = "Сегодняшний ритуал уже отмечен. До завтра!"
    await safe_edit(
        call.message,
        f"Ритуал дня · {format_day(daily['day'])}\n\n{daily['action']}\n\n{tail}",
        HOME_MENU,
    )


# ------------------------------------------------------------- завершение дел


async def _done_item(
    call: CallbackQuery,
    service: DuoPlanService,
    prefix: str,
    complete,
    view,
    done_text: str,
    closed_text: str,
) -> None:
    """Общий каркас «отметить исполненным»: guard пары, разбор callback_data,
    условное завершение и перерисовка списка."""
    pair, frozen = await _write_pair(call.from_user.id, service)
    if frozen:
        await call.answer(FROZEN_TEXT)
        return
    if not pair:
        await call.answer("Сначала соедините пространство")
        return
    parsed = parse_tail(call.data, prefix)
    if parsed is None or parsed[0] <= 0:
        await call.answer("Кнопка устарела")
        return
    item_id, page = parsed
    done = await complete(item_id, pair["id"], call.from_user.id)
    await call.answer(done_text if done else closed_text)
    await view(call, service, page)


@router.callback_query(F.data.startswith("task:done:"))
async def task_done(call: CallbackQuery, service: DuoPlanService) -> None:
    await _done_item(
        call, service, "task:done:",
        service.complete_task, tasks_view, "План завершён", "План уже закрыт",
    )


@router.callback_query(F.data.startswith("wish:done:"))
async def wish_done(call: CallbackQuery, service: DuoPlanService) -> None:
    await _done_item(
        call, service, "wish:done:",
        service.complete_wish, wishes_view, "Желание исполнено", "Желание уже закрыто",
    )


# ----------------------------------------------------------------------- ввод


async def _guarded_write_pair(message: Message, service: DuoPlanService, state: FSMContext):
    """Пара для записи из текстового ввода.

    При заморозке или отсутствии пары сам очищает FSM и отвечает
    пользователю — обработчик получает ``None`` и просто выходит.
    """
    pair, frozen = await _write_pair(_sender(message).id, service)
    if frozen:
        await state.clear()
        await message.answer(FROZEN_TEXT)
        return None
    if not pair:
        await state.clear()
        await message.answer("Сначала соедините пространство.", reply_markup=START_MENU)
        return None
    return pair


async def _submit_item(
    message: Message, state: FSMContext, submit, success_text: str, section: str
) -> None:
    """Записать элемент раздела: ValidationError — подсказка, успех — экран раздела."""
    try:
        await submit()
    except ValidationError as exc:
        await message.answer(f"{exc}\n\nПопробуйте ещё раз или /cancel.")
        return
    await state.clear()
    await message.answer(success_text, reply_markup=section_menu(section))


@router.callback_query(F.data.in_({"add:tasks", "add:dates", "add:memories", "add:wishes"}))
async def add_item(call: CallbackQuery, service: DuoPlanService, state: FSMContext) -> None:
    pair, frozen = await _write_pair(call.from_user.id, service)
    if frozen:
        await call.answer(FROZEN_TEXT)
        return
    if not pair:
        await call.answer("Сначала соедините пространство")
        return
    prompts = {
        "add:tasks": (Form.task, "Какой план добавим? Одно понятное действие."),
        "add:dates": (Form.date_title, "Как называется эта дата?"),
        "add:memories": (Form.memory, "Запишите момент, который хочется сохранить."),
        "add:wishes": (Form.wish, "Чего вы хотите? Запишите одно желание."),
    }
    next_state, prompt = prompts[call.data or ""]
    await state.set_state(next_state)
    await safe_edit(call.message, prompt + "\n\nДля отмены: /cancel")
    await call.answer()


@router.message(StateFilter(Form.task), F.text)
async def receive_task(message: Message, service: DuoPlanService, state: FSMContext) -> None:
    pair = await _guarded_write_pair(message, service, state)
    if pair is None:
        return
    await _submit_item(
        message, state,
        lambda: service.add_task(pair["id"], message.text, _sender(message).id),
        "План добавлен в ваше пространство.", "tasks",
    )


@router.message(StateFilter(Form.date_title), F.text)
async def receive_date_title(message: Message, state: FSMContext) -> None:
    title = (message.text or "").strip()
    if not title:
        await message.answer("Название не может быть пустым. Попробуйте ещё раз или /cancel.")
        return
    # Лимит — кодпоинты, как worker.validateSchema и add_date ниже (UTF-16
    # мерял эмодзи двойным весом и отклонял валидные для приложения названия).
    if len(title) > DATE_TITLE_MAX:
        await message.answer(
            f"Название длиннее {DATE_TITLE_MAX} символов. Сократите его или /cancel."
        )
        return
    await state.update_data(title=title)
    await state.set_state(Form.date_day)
    await message.answer(
        "Введите дату в формате ДД.ММ или ДД.ММ.ГГГГ — после этого уточню, "
        "ежегодная ли она."
    )


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
    pair = await _guarded_write_pair(message, service, state)
    if pair is None:
        return
    raw = (message.text or "").strip()
    try:
        day = parse_date_input(raw, service.today_for(pair["timezone"]).year)
    except ValueError:
        await message.answer(
            "Не распознал дату. Попробуйте ещё раз: ДД.ММ или ДД.ММ.ГГГГ (год — четырьмя цифрами)."
        )
        return
    # 29 февраля существует не в каждом году: календарь и уведомления
    # пропускают эту дату в невисокосный год — предупреждаем сразу, а не
    # молча «теряем» напоминание.
    leap_note = (
        "\n\n29 февраля существует не в каждом году — напомню только в високосный."
        if day.endswith("-02-29") else ""
    )
    await state.update_data(day=day)
    await state.set_state(Form.date_recurs)
    await message.answer("Напоминать ежегодно? Ответьте «да» или «нет»." + leap_note)


@router.message(StateFilter(Form.date_recurs), F.text)
async def receive_date_recurs(message: Message, service: DuoPlanService, state: FSMContext) -> None:
    answer = parse_yes_no(message.text)
    if answer is None:
        await message.answer("Ответьте «да» или «нет» (или /cancel).")
        return
    data = await state.get_data()
    pair = await _guarded_write_pair(message, service, state)
    if pair is None:
        return
    title = data.get("title", "")
    day = data.get("day", "")
    if not title or not day:
        # FSM-данные истекли (TTL) или потерялись: без них add_date отклонит
        # ввод, а состояние останется — пользователь зациклится до /cancel.
        # Честно перезапускаем сценарий.
        await state.clear()
        await message.answer(
            "Ввод даты прерван — начните заново кнопкой «Добавить дату».",
            reply_markup=section_menu("dates"),
        )
        return
    try:
        await service.add_date(pair["id"], title, day, 1 if answer else 0, _sender(message).id)
    except ValidationError as exc:
        await message.answer(f"{exc}\n\nПопробуйте ещё раз или /cancel.")
        return
    await state.clear()
    tail = " Напомню каждый год." if answer else " Однократная: ежегодного напоминания не будет."
    await message.answer("Дата сохранена." + tail, reply_markup=section_menu("dates"))


@router.message(StateFilter(Form.memory), F.text)
async def receive_memory(message: Message, service: DuoPlanService, state: FSMContext) -> None:
    pair = await _guarded_write_pair(message, service, state)
    if pair is None:
        return
    await _submit_item(
        message, state,
        lambda: service.add_memory(pair["id"], _sender(message).id, message.text),
        "Момент сохранён в дневнике.", "memories",
    )


@router.message(StateFilter(Form.wish), F.text)
async def receive_wish(message: Message, service: DuoPlanService, state: FSMContext) -> None:
    pair = await _guarded_write_pair(message, service, state)
    if pair is None:
        return
    text = (message.text or "").strip()
    if not text or len(text) > WISH_MAX:
        await message.answer(
            f"Желание: не длиннее {WISH_MAX} символов. Попробуйте ещё раз или /cancel."
        )
        return
    # Уточнение спрашиваем отдельным шагом: пользователь может добавить
    # контекст подарка в момент публикации, а может сразу пропустить шаг.
    await state.update_data(wish_body=text)
    await state.set_state(Form.wish_comment)
    await message.answer(
        "Хотите уточнить? Напишите, какой именно подарок, размер, цвет или где "
        "его найти — или отправьте «-», чтобы сохранить без уточнения."
    )


@router.message(StateFilter(Form.wish_comment), F.text)
async def receive_wish_comment(message: Message, service: DuoPlanService,
                               state: FSMContext) -> None:
    pair = await _guarded_write_pair(message, service, state)
    if pair is None:
        return
    raw = (message.text or "").strip()
    comment = "" if raw.lower() in {"-", "—", "пропустить", "нет"} else raw
    data = await state.get_data()
    await _submit_item(
        message, state,
        lambda: service.add_wish(
            pair["id"], _sender(message).id, data.get("wish_body", ""), comment=comment
        ),
        "Желание добавлено.", "wishes",
    )


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


# ---------------------------------------------------------------------------
# Фло (трекер цикла) в боте: /flo, шеринг, уведомления партнёра, выгрузка, /flo_partner.
# Дневник симптомов и секс-логи здесь не ведутся: они только в Mini App.
# ---------------------------------------------------------------------------
from datetime import datetime as _flo_datetime  # noqa: E402

from aiogram.types import BufferedInputFile, InlineKeyboardButton, InlineKeyboardMarkup  # noqa: E402

from duoplan import cycle as flo  # noqa: E402


def _flo_keyboard(has_open: bool, share: dict) -> InlineKeyboardMarkup:
    period = InlineKeyboardButton(
        text="Завершить месячные" if has_open else "Отметить месячные",
        callback_data="flo:end" if has_open else "flo:start",
    )
    share_btn = InlineKeyboardButton(
        text="Выключить шеринг" if share["enabled"] else "Включить шеринг",
        callback_data="flo:share",
    )
    notify_btn = InlineKeyboardButton(
        text="Не уведомлять партнёра" if share["notify"] else "Уведомлять партнёра",
        callback_data="flo:notify",
    )
    export_btn = InlineKeyboardButton(text="Выгрузить файл", callback_data="flo:export")
    return InlineKeyboardMarkup(inline_keyboard=[[period], [share_btn], [notify_btn], [export_btn]])


async def _flo_view(service: DuoPlanService, tg_id: int) -> tuple[str, InlineKeyboardMarkup]:
    now_dt = _flo_datetime.now(service.tz)
    today = now_dt.date()
    profile = await flo.load_profile(service.db, tg_id, int(now_dt.timestamp()))
    periods = await flo.load_periods(service.db, tg_id)
    measurements = await flo.load_measurements(service.db, tg_id)
    forecast = flo.cycle_forecast(
        periods, today,
        profile["avg_cycle_length"], profile["avg_period_length"],
        profile.get("cycle_length_known", 0), measurements,
    )
    open_start = next((s for s, e, u in (flo._period_parts(p) for p in periods) if e is None and not u), None)
    share = await flo.share_state(service.db, tg_id)
    return flo.cycle_text(forecast, open_start), _flo_keyboard(open_start is not None, share)


# ---------------------------------------------------------------------------
# Фло: команды /flo_log (дневник) и /flo_settings (настройки).
# ---------------------------------------------------------------------------


@router.message(Command("flo_log"))
async def flo_log_start(message: Message, service: DuoPlanService, state: FSMContext) -> None:
    tg_id = _sender(message).id
    if not await flo.is_female(service.db, tg_id):
        await message.answer("Фло доступен только владелице календаря.")
        return
    await message.answer("Дневник дня. Введите дату в формате ГГГГ-ММ-ДД (например, 2026-11-12) или «сегодня».")
    await state.set_state(Form.flo_log_date)


@router.message(StateFilter(Form.flo_log_date), F.text)
async def flo_log_date(message: Message, service: DuoPlanService, state: FSMContext) -> None:
    text = message.text.strip().lower()
    try:
        if text == "сегодня":
            day = await user_today(service.db, _sender(message).id)
        else:
            day = date.fromisoformat(text)
    except ValueError:
        await message.answer("Проверьте дату (ГГГГ-ММ-ДД или «сегодня»).")
        return
    await state.update_data(log_date=day)
    await message.answer(
        "Интенсивность выделений (один код или пропустите):\n"
        "spotting (мажь), light (слабые), medium (средние), heavy (сильные)"
    )
    await state.set_state(Form.flo_log_flow)


@router.message(StateFilter(Form.flo_log_flow), F.text)
async def flo_log_flow(message: Message, state: FSMContext) -> None:
    text = message.text.strip().lower()
    if text in {"", "-", "пропустить", "нет"}:
        flow = None
    elif text in flo.FLOW_CODES:
        flow = text
    else:
        await message.answer("Неверный код. Введите один из: spotting, light, medium, heavy или пропустите.")
        return
    await state.update_data(log_flow=flow)
    await message.answer("Были ли сгустки? (да / нет или пропустите)")
    await state.set_state(Form.flo_log_clots)


@router.message(StateFilter(Form.flo_log_clots), F.text)
async def flo_log_clots(message: Message, state: FSMContext) -> None:
    text = message.text.strip().lower()
    if text in {"", "-", "пропустить"}:
        clots = None
    elif text in {"да", "yes", "y", "+"}:
        clots = True
    elif text in {"нет", "no", "n"}:
        clots = False
    else:
        await message.answer("Ответьте «да» или «нет» (или пропустите).")
        return
    await state.update_data(log_clots=clots)
    await message.answer(
        "Настроение (один код или пропустите):\n"
        "happy (радость), calm (спокойствие), sensitive (чувствительность), "
        "irritable (раздражительность), anxious (тревожность), sad (грусть), mood_swings (перепады)"
    )
    await state.set_state(Form.flo_log_mood)


@router.message(StateFilter(Form.flo_log_mood), F.text)
async def flo_log_mood(message: Message, state: FSMContext) -> None:
    text = message.text.strip().lower()
    if text in {"", "-", "пропустить", "нет"}:
        mood = None
    elif text in flo.MOOD_CODES:
        mood = text
    else:
        await message.answer("Неверный код. Введите один из: happy, calm, sensitive, irritable, anxious, sad, mood_swings или пропустите.")
        return
    await state.update_data(log_mood=mood)
    await message.answer(
        "Энергия (один код или пропустите):\n"
        "very_low (очень низкая), low (низкая), normal (обычная), high (высокая)"
    )
    await state.set_state(Form.flo_log_energy)


@router.message(StateFilter(Form.flo_log_energy), F.text)
async def flo_log_energy(message: Message, state: FSMContext) -> None:
    text = message.text.strip().lower()
    if text in {"", "-", "пропустить", "нет"}:
        energy = None
    elif text in flo.ENERGY_CODES:
        energy = text
    else:
        await message.answer("Неверный код. Введите один из: very_low, low, normal, high или пропустите.")
        return
    await state.update_data(log_energy=energy)
    await message.answer(
        "Симптомы (коды через запятую, «не было», или пропустите):\n"
        "cramps, headache, bloating, breast_tenderness, fatigue, acne, nausea, back_pain, dizziness, constipation, diarrhea, exercise, good_sleep, poor_sleep, water"
    )
    await state.set_state(Form.flo_log_symptoms)


@router.message(StateFilter(Form.flo_log_symptoms), F.text)
async def flo_log_symptoms(message: Message, state: FSMContext) -> None:
    text = message.text.strip().lower()
    # «не было» — явная отметка «сегодня симптомов не было», отличается
    # от пропуска (пропущенный день ничего не утверждает).
    symptoms_clear = text == "не было"
    if text in {"", "-", "пропустить", "нет", "не было"}:
        symptoms = []
    else:
        raw = [s.strip() for s in text.split(",")]
        symptoms = [s for s in raw if s in flo.SYMPTOM_CODES]
        if len(symptoms) != len(raw):
            await message.answer("Некоторые коды не распознаны и пропущены.")
    await state.update_data(log_symptoms=symptoms, log_symptoms_clear=symptoms_clear)
    await message.answer("Заметка (до 2000 символов или пропустите).")
    await state.set_state(Form.flo_log_note)


@router.message(StateFilter(Form.flo_log_note), F.text)
async def flo_log_note(message: Message, state: FSMContext) -> None:
    note = message.text[:2000] if message.text else ""
    await state.update_data(log_note=note)
    await message.answer(
        "Секс (protected, unprotected, none или пропустите — партнёру не передаётся)."
    )
    await state.set_state(Form.flo_log_sex)


@router.message(StateFilter(Form.flo_log_sex), F.text)
async def flo_log_sex(message: Message, service: DuoPlanService, state: FSMContext) -> None:
    text = message.text.strip().lower()
    if text in {"", "-", "пропустить", "нет"}:
        sex = None
    elif text in flo.SEX_CODES:
        sex = text
    else:
        await message.answer("Неверный код. Введите один из: protected, unprotected, none или пропустите.")
        return
    data = await state.get_data()
    await flo.upsert_log(
        service.db,
        _sender(message).id,
        data["log_date"],
        flow=data.get("log_flow"),
        mood=data.get("log_mood"),
        symptoms=data.get("log_symptoms"),
        note=data.get("log_note"),
        sex=sex,
        clots=data.get("log_clots") is True,
        energy=data.get("log_energy"),
        symptoms_clear=data.get("log_symptoms_clear") is True,
    )
    await message.answer("Дневник дня сохранён.")
    await state.clear()


@router.message(Command("flo_settings"))
async def flo_settings_start(message: Message, service: DuoPlanService, state: FSMContext) -> None:
    tg_id = _sender(message).id
    if not await flo.is_female(service.db, tg_id):
        await message.answer("Фло доступен только владелице календаря.")
        return
    profile = await flo.load_profile(service.db, tg_id, int(datetime.now(service.tz).timestamp()))
    await message.answer(
        f"Средняя длина цикла (20–45 дней): {profile['avg_cycle_length']}\n"
        f"Средняя длительность месячных (2–10 дней): {profile['avg_period_length']}\n"
        "Изменить? Введите два числа через пробел (цикл месячные) или «нет»."
    )
    await state.set_state(Form.flo_settings_cycle)


@router.message(StateFilter(Form.flo_settings_cycle), F.text)
async def flo_settings_cycle(message: Message, service: DuoPlanService, state: FSMContext) -> None:
    text = message.text.strip().lower()
    if text in {"нет", "-", "пропустить"}:
        await state.clear()
        await message.answer("Настройки без изменений.")
        return
    parts = text.split()
    if len(parts) != 2:
        await message.answer("Два числа через пробел или «нет».")
        return
    try:
        cycle_len = int(parts[0])
        period_len = int(parts[1])
    except ValueError:
        await message.answer("Числа должны быть целыми.")
        return
    if not (20 <= cycle_len <= 45) or not (2 <= period_len <= 10):
        await message.answer("Цикл 20–45 дней, месячные 2–10 дней.")
        return
    now = int(datetime.now(service.tz).timestamp())
    await flo.update_profile(service.db, _sender(message).id, {"avg_cycle_length": cycle_len, "avg_period_length": period_len}, now)
    await message.answer("Средние значения обновлены. Настройки напоминаний? (вкл/выкл или «нет»)")
    await state.set_state(Form.flo_settings_notify)


@router.message(StateFilter(Form.flo_settings_notify), F.text)
async def flo_settings_notify(message: Message, service: DuoPlanService, state: FSMContext) -> None:
    text = message.text.strip().lower()
    if text in {"нет", "-", "пропустить"}:
        await state.clear()
        await message.answer("Напоминания без изменений.")
        return
    enabled = text in {"вкл", "да", "yes", "1", "включить"}
    now = int(datetime.now(service.tz).timestamp())
    await flo.update_profile(service.db, _sender(message).id, {"notify_enabled": 1 if enabled else 0}, now)
    await message.answer("Напоминания обновлены.")
    await state.clear()


# ---------------------------------------------------------------------------
# Фло: команды /flo, /flo_partner (существующие, без изменений).
# ---------------------------------------------------------------------------


@router.message(Command("flo"))
async def flo_command(message: Message, service: DuoPlanService) -> None:
    tg_id = _sender(message).id
    if not await flo.is_female(service.db, tg_id):
        await message.answer("Фло доступен только владелице календаря.")
        return
    text, keyboard = await _flo_view(service, tg_id)
    await message.answer(text, reply_markup=keyboard)


@router.message(Command("flo_partner"))
async def flo_partner_command(message: Message, service: DuoPlanService) -> None:
    tg_id = _sender(message).id
    today = _flo_datetime.now(service.tz).date()
    for owner_id in await flo.partner_ids(service.db, tg_id):
        text = await flo.partner_view_text(service.db, owner_id, today)
        if text:
            await message.answer(text)
            return
    await message.answer("Партнёрша пока не делится календарём")


@router.callback_query(F.data.in_({"flo:start", "flo:end", "flo:share", "flo:notify", "flo:export"}))
async def flo_action(call: CallbackQuery, service: DuoPlanService) -> None:
    tg_id = call.from_user.id
    if not await flo.is_female(service.db, tg_id):
        await call.answer("Фло доступен только владелице", show_alert=True)
        return
    now_dt = _flo_datetime.now(service.tz)
    stamp = int(now_dt.timestamp())
    today = now_dt.date()
    if call.data == "flo:export":
        data = await flo.export_json(service.db, tg_id, stamp)
        if call.message:
            await call.message.answer_document(BufferedInputFile(data, filename="flo-export.json"), caption="Фло: выгрузка")
        await call.answer()
        return
    if call.data == "flo:start":
        await flo.mark_period(service.db, tg_id, today, None, stamp)
    elif call.data == "flo:end":
        if not await flo.close_open_period(service.db, tg_id, today, stamp):
            await call.answer("Открытых месячных нет", show_alert=True)
            return
    elif call.data == "flo:share":
        share = await flo.share_state(service.db, tg_id)
        await flo.set_share(service.db, tg_id, not share["enabled"], stamp)
    elif call.data == "flo:notify":
        share = await flo.share_state(service.db, tg_id)
        await flo.set_share_notify(service.db, tg_id, not share["notify"], stamp)
    text, keyboard = await _flo_view(service, tg_id)
    if call.message:
        await call.message.answer(text, reply_markup=keyboard)
    await call.answer()
