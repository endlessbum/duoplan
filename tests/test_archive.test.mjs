// Тест серверной пагинации архива (/api/archive в worker.js).
//
// archivePage извлекается из worker.js как есть вместе с константами лимитов
// и исполняется против мока D1, который режет строки по LIMIT/OFFSET.
//
// Запуск: node tests/test_archive.test.mjs  (или node --test "tests/*.test.mjs")
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { deepStrictEqual, equal, ok, rejects } from "node:assert/strict";
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
  if (start === -1) throw new Error("${prefix} не найдено");
  return source.slice(start, source.indexOf("\n", start));
}

// Константы лимитов между STATE_ACTIVE_LIMIT и schemaReady.
const constsStart = source.indexOf("const STATE_ACTIVE_LIMIT");
const constsEnd = source.indexOf("const schemaReady");
if (constsStart === -1 || constsEnd === -1 || constsEnd < constsStart) {
  throw new Error("не найден блок констант лимитов");
}
const consts = source.slice(constsStart, constsEnd);
const load = new Function(
  `const DEFAULT_TZ = "Europe/Moscow";\n${consts}\n${extractBraced("function validTimeZone")}\n${extractBraced("function localDay")}\n${extractBraced("function byRowId")}\n${extractLine("const dateTimeFormatCache = new Map();")}
${extractBraced("function cachedFormatter")}
${extractBraced("function timeZoneOffsetMs")}\n${extractBraced("function makeDateInTimeZone")}\n${extractBraced("function monthlyOccursOnDay"),
    extractBraced("function nextMonthlyOccurrenceMs"),
    extractBraced("function nextDateOccurrence")}\n${extractBraced("function isPastDate")}\n${extractBraced("function sortDateRows")}\n${extractBraced("function taskTargetMs")}\n${extractBraced("function sortByTaskDeadline")}\n${extractBraced("class HttpError")}\n${extractBraced("function attachMovieRatings")}\n${extractLine("const clean = value")}\n${extractLine("const AUTHOR_NAME_TYPES")}\n${extractBraced("function applyAuthorNameOverrides")}\n${extractBraced("const ARCHIVE_COUNT_SQL")}\n${extractBraced("async function archivePage")}\n` +
  "return { archivePage, taskTargetMs, sortDateRows, sortByTaskDeadline, STATE_RECENT_LIMIT, STATE_ACTIVE_LIMIT, ARCHIVE_PAGE_SIZE };");
const { archivePage, taskTargetMs, sortDateRows, sortByTaskDeadline, STATE_RECENT_LIMIT, STATE_ACTIVE_LIMIT, ARCHIVE_PAGE_SIZE } = load();

const TOTAL = 50; // 10 последних в /api/state, остальные 40 — архив

function makeMockDb(total = TOTAL) {
  const db = {
    prepare(sql) {
      return {
        bind(...params) {
          // Число bind-аргументов обязано совпадать с числом «?» в SQL:
          // рассинхрон (репорт 2026-11-03, A-1) на живом D1 падает с 500.
          const placeholders = (sql.match(/\?/g) || []).length;
          if (placeholders !== params.length) {
            throw new Error(`bind-аргументов ${params.length}, плейсхолдеров ${placeholders}: ${sql}`);
          }
          // LIMIT/OFFSET — последние два аргумента (у userScoped SQL впереди
          // ещё pair.id и created_by; COUNT лимита не содержит).
          const [limit, offset] = params.slice(-2);
          return {
            async all() {
              const rows = [];
              for (let id = offset + 1; id <= Math.min(offset + limit, total); id++) {
                rows.push({ id });
              }
              return { results: rows };
            },
            // COUNT-запрос archivePage: в наборе ровно total подходящих строк.
            async first() {
              return { n: total };
            }
          };
        }
      };
    }
  };
  return { db };
}

// Активный путь (tasks/dates) биндит только pair.id и получает весь набор.
function makeActiveDb(rows) {
  return {
    prepare() {
      return {
        bind(...params) {
          // 1 параметр — tasks, 2 (pair.id + userId) — dates с фильтром приватности.
          if (params.length !== 1 && params.length !== 2) throw new Error(`активный путь биндит pair.id (и userId для дат), получено ${params.length}`);
          return { async all() { return { results: rows }; } };
        }
      };
    }
  };
}

test("константы лимитов согласованы", () => {
  deepStrictEqual(STATE_RECENT_LIMIT, 10);
  deepStrictEqual(ARCHIVE_PAGE_SIZE, 20);
});

