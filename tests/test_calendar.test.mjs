// Календарь вкладки «Наша пара»: сетка месяца и индекс событий по дням.
//
// Логика вынесена в чистые функции (calendarGrid, calendarEventIndex и др.),
// поэтому проверяется без DOM: они исполняются через new Function с заглушкой
// appState — сам модуль при загрузке ничего не трогает.
//
// Запуск: node --test tests/test_calendar.test.mjs
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { deepStrictEqual, equal } from "node:assert/strict";
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

const calendar = new Function(
  "appState",
  [
    extractBraced("function pairTimeZone"),
    extractBraced("function calendarPad"),
    extractBraced("function calendarDayKey"),
    extractBraced("function calendarDaysInMonth"),
    extractBraced("function calendarGrid"),
    extractBraced("function calendarEventIndex"),
    extractBraced("function calendarMonthTitle"),
    extractBraced("function calendarLongDate"),
    extractBraced("function calendarKeyFromDate"),
    extractBraced("function calendarTodayKey"),
    extractBraced("function calendarEventRows"),
    "return { calendarPad, calendarDayKey, calendarDaysInMonth, calendarGrid, calendarEventIndex, calendarMonthTitle, calendarLongDate, calendarKeyFromDate, calendarTodayKey, calendarEventRows };"
  ].join("\n")
)({ pair: { timezone: "Europe/Moscow" } });

const {
  calendarDayKey,
  calendarDaysInMonth,
  calendarGrid,
  calendarEventIndex,
  calendarMonthTitle,
  calendarLongDate,
  calendarTodayKey,
  calendarEventRows
} = calendar;

const task = (id, day, time = null, title = `План ${id}`) => ({ id, title, day, time, is_private: 0 });
const date = (id, day, recurs, time = null, title = `Дата ${id}`) => ({ id, title, day, recurs, time, is_private: 0 });

// ------------------------------------------------------------------ сетка

test("февраль: 28 дней в обычном году и 29 в високосном", () => {
  equal(calendarDaysInMonth(2026, 2), 28);
  equal(calendarDaysInMonth(2028, 2), 29);
  equal(calendarDaysInMonth(2026, 12), 31);
  equal(calendarDaysInMonth(2026, 4), 30);
});

test("сетка начинается с понедельника и кратна семи", () => {
  const grid = calendarGrid(2026, 10); // октябрь 2026
  equal(grid.length % 7, 0);
  // 1 октября 2026 — четверг, значит перед ним Пн, Вт, Ср.
  equal(grid[0].day, 28);
  equal(grid[0].month, 9);
  equal(grid[0].inMonth, false);
  equal(grid[3].key, "2026-10-01");
  equal(grid[3].inMonth, true);
});

test("дни соседних месяцев помечены как внешние", () => {
  const grid = calendarGrid(2026, 10);
  const outside = grid.filter((cell) => !cell.inMonth);
  equal(outside.length > 0, true);
  for (const cell of outside) equal(cell.inMonth, false);
  const inside = grid.filter((cell) => cell.inMonth);
  equal(inside.length, 31);
  equal(inside[0].key, "2026-10-01");
  equal(inside[30].key, "2026-10-31");
});

test("переход через границу года: декабрь → январь", () => {
  const december = calendarGrid(2026, 12);
  const januaryCells = december.filter((cell) => cell.month === 1 && cell.year === 2027);
  equal(januaryCells.length > 0, true);
  equal(januaryCells[0].key.startsWith("2027-01"), true);
});

test("февраль 2028 содержит 29-е число", () => {
  const grid = calendarGrid(2028, 2);
  equal(grid.some((cell) => cell.key === "2028-02-29"), true);
  const plain = calendarGrid(2027, 2);
  equal(plain.some((cell) => cell.key === "2027-02-29"), false);
});

test("название месяца по-русски и с заглавной буквы", () => {
  equal(calendarMonthTitle(2026, 5), "Май 2026");
  equal(calendarMonthTitle(2027, 1), "Январь 2027");
});

test("полная дата выбранного дня — русская", () => {
  equal(calendarLongDate("2026-05-15").includes("мая 2026"), true);
  equal(calendarLongDate("2026-01-01").includes("января 2026"), true);
});

test("«сегодня» — ключ YYYY-MM-DD в поясе пары", () => {
  equal(/^\d{4}-\d{2}-\d{2}$/.test(calendarTodayKey()), true);
});

// ------------------------------------------------------------- события

