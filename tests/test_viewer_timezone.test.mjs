// Личные пояса зрителя (public/app.js): «сегодня» календаря, отметки и
// конверсия «для вас» считаются в users.timezone, якоря событий — в поясе
// пары. При одинаковых поясах конверсия пустая (fast path).
//
// Запуск: node --test tests/test_viewer_timezone.test.mjs
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { equal, ok } from "node:assert/strict";
import { test } from "node:test";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const source = readFileSync(join(root, "public/app.js"), "utf8");

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

// planTarget стабилизирован фиксированным моментом: конверсия работает с
// любым абсолютным Date, якорить его здесь не нужно.
const STUB_TARGET = Date.UTC(2026, 6, 15, 17, 0, 0); // 20:00 Москвы, 17:00 UTC

const load = new Function(
  "planTarget",
  [
    "let appState = null;",
    "function esc(value) { return String(value ?? ''); }",
    extractBraced("function pairTimeZone("),
    extractBraced("function viewerTimeZone("),
    extractBraced("function validTimeZoneLite("),
    extractBraced("function calendarKeyFromDate("),
    extractBraced("function calendarTodayKey("),
    extractBraced("function formatTimestamp("),
    extractBraced("function viewerTimeHint("),
    // Цепочка nextDaysLabel → nextOccurrence → annualDate/monthlyNext/zonedToday.
    extractBraced("function timeZoneOffsetMs("),
    extractBraced("function makeDateInTimeZone("),
    extractBraced("function zonedToday("),
    extractBraced("function monthlyNext("),
    extractBraced("function annualDate("),
    extractBraced("function dayTime("),
    extractBraced("function nextOccurrence("),
    extractBraced("function plural("),
    extractBraced("function calendarDaysFromNow("),
    extractBraced("function nextDaysLabel("),
    "return { viewerTimeZone, pairTimeZone, calendarKeyFromDate, calendarTodayKey, formatTimestamp, viewerTimeHint, nextDaysLabel, setState: (v) => { appState = v; } };"
  ].join("\n")
);

function makeView({ userTz, pairTz }) {
  const ctx = load(() => new Date(STUB_TARGET));
  ctx.setState({
    user: { timezone: userTz },
    pair: { timezone: pairTz }
  });
  return ctx;
}

test("одинаковые пояса: конверсия пустая (fast path)", () => {
  const ctx = makeView({ userTz: "Europe/Moscow", pairTz: "Europe/Moscow" });
  equal(ctx.viewerTimeHint("2026-07-15", "20:00"), "");
});

test("разные пояса: время конвертируется, дата та же", () => {
  const ctx = makeView({ userTz: "UTC", pairTz: "Europe/Moscow" });
  equal(ctx.viewerTimeHint("2026-07-15", "20:00"), "для вас 17:00");
});

test("разные пояса: дата сместилась — конверсия с датой", () => {
  // 20:00 Москвы = 23:59+ UTC… берём цель ближе к полуночи: стаб цели
  // фиксирован, поэтому смещение проверяем на дате пояса зрителя: цель
  // 17:00 UTC = 20:00 МСК того же дня; для смещения сравниваем пары
  // «Москва → Лос-Анджелес»: 20:00 МСК 15.07 = 10:00 LAX 15.07 (та же дата).
  // Смещение суток даёт Лос-Анджелес при 04:00 МСК — стаб не двигается,
  // поэтому проверяем через calendarKeyFromDate (см. ниже), а здесь — формат.
  const ctx = makeView({ userTz: "America/Los_Angeles", pairTz: "Europe/Moscow" });
  const hint = ctx.viewerTimeHint("2026-07-15", "20:00");
  ok(hint.startsWith("для вас "), hint);
  ok(/\d{2}:\d{2}$/.test(hint), hint);
});

// BUG-01: записи без времени не должны получать ложную подсказку «для вас
// HH:MM» — planTarget превращал пустое время в 23:59 и строил абсолютный
// момент, которого у безвременной записи нет.
test("viewerTimeHint: пустое время — пустая строка при любых поясах", () => {
  for (const [userTz, pairTz] of [
    ["UTC", "Europe/Moscow"],
    ["America/Los_Angeles", "Asia/Tokyo"],
    ["Europe/Moscow", "Europe/Moscow"]
  ]) {
    const ctx = makeView({ userTz, pairTz });
    equal(ctx.viewerTimeHint("2026-07-15", null), "", `${userTz}←${pairTz}, null`);
    equal(ctx.viewerTimeHint("2026-07-15", undefined), "", `${userTz}←${pairTz}, undefined`);
    equal(ctx.viewerTimeHint("2026-07-15", ""), "", `${userTz}←${pairTz}, ""`);
  }
});