test("первая страница архива начинается после недавних записей state", async () => {
  const { db } = makeMockDb();
  const result = await archivePage({ DB: db }, { id: 1 }, "memories", 0);
  deepStrictEqual(result.items.map((r) => r.id), Array.from({ length: ARCHIVE_PAGE_SIZE }, (_, i) => STATE_RECENT_LIMIT + 1 + i));
  deepStrictEqual(result.hasMore, true);
});

test("последняя страница возвращает остаток и закрывает архив", async () => {
  const { db } = makeMockDb();
  const second = await archivePage({ DB: db }, { id: 1 }, "done_tasks", 1);
  deepStrictEqual(second.items.map((r) => r.id), Array.from({ length: 20 }, (_, i) => 31 + i));
  deepStrictEqual(second.hasMore, false);
  // Страница за концом — пустая.
  const third = await archivePage({ DB: db }, { id: 1 }, "done_wishes", 2);
  deepStrictEqual(third.items, []);
  deepStrictEqual(third.hasMore, false);
});

// Репорт 2026-11-03, A-1: SQL done_tasks содержит created_by=?, а не-sort путь
// биндил только [pairId, limit, offset] — D1 отвечал «not enough parameters»,
// архив «Завершённые» падал с 500 после 10 завершённых планов.
test("userScoped SQL (done_tasks) биндит userId и на SELECT, а не только в COUNT", async () => {
  const seen = [];
  const spyDb = {
    prepare(sql) {
      return {
        bind(...params) {
          seen.push({ sql, params });
          return {
            async all() { return { results: [] }; },
            async first() { return { n: 0 }; }
          };
        }
      };
    }
  };
  await archivePage({ DB: spyDb }, { id: 7 }, "done_tasks", 0, 42);
  const main = seen.find((b) => b.sql.includes("SELECT"));
  ok(main, "SELECT-запрос не выполнен");
  deepStrictEqual(main.params, [7, 42, ARCHIVE_PAGE_SIZE + 1, STATE_RECENT_LIMIT]);
  const count = seen.find((b) => b.sql.includes("COUNT"));
  deepStrictEqual(count.params, [7, 42]);
});

test("неизвестный тип архива отклоняется", async () => {
  const { db } = makeMockDb();
  await rejects(archivePage({ DB: db }, { id: 1 }, "hack", 0), /Неизвестный тип архива/);
});

test("имена из прототипа не проходят за тип архива", async () => {
  const { db } = makeMockDb();
  for (const type of ["constructor", "toString", "__proto__", "hasOwnProperty"]) {
    await rejects(
      archivePage({ DB: db }, { id: 1 }, type, 0),
      error => error.status === 400 && error.code === "INVALID_ARCHIVE_TYPE",
      `${type} должен отклоняться как неизвестный тип`
    );
  }
});

test("активные желания грузятся страницами после 200, а не после 10", async () => {
  const { db } = makeMockDb(230);
  const result = await archivePage({ DB: db }, { id: 1 }, "wishes", 0);
  deepStrictEqual(result.items.map((r) => r.id), Array.from({ length: ARCHIVE_PAGE_SIZE }, (_, i) => STATE_ACTIVE_LIMIT + 1 + i));
  deepStrictEqual(result.hasMore, true);
  // Страница за концом набора пуста.
  const tail = await archivePage({ DB: db }, { id: 1 }, "wishes", 2);
  deepStrictEqual(tail.items, []);
  deepStrictEqual(tail.hasMore, false);
});

test("открытые планы после 200 приходят в порядке дедлайна (как в state)", async () => {
  const rows = Array.from({ length: STATE_ACTIVE_LIMIT + 25 }, (_, i) => ({
    id: i + 1,
    day: `2026-${String((i % 12) + 1).padStart(2, "0")}-${String((i % 28) + 1).padStart(2, "0")}`,
    recurs: false
  }));
  const expected = [...rows].sort((a, b) => taskTargetMs(a, "UTC") - taskTargetMs(b, "UTC")).map((r) => r.id);
  const first = await archivePage({ DB: makeActiveDb(rows) }, { id: 1, timezone: "UTC" }, "tasks", 0);
  deepStrictEqual(first.items.map((r) => r.id), expected.slice(STATE_ACTIVE_LIMIT, STATE_ACTIVE_LIMIT + ARCHIVE_PAGE_SIZE));
  deepStrictEqual(first.hasMore, true); // 225 > 220
  const second = await archivePage({ DB: makeActiveDb(rows) }, { id: 1, timezone: "UTC" }, "tasks", 1);
  deepStrictEqual(second.items.map((r) => r.id), expected.slice(220, 225));
  deepStrictEqual(second.hasMore, false); // 225 > 240 нет
});

