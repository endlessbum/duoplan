// «Рандом» мест: колода, а не Math.random() на каждый тап.
//
// Репорт 2026-11-04: при двух свободных местах повторное нажатие показывало то
// же место — syncPlaceDeck считал текущий выпавший выбор «новым» и возвращал
// его в колоду. Тест держит инвариант: пока список не изменился, место не
// выпадает дважды, а посещённые в колоду не попадают вовсе.
//
// Функции извлекаются из public/app.js как есть — тот же приём, что в
// test_pair_invite и test_archive_cache.
//
// Запуск: node tests/test_places_random.test.mjs
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
      "let placeDeck = [];",
      "let placePickId = null;",
      extractBraced(source, "function placeList()"),
      extractBraced(source, "function unvisitedPlaces()"),
      extractBraced(source, "function visitedPlaces()"),
      extractBraced(source, "function currentPlacePick()"),
      extractBraced(source, "function shuffleIds("),
      extractBraced(source, "function syncPlaceDeck("),
      extractBraced(source, "function drawPlace("),
      `return {
        setPlaces: (places) => { appState = { places }; },
        setVisited: (id, visited) => {
          const place = appState.places.find((item) => Number(item.id) === Number(id));
          if (place) place.visited = visited ? 1 : 0;
        },
        draw: drawPlace,
        pick: () => placePickId,
        deck: () => placeDeck.slice(),
        unvisited: unvisitedPlaces,
        visited: visitedPlaces,
        current: currentPlacePick
      };`
    ].join("\n")
  )();
}

const place = (id, visited = 0) => ({ id, title: `Место ${id}`, visited });

test("пока список не менялся, место не выпадает дважды", () => {
  const deck = loadDeck();
  deck.setPlaces([place(1), place(2), place(3)]);
  const drawn = [deck.draw(), deck.draw(), deck.draw()];
  deepStrictEqual([...new Set(drawn)].length, 3, `повтор в цикле: ${drawn}`);
  // Колода исчерпана — следующий цикл начинается заново, но не с текущего.
  const next = deck.draw();
  ok(next !== drawn[2], "новый цикл не должен начинаться с только что показанного");
});

test("посещённые места не участвуют в рандоме", () => {
  const deck = loadDeck();
  deck.setPlaces([place(1), place(2), place(3, 1)]);
  const drawn = [deck.draw(), deck.draw(), deck.draw()];
  ok(!drawn.includes(3), `посещённое место выпало: ${drawn}`);
  deepStrictEqual([...new Set(drawn)].length, 2, `ожидались только 1 и 2: ${drawn}`);
});

test("отметка посещения не перезапускает цикл и не повторяет выбор", () => {
  const deck = loadDeck();
  deck.setPlaces([place(1), place(2), place(3), place(4)]);
  const first = deck.draw();
  const second = deck.draw();
  // Подтвердили посещение второго места — оно уходит из пула.
  deck.setVisited(second, true);
  const third = deck.draw();
  ok(third !== second, "только что посещённое место не должно выпасть снова");
  ok(third !== first, "выбор повторился раньше времени");
  // Посещённым стало именно второе выпавшее место — какое бы оно ни было.
  deepStrictEqual(
    deck.unvisited().map((item) => item.id).sort(),
    [1, 2, 3, 4].filter((id) => id !== second).sort()
  );
});

test("одно место: рандом возвращает его же, но не падает", () => {
  const deck = loadDeck();
  deck.setPlaces([place(7)]);
  equal(deck.draw(), 7);
  equal(deck.draw(), 7);
});

test("все места посещены: выбора нет, карточка снимается", () => {
  const deck = loadDeck();
  deck.setPlaces([place(1, 1), place(2, 1)]);
  equal(deck.draw(), null);
  equal(deck.pick(), null);
  equal(deck.current(), null);
  equal(deck.unvisited().length, 0);
  equal(deck.visited().length, 2);
});

test("удалённое место исчезает из колоды, карточка результата снимается", () => {
  const deck = loadDeck();
  deck.setPlaces([place(1), place(2)]);
  const picked = deck.draw();
  // Партнёр удалил выпавшее место между показом и подтверждением.
  deck.setPlaces([place(picked === 1 ? 2 : 1)]);
  equal(deck.current(), null, "карточка удалённого места должна исчезнуть");
  const next = deck.draw();
  ok(next !== picked, "удалённое место не должно выпадать");
});
