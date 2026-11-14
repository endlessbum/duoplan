// HTTP-level тесты ранее непокрытых эндпоинтов Фло и здоровья:
// /api/cycle/stats, /api/cycle/history, /api/cycle/export,
// /api/cycle/period/delete, /api/cycle/med-log/delete,
// /api/cycle/share-notify, /api/health/med-log/delete.
// Харнесс — как в test_cycle_api.test.mjs, плюс Flo-функции, которые
// вызывают эти маршруты (cycleStats/cycleInsights/cycleLogFromRow и пр.).
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
  if (start === -1) throw new Error(`${declaration} not found`);
  // Тело функции — после закрывающей ')' списка параметров: в сигнатурах
  // встречаются {} (opts = {}, деструктуризация), их пропускаем.
  // Для class тело начинается с первого '{'.
  const paramsEnd = declaration.startsWith("class") ? start : source.indexOf(")", start);
  let depth = 0;
  for (let j = source.indexOf("{", paramsEnd); j < source.length; j++) {
    if (source[j] === "{") depth++;
    else if (source[j] === "}") {
      depth--;
      if (depth === 0) return source.slice(start, j + 1);
    }
  }
  throw new Error(`unclosed block: ${declaration}`);
}

function extractLine(prefix) {
  const start = source.indexOf(prefix);
  if (start === -1) throw new Error(`${prefix} not found`);
  return source.slice(start, source.indexOf("\n", start));
}

function extractConstArray(name) {
  const start = source.indexOf(`const ${name} = [`);
  if (start === -1) throw new Error(`${name} not found`);
  const end = source.indexOf("];", start);
  if (end === -1) throw new Error(`unclosed const array: ${name}`);
  return source.slice(start, end + 2);
}

const buildApi = new Function(
  "json", "ensureSchemaOnce", "telegramUser", "validTimeZone", "ensureUser",
  "rateLimit", "readJson", "state", "membership", "ownerIds",
  "cycleState", "telegramForm", "healthState",
  [
    extractBraced("class HttpError"),
    extractLine("const ACCENT_KEYS"),
    extractLine("const now = "),
    extractLine("const clean = "),
    extractLine("const CYCLE_DATE_RE"),
    extractLine("const CYCLE_LEVELS"),
    extractLine("const CYCLE_SHARE_CATEGORIES"),
    extractLine("const CYCLE_SHARE_COLUMNS"),
    extractLine("const CYCLE_BLEEDING_SATURATION"),
    extractLine("const CYCLE_PERIOD_MAX_DAYS"),
    extractLine("const CYCLE_PERIOD_STATS_USABLE"),
    extractLine("const CYCLE_CONTEXT_RANGE_BONUS"),
    extractLine("const CYCLE_STALE_GRACE"),
    extractLine("const CYCLE_INTERVAL_MIN"),
    extractLine("const CYCLE_INTERVAL_MAX"),
    extractLine("const CYCLE_INTERVAL_USABLE"),
    extractLine("const CYCLE_CONTEXT_KEYS"),
    extractLine("const CYCLE_FLOWS"),
    extractLine("const CYCLE_FLOW_LABELS"),
    extractLine("const CYCLE_ENERGY"),
    extractLine("const CYCLE_MOOD_CODES"),
    extractLine("const CYCLE_SYMPTOM_CODES"),
    extractLine("const CYCLE_SEX"),
    extractLine("const CYCLE_LEAKAGE"),
    extractLine("const CYCLE_PAIN_LOCATIONS"),
    extractLine("const CYCLE_LIFE_IMPACT"),
    extractLine("const CYCLE_MUCUS_AMOUNTS"),
    extractLine("const CYCLE_MUCUS_CONSISTENCY"),
    extractLine("const CYCLE_MUCUS_COLORS"),
    extractLine("const CYCLE_SLEEP_QUALITY"),
    extractLine("const CYCLE_STRESS"),
    extractLine("const CYCLE_MEASUREMENT_KINDS"),
    extractLine("const CYCLE_LH_RESULTS"),
    extractLine("const CYCLE_MED_CATEGORIES"),
    extractLine("const CYCLE_MED_FORMS"),
    extractLine("const CYCLE_MED_STATUS"),
    extractLine("const NOTIFY_COLUMNS"),
    extractLine("const CYCLE_MS_DAY"),
    extractLine("const DEFAULT_TZ"),
    extractConstArray("DAILY_ACTIONS"),
    extractBraced("function localDay"),
    extractBraced("function dailyAction"),
    extractBraced("async function dailyFor"),
    extractBraced("function optionalTime"),
    extractBraced("function cycleValidDate"),
    extractBraced("function cycleDayNum"),
    extractBraced("function cycleDateStr"),
    extractBraced("function cycleToday"),
    extractBraced("function cycleMonthsAgo"),
    extractBraced("function cyclePhaseTip"),
    extractBraced("function cycleShareCategories"),
    extractBraced("function cycleIntervals"),
    extractBraced("function cycleMedianInt"),
    extractBraced("function cycleWeightedMedian"),
    extractBraced("function cyclePeriodDurations"),
    extractBraced("function cyclePeriodStats"),
    extractBraced("function cycleStats"),
    extractBraced("function cycleInsights"),
    extractBraced("function cycleLogFromRow"),
    extractBraced("function cycleExportPayload"),
    extractBraced("function cycleProfileContext"),
    extractBraced("function cycleOnboardPlan"),
    extractBraced("function validateSchema"),
    extractBraced("function ownerIds"),
    extractBraced("async function api"),
    "return api;"
  ].join("\n")
);

