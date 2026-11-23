// PD-DATES-002: количество лет по конкретному наступлению и серверный
// инвариант show_years. Тесты исполняют реальные функции из worker.js
// и public/app.js, а не ищут строки в исходнике.
//
// Запуск: node --test tests/test_date_years.test.mjs
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { deepStrictEqual, equal, ok } from "node:assert/strict";
import { test } from "node:test";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const worker = readFileSync(join(root, "worker.js"), "utf8");
const app = readFileSync(join(root, "public/app.js"), "utf8");

function makeExtract(source) {
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
    return source.slice(start, source.indexOf("\n", start));
  }
  return { extractBraced, extractLine };
}
const w = makeExtract(worker);
const a = makeExtract(app);

// ------------------------------------------------------------------
// 1. Чистая функция расчёта лет
// ------------------------------------------------------------------
const years = new Function([
  'const DEFAULT_TZ = "Europe/Moscow";',
  w.extractLine("const clean = "),
  w.extractBraced("function validDate("),
  w.extractBraced("function monthlyOccursOnDay("),
  w.extractBraced("function dateOccursOnDay("),
  w.extractBraced("function yearsAtOccurrence("),
  w.extractBraced("function yearsWord("),
  w.extractBraced("function yearsSuffix("),
  "return { yearsAtOccurrence, yearsWord, yearsSuffix };"
].join("\n"))();

const DATE = (extra = {}) => ({
  kind: "date", day: "2020-01-01", recurs: 1, monthly: 0, show_years: 1, ...extra
});

test("годы считаются на наступление: 37 / 6 / 1", () => {
  equal(years.yearsAtOccurrence(DATE({ day: "1990-05-14" }), "2027-05-14"), 37);
  equal(years.yearsAtOccurrence(DATE({ day: "2020-11-20" }), "2026-11-20"), 6);
  equal(years.yearsAtOccurrence(DATE({ day: "2024-03-10" }), "2025-03-10"), 1);
});

test("день рождения считается ежегодным даже без флагов повтора", () => {
  equal(years.yearsAtOccurrence(DATE({ kind: "birthday", day: "1990-05-14", recurs: 0 }), "2027-05-14"), 37);
});

test("склонение: год / года / лет, включая 11–14 и 21", () => {
  equal(years.yearsSuffix(DATE({ day: "2024-01-01" }), "2025-01-01"), " · 1 год");
  equal(years.yearsSuffix(DATE({ day: "2023-01-01" }), "2025-01-01"), " · 2 года");
  equal(years.yearsSuffix(DATE({ day: "2020-01-01" }), "2025-01-01"), " · 5 лет");
  equal(years.yearsSuffix(DATE({ day: "2004-01-01" }), "2025-01-01"), " · 21 год");
  equal(years.yearsSuffix(DATE({ day: "2003-01-01" }), "2025-01-01"), " · 22 года");
  equal(years.yearsSuffix(DATE({ day: "2014-01-01" }), "2025-01-01"), " · 11 лет");
  equal(years.yearsSuffix(DATE({ day: "2011-01-01" }), "2025-01-01"), " · 14 лет");
});

test("выключенный флаг, не-ежегодные даты и неверное наступление — ничего", () => {
  equal(years.yearsAtOccurrence(DATE({ show_years: 0 }), "2027-05-14"), null);
  equal(years.yearsAtOccurrence(DATE({ kind: "date", day: "2020-05-14", recurs: 0 }), "2020-05-14"), null);
  equal(years.yearsAtOccurrence(DATE({ monthly: 1 }), "2027-05-14"), null);
  equal(years.yearsAtOccurrence(DATE({ day: "2020-05-14" }), "2027-05-15"), null);
  equal(years.yearsAtOccurrence(DATE({ day: "2020-05-14" }), "2020-05-14"), null);
  equal(years.yearsAtOccurrence(DATE({ day: "не дата" }), "2027-05-14"), null);
  equal(years.yearsSuffix(DATE({ show_years: 0 }), "2027-05-14"), "");
});

test("29 февраля считается только в фактический високосный год", () => {
  const leap = DATE({ day: "2020-02-29" });
  equal(years.yearsAtOccurrence(leap, "2027-02-28"), null);
  equal(years.yearsAtOccurrence(leap, "2027-03-01"), null);
  equal(years.yearsAtOccurrence(leap, "2028-02-29"), 8);
});

