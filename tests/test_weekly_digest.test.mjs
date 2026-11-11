// Недельная сводка (worker.js): окно предстоящей недели (пн–вс) и текст
// сводки — планы, значимые даты и дни рождения одним сообщением.
//
// Запуск: node --test tests/test_weekly_digest.test.mjs
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { deepStrictEqual, equal, ok } from "node:assert/strict";
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

// Цепочка: weeklyDigestText → maskTitle → richToHtml → richInline → escapeHtml,
// плюс dateOccursOnDay/monthlyOccursOnDay и капы. Всё чистое.
const bundle = [
  'const DEFAULT_TZ = "Europe/Moscow";',
  "const WEEKDAY_SHORT = " + source.match(/const WEEKDAY_SHORT = (\[.*\]);/)?.[1] + ";",
  "const escapeHtml = (value) => String(value ?? '');",
  "const RICH_TOKENS = [];",
  extractBraced("function richInline("),
  extractBraced("function richToHtml("),
  "const RICH_MASKED = '<tg-spoiler>Скрытый</tg-spoiler>';",
  "const maskTitle = (item) => (Number(item.is_private) === 1 ? RICH_MASKED : richToHtml(item.title));",
  "const DIGEST_MAX_ITEMS = 18;",
  "const DIGEST_MAX_CHARS = 3400;",
  extractBraced("function monthlyOccursOnDay("),
  extractBraced("function dateOccursOnDay("),
  extractBraced("function upcomingWeekWindow("),
  extractBraced("function weeklyDigestText(")
].join("\n");

const load = new Function(`${bundle}\nreturn { upcomingWeekWindow, weeklyDigestText };`);
const { upcomingWeekWindow, weeklyDigestText } = load();

// Неделя: пн 09.03.2026 — вс 15.03.2026.
const TASK = (id, day, time = null, extra = {}) => ({
  id, title: `План ${id}`, day, time, is_private: 0, created_by: 1, monthly: 0, yearly: 0, ...extra
});
const DATE = (id, day, extra = {}) => ({
  id, title: `Дата ${id}`, day, recurs: 0, monthly: 0, is_private: 0, kind: "date", created_by: 1, ...extra
});

test("окно недели: воскресенье → пн завтра, понедельник → сегодня", () => {
  // 08.03.2026 — воскресенье.
  deepStrictEqual(upcomingWeekWindow("2026-03-08"), { start: "2026-03-09", end: "2026-03-15" });
  // 09.03.2026 — понедельник: неделя начинается сегодня.
  deepStrictEqual(upcomingWeekWindow("2026-03-09"), { start: "2026-03-09", end: "2026-03-15" });
  // 14.03.2026 — суббота: до понедельника два дня.
  deepStrictEqual(upcomingWeekWindow("2026-03-14"), { start: "2026-03-16", end: "2026-03-22" });
});

test("окно недели: конец — воскресенье, ровно 7 дней", () => {
  const { start, end } = upcomingWeekWindow("2026-11-11"); // среда
  equal(start, "2026-11-16");
  equal(end, "2026-11-22");
  equal(new Date(`${end}T00:00:00Z`).getUTCDay(), 0, "конец недели — воскресенье");
  equal(new Date(`${start}T00:00:00Z`).getUTCDay(), 1, "начало недели — понедельник");
});

test("weeklyDigestText: планы и даты недели с днями, пустая неделя — пусто", () => {
  const dates = [DATE(1, "2020-03-10", { recurs: 1 }), DATE(2, "2020-03-20", { recurs: 1 })];
  const tasks = [
    TASK(1, "2026-03-09", "18:00"),
    TASK(2, "2026-03-11"),
    TASK(3, "2026-03-20") // вне окна
  ];
  const text = weeklyDigestText("2026-03-09", "2026-03-15", dates, tasks);
  ok(text.startsWith("Планы на неделю 09.03 — 15.03:"), text.slice(0, 40));
  ok(text.includes("• Пн 09.03, до 18:00 — План 1"), "план с временем без подписи «до»");
  ok(text.includes("• Ср 11.03 — План 2"), "план без времени");
  ok(!text.includes("План 3"), "план вне окна попал в сводку");
  ok(text.includes("• Вт 10.03 — Дата 1"), "дата в окне не найдена");
  ok(!text.includes("Дата 2"), "дата вне окна попала в сводку");
  // Пустая неделя — пустой текст (не отправляем).
  equal(weeklyDigestText("2026-03-09", "2026-03-15", [], []), "");
});

test("weeklyDigestText: ежемесячные и ежегодные попадают в окно", () => {
  const tasks = [
    TASK(1, "2020-03-12", null, { monthly: 1 }),  // 12-е число — в окне
    TASK(2, "2020-03-16", null, { yearly: 1 })    // 16 марта — в окне
  ];
  const text = weeklyDigestText("2026-03-09", "2026-03-15", [], tasks);
  ok(text.includes("План 1"), "ежемесячный план не найден в окне");
  ok(!text.includes("План 2"), "ежегодный план вне окна попал в сводку");
  const text2 = weeklyDigestText("2026-03-09", "2026-03-15", [], [TASK(2, "2020-03-12", null, { yearly: 1 })]);
  ok(text2.includes("План 2"), "ежегодный 12 марта не найден");
});

test("weeklyDigestText: дни рождения отдельным абзацем без маски, приватные — спойлер", () => {
  const dates = [
    DATE(1, "2020-03-12", { kind: "birthday", title: "Аня", recurs: 1 }),
    DATE(2, "2020-03-13", { is_private: 1, title: "Секретный план", recurs: 1 })
  ];
  const text = weeklyDigestText("2026-03-09", "2026-03-15", dates, []);
  ok(text.includes("Дни рождения"), "нет абзаца дней рождения");
  ok(text.includes("richToHtml") === false, "текст leaked");
  ok(/• Чт 12\.03 — Аня/.test(text), "день рождения без имени не найден");
  ok(text.includes("<tg-spoiler>Скрытый</tg-spoiler>"), "приватный план не замаскирован");
  ok(!text.includes("Секретный план"), "приватный заголовок утёк в сводку");
  // Порядок абзацев: Дни рождения → Значимые даты → Планы.
  ok(text.indexOf("Дни рождения") < text.indexOf("Значимые даты"), "порядок абзацев нарушен");
});

test("weeklyDigestText: капы — «…и ещё N» при переполнении", () => {
  const tasks = [];
  for (let i = 0; i < 25; i++) tasks.push(TASK(i + 1, "2026-03-09"));
  const text = weeklyDigestText("2026-03-09", "2026-03-15", [], tasks);
  ok(text.includes("…и ещё 7 — полный список в приложении"), "нет хвоста переполнения");
  ok(text.split("\n").filter((line) => line.startsWith("• Пн 09.03")).length === 18, "кап по числу строк не сработал");
});
