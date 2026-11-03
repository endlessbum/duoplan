// Отображение серии: users.streak не обнуляется сам после пропущенных дней,
// поэтому publicUser обязан вернуть 0, если last_activity не сегодня и не вчера.
//
// Репорт 2026-10-29: после пропуска в интерфейсе оставалось «🔥 Серия 7 дн.»,
// пока кто-то не отметит ритуал. Логика начисления не меняется — только вывод.
//
// Запуск: node tests/test_streak_display.test.mjs  (или node --test "tests/*.test.mjs")
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { deepStrictEqual, equal } from "node:assert/strict";
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

const buildPublicUser = new Function(
  "localDay",
  [
    extractBraced("function displayStreak"),
    extractBraced("function publicUser"),
    "return { displayStreak, publicUser };"
  ].join("\n")
);

// Сегодня фиксируем, чтобы тест не зависел от даты запуска: localDay возвращает
// дату в зависимости от пояса — в Auckland уже 30-е, в Москве ещё 29-е.
const { displayStreak, publicUser } = buildPublicUser((tz) => (tz === "Pacific/Auckland" ? "2026-10-30" : "2026-10-29"));

function user(overrides = {}) {
  return {
    tg_id: 1,
    display_name: "Тест",
    points: 40,
    streak: 7,
    best_streak: 9,
    last_activity: "2026-10-29",
    timezone: "Europe/Moscow",
    gender: null,
    ...overrides
  };
}

test("серия сохраняется, если ритуал отмечен сегодня", () => {
  equal(displayStreak(user()), 7);
});

test("серия сохраняется, если ритуал отмечен вчера (ещё можно продолжить)", () => {
  equal(displayStreak(user({ last_activity: "2026-10-28" })), 7);
});

test("серия обнуляется после пропущенного дня", () => {
  equal(displayStreak(user({ last_activity: "2026-10-27" })), 0);
});

test("серия считается в поясе пары, которым писался last_activity (репорт 2026-11-03, B-8)", () => {
  // Ритуал отметили, когда в поясе пары (Auckland) уже наступило 30-е:
  // last_activity записан как 2026-10-30, и по поясу пары серия жива.
  equal(displayStreak(user({ last_activity: "2026-10-30" }), "Pacific/Auckland"), 7);
  // По личному поясу пользователя (Москва, ещё 29-е) отметка выглядела бы
  // «завтрашней» — до фикса серия ошибочно показывалась как 0.
  equal(displayStreak(user({ last_activity: "2026-10-30" })), 0);
});

test("серия обнуляется, если активности не было вовсе", () => {
  equal(displayStreak(user({ last_activity: null })), 0);
});

test("нулевая серия остаётся нулём", () => {
  equal(displayStreak(user({ streak: 0, last_activity: null })), 0);
});

test("publicUser отдаёт вычисленную серию, не меняя best_streak", () => {
  const fresh = publicUser(user());
  deepStrictEqual([fresh.streak, fresh.best_streak], [7, 9]);

  const stale = publicUser(user({ last_activity: "2026-10-20" }));
  deepStrictEqual([stale.streak, stale.best_streak], [0, 9]);
});
