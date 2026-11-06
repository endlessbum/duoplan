// PATCH /api/goals/:id и /api/goal_items/:id обязан отвечать 405, а не 500.
//
// Типы goals/goal_items не покрыты patchSchemas и ветками PATCH в itemRoute:
// запрос проваливался в финальный else (ветка wishes) и умирал на
// «UPDATE goals SET body=?» → «no such column: body» → 500. Теперь, как у
// movies, они отсекаются METHOD_NOT_ALLOWED до сборки полей.
//
// Запуск: node --test tests/test_item_patch_405.test.mjs
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { equal } from "node:assert/strict";
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
  "rateLimit", "readJson", "state", "membership", "ownerIds",
  [
    extractBraced("class HttpError"),
    extractLine("const now = "),
    extractLine("const clean = "),
    extractLine("const positiveId = "),
    extractLine("const ACCENT_KEYS"),
    extractBraced("function validateSchema"),
    extractBraced("function textField"),
    extractBraced("function wishUrl"),
    extractBraced("function moneyAmount"),
    extractBraced("async function ensureWishOwner"),
    extractBraced("async function ensureSavingVisible"),
    extractBraced("async function ensureDateVisible"),
    extractBraced("async function ensureTaskVisible"),
    extractBraced("async function ensureGoalVisible"),
    extractBraced("async function itemRoute"),
    extractBraced("function ownerIds"),
    extractBraced("async function api"),
    "return api;"
  ].join("\n")
);

function makeApi() {
  const db = {
    prepare(sql) {
      return {
        bind() {
          return {
            // Видимость пройдена: строка «своя», 405 должен прийти из guard'а.
            first: async () => ({ id: 1, is_private: 0, created_by: 777, owner_id: 777 }),
            run: async () => ({ meta: { changes: 1 } }),
            all: async () => ({ results: [] })
          };
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
    async () => ({ title: "Правка" }),
    async () => ({ user: { tg_id: 777 }, pair: { id: 1 } }),
    async () => ({ id: 1, timezone: "Europe/Moscow", awaiting_return: 0 })
  );
  return { api, env: { DB: db }, request: { method: "PATCH", headers: { get: () => null } } };
}

for (const type of ["goals", "goal_items", "movies"]) {
  test(`PATCH /api/${type}/1 → 405 METHOD_NOT_ALLOWED, не 500`, async () => {
    const { api, env, request } = makeApi();
    try {
      await api(request, env, new URL(`https://duoplan.test/api/${type}/1`));
      throw new Error("PATCH не отклонён");
    } catch (error) {
      equal(error.status, 405, `${type}: ожидался 405`);
      equal(error.code, "METHOD_NOT_ALLOWED");
    }
  });
}
