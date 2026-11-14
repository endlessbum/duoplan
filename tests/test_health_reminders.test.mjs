// Правила напоминаний о приёме препаратов («Дневник → Здоровье»).
// healthReminderKinds — чистая функция: исполняется вне Worker'а, дедуп на
// день остаётся в deliverNotification (notification_log), как у Фло.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const source = readFileSync(new URL("../worker.js", import.meta.url), "utf8");
// Константы объявлены в блоке Фло, функции — в блоке «Здоровье»: собираем оба.
const constants = [
  source.slice(source.indexOf('const HEALTH_MED_FORMS'), source.indexOf("\n", source.indexOf('const HEALTH_MED_FORMS'))),
  source.slice(source.indexOf('const HEALTH_MED_STATUS ='), source.indexOf("\n", source.indexOf('const HEALTH_MED_STATUS ='))),
  source.slice(source.indexOf('const HEALTH_TIME_RE'), source.indexOf("\n", source.indexOf('const HEALTH_TIME_RE')))
].join("\n");
const block = source.slice(source.indexOf("// ---- Здоровье"), source.indexOf("async function ensureSchema(env)"));
const { healthReminderKinds } = new Function("DEFAULT_TZ", `${constants}\n${block}; return { healthReminderKinds };`)("Europe/Moscow");

const med = (patch = {}) => ({
  id: 7,
  name: "Магний",
  dosage: "1 таблетка",
  schedule: "после еды",
  remind_enabled: true,
  remind_time: "09:00",
  start_date: "2026-11-01",
  end_date: null,
  status: "active",
  ...patch
});

test("активный курс с включённым напоминанием: время достигло — напомнить", () => {
  const out = healthReminderKinds([med()], "2026-11-10", "09:00");
  assert.equal(out.length, 1);
  assert.equal(out[0].kind, "health_med_7");
  assert.ok(out[0].text.includes("Магний"));
  assert.ok(out[0].text.includes("после еды"));
  assert.ok(out[0].text.includes("Дневник → Здоровье"), "текст подсказывает, где отметить приём");
});

test("время ещё не наступило — не напоминать (крон 15-минутный)", () => {
  assert.deepEqual(healthReminderKinds([med()], "2026-11-10", "08:45"), []);
});

test("пауза, завершённый курс и выключенное напоминание — молчание", () => {
  assert.deepEqual(healthReminderKinds([med({ status: "paused" })], "2026-11-10", "09:00"), []);
  assert.deepEqual(healthReminderKinds([med({ status: "completed" })], "2026-11-10", "09:00"), []);
  assert.deepEqual(healthReminderKinds([med({ remind_enabled: false })], "2026-11-10", "09:00"), []);
});

test("курс ещё не начался или уже закончился — не напоминать", () => {
  assert.deepEqual(healthReminderKinds([med({ start_date: "2026-11-11" })], "2026-11-10", "09:00"), []);
  assert.deepEqual(healthReminderKinds([med({ end_date: "2026-11-09" })], "2026-11-10", "09:00"), []);
  // Граничные дни входят: старт сегодня и последний день курса напоминают.
  assert.equal(healthReminderKinds([med({ start_date: "2026-11-10" })], "2026-11-10", "09:00").length, 1);
  assert.equal(healthReminderKinds([med({ end_date: "2026-11-10" })], "2026-11-10", "09:00").length, 1);
});

test("битое или отсутствующее время напоминания — молчание (fail-safe)", () => {
  assert.deepEqual(healthReminderKinds([med({ remind_time: null })], "2026-11-10", "09:00"), []);
  assert.deepEqual(healthReminderKinds([med({ remind_time: "9 утра" })], "2026-11-10", "09:00"), []);
});

test("несколько препаратов в одном тике — по одному напоминанию на препарат", () => {
  const out = healthReminderKinds([med(), med({ id: 8, name: "Омега-3", remind_time: "09:10" })], "2026-11-10", "09:14");
  assert.deepEqual(out.map(r => r.kind), ["health_med_7", "health_med_8"]);
  assert.ok(out[1].text.includes("Омега-3"));
});