// ------------------------------------------------------------------
// 2. POST /api/dates — сервер нормализует флаг
// ------------------------------------------------------------------
const buildApi = new Function(
  "json", "ensureSchemaOnce", "telegramUser", "validTimeZone", "ensureUser",
  "rateLimit", "readJson", "state", "membership", "ownerIds", "syncWidgetAccents",
  [
    w.extractBraced("class HttpError"),
    w.extractLine("const now = "),
    w.extractLine("const clean = "),
    w.extractLine("const ACCENT_KEYS"),
    w.extractBraced("function validateSchema"),
    w.extractBraced("function textField"),
    w.extractBraced("function validDate"),
    w.extractBraced("function optionalTime"),
    w.extractBraced("function showYearsValue"),
    w.extractBraced("function ownerIds"),
    w.extractBraced("async function api"),
    "return api;"
  ].join("\n")
);

function apiEnv(body) {
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
    (data, status = 200) => ({ data, status }), async () => {},
    async () => ({ id: 777, first_name: "Тест" }), () => "Europe/Moscow",
    async () => ({ tg_id: 777, gender: null }), async () => {},
    async () => body, async () => ({ user: { tg_id: 777 }, pair: { id: 1 } }),
    async () => ({ id: 1 }), async () => {}, async () => {}
  );
  return { api, env: { DB: db }, queries, request: { method: "POST", headers: { get: () => null } } };
}

async function showYearsInserted(body) {
  const { api, env, queries, request } = apiEnv(body);
  const result = await api(request, env, new URL("https://duoplan.test/api/dates"));
  equal(result.status, 200);
  const insert = queries.find((q) => q.sql.startsWith("INSERT INTO dates"));
  ok(insert, "INSERT INTO dates не выполнен");
  return insert.args[9]; // show_years перед created_at
}

test("POST birthday: true → 1, false → 0, отсутствие поля → 0", async () => {
  equal(await showYearsInserted({ title: "Маша", day: "1990-05-14", kind: "birthday", show_years: true }), 1);
  equal(await showYearsInserted({ title: "Маша", day: "1990-05-14", kind: "birthday", show_years: false }), 0);
  equal(await showYearsInserted({ title: "Маша", day: "1990-05-14", kind: "birthday" }), 0);
});

test("POST ежегодной даты с show_years=true → 1", async () => {
  equal(await showYearsInserted({ title: "Знакомство", day: "2020-11-20", recurs: true, show_years: true }), 1);
});

test("POST monthly и one-shot нормализуют show_years в 0", async () => {
  equal(await showYearsInserted({ title: "Ежемесячно", day: "2020-11-20", monthly: true, recurs: true, show_years: true }), 0);
  equal(await showYearsInserted({ title: "Разово", day: "2020-11-20", recurs: false, show_years: true }), 0);
});

// ------------------------------------------------------------------
// 3. PATCH /api/dates/:id — частичное обновление и инвариант
// ------------------------------------------------------------------
const itemRoute = new Function("now", [
  w.extractLine("const clean = "),
  w.extractLine("const positiveId = "),
  w.extractBraced("class HttpError"),
  w.extractBraced("function validateSchema"),
  w.extractBraced("function textField"),
  w.extractBraced("function validDate"),
  w.extractBraced("function optionalDay"),
  w.extractBraced("function optionalTime"),
  w.extractBraced("function showYearsValue"),
  w.extractBraced("function showYearsAllowed"),
  w.extractBraced("function planSchedule"),
  w.extractBraced("async function ensureWishOwner"),
  w.extractBraced("async function ensureDateVisible"),
  w.extractBraced("async function ensureTaskVisible"),
  w.extractBraced("async function disbandGroupIfSingleton"),
  w.extractBraced("async function itemRoute"),
  "return itemRoute;"
].join("\n"))(() => 1760000000);

const PAIR = { id: 1, timezone: "Europe/Moscow", user_a: 777, user_b: 0 };
const ANNUAL = { is_private: 0, created_by: 777, kind: "date", day: "2020-05-14", time: "19:00", recurs: 1, monthly: 0, show_years: 1 };

function patchDb(row) {
  const queries = [];
  const env = {
    DB: {
      prepare(sql) {
        return {
          bind(...args) {
            queries.push({ sql, args });
            return {
              first: async () => row,
              run: async () => ({ meta: { changes: 1 } })
            };
          }
        };
      }
    }
  };
  return { env, queries, update: () => queries.find((q) => q.sql.startsWith("UPDATE dates")) };
}

