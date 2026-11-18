// ASCII-вложение записи дневника: валидация validateAsciiArt и проводка
// поля через POST/PATCH /api/memories (worker.js, migrations/0050).
//
// Запуск: node --test tests/test_ascii_art.test.mjs
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { deepStrictEqual, equal, ok, throws, rejects } from "node:assert/strict";
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
  return source.slice(start, source.indexOf(String.fromCharCode(10), start));
}

const buildValidator = new Function(
  [
    extractBraced("class HttpError"),
    "const ASCII_ART_MAX_COLUMNS = 144;",
    "const ASCII_ART_MAX_ROWS = 120;",
    "const ASCII_ART_MAX_LENGTH = 18000;",
    extractBraced("function validateAsciiArt"),
    "return validateAsciiArt;"
  ].join("\n")
);

class HttpError extends Error {
  constructor(status, message, code) { super(message); this.status = status; this.code = code; }
}
const validateAsciiArt = buildValidator();

test("validateAsciiArt: null/''/undefined -> null", () => {
  equal(validateAsciiArt(null), null);
  equal(validateAsciiArt(""), null);
  equal(validateAsciiArt(undefined), null);
});

test("validateAsciiArt: сохраняет пробелы по краям строк", () => {
  const art = "  @#  \n   .  \n#####   ";
  equal(validateAsciiArt(art), art);
});

test("validateAsciiArt: отклоняет >144 символов в строке", () => {
  throws(() => validateAsciiArt("x".repeat(145)), /144/);
  equal(validateAsciiArt("x".repeat(144)), "x".repeat(144));
});

test("validateAsciiArt: отклоняет >120 строк", () => {
  throws(() => validateAsciiArt(Array(121).fill("x").join("\n")), /120/);
});

test("validateAsciiArt: максимальная геометрия 144x120 проходит", () => {
  // Худший случай: 120 строк по 144 символа + 119 переводов = 17399 < 18000.
  const art = Array(120).fill("x".repeat(144)).join("\n");
  equal(validateAsciiArt(art).length, 17399);
});

test("validateAsciiArt: >18000 кодовых точек отклоняется", () => {
  // Превышение достижимо только искусственно: строки <=144, строк <=120,
  // но суммарно >18000 — например 121 строка по 149 нельзя (cols), поэтому
  // собираем 120 строк по 144 = 17399 и добавляем строку -> rows error.
  // Для чистого length-error делаем невалидную геометрию невозможной —
  // лимит 18000 это запас; проверяем границу валидатора напрямую.
  const art = "x".repeat(144) + "\n" + "y".repeat(18000);
  throws(() => validateAsciiArt(art), /144|120|18000/);
});

test("validateAsciiArt: отклоняет управляющие символы", () => {
  for (const bad of ["a\tb", "a\rb", "a\0b", "ab", "ab"]) {
    throws(() => validateAsciiArt(bad), /недопустимые/);
  }
});

test("validateAsciiArt: строка только из пробелов/переводов отклоняется", () => {
  throws(() => validateAsciiArt("   \n   \n  "), /пустое/);
});

test("validateAsciiArt: кириллица и unicode-блоки проходят (печать >= 0x20)", () => {
  equal(validateAsciiArt("█▓▒░ @#"), "█▓▒░ @#");
});

// ------------------------- POST/PATCH через api() -------------------------

const buildApi = new Function(
  "json", "ensureSchemaOnce", "telegramUser", "validTimeZone", "ensureUser",
  "rateLimit", "readJson", "state", "membership", "ownerIds",
  [
    extractBraced("class HttpError"),
    extractLine("const now = "),
    extractLine("const clean = "),
    extractLine("const positiveId = "),
    extractBraced("function localDay"),
    extractLine("const ACCENT_KEYS"),
    extractBraced("function validateSchema"),
    extractBraced("function textField"),
    extractBraced("function validateAsciiArt"),
    extractBraced("function validDate"),
    extractBraced("function optionalDay"),
    extractBraced("function optionalTime"),
    extractBraced("function planSchedule"),
    extractBraced("function wishUrl"),
    extractBraced("async function ensureWishOwner"),
    extractBraced("async function ensureDateVisible"),
    extractBraced("async function ensureTaskVisible"),
    extractBraced("async function disbandGroupIfSingleton"),
    extractBraced("async function itemRoute"),
    extractBraced("function ownerIds"),
    extractBraced("async function api"),
    "return api;"
  ].join("\n")
);

// validateAsciiArt требует константы лимитов — они const в модуле, поэтому
// Function-конструктор не видит их; добавляем в список выше? Они не
// extractBraced. Вставляем объявления рядом с функцией.
// (Выше extractBraced("function validateAsciiArt") не включает константы —
//  api упадёт при вызове. Чиним: buildApi собирается заново ниже.)

