// Тест лимита неудачных попыток входа по коду (checkJoinAttempts /
// recordJoinFailure / joinPair в worker.js).
//
// Репорт 2026-10-29: код приглашения — 4 байта (2^32 вариантов), общий лимит
// 240/мин на аккаунт позволял сотни тысяч попыток перебора в сутки, а путь
// /start CODE в вебхуке не имел лимита вовсе. Теперь joinPair считает только
// неудачные попытки (CODE_NOT_FOUND): 5 неудач за 15 минут на аккаунт — и вход
// по коду блокируется до следующего окна.
//
// Запуск: node tests/test_join_rate_limit.test.mjs  (или node --test "tests/*.test.mjs")
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { deepStrictEqual, equal, ok, strictEqual, throws, rejects } from "node:assert/strict";
import { test } from "node:test";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const source = readFileSync(join(root, "worker.js"), "utf8");

function extractBraced(declaration) {
  const start = source.indexOf(declaration);
  if (start === -1) throw new Error(`${declaration} не найдена`);
  let depth = 0;
  for (let j = source.indexOf("{", start); j < source.length; j++) {
    if (source[j] === "{") depth++;
    else if (source[j] === "}") {
      depth--;
      if (depth === 0) return source.slice(start, j + 1);
    }
  }
  throw new Error(`незакрытая функция: ${declaration}`);
}

function extractLine(prefix) {
  const start = source.indexOf(prefix);
  if (start === -1) throw new Error(`${prefix} не найдено`);
  return source.slice(start, source.indexOf("\n", start));
}

const nowDecl = source.match(/const now = \(\) => [^;]+;/)?.[0];
if (!nowDecl) throw new Error("now() не найдена");
const cleanDecl = source.match(/const clean = [^;]+;/)?.[0];
if (!cleanDecl) throw new Error("clean() не найдена");
const limitDecl = source.match(/const JOIN_ATTEMPT_LIMIT = [^;]+;/)?.[0];
const windowDecl = source.match(/const JOIN_ATTEMPT_WINDOW = [^;]+;/)?.[0];
if (!limitDecl || !windowDecl) throw new Error("константы лимита не найдены");

const preamble = [
  nowDecl,
  cleanDecl,
  limitDecl,
  windowDecl,
  extractBraced("class HttpError"),
  extractLine("const positiveId = "),
  extractBraced("async function checkJoinAttempts"),
  extractBraced("async function recordJoinFailure"),
  extractBraced("async function membership"),
  extractBraced("async function joinPair")
].join("\n");

const load = new Function(`${preamble}\nreturn { joinPair, checkJoinAttempts, recordJoinFailure, HttpError, now };`);
const { joinPair, checkJoinAttempts, recordJoinFailure, HttpError, now } = load();

// Вариант с открытым openApp: нужен тесту возврата партнёра (уведомление
// оставшемуся). escapeHtml внутри joinPair — рабочий из worker.js не нужен,
// достаточно простой подмены.
function loadWithNotifier(openApp) {
  return new Function(
    "openApp",
    "escapeHtml",
    `${preamble}\nreturn { joinPair, HttpError, now };`
  )(openApp, (value) => String(value ?? ""));
}

// Мок D1 с маршрутизацией по SQL: rate_limits — счётчик в Map,
// membership и pairs — настраиваемые таблицы. Успешный batch (вход)
// заполняет membership, как реальная БД после INSERT в pair_members.
function makeJoinMockDb({ membershipRow = null, pairs = {}, closedCodes = [] } = {}) {
  const counters = new Map();
  const batches = [];
  let member = membershipRow;
  const db = {
    prepare(sql) {
      return {
        bind(...params) {
          return {
            async first() {
              if (sql.startsWith("SELECT count FROM rate_limits")) {
                const count = counters.get(params[0]) || 0;
                return { count };
              }
              if (sql.includes("FROM pair_members pm JOIN pairs p")) return member;
              if (sql.startsWith("SELECT * FROM pairs WHERE code=?")) return pairs[params[0]] || null;
              if (sql.includes("FROM closed_codes")) return closedCodes.includes(params[0]) ? { code: params[0] } : null;
              throw new Error("неожиданный first(): " + sql);
            },
            async run() {
              if (sql.startsWith("INSERT INTO rate_limits")) {
                counters.set(params[0], (counters.get(params[0]) || 0) + 1);
                return { meta: { changes: 1 } };
              }
              throw new Error("неожиданный run(): " + sql);
            },
            sql,
            params
          };
        }
      };
    },
    async batch(operations) {
      batches.push(operations.map((op) => op.sql));
      for (const op of operations) {
        if (op.sql.startsWith("INSERT INTO pair_members")) {
          member = { id: op.params[1], tg_id: op.params[0], role: "b" };
        }
      }
      return operations.map(() => ({ meta: { changes: 1 } }));
    }
  };
  return { db, counters, batches };
}

