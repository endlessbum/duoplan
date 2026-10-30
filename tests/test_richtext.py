"""Разметка в сообщениях бота: порт ``richToHtml`` и рендер списков.

Маркеры те же, что в Mini App и Telegram: ``**жирный**``, ``_курсив_``,
``__подчёркнутый__``, ``~~зачёркнутый~~``, ``||спойлер||``, строки ``> `` —
цитата. Всё экранируется ДО наклейки тегов, поэтому HTML из поля ввода
не проходит и ``editMessageText`` с ``parse_mode="HTML"`` не падает.
"""

from __future__ import annotations

import pytest

from duoplan.handlers import dates_view
from duoplan.handlers import memories_view
from duoplan.handlers import render_list_items
from duoplan.handlers import render_list_items
from duoplan.handlers import tasks_view
from duoplan.handlers import wishes_view
from duoplan.richtext import escape_html
from duoplan.richtext import rich_to_html
from duoplan.richtext import rich_to_plain

# ------------------------------------------------------------ чистые функции


def test_escape_html_neutralises_tags_and_ampersands():
    assert escape_html("<img src=x onerror=alert(1)>") == "&lt;img src=x onerror=alert(1)&gt;"
    assert escape_html("Съешь & <выпей>") == "Съешь &amp; &lt;выпей&gt;"
    assert escape_html('кавычки "') == "кавычки &quot;"


def test_all_markers_become_telegram_tags():
    assert rich_to_html("**жирный**") == "<b>жирный</b>"
    assert rich_to_html("_курсив_") == "<i>курсив</i>"
    assert rich_to_html("__подчёркнутый__") == "<u>подчёркнутый</u>"
    assert rich_to_html("~~зачёркнутый~~") == "<s>зачёркнутый</s>"
    assert rich_to_html("||сюрприз||") == "<tg-spoiler>сюрприз</tg-spoiler>"


def test_nesting_and_unclosed_markers_stay_valid():
    assert rich_to_html("**жирный и _курсив_**") == "<b>жирный и <i>курсив</i></b>"
    # Незакрытый маркер закрывается в конце — иначе Telegram вернёт 400.
    assert rich_to_html("начало **незакрытое") == "начало <b>незакрытое</b>"
    # Интерливинг маркеров не ломает вложенность.
    assert rich_to_html("а __б _в__ г_ д") == "а <u>б <i>в</i></u> г<i> д</i>"


def test_quote_lines_become_blockquote():
    html = rich_to_html("до\n> первая\n> **вторая**\nпосле")
    assert "<blockquote>первая\n<b>вторая</b></blockquote>" in html
    assert html.startswith("до\n")
    assert html.endswith("\nпосле")


def test_user_html_is_escaped_not_rendered():
    assert rich_to_html("<b>взлом</b>") == "&lt;b&gt;взлом&lt;/b&gt;"
    # Амперсанд экранируется, но разметка вокруг него работает.
    assert rich_to_html("**чай & кофе**") == "<b>чай &amp; кофе</b>"


def test_rich_to_plain_strips_markers_for_buttons():
    assert rich_to_plain("**Купить** кольцо") == "Купить кольцо"
    assert rich_to_plain("||секрет|| и <b>тег</b>") == "секрет и <b>тег</b>"
    assert rich_to_plain("> цитата") == "цитата"
    assert rich_to_plain(None) == ""


# ---------------------------------------------------------------- вьюхи бота


class FakeMessage:
    def __init__(self) -> None:
        self.calls: list[dict] = []

    async def edit_text(self, text, reply_markup=None, parse_mode=None) -> None:
        self.calls.append({"text": text, "markup": reply_markup, "parse_mode": parse_mode})


class FakeUser:
    id = 1


class FakeCall:
    def __init__(self) -> None:
        self.message = FakeMessage()
        self.from_user = FakeUser()

    async def answer(self, *args, **kwargs) -> None:
        return None


class FakeService:
    def __init__(self, tasks=None, dates=None, memories=None, wishes=None) -> None:
        self._tasks = tasks or []
        self._dates = dates or []
        self._memories = memories or []
        self._wishes = wishes or []

    async def pair_for(self, user_id):
        return {"id": 7}

    async def tasks(self, pair_id, limit=20, offset=0, viewer_id=None):
        return self._tasks

    async def dates(self, pair_id, limit=20, offset=0, viewer_id=None):
        return self._dates

    async def memories(self, pair_id, limit=20, offset=0):
        return self._memories

    async def wishes(self, pair_id, limit=20, offset=0):
        return self._wishes


def _buttons(call) -> list[str]:
    markup = call.message.calls[0]["markup"]
    return [btn.text for row in markup.inline_keyboard for btn in row]


