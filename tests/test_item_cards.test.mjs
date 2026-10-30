// Карточки планов/дат/желаний и их чипы (public/app.js) — rich-mock рендер.
//
// Тесты извлекают рендереры и гоняют их с насыщенными данными (приватные,
// просроченные, без даты, 29 февраля) — по уроку п.24: функции в изоляции и
// пустые моки не ловят ошибки рендер-пути.
//
// Запуск: node --test tests/test_item_cards.test.mjs
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
  return source.slice(start, source.indexOf("\n", start));
}

const load = new Function(
  [
    // pairTimeZone и applyAccent-путь читают appState/документ — минимальные стабы.
    'const appState = { pair: { timezone: "Europe/Moscow", user_b: 1 }, user: { tg_id: 1 } };',
    'const document = { documentElement: { dataset: { theme: "dark" } }, querySelectorAll: () => [] };',
    extractLine("  const RICH_TOKENS"),
    extractLine("  const REOPEN_ICON"),
    extractBraced("function esc"),
    extractBraced("function formatDay"),
    extractBraced("function richInline"),
    extractBraced("function renderRichText"),
    extractBraced("function pairTimeZone"),
    extractBraced("function timeZoneOffsetMs"),
    extractBraced("function makeDateInTimeZone"),
    extractBraced("function zonedToday"),
    extractBraced("function planTarget"),
    extractBraced("function taskRepeat"),
    extractBraced("function monthlyNext"),
    extractBraced("function yearlyNext"),
    extractBraced("function byRowId"),
    extractBraced("function dayTime"),
    extractBraced("function annualDate"),
    extractBraced("function nextOccurrence"),
    extractBraced("function plural"),
    extractBraced("function countdownFromDiff"),
    extractBraced("function countdownChip"),
    extractBraced("function taskItem"),
    extractBraced("function dateItem"),
    extractBraced("function wishItem"),
    extractBraced("function completedTaskItem"),
    extractBraced("function completedWishItem"),
    "return { taskItem, dateItem, wishItem, completedTaskItem, completedWishItem, countdownChip, REOPEN_ICON, formatDay };"
  ].join("\n")
);
const { taskItem, dateItem, wishItem, completedTaskItem, completedWishItem, countdownChip, REOPEN_ICON, formatDay } = load();

test("у плана с датой есть «В календаре», у плана без даты — нет", () => {
  const withDay = taskItem({ id: 1, title: "План", day: "2026-11-05", time: "19:30", is_private: 0 });
  ok(withDay.includes('data-action="show-in-calendar"'), "нет кнопки «В календаре»");
  ok(withDay.includes('data-day="2026-11-05"'), "data-day не передан");
  const noDay = taskItem({ id: 2, title: "Идея", day: "", time: "", is_private: 0 });
  ok(!noDay.includes("show-in-calendar"), "кнопка не должна быть у плана без даты");
});

test("у значимой даты всегда есть «В календаре» с её днём", () => {
  for (const item of [
    { id: 3, title: "Ежегодная", day: "2021-05-17", time: "", recurs: 1, is_private: 0 },
    { id: 4, title: "Разовая", day: "2024-01-01", time: "12:00", recurs: 0, is_private: 1 }
  ]) {
    const html = dateItem(item);
    ok(html.includes('data-action="show-in-calendar"'), item.title);
    ok(html.includes(`data-day="${item.day}"`), item.title);
  }
});

test("карточки рендерятся без ошибок на богатом наборе состояний", () => {
  const mocks = [
    () => taskItem({ id: 5, title: "**Сюрприз** ||скрытый||", day: "2026-11-05", time: "19:30", is_private: 1 }),
    () => taskItem({ id: 6, title: "Просрочка за год", day: "2025-10-30", time: "10:00", is_private: 0 }),
    () => dateItem({ id: 7, title: "29 февраля", day: "2020-02-29", time: "", recurs: 1, is_private: 1 }),
    () => dateItem({ id: 8, title: "Будущее", day: "2027-01-01", time: "", recurs: 1, is_private: 0 })
  ];
  for (const render of mocks) {
    const html = render();
    ok(html.includes("item-row"), "карточка не отрендерилась");
    ok(!html.includes("undefined") && !html.includes("NaN"), "в разметке undefined/NaN");
  }
});

test("просрочка старше недели — приглушённый is-stale, свежая и будущая — нет", () => {
  ok(countdownChip("2025-10-30", "10:00").includes("is-stale"), "годовалая просрочка без is-stale");
  ok(!countdownChip("2026-10-30", "00:01").includes("is-stale"), "свежая просрочка помечена stale");
  ok(!countdownChip("2027-01-01", "12:00").includes("is-stale"), "будущий план помечен stale");
  equal(countdownChip("", ""), "");
});

