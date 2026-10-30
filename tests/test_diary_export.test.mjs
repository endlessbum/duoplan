// Резервная копия дневника: POST /api/diary/export (worker.js).
//
// diaryExportMessages собирает записи дневника в сообщения <= 3800 UTF-16
// единиц (лимит Telegram 4096, запас под заголовок/хвост), экранирует имена
// и рендерит тела через richToHtml. Проверяем chunking, заголовок, хвост
// при капе сообщений и обрезку раздутой экранированием записи.
//
// Запуск: node --test tests/test_diary_export.test.mjs
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { deepStrictEqual, equal, ok } from "node:assert/strict";
import { test } from "node:test";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const source = readFileSync(join(root, "worker.js"), "utf8");

function extractBraced(declaration) {
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

function extractLine(prefix) {
  const start = source.indexOf(prefix);
  if (start === -1) throw new Error(`${prefix} не найдено`);
  const end = source.indexOf("\n", start);
  return source.slice(start, end);
}

const load = new Function(
  [
    'const clean = (value) => String(value ?? "").trim();',
    extractLine("const DIARY_EXPORT_MESSAGE_LIMIT"),
    extractLine("const DIARY_EXPORT_MAX_MESSAGES"),
    extractBraced("function escapeHtml"),
    extractLine("const RICH_TOKENS"),
    extractBraced("function richInline"),
    extractBraced("function cutUtf16"),
    extractBraced("function richToHtml"),
    extractBraced("function diaryExportMessages"),
    "return { diaryExportMessages, cutUtf16, DIARY_EXPORT_MESSAGE_LIMIT, DIARY_EXPORT_MAX_MESSAGES, escapeHtml };"
  ].join("\n")
);
const { diaryExportMessages, cutUtf16, DIARY_EXPORT_MESSAGE_LIMIT, DIARY_EXPORT_MAX_MESSAGES } = load();

test("пустой дневник — одно короткое сообщение без заголовка-счётчика", () => {
  const messages = diaryExportMessages([]);
  deepStrictEqual(messages, ["В вашем дневнике пока нет записей."]);
});

test("записи рендерятся с датой, именем и rich-разметкой, заголовок — в первом сообщении", () => {
  const messages = diaryExportMessages([
    { day: "2026-10-01", display_name: "Аня <3", body: "**вечер** у реки" }
  ]);
  equal(messages.length, 1);
  ok(messages[0].startsWith("Общий дневник — резервная копия, записей: 1"), messages[0]);
  ok(messages[0].includes("2026-10-01 · Аня &lt;3"), "имя экранировано");
  ok(messages[0].includes("<b>вечер</b> у реки"), "разметка тела отрендерена");
});

test("каждое сообщение укладывается в лимит Telegram", () => {
  const rows = Array.from({ length: 60 }, (_, i) => ({
    day: `2026-01-${String((i % 28) + 1).padStart(2, "0")}`,
    display_name: "Тест",
    body: "Запись ".repeat(120) + String(i) // ~840 символов на запись
  }));
  const messages = diaryExportMessages(rows);
  ok(messages.length > 1, "ожидается несколько сообщений");
  for (const text of messages) {
    // length в JS — UTF-16 единицы, как и лимит Telegram.
    ok(text.length <= 4096, `сообщение ${text.length} > 4096`);
  }
});

test("запись, раздутая экранированием, обрезается и не роняет sendMessage", () => {
  // 2000 символов «<» после валидации превращаются в ~8000 единиц разметки.
  const messages = diaryExportMessages([
    { day: "2026-10-02", display_name: "Тест", body: "<".repeat(2000) }
  ]);
  equal(messages.length, 1);
  ok(messages[0].length <= 4096, `сообщение ${messages[0].length} > 4096`);
});

test("кап сообщений: хвост сообщает о неполной выгрузке", () => {
  const rows = Array.from({ length: 400 }, (_, i) => ({
    day: "2026-10-03",
    display_name: "Тест",
    body: "Запись ".repeat(300) + String(i) // ~2100 символов, ~1 запись на сообщение
  }));
  const messages = diaryExportMessages(rows);
  equal(messages.length, DIARY_EXPORT_MAX_MESSAGES);
  ok(messages[messages.length - 1].includes("только часть дневника"), messages.at(-1));
  for (const text of messages) ok(text.length <= 4096);
});

test("cutUtf16 режет по UTF-16 единицам и не рвёт суррогатные пары", () => {
  const emoji = "🎄".repeat(10); // 20 единиц
  equal([...cutUtf16(emoji, 20)].length, 10);
  // 19 единиц — 9 целых эмодзи, десятый не влезает целиком.
  equal([...cutUtf16(emoji, 19)].length, 9);
  equal(cutUtf16("abc", 10), "abc");
});