test("план с датой попадает в свой день, без даты — никуда", () => {
  const index = calendarEventIndex([task(1, "2026-05-15"), task(2, null)], [], [], 2026, 5);
  equal(index.get("2026-05-15").tasks.length, 1);
  equal(index.get("2026-05-15").dates.length, 0);
  equal(index.size, 1);
});

test("значимая дата без повтора — только в исходном году", () => {
  const dates = [date(1, "2024-05-15", 0)];
  equal(calendarEventIndex([], dates, [], 2024, 5).get("2024-05-15").dates.length, 1);
  equal(calendarEventIndex([], dates, [], 2026, 5).size, 0);
});

test("ежегодная дата проецируется на тот же месяц и день", () => {
  const dates = [date(1, "2024-05-15", 1)];
  for (const year of [2024, 2025, 2026, 2030]) {
    const bucket = calendarEventIndex([], dates, [], year, 5).get(`${year}-05-15`);
    equal(Boolean(bucket), true, `год ${year}`);
    equal(bucket.dates.length, 1);
  }
  // До года создания не показываем.
  equal(calendarEventIndex([], dates, [], 2023, 5).size, 0);
  // И не показываем в других месяцах.
  equal(calendarEventIndex([], dates, [], 2026, 6).size, 0);
});

test("29 февраля: только в високосные годы, без переноса", () => {
  const dates = [date(1, "2024-02-29", 1)];
  const leap = calendarEventIndex([], dates, [], 2028, 2);
  equal(leap.get("2028-02-29").dates.length, 1);
  const plain = calendarEventIndex([], dates, [], 2027, 2);
  equal(plain.size, 0);
  // 28 февраля и 1 марта — не место для этой даты.
  equal(calendarEventIndex([], dates, [], 2027, 2).get("2027-02-28"), undefined);
});

test("план и дата в один день дают обе группы событий", () => {
  const index = calendarEventIndex([task(1, "2026-05-15")], [date(2, "2024-05-15", 1)], [], 2026, 5);
  const bucket = index.get("2026-05-15");
  equal(bucket.tasks.length, 1);
  equal(bucket.dates.length, 1);
});

test("несколько событий одного дня сохраняются все", () => {
  const tasks = [task(1, "2026-05-15"), task(2, "2026-05-15"), task(3, "2026-05-16")];
  const bucket = calendarEventIndex(tasks, [], [], 2026, 5).get("2026-05-15");
  deepStrictEqual(bucket.tasks.map((item) => item.id), [1, 2]);
});

test("строки событий сортируются по времени, без времени — в конце", () => {
  const bucket = {
    tasks: [{ title: "Вечер", time: "20:00" }, { title: "Без времени", time: null }],
    dates: [{ title: "Утро", time: "09:30" }]
  };
  deepStrictEqual(calendarEventRows(bucket).map((row) => row.title), ["Утро", "Вечер", "Без времени"]);
});

test("пустой день даёт пустой список строк", () => {
  deepStrictEqual(calendarEventRows(undefined), []);
  deepStrictEqual(calendarEventRows({ tasks: [], dates: [] }), []);
});

test("ключи дней всегда двузначные", () => {
  equal(calendarDayKey(2026, 5, 7), "2026-05-07");
  equal(calendarDayKey(2026, 12, 31), "2026-12-31");
});

// ------------------------------------------------- вручённые желания

const wish = (id, doneAt, done = 1, body = `Желание ${id}`) => ({ id, body, owner_id: 111, done, done_at: doneAt });
const at = (y, m, d, h = 12) => Math.floor(Date.UTC(y, m - 1, d, h) / 1000);

test("вручённое желание попадает в день вручения", () => {
  const wishes = [wish(1, at(2026, 5, 15, 9))]; // 12:00 по Москве
  const bucket = calendarEventIndex([], [], wishes, 2026, 5).get("2026-05-15");
  equal(Boolean(bucket), true);
  equal(bucket.wishes.length, 1);
});

test("день вручения считается по часовому поясу пары", () => {
  // 22:30 UTC = 01:30 следующего дня по Москве.
  const wishes = [wish(1, at(2026, 5, 15, 22) + 1800)];
  const index = calendarEventIndex([], [], wishes, 2026, 5);
  equal(index.get("2026-05-15"), undefined);
  equal(index.get("2026-05-16").wishes.length, 1);
});

test("незакрытое желание и запись без даты вручения не показываются", () => {
  const wishes = [wish(1, at(2026, 5, 15), 0), wish(2, null), wish(3, at(2026, 5, 15), 1)];
  const index = calendarEventIndex([], [], wishes, 2026, 5);
  equal(index.get("2026-05-15").wishes.length, 1);
  equal(index.get("2026-05-15").wishes[0].id, 3);
});