// Мок D1: prepare→bind→{all,first,run} с выборкой строк по имени таблицы
// в SQL и журналом записей (DELETE/UPDATE/INSERT).
function createStatsDB({ gender = "female", rows = {}, profile = null, membershipPair = null } = {}) {
  const writes = [];
  const pick = (sql) => {
    if (sql.includes("FROM cycle_periods")) return rows.cycle_periods || [];
    if (sql.includes("FROM cycle_logs")) return rows.cycle_logs || [];
    if (sql.includes("FROM cycle_measurements")) return rows.cycle_measurements || [];
    if (sql.includes("FROM cycle_meds")) return rows.cycle_meds || [];
    if (sql.includes("FROM cycle_med_logs")) return rows.cycle_med_logs || [];
    if (sql.includes("FROM cycle_profiles")) return rows.cycle_profiles || [];
    if (sql.includes("FROM users")) return rows.users || [];
    return [];
  };
  const db = {
    writes,
    async batch(statements = []) {
      return statements.map(() => ({ meta: { changes: 1 } }));
    },
    prepare(sql) {
      return {
        bind(...args) {
          writes.push({ sql, args });
          return {
            async first() {
              if (sql.includes("SELECT gender FROM users")) return { gender };
              if (sql.includes("FROM cycle_profiles")) return profile;
              return null;
            },
            async all() {
              if (sql.includes("FROM cycle_profiles p JOIN users u")) return { results: [] };
              return { results: pick(sql) };
            },
            async run() {
              return { meta: { changes: 1 } };
            }
          };
        },
        async batch() {
          return {};
        }
      };
    }
  };
  return db;
}

function makeEnv({ method = "GET", path = "/api/cycle/stats", body = {}, gender = "female", rows = {}, profile = null, stateMock = null, telegramCalls = null, pair = null } = {}) {
  const db = createStatsDB({ gender, rows, profile });
  const request = { method, headers: { get: () => null } };
  const api = buildApi(
    (data, status = 200) => ({ data, status }),
    async () => {},
    async () => ({ id: 777, first_name: "Тест" }),
    () => "Europe/Moscow",
    async () => ({ tg_id: 777, first_name: "Тест" }),
    async () => {},
    async () => body,
    async () => ({ user: { tg_id: 777, gender }, pair: null }),
    async () => pair,
    async () => [],
    stateMock || (async () => ({ periods: [], logs: [] })),
    async (env, methodName, form) => {
      if (telegramCalls) telegramCalls.push({ method: methodName, form });
      return { ok: true };
    },
    async () => ({ meds: [], reminders: [] })
  );
  return { api, env: { DB: db }, request, writes: db.writes };
}

