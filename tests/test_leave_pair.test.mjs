// Тест выхода из пространства (leavePair в worker.js).
//
// leavePair извлекается из worker.js как есть и исполняется против мока D1,
// который записывает выполняемые SQL-выражения. openApp/escapeHtml подменяются:
// сеть в тестах не нужна, а уведомление оставшемуся партнёру проверяется по
// аргументам вызова.
//
// Запуск: node tests/test_leave_pair.test.mjs  (или node --test "tests/*.test.mjs")
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { deepStrictEqual, equal, ok } from "node:assert/strict";
import { test } from "node:test";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const source = readFileSync(join(root, "worker.js"), "utf8");

function extractFunction(name) {
  let start = source.indexOf(`async function ${name}(`);
  const declaration = start === -1 ? `function ${name}(` : `async function ${name}(`;
  if (start === -1) start = source.indexOf(declaration);
  if (start === -1) throw new Error(`function ${name} не найдена`);
  let depth = 0;
  for (let j = source.indexOf("{", start); j < source.length; j++) {
    if (source[j] === "{") depth++;
    else if (source[j] === "}") {
      depth--;
      if (depth === 0) return source.slice(start, j + 1);
    }
  }
  throw new Error(`незакрытая функция ${name}`);
}

const nowDecl = source.match(/const now = \(\) => [^;]+;/)?.[0];
if (!nowDecl) throw new Error("now() не найдена");
const cleanDecl = source.match(/const clean = [^;]+;/)?.[0];
if (!cleanDecl) throw new Error("clean() не найдена");
const load = new Function(
  "openApp",
  "escapeHtml",
  "membership",
  "HttpError",
  `${nowDecl}\n${cleanDecl}\n${extractFunction("leavePair")}\nreturn leavePair;`
);

// Мок D1: prepare().bind() только записывает SQL; batch собирает выполненное.
function makeMockDb(order = []) {
  const executed = [];
  const db = {
    prepare(sql) {
      return {
        bind(...params) {
          return { sql, params };
        }
      };
    },
    async batch(operations) {
      executed.push(...operations);
      order.push("batch");
      return operations.map(() => ({ meta: { changes: 1 } }));
    }
  };
  return { db, executed };
}

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function makeNotifier(order = [], { fail = false } = {}) {
  const calls = [];
  const openApp = async (env, chatId, requestUrl, text) => {
    calls.push({ env, chatId, requestUrl, text });
    order.push("notify");
    if (fail) throw new Error("Telegram недоступен");
  };
  return { calls, openApp };
}

// Полный список child-таблиц: все коллекции пары, а не только до-0016
// (savings_deposits уходит каскадом за savings).
const CHILD_TABLES = ["tasks", "dates", "memories", "wishes", "daily_rolls", "quotes", "places", "movies", "savings", "member_stats"];

test("выход последнего держателя удаляет все данные пары, включая member_stats", async () => {
  const { db, executed } = makeMockDb();
  const notifier = makeNotifier();
  const leavePair = load(notifier.openApp, escapeHtml);
  await leavePair({ DB: db }, { id: 7, tg_id: 1, role: "a", user_a: 1, user_b: 0 });

  for (const table of CHILD_TABLES) {
    deepStrictEqual(
      executed.some((op) => op.sql.startsWith(`DELETE FROM ${table} WHERE pair_id=?`)),
      true,
      `ожидается удаление ${table}`
    );
  }
  deepStrictEqual(executed.some((op) => op.sql.startsWith("DELETE FROM pair_members WHERE pair_id=?")), true);
  deepStrictEqual(executed.some((op) => op.sql.startsWith("DELETE FROM pairs WHERE id=?")), true);
  deepStrictEqual(executed.some((op) => op.sql.startsWith("UPDATE users SET pair_id=NULL")), true);
  deepStrictEqual(executed.some((op) => op.sql.includes("INSERT OR REPLACE INTO member_stats")), false, "снимок не пишется: партнёра нет");
  deepStrictEqual(executed.some((op) => op.sql.startsWith("DELETE FROM member_stats WHERE pair_id=?")), true, "member_stats удаляется вместе с парой");
});

test("выход одного из пары сохраняет данные пары и снимок статистики", async () => {
  const { db, executed } = makeMockDb();
  const notifier = makeNotifier();
  const leavePair = load(notifier.openApp, escapeHtml);
  await leavePair({ DB: db }, { id: 7, tg_id: 1, role: "a", user_a: 1, user_b: 2 });

  for (const table of CHILD_TABLES) {
    deepStrictEqual(
      executed.some((op) => op.sql.startsWith(`DELETE FROM ${table}`)),
      false,
      `${table} не должен удаляться`
    );
  }
  deepStrictEqual(executed.some((op) => op.sql.startsWith("DELETE FROM pairs")), false);
  deepStrictEqual(executed.some((op) => op.sql.includes("user_a=user_b")), true);
  deepStrictEqual(executed.some((op) => op.sql.includes("INSERT OR REPLACE INTO member_stats")), true, "снимок статистики записан");
});