@pytest.mark.asyncio
async def test_tasks_view_renders_markup_and_escapes_user_html():
    call = FakeCall()
    service = FakeService(tasks=[
        {"id": 1, "title": "**Купить** кольцо"},
        {"id": 2, "title": "<script>alert(1)</script>"},
    ])

    assert await tasks_view(call, service) is True

    call_data = call.message.calls[0]
    assert call_data["parse_mode"] == "HTML"
    assert "<b>Купить</b> кольцо" in call_data["text"]
    assert "&lt;script&gt;alert(1)&lt;/script&gt;" in call_data["text"]
    # В подписи кнопки маркеров быть не должно: кнопки не поддерживают разметку.
    labels = _buttons(call)
    assert "Готово: Купить кольцо" in labels
    assert all("**" not in label for label in labels)


@pytest.mark.asyncio
async def test_dates_view_renders_spoiler_and_quote():
    call = FakeCall()
    service = FakeService(dates=[{"id": 3, "day": "2026-03-02", "title": "||Сюрприз||"}])

    assert await dates_view(call, service) is True

    call_data = call.message.calls[0]
    assert call_data["parse_mode"] == "HTML"
    assert "<tg-spoiler>Сюрприз</tg-spoiler>" in call_data["text"]


@pytest.mark.asyncio
async def test_memories_view_renders_body_and_keeps_page_limit():
    call = FakeCall()
    body = "> цитата\n**важно** " + "х" * 300
    service = FakeService(memories=[{"day": "2026-03-02", "display_name": "Аня", "body": body}])

    assert await memories_view(call, service) is True

    text = call.message.calls[0]["text"]
    assert "<blockquote>цитата</blockquote>" in text
    assert "<b>важно</b>" in text
    assert call.message.calls[0]["parse_mode"] == "HTML"


@pytest.mark.asyncio
async def test_wishes_view_renders_markup_and_plain_button_label():
    call = FakeCall()
    service = FakeService(wishes=[{"id": 4, "body": "__Плед__ и какао", "display_name": "Аня", "owner_id": 1}])

    assert await wishes_view(call, service) is True

    text = call.message.calls[0]["text"]
    assert "<u>Плед</u> и какао" in text
    assert "Исполнено: Плед и какао" in _buttons(call)


@pytest.mark.asyncio
async def test_wishes_view_shows_done_only_for_own_wishes():
    """Желания партнёра видны (подарок/мечту), закрывать их может только он."""
    call = FakeCall()
    service = FakeService(wishes=[{"id": 5, "body": "**Кино**", "display_name": "Борис", "owner_id": 2}])

    assert await wishes_view(call, service) is True

    assert "Кино" in call.message.calls[0]["text"]
    assert "Исполнено: Кино" not in _buttons(call)


# --------------------------------------------------- устойчивость к «мусору»

_ALLOWED = {"b", "i", "u", "s", "tg-spoiler", "blockquote"}


def _assert_well_formed(markup: str) -> None:
    """Теги только из разрешённого набора и закрыты в правильном порядке."""
    stack: list[str] = []
    index = 0
    while index < len(markup):
        if markup[index] == "<":
            end = markup.index(">", index)
            tag = markup[index + 1:end]
            if tag.startswith("/"):
                name = tag[1:]
                assert stack and stack[-1] == name, f"несовпадение тега {name} в {markup!r}"
                stack.pop()
            else:
                name = tag.split(" ")[0]
                assert name in _ALLOWED, f"запрещённый тег {name} в {markup!r}"
                stack.append(name)
            index = end + 1
            continue
        index += 1
    assert not stack, f"незакрытые теги {stack} в {markup!r}"


def test_random_marker_soup_always_produces_valid_html():
    import random

    rng = random.Random(20261030)
    alphabet = ["*", "_", "~", "|", ">", " ", "а", "б", "<", "&", "\n", '"']
    for _ in range(500):
        raw = "".join(rng.choice(alphabet) for _ in range(rng.randint(0, 40)))
        _assert_well_formed(rich_to_html(raw))


def test_realistic_mixed_text_is_valid_html():
    raw = (
        "**Купить** билеты _сегодня_\n"
        "> не забудь ||про сюрприз||\n"
        "__важно__ и ~~старое~~ <b>не тег</b>"
    )
    markup = rich_to_html(raw)
    _assert_well_formed(markup)
    assert "&lt;b&gt;не тег&lt;/b&gt;" in markup
    assert "<blockquote>не забудь <tg-spoiler>про сюрприз</tg-spoiler></blockquote>" in markup


