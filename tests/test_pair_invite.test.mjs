// Вкладка «Наша пара»: карточка «Приглашение партнёра» видна только пока
// партнёра нет. После присоединения (user_b заполнен) она скрывается, а после
// выхода партнёра (сервер обнуляет user_b) возвращается.
//
// renderPair извлекается из public/app.js; внешние функции рендера и состояние
// подменяются, DOM не нужен.
//
// Запуск: node --test tests/test_pair_invite.test.mjs
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { equal } from "node:assert/strict";
import { test } from "node:test";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const appSource = readFileSync(join(root, "public/app.js"), "utf8");

function extractBraced(source, declaration) {
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

const loadRenderPair = new Function(
  "appState",
  "renderTabHeader",
  "renderPairCalendar",
  "renderPairSettings",
  [
    extractBraced(appSource, "function esc"),
    extractBraced(appSource, "function partnerMissing"),
    extractBraced(appSource, "function renderPair()"),
    "return renderPair;"
  ].join("\n")
);

function render(pair) {
  const renderPair = loadRenderPair(
    { pair },
    () => "",
    () => "",
    () => ""
  );
  return renderPair();
}

const PAIR = {
  id: 7,
  code: "ABCD1234",
  name1: "Игорь",
  name2: "",
  user_b: 0,
  role: "a",
  together_pts: 42
};

test("партнёра нет — карточка приглашения с кодом видна", () => {
  const html = render(PAIR);
  equal(html.includes("Приглашение партнёра"), true);
  equal(html.includes("Скопировать код: ABCD1234"), true);
  equal(html.includes("(ожидание партнёра)"), true);
});

test("партнёр присоединился — карточка приглашения скрыта", () => {
  const html = render({ ...PAIR, code: null, name2: "Аня", user_b: 2 });
  equal(html.includes("Приглашение партнёра"), false);
  equal(html.includes("Скопировать код"), false);
  equal(html.includes("и Аня"), true);
});

test("партнёр вышел — карточка приглашения возвращается", () => {
  // state() после выхода отдаёт user_b=0 и снова открывает код пары.
  const html = render({ ...PAIR, code: "ABCD1234", name2: "", user_b: 0 });
  equal(html.includes("Приглашение партнёра"), true);
  equal(html.includes("Скопировать код: ABCD1234"), true);
});
