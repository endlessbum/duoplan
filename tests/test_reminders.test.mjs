// Напоминания о планах (worker.js: planTaskReminders).
//
// Окна «за 3 часа» и «за час» не должны пересекаться: раньше задача, до которой
// меньше часа, получала ДВА сообщения в одном тике, и первое врало — «Через
// 3 часа» про событие через 20 минут.
//
// Запуск: node --test tests/test_reminders.test.mjs
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

function extractLine(prefix) {
  const start = source.indexOf(prefix);
  if (start === -1) throw new Error(`${prefix} не найдено`);
  return source.slice(start, source.indexOf("\n", start));
}

// Цепочка зависимостей: planTaskReminders → taskTargetMs → makeDateInTimeZone
// → timeZoneOffsetMs плюс константы окон. Все чистые, исполняем как есть.
const bundle = [
  extractLine("const REMINDER_3H"),
  extractLine("const REMINDER_1H"),
  extractLine("const dateTimeFormatCache = new Map();"),
  extractBraced("function cachedFormatter"),
  extractBraced("function timeZoneOffsetMs("),
  extractBraced("function makeDateInTimeZone("),
  extractBraced("function monthlyOccursOnDay("),
  extractBraced("function nextMonthlyOccurrenceMs("),
  extractBraced("function taskTargetMs("),
  extractBraced("function planTaskReminders(")
].join("\n");

// Условие отправки сводок: время наступило с переносом через полночь.
const timeDueBundle = [
  extractBraced("function parseTimeMinutes("),
  extractLine("const CRON_TICK_MINUTES"),
  extractBraced("function timeDueWithRollover("),
  extractBraced("function weeklyDigestDayKey(")
].join("\n");
const timeDueWithRollover = new Function(`${timeDueBundle}\nreturn timeDueWithRollover;`)();
const weeklyDigestDayKey = new Function(`${timeDueBundle}\nreturn weeklyDigestDayKey;`)();

// Личный контекст участника: сводки доставляются в его местное утро
// (users.timezone), содержимое — в поясе пары.
const memberBundle = [
  extractLine("const DEFAULT_TZ"),
  extractBraced("function validTimeZone("),
  extractBraced("function localDay("),
  extractBraced("function localMinutesOfDay("),
  extractBraced("function memberTimeContext(")
].join("\n");
const memberTimeContext = new Function(`${memberBundle}\nreturn memberTimeContext;`)();

const planTaskReminders = new Function(`${bundle}\nreturn planTaskReminders;`)();
const TZ = "Europe/Moscow";

// Полдень по Москве 15 июля 2026 (UTC+3, без переходов).
const nowMs = Date.UTC(2026, 6, 15, 9, 0, 0);
const at = (hours, minutes = 0) => Date.UTC(2026, 6, 15, hours, minutes, 0);
const task = (id, day, time) => ({ id, day, time, title: `Задача ${id}` });

test("до задачи больше трёх часов — напоминаний нет", () => {
  const planned = planTaskReminders([task(1, "2026-07-15", "16:00")], TZ, nowMs);
  deepStrictEqual(planned, []);
});

test("до задачи 2 часа 30 минут — одно напоминание «за 3 часа»", () => {
  const planned = planTaskReminders([task(1, "2026-07-15", "14:30")], TZ, nowMs);
  equal(planned.length, 1);
  equal(planned[0].kind, "task3h:1");
  equal(planned[0].lead, "Через 3 часа");
});

test("до задачи 20 минут — одно напоминание с фактическим временем", () => {
  const planned = planTaskReminders([task(1, "2026-07-15", "12:20")], TZ, nowMs);
  equal(planned.length, 1, "должно быть ровно одно напоминание");
  equal(planned[0].kind, "task1h:1");
  equal(planned[0].lead, "Через 20 мин", "в тексте реальные минуты, не «через час»");
});

