// Тест выхода из пространства (leavePair в worker.js).
//
// leavePair извлекается из worker.js как есть и исполняется против мока D1,
// который записывает выполняемые SQL-выражения.
//
// Запуск: node tests/test_leave_pair.test.mjs  (или node --test "tests/*.test.mjs")
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { deepStrictEqual } from "node:assert/strict";
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
const load = new Function(`${nowDecl}\n${extractFunction("leavePair")}\nreturn leavePair;`);
const leavePair = load();

// Мок D1: prepare().bind() только записывает SQL; batch собирает выполненное.
function makeMockDb() {
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
      return operations.map(() => ({ meta: { changes: 1 } }));
    }
  };
  return { db, executed };
}

const CHILD_TABLES = ["tasks", "dates", "memories", "wishes", "daily_rolls"];

test("выход последнего держателя удаляет все данные пары", async () => {
  const { db, executed } = makeMockDb();
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
});

test("выход одного из пары сохраняет данные пары", async () => {
  const { db, executed } = makeMockDb();
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
  await leavePair({ DB: db }, { id: 7, tg_id: 2, role: "b", user_a: 1, user_b: 2 });

  for (const table of CHILD_TABLES) {
    deepStrictEqual(executed.some((sql) => sql.startsWith(`DELETE FROM ${table}`)), false);
  }
  deepStrictEqual(executed.some((sql) => sql.startsWith("DELETE FROM pairs")), false);
  deepStrictEqual(executed.some((sql) => sql.startsWith("UPDATE pairs SET user_b=0")), true);
  deepStrictEqual(executed.some((sql) => sql.startsWith("DELETE FROM pair_members WHERE tg_id=? AND pair_id=?")), true);
});