// ------------------------------------------------------------------
// Полный путь sendHealthReminders: SELECT из D1 → нормализация →
// healthReminderKinds → deliverNotification → openApp. Регрессия P1:
// колонка remind_enabled не выбиралась, а D1 отдаёт 0/1 вместо boolean.
// ------------------------------------------------------------------
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

const loadReminders = new Function(
  "openApp", "now",
  [
    'const DEFAULT_TZ = "Europe/Moscow";',
    extractLine("const HEALTH_TIME_RE"),
    extractBraced("function validTimeZone"),
    extractBraced("function cycleToday"),
    extractBraced("function healthReminderKinds"),
    extractBraced("async function deliverNotification"),
    extractBraced("async function sendHealthReminders"),
    "return { sendHealthReminders };"
  ].join("\n")
);

// Мок D1 в форме реальных ответов: boolean-колонки приходят как 0/1,
// запрос препаратов не имеет bind-параметров (.all() без .bind()).
function makeHealthDb(meds, queries = []) {
  const notified = new Set();
  return {
    env: {
      DB: {
        prepare(sql) {
          const stmt = {
            _args: [],
            all: async () => ({ results: sql.includes("FROM health_meds") ? meds : [] }),
            first: async () => null,
            run: async () => {
              if (sql.startsWith("INSERT OR IGNORE INTO notification_log")) {
                const key = stmt._args.join("|");
                if (notified.has(key)) return { meta: { changes: 0 } };
                notified.add(key);
                return { meta: { changes: 1 } };
              }
              return { meta: { changes: 1 } };
            },
            bind(...args) { stmt._args = args; return stmt; }
          };
          queries.push({ sql });
          return stmt;
        }
      }
    }
  };
}

// Строка ровно в том виде, в каком её вернул бы D1: плоский join
// health_meds + users.timezone, remind_enabled как 1/0.
const d1Med = (patch = {}) => ({
  id: 7,
  tg_id: 111,
  name: "Магний",
  dosage: "1 таблетка",
  schedule: "после еды",
  remind_enabled: 1,
  remind_time: "00:00",
  start_date: null,
  end_date: null,
  status: "active",
  timezone: "Europe/Moscow",
  ...patch
});

function reminderHarness(meds) {
  const sent = [];
  const openApp = async (env, chatId, requestUrl, text) => { sent.push({ chatId, text }); };
  const queries = [];
  const db = makeHealthDb(meds, queries);
  const { sendHealthReminders } = loadReminders(openApp, () => 1760000000);
  return { run: () => sendHealthReminders(db.env), sent, queries };
}

test("SELECT sendHealthReminders выбирает remind_enabled (регрессия P1)", () => {
  assert.match(source, /SELECT m\.id, m\.tg_id, m\.name, m\.dosage, m\.schedule, m\.remind_enabled, m\.remind_time/);
});

test("строка D1 с remind_enabled=1 доходит до openApp ровно один раз", async () => {
  const h = reminderHarness([d1Med()]);
  await h.run();
  assert.equal(h.sent.length, 1);
  assert.equal(h.sent[0].chatId, 111);
  assert.ok(h.sent[0].text.includes("Магний"));
  assert.ok(h.queries.some(q => q.sql.includes("INSERT OR IGNORE INTO notification_log")));
});

test("remind_enabled=0 в строке не приводит к отправке", async () => {
  const h = reminderHarness([d1Med({ remind_enabled: 0 })]);
  await h.run();
  assert.deepEqual(h.sent, []);
});

test("повторный тик крона не создаёт дубль (notification_log)", async () => {
  const h = reminderHarness([d1Med()]);
  await h.run();
  await h.run();
  assert.equal(h.sent.length, 1);
});

test("препарат другого пользователя и неактивный статус не напоминают", async () => {
  const h = reminderHarness([d1Med({ id: 8, tg_id: 222 }), d1Med({ id: 9, status: "paused" })]);
  await h.run();
  assert.deepEqual(h.sent.map(s => s.chatId), [222]);
});