test("граница часа: ровно 60 минут — «через час», не «через 3 часа»", () => {
  const planned = planTaskReminders([task(1, "2026-07-15", "13:00")], TZ, nowMs);
  equal(planned.length, 1);
  equal(planned[0].kind, "task1h:1");
  equal(planned[0].lead, "Через час", "ровно час читается как «через час»");
});

test("граница трёх часов: ровно 3 часа — «за 3 часа»", () => {
  const planned = planTaskReminders([task(1, "2026-07-15", "15:00")], TZ, nowMs);
  equal(planned.length, 1);
  equal(planned[0].kind, "task3h:1");
});

test("прошедшее время и задачи без времени пропускаются", () => {
  const planned = planTaskReminders(
    [task(1, "2026-07-15", "08:00"), task(2, "2026-07-15", null), task(3, null, "13:00")],
    TZ,
    nowMs
  );
  deepStrictEqual(planned, []);
});

test("напоминания не дублируются между задачами", () => {
  const planned = planTaskReminders(
    [task(1, "2026-07-15", "14:30"), task(2, "2026-07-15", "12:30")],
    TZ,
    nowMs
  );
  deepStrictEqual(planned.map((item) => item.kind), ["task3h:1", "task1h:2"]);
});

test("время задачи трактуется в часовом поясе пары", () => {
  // 12:20 по Москве = 09:20 UTC; при nowMs = 09:00 UTC это 20 минут.
  const planned = planTaskReminders([task(1, "2026-07-15", "12:20")], TZ, nowMs);
  equal(planned.length, 1);
  equal(planned[0].kind, "task1h:1");
  // Тот же момент в UTC-зоне — задача уже через 3 часа 20 минут.
  const utc = planTaskReminders([task(1, "2026-07-15", "12:20")], "UTC", nowMs);
  deepStrictEqual(utc, []);
});

// Сводки: cron тикает */15, и время 23:46–23:59 раньше не срабатывало никогда —
// тик 23:45 ещё раньше, а тик 00:00 попадал на новые сутки с minutes=0.
test("сводка в хвосте суток уходит полуночным тиком", () => {
  equal(timeDueWithRollover(1430, "23:50"), true, "23:50 того же дня");
  equal(timeDueWithRollover(0, "23:50"), true, "тик 00:00 — в пределах 15 минут после 23:50");
  equal(timeDueWithRollover(15, "23:50"), false, "00:15 — окно уже прошло");
  equal(timeDueWithRollover(0, "23:30"), false, "23:30 — до полуночи 30 минут, окно не то");
});

test("обычное время сводки не срабатывает в полночь", () => {
  equal(timeDueWithRollover(0, "09:00"), false, "09:00 в полночь ещё не наступило");
  equal(timeDueWithRollover(540, "09:00"), true, "09:00 наступило");
  equal(timeDueWithRollover(555, "09:07"), true, "09:15 — время 09:07 уже прошло");
  equal(timeDueWithRollover(0, "00:00"), true, "полночь наступила на первом тике суток");
});

// BUG-02: недельная сводка с временем из хвоста суток (напр. вс 23:50)
// срабатывает rollover-тиком 00:00 следующего дня. День недели при этом
// считается по ПРЕДЫДУЩЕМУ локальному дню участника, иначе расписание
// «пропадает»: memberCtx.today уже новый день.
const weekdayOf = (dayKey) => new Date(`${dayKey}T00:00:00Z`).getUTCDay(); // 0 = вс
const weeklyDue = (memberToday, minutes, timeValue, wantWeekday) =>
  weekdayOf(weeklyDigestDayKey(memberToday, minutes, timeValue)) === wantWeekday &&
  timeDueWithRollover(minutes, timeValue);

test("недельная сводка: воскресенье 23:50 уходит тиком понедельника 00:00", () => {
  // 2026-11-08 — воскресенье, 2026-11-09 — понедельник.
  equal(weeklyDue("2026-11-09", 0, "23:50", 0), true, "вс 23:50 → пн 00:00 отправляет");
  equal(weeklyDue("2026-11-10", 0, "23:50", 1), true, "пн 23:50 → вт 00:00 отправляет");
});

