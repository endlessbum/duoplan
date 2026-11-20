// Регрессия на сдвиг Promise.all в state() (репорт 2026-11-20: «пропали
// цитаты и дни рождения»). PD-WISHES-001 вставил запрос личных желаний
// седьмым в массив Promise.all, а порядок деструктуризации не обновили:
// quotes получал личные желания, birthdays — просмотренные фильмы, movies —
// места, savings — рейтинги, privateWishes — дни рождения. Тот же класс
// бага, что и сдвиг goals/savings 2026-11-11.
//
// Две защиты:
// 1) структурная: имён в деструктуризации ровно столько же, сколько
//    env.DB.prepare() в массиве Promise.all (ловит ЛЮБОЕ будущее
//    добавление/удаление запроса без правки деструктуризации);
// 2) поведенческая: мок D1 возвращает на каждый SQL свой маркер, и каждый
//    ключ state обязан содержать маркер именно СВОЕГО запроса.
//
// Запуск: node --test tests/test_state_query_order.test.mjs
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

function extractLine(prefix) {
  const start = source.indexOf(prefix);
  if (start === -1) throw new Error(`${prefix} не найдено`);
  return source.slice(start, source.indexOf("\n", start));
}

// ---------- Структурная защита: имена == запросы ----------

const stateBody = extractBraced("async function state");
const destructureStart = stateBody.indexOf("const [");
const destructureEnd = stateBody.indexOf("= await Promise.all([");
ok(destructureStart > -1 && destructureEnd > destructureStart, "не найдена деструктуризация Promise.all в state()");
const namesBlock = stateBody.slice(destructureStart + 7, destructureEnd);
const names = namesBlock.split(",").map((n) => n.trim().replace(/^\[/, "").replace(/\]$/, "")).filter(Boolean);
const arrayBlock = stateBody.slice(destructureEnd, stateBody.indexOf("]);", destructureEnd));
// Число ЭЛЕМЕНТОВ массива (не только prepare: dailyFor/`null`-ветки тоже
// занимают позицию деструктуризации). Строки SQL содержат скобки и кавычки —
// делим по запятым верхнего уровня с учётом строковых литералов.
function countArrayEntries(block) {
  const inner = block.slice(block.indexOf("([") + 2);
  let depth = 0, quote = null, entries = 1, escape = false;
  for (let i = 0; i < inner.length; i++) {
    const ch = inner[i];
    if (quote) {
      if (escape) { escape = false; continue; }
      if (ch === "\\") { escape = true; continue; }
      if (ch === quote) quote = null;
      continue;
    }
    // Комментарии вне строк пропускаем целиком: в русском тексте есть запятые.
    if (ch === "/" && inner[i + 1] === "/") {
      while (i < inner.length && inner[i] !== "\n") i++;
      continue;
    }
    if (ch === "'" || ch === '"' || ch === "`") { quote = ch; continue; }
    if (ch === "(" || ch === "{" || ch === "[") depth++;
    else if (ch === ")" || ch === "}" || ch === "]") depth--;
    else if (ch === "," && depth === 0) entries++;
    else if (ch === ")" && depth < 0) break;
  }
  return entries;
}
const entries = countArrayEntries(arrayBlock);

test("state(): число имён в деструктуризации равно числу элементов Promise.all", () => {
  ok(names.length >= 15, `деструктуризация подозрительно мала: [${namesBlock}]`);
  equal(names.length, entries,
    `порядок деструктуризации [${names.join(", ")}] не соответствует ${entries} элементам Promise.all — результат одного запроса уйдёт в чужой ключ`);
});

// ---------- Поведенческая защита: свой маркер в своём ключе ----------

const constsStart = source.indexOf("const STATE_ACTIVE_LIMIT");
const constsEnd = source.indexOf("const schemaReady");
if (constsStart === -1 || constsEnd === -1 || constsEnd < constsStart) {
  throw new Error("не найден блок констант лимитов");
}

