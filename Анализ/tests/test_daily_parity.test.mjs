// Паритет ритуала дня между Worker и Python-ботом.
//
// Репорт 2026-10-29: в Worker действие выбиралось своим хешем, в Python —
// random.Random(seed), поэтому одна и та же пара в один день получала разные
// задания в боте и в Mini App. Плюс тексты действий разошлись («сегодня»
// в первом пункте только в Python).
//
// Канонический список и векторы — tests/fixtures/daily_actions.json.
// Python-сторона проверяется в tests/test_daily_parity.py на тех же данных.
//
// Запуск: node tests/test_daily_parity.test.mjs  (или node --test "tests/*.test.mjs")
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { deepStrictEqual, equal, ok } from "node:assert/strict";
import { test } from "node:test";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const source = readFileSync(join(root, "worker.js"), "utf8");
const contract = JSON.parse(readFileSync(join(here, "fixtures", "daily_actions.json"), "utf8"));

const actions = new Function(`return ${source.match(/const DAILY_ACTIONS = (\[[\s\S]*?\]);/)[1]}`)();

function extractFunction(name) {
  const start = source.indexOf(`function ${name}(`);
  if (start === -1) throw new Error(`function ${name} не найдена`);
  let depth = 0;
  for (let i = source.indexOf("{", start); i < source.length; i++) {
    if (source[i] === "{") depth++;
    else if (source[i] === "}") {
      depth--;
      if (depth === 0) return source.slice(start, i + 1);
    }
  }
  throw new Error(`незакрытая функция ${name}`);
}

const dailyAction = new Function("DAILY_ACTIONS", `${extractFunction("dailyAction")}\nreturn dailyAction;`)(actions);

test("список действий в Worker совпадает с контрактом", () => {
  deepStrictEqual(actions, contract.actions);
});

test("dailyAction воспроизводит общие векторы", () => {
  for (const { pair_id, day, index } of contract.vectors) {
    equal(dailyAction(pair_id, day), contract.actions[index], `pair=${pair_id} day=${day}`);
  }
});

test("dailyFor не считает хеш самостоятельно", () => {
  const body = source.slice(source.indexOf("async function dailyFor"), source.indexOf("function displayStreak"));
  ok(body.includes("dailyAction(pairId, day)"), "dailyFor должен вызывать dailyAction()");
  ok(!/charCodeAt/.test(body), "в dailyFor остался собственный хеш");
});