const LOG_ROW = {
  date: "2026-11-10", flow: "light", clots: 0, mood: "calm", energy: "normal",
  symptoms: null, symptoms_clear: 0, note: null, sex: null, sex_count: 1,
  leakage: null, pain_score: 4, pain_locations: null, life_impact: null,
  mucus: null, sleep_hours: 7.5, sleep_quality: "good", stress: "low",
  sick: 0, travel: 0, weight_kg: null, bleeding_details: null
};

// ---------- /api/cycle/stats ----------

test("S1: GET /api/cycle/stats отдаёт daily с полями самочувствия и meds-агрегацию", async () => {
  const { api, env, request } = makeEnv({
    path: "/api/cycle/stats?months=6",
    rows: {
      cycle_periods: [{ start_date: "2026-10-01", end_date: "2026-10-05", end_unknown: 0 }],
      cycle_logs: [LOG_ROW],
      cycle_measurements: [{ date: "2026-11-10", time: "07:00", kind: "bbt", value: 36.6, unit: "C", result: null, note: null }],
      cycle_meds: [{ id: 5, name: "Фолиевая", status: "active", start_date: "2026-01-01", end_date: null }],
      cycle_med_logs: [{ med_id: 5, date: "2026-11-10", status: "taken" }, { med_id: 5, date: "2026-11-11", status: "skipped" }]
    }
  });
  const res = await api(request, env, new URL("https://t.test/api/cycle/stats?months=6"));
  equal(res.status, 200);
  const s = res.data;
  ok(Array.isArray(s.daily), "daily — массив");
  const day = s.daily.find(d => d.date === "2026-11-10");
  ok(day, "день с записью есть");
  equal(day.mood, "calm");
  equal(day.energy, "normal");
  equal(day.sleep_hours, 7.5);
  equal(day.sleep_quality, "good");
  equal(day.stress, "low");
  ok(Array.isArray(s.measurements) && s.measurements[0].kind === "bbt", "измерения отданы");
  equal(s.meds[0].taken, 1);
  equal(s.meds[0].skipped, 1);
  ok(s.insights, "insights присутствует");
});

test("S2: stats при мусорном months откатывается на 12 и не падает на пустых данных", async () => {
  const { api, env, request } = makeEnv({ path: "/api/cycle/stats?months=99" });
  const res = await api(request, env, new URL("https://t.test/api/cycle/stats?months=99"));
  equal(res.status, 200);
  ok(Array.isArray(res.data.daily) && res.data.daily.length === 0);
});

test("S3: daily без необязательных полей — null, а не undefined/крах", async () => {
  const sparse = { ...LOG_ROW, mood: null, energy: null, sleep_hours: null, sleep_quality: null, stress: null, pain_score: null, flow: null };
  const { api, env, request } = makeEnv({
    path: "/api/cycle/stats",
    rows: { cycle_logs: [sparse] }
  });
  const res = await api(request, env, new URL("https://t.test/api/cycle/stats"));
  equal(res.status, 200);
  const day = res.data.daily[0];
  equal(day.mood, null);
  equal(day.sleep_hours, null);
  equal(day.flow, null);
});

// ---------- /api/cycle/history ----------