async function patch(row, body) {
  const ctx = patchDb(row);
  await itemRoute(ctx.env, PAIR, { tg_id: 777 }, "PATCH", "/api/dates/5", body);
  return ctx.update();
}

test("PATCH только названия сохраняет show_years", async () => {
  const u = await patch(ANNUAL, { title: "Новое название" });
  equal(u.sql.includes("show_years=?"), false);
  deepStrictEqual(u.args, ["Новое название", 5, 1]);
});

test("PATCH только show_years меняет флаг в обе стороны", async () => {
  const off = await patch(ANNUAL, { show_years: false });
  equal(off.sql.includes("show_years=?"), true);
  deepStrictEqual(off.args, [0, 5, 1]);
  const on = await patch({ ...ANNUAL, show_years: 0 }, { show_years: true });
  deepStrictEqual(on.args, [1, 5, 1]);
});

test("PATCH annual → monthly и annual → one-shot очищает show_years", async () => {
  const monthly = await patch(ANNUAL, { monthly: true, recurs: true, show_years: true });
  equal(monthly.sql.includes("show_years=?"), true);
  equal(monthly.args[monthly.args.length - 3], 0);
  const once = await patch(ANNUAL, { recurs: false });
  equal(once.sql.includes("show_years=?"), true);
  equal(once.args[once.args.length - 3], 0);
});

test("PATCH дня рождения меняет флаг, не трогая принудительный recurs", async () => {
  const row = { ...ANNUAL, kind: "birthday", show_years: 1, time: "19:00" };
  const u = await patch(row, { show_years: false });
  deepStrictEqual(u.args, [null, 0, 5, 1]); // time=NULL, show_years=0
  const titleOnly = await patch(row, { title: "Именинник" });
  equal(titleOnly.sql.includes("recurs=?"), false);
  equal(titleOnly.sql.includes("show_years=?"), false);
});

// ------------------------------------------------------------------
// 4. Экспорт/импорт
// ------------------------------------------------------------------
const exportRow = new Function(w.extractLine("const clean = ") + "\n" + w.extractBraced("function exportDateRow(") + "\nreturn exportDateRow;")();

test("экспорт даты сохраняет show_years как boolean", () => {
  const base = { id: 1, title: "Дата", day: "2020-05-14", recurs: 1, monthly: 0, is_private: 0, kind: "date" };
  equal(exportRow({ ...base, show_years: 1 }).show_years, true);
  equal(exportRow({ ...base, show_years: 0 }).show_years, false);
});

test("старый экспорт без поля даёт false", () => {
  equal(exportRow({ id: 1, title: "Дата", day: "2020-05-14" }).show_years, false);
});

// ------------------------------------------------------------------
// 5. UI: форма и карточки
// ------------------------------------------------------------------
test("все четыре формы дат содержат чекбокс «Отображать годы»", () => {
  const need = ["name=\"show_years\""];
  for (const marker of [
    'action === "add-date"', 'action === "add-birthday"',
    'title: "Редактировать день рождения"', 'title: "Редактировать дату"'
  ]) {
    const start = app.indexOf(marker);
    ok(start !== -1, `форма ${marker} не найдена`);
    const fragment = app.slice(start, start + 2600);
    for (const token of need) ok(fragment.includes(token), `в форме ${marker} нет чекбокса лет`);
  }
  // День рождения доступен всегда; обычная дата — только в ежегодном режиме.
  const birthdayAdd = app.slice(app.indexOf('action === "add-birthday"'), app.indexOf('action === "add-birthday"') + 1600);
  ok(birthdayAdd.includes('data-show-years-always="1"'));
});

const syncShowYearsControl = new Function(a.extractBraced("function syncShowYearsControl(") + "\nreturn syncShowYearsControl;")();

function fakeForm({ always = false, monthly = false, recurs = false, checked = false } = {}) {
  const control = { name: "show_years", checked, disabled: false, dataset: always ? { showYearsAlways: "1" } : {}, closest: () => field };
  const monthlyInput = { checked: monthly };
  const recursInput = { checked: recurs };
  const field = { classList: { toggle: (name, on) => { field.disabledClass = on; } } };
  const form = {
    querySelector: (selector) => selector.includes("show_years") ? control
      : selector.includes("monthly") ? monthlyInput
      : selector.includes("recurs") ? recursInput : null
  };
  return { form, control, field };
}

