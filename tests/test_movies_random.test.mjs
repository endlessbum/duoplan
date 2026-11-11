// «Рандом» кино: колода, а не Math.random() на каждый тап — клон механики
// «Мест» (см. test_places_random.test.mjs) на списках movies.
//
// Функции извлекаются из public/app.js как есть — тот же приём, что в
// test_pair_invite и test_archive_cache.
//
// Запуск: node tests/test_movies_random.test.mjs
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { deepStrictEqual, equal, ok } from "node:assert/strict";
import { test } from "node:test";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const source = readFileSync(join(root, "public/app.js"), "utf8");

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

function loadDeck() {
  return new Function(
    [
      "let appState = null;",
      "let movieDeck = [];",
      "let moviePickId = null;",
      // movieList() читает mergedArchive — стаб возвращает недавние как есть.
      "const mergedArchive = (type, recent) => recent || [];",
      extractBraced(source, "function movieList()"),
      extractBraced(source, "function openMovies()"),
      extractBraced(source, "function watchedMovies()"),
      extractBraced(source, "function findLivePick("),
      extractBraced(source, "function shuffleIds("),
      extractBraced(source, "function syncDeckIds("),
      extractBraced(source, "function shuffledDeck("),
      extractBraced(source, "function currentMoviePick()"),
      extractBraced(source, "function syncMovieDeck("),
      extractBraced(source, "function drawMovie("),
      `return {
        setMovies: (movies) => { appState = { movies }; },
        setWatched: (id, watched) => {
          const movie = appState.movies.find((item) => Number(item.id) === Number(id));
          if (movie) movie.watched = watched ? 1 : 0;
        },
        draw: drawMovie,
        pick: () => moviePickId,
        deck: () => movieDeck.slice(),
        open: openMovies,
        watched: watchedMovies,
        current: currentMoviePick
      };`
    ].join("\n")
  )();
}

const movie = (id, watched = 0) => ({ id, title: `Фильм ${id}`, watched });

test("пока список не менялся, фильм не выпадает дважды", () => {
  const deck = loadDeck();
  deck.setMovies([movie(1), movie(2), movie(3)]);
  const drawn = [deck.draw(), deck.draw(), deck.draw()];
  deepStrictEqual([...new Set(drawn)].length, 3, `повтор в цикле: ${drawn}`);
  const next = deck.draw();
  ok(next !== drawn[2], "новый цикл не должен начинаться с только что показанного");
});

test("просмотренные фильмы не участвуют в рандоме", () => {
  const deck = loadDeck();
  deck.setMovies([movie(1), movie(2), movie(3, 1)]);
  const drawn = [deck.draw(), deck.draw(), deck.draw()];
  ok(!drawn.includes(3), `просмотренный фильм выпал: ${drawn}`);
  deepStrictEqual([...new Set(drawn)].length, 2, `ожидались только 1 и 2: ${drawn}`);
});

test("отметка просмотра не перезапускает цикл и не повторяет выбор", () => {
  const deck = loadDeck();
  deck.setMovies([movie(1), movie(2), movie(3), movie(4)]);
  const first = deck.draw();
  const second = deck.draw();
  deck.setWatched(second, true);
  const third = deck.draw();
  ok(third !== second, "только что просмотренный фильм не должен выпасть снова");
  ok(third !== first, "выбор повторился раньше времени");
  deepStrictEqual(
    deck.open().map((item) => item.id).sort(),
    [1, 2, 3, 4].filter((id) => id !== second).sort()
  );
});

test("один фильм: рандом возвращает его же, но не падает", () => {
  const deck = loadDeck();
  deck.setMovies([movie(7)]);
  equal(deck.draw(), 7);
  equal(deck.draw(), 7);
});

test("всё просмотрено: выбора нет, карточка снимается", () => {
  const deck = loadDeck();
  deck.setMovies([movie(1, 1), movie(2, 1)]);
  equal(deck.draw(), null);
  equal(deck.pick(), null);
  equal(deck.current(), null);
  equal(deck.open().length, 0);
  equal(deck.watched().length, 2);
});

test("удалённый фильм исчезает из колоды, карточка результата снимается", () => {
  const deck = loadDeck();
  deck.setMovies([movie(1), movie(2)]);
  const picked = deck.draw();
  // Партнёр удалил выпавший фильм между показом и подтверждением.
  deck.setMovies([movie(picked === 1 ? 2 : 1)]);
  equal(deck.current(), null, "карточка удалённого фильма должна исчезнуть");
  const next = deck.draw();
  ok(next !== picked, "удалённый фильм не должен выпадать");
});
