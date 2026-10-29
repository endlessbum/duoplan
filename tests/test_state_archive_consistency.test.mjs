// Интеграционный тест согласованности /api/state и /api/archive (worker.js).
//
// Репорт 2026-10-29: state() ограничивал открытые планы/даты SQL-лимитом
// ДО сортировки по дедлайну, а архив сортировал полный набор и отрезал
// страницы с 200-й позиции — последовательности расходились: часть записей
// приходила дважды (клиент скрывал дубли), часть отсутствовала везде.
// Теперь обе выдачи строятся на одном полном наборе и одном хелпере сортировки.
//
// state() и archivePage() извлекаются из worker.js как есть и исполняются
// против ОДНОГО мока D1, который маршрутизирует запросы по SQL-подстрокам.
// dailyFor не достигается (в моке pair.user_b = 0), поэтому в моках не нуждается.
//
// Запуск: node tests/test_state_archive_consistency.test.mjs  (или node --test "tests/*.test.mjs")
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

const constsStart = source.indexOf("const STATE_ACTIVE_LIMIT");
const constsEnd = source.indexOf("const schemaReady");
if (constsStart === -1 || constsEnd === -1 || constsEnd < constsStart) {
  throw new Error("не найден блок констант лимитов");
}

const load = new Function(
  `${source.slice(constsStart, constsEnd)}\n` +
  [
    'const DEFAULT_TZ = "Europe/Moscow";',
    extractBraced("class HttpError"),
    extractBraced("function validTimeZone"),
    extractBraced("function localDay"),
    extractBraced("function byRowId"),
    extractBraced("function timeZoneOffsetMs"),
    extractBraced("function makeDateInTimeZone"),
    extractBraced("function taskTargetMs"),
    extractBraced("function sortByTaskDeadline"),
    extractBraced("function nextDateOccurrence"),
    extractBraced("function isPastDate"),
    extractBraced("function sortDateRows"),
    extractBraced("function displayStreak"),
    extractBraced("function publicUser"),
    extractBraced("async function membership"),
    extractBraced("async function state"),
    extractBraced("async function archivePage")
  ].join("\n") +
  "\nreturn { state, archivePage, STATE_ACTIVE_LIMIT, ARCHIVE_PAGE_SIZE };"
);
const { state, archivePage, STATE_ACTIVE_LIMIT, ARCHIVE_PAGE_SIZE } = load();

const TZ = "Europe/Moscow";
const USER_ID = 777;
const PAIR = {
  id: 1, role: "a", user_a: USER_ID, user_b: 0, code: "ABC123",
  name1: "Один", name2: "", started_at: "2026-01-01", together_pts: 0,
  timezone: TZ, owner_name: "Один", partner_name: ""
};

function makeDb({ openTasks = [], dates = [] } = {}) {
  const pick = (sql) => {
    if (sql.includes("FROM tasks WHERE pair_id=? AND status='open'")) return openTasks;
    if (sql.includes("FROM tasks WHERE pair_id=? AND status='done'")) return [];
    if (sql.includes("FROM dates WHERE pair_id=?")) return dates;
    if (sql.includes("FROM memories")) return [];
    if (sql.includes("w.done=1")) return [];
    if (sql.includes("FROM wishes")) return [];
    if (sql.includes("FROM users WHERE tg_id=?")) return [{ tg_id: USER_ID, display_name: "Тест", gender: "female", points: 0 }];
    if (sql.includes("FROM pair_members pm JOIN pairs")) return [PAIR];
    return [];
  };
  return {
    prepare(sql) {
      return {
        bind(...args) {
          return {
            all: async () => ({ results: [...pick(sql)] }),
            first: async () => pick(sql)[0] ?? null
          };
        }
      };
    }
  };
}

// day как UTC-дата со сдвигом: важен только относительный порядок строк day.
function dayFromToday(offsetDays) {
  const d = new Date(Date.now() + offsetDays * 86400000);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}`;
}

// Собирает state + все страницы архива и возвращает сводку: множество id,
// дубли и число страниц. pair — объект membership для archivePage.
async function collect(env, pair, type, stateList) {
  const seen = new Set(stateList.map((r) => r.id));
  const duplicates = [];
  let page = 0;
  let hasMore = true;
  while (hasMore && page < 100) {
    const result = await archivePage(env, pair, type, page++);
    for (const item of result.items) {
      if (seen.has(item.id)) duplicates.push(item.id);
      seen.add(item.id);
    }
    hasMore = result.hasMore;
  }
  return { seen, duplicates, pages: page };
}

function makePairObject() {
  return { id: PAIR.id, timezone: TZ };
}

test("репорт: 225 планов, 25 старых со срочными дедлайнами — ничего не потеряно и не задублировано", async () => {
  const openTasks = [];
  for (let id = 1; id <= 25; id++) {
    openTasks.push({ id, title: `Срочный ${id}`, status: "open", day: dayFromToday(id), time: "12:00", created_at: 100 - id });
  }
  for (let id = 26; id <= 225; id++) {
    openTasks.push({ id, title: `Дальний ${id}`, status: "open", day: dayFromToday(50 + (id - 26)), time: "12:00", created_at: 700 - (id - 26) });
  }
  const env = { DB: makeDb({ openTasks }) };
  const stateResp = await state(env, USER_ID);
  equal(stateResp.tasks.length, STATE_ACTIVE_LIMIT);
  // До фикса state() брал 200 самых свежих по created_at и терял ids 1–25.
  const stateIds = new Set(stateResp.tasks.map((t) => t.id));
  for (let id = 1; id <= 25; id++) equal(stateIds.has(id), true, `срочный план ${id} должен быть в state`);

  const { seen, duplicates, pages } = await collect(env, makePairObject(), "tasks", stateResp.tasks);
  deepStrictEqual(duplicates, []);
  equal(seen.size, 225);
  equal(pages, Math.ceil((225 - STATE_ACTIVE_LIMIT) / ARCHIVE_PAGE_SIZE));
});

test("даты: объединение state и всех страниц архива покрывает набор без дублей и пропусков", async () => {
  const dates = [];
  for (let id = 1; id <= 210; id++) {
    const recurs = id % 2 === 0 ? 1 : 0;
    dates.push({ id, title: `Дата ${id}`, day: recurs ? "2001-03-15" : dayFromToday(id - 300), time: null, recurs, created_at: id });
  }
  const env = { DB: makeDb({ dates }) };
  const stateResp = await state(env, USER_ID);
  equal(stateResp.dates.length, STATE_ACTIVE_LIMIT);

  const { seen, duplicates } = await collect(env, makePairObject(), "dates", stateResp.dates);
  deepStrictEqual(duplicates, []);
  equal(seen.size, 210);
});

test("равные дедлайны разбираются по id: порядок state и архива однозначный", async () => {
  const sameDay = dayFromToday(10);
  const openTasks = [];
  for (let id = 1; id <= 210; id++) {
    openTasks.push({ id, title: `План ${id}`, status: "open", day: sameDay, time: "12:00", created_at: 500 - id });
  }
  const env = { DB: makeDb({ openTasks }) };
  const stateResp = await state(env, USER_ID);
  deepStrictEqual(stateResp.tasks.map((t) => t.id), Array.from({ length: STATE_ACTIVE_LIMIT }, (_, i) => i + 1));

  const page0 = await archivePage(env, makePairObject(), "tasks", 0);
  deepStrictEqual(page0.items.map((t) => t.id), Array.from({ length: 10 }, (_, i) => STATE_ACTIVE_LIMIT + 1 + i));
  equal(page0.hasMore, false);
});
