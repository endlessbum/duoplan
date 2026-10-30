// Тест серверной пагинации архива (/api/archive в worker.js).
//
// archivePage извлекается из worker.js как есть вместе с константами лимитов
// и исполняется против мока D1, который режет строки по LIMIT/OFFSET.
//
// Запуск: node tests/test_archive.test.mjs  (или node --test "tests/*.test.mjs")
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { deepStrictEqual, equal, rejects } from "node:assert/strict";
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

// Константы лимитов между STATE_ACTIVE_LIMIT и schemaReady.
const constsStart = source.indexOf("const STATE_ACTIVE_LIMIT");
const constsEnd = source.indexOf("const schemaReady");
if (constsStart === -1 || constsEnd === -1 || constsEnd < constsStart) {
  throw new Error("не найден блок констант лимитов");
}
const consts = source.slice(constsStart, constsEnd);
const load = new Function(
  `const DEFAULT_TZ = "Europe/Moscow";\n${consts}\n${extractBraced("function validTimeZone")}\n${extractBraced("function localDay")}\n${extractBraced("function byRowId")}\n${extractBraced("function timeZoneOffsetMs")}\n${extractBraced("function makeDateInTimeZone")}\n${extractBraced("function nextDateOccurrence")}\n${extractBraced("function isPastDate")}\n${extractBraced("function sortDateRows")}\n${extractBraced("function taskTargetMs")}\n${extractBraced("function sortByTaskDeadline")}\n${extractBraced("class HttpError")}\n${extractBraced("const ARCHIVE_COUNT_SQL")}\n${extractBraced("async function archivePage")}\n` +
  "return { archivePage, taskTargetMs, sortDateRows, sortByTaskDeadline, STATE_RECENT_LIMIT, STATE_ACTIVE_LIMIT, ARCHIVE_PAGE_SIZE };");
const { archivePage, taskTargetMs, sortDateRows, sortByTaskDeadline, STATE_RECENT_LIMIT, STATE_ACTIVE_LIMIT, ARCHIVE_PAGE_SIZE } = load();

const TOTAL = 50; // 10 последних в /api/state, остальные 40 — архив

function makeMockDb(total = TOTAL) {
  const db = {
    prepare(_sql) {
      return {
        bind(...params) {
          const [, limit, offset] = params;
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