const USER = { tg_id: 42, display_name: "Атакующий" };
const VALID_CODE = "ABCDEF12";
const OPEN_PAIR = { id: 7, code: VALID_CODE, user_a: 1, user_b: 0 };

test("пять неудачных попыток — шестая отклонена даже с верным кодом", async () => {
  const { db, counters } = makeJoinMockDb({ pairs: { [VALID_CODE]: OPEN_PAIR } });
  for (let i = 0; i < 5; i++) {
    await rejects(
      () => joinPair({ DB: db }, USER, "00000000"),
      (error) => error instanceof HttpError && error.status === 404 && error.code === "CODE_NOT_FOUND"
    );
  }
  strictEqual(counters.size, 1, "неудачи копятся в одном окне");
  // Переборщик нашёл верный код — но лимит уже исчерпан.
  await rejects(
    () => joinPair({ DB: db }, USER, VALID_CODE),
    (error) => error instanceof HttpError && error.status === 429 && error.code === "JOIN_RATE_LIMITED"
  );
});

test("успешный вход не расходует лимит", async () => {
  const { db, counters } = makeJoinMockDb({ pairs: { [VALID_CODE]: OPEN_PAIR } });
  const joined = await joinPair({ DB: db }, USER, VALID_CODE);
  strictEqual(joined.id, 7, "после входа возвращается membership новой пары");
  strictEqual(counters.size, 0, "успех не пишется в счётчик неудач");
});

test("некорректный формат кода не расходует лимит", async () => {
  const { db, counters } = makeJoinMockDb({});
  for (const bad of ["XYZ!", "123", "ABCDEF123", ""]) {
    await rejects(() => joinPair({ DB: db }, USER, bad),
      (error) => error.status === 400 && error.code === "INVALID_CODE");
  }
  strictEqual(counters.size, 0, "форматные ошибки не пишутся в счётчик");
  // Контроль: хорошо сформированный неверный код счётчик пополняет.
  await rejects(() => joinPair({ DB: db }, USER, "00000000"), (error) => error.status === 404);
  strictEqual(counters.size, 1);
});

test("участник пары не тратит лимит: ALREADY_PAIRED до проверки счётчика", async () => {
  const { db, counters } = makeJoinMockDb({ membershipRow: { id: 1, code: "AAAA0000" } });
  await rejects(() => joinPair({ DB: db }, USER, VALID_CODE),
    (error) => error.status === 409 && error.code === "ALREADY_PAIRED");
  strictEqual(counters.size, 0);
});

test("код закрытого пространства — 410 PAIR_CLOSED, лимит перебора пишется", async () => {
  // Последний участник вышел: пары нет, но код остался в closed_codes.
  // Отличать «закрыто» от «не найдено» безопасно: неудача в обоих случаях
  // пополняет лимит, перебор не узнаёт, какие коды существовали.
  const { db, counters } = makeJoinMockDb({ closedCodes: [VALID_CODE] });
  await rejects(() => joinPair({ DB: db }, USER, VALID_CODE),
    (error) => error.status === 410 && error.code === "PAIR_CLOSED" && /закрыто/i.test(error.message));
  strictEqual(counters.size, 1, "неудача с закрытым кодом тратит лимит");
});

