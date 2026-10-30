"""Telegram-разметка в текстах бота — порт ``richToHtml`` из ``worker.js``.

Пользователь набирает текст в Mini App (или прямо в чате) теми же маркерами,
что и в Telegram: ``**жирный**``, ``_курсив_``, ``__подчёркнутый__``,
``~~зачёркнутый~~``, ``||спойлер||``, строки с префиксом ``> `` — цитата.

Порядок операций важен: сначала экранируем ``& < > "``, и только потом
наклеиваем теги из фиксированного набора. Произвольный HTML из поля ввода
не проходит, а незакрытые маркеры закрываются автоматически — иначе
``sendMessage``/``editMessageText`` с ``parse_mode="HTML"`` вернул бы 400 и
сообщение просто не отправилось бы.

Цитата распознаётся только в начале строки (``> текст``) — как в самом
Telegram. Поэтому списки в боте собираются по пунктам: ``handlers.rich_list_item``
рендерит заголовок отдельным блоком и приписывает номер/дату/автора снаружи,
так что цитата с первой строки остаётся цитатой.
"""

from __future__ import annotations

import html
import re

# Порядок как в worker.js: ``__`` проверяется раньше ``_``, иначе
# подчёркивание съело бы первый символ жирного маркера.
RICH_TOKENS: tuple[tuple[str, str], ...] = (
    ("**", "b"),
    ("__", "u"),
    ("||", "tg-spoiler"),
    ("~~", "s"),
    ("_", "i"),
)

_TAG_RE = re.compile(r"<[^>]+>")
# Пустая пара тегов («****» → «<b></b>») Telegram разбирает с ошибкой
# «can't parse entities», поэтому вычищаем её — повторно, чтобы убрать
# вложенные пустышки вроде «<b><i></i></b>».
_EMPTY_TAG_RE = re.compile(r"<(b|i|u|s|tg-spoiler|blockquote)></\1>")


def escape_html(value: object) -> str:
    """Экранировать всё, что может быть принято за HTML-тег."""
    return (
        str(value if value is not None else "")
        .replace("&", "&amp;")
        .replace("<", "&lt;")
        .replace(">", "&gt;")
        .replace('"', "&quot;")
    )


def _rich_inline(escaped: str) -> str:
    """Развернуть маркеры одной строки (уже экранированной) в теги."""
    out: list[str] = []
    stack: list[tuple[str, str]] = []
    i = 0
    length = len(escaped)
    while i < length:
        token = None
        for marker, tag in RICH_TOKENS:
            if escaped.startswith(marker, i):
                token = (marker, tag)
                break
        if token is None:
            out.append(escaped[i])
            i += 1
            continue
        marker, tag = token
        # Балансировка как в HTML: закрывающий маркер закрывает и все вложенные
        # элементы — интерливинг «__а _б__ в_» не ломает структуру тегов.
        open_index = -1
        for index in range(len(stack) - 1, -1, -1):
            if stack[index][0] == marker:
                open_index = index
                break
        if open_index != -1:
            while len(stack) > open_index:
                out.append(f"</{stack.pop()[1]}>")
        else:
            out.append(f"<{tag}>")
            stack.append((marker, tag))
        i += len(marker)
    while stack:
        out.append(f"</{stack.pop()[1]}>")
    return "".join(out)


def rich_to_html(raw: object) -> str:
    """Собрать HTML-поднабор Telegram из текста с маркерами."""
    lines = escape_html(raw).split("\n")
    out: list[str] = []
    quote: list[str] | None = None

    def flush_quote() -> None:
        nonlocal quote
        if quote is None:
            return
        out.append("<blockquote>" + "\n".join(_rich_inline(line) for line in quote) + "</blockquote>")
        quote = None

    for line in lines:
        if line.startswith("&gt; "):
            quote = (quote or []) + [line[len("&gt; "):]]
            continue
        if line == "&gt;":
            quote = (quote or []) + [""]
            continue
        flush_quote()
        out.append(_rich_inline(line))
    flush_quote()
    markup = "\n".join(out)
    while True:
        cleaned = _EMPTY_TAG_RE.sub("", markup)
        if cleaned == markup:
            return markup
        markup = cleaned


def rich_to_plain(raw: object) -> str:
    """Текст без разметки — для подписей inline-кнопок.

    Кнопки не поддерживают ``parse_mode``, поэтому маркеры в них выглядели бы
    звёздочками. Прогоняем через тот же рендер и снимаем теги: получается ровно
    то, что пользователь увидел бы в сообщении.
    """
    return html.unescape(_TAG_RE.sub("", rich_to_html(raw)))