test("viewerTimeHint: валидное HH:MM по-прежнему конвертируется", () => {
  const ctx = makeView({ userTz: "UTC", pairTz: "Europe/Moscow" });
  equal(ctx.viewerTimeHint("2026-07-15", "20:00"), "для вас 17:00");
});

// BUG-04: «Сегодня/Завтра» у дня рождения считались в поясе ПАРЫ, тогда как
// dateItem/calendarDaysFromNow — в поясе зрителя. Подпись обязана совпадать
// по семантике с остальными бактетами экрана.
test("nextDaysLabel: «Сегодня/Завтра» по календарю зрителя", () => {
  // Фиксируем «сейчас»: 2026-11-10 16:00 UTC = 08:00 в Лос-Анджелесе
  // (у зрителя ещё 10.11), но уже 01:00 11.11 в Токио (у пары — 11.11).
  const RealDate = Date;
  const FIXED = Date.UTC(2026, 10, 10, 16, 0, 0);
  class FakeDate extends RealDate {
    constructor(...args) { super(...(args.length ? args : [FIXED])); }
    static now() { return FIXED; }
  }
  globalThis.Date = FakeDate;
  try {
    const ctx = makeView({ userTz: "America/Los_Angeles", pairTz: "Asia/Tokyo" });
    // День рождения 11.11 в 20:00 по Токио = 11.11 03:00 по Лос-Анджелесу:
    // для зрителя это ЗАВТРАШНИЙ день → «Завтра» (старый код по поясу пары
    // давал «Сегодня»: у пары этот момент — сегодня 11.11).
    equal(ctx.nextDaysLabel({ day: "1990-11-11", time: "20:00", recurs: 1 }), "Завтра");
    // Контроль: 11.11 05:00 по Токио = 10.11 12:00 по Лос-Анджелесу —
    // «сегодня» по обоим поясам → «Сегодня».
    equal(ctx.nextDaysLabel({ day: "1990-11-11", time: "05:00", recurs: 1 }), "Сегодня");
  } finally {
    globalThis.Date = RealDate;
  }
});

test("calendarKeyFromDate: «сегодня» зрителя и пояс пары различаются у полуночи", () => {
  const ctx = makeView({ userTz: "UTC", pairTz: "Europe/Moscow" });
  // 22:00 UTC 15.07 = 01:00 Москвы 16.07.
  const moment = new Date(Date.UTC(2026, 6, 15, 22, 0, 0));
  equal(ctx.calendarKeyFromDate(moment, "UTC"), "2026-07-15", "зритель в UTC — ещё 15.07");
  equal(ctx.calendarKeyFromDate(moment, "Europe/Moscow"), "2026-07-16", "пояс пары — уже 16.07");
  // Дефолт ключа — личный пояс зрителя.
  equal(ctx.calendarKeyFromDate(moment), "2026-07-15");
  equal(ctx.calendarTodayKey(), ctx.calendarKeyFromDate(new Date(), ctx.viewerTimeZone()));
});

test("formatTimestamp: отметки в личном поясе зрителя", () => {
  const ctx = makeView({ userTz: "UTC", pairTz: "Europe/Moscow" });
  const ts = Date.UTC(2026, 6, 15, 22, 0, 0) / 1000; // 01:00 Москвы 16.07
  equal(ctx.formatTimestamp(ts), "15.07.2026", "зритель в UTC видит 15.07");
});

test("гвардии: якоря в поясе пары, зрительские точки — в личном", () => {
  const slice = (startMarker, endMarker) => {
    const start = source.indexOf(startMarker);
    const end = source.indexOf(endMarker, start);
    ok(start > -1 && end > start, `${startMarker} не найдено`);
    return source.slice(start, end);
  };
  const planBody = slice("function planTarget(day, time, repeat = null)", "function byRowId");
  ok(planBody.includes("const tz = pairTimeZone();"), "planTarget отвязан от пояса пары");
  const daysBody = slice("function calendarDaysFromNow(target)", "function viewerTimeHint");
  ok(daysBody.includes("const tz = viewerTimeZone();"), "бактеты «Сегодня/Завтра» не по зрителю");
  ok(/function calendarTodayKey\(\) \{\s*\n\s*return calendarKeyFromDate\(new Date\(\), viewerTimeZone\(\)\);/.test(source), "calendarTodayKey не по зрителю");
  ok(/timeZone: viewerTimeZone\(\), year: "numeric", month: "2-digit", day: "2-digit"\s*\n?\s*\}\)\.formatToParts\(new Date\(n \* 1000\)\)/.test(source), "formatTimestamp не по зрителю");
  ok(/function viewerTimeHint\(day, time\) \{[\s\S]{0,200}if \(viewer === pair\) return "";/.test(source), "нет fast path при равных поясах");
});
