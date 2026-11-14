// Тесты cron-контура напоминаний Фло: sendCycleReminders и scheduled().
// deliverNotification используется настоящий — дедуп проверяется через
// INSERT OR IGNORE в notification_log на моковой D1.
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

function extractConstObject(name) {
  const start = source.indexOf(`const ${name} = {`);
  if (start === -1) throw new Error(`${name} not found`);
  let depth = 0;
  for (let j = source.indexOf("{", start); j < source.length; j++) {
    if (source[j] === "{") depth++;
    else if (source[j] === "}") {
      depth--;
      if (depth === 0) return source.slice(start, j + 2);
    }
  }
  throw new Error(`unclosed const: ${name}`);
}

const sharedFns = [
  extractLine("const CYCLE_MS_DAY"),
  extractLine("const now = "),
  extractBraced("function cycleDayNum"),
  extractBraced("function cycleDateStr"),
  extractBraced("function cycleReminderKinds"),
  extractBraced("async function deliverNotification"),
].join("\n");

// Харнесс A: настоящий sendCycleReminders + настоящий deliverNotification.
const buildReminders = new Function(
  "validTimeZone", "DEFAULT_TZ", "cycleState", "cycleForecast", "openApp",
  `${sharedFns}
   ${extractConstObject("CYCLE_PARTNER_NOTICES")}
   ${extractBraced("async function sendCycleReminders")}
   return { sendCycleReminders };`
);

// Харнесс B: только scheduled() — три cron-задачи подменены стабами.
const buildScheduled = new Function(
  "sendDigests", "sendCycleReminders", "sendHealthReminders",
  `${extractBraced("async scheduled(event, env)").replace("async scheduled(", "async function scheduled(")}
   return { scheduled };`
);

// Мок D1 для крона: owners-запрос, pair_members и notification_log.
function makeCronDB({ owners = [], partners = {} } = {}) {
  const inserts = new Set();
  const writes = [];
  return {
    inserts,
    writes,
    prepare(sql) {
      const stmt = {
        __args: [],
        bind(...args) { return { ...stmt, __args: args }; },
        async all() { return queryAll(sql, this.__args); },
        async run() { return queryRun(sql, this.__args); },
        async first() { return null; }
      };
      return stmt;
    }
  };
  function queryAll(sql, args) {
    if (sql.includes("FROM cycle_profiles p JOIN users u")) return Promise.resolve({ results: owners });
    if (sql.includes("FROM pair_members pm1")) {
      return Promise.resolve({ results: partners[args[0]] || [] });
    }
    return Promise.resolve({ results: [] });
  }
  function queryRun(sql, args) {
    writes.push({ sql, args });
    if (sql.includes("INSERT OR IGNORE INTO notification_log")) {
      const key = args.slice(0, 3).join("|");
      if (inserts.has(key)) return Promise.resolve({ meta: { changes: 0 } });
      inserts.add(key);
      return Promise.resolve({ meta: { changes: 1 } });
    }
    return Promise.resolve({ meta: { changes: 1 } });
  }
}

function makeRemindersEnv({ owners = [], partners = {}, states = {}, forecastByOwner = {}, beforePhase = {} } = {}) {
  const db = makeCronDB({ owners, partners });
  const sent = [];
  const { sendCycleReminders } = buildReminders(
    () => "Europe/Moscow",
    "Europe/Moscow",
    async (env, tgId) => {
      if (!states[tgId]) throw new Error(`no state for ${tgId}`);
      return states[tgId];
    },
    // cycleForecast используется только для «фазы вчера» в партнёрской ветке.
    (periods, profile, yesterday) => ({ phase: beforePhase[yesterday] ?? "follicular" }),
    async (env, member, opts, text) => { sent.push({ member, text }); }
  );
  return { sendCycleReminders, env: { DB: db }, db, sent };
}

const OWNER = {
  tg_id: 100, timezone: "Europe/Moscow",
  notify_enabled: 1, notify_period: 1, notify_ovulation: 1, notify_fertile: 1,
  notify_delay: 1, notify_period_days: 2, notify_delay_days: 3, notify_diary: 1,
  share_enabled: 0, share_notify: 0
};

function state(over = {}) {
  return {
    today: "2026-11-10",
    periods: [], profile: {}, measurements: [], logs: [],
    forecast: { empty: true, phase: "follicular", quality: "full", based_on: "history" },
    ...over
  };
}

// ---------- напоминания владельцу ----------

test("R1: period-напоминание уходит при next_period_in === period_days", async () => {
  const forecast = { empty: false, phase: "follicular", next_period_in: 2, ovulation_in: 9, delay_days: 0, quality: "full", based_on: "history" };
  const { sendCycleReminders, env, sent } = makeRemindersEnv({
    owners: [OWNER],
    states: { 100: state({ forecast }) }
  });
  await sendCycleReminders(env);
  ok(sent.some(m => m.member === 100 && m.text.includes("месячные")), "напоминание о месячных отправлено");
});

test("R2: diary-напоминание — только когда вчера нет записи; с записью не шлём", async () => {
  const { sendCycleReminders, env, sent } = makeRemindersEnv({
    owners: [OWNER],
    states: { 100: state({ logs: [] }) }
  });
  await sendCycleReminders(env);
  ok(sent.some(m => m.text.includes("дневнике Фло")), "вчера без записи — подсказка ушла");

  const sent2 = [];
  const db2 = makeCronDB({ owners: [OWNER] });
  const { sendCycleReminders: scr2 } = buildReminders(
    () => "Europe/Moscow", "Europe/Moscow",
    async () => state({ logs: [{ date: "2026-11-09" }] }),
    () => ({ phase: "follicular" }),
    async (e, member, o, text) => { sent2.push({ member, text }); }
  );
  await scr2({ DB: db2 });
  ok(!sent2.some(m => m.text.includes("дневнике Фло")), "вчера записан — diary-напоминания нет");
});

