// Покрытие чистых хелперов app.js, у которых не было прямых тестов:
// flo-математика дат (floDayDiff/floDateShift/floInPeriod), разбор расписания
// приёмов здоровья (healthScheduleCount/healthTimesList/...), политика
// тулбара форматирования (allowedFmt/isFmtTarget), datesOfKind (PD-DATES-001),
// renderMemoriesList (слияние recent+архива), movieSelectionOrder (порядок
// частей новой группы).
import { readFileSync } from "node:fs";
import { deepStrictEqual, equal, ok } from "node:assert/strict";
import { test } from "node:test";

const source = readFileSync(new URL("../public/app.js", import.meta.url), "utf8");

function extractBraced(declaration) {
  const start = source.indexOf(declaration);
  if (start === -1) throw new Error(`${declaration} not found`);
  let depth = 0;
  for (let j = source.indexOf("{", start); j < source.length; j++) {
    if (source[j] === "{") depth++;
    else if (source[j] === "}") {
      depth--;
      if (depth === 0) return source.slice(start, j + 1);
    }
  }
  throw new Error(`unclosed block: ${declaration}`);
}

// ---------- flo-математика дат ----------

const floPeriods = { list: [] };
const F = new Function(
  "floAllPeriods",
  [
    extractBraced("function floInPeriod"),
    extractBraced("function floDayDiff"),
    extractBraced("function floDateShift"),
    "let floState = null;",
    "return { floInPeriod, floDayDiff, floDateShift, setFloState: (s) => { floState = s; } };"
  ].join("\n")
)(() => floPeriods.list);

test("floDayDiff: разница дат в днях без часовых поясов", () => {
  equal(F.floDayDiff("2026-11-01", "2026-11-24"), 23);
  equal(F.floDayDiff("2026-11-24", "2026-11-01"), -23);
  equal(F.floDayDiff("2026-11-24", "2026-11-24"), 0);
  equal(F.floDayDiff("2026-02-28", "2026-03-01"), 1, "невисокосный февраль");
  equal(F.floDayDiff("2028-02-28", "2028-03-01"), 2, "високосный февраль");
});

test("floDateShift: календарный сдвиг через UTC", () => {
  equal(F.floDateShift("2026-11-24", 7), "2026-12-01");
  equal(F.floDateShift("2026-12-01", -7), "2026-11-24");
  equal(F.floDateShift("2026-11-24", 0), "2026-11-24");
  equal(F.floDateShift("2026-02-28", 1), "2026-03-01");
  equal(F.floDateShift("2028-02-28", 1), "2028-02-29");
});

test("floInPeriod: закрытый период — от start до end включительно", () => {
  floPeriods.list = [{ start_date: "2026-11-01", end_date: "2026-11-05" }];
  F.setFloState({ today: "2026-11-24" });
  ok(F.floInPeriod("2026-11-01"));
  ok(F.floInPeriod("2026-11-05"), "конец включается");
  ok(!F.floInPeriod("2026-11-06"));
});

test("floInPeriod: открытый период — до сегодня по floState.today, дальше нет", () => {
  floPeriods.list = [{ start_date: "2026-11-20", end_date: null }];
  F.setFloState({ today: "2026-11-24", open_period_start: "2026-11-20" });
  ok(F.floInPeriod("2026-11-24"), "сегодня внутри открытого периода");
  ok(!F.floInPeriod("2026-11-25"), "несостоявшиеся дни открытого периода не считаются");
  ok(!F.floInPeriod("2026-11-19"));
});

test("floInPeriod: период без конца и не открытый — только день старта", () => {
  floPeriods.list = [{ start_date: "2026-11-01", end_date: null }];
  F.setFloState({ today: "2026-11-24", open_period_start: "2026-11-20" });
  ok(F.floInPeriod("2026-11-01"));
  ok(!F.floInPeriod("2026-11-02"), "конец неизвестен — период не растягивается");
});

// ---------- health: расписание приёмов ----------

const H = new Function(
  [
    source.slice(source.indexOf("const HEALTH_MED_DEFAULT_TIMES"), source.indexOf("function healthScheduleCount")),
    extractBraced("function healthScheduleCount"),
    extractBraced("function healthTimesList"),
    extractBraced("function healthTimesCount"),
    extractBraced("function healthDefaultTime"),
    extractBraced("function healthRemindTimesHtml"),
    `function esc(v) {
      return String(v ?? "").replace(/[&<>"']/g, ch => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch]));
    }`,
    "return { healthScheduleCount, healthTimesList, healthTimesCount, healthDefaultTime, healthRemindTimesHtml };"
  ].join("\n")
)();

