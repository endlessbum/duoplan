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
import { deepStrictEqual, equal } from "node:assert/strict";
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
const load = new Function(
  "openApp",
  "escapeHtml",
  `${nowDecl}\n${extractFunction("leavePair")}\nreturn leavePair;`
);

// Мок D1: prepare().bind() только записывает SQL; batch собирает выполненное.
function makeMockDb(order = []) {
  const executed = [];
  const db = {
    prepare(sql) {
      return {
        bind(..._params) {
          return { sql };
        }
      };
    },
    async batch(operations) {
      executed.push(...operations.map((op) => op.sql));
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

const CHILD_TABLES = ["tasks", "dates", "memories", "wishes", "daily_rolls"];

test("выход последнего держателя удаляет все данные пары", async () => {
  const { db, executed } = makeMockDb();
  const notifier = makeNotifier();
  const leavePair = load(notifier.openApp, escapeHtml);
  await leavePair({ DB: db }, { id: 7, tg_id: 1, role: "a", user_a: 1, user_b: 0 });

  for (const table of CHILD_TABLES) {
    deepStrictEqual(
      executed.some((sql) => sql.startsWith(`DELETE FROM ${table} WHERE pair_id=?`)),
      true,
      `ожидается удаление ${table}`
    );
  }
  deepStrictEqual(executed.some((sql) => sql.startsWith("DELETE FROM pair_members WHERE pair_id=?")), true);
  deepStrictEqual(executed.some((sql) => sql.startsWith("DELETE FROM pairs WHERE id=?")), true);
  deepStrictEqual(executed.some((sql) => sql.startsWith("UPDATE users SET pair_id=NULL")), true);
  // Партнёра повышение не затрагивает.
  deepStrictEqual(executed.some((sql) => sql.includes("user_a=user_b")), false);
  // Оставшегося нет — уведомлять некого.
  equal(notifier.calls.length, 0);
});

test("выход одного из пары сохраняет данные пары", async () => {
  const { db, executed } = makeMockDb();
  const notifier = makeNotifier();
  const leavePair = load(notifier.openApp, escapeHtml);
  await leavePair({ DB: db }, { id: 7, tg_id: 1, role: "a", user_a: 1, user_b: 2 });

  for (const table of CHILD_TABLES) {
    deepStrictEqual(
      executed.some((sql) => sql.startsWith(`DELETE FROM ${table}`)),
      false,
      `${table} не должен удаляться`
    );
  }
  deepStrictEqual(executed.some((sql) => sql.startsWith("DELETE FROM pairs")), false);
  // Пространство переходит партнёру.
  deepStrictEqual(executed.some((sql) => sql.includes("user_a=user_b")), true);
});

test("выход партнёра (role b) сохраняет данные пары", async () => {
  const { db, executed } = makeMockDb();
  const notifier = makeNotifier();
  const leavePair = load(notifier.openApp, escapeHtml);
  await leavePair({ DB: db }, { id: 7, tg_id: 2, role: "b", user_a: 1, user_b: 2 });

  for (const table of CHILD_TABLES) {
    deepStrictEqual(executed.some((sql) => sql.startsWith(`DELETE FROM ${table}`)), false);
  }
  deepStrictEqual(executed.some((sql) => sql.startsWith("DELETE FROM pairs")), false);
  deepStrictEqual(executed.some((sql) => sql.startsWith("UPDATE pairs SET user_b=0")), true);
  deepStrictEqual(executed.some((sql) => sql.startsWith("DELETE FROM pair_members WHERE tg_id=? AND pair_id=?")), true);
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
  deepStrictEqual(executed.some((sql) => sql.includes("user_a=user_b")), true);
  deepStrictEqual(executed.some((sql) => sql.startsWith("DELETE FROM pairs")), false);
});