const load = new Function(
  `${source.slice(constsStart, constsEnd)}\n` +
  [
    'const DEFAULT_TZ = "Europe/Moscow";',
    extractLine("const clean = "),
    extractBraced("class HttpError"),
    extractBraced("function validTimeZone"),
    extractBraced("function localDay"),
    extractBraced("function byRowId"),
    extractLine("const dateTimeFormatCache = new Map();"),
    extractBraced("function cachedFormatter"),
    extractBraced("function timeZoneOffsetMs"),
    extractBraced("function makeDateInTimeZone"),
    extractBraced("function taskTargetMs"),
    extractBraced("function sortByTaskDeadline"),
    extractBraced("function monthlyOccursOnDay"),
    extractBraced("function nextMonthlyOccurrenceMs"),
    extractBraced("function nextDateOccurrence"),
    extractBraced("function isPastDate"),
    extractBraced("function sortDateRows"),
    extractBraced("function displayStreak"),
    extractBraced("function publicUser"),
    extractBraced("function withPartnerOverride"),
    extractBraced("async function membership"),
    extractBraced("function attachMovieRatings"),
    extractBraced("async function movieGroupSummaries"),
    extractLine("const AUTHOR_NAME_TYPES"),
    extractBraced("function applyAuthorNameOverrides"),
    extractBraced("async function state")
  ].join("\n") +
  "\nreturn { state };"
);
const { state } = load();

const TZ = "Europe/Moscow";
const USER_ID = 777;
const PAIR = {
  id: 1, role: "a", user_a: USER_ID, user_b: 0, code: "ABC123",
  name1: "Один", name2: "", started_at: "2026-01-01", together_pts: 0,
  timezone: TZ, owner_name: "Один", partner_name: ""
};

// Маркированные строки: каждая по форме своего SELECT, marker — якорь теста.
const ROWS = {
  task_open: [{ id: 1, title: "P", marker: "TASK_OPEN", status: "open", day: "2030-01-01", time: "12:00", monthly: 0, yearly: 0, is_private: 0, created_by: USER_ID, created_at: 5 }],
  task_done: [{ id: 2, title: "P", marker: "TASK_DONE", status: "done", day: null, time: null, monthly: 0, yearly: 0, is_private: 0, created_by: USER_ID, created_at: 4, completed_at: 3 }],
  date_date: [{ id: 3, title: "P", marker: "DATE_DATE", kind: "date", day: "2030-02-01", time: null, recurs: 1, monthly: 0, is_private: 0, created_by: USER_ID, created_at: 3 }],
  date_bday: [{ id: 4, title: "P", marker: "DATE_BDAY", kind: "birthday", day: "2030-03-01", time: null, recurs: 1, monthly: 0, is_private: 0, created_by: USER_ID, created_at: 2 }],
  memory: [{ id: 5, marker: "MEMORY", author_id: USER_ID, title: null, body: "B", ascii_art: null, day: "2026-11-20", created_at: 1, display_name: "Тест" }],
  wish_open: [{ id: 6, marker: "WISH_OPEN", body: "B", owner_id: USER_ID, created_at: 1, done_at: null, url: null, comment: null, is_private: 0, shared_at: null, display_name: "Тест" }],
  wish_done: [{ id: 7, marker: "WISH_DONE", body: "B", owner_id: USER_ID, created_at: 1, done_at: 2, url: null, comment: null, is_private: 0, shared_at: null, display_name: "Тест" }],
  wish_priv: [{ id: 8, marker: "WISH_PRIV", body: "B", owner_id: USER_ID, created_at: 1, done_at: null, url: null, comment: null, is_private: 1, shared_at: null, display_name: "Тест" }],
  quote: [{ id: 9, marker: "QUOTE", body: "B", source: null, author_id: USER_ID, created_at: 1, display_name: "Тест" }],
  place: [{ id: 10, title: "P", marker: "PLACE", note: null, url: null, visited: 0, visited_at: null, visited_by: null, created_by: USER_ID, created_at: 1 }],
  trip: [{ id: 11, title: "P", marker: "TRIP", note: null, visited: 0, visited_at: null, visited_by: null, created_by: USER_ID, created_at: 1, saving_id: null }],
  movie_open: [{ id: 12, title: "P", marker: "MOVIE_OPEN", imdb_id: "tt1", year: 2020, kind: "movie", rating: null, rating_source: null, rating_checked_at: null, genres: null, runtime: 90, seasons: null, episodes: null, url: null, watched: 0, watched_at: null, watched_by: null, resume_position: null, created_by: USER_ID, created_at: 1, group_id: null, group_position: null }],
  movie_done: [{ id: 13, title: "P", marker: "MOVIE_DONE", imdb_id: "tt2", year: 2021, kind: "movie", rating: null, rating_source: null, rating_checked_at: null, genres: null, runtime: 90, seasons: null, episodes: null, url: null, watched: 1, watched_at: 2, watched_by: USER_ID, resume_position: null, created_by: USER_ID, created_at: 1, group_id: null, group_position: null }],
  rating: [{ id: 14, marker: "RATING", movie_id: 12, tg_id: USER_ID, rating: 8 }],
  saving: [{ id: 15, marker: "SAVING", created_by: USER_ID, kind: "shared", title: "P", target: 100, collected: 10, created_at: 1 }],
  goal_open: [{ id: 16, marker: "GOAL_OPEN", title: "P", is_private: 0, created_by: USER_ID, created_at: 1 }],
  goal_item: [{ id: 17, marker: "GOAL_ITEM", goal_id: 16, title: "P", done: 0, done_at: null, done_by: null, created_at: 1 }],
  goal_done: [{ id: 18, marker: "GOAL_DONE", title: "P", is_private: 0, created_by: USER_ID, created_at: 1, completed_at: 2 }]
};