test("выход партнёра (role b) сохраняет данные пары и снимок статистики", async () => {
  const { db, executed } = makeMockDb();
  const notifier = makeNotifier();
  const leavePair = load(notifier.openApp, escapeHtml);
  await leavePair({ DB: db }, { id: 7, tg_id: 2, role: "b", user_a: 1, user_b: 2 });

  for (const table of CHILD_TABLES) {
    deepStrictEqual(executed.some((op) => op.sql.startsWith(`DELETE FROM ${table}`)), false);
  }
  deepStrictEqual(executed.some((op) => op.sql.startsWith("DELETE FROM pairs")), false);
  deepStrictEqual(executed.some((op) => op.sql.startsWith("UPDATE pairs SET user_b=0")), true);
  deepStrictEqual(executed.some((op) => op.sql.startsWith("DELETE FROM pair_members WHERE tg_id=? AND pair_id=?")), true);
  deepStrictEqual(executed.some((op) => op.sql.includes("INSERT OR REPLACE INTO member_stats")), true, "снимок статистики записан");
});

test("владелец уходит — бот уведомляет оставшегося партнёра", async () => {
  const order = [];
  const { db } = makeMockDb(order);
  const notifier = makeNotifier(order);
  const leavePair = load(notifier.openApp, escapeHtml);
  const requestUrl = new URL("https://duoplan.example/api/pair/leave");
  await leavePair({ DB: db }, {
    id: 7,
    tg_id: 1,
    role: "a",
    user_a: 1,
    user_b: 2,
    owner_name: "Игорь",
    partner_name: "Аня"
  }, requestUrl);

  equal(notifier.calls.length, 1);
  const [call] = notifier.calls;
  equal(call.chatId, 2, "уведомление уходит оставшемуся партнёру");
  equal(call.requestUrl, requestUrl);
  equal(call.text.includes("<b>Игорь</b>"), true, "в тексте имя ушедшего");
  equal(call.text.includes("больше не в вашем пространстве"), true);
  // Сначала фиксируем выход в БД, потом отправляем уведомление.
  deepStrictEqual(order, ["batch", "notify"]);
});

test("партнёр уходит — бот уведомляет владельца", async () => {
  const { db } = makeMockDb();
  const notifier = makeNotifier();
  const leavePair = load(notifier.openApp, escapeHtml);
  await leavePair({ DB: db }, {
    id: 7,
    tg_id: 2,
    role: "b",
    user_a: 1,
    user_b: 2,
    owner_name: "Игорь",
    partner_name: "Аня"
  }, new URL("https://duoplan.example/api/pair/leave"));

  equal(notifier.calls.length, 1);
  equal(notifier.calls[0].chatId, 1);
  equal(notifier.calls[0].text.includes("<b>Аня</b>"), true);
});

test("имя ушедшего берётся из users, а при его отсутствии — из pairs", async () => {
  const { db } = makeMockDb();
  const notifier = makeNotifier();
  const leavePair = load(notifier.openApp, escapeHtml);
  await leavePair({ DB: db }, {
    id: 7,
    tg_id: 2,
    role: "b",
    user_a: 1,
    user_b: 2,
    owner_name: null,
    partner_name: null,
    name1: "Игорь",
    name2: "Аня"
  }, new URL("https://duoplan.example/api/pair/leave"));

  equal(notifier.calls[0].text.includes("<b>Аня</b>"), true);
});

test("сбой Telegram не отменяет выход из пространства", async () => {
  const { db, executed } = makeMockDb();
  const notifier = makeNotifier([], { fail: true });
  const leavePair = load(notifier.openApp, escapeHtml);

  await leavePair({ DB: db }, {
    id: 7,
    tg_id: 1,
    role: "a",
    user_a: 1,
    user_b: 2
  }, new URL("https://duoplan.example/api/pair/leave"));

  equal(notifier.calls.length, 1, "попытка уведомления была");
  deepStrictEqual(executed.some((op) => op.sql.includes("user_a=user_b")), true);
  deepStrictEqual(executed.some((op) => op.sql.startsWith("DELETE FROM pairs")), false);
});

