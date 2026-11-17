// Тест лимита неудачных попыток входа по коду (claimJoinAttempt /
// releaseJoinAttempt / joinPair в worker.js).
//
// Репорт 2026-10-29: код приглашения — 4 байта (2^32 вариантов), общий лимит
// 240/мин на аккаунт позволял сотни тысяч попыток перебора в сутки, а путь
// /start CODE в вебхуке не имел лимита вовсе. Теперь joinPair считает
// неудачные попытки по валидно сформированному коду: CODE_NOT_FOUND,
// PAIR_CLOSED, OWN_CODE, PAIR_FULL, PAIR_RESERVED — 5 в любом скользящем
// 15-минутном интервале на аккаунт. Не расходуют слот: битый формат
// (INVALID_CODE), ALREADY_PAIRED, успешный вход и гонка захвата.
//
// Аудит 2026-11-11 (P2): SELECT + отдельный инкремент обходились параллельными
// запросами. Слот резервируется одним INSERT ... SELECT ... WHERE ...
// RETURNING до чтения кода, успешный вход удаляет событие.
// Аудит 2026-11-16/17 (INV-SEC-03, RATE-01/02): точный sliding log —
// не более 5 событий в любом скользящем 900-секундном интервале.
// Аудит 2026-11-17 re-audit (RATE-MIG-01/RATE-PERF-01): SUM(count) для
// legacy bucket-строк и индексируемый диапазон вместо LIKE.
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
  extractBraced("function hex"),
  extractLine("const positiveId = "),
  extractBraced("async function claimJoinAttempt"),
  extractBraced("async function releaseJoinAttempt"),
  extractBraced("async function membership"),
  extractBraced("async function joinPair")
].join("\n");

const load = new Function(`${preamble}\nreturn { joinPair, claimJoinAttempt, releaseJoinAttempt, HttpError, now, JOIN_ATTEMPT_WINDOW, JOIN_ATTEMPT_LIMIT };`);
const { joinPair, claimJoinAttempt, releaseJoinAttempt, HttpError, now, JOIN_ATTEMPT_WINDOW, JOIN_ATTEMPT_LIMIT } = load();

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

// Мок D1 с маршрутизацией по SQL: rate_limits — sliding log событий
// (Map ключ → expires_at), membership и pairs — настраиваемые таблицы.
// Успешный batch (вход) заполняет membership, как реальная БД после
// INSERT в pair_members.
//
// Атомарный INSERT ... SELECT ... WHERE ... RETURNING лимитера воспроизводим
// честно: SUM(count) по событиям диапазона jf:<id>: [lo,hi) с expires_at >
// timestamp, вставка только при sum < limit — как в SQLite/D1. Ключ →
// { e: expires_at, c: count }: legacy bucket-строки (RATE-MIG-01) могут
// нести count>1.
function rateLimitInsert(events, params) {
  const [key, expiresAt, lo, hi, timestamp, limit] = params;
  let count = 0;
  for (const [eventKey, event] of events) {
    if (eventKey >= lo && eventKey < hi && event.e > timestamp) count += event.c;
  }
  if (count >= limit) return null;
  events.set(key, { e: expiresAt, c: 1 });
  return { bucket_key: key };
}

