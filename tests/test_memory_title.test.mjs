// Заголовок записи дневника: POST /api/memories пишет title, PATCH обновляет,
// state() отдаёт его клиенту (worker.js, миграция 0012).
//
// Запуск: node tests/test_memory_title.test.mjs (или node --test)
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { deepStrictEqual, equal } from "node:assert/strict";
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

const buildApi = new Function(
  "json", "ensureSchemaOnce", "telegramUser", "validTimeZone", "ensureUser",
  "rateLimit", "readJson", "state", "membership",
  [
    extractBraced("class HttpError"),
    extractLine("const now = "),
    extractLine("const clean = "),
    extractLine("const positiveId = "),
    extractBraced("function localDay"),
    extractLine("const ACCENT_KEYS"),
    extractBraced("function validateSchema"),
    extractBraced("function textField"),
    extractBraced("function validDate"),
    extractBraced("function optionalDay"),
    extractBraced("function optionalTime"),
    extractBraced("function planSchedule"),
    extractBraced("function wishUrl"),
    extractBraced("async function ensureWishOwner"),
    extractBraced("async function ensureDateVisible"),
    extractBraced("async function ensureTaskVisible"),
    extractBraced("async function itemRoute"),
    extractBraced("async function api"),
    "return api;"
  ].join("\n")
);

function makeEnv({ pair, body }) {
  const queries = [];
  const db = {
    prepare(sql) {
      return {
        bind(...args) {
          queries.push({ sql, args });
          return { run: async () => ({ meta: { changes: 1 } }) };
        }
      };
    }
  };
  const api = buildApi(
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
  return { api, env: { DB: db }, queries, request: { method: "POST", headers: { get: () => null } } };
}

test("POST /api/memories пишет title рядом с телом записи", async () => {
  const { api, env, queries, request } = makeEnv({
    pair: { id: 1, timezone: "Europe/Moscow" },
    body: { title: "Тёплый вечер", body: "Текст воспоминания" }
  });
  await api(request, env, new URL("https://duoplan.test/api/memories"));
  const insert = queries.find((q) => q.sql.startsWith("INSERT INTO memories"));
  equal(insert.args.length, 6);
  equal(insert.args[2], "Тёплый вечер");
  equal(insert.args[3], "Текст воспоминания");
});

test("POST /api/memories без title пишет NULL — у записи не будет заголовка", async () => {
  const { api, env, queries, request } = makeEnv({
    pair: { id: 1, timezone: "Europe/Moscow" },
    body: { body: "Старый стиль" }
  });
  await api(request, env, new URL("https://duoplan.test/api/memories"));
  const insert = queries.find((q) => q.sql.startsWith("INSERT INTO memories"));
  equal(insert.args[2], null);
});

test("PATCH /api/memories обновляет title вместе с телом", async () => {
  const { api, env, queries, request } = makeEnv({
    pair: { id: 1, timezone: "Europe/Moscow" },
    body: { title: "Новый заголовок", body: "Текст" }
  });
  request.method = "PATCH";
  await api(request, env, new URL("https://duoplan.test/api/memories/8"));
  const update = queries.find((q) => q.sql.startsWith("UPDATE memories"));
  deepStrictEqual(update.sql.includes("body=?"), true);
  deepStrictEqual(update.sql.includes("title=?"), true);
  deepStrictEqual(update.args.includes("Новый заголовок"), true);
});

test("state() и архив отдают title вместе с телом записи", () => {
  deepStrictEqual(source.includes("m.id,m.title,m.body,m.day"), true, "state(): m.title в выборке");
  const archive = source.slice(source.indexOf("memories: {"), source.indexOf("memories: {") + 400);
  deepStrictEqual(archive.includes("m.title"), true, "ARCHIVE_QUERIES.memories без m.title");
});