function pick(sql) {
  if (sql.includes("FROM pair_members")) return [PAIR];
  if (sql.includes("FROM users WHERE tg_id=?")) return [{ tg_id: USER_ID, display_name: "Тест", gender: "female", points: 0, accent_color: null }];
  if (sql.includes("status='open'")) return ROWS.task_open;
  if (sql.includes("status='done'")) return ROWS.task_done;
  if (sql.includes("kind='date'")) return ROWS.date_date;
  if (sql.includes("kind='birthday'")) return ROWS.date_bday;
  if (sql.includes("FROM memories")) return ROWS.memory;
  if (sql.includes("w.is_private=1")) return ROWS.wish_priv;
  if (sql.includes("w.done=1")) return ROWS.wish_done;
  if (sql.includes("FROM wishes")) return ROWS.wish_open;
  if (sql.includes("FROM quotes")) return ROWS.quote;
  if (sql.includes("FROM places")) return ROWS.place;
  if (sql.includes("FROM trips")) return ROWS.trip;
  if (sql.includes("m.watched=1")) return ROWS.movie_done;
  if (sql.includes("m.watched=0")) return ROWS.movie_open;
  if (sql.includes("FROM movie_ratings")) return ROWS.rating;
  if (sql.includes("FROM savings")) return ROWS.saving;
  if (sql.includes("EXISTS (SELECT 1 FROM goal_items")) return ROWS.goal_open;
  if (sql.includes("FROM goal_items")) return ROWS.goal_item;
  if (sql.includes("GROUP BY g.id HAVING")) return ROWS.goal_done;
  return [];
}

function makeDb() {
  return {
    prepare(sql) {
      return {
        bind() {
          return {
            all: async () => ({ results: [...pick(sql)] }),
            first: async () => pick(sql)[0] ?? null
          };
        }
      };
    }
  };
}

// Имя ключа state → маркер его собственного запроса.
const EXPECT = [
  ["tasks", "TASK_OPEN"],
  ["completedTasks", "TASK_DONE"],
  ["dates", "DATE_DATE"],
  ["birthdays", "DATE_BDAY"],
  ["memories", "MEMORY"],
  ["wishes", "WISH_OPEN"],
  ["completedWishes", "WISH_DONE"],
  ["privateWishes", "WISH_PRIV"],
  ["quotes", "QUOTE"],
  ["places", "PLACE"],
  ["trips", "TRIP"],
  ["movies", "MOVIE_OPEN"],
  ["completedMovies", "MOVIE_DONE"],
  ["savings", "SAVING"],
  ["goals", "GOAL_OPEN"],
  ["completedGoals", "GOAL_DONE"]
];

test("state(): каждый ключ получает результат именно своего запроса", async () => {
  const env = { DB: makeDb() };
  const resp = await state(env, USER_ID);
  for (const [key, marker] of EXPECT) {
    ok(Array.isArray(resp[key]), `ключ ${key} отсутствует или не массив`);
    const markers = resp[key].map((x) => x.marker);
    ok(markers.includes(marker),
      `${key} не содержит маркер ${marker} (получено: ${JSON.stringify(markers)}) — сдвиг Promise.all`);
    for (const m of markers) {
      equal(m, marker, `${key} содержит чужой маркер ${m} — запрос уехал в другой ключ`);
    }
  }
  // goalItems — не верхнеуровневый ключ: пункты вложены в цели.
  const goalItemMarkers = (resp.goals || []).flatMap((g) => (g.items || []).map((x) => x.marker));
  ok(goalItemMarkers.includes("GOAL_ITEM"), `goals[].items не содержит GOAL_ITEM (${JSON.stringify(goalItemMarkers)})`);
  for (const m of goalItemMarkers) {
    equal(m, "GOAL_ITEM", `goals[].items содержит чужой маркер ${m}`);
  }
  deepStrictEqual(names.sort(), EXPECT.map(([key]) => key).concat(["goalItems", "daily", "partnerUser", "stats", "movieRatings"]).sort(),
    "набор имён деструктуризации разошёлся с набором проверяемых ключей");
});
