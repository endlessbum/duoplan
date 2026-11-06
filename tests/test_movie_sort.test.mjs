// Сортировка списков «Кино»: критерии, направления, «нет данных — в конец».
// Функции извлекаются из app.js как есть; состояние movieSort подменяется.
//
// Запуск: node --test tests/test_movie_sort.test.mjs
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { deepStrictEqual, equal, ok } from "node:assert/strict";
import { test } from "node:test";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const source = readFileSync(join(root, "public", "app.js"), "utf8");

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

function loadSort(view, key, dir) {
  return new Function(
    "movieSort",
    [
      extractBraced("function byRowId"),
      extractBraced("function movieSortValue"),
      extractBraced("function sortMovies"),
      "return sortMovies;"
    ].join("\n")
  )({ [view]: { key, dir } });
}

function loadFilter(view, kind) {
  return new Function(
    "movieKindFilter",
    [
      extractBraced("function filterMoviesByKind"),
      "return filterMoviesByKind;"
    ].join("\n")
  )({ [view]: kind });
}

const MOVIES = [
  { id: 1, title: "Старый", year: 1994, kind: "movie", rating: 9.3, runtime: 142, genres: "Драма", created_at: 10, pair_rating: null },
  { id: 2, title: "Новый", year: 2023, kind: "movie", rating: 8.4, runtime: 181, genres: "Драма, История", created_at: 30, pair_rating: 8 },
  { id: 3, title: "Сериал", year: 2010, kind: "series", rating: 5.1, episodes: 177, genres: "Ужасы", created_at: 20, pair_rating: 7 }
];

test("год: по убыванию и возрастанию", () => {
  deepStrictEqual(loadSort("open", "year", "desc")(MOVIES, "open").map((m) => m.title), ["Новый", "Сериал", "Старый"]);
  deepStrictEqual(loadSort("open", "year", "asc")(MOVIES, "open").map((m) => m.title), ["Старый", "Сериал", "Новый"]);
});

test("оценка IMDb/TMDB: по убыванию и возрастанию", () => {
  deepStrictEqual(loadSort("open", "rating", "desc")(MOVIES, "open").map((m) => m.title), ["Старый", "Новый", "Сериал"]);
  deepStrictEqual(loadSort("open", "rating", "asc")(MOVIES, "open").map((m) => m.title), ["Сериал", "Новый", "Старый"]);
});

test("длительность: у фильма хронометраж, у сериала — число серий", () => {
  deepStrictEqual(loadSort("open", "runtime", "desc")(MOVIES, "open").map((m) => m.title), ["Новый", "Сериал", "Старый"]);
});

test("жанр: строковая сортировка, равные — по id", () => {
  const byGenre = loadSort("open", "genre", "asc")(MOVIES, "open").map((m) => m.title);
  deepStrictEqual(byGenre, ["Старый", "Новый", "Сериал"], "Драма раньше Ужасов, внутри — по id");
});

test("тип (фильм/сериал) — фильтр, а не критерий сортировки", () => {
  ok(!source.includes('["kind", "Фильм/сериал"]'), "«Фильм/сериал» остался в опциях сортировки");
  ok(!source.includes('if (key === "kind")'), "ветка kind осталась в movieSortValue");
  ok(source.includes('data-action="movie-filter-kind"'), "нет селекта фильтра типа");
  ok(source.includes('["series", "Сериалы"]'), "нет опции «Сериалы» у фильтра");

  const seriesOnly = loadFilter("open", "series")(MOVIES, "open").map((m) => m.title);
  deepStrictEqual(seriesOnly, ["Сериал"], "фильтр сериалов пропустил фильм");
  const moviesOnly = loadFilter("watched", "movie")(MOVIES, "watched").map((m) => m.title);
  deepStrictEqual(moviesOnly, ["Старый", "Новый"], "фильтр фильмов пропустил сериал");
  deepStrictEqual(loadFilter("open", "all")(MOVIES, "open"), MOVIES, "«Все» должен возвращать список как есть");
});

test("RAofP: по убыванию, без оценки — в конце", () => {
  deepStrictEqual(loadSort("watched", "raofp", "desc")(MOVIES, "watched").map((m) => m.title), ["Новый", "Сериал", "Старый"]);
  deepStrictEqual(loadSort("watched", "raofp", "asc")(MOVIES, "watched").map((m) => m.title), ["Сериал", "Новый", "Старый"]);
});

test("нет данных — всегда в конце, независимо от направления", () => {
  const list = [
    { id: 1, title: "Без года", year: null, kind: "movie" },
    { id: 2, title: "2020", year: 2020, kind: "movie" }
  ];
  deepStrictEqual(loadSort("open", "year", "asc")(list, "open").map((m) => m.title), ["2020", "Без года"]);
  deepStrictEqual(loadSort("open", "year", "desc")(list, "open").map((m) => m.title), ["2020", "Без года"]);
});

test("бар «В планах/Просмотрено» и RAofP только у просмотренных", () => {
  ok(source.includes('renderSegment("movies", moviesView, [["open", "В планах"], ["watched", "Просмотрено"]]'));
  ok(source.includes('["raofp", "RAofP"]'), "RAofP нет в опциях сортировки");
  ok(source.includes('data-action="movie-sort-dir"'), "нет кнопки направления");
  equal(source.includes("Хотим посмотреть ·"), false, "старый заголовок списка остался");
});
