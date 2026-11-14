// Окно «Ваша история»: итоги пары — записи, выполненные планы, часы кино,
// накопленные средства, путешествия.
//
// Считает сервер: в /api/state приходит только 10 недавних записей, счёт
// с клиента врал бы. Нулевые строки окно не показывает — «Путешествий: 0»
// только мозолит глаза.
//
// Запуск: node --test tests/test_history_stats.test.mjs
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { deepStrictEqual, equal, ok } from "node:assert/strict";
import { test } from "node:test";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const workerSource = readFileSync(join(root, "worker.js"), "utf8");
const appSource = readFileSync(join(root, "public", "app.js"), "utf8");

function extractBraced(text, declaration) {
  const start = text.indexOf(declaration);
  if (start === -1) throw new Error(`${declaration} не найдено`);
  let depth = 0;
  for (let j = text.indexOf("{", start); j < text.length; j++) {
    if (text[j] === "{") depth++;
    else if (text[j] === "}") {
      depth--;
      if (depth === 0) return text.slice(start, j + 1);
    }
  }
  throw new Error(`незакрытый блок: ${declaration}`);
}

function extractLine(text, prefix) {
  const start = text.indexOf(prefix);
  if (start === -1) throw new Error(`${prefix} не найдено`);
  return text.slice(start, text.indexOf("\n", start));
}

// ---------------------------------------------------------------- клиент ----
const loadClient = new Function(
  [
    "let appState = { stats: {} };",
    "const esc = (v) => String(v ?? '').replace(/[&<>\"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '\"': '&quot;', \"'\": '&#39;' }[ch]));",
    extractBraced(appSource, "function formatAmount"),
    extractBraced(appSource, "function formatWatchedTime"),
    extractBraced(appSource, "function historyStatsRows"),
    "return { historyStatsRows, formatWatchedTime, setStats: (stats) => { appState = { stats }; } };"
  ].join("\n")
);
const { historyStatsRows, formatWatchedTime, setStats } = loadClient();

function rowsOf(stats) {
  setStats(stats);
  return historyStatsRows()
    .split("\n")
    .map(line => line.trim())
    .filter(Boolean)
    .map(line => line.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim());
}

test("окно истории показывает все пять итогов пары", () => {
  const rows = rowsOf({ memories: 12, doneTasks: 5, watchedMinutes: 1020, saved: 100000, trips: 3 });
  ok(rows.some(r => r.includes("Записей в дневнике") && r.includes("12")), "нет числа записей");
  ok(rows.some(r => r.includes("Планов выполнено") && r.includes("5")), "нет числа выполненных планов");
  ok(rows.some(r => r.includes("Просмотрено кино") && r.includes("17 ч")), "нет часов кино");
  ok(rows.some(r => r.includes("Накоплено") && r.includes("100") && r.includes("₽")), "нет суммы накопленного");
  ok(rows.some(r => r.includes("Путешествий") && r.includes("3")), "нет числа путешествий");
});

test("нулевые итоги не показываются", () => {
  const rows = rowsOf({ memories: 0, doneTasks: 0, watchedMinutes: 0, saved: 0, trips: 0 });
  equal(rows.length, 0, "пустое окно должно остаться пустым");
  const partial = rowsOf({ memories: 4, doneTasks: 0, watchedMinutes: 0, saved: 0, trips: 0 });
  equal(partial.length, 1, "показан только непустой итог");
  ok(!partial[0].includes("Путешествий"), "пустой итог просочился в окно");
});

test("итоги без stats (старый ответ сервера) не ломают окно", () => {
  const rows = rowsOf(undefined);
  equal(rows.length, 0);
});

test("часы просмотра: минуты → «ч» и «мин»", () => {
  equal(formatWatchedTime(1020), "17 ч");
  equal(formatWatchedTime(125), "2 ч 5 мин");
  equal(formatWatchedTime(45), "45 мин");
  equal(formatWatchedTime(0), "");
});

