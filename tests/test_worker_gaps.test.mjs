// Покрытие worker-функций, у которых не было прямых тестов:
// createPair (гонка кода пары), callbackSignature (HMAC fallback-кнопок),
// actionTargetUrl (dp_*-параметры Web App-кнопки), actionResultText (тексты
// результатов Widget/callback), consumeActionTokenGroup (закрытие группы
// nonce), updateWidgetChatData (best-effort правка chat_data Widget).
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { createHmac } from "node:crypto";
import { deepStrictEqual, equal, match, ok, rejects } from "node:assert/strict";
import { test } from "node:test";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const source = readFileSync(join(root, "worker.js"), "utf8");

function extractBraced(declaration) {
  const start = source.indexOf(declaration);
  if (start === -1) throw new Error(`${declaration} not found`);
  let depth = 0;
  for (let j = source.indexOf("{", start); j < source.length; j++) {
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

const buildWorker = new Function(
  "membership", "telegram", "localDay",
  [
    extractBraced("class HttpError"),
    extractLine("const now = "),
    extractLine("const DEFAULT_TZ = "),
    source.slice(source.indexOf("const ACTION_RESULT_TEXT = {"), source.indexOf("function actionResultText")),
    extractBraced("function hex"),
    extractBraced("async function hmac"),
    extractBraced("function appUrl"),
    extractBraced("function localDay"),
    extractBraced("function validTimeZone"),
    extractBraced("async function callbackSignature"),
    extractBraced("function actionTargetUrl"),
    extractBraced("function actionResultText"),
    extractBraced("async function consumeActionTokenGroup"),
    extractBraced("async function updateWidgetChatData"),
    extractBraced("async function createPair"),
    "return { createPair, callbackSignature, actionTargetUrl, actionResultText, consumeActionTokenGroup, updateWidgetChatData, now, HttpError };"
  ].join("\n")
);

const stubMembership = () => null;
const stubTelegram = async () => {};
const stubLocalDay = () => "2026-11-24";
const W = buildWorker(stubMembership, stubTelegram, stubLocalDay);

// Мок БД: prepare/bind записываются, batch может падать (гонка кода пары),
// first() для updateWidgetChatData возвращает управляемую строку.
function makeDb({ batchFails = false, widgetRow = undefined } = {}) {
  const calls = { prepare: [], binds: [], batches: [], runs: [] };
  const db = {
    prepare(sql) {
      calls.prepare.push(sql);
      return {
        bind(...args) {
          calls.binds.push({ sql, args });
          return {
            sql, args,
            async first() { return widgetRow ?? null; },
            async all() { return { results: [] }; },
            async run() { calls.runs.push({ sql, args }); return { meta: { changes: 1 } }; }
          };
        },
        async first() { return widgetRow ?? null; },
        async all() { return { results: [] }; },
        async run() { calls.runs.push({ sql, args: [] }); return { meta: { changes: 1 } }; }
      };
    },
    async batch(statements) {
      calls.batches.push(statements.map(s => ({ sql: s.sql, args: s.args })));
      if (batchFails) throw new Error("UNIQUE constraint failed: pairs.code");
      return statements.map(() => ({ meta: { changes: 1 } }));
    }
  };
  return { db, calls };
}

function isHttpError(error, status, code) {
  return error && error.status === status && error.code === code;
}

// ---------- createPair ----------

test("createPair: существующее членство возвращается без записи в БД", async () => {
  const existing = { id: 7, user_a: 42 };
  const { db, calls } = makeDb();
  const w = buildWorker(async () => existing, stubTelegram, stubLocalDay);
  const result = await w.createPair({ DB: db }, { tg_id: 42, display_name: "Аня", timezone: "Europe/Moscow" });
  equal(result, existing);
  deepStrictEqual(calls.batches, [], "batch не выполняется");
});

test("createPair: batch из трёх операторов, код — 8 hex-символов в верхнем регистре", async () => {
  const created = { id: 1, user_a: 42 };
  let membershipCalls = 0;
  const { db, calls } = makeDb();
  const w = buildWorker(async () => (++membershipCalls === 1 ? null : created), stubTelegram, stubLocalDay);
  const result = await w.createPair({ DB: db }, { tg_id: 42, display_name: "Аня", timezone: "Europe/Moscow" });
  equal(result, created);
  equal(calls.batches.length, 1, "создание — один batch");
  const ops = calls.batches[0];
  equal(ops.length, 3, "INSERT pairs + INSERT pair_members + UPDATE users");
  const [code, name, ownerId, day, tz] = ops[0].args;
  match(code, /^[A-F0-9]{8}$/, "код 8 hex-символов в верхнем регистре");
  equal(name, "Аня");
  equal(ownerId, 42);
  equal(day, "2026-11-24", "started_at — местный день владельца");
  equal(tz, "Europe/Moscow");
  ok(ops[1].sql.includes("pair_members"), "членство в паре");
  ok(ops[2].sql.includes("points=0,streak=0,best_streak=0"), "личная история обнуляется атомарно");
});

test("createPair: гонка кода — членство от конкурентного isolate возвращается без ошибки", async () => {
  const raced = { id: 9, user_a: 42 };
  let call = 0;
  const { db, calls } = makeDb({ batchFails: true });
  const w = buildWorker(async () => (++call === 1 ? null : raced), stubTelegram, stubLocalDay);
  const result = await w.createPair({ DB: db }, { tg_id: 42, display_name: "Аня" });
  equal(result, raced, "raced-пара — источник истины");
  equal(calls.batches.length, 1, "после успешной проверки raced повторов нет");
});

// Три неудачи: последняя попытка перебрасывает сырую ошибку batch
// (HttpError PAIR_CREATE_FAILED после цикла недостижима — attempt===2
// всегда бросает раньше), фактическое поведение и покрываем.
test("createPair: три неудачи — сырая ошибка batch после трёх попыток", async () => {
  const { db, calls } = makeDb({ batchFails: true });
  const w = buildWorker(stubMembership, stubTelegram, stubLocalDay);
  await rejects(
    w.createPair({ DB: db }, { tg_id: 42, display_name: "Аня" }),
    /UNIQUE constraint failed: pairs\.code/
  );
  equal(calls.batches.length, 3, "три попытки генерации кода");
  const codes = calls.batches.map(batch => batch[0].args[0]);
  ok(new Set(codes).size === 3, "каждая попытка — новый код");
});

// ---------- callbackSignature ----------

test("callbackSignature: HMAC-SHA256(WEBHOOK_SECRET), первые 24 hex-символа", async () => {
  const env = { WEBHOOK_SECRET: "whsec-test" };
  const payload = "dp1|td|42|777";
  const sig = await W.callbackSignature(env, payload);
  match(sig, /^[0-9a-f]{24}$/);
  equal(sig, createHmac("sha256", "whsec-test").update(payload).digest("hex").slice(0, 24),
    "подпись совпадает с независимым HMAC-расчётом");
});

test("callbackSignature: другой payload или секрет — другая подпись", async () => {
  const env = { WEBHOOK_SECRET: "whsec-test" };
  const a = await W.callbackSignature(env, "dp1|td|42|777");
  const b = await W.callbackSignature(env, "dp1|td|42|888");
  const c = await W.callbackSignature({ WEBHOOK_SECRET: "other" }, "dp1|td|42|777");
  ok(a !== b && a !== c, "привязка к tg_id получателя и секрету");
});

// ---------- actionTargetUrl ----------

const REQ = "https://duoplan.workers.dev/api/daily";
const ORIGIN = "https://duoplan.example";

test("actionTargetUrl: dp_v/dp_target/dp_day/dp_id, только dp_*-параметры", () => {
  const url = new URL(W.actionTargetUrl({ APP_ORIGIN: ORIGIN }, REQ, { type: "health_med", day: "2026-11-24", id: 7, title: "Секретное название" }));
  equal(`${url.origin}${url.pathname}`, `${ORIGIN}/app`);
  equal(url.searchParams.get("dp_v"), "1");
  equal(url.searchParams.get("dp_target"), "health_med");
  equal(url.searchParams.get("dp_day"), "2026-11-24");
  equal(url.searchParams.get("dp_id"), "7");
  ok([...url.searchParams.keys()].every(key => key.startsWith("dp_")), "персональные данные не попадают в query");
  ok(!url.search.includes(encodeURIComponent("Секретное название")), "название цели не в ссылке");
});

test("actionTargetUrl: без APP_ORIGIN берётся origin запроса", () => {
  const url = new URL(W.actionTargetUrl({}, new URL(REQ), { type: "task_done" }));
  equal(url.origin, "https://duoplan.workers.dev");
  equal(url.searchParams.get("dp_target"), "task_done");
});

test("actionTargetUrl: без дня и целого id параметры не ставятся", () => {
  const url = new URL(W.actionTargetUrl({ APP_ORIGIN: ORIGIN }, REQ, { type: "task_done", id: "abc" }));
  equal(url.searchParams.get("dp_day"), null);
  equal(url.searchParams.get("dp_id"), null, "нецелый id не попадает в dp_id");
});

// ---------- actionResultText ----------

test("actionResultText: все статусы имеют текст, skipped уточняет «Принято»", () => {
  equal(W.actionResultText("task_done", "done"), "План отмечен выполненным");
  equal(W.actionResultText("health_med", "done"), "Принято");
  equal(W.actionResultText("health_med", "done", "skipped"), "Отмечено как пропущенное");
  equal(W.actionResultText("task_done", "already"), "Уже выполнено");
  equal(W.actionResultText("health_med", "already"), "Уже отмечено");
  equal(W.actionResultText("health_med", "conflict"), "На эту дату уже есть другая отметка — измените её в приложении");
  equal(W.actionResultText("task_done", "stale"), "Кнопка устарела — откройте DuoPlan через меню бота");
  equal(W.actionResultText("health_med", "unavailable"), "Действие недоступно");
  equal(W.actionResultText("unknown", "done"), "Действие недоступно");
});

// ---------- consumeActionTokenGroup ----------

test("consumeActionTokenGroup: без группы — ни одного запроса к БД", async () => {
  const { db, calls } = makeDb();
  await W.consumeActionTokenGroup({ DB: db }, null);
  await W.consumeActionTokenGroup({ DB: db }, "");
  deepStrictEqual(calls.prepare, [], "нет UPDATE");
});

test("consumeActionTokenGroup: UPDATE закрывает только не потреблённые nonce группы", async () => {
  const { db, calls } = makeDb();
  await W.consumeActionTokenGroup({ DB: db }, "grp123");
  equal(calls.prepare.length, 1);
  const write = calls.binds[0];
  ok(write.sql.includes("SET consumed_at=? WHERE group_id=? AND consumed_at IS NULL"));
  deepStrictEqual(write.args[1], "grp123", "group_id в условии");
});

// ---------- updateWidgetChatData ----------

function makeWidgetEnv(row, telegramImpl) {
  const { db, calls } = makeDb({ widgetRow: row });
  const tgCalls = [];
  const telegram = async (env, method, params) => {
    tgCalls.push({ method, params });
    if (telegramImpl) return telegramImpl(method, params);
    return {};
  };
  return { env: { DB: db }, calls, tgCalls, telegram };
}

test("updateWidgetChatData: результат и accent пишутся в chat_data, реестр помечается consumed", async () => {
  const row = { chat_data: JSON.stringify({ a: "berry", d: null, acts: [[ "t1", "Кнопка", null ]] }) };
  const { env, calls, tgCalls, telegram } = makeWidgetEnv(row);
  const w = buildWorker(stubMembership, telegram, stubLocalDay);
  await w.updateWidgetChatData(env, 100, 55, "Принято", "ocean");
  equal(tgCalls.length, 1);
  equal(tgCalls[0].method, "editMessageWidgetData");
  equal(tgCalls[0].params.chat_id, 100);
  equal(tgCalls[0].params.message_id, 55);
  const state = JSON.parse(tgCalls[0].params.chat_data);
  equal(state.d, "Принято", "текст результата блокирует кнопки Widget");
  equal(state.a, "ocean", "accent обновляется");
  deepStrictEqual(state.acts, [["t1", "Кнопка", null]], "кнопки не трогаются");
  const registry = calls.runs.find(run => run.sql.includes("status='consumed'"));
  ok(registry, "реестр обновляется после успешной правки");
  equal(registry.args[0], tgCalls[0].params.chat_data);
});

test("updateWidgetChatData: без записи реестра Telegram не вызывается", async () => {
  const { env, calls, tgCalls, telegram } = makeWidgetEnv(undefined);
  const w = buildWorker(stubMembership, telegram, stubLocalDay);
  await w.updateWidgetChatData(env, 100, 55, "Готово", null);
  deepStrictEqual(tgCalls, []);
  deepStrictEqual(calls.runs, []);
});

test("updateWidgetChatData: ошибка Telegram не мешает пометке реестра", async () => {
  const row = { chat_data: JSON.stringify({ a: "berry", d: null, acts: [] }) };
  const { env, calls, tgCalls, telegram } = makeWidgetEnv(row, () => {
    throw new Error("Bad Request: message to edit not found");
  });
  const w = buildWorker(stubMembership, telegram, stubLocalDay);
  await w.updateWidgetChatData(env, 100, 55, "Готово", null);
  equal(tgCalls.length, 1, "правка пыталась выполниться");
  ok(calls.runs.some(run => run.sql.includes("status='consumed'")), "реестр всё равно помечается consumed");
});
