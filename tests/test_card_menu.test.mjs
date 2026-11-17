// Единое меню действий карточек «⋮»: все кнопки записи собраны в один
// список в правом верхнем углу; «Остановились» — пункт меню фильма/сериала
// с чипом позиции в карточке.
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
  if (start === -1) throw new Error(`${declaration} not found`);
  let depth = 0;
  for (let j = source.indexOf("{", start); j < source.length; j++) {
    if (source[j] === "{") depth++;
    else if (source[j] === "}") {
      depth--;
      if (depth === 0) return source.slice(start, j + 1);
    }
  }
  throw new Error(`unclosed block: ${declaration}`);
}
function extractLine(prefix) {
  const start = source.indexOf(prefix);
  if (start === -1) throw new Error(`${prefix} not found`);
  return source.slice(start, source.indexOf("\n", start));
}

const helpers = new Function(
  [
    extractBraced("function esc"),
    extractBraced("function itemActionButton"),
    extractBraced("function itemActions"),
    extractLine("  const DONE_ICON"),
    extractLine("  const REOPEN_ICON"),
    extractLine("  const EDIT_ICON"),
    extractLine("  const DELETE_ICON"),
    extractLine("  const LINK_ICON"),
    extractLine("  const RESUME_ICON"),
    "return { itemActionButton, itemActions };"
  ].join("\n")
)();
const { itemActionButton, itemActions } = helpers;

test("itemActions: «⋮»-тоггл без обводки + список role=menu, изначально скрыт", () => {
  const html = itemActions(itemActionButton({ action: "done-item", type: "tasks", id: 5, label: "Выполнено", icon: "<svg/>" }));
  ok(html.includes('data-action="item-menu-toggle"'), "нет тоггла меню");
  ok(html.includes("⋮"), "тоггл — не вертикальное многоточие");
  ok(html.includes('aria-haspopup="menu"') && html.includes('aria-expanded="false"'), "нет aria атрибутов");
  ok(!html.includes('class="icon-btn"'), "кнопочной обводки у тоггла быть не должно");
  ok(html.includes('class="item-menu"') && html.includes("hidden"), "список не скрыт по умолчанию");
  ok(html.includes('role="menu"'), "нет role=menu");
  ok(html.includes('data-action="done-item"') && html.includes('data-type="tasks"') && html.includes('data-id="5"'), "потеряны data-атрибуты действия");
  ok(html.includes(">Выполнено<"), "подпись действия не видна текстом");
});

test("itemActionButton: иконка + текст, url пробрасывается", () => {
  const html = itemActionButton({ action: "open-url", url: "https://example.com?a=1&b=2", label: "Ссылка", icon: "<svg/>" });
  ok(html.includes('data-url="https://example.com?a=1&amp;b=2"'), "url не экранирован/не проброшен");
  ok(html.includes('role="menuitem"'), "пункт без role=menuitem");
});

test("itemActions: пустой набор — без пустой разметки", () => {
  ok(itemActions("") === "", "пустые actions дали разметку");
  ok(itemActions(null) === "", "null actions дали разметку");
});

// movieItem с минимальным набором зависимостей — как в test_item_cards.
const loadMovieItem = new Function(
  [
    extractLine("  const REOPEN_ICON"),
    extractLine("  const DONE_ICON"),
    extractLine("  const EDIT_ICON"),
    extractLine("  const DELETE_ICON"),
    extractLine("  const LINK_ICON"),
    extractLine("  const RESUME_ICON"),
    extractBraced("function esc"),
    extractBraced("function itemActionButton"),
    extractBraced("function itemActions"),
    extractBraced("function plural"),
    'const viewerTimeZone = () => "UTC";',
    extractBraced("function formatTimestamp"),
    extractBraced("function scorePill"),
    extractBraced("function ratingPill"),
    extractBraced("function raofpPill"),
    extractBraced("function formatMovieLength"),
    "let movieGroupSelection = null;",
    extractBraced("function movieItem"),
    "return movieItem;"
  ].join("\n")
);
const movieItem = loadMovieItem();

test("movieItem: у непросмотренного — «Остановились» в меню, чип при отметке", () => {
  const plain = movieItem({ id: 1, title: "Фильм", kind: "movie", watched: 0 });
  ok(plain.includes('data-action="item-menu-toggle"'), "нет «⋮»-меню");
  ok(plain.includes('data-action="movie-resume"'), "нет пункта «Остановились»");
  ok(plain.includes(">Остановились<"), "подпись пункта потеряна");
  ok(!plain.includes("is-resume"), "чип без отметки не нужен");

  const marked = movieItem({ id: 2, title: "Сериал", kind: "series", watched: 0, resume_position: "2 сезон, 5 серия · 34:12" });
  ok(marked.includes("is-resume"), "нет чипа точки просмотра");
  ok(marked.includes("2 сезон, 5 серия · 34:12"), "чип без текста позиции");
  ok(marked.includes("Изменить точку просмотра"), "нет пункта изменения");
  ok(marked.includes('data-action="movie-resume-clear"'), "нет пункта сброса");
});

test("movieItem: у просмотренного «Остановились» нет — сервер её и так сбрасывает", () => {
  const watched = movieItem({ id: 3, title: "Фильм", kind: "movie", watched: 1, watched_at: 1730000000 });
  ok(!watched.includes("movie-resume"), "resume-пункты у просмотренного");
  ok(watched.includes('data-action="item-menu-toggle"'), "меню у просмотренного потеряно");
});

test("карточка группы и карточки разделов используют общее меню, а не icon-btn ряд", () => {
  // Группа: единственная кнопка управления — через itemActions → «⋮».
  ok(!source.includes('data-action="movie-group-menu" data-id="${esc(group.id)}" aria-label="Управление группой">${MENU_ICON}'), "старый icon-btn группы остался");
  // Все пункты меню — с текстовой подписью (визуальный список действий).
  const menuCalls = source.match(/itemActionButton\(\{[^}]*label:/g) || [];
  ok(menuCalls.length > 20, `ожидалось много пунктов меню, найдено ${menuCalls.length}`);
});
