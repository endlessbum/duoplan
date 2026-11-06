// «Рандом»-карточки и главная: правки по запросу 2026-11-06.
//
// * Из hero-карточек «Места» и «Кино» убран eyebrow «Рандом».
// * У карточек результата (place-pick / movie-pick) есть кнопка «Закрыть»
//   (data-action="close-pick"), которая сбрасывает выбор и перерисовывает
//   экран, не трогая hero-информер и кнопку «Рандом».
// * «Места» повторяют механику «Кино»: hero живёт до первого успешного
//   рандома (localStorage-флаг), потом карточка исчезает, а кнопка
//   «Рандом» остаётся отдельной под «Добавить место».
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

test("hero-карточки без eyebrow «Рандом»", () => {
  const placesHero = sliceBetween(appJs, 'class="card place-hero"', "if (pick) html += renderPlacePick");
  const moviesHero = sliceBetween(appJs, 'class="card place-hero movie-hero"', "if (pick) html += renderMoviePick");
  ok(!placesHero.includes("eyebrow"), "в карточке «Мест» не должно быть eyebrow");
  ok(!moviesHero.includes("eyebrow"), "в карточке «Кино» не должно быть eyebrow");
  ok(placesHero.includes("Не знаете, куда пойти?"), "заголовок мест потерян");
  ok(moviesHero.includes("Не знаете, что посмотреть?"), "заголовок кино потерян");
});

test("карточки результата имеют кнопку «Закрыть»", () => {
  const placePick = sliceBetween(appJs, "function renderPlacePick(", "function placeItem(");
  const moviePick = sliceBetween(appJs, "function renderMoviePick(", "const MOVIE_RANDOM_KEY");
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

test("«Места» повторяют жизненный цикл hero «Кино»", () => {
  // Hero рисуется только пока !placeRandomUsed(), после первого draw —
  // markPlaceRandomUsed() гасит его, а кнопка возвращается отдельной.
  const placesBody = sliceBetween(appJs, "function renderPlacesBody()", "function tripList()");
  ok(placesBody.includes("if (!heroUsed)"), "hero мест не привязан к флагу");
  ok(placesBody.includes('data-action="random-place">Рандом</button>'),
    "после первого рандома кнопка «Рандом» должна остаться");
  const randomHandler = sliceBetween(appJs, 'action === "random-place"', 'action === "movie-watched"');
  ok(randomHandler.includes("markPlaceRandomUsed()"),
    "первый успешный рандом должен помечать флаг");
  // Паритет с кино: те же три точки механики.
  const moviesBody = sliceBetween(appJs, "function renderMoviesBody()", "function renderWishLists()");
  ok(moviesBody.includes("if (!heroUsed)"), "hero кино не привязан к флагу");
  ok(moviesBody.includes('data-action="random-movie">Рандом</button>'),
    "после первого рандома кнопка «Рандом» кино должна остаться");
  const movieHandler = sliceBetween(appJs, 'action === "random-movie"', 'action === "deposit-saving"');
  ok(movieHandler.includes("markMovieRandomUsed()"),
    "первый успешный рандом кино должен помечать флаг");
});

test("главная: дни рождения под своим заголовком", () => {
  const home = sliceBetween(appJs, "function renderHome()", "function taskItem(");
  ok(home.includes('item.kind === "birthday"'), "фильтр по kind потерян");
  ok(home.includes("previewBirthdays"), "previewBirthdays не собран");
  ok(home.includes("<h3>Дни рождения</h3>"), "нет секции «Дни рождения»");
  ok(home.includes("<h3>Значимые даты</h3>"), "нет секции «Значимые даты»");
  match(home, /dates\.filter\(\(item\) => item\.kind === "birthday"\)/);
});