test("желание другого месяца в текущую сетку не попадает", () => {
  const wishes = [wish(1, at(2026, 6, 1, 9))];
  equal(calendarEventIndex([], [], wishes, 2026, 5).size, 0);
  equal(calendarEventIndex([], [], wishes, 2026, 6).get("2026-06-01").wishes.length, 1);
});

test("в один день: звезда, план и дата", () => {
  const index = calendarEventIndex(
    [task(1, "2026-05-15")],
    [date(2, "2024-05-15", 1)],
    [wish(3, at(2026, 5, 15, 9))],
    2026,
    5
  );
  const bucket = index.get("2026-05-15");
  equal(bucket.tasks.length, 1);
  equal(bucket.dates.length, 1);
  equal(bucket.wishes.length, 1);
});

test("вручённое желание в списке событий — отдельный тип", () => {
  const rows = calendarEventRows({
    tasks: [],
    dates: [],
    wishes: [{ body: "Плед", owner_id: 111 }]
  });
  deepStrictEqual(rows.map((row) => row.kind), ["wish"]);
  equal(rows[0].title, "Плед");
});

test("личные записи помечены в строках событий", () => {
  const rows = calendarEventRows({
    tasks: [{ title: "Секрет", time: null, is_private: 1 }],
    dates: [{ title: "Сюрприз", time: null, is_private: 1 }],
    wishes: []
  });
  equal(rows.every((row) => row.isPrivate === true), true);
});

test("маркеры: звезда жёлтая, личное — серое, и не от акцента", () => {
  equal(cssSource.includes(".cal-star"), true);
  equal(cssSource.includes("var(--cal-wish)"), true);
  equal(cssSource.includes(".cal-dot.is-private"), true);
  equal(cssSource.includes("var(--cal-private)"), true);
  equal(cssSource.includes("--cal-wish: #"), true);
  equal(cssSource.includes("--cal-wish: var(--berry"), false);
});

test("в календарь попадают только свои вручённые желания", () => {
  // Фильтр по owner_id стоит в renderPairCalendar, до построения индекса.
  const fn = source.slice(source.indexOf("function renderPairCalendar"), source.indexOf("function calendarArchivePending"));
  equal(fn.includes('mergedArchive("done_wishes"'), true);
  equal(fn.includes("Number(wish.owner_id) === myId"), true);
  equal(fn.includes("appState.user?.tg_id"), true);
});

// ------------------------------------------------------- интеграция в UI

const cssSource = readFileSync(join(root, "public/app.css"), "utf8");

test("календарь стоит между участниками и настройками", () => {
  const pair = source.slice(source.indexOf("function renderPair()"), source.indexOf("function render()"));
  const calendarAt = pair.indexOf("${renderPairCalendar()}");
  const settingsAt = pair.indexOf("${renderPairSettings()}");
  equal(calendarAt > 0, true, "календарь не вставлен в renderPair");
  equal(settingsAt > 0, true, "настройки не найдены");
  equal(calendarAt < settingsAt, true, "календарь должен быть выше настроек");
});

test("кнопки календаря подключены к обработчику действий", () => {
  for (const action of ["calendar-prev", "calendar-next", "calendar-day"]) {
    equal(source.includes('data-action="' + action + '"'), true, action);
    equal(source.includes('action === "' + action + '"'), true, action + " не обрабатывается");
  }
});

test("маркеры семантические и не зависят от акцента", () => {
  const taskRule = cssSource.slice(cssSource.indexOf(".cal-dot.is-task"), cssSource.indexOf(".cal-dot.is-task") + 80);
  const dateRule = cssSource.slice(cssSource.indexOf(".cal-dot.is-date"), cssSource.indexOf(".cal-dot.is-date") + 80);
  equal(taskRule.includes("var(--cal-task)"), true, taskRule);
  equal(dateRule.includes("var(--cal-date)"), true, dateRule);
  equal(cssSource.includes("--cal-task: #"), true);
  equal(cssSource.includes("--cal-date: #"), true);
  // Цвета не должны быть привязаны к акцентной палитре.
  equal(cssSource.includes("--cal-task: var(--berry"), false);
  equal(cssSource.includes("--cal-date: var(--berry"), false);
});

test("сегодня и выбранный день — разные классы", () => {
  equal(cssSource.includes(".cal-day.is-today"), true);
  equal(cssSource.includes(".cal-day.is-selected"), true);
  equal(cssSource.includes(".cal-day.is-outside"), true);
});
