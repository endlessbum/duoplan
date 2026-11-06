// Частичный PATCH /api/tasks: флаги повтора monthly/yearly (worker.js, itemRoute).
//
// Раньше блок monthly/yearly пересчитывал оба флага с нуля: PATCH с одним
// полем ({yearly:false} или {monthly:false}) обнулял и второй — у
// ежемесячного плана молча снимался повтор. Теперь неприсланный флаг
// берётся из строки задачи, а явный «true» одного — переключает режим.
//
// Запуск: node --test tests/test_task_patch_flags.test.mjs
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
    extractBraced("function validDate"),
    extractBraced("function optionalDay"),
    extractBraced("function optionalTime"),
    extractBraced("function planSchedule"),
    extractBraced("function wishUrl"),
    extractBraced("async function ensureWishOwner"),
    extractBraced("async function ensureDateVisible"),
    extractBraced("async function ensureTaskVisible"),
    extractBraced("async function itemRoute"),
    extractBraced("function ownerIds"),
    extractBraced("async function api"),
    "return api;"
  ].join("\n")
);

function makeEnv({ taskRow, body }) {
  const queries = [];
  const db = {
    prepare(sql) {
      return {
        bind(...args) {
          queries.push({ sql, args });
          return {
            first: async () => (/^SELECT .* FROM tasks/.test(sql) ? taskRow : null),
            run: async () => ({ meta: { changes: 1 } })
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
    async () => body,
    async () => ({ user: { tg_id: 777 }, pair: { id: 1 } }),
    async () => ({ id: 1, timezone: "Europe/Moscow", awaiting_return: 0 })
  );
  const request = { method: "PATCH", headers: { get: () => null } };
  return { api, env: { DB: db }, queries, request };
}

async function patchFlags(taskRow, body) {
  const { api, env, queries, request } = makeEnv({ taskRow, body });
  await api(request, env, new URL("https://duoplan.test/api/tasks/5"));
  const update = queries.find((q) => q.sql.startsWith("UPDATE tasks SET"));
  if (!update) throw new Error("UPDATE tasks не выполнен");
  return { monthly: update.args[0], yearly: update.args[1], sql: update.sql };
}

const MONTHLY_TASK = { id: 5, is_private: 0, created_by: 1, day: "2026-11-05", time: null, monthly: 1, yearly: 0 };
const YEARLY_TASK = { id: 5, is_private: 0, created_by: 1, day: "2026-11-05", time: null, monthly: 0, yearly: 1 };

test("PATCH {yearly:false} не снимает monthly у ежемесячного плана", async () => {
  const { monthly, yearly } = await patchFlags(MONTHLY_TASK, { yearly: false });
  equal(monthly, 1);
  equal(yearly, 0);
});

test("PATCH {monthly:false} не снимает yearly у годового плана", async () => {
  const { monthly, yearly } = await patchFlags(YEARLY_TASK, { monthly: false });
  equal(monthly, 0);
  equal(yearly, 1);
});

test("PATCH {yearly:true} переключает ежемесячный план на ежегодный", async () => {
  const { monthly, yearly } = await patchFlags(MONTHLY_TASK, { yearly: true });
  equal(monthly, 0);
  equal(yearly, 1);
});

test("PATCH {monthly:true} переключает годовой план на ежемесячный", async () => {
  const { monthly, yearly } = await patchFlags(YEARLY_TASK, { monthly: true });
  equal(monthly, 1);
  equal(yearly, 0);
});

test("PATCH {monthly:false, yearly:false} снимает повтор целиком", async () => {
  const { monthly, yearly } = await patchFlags(MONTHLY_TASK, { monthly: false, yearly: false });
  equal(monthly, 0);
  equal(yearly, 0);
});

test("PATCH только названия не трогает флаги повтора", async () => {
  const { sql } = await patchFlags(MONTHLY_TASK, { title: "Новое название" });
  equal(/monthly=\?/.test(sql), false);
  equal(/yearly=\?/.test(sql), false);
});