test("возвращение того же аккаунта уведомляет оставшегося и снимает резерв", async () => {
  const calls = [];
  const openApp = async (env, chatId, requestUrl, text) => { calls.push({ chatId, text }); };
  const { joinPair: joinWithNotify } = loadWithNotifier(openApp);
  const { db, batches } = makeJoinMockDb({
    pairs: { [VALID_CODE]: { ...OPEN_PAIR, awaiting_return: 1, last_partner: 42 } }
  });
  const joined = await joinWithNotify({ DB: db }, USER, VALID_CODE);
  strictEqual(joined.id, 7, "вход состоялся");
  equal(calls.length, 1, "уведомление оставшемуся отправлено");
  equal(calls[0].chatId, 1, "получатель — владелец пары (user_a)");
  ok(calls[0].text.includes("Атакующий"), "в тексте имя вернувшегося");
  ok(calls[0].text.includes("снова в вашем пространстве"));
  ok(batches.flat().some((sql) => sql.includes("awaiting_return=0")), "флаг ожидания снят");
  ok(batches.flat().some((sql) => sql.includes("last_partner=0")), "резерв кода снят");
});

test("чужой аккаунт по коду вышедшего партнёра не входит (PAIR_RESERVED)", async () => {
  // Код «уехал» в пересланные сообщения: пространство ждёт tg_id 42, а не 43.
  const { db } = makeJoinMockDb({
    pairs: { [VALID_CODE]: { ...OPEN_PAIR, awaiting_return: 1, last_partner: 42 } }
  });
  const other = { tg_id: 43, display_name: "Другой" };
  await rejects(() => joinPair({ DB: db }, other, VALID_CODE),
    (error) => error.status === 403 && error.code === "PAIR_RESERVED" && /прежнего партнёра/.test(error.message));
});

test("свежая пара без вышедшего партнёра открыта любому по коду", async () => {
  const { db } = makeJoinMockDb({ pairs: { [VALID_CODE]: OPEN_PAIR } });
  const joined = await joinPair({ DB: db }, { tg_id: 43, display_name: "Другой" }, VALID_CODE);
  strictEqual(joined.id, 7, "awaiting_return=0 — резерв не проверяется");
});

test("первый вход по коду (партнёр не выходил) уведомления не шлёт", async () => {
  const calls = [];
  const openApp = async (env, chatId, requestUrl, text) => { calls.push({ chatId, text }); };
  const { joinPair: joinWithNotify } = loadWithNotifier(openApp);
  const { db } = makeJoinMockDb({ pairs: { [VALID_CODE]: OPEN_PAIR } });
  await joinWithNotify({ DB: db }, USER, VALID_CODE);
  equal(calls.length, 0, "без awaiting_return=1 уведомления нет");
});

test("recordJoinFailure пишет окно с expires_at, checkJoinAttempts читает тот же ключ", async () => {
  const { db, counters } = makeJoinMockDb({});
  await recordJoinFailure({ DB: db }, 42);
  const bucket = Math.floor(now() / (15 * 60));
  const key = `jf:42:${bucket}`;
  strictEqual(counters.get(key), 1, `ключ jf:<id>:<bucket>, получено: ${[...counters.keys()].join(", ")}`);
  // Держим expires_at в совместимости с чисткой rateLimit: удаление по expires_at < now.
  const expiresAt = (bucket + 1) * 15 * 60;
  strictEqual(expiresAt > now(), true, "текущее окно ещё не истекло");
  // Порог: 4 неудачи — вход ещё разрешён, 5-я попытка (после пятой неудачи) — нет.
  counters.set(key, 4);
  await checkJoinAttempts({ DB: db }, 42);
  counters.set(key, 5);
  await rejects(() => checkJoinAttempts({ DB: db }, 42),
    (error) => error.status === 429 && error.code === "JOIN_RATE_LIMITED");
});

test("лимит считается по аккаунту: у другого пользователя свой счётчик", async () => {
  const { db, counters } = makeJoinMockDb({ pairs: { [VALID_CODE]: OPEN_PAIR } });
  for (let i = 0; i < 5; i++) {
    await rejects(() => joinPair({ DB: db }, USER, "00000000"), (error) => error.status === 404);
  }
  // Другой аккаунт — отдельный ключ, вход разрешён.
  const other = { tg_id: 43, display_name: "Другой" };
  const joined = await joinPair({ DB: db }, other, VALID_CODE);
  strictEqual(Boolean(joined), true);
  strictEqual(counters.get(`jf:43:${Math.floor(now() / (15 * 60))}`), undefined);
});