test("healthScheduleCount: число из схемы, 1..4, остальное — 0", () => {
  equal(H.healthScheduleCount("2 раза в день"), 2);
  equal(H.healthScheduleCount("4"), 4);
  equal(H.healthScheduleCount("—"), 0, "свободный текст старых записей");
  equal(H.healthScheduleCount(""), 0);
  equal(H.healthScheduleCount(null), 0);
  equal(H.healthScheduleCount("5"), 0, "вне диапазона");
  equal(H.healthScheduleCount("0"), 0);
});

test("healthTimesList: только валидные «ЧЧ:ММ», с trim и фильтром мусора", () => {
  deepStrictEqual(
    H.healthTimesList({ remind_time: "09:00, 21:05, bad, 9:00, 24:00, 07:5, 00:00" }),
    ["09:00", "21:05", "00:00"]
  );
  deepStrictEqual(H.healthTimesList({}), []);
  deepStrictEqual(H.healthTimesList({ remind_time: null }), []);
});

test("healthTimesCount: схема важнее списка, иначе длина списка, иначе 1", () => {
  equal(H.healthTimesCount({ schedule: "3", remind_time: "08:00" }), 3);
  equal(H.healthTimesCount({ schedule: "—", remind_time: "08:00, 09:00" }), 2);
  equal(H.healthTimesCount({}), 1);
});

test("healthDefaultTime: сетка по числу приёмов, неизвестное — 09:00", () => {
  equal(H.healthDefaultTime(0, 1), "09:00");
  equal(H.healthDefaultTime(1, 2), "21:00");
  equal(H.healthDefaultTime(0, 3), "08:00");
  equal(H.healthDefaultTime(2, 3), "20:00");
  equal(H.healthDefaultTime(2, 4), "16:00");
  equal(H.healthDefaultTime(0, 5), "09:00");
});

test("healthRemindTimesHtml: сохранённые времена важнее, пустые слоты — из сетки", () => {
  const html = H.healthRemindTimesHtml({ schedule: "3", remind_time: "07:30, 21:05" });
  equal((html.match(/<input /g) || []).length, 3, "три поля по числу приёмов");
  ok(html.includes('value="07:30"') && html.includes('value="21:05"'));
  ok(html.includes('value="20:00"'), "третий слот добирается из HEALTH_MED_DEFAULT_TIMES");
  ok(html.includes('name="remind_times"'), "имя поля для formData");
  ok(html.includes('data-fmt="none"'), "время приёма не форматируется тулбаром");
  ok(html.includes('aria-label="Время приёма 3"'));
  ok(html.includes('<label class="field">'), "каждое время в обёртке .field (репорт 2026-11-22)");
});

test("healthRemindTimesHtml: без данных — одно поле с дефолтом 09:00", () => {
  const html = H.healthRemindTimesHtml({});
  ok(html.includes('value="09:00"'));
  ok(!html.includes('value=""'), "пустых слотов нет");
});

// ---------- тулбар форматирования ----------

function FakeArea(inDialog = true) { this._in = inDialog; }
FakeArea.prototype.closest = function () { return this._in ? {} : null; };
function FakeInput(inDialog = true, type = "text") { this._in = inDialog; this.type = type; }
FakeInput.prototype.closest = FakeArea.prototype.closest;

const fmt = new Function(
  "HTMLTextAreaElement", "HTMLInputElement",
  [
    extractBraced("function isFmtTarget"),
    extractBraced("function allowedFmt"),
    "return { isFmtTarget, allowedFmt };"
  ].join("\n")
)(FakeArea, FakeInput);

test("allowedFmt: без атрибута — все кнопки (null), none — пусто, список — по словам", () => {
  equal(fmt.allowedFmt(null), null, "нет поля — тулбар не ограничиваем");
  equal(fmt.allowedFmt({}), null, "поле без data-fmt — все кнопки");
  deepStrictEqual(fmt.allowedFmt({ dataset: { fmt: "none" } }), [], "заголовки окон");
  deepStrictEqual(fmt.allowedFmt({ dataset: { fmt: "** _ __ ~~" } }), ["**", "_", "__", "~~"]);
  deepStrictEqual(fmt.allowedFmt({ dataset: { fmt: "  **   _  " } }), ["**", "_"], "лишние пробелы отбрасываются");
});

test("isFmtTarget: textarea и текстовый input внутри #dialog-fields", () => {
  ok(fmt.isFmtTarget(new FakeArea(true)));
  ok(fmt.isFmtTarget(new FakeInput(true)));
  ok(fmt.isFmtTarget(new FakeInput(true, undefined)), "input без типа считается текстовым");
  ok(!fmt.isFmtTarget(new FakeInput(true, "time")), "не-текстовый тип — выделения нет");
  ok(!fmt.isFmtTarget(new FakeArea(false)), "вне #dialog-fields");
  ok(!fmt.isFmtTarget(new FakeInput(false)));
  ok(!fmt.isFmtTarget(null));
});