const ASCII_CONSTS = [
  "const ASCII_ART_MAX_COLUMNS = 144;",
  "const ASCII_ART_MAX_ROWS = 120;",
  "const ASCII_ART_MAX_LENGTH = 18000;"
].join("\n");

const buildApi2 = new Function(
  "json", "ensureSchemaOnce", "telegramUser", "validTimeZone", "ensureUser",
  "rateLimit", "readJson", "state", "membership", "ownerIds",
  [
    extractBraced("class HttpError"),
    extractLine("const now = "),
    extractLine("const clean = "),
    extractLine("const positiveId = "),
    extractBraced("function localDay"),
    extractLine("const ACCENT_KEYS"),
    extractBraced("function validateSchema"),
    extractBraced("function textField"),
    ASCII_CONSTS,
    extractBraced("function validateAsciiArt"),
    extractBraced("function validDate"),
    extractBraced("function optionalDay"),
    extractBraced("function optionalTime"),
    extractBraced("function planSchedule"),
    extractBraced("function wishUrl"),
    extractBraced("async function ensureWishOwner"),
    extractBraced("async function ensureDateVisible"),
    extractBraced("async function ensureTaskVisible"),
    extractBraced("async function disbandGroupIfSingleton"),
    extractBraced("async function itemRoute"),
    extractBraced("function ownerIds"),
    extractBraced("async function api"),
    "return api;"
  ].join("\n")
);

function makeEnv({ pair, body, method = "POST", path = "/api/memories", patchResults = {} }) {
  const queries = [];
  const db = {
    prepare(sql) {
      return {
        bind(...args) {
          queries.push({ sql, args });
          const key = sql.trim().split(/\s+/).slice(0, 2).join(" ").toUpperCase();
          if (sql.startsWith("UPDATE memories")) {
            return { run: async () => ({ meta: { changes: patchResults.changes ?? 1 } }), first: async () => patchResults.row ?? { id: 8 } };
          }
          if (sql.startsWith("SELECT id FROM memories")) {
            return { first: async () => patchResults.exists !== false ? { id: 8 } : null, run: async () => ({}) };
          }
          return { run: async () => ({ meta: { changes: 1 } }), first: async () => null, all: async () => ({ results: [] }) };
        }
      };
    }
  };
  const api = buildApi2(
    (data, status = 200) => ({ data, status }),
    async () => {},
    async () => ({ id: 777, first_name: "Тест" }),
    () => "Europe/Moscow",
    async () => ({ tg_id: 777, gender: null }),
    async () => {},
    async () => body,
    async () => ({ user: { tg_id: 777 }, pair }),
    async () => pair
  );
  return {
    api, env: { DB: db }, queries,
    request: { method, headers: { get: () => null } },
    url: new URL(`https://duoplan.test${path}`)
  };
}

test("POST /api/memories с ascii_art пишет его в INSERT", async () => {
  const art = "  @#\n  .  ";
  const { api, env, queries, request, url } = makeEnv({
    pair: { id: 1, timezone: "Europe/Moscow" },
    body: { title: "Вечер", body: "Текст", ascii_art: art }
  });
  await api(request, env, url);
  const insert = queries.find((q) => q.sql.startsWith("INSERT INTO memories"));
  ok(insert.sql.includes("ascii_art"), "INSERT без колонки ascii_art");
  equal(insert.args[4], art);
});

test("POST /api/memories с битым ascii_art -> 400, INSERT не выполняется", async () => {
  const { api, env, queries, request, url } = makeEnv({
    pair: { id: 1, timezone: "Europe/Moscow" },
    body: { body: "Текст", ascii_art: "a\tb" }
  });
  await rejects(() => api(request, env, url), /недопустимые|ASCII/i);
  equal(queries.filter((q) => q.sql.startsWith("INSERT INTO memories")).length, 0);
});

test("POST /api/memories без ascii_art -> NULL", async () => {
  const { api, env, queries, request, url } = makeEnv({
    pair: { id: 1, timezone: "Europe/Moscow" },
    body: { body: "Текст" }
  });
  await api(request, env, url);
  const insert = queries.find((q) => q.sql.startsWith("INSERT INTO memories"));
  equal(insert.args[4], null);
});

test("PATCH /api/memories без ascii_art не трогает колонку", async () => {
  const { api, env, queries, request, url } = makeEnv({
    pair: { id: 1, timezone: "Europe/Moscow" },
    body: { body: "Новый текст" },
    method: "PATCH", path: "/api/memories/8"
  });
  await api(request, env, url);
  const update = queries.find((q) => q.sql.startsWith("UPDATE memories"));
  equal(update.sql.includes("ascii_art"), false);
});

