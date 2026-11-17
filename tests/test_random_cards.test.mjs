// «Рандом»-карточки и главная: правки по запросу 2026-11-06 и 2026-11-17.
//
// * 2026-11-17: hero-информеры «Не знаете, куда пойти?» / «Не знаете, что
//   посмотреть?» показываются до первого запуска «Рандом», но только когда
//   в списке уже есть записи — на пустой вкладке карточки нет, только
//   «Пока пусто». После первого запуска остаётся отдельная кнопка «Рандом»
//   под «Добавить…».
// * У карточек результата (place-pick / movie-pick) есть кнопка «Закрыть»
//   (data-action="close-pick"), которая сбрасывает выбор и перерисовывает
//   экран.
// * На главной дни рождения и значимые даты — разные секции: birthdayItem
//   под заголовком «Дни рождения», dateItem — под «Значимые даты».
//
// Запуск: node --test tests/test_random_cards.test.mjs
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { ok, match } from "node:assert/strict";
import { test } from "node:test";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const appJs = readFileSync(join(root, "public", "app.js"), "utf8");

function sliceBetween(text, startNeedle, endNeedle) {
  const start = text.indexOf(startNeedle);
  ok(start !== -1, `${startNeedle} не найден`);
  const end = text.indexOf(endNeedle, start);
  ok(end !== -1, `${endNeedle} после ${startNeedle} не найден`);
  return text.slice(start, end);
}

test("hero-информеры «Рандом» есть, но скрыты на пустом списке", () => {
  // Hero живёт в обоих разделах и управляется флагом первого запуска.
  ok(appJs.includes("Не знаете, куда пойти?"), "hero мест должен присутствовать");
  ok(appJs.includes("Не знаете, что посмотреть?"), "hero кино должен присутствовать");
  ok(appJs.includes("place-hero"), "разметки hero-мест не должно быть");
  ok(appJs.includes("movie-hero"), "разметки hero-кино не должно быть");
  // Места: hero только при непустом списке (!heroUsed && !empty).
  const placesBody = sliceBetween(appJs, "function renderPlacesBody()", "function tripList()");
  match(placesBody, /if \(!heroUsed && !empty\)/, "hero мест должен быть ограничен непустым списком");
  // Кино: hero только когда есть хоть одна запись (open или watched).
  const moviesBody = sliceBetween(appJs, "function renderOpenMovies()", "function renderWishLists()");
  match(moviesBody, /if \(!heroUsed && hasAny\)/, "hero кино должен быть ограничен наличием записей");
  // После первого запуска флаг ставится в localStorage.
  ok(appJs.includes("placeRandomUsed") && appJs.includes("movieRandomUsed"),
    "флаги первого запуска должны использоваться");
});

test("карточки результата имеют кнопку «Закрыть»", () => {
  const placePick = sliceBetween(appJs, "function renderPlacePick(", "function placeItem(");
  const moviePick = sliceBetween(appJs, "function renderMoviePick(", "function filterMoviesByKind");
  for (const [name, body] of [["place-pick", placePick], ["movie-pick", moviePick]]) {
    ok(body.includes('data-action="close-pick"'), `${name}: нет data-action="close-pick"`);
    ok(body.includes(">Закрыть</button>"), `${name}: нет видимой кнопки «Закрыть»`);
  }
});

test("close-pick сбрасывает оба выбора и перерисовывает экран", () => {
  const handler = sliceBetween(appJs, 'action === "close-pick"', 'action === "random-place"');
  ok(handler.includes("placePickId = null"), "placePickId не сбрасывается");
  ok(handler.includes("moviePickId = null"), "moviePickId не сбрасывается");
  ok(handler.includes("render()"), "экран не перерисовывается");
});

test("«Рандом» — отдельная кнопка под «Добавить…» после первого запуска", () => {
  // Места: до первого нажатия кнопка живёт внутри hero-карточки; после —
  // отдельная кнопка под «Добавить место» (видна при непустом списке).
  const placesBody = sliceBetween(appJs, "function renderPlacesBody()", "function tripList()");
  ok(placesBody.includes("heroUsed"), "hero-флаг мест должен использоваться");
  ok(placesBody.includes('data-action="random-place">Рандом</button>'),
    "кнопка «Рандом» мест должна присутствовать");
  match(placesBody, /if \(heroUsed\) html \+= `<button class="secondary full place-random"[^`]*random-place/,
    "отдельная кнопка мест должна показываться только после первого запуска");
  const randomHandler = sliceBetween(appJs, 'action === "random-place"', 'action === "movie-watched"');
  ok(randomHandler.includes("markPlaceRandomUsed()"),
    "обработчик должен помечать первый запуск");
  // Кино: то же самое в renderOpenMovies.
  const moviesBody = sliceBetween(appJs, "function renderOpenMovies()", "function renderWishLists()");
  ok(moviesBody.includes("heroUsed"), "hero-флаг кино должен использоваться");
  ok(moviesBody.includes('data-action="random-movie">Рандом</button>'),
    "кнопка «Рандом» кино должна присутствовать");
  match(moviesBody, /if \(heroUsed\) html \+= `<button class="secondary full place-random"[^`]*random-movie/,
    "отдельная кнопка кино должна показываться только после первого запуска");
  const movieHandler = sliceBetween(appJs, 'action === "random-movie"', 'action === "deposit-saving"');
  ok(movieHandler.includes("markMovieRandomUsed()"),
    "обработчик должен помечать первый запуск");
});

test("главная: дни рождения под своим заголовком", () => {
  const home = sliceBetween(appJs, "function renderHome()", "function taskItem(");
  ok(home.includes('item.kind === "birthday"'), "фильтр по kind потерян");
  ok(home.includes("previewBirthdays"), "previewBirthdays не собран");
  ok(home.includes("<h3>Дни рождения</h3>"), "нет секции «Дни рождения»");
  ok(home.includes("<h3>Значимые даты</h3>"), "нет секции «Значимые даты»");
  match(home, /dates\.filter\(\(item\) => item\.kind === "birthday"\)/);
});