test("S4: GET /api/cycle/history валидирует диапазон и отдаёт все категории", async () => {
  const { api, env, request } = makeEnv({
    path: "/api/cycle/history?from=2026-01-01&to=2026-12-31",
    rows: {
      cycle_periods: [{ start_date: "2026-10-01", end_date: "2026-10-05", end_unknown: 0 }],
      cycle_logs: [LOG_ROW],
      cycle_meds: [{ id: 5, name: "Фолиевая" }],
      cycle_med_logs: [{ med_id: 5, date: "2026-11-10", status: "taken" }],
      cycle_measurements: [{ id: 1, date: "2026-11-10", time: "07:00", kind: "lh", value: null, unit: null, result: "positive", note: null }]
    }
  });
  await api(request, env, new URL("https://t.test/api/cycle/history?from=2026-12-31&to=2026-01-01")).then(
    () => { throw new Error("expected 400"); },
    (e) => equal(e.status, 400)
  );
  await api(request, env, new URL("https://t.test/api/cycle/history?from=2024-01-01&to=2026-12-31")).then(
    () => { throw new Error("expected 400"); },
    (e) => equal(e.status, 400)
  );
  const res = await api(request, env, new URL("https://t.test/api/cycle/history?from=2026-01-01&to=2026-12-31"));
  equal(res.status, 200);
  const h = res.data;
  equal(h.periods.length, 1);
  equal(h.periods[0].end_unknown, false);
  equal(h.logs[0].date, "2026-11-10");
  equal(h.meds.length, 1);
  equal(h.med_logs.length, 1);
  equal(h.measurements[0].result, "positive");
});

// ---------- /api/cycle/export ----------

test("S5: POST /api/cycle/export шлёт документ только владельцу через telegramForm", async () => {
  const telegramCalls = [];
  const { api, env, request } = makeEnv({
    method: "POST", path: "/api/cycle/export", body: {},
    rows: { cycle_logs: [LOG_ROW] },
    profile: { avg_cycle_length: 28, avg_period_length: 5, share_enabled: 0, share_level: "phases", context: null },
    telegramCalls
  });
  const res = await api(request, env, new URL("https://t.test/api/cycle/export"));
  equal(res.status, 200);
  equal(res.data.ok, true);
  equal(telegramCalls.length, 1, "telegramForm вызван один раз");
  equal(telegramCalls[0].method, "sendDocument");
  // chat_id — tg_id владельца: документ не уходит партнёру.
  const formData = telegramCalls[0].form;
  ok(formData, "форма с документом передана");
});

// ---------- delete / share-notify ----------

test("S6: /api/cycle/period/delete валидирует дату и пишет DELETE", async () => {
  const stateMock = async () => ({ periods: [], logs: [] });
  const { api, env, request, writes } = makeEnv({ method: "POST", path: "/api/cycle/period/delete", body: { start: "bad" }, stateMock });
  await api(request, env, new URL("https://t.test/api/cycle/period/delete")).then(
    () => { throw new Error("expected 400"); },
    (e) => equal(e.status, 400)
  );
  // Проверяем, что валидный запрос доходит до DELETE (env2 с валидной датой).
  const env2 = makeEnv({ method: "POST", path: "/api/cycle/period/delete", body: { start: "2026-10-01" }, stateMock });
  const res2 = await env2.api(env2.request, env2.env, new URL("https://t.test/api/cycle/period/delete"));
  equal(res2.status, 200);
  ok(env2.writes.some(w => w.sql.includes("DELETE FROM cycle_periods")), "DELETE записан");
  ok(env2.writes.find(w => w.sql.includes("DELETE FROM cycle_periods")).args.includes("2026-10-01"), "старт в bind");
});

test("S7: /api/cycle/med-log/delete валидирует и удаляет отметку приёма", async () => {
  const stateMock = async () => ({ meds: [] });
  const bad = makeEnv({ method: "POST", path: "/api/cycle/med-log/delete", body: { med_id: "x", date: "2026-11-10" }, stateMock });
  await bad.api(bad.request, bad.env, new URL("https://t.test/api/cycle/med-log/delete")).then(
    () => { throw new Error("expected 400"); },
    (e) => equal(e.status, 400)
  );
  const good = makeEnv({ method: "POST", path: "/api/cycle/med-log/delete", body: { med_id: 5, date: "2026-11-10" }, stateMock });
  const res = await good.api(good.request, good.env, new URL("https://t.test/api/cycle/med-log/delete"));
  equal(res.status, 200);
  ok(good.writes.some(w => w.sql.includes("DELETE FROM cycle_med_logs")), "DELETE med_logs записан");
});

