// Панель сортировки «Кино» не должна пропадать при пустом результате фильтра:
// пользователь обязан всегда видеть переключатель «Все/Фильмы/Сериалы»,
// иначе после выбора пустого фильтра вернуться можно только сменой вида.
// Регрессия: во вкладке «Просмотрено» пустой фильтр возвращал только
// карточку «Пусто» без movieSortBar.
//
// Запуск: node --test tests/test_movie_sort_bar.test.mjs
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { ok } from "node:assert/strict";
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

const SORT_BAR = "<SORTBAR>";
const ITEM = "<ITEM>";

// Собираем renderMoviesList с реальными movieEmptyByKind/filterMoviesByKind
// и заглушками остальных зависимостей.
function loadRender({ view, watched, kind }) {
  const filterMoviesByKind = new Function(
    "movieKindFilter",
    [extractBraced("function filterMoviesByKind"), "return filterMoviesByKind;"].join("\n")
  )({ open: "all", watched: kind });
  return new Function(
    "moviesView", "watchedMovies", "filterMoviesByKind", "movieSortBar",
    "sortMovies", "movieItem", "renderOpenMovies", "movieKindFilter",
    [
      "const appState = { movies: [] };",
      "const archiveMoreHtml = () => \"\";",
      extractBraced("function movieEmptyByKind"),
      extractBraced("function renderMoviesList"),
      "return renderMoviesList;"
    ].join("\n")
  )(
    view,
    () => watched,
    filterMoviesByKind,
    () => SORT_BAR,
    (list) => list,
    () => ITEM,
    () => "<OPEN>",
    { open: "all", watched: kind }
  );
}

// Собираем renderOpenMovies с реальными filterMoviesByKind/movieEmptyByKind
// и заглушками остальных зависимостей — для регрессии «двойного пустого
// состояния» в «В планах».
function loadOpenRender({ open, watched, kind }) {
  const filterMoviesByKind = new Function(
    "movieKindFilter",
    [extractBraced("function filterMoviesByKind"), "return filterMoviesByKind;"].join("\n")
  )({ open: kind, watched: "all" });
  return new Function(
    "openMovies", "watchedMovies", "filterMoviesByKind", "partnerMissing",
    "currentMoviePick", "movieRandomUsed", "movieEmptyByKind", "movieSortBar",
    "sortMovies", "movieItem",
    [
      "const appState = { movies: [] };",
      "const archiveMoreHtml = () => \"\";",
      extractBraced("function renderOpenMovies"),
      "return renderOpenMovies;"
    ].join("\n")
  )(
    () => open,
    () => watched,
    filterMoviesByKind,
    () => false,
    () => null,
    () => true,
    movieEmptyByKindStub,
    () => SORT_BAR,
    (list) => list,
    () => ITEM
  );
}

// movieEmptyByKind нужен и внутри loadRender — выносим его создание.
function movieEmptyByKindStub(view) {
  return `<EMPTY:${view}>`;
}

const ONLY_MOVIES = [
  { id: 1, title: "Фильм", kind: "movie", watched: 1 },
  { id: 2, title: "Ещё фильм", kind: "movie", watched: 1 }
];
const ONLY_SERIES = [{ id: 3, title: "Сериал", kind: "series", watched: 1 }];

test("watched + фильтр «Сериалы» без сериалов: сортировка остаётся", () => {
  const html = loadRender({ view: "watched", watched: ONLY_MOVIES, kind: "series" })();
  ok(html.includes(SORT_BAR), "movieSortBar потерян при пустом фильтре");
  ok(html.includes("Пусто"), "нет карточки пустого результата");
});

test("watched + фильтр «Фильмы» без фильмов: сортировка остаётся", () => {
  const html = loadRender({ view: "watched", watched: ONLY_SERIES, kind: "movie" })();
  ok(html.includes(SORT_BAR), "movieSortBar потерян при пустом фильтре");
});

test("watched + фильтр «Все»: список рендерится с сортировкой", () => {
  const html = loadRender({ view: "watched", watched: ONLY_MOVIES, kind: "all" })();
  ok(html.includes(SORT_BAR) && html.includes(ITEM), "список просмотренного не отрендерился");
});

test("watched без фильмов вообще: карточка «ничего не просмотрено» без панели", () => {
  const html = loadRender({ view: "watched", watched: [], kind: "series" })();
  ok(html.includes("ничего не просмотрено"), "нет пустого состояния");
  ok(!html.includes(SORT_BAR), "панель сортировки показана при полностью пустом списке");
});

test("open + фильтр «Сериалы» при одних фильмах: нет дубля «Пока пусто»", () => {
  // Регрессия: карточка «Пока пусто» рендерилась по пустому результату
  // фильтра, хотя под сортировкой уже есть «Пусто» — две пустые карточки.
  const openMovies = [
    { id: 1, title: "Фильм А", kind: "movie", watched: 0 },
    { id: 2, title: "Фильм Б", kind: "movie", watched: 0 }
  ];
  const html = loadOpenRender({ open: openMovies, watched: [], kind: "series" })();
  ok(!html.includes("Пока пусто"), "лишняя карточка «Пока пусто» при пустом фильтре");
  ok(html.includes(SORT_BAR), "нет панели сортировки");
  ok(html.includes("<EMPTY:open>"), "нет карточки пустого фильтра");
});

test("open без фильмов вообще: карточка «Пока пусто» с кнопкой добавления", () => {
  const html = loadOpenRender({ open: [], watched: [], kind: "all" })();
  ok(html.includes("Пока пусто"), "нет пустого состояния");
  ok(html.includes("add-movie"), "нет кнопки добавления в пустом состоянии");
});

test("open + фильтр «Сериалы» при одних сериалах: список рендерится", () => {
  const openMovies = [{ id: 3, title: "Сериал", kind: "series", watched: 0 }];
  const html = loadOpenRender({ open: openMovies, watched: [], kind: "series" })();
  ok(html.includes(ITEM), "отфильтрованный список не отрендерился");
  ok(!html.includes("Пока пусто"), "лишняя пустая карточка");
});