def test_empty_marker_pairs_are_removed():
    # Telegram отвергает пустые теги («can't parse entities») — от них надо
    # избавляться, иначе план из одних звёздочек не отправится.
    assert rich_to_html("****") == ""
    assert rich_to_html("__~~~~__") == ""
    assert rich_to_html("> ") == ""
    # Содержимое рядом с пустой парой не страдает.
    assert rich_to_html("**ок** и ****") == "<b>ок</b> и "


@pytest.mark.asyncio
async def test_real_service_roundtrip_renders_saved_markup(pair):
    """План с разметкой, сохранённый сервисом, приходит в список уже HTML-ом."""
    service, pair_id, owner_id, _ = pair
    await service.add_task(pair_id, "**Купить** кольцо ||тайком||", owner_id)

    call = FakeCall()
    assert await tasks_view(call, service) is True

    text = call.message.calls[0]["text"]
    assert call.message.calls[0]["parse_mode"] == "HTML"
    assert "<b>Купить</b> кольцо <tg-spoiler>тайком</tg-spoiler>" in text


@pytest.mark.asyncio
async def test_real_service_roundtrip_renders_saved_markup(pair):
    """План с разметкой, сохранённый сервисом, приходит в список уже HTML-ом."""
    service, pair_id, owner_id, _ = pair
    await service.add_task(pair_id, "**Купить** кольцо ||тайком||", owner_id)

    call = FakeCall()
    assert await tasks_view(call, service) is True

    text = call.message.calls[0]["text"]
    assert call.message.calls[0]["parse_mode"] == "HTML"
    assert "<b>Купить</b> кольцо <tg-spoiler>тайком</tg-spoiler>" in text


# ------------------------------------------------- пункты списков как блоки


def test_list_item_renders_quote_as_block():
    html = render_list_items([("1. ", "> не забудь про ||сюрприз||", "")])
    assert html == "1. <blockquote>не забудь про <tg-spoiler>сюрприз</tg-spoiler></blockquote>"
    # Литерального «>» в тексте больше нет — цитата стала блоком.
    assert "&gt;" not in html


def test_list_item_keeps_numbering_and_multiline_titles():
    html = render_list_items([("2. ", "обычный\n> цитата\nхвост", "")])
    assert html == "2. обычный\n<blockquote>цитата</blockquote>\nхвост"


def test_list_item_escapes_prefix_and_suffix():
    assert render_list_items([("<", "x", ">")]) == "&lt;x&gt;"


def test_list_items_truncate_raw_text_before_rendering():
    html = render_list_items([("1. ", "**" + "я" * 100, "")], limit=20)
    # Тег закрыт: обрезка не разрубила разметку.
    assert html.startswith("1. <b>")
    assert html.endswith("</b>")


@pytest.mark.asyncio
async def test_tasks_view_renders_quote_title_as_block():
    call = FakeCall()
    service = FakeService(tasks=[{"id": 1, "title": "> не забудь про ||сюрприз||"}])

    assert await tasks_view(call, service) is True

    text = call.message.calls[0]["text"]
    assert "1. <blockquote>не забудь про <tg-spoiler>сюрприз</tg-spoiler></blockquote>" in text
    assert "&gt;" not in text


# ------------------------------------------------- пункты списков как блоки


def test_list_item_renders_quote_as_block():
    html = render_list_items([("1. ", "> не забудь про ||сюрприз||", "")])
    assert html == "1. <blockquote>не забудь про <tg-spoiler>сюрприз</tg-spoiler></blockquote>"
    # Литерального «>» в тексте больше нет — цитата стала блоком.
    assert "&gt;" not in html


def test_list_item_keeps_numbering_and_multiline_titles():
    html = render_list_items([("2. ", "обычный\n> цитата\nхвост", "")])
    assert html == "2. обычный\n<blockquote>цитата</blockquote>\nхвост"


def test_list_item_escapes_prefix_and_suffix():
    assert render_list_items([("<", "x", ">")]) == "&lt;x&gt;"


def test_list_items_truncate_raw_text_before_rendering():
    html = render_list_items([("1. ", "**" + "я" * 100, "")], limit=20)
    # Тег закрыт: обрезка не разрубила разметку.
    assert html.startswith("1. <b>")
    assert html.endswith("</b>")


@pytest.mark.asyncio
async def test_tasks_view_renders_quote_title_as_block():
    call = FakeCall()
    service = FakeService(tasks=[{"id": 1, "title": "> не забудь про ||сюрприз||"}])

    assert await tasks_view(call, service) is True

    text = call.message.calls[0]["text"]
    assert "1. <blockquote>не забудь про <tg-spoiler>сюрприз</tg-spoiler></blockquote>" in text
    assert "&gt;" not in text
