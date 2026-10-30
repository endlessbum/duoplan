// Тест сортировки дат для /api/state (sortDateRows в worker.js).
//
// Раньше nextDateOccurrence (несколько Intl.DateTimeFormat на вызов)
// дёргался из компаратора дважды на каждое сравнение. Теперь timestamp
// считается один раз на запись. Тесты фиксируют порядок групп и
// эквивалентность прежнему inline-компаратору, включая DST-зоны,
// 29 февраля и невалидные дни.
//
// Запуск: node tests/test_dates_sort.test.mjs  (или node --test "tests/*.test.mjs")
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { deepStrictEqual } from "node:assert/strict";
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

const load = new Function(
  [
    'const DEFAULT_TZ = "Europe/Moscow";',
    extractBraced("function validTimeZone"),
    extractBraced("function localDay"),
    extractBraced("function byRowId"),
    extractBraced("function timeZoneOffsetMs"),
    extractBraced("function makeDateInTimeZone"),
    extractBraced("function monthlyOccursOnDay"),
    extractBraced("function nextMonthlyOccurrenceMs"),
    extractBraced("function nextDateOccurrence"),
    extractBraced("function isPastDate"),
    extractBraced("function sortDateRows")
  ].join("\n") + "\nreturn { nextDateOccurrence, sortDateRows };"
);
const { nextDateOccurrence, sortDateRows } = load();

const TZ = "Europe/Amsterdam";
// До полудня по Амстердаму: эталонный компаратор ниже не знает про дефект
// «сегодня после 12:00», поэтому эквивалентность проверяем на времени, где
// старое и новое поведение совпадают. Сам дефект — в отдельном тесте.
const NOW_MS = new Date("2026-06-15T08:00:00Z").getTime();

// Прежний inline-компаратор из state() до оптимизации (поведение-эталон).
function legacySort(rows, timeZone, nowMs) {
  return [...rows].sort((a, b) => {
    const ta = nextDateOccurrence(a, timeZone);
    const tb = nextDateOccurrence(b, timeZone);
    const aPast = !a.recurs && ta < nowMs;
    const bPast = !b.recurs && tb < nowMs;
    if (aPast !== bPast) return aPast ? 1 : -1;
    if (aPast && bPast) return tb - ta;
    return ta - tb;
  });
}

test("будущие даты по возрастанию, прошедшие после них от свежих к старым", () => {
  const rows = [
    { id: "past-old", day: "2019-11-11" },
    { id: "past-new", day: "2020-01-01" },
    { id: "future-late", day: "2026-12-31" },
    { id: "future-soon", day: "2026-06-20" },
    { id: "recurring-may", day: "2020-05-05", recurs: true }
  ];
  const sorted = sortDateRows(rows, TZ, NOW_MS);
  // recurring 05-05: в 2026 уже прошло → следующее 2027-05-05, в будущей группе.
  deepStrictEqual(sorted.map((r) => r.id), ["future-soon", "future-late", "recurring-may", "past-new", "past-old"]);
});

test("неповторяющаяся дата «сегодня» остаётся в будущих и после полудня", () => {
  // 17:00 по Амстердаму: время по умолчанию (12:00) уже прошло.
  const now = new Date("2026-06-15T15:00:00Z").getTime();
  const rows = [
    { id: "yesterday", day: "2026-06-14" },
    { id: "today-timed", day: "2026-06-15", time: "09:00" },
    { id: "today", day: "2026-06-15" },
    { id: "tomorrow", day: "2026-06-16" }
  ];
  const sorted = sortDateRows(rows, TZ, now);
  // Прошедшая — только вчера; сегодняшние остаются впереди, по времени.
  deepStrictEqual(sorted.map((r) => r.id), ["today-timed", "today", "tomorrow", "yesterday"]);
});

test("29 февраля ежегодной даты резолвится в ближайший високосный год", () => {
  const occurrence = nextDateOccurrence({ day: "2024-02-29", recurs: true }, TZ);
  // Полдень по Амстердаму 29.02.2028 — сверяем зональное представление.
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit" })
    .format(new Date(occurrence));
  deepStrictEqual(parts, "2028-02-29");
});

test("результат эквивалентен прежнему компаратору на сложной смеси", () => {
  const rows = [
    { id: 1, day: "2024-02-29", recurs: true },
    { id: 2, day: "2026-02-30" },
    { id: 3, day: "" },
    { id: 4, day: "2026-06-14", time: "23:30" },
    { id: 5, day: "2026-06-15", time: "23:30" },
    { id: 6, day: "2026-06-15" },
    { id: 7, day: "2026-07-01", recurs: true },
    { id: 8, day: "2021-03-01", recurs: true },
    { id: 9, day: "2020-08-16" },
    { id: 10, day: "2026-06-20" },
    { id: 11, day: "2026-06-20" },
    { id: 12, day: "garbage" },
    { id: 13, day: "2030-01-01", recurs: false }
  ];
  const optimized = sortDateRows(rows, TZ, NOW_MS).map((r) => r.id);
  const legacy = legacySort(rows, TZ, NOW_MS).map((r) => r.id);
  deepStrictEqual(optimized, legacy);
});

test("сортировка стабильна при равных ключах", () => {
  const rows = [
    { id: "a", day: "2026-08-01" },
    { id: "b", day: "2026-08-01" },
    { id: "c", day: "2026-08-01" }
  ];
  const sorted = sortDateRows(rows, TZ, NOW_MS);
  deepStrictEqual(sorted.map((r) => r.id), ["a", "b", "c"]);
});