test("даты после 200 продолжают зональный порядок /api/state", async () => {
  const rows = Array.from({ length: STATE_ACTIVE_LIMIT + 3 }, (_, i) => ({
    id: i + 1,
    day: `202${i % 10}-${String((i % 12) + 1).padStart(2, "0")}-${String((i % 28) + 1).padStart(2, "0")}`,
    recurs: i % 4 === 0
  }));
  const expected = sortDateRows(rows, "UTC").map((r) => r.id);
  const result = await archivePage({ DB: makeActiveDb(rows) }, { id: 1, timezone: "UTC" }, "dates", 0);
  deepStrictEqual(result.items.map((r) => r.id), expected.slice(STATE_ACTIVE_LIMIT, STATE_ACTIVE_LIMIT + ARCHIVE_PAGE_SIZE));
  deepStrictEqual(result.items.length, 3);
  deepStrictEqual(result.hasMore, false);
});

test("archivePage отдаёт remaining — счётчик кнопки «Показать ещё»", async () => {
  // SQL-путь (memories): COUNT в моке равен total.
  const { db } = makeMockDb();
  const first = await archivePage({ DB: db }, { id: 1, timezone: "UTC" }, "memories", 0);
  equal(first.remaining, 20); // 50 записей, показано 10 + 20 → осталось 20
  equal(first.hasMore, true);
  const last = await archivePage({ DB: db }, { id: 1, timezone: "UTC" }, "memories", 1);
  equal(last.remaining, 0);
  equal(last.hasMore, false);
  // Sort-путь (tasks): остаток считается по уже загруженному набору.
  const rows = Array.from({ length: 225 }, (_, i) => ({ id: i + 1, day: "", time: "" }));
  const page = await archivePage({ DB: makeActiveDb(rows) }, { id: 1, timezone: "UTC" }, "tasks", 0);
  equal(page.remaining, 5); // 225 - 220 (200 база + 20 страница)
  equal(page.hasMore, true);
});

// ------------------------------------------------------------------
// Новые типы архива: кино, цитаты, места, трипы, цели, копилки.
// state() отдаёт первые 200 — страницы архива продолжают список от 200-й.

test("шесть новых типов грузятся страницами после 200 (как активные)", async () => {
  for (const type of ["movies", "quotes", "places", "trips", "savings", "goals"]) {
    const { db } = makeMockDb(STATE_ACTIVE_LIMIT + 5);
    const page = await archivePage({ DB: db }, { id: 1, timezone: "UTC" }, type, 0);
    deepStrictEqual(page.items.map((r) => r.id), [201, 202, 203, 204, 205], `${type}: неверный офсет`);
    equal(page.hasMore, false, `${type}: лишняя страница`);
    equal(page.remaining, 0, `${type}: неверный remaining`);
  }
});

test("цели из архива приходят с приклеенными пунктами", async () => {
  const goalRows = Array.from({ length: 3 }, (_, i) => ({
    id: 201 + i, title: `Цель ${i + 1}`, is_private: 0, created_by: 1, created_at: 1700000000 + i
  }));
  const itemRows = [
    { id: 1, goal_id: 201, title: "Шаг 1", done: 0, created_at: 1 },
    { id: 2, goal_id: 201, title: "Шаг 2", done: 1, created_at: 2 },
    { id: 3, goal_id: 203, title: "Шаг A", done: 0, created_at: 3 }
  ];
  const db = {
    prepare(sql) {
      return {
        bind(...params) {
          const placeholders = (sql.match(/\?/g) || []).length;
          if (placeholders !== params.length) throw new Error(`bind ${params.length} != ${placeholders}`);
          return {
            async all() {
              if (sql.includes("FROM goals")) return { results: goalRows };
              if (sql.includes("FROM goal_items")) return { results: itemRows };
              return { results: [] };
            },
            async first() { return { n: 203 }; }
          };
        }
      };
    }
  };
  const page = await archivePage({ DB: db }, { id: 1, timezone: "UTC" }, "goals", 0);
  deepStrictEqual(page.items.map((g) => g.id), [201, 202, 203]);
  deepStrictEqual(page.items[0].items.map((i) => i.title), ["Шаг 1", "Шаг 2"], "пункты цели 201 не приклеились");
  deepStrictEqual(page.items[1].items, [], "цель 202 получила чужие пункты");
  deepStrictEqual(page.items[2].items.map((i) => i.title), ["Шаг A"], "пункты цели 203 не приклеились");
});

