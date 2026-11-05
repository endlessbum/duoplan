// Стабильный порядок архивных выборок (worker.js).
//
// Страницы архива продолжают первые STATE_* записей из /api/state. Если у двух
// строк совпадает created_at/completed_at, SQLite не обязан отдавать их в одном
// и том же порядке в двух разных запросах — на стыке появлялись бы дубли и
// пропуски. Поэтому у каждой выборки с LIMIT должен быть tie-break по id, и
// state, и архив должны сортировать одинаково.
//
// Запуск: node --test tests/test_archive_order.test.mjs
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { equal, match, ok } from "node:assert/strict";
import { test } from "node:test";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const source = readFileSync(join(root, "worker.js"), "utf8");

const orders = [...source.matchAll(/ORDER BY ([^\n`"]+?)\s+LIMIT/g)].map((found) => found[1].trim());

test("выборки с LIMIT сортируются детерминированно", () => {
  ok(orders.length >= 8, `найдено всего ${orders.length} ORDER BY … LIMIT`);
  for (const order of orders) {
    match(order, /\bid DESC$/, `нет tie-break по id: ORDER BY ${order}`);
  }
});

test("state и архив используют один и тот же порядок", () => {
  // wishes и done_wishes делят один ORDER BY: по два запроса на каждый
  // (state + страница архива) — итого четыре.
  for (const [order, expected] of [
    ["w.created_at DESC, w.id DESC", 4],
    ["m.created_at DESC, m.id DESC", 2],
    ["completed_at DESC, id DESC", 2]
  ]) {
    const count = orders.filter((item) => item === order).length;
    equal(count, expected, `${order}: ожидалось ${expected} выборки, найдено ${count}`);
  }
});