test("кнопка возврата — SVG в стиле приложения, а не эмодзи-глиф ↩ (U+21A9)", () => {
  // Регрессия: U+21A9 на мобильных рендерится эмодзи и выпадает из стиля
  // текстовых кнопок ✓ ✎ ✕. Заменён на инлайн-SVG (stroke 1.9, как в app.html).
  const task = completedTaskItem({ id: 9, title: "План", day: "2026-11-05", time: "", is_private: 0 });
  const wish = completedWishItem({ id: 10, body: "Желание", owner_id: 1, url: "" }, true);
  for (const [name, html] of [["план", task], ["желание", wish]]) {
    ok(html.includes('data-action="reopen-item"'), `${name}: нет кнопки возврата`);
    ok(html.includes("<svg"), `${name}: возврат не в SVG-стиле приложения`);
    ok(!html.includes("\u21A9"), `${name}: остался эмодзи-глиф U+21A9`);
  }
  ok(REOPEN_ICON.includes('stroke-width="1.9"'), "SVG возврата не в толщине иконок приложения");
});

test("у чужого исполненного желания кнопок нет, у своего — есть", () => {
  const own = completedWishItem({ id: 11, body: "Моё", owner_id: 1, url: "" }, true);
  ok(own.includes('data-action="reopen-item"'), "у своего нет кнопок");
  const alien = completedWishItem({ id: 12, body: "Чужое", owner_id: 2, url: "" }, true);
  ok(!alien.includes('data-action="reopen-item"'), "у чужого остались кнопки");
  const readonly = completedWishItem({ id: 13, body: "Партнёра", owner_id: 2, url: "" }, false);
  ok(!readonly.includes('data-action="reopen-item"'), "read-only вид отрисовывает кнопки");
});

test("приватная запись помечается чипом «Личная»", () => {
  ok(taskItem({ id: 14, title: "x", day: "2026-11-05", time: "", is_private: 1 }).includes(">Личная</span>"));
  ok(dateItem({ id: 15, title: "x", day: "2026-11-05", time: "", recurs: 0, is_private: 1 }).includes(">Личная</span>"));
});

test("wishItem: у желания партнёра нет кнопок, у своего — полный набор", () => {
  const own = wishItem({ id: 16, body: "Моё", owner_id: 1, url: "" }, true);
  for (const action of ["done-item", "edit-item", "delete-item"]) {
    ok(own.includes(`data-action="${action}"`), action);
  }
  const alien = wishItem({ id: 17, body: "Чужое", owner_id: 2, url: "" }, true);
  ok(!alien.includes("icon-btn"), "у чужого желания отрисовались кнопки");
});

// ------------------------------------------------------------------
// Дневник: карточка с заголовком, свёрнутым телом и разворотом по клику.
// ------------------------------------------------------------------
test("memoryItem: заголовок, свёрнутое тело и клик-разворот", async () => {
  // memoryItem извлекается тем же экстрактором — перезагружаем с ним.
  const source2 = source;
  const loadMemory = new Function(
    [
      'const appState = { pair: { timezone: "Europe/Moscow", user_b: 1 }, user: { tg_id: 1 } };',
      'const document = { documentElement: { dataset: { theme: "dark" } }, querySelectorAll: () => [] };',
      extractLine("  const RICH_TOKENS"),
      extractBraced("function esc"),
      extractBraced("function formatDay"),
      extractBraced("function richInline"),
      extractBraced("function renderRichText"),
      extractBraced("function memoryItem"),
      "return memoryItem;"
    ].join("\n")
  );
  const memoryItem = loadMemory();
  const html = memoryItem({
    id: 20, title: "Тёплый вечер", body: "Строка 1\nСтрока 2\nСтрока 3\nСтрока 4\nСтрока 5\nСтрока 6",
    day: "2026-10-01", display_name: "Оля"
  });
  ok(html.includes('data-action="open-memory"'), "карточка не кликабельна");
  ok(html.includes('data-id="20"'), "data-id не передан");
  ok(html.includes("memory-body"), "нет класса свёрнутого тела (line-clamp в CSS)");
  ok(html.includes(">Тёплый вечер<"), "заголовок не отрисован");
  ok(html.includes("memory-card"), "нет класса карточки дневника");
  // Старая запись без заголовка — без пустого h3.
  const noTitle = memoryItem({ id: 21, title: "", body: "Текст", day: "2026-09-20", display_name: "Игорь" });
  ok(!noTitle.includes("<h3"), "пустой заголовок отрисовался пустым h3");
});


test("formatDay: все даты приложения — дд/мм/гггг", () => {
  equal(formatDay("2026-11-05"), "05/11/2026");
  equal(formatDay("2020-02-29"), "29/02/2020");
  // Мусор проходит как есть: чипы не должны показывать «undefined/NaN».
  equal(formatDay(""), "");
  equal(formatDay("мусор"), "мусор");
  equal(formatDay(null), "");
});
