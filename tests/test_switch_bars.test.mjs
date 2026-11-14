// Внутренние бары внутри вкладок (renderSegment): у каждого — своё состояние,
// своя копия капли и маршрут в делегате клика.
//
// Страховка от «мёртвого» бара: если забыть ключ в switchValue/setSwitchValue
// или в делегате, подписи переключались бы, а содержимое — нет. Список баров
// берётся из самого app.js (renderSegment(...)), поэтому новый бар попадает под
// проверку автоматически.
//
// Запуск: node --test tests/test_switch_bars.test.mjs
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { ok } from "node:assert/strict";
import { test } from "node:test";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
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

const switchValue = extractBraced(appSource, "function switchValue");
const setSwitchValue = extractBraced(appSource, "function setSwitchValue");
const destroySwitches = extractBraced(appSource, "function destroySwitches");
const renderFn = extractBraced(appSource, "function render()");

// Делегированный обработчик клика: ветка "seg-switch".
const delegateStart = appSource.indexOf('action === "seg-switch"');
const delegateEnd = appSource.indexOf("} else if (action ===", delegateStart + 10);
const delegate = appSource.slice(delegateStart, delegateEnd);

// Все бары, нарисованные через renderSegment.
const barKeys = [...appSource.matchAll(/renderSegment\("([^"]+)"/g)].map(m => m[1]);

// Бары с отдельной commit-функцией: их ключ не живёт в switchValue.
const ownCommit = { movies: "commitMoviesView", flo: "commitFloView" };

// Бары с собственной копией капли (внутренние, не верхние по вкладкам).
const internalBars = [
  { key: "movies", instance: "movieSwitch", mount: "mountMovieSwitch" },
  { key: "goals", instance: "goalsSwitch", mount: "mountGoalsSwitch" },
  { key: "plans", instance: "plansSwitch", mount: "mountPlansSwitch" },
  { key: "flo", instance: "floSwitch", mount: "mountFloSwitch" },
  { key: "savings", instance: "savingsSwitch", mount: "mountSavingsSwitch" },
  { key: "wishesView", instance: "wishesViewSwitch", mount: "mountWishesViewSwitch" }
];

test("все бары известны исходнику", () => {
  ok(barKeys.length >= 10, `найдено всего ${barKeys.length} баров`);
  for (const key of ["pair", "savings", "wishesView", "flo", "movies", "goals", "plans"]) {
    ok(barKeys.includes(key), `нет бара ${key}`);
  }
});

test("у каждого барa есть состояние: switchValue и setSwitchValue", () => {
  for (const key of barKeys) {
    if (ownCommit[key]) continue; // своя commit-функция — ключ не нужен
    ok(switchValue.includes(`key === "${key}"`), `switchValue не знает ${key}`);
    ok(setSwitchValue.includes(`key === "${key}"`), `setSwitchValue не знает ${key}`);
  }
});

test("у каждого барa есть маршрут в делегате клика", () => {
  for (const key of barKeys) {
    const commit = ownCommit[key];
    if (commit) {
      ok(appSource.includes(`function ${commit}`), `нет функции ${commit}`);
      ok(delegate.includes(commit), `делегат не ведёт в ${commit}`);
      continue;
    }
    ok(delegate.includes(`"${key}"`), `делегат не знает ${key}`);
  }
});

test("у внутренних баров есть своя копия капли: создаётся, снимается, перемонтируется", () => {
  for (const bar of internalBars) {
    ok(appSource.includes(`function ${bar.mount}()`), `нет функции ${bar.mount}`);
    ok(renderFn.includes(`${bar.mount}();`), `${bar.mount} не вызывается из render()`);
    ok(destroySwitches.includes(`${bar.instance}.destroy()`), `${bar.instance} не снимается в destroySwitches`);
  }
});

test("состояние бара переживает перерисовку вкладки", () => {
  // Виды живут вне рендера — иначе минутный refresh сбрасывал бы выбор.
  for (const [state, view] of [["savingsView", "saving"], ["wishesView", "open"], ["floView", "today"]]) {
    ok(new RegExp(`let ${state} = "${view}";`).test(appSource), `нет состояния ${state}`);
  }
});