test("личное имя партнёра сбрасывается у обоих участников (регрессия M5)", async () => {
  // Иначе кастомное имя, заданное старому партнёру, прилипнет к следующему.
  const { db, executed } = makeMockDb();
  const notifier = makeNotifier();
  const leavePair = load(notifier.openApp, escapeHtml);
  await leavePair({ DB: db }, { id: 7, tg_id: 1, role: "a", user_a: 1, user_b: 2 });

  const leaverUpdate = executed.find((op) => op.sql.startsWith("UPDATE users SET pair_id=NULL"));
  ok(leaverUpdate.sql.includes("partner_custom_name=NULL"), "у ушедшего");
  const remainingUpdate = executed.find((op) => op.sql.includes("role='a'") && op.sql.includes("partner_custom_name=NULL"));
  ok(remainingUpdate, "у оставшегося партнёра (повышен до владельца)");

  const mockB = makeMockDb();
  await leavePair({ DB: mockB.db }, { id: 7, tg_id: 2, role: "b", user_a: 1, user_b: 2 });
  const ownerUpdate = mockB.executed.find((op) => op.sql.startsWith("UPDATE users SET partner_custom_name=NULL"));
  ok(ownerUpdate, "владелец, оставшийся после ухода партнёра (b)");
});

test("код закрывшегося пространства остаётся в closed_codes", async () => {
  // Вход по такому коду позже получит «пространство закрыто», а не «не найден».
  const { db, executed } = makeMockDb();
  const notifier = makeNotifier();
  const leavePair = load(notifier.openApp, escapeHtml);
  await leavePair({ DB: db }, { id: 7, code: "abcdef12", tg_id: 1, role: "a", user_a: 1, user_b: 0 });

  const tombstone = executed.find((op) => op.sql.startsWith("INSERT OR IGNORE INTO closed_codes"));
  ok(tombstone, "надгробие кода записано");
});

test("после выхода партнёра пара помечается awaiting_return=1 (обе роли)", async () => {
  const { db, executed } = makeMockDb();
  const notifier = makeNotifier();
  const leavePair = load(notifier.openApp, escapeHtml);

  await leavePair({ DB: db }, { id: 7, tg_id: 2, role: "b", user_a: 1, user_b: 2 });
  ok(
    executed.some((op) => op.sql.startsWith("UPDATE pairs SET user_b=0") && op.sql.includes("awaiting_return=1")),
    "ушёл партнёр (b): флаг на паре"
  );

  const mockA = makeMockDb();
  await leavePair({ DB: mockA.db }, { id: 7, tg_id: 1, role: "a", user_a: 1, user_b: 2 });
  ok(
    mockA.executed.some((op) => op.sql.includes("user_a=user_b") && op.sql.includes("awaiting_return=1")),
    "ушёл владелец (a): флаг на паре после передачи прав"
  );

  // Последний держатель: пары больше нет — флага некуда ставить.
  const mockLast = makeMockDb();
  await leavePair({ DB: mockLast.db }, { id: 7, tg_id: 1, role: "a", user_a: 1, user_b: 0 });
  ok(
    !mockLast.executed.some((op) => op.sql.includes("awaiting_return=1")),
    "флаг не пишется при полном удалении пары"
  );
});

test("код резервируется за tg_id ушедшего (обе роли)", async () => {
  const { db, executed } = makeMockDb();
  const notifier = makeNotifier();
  const leavePair = load(notifier.openApp, escapeHtml);

  await leavePair({ DB: db }, { id: 7, tg_id: 2, role: "b", user_a: 1, user_b: 2 });
  const updateB = executed.find((op) => op.sql.startsWith("UPDATE pairs SET user_b=0"));
  ok(updateB.sql.includes("last_partner=?"), "ушёл партнёр (b): колонка в UPDATE");
  deepStrictEqual(updateB.params[0], 2, "в резерве tg_id ушедшего");

  const mockA = makeMockDb();
  await leavePair({ DB: mockA.db }, { id: 7, tg_id: 1, role: "a", user_a: 1, user_b: 2 });
  const updateA = mockA.executed.find((op) => op.sql.includes("user_a=user_b"));
  ok(updateA.sql.includes("last_partner=?"), "ушёл владелец (a): колонка в UPDATE");
  deepStrictEqual(updateA.params[1], 1, "в резерве tg_id ушедшего владельца");
});

// ------------------------------------------------------------------
// Гонки выхода (репорт 2026-11-10): снимок member устаревает между
// membership() и batch — гварды превращают batch в no-op (changes=0),
// и leavePair пересобирает попытку со свежим membership().
// ------------------------------------------------------------------
class FakeHttpError {
  constructor(status, message, code) { this.status = status; this.message = message; this.code = code; }
}