test("S8: PATCH /api/cycle/share-notify принимает только boolean", async () => {
  const stateMock = async () => ({ share: { notify: true } });
  const bad = makeEnv({ method: "PATCH", path: "/api/cycle/share-notify", body: { enabled: "yes" }, stateMock });
  await bad.api(bad.request, bad.env, new URL("https://t.test/api/cycle/share-notify")).then(
    () => { throw new Error("expected 400"); },
    (e) => equal(e.status, 400)
  );
  const good = makeEnv({ method: "PATCH", path: "/api/cycle/share-notify", body: { enabled: true }, stateMock });
  const res = await good.api(good.request, good.env, new URL("https://t.test/api/cycle/share-notify"));
  equal(res.status, 200);
  const upd = good.writes.find(w => w.sql.includes("share_notify=?"));
  ok(upd, "UPDATE share_notify записан");
  equal(upd.args[0], 1);
});

// ---------- /api/health/med-log/delete ----------

test("S9: /api/health/med-log/delete валидирует и удаляет персональную отметку", async () => {
  const bad = makeEnv({ method: "POST", path: "/api/health/med-log/delete", body: { med_id: 1, date: "nope" } });
  await bad.api(bad.request, bad.env, new URL("https://t.test/api/health/med-log/delete")).then(
    () => { throw new Error("expected 400"); },
    (e) => equal(e.status, 400)
  );
  const good = makeEnv({ method: "POST", path: "/api/health/med-log/delete", body: { med_id: 1, date: "2026-11-10" } });
  const res = await good.api(good.request, good.env, new URL("https://t.test/api/health/med-log/delete"));
  equal(res.status, 200);
  ok(good.writes.some(w => w.sql.includes("DELETE FROM health_med_logs")), "DELETE health_med_logs записан");
});

// ---------- /api/daily/done ----------

function makeDailyDB() {
  const completed = new Set();
  const writes = [];
  let batchCalls = 0;
  return {
    writes,
    get completed() { return completed; },
    prepare(sql) {
      const stmt = {
        __args: [],
        bind(...args) { return { ...stmt, __args: args }; },
        async first() {
          if (sql.includes("FROM daily_rolls")) return { daily_value: "Тестовое действие" };
          return null;
        },
        async all() {
          if (sql.includes("FROM daily_completions")) {
            return { results: [...completed].map(tg_id => ({ tg_id })) };
          }
          return { results: [] };
        },
        async run() { writes.push({ sql, args: stmt.__args }); return { meta: { changes: 1 } }; }
      };
      return stmt;
    },
    async batch(statements) {
      batchCalls += 1;
      writes.push({ sql: "BATCH", args: [] });
      // Первый захват успешен; повторный INSERT OR IGNORE даёт changes=0.
      const captured = batchCalls === 1 ? 1 : 0;
      if (captured) completed.add(777);
      return [{ meta: { changes: captured } }, { meta: { changes: captured } }];
    }
  };
}

test("D1: /api/daily/done — awarded:true при захвате, повтор идемпотентен без дубля XP", async () => {
  const pair = { id: 5, user_a: 777, user_b: 555, timezone: "Europe/Moscow" };
  const { api, env, request } = makeEnv({ method: "POST", path: "/api/daily/done", pair });
  env.DB = makeDailyDB();
  const res1 = await api(request, env, new URL("https://t.test/api/daily/done"));
  equal(res1.status, 200);
  equal(res1.data.awarded, true, "первый вызов начисляет");
  const res2 = await api(request, env, new URL("https://t.test/api/daily/done"));
  equal(res2.data.awarded, false, "повтор — уже отмечено, без повторного XP");
  const batches = env.DB.writes.filter(w => w.sql === "BATCH");
  equal(batches.length, 1, "batch с INSERT+UPDATE XP вызван ровно один раз");
});

test("D2: /api/daily/done без user_b → 409 PAIR_INCOMPLETE", async () => {
  const pair = { id: 5, user_a: 777, user_b: null, timezone: "Europe/Moscow" };
  const { api, env, request } = makeEnv({ method: "POST", path: "/api/daily/done", pair });
  env.DB = makeDailyDB();
  await api(request, env, new URL("https://t.test/api/daily/done")).then(
    () => { throw new Error("expected 409"); },
    (e) => equal(e.status, 409)
  );
});