function makeJoinMockDb({ membershipRow = null, pairs = {}, closedCodes = [], memberStats = null } = {}) {
  const events = new Map();
  const batches = [];
  let pairReads = 0;
  let member = membershipRow;
  const db = {
    prepare(sql) {
      return {
        bind(...params) {
          return {
            async first() {
              if (sql.startsWith("INSERT INTO rate_limits") && sql.includes("RETURNING bucket_key")) {
                return rateLimitInsert(events, params);
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
              if (sql.startsWith("DELETE FROM rate_limits")) {
                events.delete(params[0]);
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
  return { db, events, batches, pairReads: () => pairReads };
}

// Dummy openApp для тестов, где уведомления не нужны (но joinPair вызывает его).
const dummyOpenApp = async () => {};

// Вариант с перехватом member_stats-запроса: нужно перехватывать .first() до batch.
function makeJoinMockDbWithStatIntercept({ membershipRow = null, pairs = {}, closedCodes = [], memberStats = null } = {}) {
  const events = new Map();
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
              if (sql.startsWith("INSERT INTO rate_limits") && sql.includes("RETURNING bucket_key")) {
                return rateLimitInsert(events, params);
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
              if (sql.startsWith("DELETE FROM rate_limits")) {
                events.delete(params[0]);
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
  return { db, events, batches, statRead: () => statRead, pairReads: () => pairReads };
}

const USER = { tg_id: 42, display_name: "Атакующий" };
const VALID_CODE = "ABCDEF12";
const OPEN_PAIR = { id: 7, code: VALID_CODE, user_a: 1, user_b: 0 };

// Число событий sliding log пользователя (ключи вида jf:<id>:<ts>:<hex>).
const eventCount = (events, tgId) =>
  [...events.keys()].filter((key) => key.startsWith(`jf:${tgId}:`)).length;

test("пять неудачных попыток — шестая отклонена даже с верным кодом", async () => {
  const { db, events } = makeJoinMockDb({ pairs: { [VALID_CODE]: OPEN_PAIR } });
  for (let i = 0; i < 5; i++) {
    await rejects(
      () => joinPair({ DB: db, openApp: dummyOpenApp }, USER, "00000000"),
      (error) => error instanceof HttpError && error.status === 404 && error.code === "CODE_NOT_FOUND"
    );
  }
  strictEqual(eventCount(events, 42), 5, "неудачи копятся как события sliding log");
  // Переборщик нашёл верный код — но лимит уже исчерпан.
  await rejects(
    () => joinPair({ DB: db, openApp: dummyOpenApp }, USER, VALID_CODE),
    (error) => error instanceof HttpError && error.status === 429 && error.code === "JOIN_RATE_LIMITED"
  );
});

test("успешный вход не расходует лимит", async () => {
  const { db, events } = makeJoinMockDb({ pairs: { [VALID_CODE]: OPEN_PAIR } });
  const joined = await joinPair({ DB: db, openApp: dummyOpenApp }, USER, VALID_CODE);
  strictEqual(joined.id, 7, "после входа возвращается membership новой пары");
  strictEqual(events.size, 0, "успех не оставляет события в счётчике неудач");
});

test("некорректный формат кода не расходует лимит", async () => {
  const { db, events } = makeJoinMockDb({});
  for (const bad of ["XYZ!", "123", "ABCDEF123", ""]) {
    await rejects(() => joinPair({ DB: db, openApp: dummyOpenApp }, USER, bad),
      (error) => error.status === 400 && error.code === "INVALID_CODE");
  }
  strictEqual(events.size, 0, "форматные ошибки не пишутся в счётчик");
  // Контроль: хорошо сформированный неверный код счётчик пополняет.
  await rejects(() => joinPair({ DB: db, openApp: dummyOpenApp }, USER, "00000000"), (error) => error.status === 404);
  strictEqual(events.size, 1);
});

test("участник пары не тратит лимит: ALREADY_PAIRED до проверки счётчика", async () => {
  const { db, events } = makeJoinMockDb({ membershipRow: { id: 1, code: "AAAA0000" } });
  await rejects(() => joinPair({ DB: db, openApp: dummyOpenApp }, USER, VALID_CODE),
    (error) => error.status === 409 && error.code === "ALREADY_PAIRED");
  strictEqual(events.size, 0);
});

test("код закрытого пространства — 410 PAIR_CLOSED, лимит перебора пишется", async () => {
  // Последний участник вышел: пары нет, но код остался в closed_codes.
  // Отличать «закрыто» от «не найдено» безопасно: неудача в обоих случаях
  // пополняет лимит, перебор не узнаёт, какие коды существовали.
  const { db, events } = makeJoinMockDb({ closedCodes: [VALID_CODE] });
  await rejects(() => joinPair({ DB: db, openApp: dummyOpenApp }, USER, VALID_CODE),
    (error) => error.status === 410 && error.code === "PAIR_CLOSED" && /закрыто/i.test(error.message));
  strictEqual(events.size, 1, "неудача с закрытым кодом тратит лимит");
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

test("claimJoinAttempt: пять событий, шестое отклонено, release освобождает слот", async () => {
  const { db, events } = makeJoinMockDb({});
  const seen = new Set();
  for (let i = 1; i <= 5; i++) {
    const key = await claimJoinAttempt({ DB: db }, 42);
    ok(key.startsWith("jf:42:"), "ключ события jf:<id>:<ts>:<hex>");
    ok(!seen.has(key), "каждая попытка — уникальное событие");
    seen.add(key);
  }
  strictEqual(events.size, 5);
  await rejects(() => claimJoinAttempt({ DB: db }, 42),
    (error) => error.status === 429 && error.code === "JOIN_RATE_LIMITED");
  strictEqual(events.size, 5, "отклонённая лимитером попытка строки не оставляет");
  await releaseJoinAttempt({ DB: db }, [...seen][0]);
  strictEqual(events.size, 4, "освобождение удаляет событие sliding log");
  const again = await claimJoinAttempt({ DB: db }, 42);
  strictEqual(events.size, 5, "освобождённый слот снова доступен");
  strictEqual(typeof again, "string");
});

test("параллельные неудачные входы не обходят лимит", async () => {
  const { db, events, pairReads } = makeJoinMockDb({});
  const results = await Promise.allSettled(
    Array.from({ length: 12 }, () => joinPair({ DB: db, openApp: dummyOpenApp }, USER, "00000000"))
  );
  const codes = results.map((result) => result.reason?.code);
  strictEqual(codes.filter((code) => code === "CODE_NOT_FOUND").length, 5,
    "до чтения кода дошли ровно JOIN_ATTEMPT_LIMIT запросов");
  strictEqual(codes.filter((code) => code === "JOIN_RATE_LIMITED").length, 7,
    "остальные отклонены до обращения к таблице пар");
  strictEqual(pairReads(), 5, "чтение pairs не превысило лимит");
  strictEqual(eventCount(events, 42), 5,
    "записаны только принятые события; отклонённые строк не оставляют");
});

test("лимит считается по аккаунту: у другого пользователя свой счётчик", async () => {
  const { db, events } = makeJoinMockDb({ pairs: { [VALID_CODE]: OPEN_PAIR } });
  for (let i = 0; i < 5; i++) {
    await rejects(() => joinPair({ DB: db, openApp: dummyOpenApp }, USER, "00000000"), (error) => error.status === 404);
  }
  // Другой аккаунт — отдельный набор событий, вход разрешён.
  const other = { tg_id: 43, display_name: "Другой" };
  const joined = await joinPair({ DB: db, openApp: dummyOpenApp }, other, VALID_CODE);
  strictEqual(Boolean(joined), true);
  strictEqual(eventCount(events, 43), 0);
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

// Аудит 2026-11-16/17 (INV-SEC-03, RATE-01/02): фиксированные bucket-окна
// допускали двойной burst на стыке, weighted-приближение пропускало до 7
// проверок в фактических 15 минутах. Теперь — точный sliding log: не более
// 5 событий в ЛЮБОМ скользящем 900-секундном интервале.
test("строгий sliding log: burst на стыке и внутри окна не проходит", async () => {
  const { db, events } = makeJoinMockDb({});
  const W = JOIN_ATTEMPT_WINDOW;
  // Метки времени задаём напрямую — реальное время не важно.
  const t0 = 1800000000 - (1800000000 % W);
  const env = { DB: db };
  // Пять неудач в последние секунды окна — классический burst на стыке.
  for (let i = 0; i < 5; i++) {
    await claimJoinAttempt(env, 42, t0 + W - 5 + i);
  }
  // +1с после границы все пять событий ещё внутри 900 с — лимит закрыт.
  await rejects(
    () => claimJoinAttempt(env, 42, t0 + W + 1),
    (error) => error.status === 429 && error.code === "JOIN_RATE_LIMITED"
  );
  // Даже спустя пол-окна — события всё ещё свежие, попытка отклонена.
  await rejects(
    () => claimJoinAttempt(env, 42, t0 + W + W / 2),
    (error) => error.status === 429
  );
  strictEqual(eventCount(events, 42), 5, "отклонённые попытки строк не оставляют");
  // Старейшее событие (t0+W-5) истекает в t0+W+895: ровно WINDOW секунд
  // спустя expires_at > ts уже не выполняется — попытка разрешена.
  await rejects(() => claimJoinAttempt(env, 42, t0 + W + 894), (error) => error.status === 429);
  const key = await claimJoinAttempt(env, 42, t0 + W + 895);
  ok(key.startsWith("jf:42:"), "после истечения старейшего события попытка разрешена");
});

test("claimJoinAttempt: timestamp по умолчанию — текущее время", async () => {
  const { db, events } = makeJoinMockDb({});
  await claimJoinAttempt({ DB: db }, 42);
  strictEqual(eventCount(events, 42), 1);
});

// Аудит 2026-11-17 re-audit (RATE-MIG-01): до sliding log попытки хранились
// агрегированно — одна строка jf:<id>:<bucket> с count=N. COUNT(*) читал
// такую строку как одну попытку и ослаблял лимит после обновления; теперь
// SUM(count) сохраняет фактический вес legacy-записей.
test("RATE-MIG-01: legacy bucket-строка с count=5 блокирует новую попытку", async () => {
  const { db, events } = makeJoinMockDb({});
  const ts = now();
  const env = { DB: db };
  // Старая агрегация: одна строка bucket, count=5, ещё не истекла.
  events.set(`jf:42:${Math.floor(ts / JOIN_ATTEMPT_WINDOW)}`, { e: ts + JOIN_ATTEMPT_WINDOW, c: 5 });
  await rejects(
    () => claimJoinAttempt(env, 42, ts),
    (error) => error.status === 429 && error.code === "JOIN_RATE_LIMITED"
  );
  strictEqual(events.size, 1, "отклонённая попытка строки не добавила");
});

test("RATE-MIG-01: legacy count>5 и смесь legacy+новых событий", async () => {
  const { db, events } = makeJoinMockDb({});
  const ts = now();
  const env = { DB: db };
  // Старый код мог превысить лимит (отвергнутая попытка тоже инкрементила).
  events.set("jf:42:1", { e: ts + JOIN_ATTEMPT_WINDOW, c: 7 });
  await rejects(() => claimJoinAttempt(env, 42, ts), (error) => error.status === 429);
  // Смесь: legacy count=3 + два новых события = 5 — следующая отклонена.
  events.clear();
  events.set("jf:42:1", { e: ts + JOIN_ATTEMPT_WINDOW, c: 3 });
  await claimJoinAttempt(env, 42, ts);
  await claimJoinAttempt(env, 42, ts);
  await rejects(() => claimJoinAttempt(env, 42, ts), (error) => error.status === 429);
  // Протухшая legacy-строка (expires_at <= ts) не влияет на решение.
  events.clear();
  events.set("jf:42:1", { e: ts, c: 9 });
  const key = await claimJoinAttempt(env, 42, ts);
  ok(key.startsWith("jf:42:"), "истёкшая legacy-строка не блокирует");
});
