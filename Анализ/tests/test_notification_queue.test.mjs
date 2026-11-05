// Нагрузочный тест очереди уведомлений cron (queuePage в worker.js).
//
// Внешний аудит (2026-10-31, п. 4.1) пометил прежнюю ротацию «по минутам
// суток» как риск голодания при росте числа пар: 96 тиков × 10 пар = 960
// обработок в сутки. Ротация заменена на устойчивый курсор: каждый тик берёт
// следующие после курсора DIGEST_MAX_PAIRS пар по возрастанию id, хвост
// исчерпан — с начала. Тест имитирует сутки тиков и проверяет:
//   — каждая пара при N ≤ 960 посещена хотя бы раз за сутки;
//   — за любое окно тиков разница посещений пар не больше 1 (без голодания);
//   — в странице нет дублей, id идут по возрастанию, курсор монотонен.
//
// Запуск: node --test tests/test_notification_queue.test.mjs
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { deepStrictEqual, ok } from "node:assert/strict";
import { test } from "node:test";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const source = readFileSync(join(root, "worker.js"), "utf8");

function extractBraced(declaration) {
  const start = source.indexOf(declaration);
  if (start === -1) throw new Error(`${declaration} не найдено`);
  let depth = 0;
  for (let j = source.indexOf("{", start); j < source.length; j++) {
    if (source[j] === "{") depth++;
    else if (source[j] === "}") {
      depth--;
      if (depth === 0) return source.slice(start, j + 1);
    }
  }
  throw new Error(`незакрытый блок: ${declaration}`);
}

function extractConst(name) {
  const start = source.indexOf(`const ${name} = `);
  if (start === -1) throw new Error(`${name} не найдено`);
  return source.slice(start, source.indexOf(";", start));
}

const load = new Function(
  [
    extractConst("DIGEST_MAX_PAIRS"),
    extractBraced("function queuePage"),
    "return { DIGEST_MAX_PAIRS, queuePage };"
  ].join("\n")
);
const { DIGEST_MAX_PAIRS, queuePage } = load();

const TICKS_PER_DAY = 96; // cron */15

// Имитация тиков: курсор живёт только в test-памяти — sendDigests пишет его
// в D1 между тиками, здесь семантика та же (курсор = id последней пары).
function simulateDay(pairCount, ticks = TICKS_PER_DAY) {
  const pairs = Array.from({ length: pairCount }, (_, i) => ({ id: i + 1 }));
  let cursor = 0;
  const visits = new Map(pairs.map((p) => [p.id, 0]));
  const pages = [];
  for (let t = 0; t < ticks; t++) {
    const sorted = pairs; // nextNotificationQueue сортирует по id — здесь уже отсортированы
    const page = queuePage(sorted, cursor);
    ok(page.length <= DIGEST_MAX_PAIRS, `страница тика ${t} длиннее лимита`);
    ok(new Set(page.map((p) => p.id)).size === page.length, `дубль пары в тике ${t}`);
    for (let i = 1; i < page.length; i++) {
      ok(page[i - 1].id < page[i].id, `id в странице тика ${t} не по возрастанию`);
    }
    for (const p of page) visits.set(p.id, visits.get(p.id) + 1);
    if (page.length) cursor = page[page.length - 1].id;
    pages.push(page.map((p) => p.id));
  }
  return { visits, pages };
}

test("константы аудита: 10 пар на тик, 96 тиков в сутки", () => {
  deepStrictEqual(DIGEST_MAX_PAIRS, 10);
});

for (const n of [1, 10, 100, 500, 960]) {
  test(`полный обход за сутки: ${n} пар — каждая посещена хотя бы раз`, () => {
    const { visits } = simulateDay(n);
    for (const [id, count] of visits) {
      ok(count >= 1, `пара ${id} из ${n} не обработана за 96 тиков`);
    }
  });
}

for (const n of [1000, 5000]) {
  test(`за сутки при ${n} парах обработано ровно 96×10 уникальных, без повторов`, () => {
    const { visits } = simulateDay(n);
    const total = [...visits.values()].reduce((a, b) => a + b, 0);
    deepStrictEqual(total, Math.min(n, TICKS_PER_DAY * DIGEST_MAX_PAIRS));
    for (const count of visits.values()) {
      ok(count <= 1, `пара обработана дважды за сутки при ${n} парах`);
    }
  });
}

for (const n of [10, 100, 1000, 5000]) {
  // Полный цикл ceil(N/10) тиков: каждая пара ровно один раз — определение
  // честного round-robin; окно цикла растёт с N, но не меняет гарантию.
  test(`полный цикл ${Math.ceil(n / DIGEST_MAX_PAIRS)} тиков при ${n} парах — каждая ровно один раз`, () => {
    const { visits } = simulateDay(n, Math.ceil(n / DIGEST_MAX_PAIRS));
    for (const count of visits.values()) {
      deepStrictEqual(count, 1);
    }
  });
}

for (const n of [7, 13, 97, 500, 960, 1000]) {
  test(`справедливость окна: ${n} пар, разница посещений за 96 тиков ≤ 1`, () => {
    const { visits } = simulateDay(n);
    const counts = [...visits.values()];
    ok(Math.max(...counts) - Math.min(...counts) <= 1,
      `разброс посещений при ${n} парах: ${Math.min(...counts)}…${Math.max(...counts)}`);
  });
}

test("курсор мимо максимального id (удалённые пары) — очередь начинается с начала", () => {
  const pairs = [{ id: 1 }, { id: 2 }, { id: 3 }];
  deepStrictEqual(queuePage(pairs, 999).map((p) => p.id), [1, 2, 3]);
  deepStrictEqual(queuePage(pairs, 0).map((p) => p.id), [1, 2, 3]);
  deepStrictEqual(queuePage(pairs, 1).map((p) => p.id), [2, 3]);
});

test("пустой список пар даёт пустую страницу", () => {
  deepStrictEqual(queuePage([], 0), []);
});
