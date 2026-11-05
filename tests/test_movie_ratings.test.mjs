// Оценки пары (RAofP): обязательная оценка при «Просмотрено», отдельная
// кнопка «Оценить» для второго партнёра и среднее в state.
//
// itemRoute извлекается из worker.js как есть; D1 подменяется моком.
//
// Запуск: node --test tests/test_movie_ratings.test.mjs
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
    else if (source[j] === "}" && --depth === 0) return source.slice(start, j + 1);
  }
  throw new Error(`незакрытая декларация: ${declaration}`);
}

function extractLine(prefix) {
  const start = source.indexOf(prefix);
  if (start === -1) throw new Error(`${prefix} не найдено`);
  return source.slice(start, source.indexOf("\n", start));
}

const itemRoute = new Function(
  "now",
  [
    extractLine("const positiveId = "),
    extractBraced("class HttpError"),
    extractBraced("function movieRatingValue"),
    extractBraced("async function itemRoute"),
    "return itemRoute;"
  ].join("\n")
)(() => 1700000000);

const PAIR = { id: 3 };
const USER = { tg_id: 777 };

// Мок D1: SELECT id,watched FROM movies отдаёт строку фильма, остальные
// запросы пишутся в calls (batch выполняет их по порядку).
function makeMovieDb({ movie = { id: 5, watched: 0 } } = {}) {
  const calls = [];
  const db = {
    prepare(sql) {
      const stmt = {
        sql,
        args: [],
        bind(...args) {
          stmt.args = args;
          return stmt;
        },
        async first() {
          return sql.startsWith("SELECT id,watched FROM movies") ? movie : null;
        },
        async run() {
          calls.push({ sql, args: stmt.args });
          return { meta: { changes: 1 } };
        }
      };
      return stmt;
    },
    async batch(statements) {
      return Promise.all(statements.map((stmt) => stmt.run()));
    }
  };
  return { db, calls };
}

test("«Просмотрено» требует оценку и пишет её вместе с watched", async () => {
  const { db, calls } = makeMovieDb();
  equal(await itemRoute({ DB: db }, PAIR, USER, "POST", "/api/movies/5/watched", { rating: 8 }), true);
  equal(calls.length, 2);
  ok(calls[0].sql.includes("INSERT INTO movie_ratings"), "оценка не записана");
  deepStrictEqual(calls[0].args, [5, 777, 8, 1700000000, 1700000000]);
  ok(calls[1].sql.startsWith("UPDATE movies SET watched=1"), "фильм не отмечен просмотренным");
  deepStrictEqual(calls[1].args, [1700000000, 777, 5, 3]);
});

test("«Просмотрено» без оценки — 400, карточка не меняется", async () => {
  for (const body of [{}, { rating: null }, { rating: 0 }, { rating: 11 }, { rating: 4.5 }, { rating: "8" }]) {
    const { db, calls } = makeMovieDb();
    await rejects(
      itemRoute({ DB: db }, PAIR, USER, "POST", "/api/movies/5/watched", body),
      (error) => error.status === 400 && error.code === "INVALID_RATING"
    );
    equal(calls.length, 0, `запись при ${JSON.stringify(body)}`);
  }
});

test("«Оценить» на непросмотренном фильме — 409", async () => {
  const { db, calls } = makeMovieDb({ movie: { id: 5, watched: 0 } });
  await rejects(
    itemRoute({ DB: db }, PAIR, USER, "POST", "/api/movies/5/rate", { rating: 9 }),
    (error) => error.status === 409 && error.code === "MOVIE_NOT_WATCHED"
  );
  equal(calls.length, 0);
});

test("«Оценить» на просмотренном — upsert оценки второго партнёра", async () => {
  const { db, calls } = makeMovieDb({ movie: { id: 5, watched: 1 } });
  equal(await itemRoute({ DB: db }, PAIR, USER, "POST", "/api/movies/5/rate", { rating: 9 }), true);
  equal(calls.length, 1);
  ok(calls[0].sql.includes("ON CONFLICT(movie_id,tg_id) DO UPDATE"), "нет upsert");
  deepStrictEqual(calls[0].args, [5, 777, 9, 1700000000, 1700000000]);
});

test("возврат в «Хотим посмотреть» сбрасывает оценки", async () => {
  const { db, calls } = makeMovieDb({ movie: { id: 5, watched: 1 } });
  equal(await itemRoute({ DB: db }, PAIR, USER, "POST", "/api/movies/5/unwatched", {}), true);
  equal(calls.length, 2);
  ok(calls[0].sql.startsWith("DELETE FROM movie_ratings"), "оценки не удалены");
  ok(calls[1].sql.startsWith("UPDATE movies SET watched=0"), "фильм не вернулся в список");
});

test("возврат уже открытого фильма — 409", async () => {
  const { db } = makeMovieDb({ movie: { id: 5, watched: 0 } });
  await rejects(
    itemRoute({ DB: db }, PAIR, USER, "POST", "/api/movies/5/unwatched", {}),
    (error) => error.status === 409 && error.code === "NO_CHANGE"
  );
});

test("несуществующий фильм — 404 на любом действии", async () => {
  for (const action of ["watched", "rate", "unwatched"]) {
    const { db } = makeMovieDb({ movie: null });
    await rejects(
      itemRoute({ DB: db }, PAIR, USER, "POST", `/api/movies/5/${action}`, { rating: 8 }),
      (error) => error.status === 404 && error.code === "NOT_FOUND"
    );
  }
});

test("attachMovieRatings: RAofP — среднее обоих голосов, my_rating — свой", () => {
  const attachMovieRatings = new Function(`${extractBraced("function attachMovieRatings")}\nreturn attachMovieRatings;`)();
  const ratings = [
    { movie_id: 1, tg_id: 777, rating: 8 },
    { movie_id: 1, tg_id: 999, rating: 6 }
  ];
  const mine = [{ id: 1 }, { id: 2 }];
  attachMovieRatings(mine, ratings, 777);
  deepStrictEqual(mine[0], { id: 1, my_rating: 8, pair_rating: 7 });
  deepStrictEqual(mine[1], { id: 2, my_rating: null, pair_rating: null });

  const partner = [{ id: 1 }];
  attachMovieRatings(partner, ratings, 999);
  deepStrictEqual(partner[0], { id: 1, my_rating: 6, pair_rating: 7 });
});

test("attachMovieRatings: один голос — RAofP равен ему", () => {
  const attachMovieRatings = new Function(`${extractBraced("function attachMovieRatings")}\nreturn attachMovieRatings;`)();
  const movies = [{ id: 1 }];
  attachMovieRatings(movies, [{ movie_id: 1, tg_id: 777, rating: 9 }], 999);
  deepStrictEqual(movies[0], { id: 1, my_rating: null, pair_rating: 9 });
});

test("маршрут rate зарегистрирован, таблица и миграция на месте", () => {
  ok(source.includes("watched|unwatched|rate|deposit"), "rate нет в regex itemRoute");
  ok(source.includes("CREATE TABLE IF NOT EXISTS movie_ratings"), "нет таблицы movie_ratings");
  ok(source.includes("idx_movie_ratings_movie"), "нет индекса оценок");
  const migration = readFileSync(join(root, "migrations", "0022_movie_ratings.sql"), "utf8");
  ok(migration.includes("CREATE TABLE IF NOT EXISTS movie_ratings"), "миграция 0022 без таблицы");
});