test("гонка: партнёр вышел первым — retry пересобирает выход как последний держатель", async () => {
  // Первый batch: гварды не совпали с изменившейся парой → changes=0 на
  // парном операторе; membership возвращает свежий снимок без партнёра;
  // второй batch удаляет пару целиком, hand-over по зомби-снимку не выполняется.
  const batches = [];
  let batchNo = 0;
  const db = {
    prepare(sql) {
      return { bind(...params) { return { sql, params }; } };
    },
    async batch(operations) {
      batches.push(operations);
      const results = operations.map(() => ({ meta: { changes: 1 } }));
      if (batchNo === 0) results[results.length - 1] = { meta: { changes: 0 } };
      batchNo++;
      return results;
    }
  };
  const notifier = makeNotifier();
  const membership = async () => ({ id: 7, code: "abcdef12", tg_id: 1, role: "a", user_a: 1, user_b: 0 });
  const leavePair = load(notifier.openApp, escapeHtml, membership, FakeHttpError);
  // Устаревший снимок: уходит как владелец с партнёром, хотя партнёр уже вышел.
  await leavePair({ DB: db }, { id: 7, tg_id: 1, role: "a", user_a: 1, user_b: 2, owner_name: "Игорь" });

  equal(batches.length, 2, "две попытки: changes=0 → retry");
  deepStrictEqual(
    batches[0].some((op) => op.sql.includes("user_a=user_b")),
    true,
    "первая попытка — hand-over по устаревшему снимку"
  );
  deepStrictEqual(
    batches[1].some((op) => op.sql.startsWith("DELETE FROM pairs WHERE id=?")),
    true,
    "вторая попытка — полное удаление: партнёра уже нет"
  );
  deepStrictEqual(
    batches[1].some((op) => op.sql.includes("user_a=user_b")),
    false,
    "hand-over по зомби-снимку не выполняется — «зомби»-пар не возникает"
  );
  equal(notifier.calls.length, 0, "уведомлять некого: partner уже вышел");
});

test("гонка: пара удалена конкурентно — пользователь отвязывается без уведомления", async () => {
  const executed = [];
  let batchNo = 0;
  const db = {
    prepare(sql) {
      return {
        bind(...params) {
          return {
            sql, params,
            async run() { executed.push({ sql, params }); return { meta: { changes: 1 } }; }
          };
        }
      };
    },
    async batch(operations) {
      const results = operations.map(() => ({ meta: { changes: 1 } }));
      if (batchNo === 0) results[results.length - 1] = { meta: { changes: 0 } };
      batchNo++;
      return results;
    }
  };
  const notifier = makeNotifier();
  const membership = async () => null; // пары больше нет
  const leavePair = load(notifier.openApp, escapeHtml, membership, FakeHttpError);
  await leavePair({ DB: db }, { id: 7, tg_id: 1, role: "a", user_a: 1, user_b: 2 },
    new URL("https://duoplan.example/api/pair/leave"));

  equal(notifier.calls.length, 0);
  deepStrictEqual(
    executed.some((op) => op.sql.startsWith("UPDATE users SET pair_id=NULL") && op.sql.includes("pair_id=?")),
    true,
    "users-строка отвязана от исчезнувшей пары"
  );
});

test("уведомление о выходе уходит через ctx.waitUntil и не блокирует ответ", async () => {
  const order = [];
  const { db, executed } = makeMockDb(order);
  // Telegram «висит»: промис разрешится только после release(). Если бы
  // leavePair ждал уведомление, await leavePair не вернулся бы до release.
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const calls = [];
  const openApp = async (env, chatId, requestUrl, text) => {
    calls.push({ chatId, text });
    await gate;
  };
  const leavePair = load(openApp, escapeHtml);
  const waited = [];
  const ctx = { waitUntil: (promise) => waited.push(promise) };
  await leavePair(
    { DB: db },
    { id: 7, tg_id: 1, role: "a", user_a: 1, user_b: 2, owner_name: "Игорь" },
    new URL("https://duoplan.example/api/pair/leave"),
    ctx
  );
  // Дошли сюда при неразрешённом Telegram-промисе — ответ не блокировался.
  equal(executed.length > 0, true, "batch выполнен");
  equal(waited.length, 1, "промис уведомления передан в waitUntil");
  equal(calls.length, 1);
  equal(calls[0].chatId, 2, "уведомление уходит оставшемуся партнёру");
  equal(calls[0].text.includes("<b>Игорь</b>"), true);
  release();
  await Promise.all(waited);
});
