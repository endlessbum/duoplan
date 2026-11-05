// Рендер Telegram-разметки в текстах: worker (richToHtml — HTML для
// sendMessage с parse_mode) и Mini App (renderRichText — client-side HTML).
// Один поднабор маркеров: **жирный**, _курсив_, __подчёркнутый__,
// ~~зачёркнутый~~, ||спойлер||, строки «> » — цитата. Всё экранируется
// ДО наклейки тегов — произвольный HTML в поля не проходит.
//
// Запуск: node tests/test_rich_text.test.mjs  (или node --test "tests/*.test.mjs")
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { deepStrictEqual, equal } from "node:assert/strict";
import { test } from "node:test";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");

function extractBracedFrom(source, declaration) {
  const start = source.indexOf(declaration);
  if (start === -1) throw new Error(`${declaration} не найдено`);
  let depth = 0;
  for (let j = source.indexOf("{", start); j < source.length; j++) {
    if (source[j] === "{") depth++;
    else if (source[j] === "}") {
      depth--;
      if (depth === 0) return source.slice(start, j + 1);
    }
  }
  throw new Error(`незакрытый блок: ${declaration}`);
}

// ------------------------------------------------------------------
// worker.js: richToHtml (parse_mode HTML)
// ------------------------------------------------------------------
const workerSource = readFileSync(join(root, "worker.js"), "utf8");
const loadWorkerRich = new Function(
  [
    'const DEFAULT_TZ = "Europe/Moscow";',
    "const RICH_TOKENS = " + workerSource.match(/const RICH_TOKENS = (\[\[.*\]\]);/)?.[1] + ";",
    extractBracedFrom(workerSource, "function escapeHtml"),
    extractBracedFrom(workerSource, "function richInline"),
    extractBracedFrom(workerSource, "function richToHtml"),
    "return { richToHtml, escapeHtml };"
  ].join("\n")
);
const { richToHtml } = loadWorkerRich();

test("worker richToHtml: экранирует HTML до тегов разметки", () => {
  equal(richToHtml("<img src=x onerror=alert(1)>"), "&lt;img src=x onerror=alert(1)&gt;");
  equal(richToHtml("Съешь & <выпей>"), "Съешь &amp; &lt;выпей&gt;");
});

test("worker richToHtml: все маркеры переводятся в Telegram-теги", () => {
  equal(richToHtml("**жирный**"), "<b>жирный</b>");
  equal(richToHtml("_курсив_"), "<i>курсив</i>");
  equal(richToHtml("__подчёркнутый__"), "<u>подчёркнутый</u>");
  equal(richToHtml("~~зачёркнутый~~"), "<s>зачёркнутый</s>");
  equal(richToHtml("||сюрприз||"), "<tg-spoiler>сюрприз</tg-spoiler>");
});

test("worker richToHtml: вложенность и незакрытые теги корректны", () => {
  equal(richToHtml("**жирный и _курсив_**"), "<b>жирный и <i>курсив</i></b>");
  // Незакрытый маркер закрывается в конце — sendMessage не вернёт 400.
  equal(richToHtml("начало **незакрытое"), "начало <b>незакрытое</b>");
  equal(richToHtml("а __б _в__ г_ д"), "а <u>б <i>в</i></u> г<i> д</i>");
});

test("worker richToHtml: цитатные строки собираются в blockquote", () => {
  const html = richToHtml("до\n> первая\n> **вторая**\nпосле");
  equal(html.includes("<blockquote>первая\n<b>вторая</b></blockquote>"), true);
  equal(html.startsWith("до\n"), true);
  equal(html.endsWith("\nпосле"), true);
});

