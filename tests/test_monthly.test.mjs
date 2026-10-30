// Ежемесячные и ежегодные повторы (worker.js): миграция 0013.
//
// Проверяем: nextMonthlyOccurrenceMs/nextYearlyOccurrenceMs на фиксированном
// «сейчас», dateOccursOnDay для monthly-дат, валидацию POST /api/tasks
// (повтор без даты — 400) и перекрытие recurs при monthly в POST /api/dates.
//
// Запуск: node --test tests/test_monthly.test.mjs
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { deepStrictEqual, equal, ok, rejects } from "node:assert/strict";
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

const load = new Function(
  [
    'const DEFAULT_TZ = "Europe/Moscow";',
    extractLine("const positiveId = "),
    extractBraced("function validTimeZone"),
    extractBraced("function localDay"),
    extractBraced("function timeZoneOffsetMs"),
    extractBraced("function makeDateInTimeZone"),
    extractBraced("function monthlyOccursOnDay"),
    extractBraced("function nextMonthlyOccurrenceMs"),
    extractBraced("function nextYearlyOccurrenceMs"),
    extractBraced("function taskTargetMs"),
    extractBraced("function dateOccursOnDay"),
    "return { nextMonthlyOccurrenceMs, nextYearlyOccurrenceMs, monthlyOccursOnDay, dateOccursOnDay };"
  ].join("\n")
);
const { nextMonthlyOccurrenceMs, nextYearlyOccurrenceMs, monthlyOccursOnDay, dateOccursOnDay } = load();

const TZ = "Europe/Moscow";
// Фиксированное «сейчас»: 2026-10-31 09:00 UTC = 12:00 MSK.
const NOW = Date.UTC(2026, 9, 31, 9, 0, 0);

test("monthly: наступление в текущем месяце, если день ещё не прошёл", () => {
  const ms = nextMonthlyOccurrenceMs({ day: "2026-10-05", time: "", monthly: 1 }, TZ, NOW);
  // 31-го октября 5-е уже прошло — ближайшее наступление: 5 ноября, полдень MSK.
  const iso = new Date(ms).toISOString();
  equal(iso, "2026-11-05T09:00:00.000Z");
  equal(new Intl.DateTimeFormat("en-CA", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(ms)), "2026-11-05");
});

test("monthly: короткие месяцы пропускают несуществующий день (31-е)", () => {
  // Февраль 2027 не имеет 31-го — 29 дней; ноябрь имеет.
  const ms = nextMonthlyOccurrenceMs({ day: "2026-01-31", time: "", monthly: 1 }, TZ, Date.UTC(2027, 1, 10, 9));
  equal(new Intl.DateTimeFormat("en-CA", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(ms)), "2027-03-31");
});

test("yearly: следующий год с существующим днём (29 февраля -> 2028)", () => {
  const ms = nextYearlyOccurrenceMs({ day: "2020-02-29", time: "", yearly: 1 }, TZ, NOW);
  equal(new Intl.DateTimeFormat("en-CA", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(ms)), "2028-02-29");
});

test("monthlyOccursOnDay: совпадает по дню месяца, 31-е не «размазывается»", () => {
  const item = { day: "2026-01-31", monthly: 1 };
  equal(monthlyOccursOnDay(item, "2026-11-30"), false, "30-е не 31-е");
  equal(monthlyOccursOnDay(item, "2026-12-31"), true);
  equal(monthlyOccursOnDay({ day: "2026-01-05", monthly: 0 }, "2026-11-05"), false, "флаг monthly обязателен");
});

test("dateOccursOnDay: monthly-дата совпадает по дню месяца, recurs у monthly игнорируется", () => {
  const item = { day: "2024-03-10", recurs: 1, monthly: 1 };
  equal(dateOccursOnDay(item, "2026-11-10"), true);
  // Ежегодная ветка отключена для monthly: 10 марта не совпадает с 10 ноября
  // по месяцу-дню — иначе ежемесячная «звенела» бы каждый месяц-день года.
  const yearlyOnly = { day: "2024-03-10", recurs: 1, monthly: 0 };
  equal(dateOccursOnDay(yearlyOnly, "2026-03-10"), true);
});

// ------------------------------------------------------------------
// API: POST /api/tasks и /api/dates с monthly
// ------------------------------------------------------------------
const buildApi = new Function(
  "json", "ensureSchemaOnce", "telegramUser", "validTimeZone", "ensureUser",
  "rateLimit", "readJson", "state", "membership",
  [
    extractBraced("class HttpError"),
    extractLine("const now = "),
    extractLine("const clean = "),
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

test("POST /api/tasks: monthly без даты — 400, повторять нечего", async () => {
  const { api, env, request } = makeEnv({
    pair: { id: 1, timezone: "Europe/Moscow" },
    body: { title: "План", monthly: true }
  });
  await rejects(
    () => api(request, env, new URL("https://duoplan.test/api/tasks")),
    (error) => error.status === 400 && error.code === "INVALID_DATE"
  );
});

test("POST /api/tasks: monthly с датой пишется, yearly перекрывается", async () => {
  const { api, env, queries, request } = makeEnv({
    pair: { id: 1, timezone: "Europe/Moscow" },
    body: { title: "План", day: "2026-11-05", monthly: true, yearly: true }
  });
  await api(request, env, new URL("https://duoplan.test/api/tasks"));
  const insert = queries.find((q) => q.sql.startsWith("INSERT INTO tasks"));
  equal(insert.args.length, 9);
  equal(insert.args[4], 1); // monthly
  equal(insert.args[5], 0); // yearly перекрыт monthly
});

test("POST /api/dates: monthly перекрывает recurs", async () => {
  const { api, env, queries, request } = makeEnv({
    pair: { id: 1, timezone: "Europe/Moscow" },
    body: { title: "Дата", day: "2026-11-05", monthly: true, recurs: true }
  });
  await api(request, env, new URL("https://duoplan.test/api/dates"));
  const insert = queries.find((q) => q.sql.startsWith("INSERT INTO dates"));
  equal(insert.args.length, 9);
  equal(insert.args[4], 0); // recurs погашен
  equal(insert.args[5], 1); // monthly
});