test("чекбокс лет доступен только для birthday/annual и снимается при смене режима", () => {
  const birthday = fakeForm({ always: true, checked: true });
  syncShowYearsControl(birthday.form);
  equal(birthday.control.disabled, false);
  equal(birthday.control.checked, true);

  const annual = fakeForm({ recurs: true, checked: true });
  syncShowYearsControl(annual.form);
  equal(annual.control.disabled, false);

  const monthly = fakeForm({ monthly: true, recurs: false, checked: true });
  syncShowYearsControl(monthly.form);
  equal(monthly.control.disabled, true);
  equal(monthly.control.checked, false);

  const oneShot = fakeForm({ recurs: false, checked: true });
  syncShowYearsControl(oneShot.form);
  equal(oneShot.control.disabled, true);
  equal(oneShot.control.checked, false);
});

// ------------------------------------------------------------------
// 6. Все три дайджеста: суффикс привязан к дню наступления
// ------------------------------------------------------------------
const digests = new Function([
  'const DEFAULT_TZ = "Europe/Moscow";',
  w.extractLine("const clean = "),
  w.extractLine("const DIGEST_MAX_ITEMS"),
  w.extractLine("const DIGEST_MAX_CHARS"),
  w.extractLine("const maskTitle"),
  "const RICH_TOKENS = " + worker.match(/const RICH_TOKENS = (\[\[.*\]\]);/)?.[1] + ";",
  w.extractBraced("function validTimeZone("),
  w.extractBraced("function localDay("),
  w.extractLine("const dateTimeFormatCache = new Map();"),
  w.extractBraced("function cachedFormatter"),
  w.extractBraced("function timeZoneOffsetMs("),
  w.extractBraced("function makeDateInTimeZone("),
  w.extractBraced("function escapeHtml("),
  w.extractBraced("function richInline("),
  w.extractBraced("function richToHtml("),
  w.extractBraced("function monthlyOccursOnDay("),
  w.extractBraced("function nextMonthlyOccurrenceMs("),
  w.extractBraced("function dateOccursOnDay("),
  w.extractBraced("function validDate("),
  w.extractBraced("function yearsAtOccurrence("),
  w.extractBraced("function yearsWord("),
  w.extractBraced("function yearsSuffix("),
  "const WEEKDAY_SHORT = " + worker.match(/const WEEKDAY_SHORT = (\[.*\]);/)?.[1] + ";",
  w.extractBraced("function upcomingWeekWindow("),
  w.extractBraced("function weeklyDigestText("),
  w.extractBraced("function digestText("),
  w.extractBraced("function datesDigestText("),
  "return { digestText, datesDigestText, weeklyDigestText };"
].join("\n"))();

test("утренняя сводка: годы сегодняшнего и завтрашнего дней рождения", () => {
  const items = [
    { id: 1, title: "Маша", day: "1990-05-14", time: null, recurs: 1, monthly: 0, kind: "birthday", show_years: 1, is_private: 0 },
    { id: 2, title: "Встреча", day: "2020-05-15", time: null, recurs: 1, monthly: 0, kind: "date", show_years: 1, is_private: 0 }
  ];
  const text = digests.digestText("2027-05-14", "2027-05-15", items, []);
  ok(text.includes("• Сегодня — Маша · 37 лет"), text);
  ok(text.includes("• Завтра — Встреча · 7 лет"), text);
});

test("суточная сводка считает годы на завтра", () => {
  const text = digests.datesDigestText("Europe/Moscow", "2026-11-20", [
    { id: 1, title: "Знакомство", day: "2020-11-20", time: "19:30", recurs: 1, monthly: 0, kind: "date", show_years: 1, is_private: 0 }
  ]);
  ok(text.includes("Знакомство (19:30) · 6 лет"), text);
});

test("недельная сводка считает годы на день недели внутри окна", () => {
  const text = digests.weeklyDigestText("2025-03-10", "2025-03-16", [
    { id: 1, title: "Годовщина", day: "2024-03-10", time: null, recurs: 1, monthly: 0, kind: "date", show_years: 1, is_private: 0 }
  ], []);
  ok(text.includes("Годовщина · 1 год"), text);
});

test("личная дата остаётся под спойлером, годы не раскрывают заголовок", () => {
  const text = digests.digestText("2027-05-14", "2027-05-15", [
    { id: 1, title: "Тайна", day: "2020-05-14", time: null, recurs: 1, monthly: 0, kind: "date", show_years: 1, is_private: 1 }
  ], []);
  ok(text.includes("<tg-spoiler>Тайна</tg-spoiler> · 7 лет"), text);
  equal(text.includes("Тайна ·"), false);
});