// ------------------------------------------------------------------
// public/app.js: renderRichText (client HTML со спойлером и цитатой)
// ------------------------------------------------------------------
const appSource = readFileSync(join(root, "public/app.js"), "utf8");
const loadAppRich = new Function(
  [
    "const RICH_TOKENS = " + appSource.match(/const RICH_TOKENS = (\[\[.*\]\]);/)?.[1] + ";",
    extractBracedFrom(appSource, "function esc"),
    extractBracedFrom(appSource, "function richInline"),
    extractBracedFrom(appSource, "function renderRichText"),
    "return { renderRichText };"
  ].join("\n")
);
const { renderRichText } = loadAppRich();

test("app renderRichText: разметка в классы, XSS невозможен", () => {
  equal(renderRichText("**жирный**"), "<b>жирный</b>");
  equal(renderRichText("||секрет||"), '<span class="rich-spoiler" data-spoiler>секрет</span>');
  equal(renderRichText("<script>alert(1)</script>"), "&lt;script&gt;alert(1)&lt;/script&gt;");
  equal(renderRichText('кавычки " и & амперсанд'), "кавычки &quot; и &amp; амперсанд");
});

test("app renderRichText: цитата — blockquote в акцентном цвете (CSS-класс)", () => {
  const html = renderRichText("> строка цитаты");
  equal(html, '<blockquote class="rich-quote">строка цитаты</blockquote>');
});

test("app renderRichText: перенос строки сохраняется, незакрытые теги закрываются", () => {
  equal(renderRichText("строка один\nстрока два"), "строка один\nстрока два");
  equal(renderRichText("**незакрыто"), "<b>незакрыто</b>");
});

// ------------------------------------------------------------------
// public/app.js: applyFmtMarker — кнопки меню выделения
// ------------------------------------------------------------------
const loadFmt = new Function(
  [
    extractBracedFrom(appSource, "function replaceRange"),
    extractBracedFrom(appSource, "function applyFmtMarker"),
    "return { applyFmtMarker };"
  ].join("\n")
);
const { applyFmtMarker } = loadFmt();

function fakeField(value, start, end) {
  return {
    value,
    selectionStart: start,
    selectionEnd: end,
    focus() {},
    setSelectionRange(a, b) {
      this.selectionStart = a;
      this.selectionEnd = b;
    }
  };
}

test("меню форматирования: маркер оборачивает выделение и остаётся в поле", () => {
  const field = fakeField("привет мир", 0, 6);
  applyFmtMarker(field, "**");
  equal(field.value, "**привет** мир");
  equal(field.selectionStart, 2);
  equal(field.selectionEnd, 8);
});

test("меню форматирования: повторное нажатие снимает маркер", () => {
  const field = fakeField("**привет** мир", 2, 8);
  applyFmtMarker(field, "**");
  equal(field.value, "привет мир");
  equal(field.selectionStart, 0);
  equal(field.selectionEnd, 6);
});

test("меню форматирования: спойлер и подчёркивание — разные маркеры", () => {
  const spoiler = fakeField("секрет", 0, 6);
  applyFmtMarker(spoiler, "||");
  equal(spoiler.value, "||секрет||");
  const underline = fakeField("слово", 0, 5);
  applyFmtMarker(underline, "__");
  equal(underline.value, "__слово__");
});

test("меню форматирования: цитата ставит «> » каждой строке и снимается повтором", () => {
  const field = fakeField("первая\nвторая", 0, 13);
  applyFmtMarker(field, ">");
  equal(field.value, "> первая\n> вторая");
  applyFmtMarker(field, ">");
  equal(field.value, "первая\nвторая");
});

test("меню форматирования: пустое выделение ничего не меняет", () => {
  const field = fakeField("текст", 3, 3);
  applyFmtMarker(field, "**");
  equal(field.value, "текст");
});

test("worker richToHtml: пустые пары тегов вычищаются", () => {
  // «****» иначе превратилось бы в <b></b> и могло уронить разбор entities.
  equal(richToHtml("****"), "");
  equal(richToHtml("> "), "");
  equal(richToHtml("**ок** и ****"), "<b>ок</b> и ");
});