// ---------------------------------------------------------------- сервер ----
test("итоги считаются по всей базе, а не по обрезанному state", () => {
  ok(/FROM memories WHERE pair_id=\?\) AS memories/.test(workerSource), "нет счётчика записей");
  ok(/FROM tasks WHERE pair_id=\? AND status='done' AND \(is_private=0 OR created_by=\?\)\) AS done_tasks/.test(workerSource),
    "нет счётчика выполненных планов с фильтром личных");
  ok(/FROM trips WHERE pair_id=\?\) AS trips/.test(workerSource), "нет счётчика путешествий");
  ok(/FROM savings WHERE pair_id=\? AND kind='shared'\) AS saved/.test(workerSource), "нет суммы по общим копилкам");
  ok(/FROM movies WHERE pair_id=\? AND watched=1 AND runtime>0\) AS watched_minutes/.test(workerSource),
    "нет суммы минут по просмотренному кино");
});

test("сериал считается по всем сериям, фильм — по хронометражу", () => {
  ok(/runtime \* \(CASE WHEN kind='series' AND episodes>0 THEN episodes ELSE 1 END\)/.test(workerSource),
    "длительность сериала не умножается на число серий");
});

test("state отдаёт блок итогов", () => {
  ok(/stats: \{/.test(workerSource), "в state нет блока stats");
  for (const key of ["memories", "doneTasks", "trips", "saved", "watchedMinutes"]) {
    ok(workerSource.includes(`${key}: Number(stats?.`), `нет поля ${key}`);
  }
});

// --------------------------------------------------- state через мок D1 ----
const PAIR = { id: 7, role: "a", user_a: 777, user_b: 888, code: "ABC123", name1: "Один", name2: "Два", started_at: "2026-01-01", timezone: "Europe/Moscow" };
const USER_ID = 777;

const stateFn = new Function(
  "PAIR",
  [
    "const STATE_ACTIVE_LIMIT = 200;",
    "const STATE_RECENT_LIMIT = 10;",
    "const membership = async () => PAIR;",
    "const publicUser = (u) => ({ tg_id: u.tg_id, points: 0, best_streak: 0, gender: 'female' });",
    "const sortByTaskDeadline = (rows) => rows;",
    "const sortDateRows = (rows) => rows;",
    "const attachMovieRatings = () => {};",
    "const applyAuthorNameOverrides = () => {};",
    "const withPartnerOverride = () => ({ name1: 'Один', name2: 'Два' });",
    "const dailyFor = async () => null;",
    extractBraced(workerSource, "async function state"),
    "return state;"
  ].join("\n")
)(PAIR);

// Мок D1: на запрос итогов отдаёт заданную строку и запоминает параметры.
function makeDb(statsRow) {
  const calls = [];
  return {
    calls,
    DB: {
      prepare(sql) {
        return {
          bind(...args) {
            if (sql.includes("AS memories")) calls.push(args);
            return {
              all: async () => ({ results: [] }),
              first: async () => {
                if (sql.includes("AS memories")) return statsRow;
                if (sql.includes("FROM users")) return { tg_id: USER_ID, display_name: "Тест", gender: "female", points: 0 };
                return null;
              }
            };
          }
        };
      }
    }
  };
}

test("state читает итоги из отдельного запроса и отдаёт их числами", async () => {
  const mock = makeDb({ memories: 12, done_tasks: 5, trips: 3, saved: 100000, watched_minutes: 1020 });
  const resp = await stateFn(mock, USER_ID);
  deepStrictEqual(resp.stats, {
    memories: 12, doneTasks: 5, trips: 3, saved: 100000, watchedMinutes: 1020
  });
  // Параметры запроса: pair_id, pair_id+автор (личные планы), pair_id ×3.
  deepStrictEqual(mock.calls[0], [PAIR.id, PAIR.id, USER_ID, PAIR.id, PAIR.id, PAIR.id]);
});

test("пустой ответ базы даёт нулевые итоги, а не NaN", async () => {
  const mock = makeDb(null);
  const resp = await stateFn(mock, USER_ID);
  deepStrictEqual(resp.stats, {
    memories: 0, doneTasks: 0, trips: 0, saved: 0, watchedMinutes: 0
  });
});
