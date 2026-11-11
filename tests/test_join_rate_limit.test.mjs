// Тест лимита неудачных попыток входа по коду (claimJoinAttempt /
// releaseJoinAttempt / joinPair в worker.js).
//
// Репорт 2026-10-29: код приглашения — 4 байта (2^32 вариантов), общий лимит
// 240/мин на аккаунт позволял сотни тысяч попыток перебора в сутки, а путь
// /start CODE в вебхуке не имел лимита вовсе. Теперь joinPair считает только
// неудачные попытки (CODE_NOT_FOUND): 5 неудач за 15 минут на аккаунт — и вход
// по коду блокируется до следующего окна.
//
// Аудит 2026-11-11 (P2): SELECT + отдельный инкремент обходились параллельными
// запросами. Слот резервируется одним UPSERT ... RETURNING до чтения кода,
// успешный вход возвращает его.
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
  extractBraced("async function claimJoinAttempt"),
  extractBraced("async function releaseJoinAttempt"),
  extractBraced("async function membership"),
  extractBraced("async function joinPair")
].join("\n");

const load = new Function(`${preamble}\nreturn { joinPair, claimJoinAttempt, releaseJoinAttempt, HttpError, now };`);
const { joinPair, claimJoinAttempt, releaseJoinAttempt, HttpError, now } = load();

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
function makeJoinMockDb({ membershipRow = null, pairs = {}, closedCodes = [], memberStats = null } = {}) {
  const counters = new Map();
  const batches = [];
  let pairReads = 0;
  let member = membershipRow;
  const db = {
    prepare(sql) {
      return {
        bind(...params) {
          return {
            async first() {
              if (sql.startsWith("INSERT INTO rate_limits") && sql.includes("RETURNING count")) {
                const count = (counters.get(params[0]) || 0) + 1;
                counters.set(params[0], count);
                return { count };
              }
              if (sql.includes("FROM pair_members pm JOIN pairs p")) return member;
              if (sql.startsWith("SELECT * FROM pairs WHERE code=?")) {
                pairReads++;
                return pairs[params[0]] || null;
              }
              if (sql.includes("FROM closed_codes")) return closedCodes.includes(params[0]) ? { code: params[0] } : null;
              if (sql.includes("FROM member_stats")) return memberStats;
              throw new Error("неожиданный first(): " + sql);
            },
            async run() {
              if (sql.startsWith("UPDATE rate_limits")) {
                const next = (counters.get(params[0]) || 0) - 1;
                if (next > 0) counters.set(params[0], next);
                else counters.delete(params[0]);
                return { meta: { changes: 1 } };
              }
              if (sql.startsWith("DELETE FROM rate_limits")) {
                if ((counters.get(params[0]) || 0) <= 0) counters.delete(params[0]);
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
  return { db, counters, batches, pairReads: () => pairReads };
}

// Dummy openApp для тестов, где уведомления не нужны (но joinPair вызывает его).
const dummyOpenApp = async () => {};

// Вариант с перехватом member_stats-запроса: нужно перехватывать .first() до batch.
function makeJoinMockDbWithStatIntercept({ membershipRow = null, pairs = {}, closedCodes = [], memberStats = null } = {}) {
  const counters = new Map();
  const batches = [];
  let pairReads = 0;
  let member = membershipRow;
  let statRead = false;
  const db = {
    prepare(sql) {
      return {
        bind(...params) {
          return {
            async first() {
              if (sql.startsWith("INSERT INTO rate_limits") && sql.includes("RETURNING count")) {
                const count = (counters.get(params[0]) || 0) + 1;
                counters.set(params[0], count);
                return { count };
              }
              if (sql.includes("FROM pair_members pm JOIN pairs p")) return member;
              if (sql.startsWith("SELECT * FROM pairs WHERE code=?")) {
                pairReads++;
                return pairs[params[0]] || null;
              }
              if (sql.includes("FROM closed_codes")) return closedCodes.includes(params[0]) ? { code: params[0] } : null;
              if (sql.includes("FROM member_stats")) {
                statRead = true;
                return memberStats;
              }
              throw new Error("неожиданный first(): " + sql);
            },
            async run() {
              if (sql.startsWith("UPDATE rate_limits")) {
                const next = (counters.get(params[0]) || 0) - 1;
                if (next > 0) counters.set(params[0], next);
                else counters.delete(params[0]);
                return { meta: { changes: 1 } };
              }
              if (sql.startsWith("DELETE FROM rate_limits")) {
                if ((counters.get(params[0]) || 0) <= 0) counters.delete(params[0]);
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
  return { db, counters, batches, statRead: () => statRead, pairReads: () => pairReads };
}

const USER = { tg_id: 42, display_name: "Атакующий" };
const VALID_CODE = "ABCDEF12";
const OPEN_PAIR = { id: 7, code: VALID_CODE, user_a: 1, user_b: 0 };

test("пять неудачных попыток — шестая отклонена даже с верным кодом", async () => {
  const { db, counters } = makeJoinMockDb({ pairs: { [VALID_CODE]: OPEN_PAIR } });
  for (let i = 0; i < 5; i++) {
    await rejects(
      () => joinPair({ DB: db, openApp: dummyOpenApp }, USER, "00000000"),
      (error) => error instanceof HttpError && error.status === 404 && error.code === "CODE_NOT_FOUND"
    );
  }
  strictEqual(counters.size, 1, "неудачи копятся в одном окне");
  // Переборщик нашёл верный код — но лимит уже исчерпан.
  await rejects(
    () => joinPair({ DB: db, openApp: dummyOpenApp }, USER, VALID_CODE),
    (error) => error instanceof HttpError && error.status === 429 && error.code === "JOIN_RATE_LIMITED"
  );
});

test("успешный вход не расходует лимит", async () => {
  const { db, counters } = makeJoinMockDb({ pairs: { [VALID_CODE]: OPEN_PAIR } });
  const joined = await joinPair({ DB: db, openApp: dummyOpenApp }, USER, VALID_CODE);
  strictEqual(joined.id, 7, "после входа возвращается membership новой пары");
  strictEqual(counters.size, 0, "успех не пишется в счётчик неудач");
});

test("некорректный формат кода не расходует лимит", async () => {
  const { db, counters } = makeJoinMockDb({});
  for (const bad of ["XYZ!", "123", "ABCDEF123", ""]) {
    await rejects(() => joinPair({ DB: db, openApp: dummyOpenApp }, USER, bad),
      (error) => error.status === 400 && error.code === "INVALID_CODE");
  }
  strictEqual(counters.size, 0, "форматные ошибки не пишутся в счётчик");
  // Контроль: хорошо сформированный неверный код счётчик пополняет.
  await rejects(() => joinPair({ DB: db, openApp: dummyOpenApp }, USER, "00000000"), (error) => error.status === 404);
  strictEqual(counters.size, 1);
});

test("участник пары не тратит лимит: ALREADY_PAIRED до проверки счётчика", async () => {
  const { db, counters } = makeJoinMockDb({ membershipRow: { id: 1, code: "AAAA0000" } });
  await rejects(() => joinPair({ DB: db, openApp: dummyOpenApp }, USER, VALID_CODE),
    (error) => error.status === 409 && error.code === "ALREADY_PAIRED");
  strictEqual(counters.size, 0);
});

test("код закрытого пространства — 410 PAIR_CLOSED, лимит перебора пишется", async () => {
  // Последний участник вышел: пары нет, но код остался в closed_codes.
  // Отличать «закрыто» от «не найдено» безопасно: неудача в обоих случаях
  // пополняет лимит, перебор не узнаёт, какие коды существовали.
  const { db, counters } = makeJoinMockDb({ closedCodes: [VALID_CODE] });
  await rejects(() => joinPair({ DB: db, openApp: dummyOpenApp }, USER, VALID_CODE),
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
  const joined = await joinPair({ DB: db, openApp: dummyOpenApp }, { tg_id: 43, display_name: "Другой" }, VALID_CODE);
  strictEqual(joined.id, 7, "awaiting_return=0 — резерв не проверяется");
});

test("первый вход по коду (партнёр не выходил) уведомления не шлёт", async () => {
  const calls = [];
  const openApp = async (env, chatId, requestUrl, text) => { calls.push({ chatId, text }); };
  const { joinPair: joinWithNotify } = loadWithNotifier(openApp);
  const { db } = makeJoinMockDb({ pairs: { [VALID_CODE]: OPEN_PAIR } });
  await joinWithNotify({ DB: db, openApp }, USER, VALID_CODE);
  equal(calls.length, 0, "без awaiting_return=1 уведомления нет");
});

test("claimJoinAttempt выдаёт уникальные слоты, releaseJoinAttempt возвращает их", async () => {
  const { db, counters } = makeJoinMockDb({});
  const bucket = Math.floor(now() / (15 * 60));
  const key = `jf:42:${bucket}`;
  for (let i = 1; i <= 5; i++) {
    strictEqual(await claimJoinAttempt({ DB: db }, 42), key, "ключ окна jf:<id>:<bucket>");
    strictEqual(counters.get(key), i, `слот ${i} выдан ровно один раз`);
  }
  await rejects(() => claimJoinAttempt({ DB: db }, 42),
    (error) => error.status === 429 && error.code === "JOIN_RATE_LIMITED");
  // Окно 15 минут: expires_at пишется тем же UPSERT, чистка rateLimit — по expires_at.
  strictEqual((bucket + 1) * 15 * 60 > now(), true, "текущее окно ещё не истекло");
  await releaseJoinAttempt({ DB: db }, key);
  strictEqual(counters.get(key), 5, "освобождение уменьшает счётчик на единицу");
});

test("параллельные неудачные входы не обходят лимит", async () => {
  const { db, counters, pairReads } = makeJoinMockDb({});
  const results = await Promise.allSettled(
    Array.from({ length: 12 }, () => joinPair({ DB: db, openApp: dummyOpenApp }, USER, "00000000"))
  );
  const codes = results.map((result) => result.reason?.code);
  strictEqual(codes.filter((code) => code === "CODE_NOT_FOUND").length, 5,
    "до чтения кода дошли ровно JOIN_ATTEMPT_LIMIT запросов");
  strictEqual(codes.filter((code) => code === "JOIN_RATE_LIMITED").length, 7,
    "остальные отклонены до обращения к таблице пар");
  strictEqual(pairReads(), 5, "чтение pairs не превысило лимит");
  const bucket = Math.floor(now() / (15 * 60));
  strictEqual(counters.get(`jf:42:${bucket}`), 12, "все 12 попыток получили свой слот");
});

test("лимит считается по аккаунту: у другого пользователя свой счётчик", async () => {
  const { db, counters } = makeJoinMockDb({ pairs: { [VALID_CODE]: OPEN_PAIR } });
  for (let i = 0; i < 5; i++) {
    await rejects(() => joinPair({ DB: db, openApp: dummyOpenApp }, USER, "00000000"), (error) => error.status === 404);
  }
  // Другой аккаунт — отдельный ключ, вход разрешён.
  const other = { tg_id: 43, display_name: "Другой" };
  const joined = await joinPair({ DB: db, openApp: dummyOpenApp }, other, VALID_CODE);
  strictEqual(Boolean(joined), true);
  strictEqual(counters.get(`jf:43:${Math.floor(now() / (15 * 60))}`), undefined);
});

test("вход в новую пару обнуляет статистику XP/серии", async () => {
  const { db, batches } = makeJoinMockDb({ pairs: { [VALID_CODE]: OPEN_PAIR } });
  await joinPair({ DB: db, openApp: dummyOpenApp }, USER, VALID_CODE);
  ok(batches.flat().some((sql) => sql.includes("points=0")), "XP обнулен");
  ok(batches.flat().some((sql) => sql.includes("streak=0")), "серия обнулена");
  ok(batches.flat().some((sql) => sql.includes("best_streak=0")), "рекорд обнулен");
  ok(batches.flat().some((sql) => sql.includes("last_activity=NULL")), "дата активности сброшена");
});

test("возвращение прежнего партнёра восстанавливает статистику из member_stats", async () => {
  const { db, batches, statRead } = makeJoinMockDbWithStatIntercept({
    pairs: { [VALID_CODE]: { ...OPEN_PAIR, awaiting_return: 1, last_partner: 42 } },
    memberStats: { points: 150, streak: 5, best_streak: 12, last_activity: "2026-11-10" }
  });
  const { joinPair: joinWithNotify } = loadWithNotifier(dummyOpenApp);
  await joinWithNotify({ DB: db, openApp: dummyOpenApp }, USER, VALID_CODE);
  ok(statRead(), "снимок member_stats был прочитан");
  ok(batches.flat().some((sql) => sql.includes("UPDATE users SET points=?,streak=?,best_streak=?,last_activity=?")), "восстановление значений из снимка");
  ok(!batches.flat().some((sql) => sql.includes("points=0")), "при возвращении статистика НЕ обнуляется");
});

test("если снимка member_stats нет (пара ждала до появления таблицы), статистика не меняется", async () => {
  const { db, batches, statRead } = makeJoinMockDbWithStatIntercept({
    pairs: { [VALID_CODE]: { ...OPEN_PAIR, awaiting_return: 1, last_partner: 42 } },
    memberStats: null
  });
  const { joinPair: joinWithNotify } = loadWithNotifier(dummyOpenApp);
  await joinWithNotify({ DB: db, openApp: dummyOpenApp }, USER, VALID_CODE);
  ok(statRead(), "попытка чтения снимка была");
  ok(!batches.flat().some((sql) => sql.includes("points=0")), "снимка отсутствует — оставляем текущие значения");
  ok(!batches.flat().some((sql) => sql.includes("UPDATE users SET points=")), "нет UPDATE users для статистики");
});