test("недельная сводка: 23:30 не попадает в rollover-окно", () => {
  equal(weeklyDue("2026-11-09", 0, "23:30", 0), false, "23:30 → 00:00 не отправляет");
});

test("недельная сводка: обычное время не меняет день недели", () => {
  equal(weeklyDigestDayKey("2026-11-09", 540, "09:00"), "2026-11-09", "09:00 — день не сдвигается");
  equal(weeklyDue("2026-11-09", 540, "09:00", 1), true, "пн 09:00 → wantWeekday=1 отправляет");
  equal(weeklyDue("2026-11-09", 540, "09:00", 0), false, "пн 09:00 → wantWeekday=0 не отправляет");
});

test("недельная сводка: rollover через границу месяца и года", () => {
  // 2026-11-01 — воскресенье; тик 2026-11-02 00:00 относится к 31.10? Нет:
  // memberToday — это уже 02.11 (понедельник), предыдущий день — 01.11 (вс).
  equal(weeklyDigestDayKey("2026-11-02", 0, "23:50"), "2026-11-01");
  equal(weekdayOf(weeklyDigestDayKey("2026-11-02", 0, "23:50")), 0, "01.11.2026 — воскресенье");
  // Новый год: 2027-01-01 — пятница; предыдущий день — 31.12.2026 (четверг).
  equal(weeklyDigestDayKey("2027-01-01", 0, "23:50"), "2026-12-31");
  equal(weekdayOf(weeklyDigestDayKey("2027-01-01", 0, "23:50")), 4);
});

// ------------------------------------------------------------------
// Личные пояса участников: сводки — по местному времени каждого.
// Содержимое сводок считается в поясе пары; memberTimeContext задаёт
// момент доставки и день ключа журнала.

test("memberTimeContext: минуты участников в разных поясах различаются", () => {
  const stamp = Date.UTC(2026, 6, 15, 9, 0, 0); // 12:00 Москвы
  const moscow = memberTimeContext({ timezone: "Europe/Moscow" }, stamp, "Europe/Moscow");
  const vladivostok = memberTimeContext({ timezone: "Asia/Vladivostok" }, stamp, "Europe/Moscow");
  equal(moscow.minutes, 720, "12:00 в Москве");
  equal(vladivostok.minutes, 1140, "19:00 во Владивостоке");
  equal(vladivostok.minutes - moscow.minutes, 420, "разница поясов — 7 часов");
  equal(moscow.timeZone, "Europe/Moscow");
  equal(vladivostok.timeZone, "Asia/Vladivostok");
});

test("memberTimeContext: около полуночи «сегодня» участников различается", () => {
  // 16:00 UTC = 19:00 Москвы (ещё 15.07) и 02:00 Владивостока (уже 16.07):
  // Владивосток UTC+10 — впереди Москвы на 7 часов.
  const stamp = Date.UTC(2026, 6, 15, 16, 0, 0);
  const moscow = memberTimeContext({ timezone: "Europe/Moscow" }, stamp, "Europe/Moscow");
  const vladivostok = memberTimeContext({ timezone: "Asia/Vladivostok" }, stamp, "Europe/Moscow");
  equal(moscow.today, "2026-07-15");
  equal(vladivostok.today, "2026-07-16");
});

test("memberTimeContext: пустой и битый пояс — фолбэк на пояс пары", () => {
  const stamp = Date.UTC(2026, 6, 15, 9, 0, 0);
  const fallback = memberTimeContext({}, stamp, "Asia/Vladivostok");
  equal(fallback.timeZone, "Asia/Vladivostok", "нет timezone — берём пояс пары");
  const broken = memberTimeContext({ timezone: "Mars/Olympus" }, stamp, "Europe/Moscow");
  equal(broken.timeZone, "Europe/Moscow", "невалидный пояс — фолбэк на пояс пары");
});