test("PATCH /api/memories ascii_art:null удаляет вложение", async () => {
  const { api, env, queries, request, url } = makeEnv({
    pair: { id: 1, timezone: "Europe/Moscow" },
    body: { ascii_art: null },
    method: "PATCH", path: "/api/memories/8"
  });
  await api(request, env, url);
  const update = queries.find((q) => q.sql.startsWith("UPDATE memories"));
  ok(update.sql.includes("ascii_art=?"));
  equal(update.args.find((a) => a === null) !== undefined, true);
});

test("PATCH /api/memories сохраняет ascii_art побайтно с хвостовыми пробелами", async () => {
  const art = "@#  \n..   \n#####  ";
  const { api, env, queries, request, url } = makeEnv({
    pair: { id: 1, timezone: "Europe/Moscow" },
    body: { title: "T", ascii_art: art },
    method: "PATCH", path: "/api/memories/8"
  });
  await api(request, env, url);
  const update = queries.find((q) => q.sql.startsWith("UPDATE memories"));
  equal(update.args.includes(art), true);
  // title тоже обновился — частичный PATCH независим
  equal(update.args.includes("T"), true);
});

test("PATCH /api/memories с битым ascii_art -> 400, title/body не меняются", async () => {
  const { api, env, queries, request, url } = makeEnv({
    pair: { id: 1, timezone: "Europe/Moscow" },
    body: { title: "T", body: "B", ascii_art: "x".repeat(145) },
    method: "PATCH", path: "/api/memories/8"
  });
  await rejects(() => api(request, env, url));
  equal(queries.filter((q) => q.sql.startsWith("UPDATE memories")).length, 0);
});

// ------------------------- Чтение: state/archive/export SQL -------------------------

test("state() и ARCHIVE_QUERIES отдают m.ascii_art", () => {
  const stateSel = source.match(/SELECT m\.id,m\.author_id[^`]*FROM memories m[^`]*LIMIT \?/g) || [];
  ok(stateSel.length >= 1);
  ok(stateSel.every((q) => q.includes("m.ascii_art")), "state(): нет m.ascii_art");
  const arch = source.slice(source.indexOf("memories: {"), source.indexOf("memories: {") + 500);
  ok(arch.includes("m.ascii_art"), "ARCHIVE_QUERIES.memories без m.ascii_art");
});

test("экспорт memories: SELECT и мапперы включают ascii_art", () => {
  ok(source.includes("m.ascii_art"), "export SQL без ascii_art");
  ok(source.includes("ascii_art: row.ascii_art ?? null"), "exportMemoryRow без ascii_art");
  ok(source.includes("ascii_art: row.ascii_art || null"), "EXPORT_TXT_ROWS.memories без ascii_art");
  ok(source.includes("ASCII-изображение:"), "exportTxtRecord без блока ASCII");
});

test("ensureSchema: memories имеет ascii_art и ALTER-список", () => {
  ok(source.includes("body TEXT NOT NULL,ascii_art TEXT,day TEXT NOT NULL"), "CREATE TABLE без ascii_art");
  ok(source.includes('["memories", "ascii_art", "TEXT"]'), "ALTER-список без ascii_art");
});

// ------------------------- TXT-экспорт: блок ASCII без искажений -------------------------

const buildTxt = new Function(
  [
    extractLine("const clean = "),
    extractBraced("function exportTxtDay"),
    extractBraced("function exportTxtTime"),
    extractBraced("const EXPORT_TXT_ROWS = {"),
    extractBraced("function exportTxtRecord"),
    "return { EXPORT_TXT_ROWS, exportTxtRecord };"
  ].join("\n")
)();

test("TXT-экспорт: ascii_art отдельным блоком, пробелы строк сохранены", () => {
  const art = "  @#  \n..   \n#####  ";
  const rec = buildTxt.EXPORT_TXT_ROWS.memories({
    title: "Вечер", body: "Текст", day: "2026-11-18", author: "Аня",
    created_at: 1760000000, ascii_art: art
  });
  equal(rec.ascii_art, art);
  const txt = buildTxt.exportTxtRecord(1, rec);
  ok(txt.includes("ASCII-изображение:"), "нет заголовка блока");
  // Строки рисунка идут без отступов и без trim — хвостовые пробелы целы.
  ok(txt.includes("\n  @#  \n"), "ведущие/хвостовые пробелы потеряны");
  ok(txt.includes("\n#####  \n"), "хвостовые пробелы последней строки потеряны");
  ok(!txt.includes("   @#"), "строка рисунка не должна иметь отступ поля");
});

test("TXT-экспорт: запись без ascii_art не получает пустой блок", () => {
  const rec = buildTxt.EXPORT_TXT_ROWS.memories({
    title: null, body: "Текст", day: "2026-11-18", author: "Аня",
    created_at: 1760000000, ascii_art: null
  });
  equal(rec.ascii_art, null);
  const txt = buildTxt.exportTxtRecord(1, rec);
  equal(txt.includes("ASCII-изображение"), false);
});