test("R3: notify_enabled=0 и выключенные prefs — сообщений нет", async () => {
  const off = { ...OWNER, notify_enabled: 0 };
  const { sendCycleReminders, env, sent } = makeRemindersEnv({
    owners: [off],
    states: { 100: state({ forecast: { empty: false, phase: "luteal", next_period_in: 2, ovulation_in: -1, delay_days: 0 } }) }
  });
  await sendCycleReminders(env);
  equal(sent.length, 0);
});

test("R4: повторный тик в тот же день не дублирует уведомления (notification_log)", async () => {
  const forecast = { empty: false, phase: "follicular", next_period_in: 2, ovulation_in: 9, delay_days: 0, quality: "full", based_on: "history" };
  const { sendCycleReminders, env, sent } = makeRemindersEnv({
    owners: [OWNER],
    states: { 100: state({ forecast }) }
  });
  await sendCycleReminders(env);
  await sendCycleReminders(env);
  const periodMsgs = sent.filter(m => m.text.includes("месячные"));
  equal(periodMsgs.length, 1, "второй тик — INSERT OR IGNORE вернул 0, openApp не звали");
});

// ---------- партнёрские уведомления ----------

test("R5: смена фазы → партнёр получает нейтральное уведомление", async () => {
  const owner = { ...OWNER, share_enabled: 1, share_notify: 1, notify_enabled: 0 };
  const forecast = { empty: false, phase: "ovulation", quality: "full", based_on: "history", data_stale: false };
  const { sendCycleReminders, env, sent } = makeRemindersEnv({
    owners: [owner],
    partners: { 100: [{ tg_id: 200 }] },
    states: { 100: state({ forecast }) },
    beforePhase: { "2026-11-09": "follicular" } // вчера — другая фаза
  });
  // cycleForecast stub возвращает phase по дате «вчера»:
  // sendCycleReminders зовёт его с yesterday=2026-11-09 → before=follicular.
  await sendCycleReminders(env);
  ok(sent.some(m => m.member === 200 && m.text.includes("овуляц")), "партнёр уведомлён об овуляции");
  ok(!sent.some(m => m.member === 200 && /дата|11-09|11-10/.test(m.text)), "без дат в тексте");
});

test("R6: овуляция без достаточного качества данных партнёру не уходит", async () => {
  const owner = { ...OWNER, share_enabled: 1, share_notify: 1, notify_enabled: 0 };
  for (const bad of [
    { quality: "insufficient", based_on: "history" },
    { quality: "full", based_on: "default" },
    { quality: "full", based_on: "history", data_stale: true }
  ]) {
    const { sendCycleReminders, env, sent } = makeRemindersEnv({
      owners: [owner],
      partners: { 100: [{ tg_id: 200 }] },
      states: { 100: state({ forecast: { empty: false, phase: "ovulation", ...bad } }) },
      beforePhase: { "2026-11-09": "follicular" }
    });
    await sendCycleReminders(env);
    ok(!sent.some(m => m.member === 200), `нет уведомления при ${JSON.stringify(bad)}`);
  }
});

test("R7: фаза не изменилась → партнёр молчит; share_notify=0 → молчит", async () => {
  const owner = { ...OWNER, share_enabled: 1, share_notify: 1, notify_enabled: 0 };
  const forecast = { empty: false, phase: "menstruation", quality: "full", based_on: "history" };
  // beforePhase тоже menstruation → phase === before.
  const { sendCycleReminders, env, sent } = makeRemindersEnv({
    owners: [owner],
    partners: { 100: [{ tg_id: 200 }] },
    states: { 100: state({ forecast }) },
    beforePhase: { "2026-11-09": "menstruation" }
  });
  await sendCycleReminders(env);
  ok(!sent.some(m => m.member === 200), "без смены фазы уведомления нет");

  const owner2 = { ...owner, share_notify: 0 };
  const env2 = makeRemindersEnv({
    owners: [owner2],
    partners: { 100: [{ tg_id: 200 }] },
    states: { 100: state({ forecast }) },
    beforePhase: { "2026-11-09": "follicular" }
  });
  await env2.sendCycleReminders(env2.env);
  ok(!env2.sent.some(m => m.member === 200), "share_notify=0 — партнёр не уведомляется");
});

// ---------- устойчивость ----------

test("R8: падение cycleState у одного владельца не останавливает остальных", async () => {
  const good = { ...OWNER, tg_id: 101 };
  const forecast = { empty: false, phase: "follicular", next_period_in: 2, ovulation_in: 9, delay_days: 0, quality: "full", based_on: "history" };
  const { sendCycleReminders, env, sent } = makeRemindersEnv({
    owners: [OWNER, good], // 100 упадёт (нет state), 101 отработает
    states: { 101: state({ forecast }) }
  });
  const errors = [];
  const origErr = console.error;
  console.error = (...a) => errors.push(a);
  try { await sendCycleReminders(env); } finally { console.error = origErr; }
  ok(sent.some(m => m.member === 101), "второй владелец получил напоминание");
  ok(errors.length >= 1, "ошибка первого залогирована");
});

// ---------- scheduled() ----------

test("R9: scheduled() вызывает digest → cycle → health по порядку; сбой cycle не роняет health", async () => {
  const calls = [];
  const { scheduled } = buildScheduled(
    async () => { calls.push("digest"); },
    async () => { calls.push("cycle"); throw new Error("boom"); },
    async () => { calls.push("health"); }
  );
  const origErr = console.error;
  console.error = () => {};
  try { await scheduled({}, {}); } finally { console.error = origErr; }
  deepStrictEqual(calls, ["digest", "cycle", "health"]);
});