// ---------- datesOfKind ----------

function buildDates({ dates = [], birthdays = [], archiveBirthdays = [] } = {}) {
  return new Function(
    "appState", "mergedArchive",
    [
      extractBraced("function datesOfKind"),
      "return datesOfKind;"
    ].join("\n")
  )({ dates, birthdays }, (type, recent) => (type === "birthdays" ? [...recent, ...archiveBirthdays] : recent));
}

test("datesOfKind: «Наши» — только kind='date', включая записи без kind", () => {
  const rows = buildDates({
    dates: [{ id: 1, kind: "date" }, { id: 2, kind: "birthday" }, { id: 3 }]
  })("date");
  deepStrictEqual(rows.map(row => row.id), [1, 3], "записи без kind считаются обычными датами");
});

test("datesOfKind: «Дни рождения» — recent и архивный набор с фильтром kind", () => {
  const rows = buildDates({
    birthdays: [{ id: 10, kind: "birthday" }],
    archiveBirthdays: [{ id: 11, kind: "birthday" }, { id: 12, kind: "date" }]
  })("birthday");
  deepStrictEqual(rows.map(row => row.id), [10, 11], "обычная дата из архива не протекает в сегмент");
});

// ---------- renderMemoriesList ----------

function buildMemoriesList(memories) {
  const calls = { merged: [], tabs: [], more: [] };
  const fn = new Function(
    "mergedArchive", "renderListTab", "archiveMoreHtml", "memoryItem", "appState",
    [
      extractBraced("function renderMemoriesList"),
      "return renderMemoriesList;"
    ].join("\n")
  );
  const mergedArchive = (type, recent) => { calls.merged.push([type, recent.length]); return [...recent, { id: 99 }]; };
  const renderListTab = (items, addAction, addLabel) => { calls.tabs.push({ items: items.length, addAction, addLabel }); return "<list>"; };
  const archiveMoreHtml = (type, count) => { calls.more.push([type, count]); return "<more>"; };
  const html = fn(mergedArchive, renderListTab, archiveMoreHtml, () => "<item>", { memories })();
  return { html, calls };
}

test("renderMemoriesList: слияние recent+архива, константы списка, честный счётчик «Показать ещё»", () => {
  const { html, calls } = buildMemoriesList([{ id: 1 }, { id: 2 }]);
  deepStrictEqual(calls.merged, [["memories", 2]], "archive-тип memories");
  deepStrictEqual(calls.tabs, [{ items: 3, addAction: "add-memory", addLabel: "Записать" }], "в списке и архивная запись (id 99)");
  deepStrictEqual(calls.more, [["memories", 2]], "«Показать ещё» считает только recent");
  ok(html.includes("<list>") && html.includes("<more>"));
});

// ---------- movieSelectionOrder ----------

function buildSelection({ view = "open", openList, watchedList, selection, entriesByMovie = {}, fullList }) {
  return new Function(
    "moviesView", "openMovies", "watchedMovies", "buildMovieEntries", "filterMoviesByKind", "sortMovieEntries", "movieGroupSelection", "movieList",
    [
      extractBraced("function movieSelectionOrder"),
      "return movieSelectionOrder;"
    ].join("\n")
  )(
    view,
    () => openList,
    () => watchedList,
    (movies) => movies.map(m => entriesByMovie[m.id] || { type: "movie", movie: m }),
    (list) => list,
    (entries) => entries,
    new Set(selection),
    () => fullList
  );
}

test("movieSelectionOrder: порядок следует экрану, группы разворачиваются в части", () => {
  const order = buildSelection({
    openList: [{ id: 1 }, { id: 2 }, { id: 3 }],
    selection: [1, 4, 5],
    entriesByMovie: { 2: { type: "group", members: [{ id: 2 }, { id: 4 }] } },
    fullList: [{ id: 1 }, { id: 2 }, { id: 3 }, { id: 4 }, { id: 5 }]
  })();
  deepStrictEqual(order, [1, 4, 5], "1 и 4 из развёрнутой группы по порядку экрана, 5 добран fallback-ом");
});

test("movieSelectionOrder: дубликаты схлопываются, невыбранные не попадают", () => {
  const order = buildSelection({
    openList: [{ id: 1 }, { id: 2 }],
    selection: [1, 2],
    fullList: [{ id: 1 }, { id: 2 }]
  })();
  deepStrictEqual(order, [1, 2]);
});

test("movieSelectionOrder: вид «Просмотрено» берёт watched-список", () => {
  const order = buildSelection({
    view: "watched",
    openList: [{ id: 1 }],
    watchedList: [{ id: 9 }],
    selection: [9],
    fullList: [{ id: 9 }]
  })();
  deepStrictEqual(order, [9]);
});