test("фильмы из архива приходят с полями RAofP", async () => {
  const { db } = makeMockDb(STATE_ACTIVE_LIMIT + 2);
  const page = await archivePage({ DB: db }, { id: 1, timezone: "UTC" }, "movies", 0);
  // В моке голосов нет: поля приклеены пустыми — форма карточки как у state().
  ok("my_rating" in page.items[0], "нет my_rating");
  ok("pair_rating" in page.items[0], "нет pair_rating");
  equal(page.items[0].my_rating, null);
  equal(page.items[0].pair_rating, null);
});

// ------------------------------------------------------------------
// BUG-05: догрузка архива обязана сохранять личные имена авторов — те же
// подстановки, что state() делает для первых записей. Без helper'а
// «Показать ещё» откатывал display_name к сырому имени из Telegram.

const AUTHOR_FIELD = { memories: "author_id", quotes: "author_id", wishes: "owner_id", done_wishes: "owner_id" };
const rowsFor = (type) => [
  { id: 1, [AUTHOR_FIELD[type]]: 1, display_name: "АняТГ" },
  { id: 2, [AUTHOR_FIELD[type]]: 2, display_name: "БоряТГ" },
  // Автор вне пары: личные имена не применяются, сырой display_name остаётся.
  { id: 3, [AUTHOR_FIELD[type]]: 99, display_name: "ЧужойТГ" }
];
const dbReturning = (rows) => ({
  DB: {
    prepare() {
      return {
        bind() {
          return {
            async all() { return { results: rows }; },
            async first() { return { n: rows.length }; }
          };
        }
      };
    }
  }
});

test("архив применяет личные имена авторов как state(): оба участника, все типы", async () => {
  for (const type of ["memories", "quotes", "wishes", "done_wishes"]) {
    const pair = { id: 1, role: "a", user_a: 1, user_b: 2 };
    // Зритель — user_a: свой custom_name на свои записи, partner_custom_name
    // на записи партнёра (user_b).
    const userA = { tg_id: 1, partner_custom_name: "БоряЛичное", custom_name: "АняЛичная" };
    const pageA = await archivePage(dbReturning(rowsFor(type)), pair, type, 0, userA);
    equal(pageA.items[0].display_name, "АняЛичная", `${type}: своё имя не подставлено`);
    equal(pageA.items[1].display_name, "БоряЛичное", `${type}: имя партнёра не подставлено`);
    equal(pageA.items[2].display_name, "ЧужойТГ", `${type}: имя постороннего затёрто`);

    // Зритель — user_b: зеркально.
    const pairB = { id: 1, role: "b", user_a: 1, user_b: 2 };
    const userB = { tg_id: 2, partner_custom_name: "АняЛичноеB", custom_name: "БоряЛичноеB" };
    const pageB = await archivePage(dbReturning(rowsFor(type)), pairB, type, 0, userB);
    equal(pageB.items[0].display_name, "АняЛичноеB", `${type}: имя партнёра (user_b-view) не подставлено`);
    equal(pageB.items[1].display_name, "БоряЛичноеB", `${type}: своё имя (user_b-view) не подставлено`);
    equal(pageB.items[2].display_name, "ЧужойТГ", `${type}: чужое имя затёрто (user_b-view)`);
  }
});

test("архив без личных имён оставляет сырой display_name", async () => {
  for (const type of ["memories", "quotes", "wishes", "done_wishes"]) {
    const pair = { id: 1, role: "a", user_a: 1, user_b: 2 };
    const page = await archivePage(dbReturning(rowsFor(type)), pair, type, 0, { tg_id: 1 });
    deepStrictEqual(page.items.map((r) => r.display_name), ["АняТГ", "БоряТГ", "ЧужойТГ"], type);
  }
});

test("архив со старым вызовом (голый tg_id) не падает и не подменяет имена", async () => {
  const page = await archivePage(dbReturning(rowsFor("memories")), { id: 1 }, "memories", 0, 1);
  deepStrictEqual(page.items.map((r) => r.display_name), ["АняТГ", "БоряТГ", "ЧужойТГ"]);
});

test("приватность savings/goals в архиве фильтруется в SQL", () => {
  ok(/savings: \{\s*\n\s*active: true,\s*\n\s*userScoped: true/.test(source), "savings без userScoped");
  ok(/goals: \{\s*\n\s*active: true,\s*\n\s*userScoped: true/.test(source), "goals без userScoped");
  ok(source.includes("SELECT COUNT(*) AS n FROM savings WHERE pair_id=? AND (kind='shared' OR created_by=?)"), "COUNT savings без фильтра видимости");
  ok(source.includes("SELECT COUNT(*) AS n FROM goals WHERE pair_id=? AND (is_private=0 OR created_by=?)"), "COUNT goals без фильтра видимости");
});
