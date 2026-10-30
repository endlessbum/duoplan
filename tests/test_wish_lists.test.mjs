// Точечная перерисовка списков вишлиста (renderWishLists, public/app.js).
//
// Переключение «Мои / партнёр» больше не перерисовывает вкладку целиком:
// обновляется только #wish-lists, капля остаётся на живом экземпляре и
// доезжает плавно, как в главном баре. Тесты проверяют содержимое обоих
// видов и согласованность данных.
//
// Запуск: node --test tests/test_wish_lists.test.mjs
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { equal, ok } from "node:assert/strict";
import { test } from "node:test";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const source = readFileSync(join(root, "public/app.js"), "utf8");

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
  return source.slice(start, source.indexOf(String.fromCharCode(10), start));
}

function makeLoader() {
  return new Function(
    "STATE_RECENT_LIMIT", "STATE_ACTIVE_LIMIT", "ARCHIVE_PAGE_SIZE",
    [
      "let wishView = 'mine';",
      "let appState = null;",
      "let archiveCachePairId = null;",
      "const archiveCache = { tasks: { items: [], page: -1, hasMore: null, remaining: null }, dates: { items: [], page: -1, hasMore: null, remaining: null }, wishes: { items: [], page: -1, hasMore: null, remaining: null }, memories: { items: [], page: -1, hasMore: null, remaining: null }, done_tasks: { items: [], page: -1, hasMore: null, remaining: null }, done_wishes: { items: [], page: -1, hasMore: null, remaining: null } };",
      "const ARCHIVE_KEYS_BY_TYPE = { memories: ['memories'], dates: ['dates'], tasks: ['tasks', 'done_tasks'], wishes: ['wishes', 'done_wishes'] };",
      extractBraced("function esc"),
      extractLine("  const RICH_TOKENS"),
      extractLine("  const REOPEN_ICON"),
      extractBraced("function richInline"),
      extractBraced("function renderRichText"),
      extractBraced("function partnerMissing"),
      extractBraced("function mergedArchive"),
      extractBraced("function archiveMoreHtml"),
      extractBraced("function wishItem"),
      extractBraced("function completedWishItem"),
      extractBraced("function renderWishLists"),
      "return { renderWishLists, setWishView: (v) => { wishView = v; }, setAppState: (v) => { appState = v; } };"
    ].join("\n")
  );
}

const RICH = {
  user: { tg_id: 1 },
  pair: { id: 1, user_b: 2, partner_gender: "male" },
  wishes: [
    { id: 10, body: "Моё желание", owner_id: 1, url: "", done: 0, done_at: null, created_at: 1, display_name: "Оля" },
    { id: 11, body: "Чужое желание", owner_id: 2, url: "", done: 0, done_at: null, created_at: 2, display_name: "Игорь" }
  ],
  completedWishes: [
    { id: 12, body: "Моё исполненное", owner_id: 1, url: "", done: 1, done_at: 5, created_at: 3, display_name: "Оля" }
  ]
};

function renderLists(appState, view) {
  const lists = makeLoader()(10, 200, 20);
  lists.setAppState(appState);
  lists.setWishView(view);
  return lists.renderWishLists();
}

test("вид «Мои»: свои желания с кнопками, чужих нет", () => {
  const html = renderLists(RICH, "mine");
  ok(html.includes("Моё желание"), "своего желания нет");
  ok(!html.includes("Чужое желание"), "чужое желание попало в вид «Мои»");
  ok(html.includes('data-action="add-wish"'), "нет кнопки добавления");
  ok(html.includes("Исполненные · 1"), "нет блока исполненных");
});

test("вид «партнёр»: чужие желания без кнопок, своего нет", () => {
  const html = renderLists(RICH, "partner");
  ok(html.includes("Чужое желание"), "чужого желания нет");
  ok(!html.includes("Моё желание"), "своё желание попало в вид партнёра");
  ok(!html.includes('data-action="add-wish"'), "в виде партнёра не должно быть кнопки добавления");
  ok(html.includes("Пока пусто") === false, "пустой блок при наличии чужих желаний");
});

test("пустой вид «партнёр» показывает заглушку с полом партнёра", () => {
  const html = renderLists({ ...RICH, wishes: [], completedWishes: [] }, "partner");
  ok(html.includes("Пока пусто"));
  ok(html.includes("Он ещё не добавил"), "пол партнёра не учтён");
});

test("архивная кнопка «Показать ещё» остаётся внутри вынесенных списков", () => {
  // Порог архивов — 10 недавних: даём 11 исполненных, чтобы кнопка появилась.
  const many = Array.from({ length: 11 }, (_, i) => ({
    id: 100 + i, body: `Желание ${i}`, owner_id: 1, url: "", done: 1, done_at: 5, created_at: 100 + i, display_name: "Оля"
  }));
  const html = renderLists({ ...RICH, completedWishes: many }, "mine");
  ok(html.includes("load-archive"), "архивные кнопки потерялись при выносе списков");
});
