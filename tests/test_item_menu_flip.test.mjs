// Направление всплывающего меню «⋮» (решение владельца 2026-11-23).
//
// Меню открывается в ту сторону, где хватает места: вниз по умолчанию,
// вверх — если снизу его не вместить (край экрана, нижняя навигация, граница
// прокручиваемого окна диалога). Не помещается никуда — остаётся на большей
// из сторон и получает прокрутку. Механизм один для всех карточек.
//
// placeItemMenu() выполняется по-настоящему на макете прямоугольников:
// linkedom не считает раскладку, поэтому геометрия задаётся вручную.
//
// Запуск: node --test tests/test_item_menu_flip.test.mjs
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { deepStrictEqual, equal, match, ok } from "node:assert/strict";
import { test } from "node:test";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const appJs = readFileSync(join(root, "public", "app.js"), "utf8");
const appCss = readFileSync(join(root, "public", "app.css"), "utf8");

const start = appJs.indexOf("function placeItemMenu(");
const end = appJs.indexOf("// Монохромный огонёк", start);
ok(start !== -1 && end !== -1, "placeItemMenu не найден");
const placeItemMenu = new Function(
  "window", "document", "getComputedStyle",
  `${appJs.slice(start, end)}\nreturn placeItemMenu;`
);

// Карточка с «⋮»: toggle — прямоугольник кнопки, menu — высота меню.
// clip — обрезающий предок (прокручиваемое окно диалога), navTop — верх
// нижней навигации.
function card({ toggle, menuHeight, clip = null, navTop = null, innerHeight = 800 }) {
  const classes = new Set();
  const inDialog = Boolean(clip);
  const body = {};
  const clipAncestor = clip
    ? { getBoundingClientRect: () => ({ top: clip.top, bottom: clip.bottom }), parentElement: body }
    : body;
  const menu = { style: {}, getBoundingClientRect: () => ({ height: menuHeight }) };
  const wrap = {
    classList: {
      add: (c) => classes.add(c),
      remove: (c) => classes.delete(c),
      toggle: (c, on) => (on ? classes.add(c) : classes.delete(c)),
      contains: (c) => classes.has(c)
    },
    querySelector: (s) => (s === ".item-menu" ? menu : s === ".item-menu-toggle" ? toggle : null),
    parentElement: clipAncestor,
    closest: (s) => (s === "dialog" && inDialog ? {} : null)
  };
  const api = placeItemMenu(
    { innerHeight },
    { body, querySelector: () => (navTop === null ? null : { getBoundingClientRect: () => ({ top: navTop }) }) },
    (el) => ({ overflowY: clip && el === clipAncestor ? "auto" : "visible" })
  );
  return {
    run() { api(wrap); return { up: classes.has("is-up"), maxHeight: menu.style.maxHeight || null }; },
    stale() { classes.add("is-up"); menu.style.maxHeight = "111px"; }
  };
}

const anchor = (top, height = 34) => ({ getBoundingClientRect: () => ({ top, bottom: top + height }) });

test("внизу хватает места — меню открывается вниз, без предела высоты", () => {
  const c = card({ toggle: anchor(200), menuHeight: 300, navTop: 740 });
  // Результат прошлого открытия не должен попадать в новый замер.
  c.stale();
  deepStrictEqual(c.run(), { up: false, maxHeight: null });
});

test("снизу не хватает, сверху хватает — меню открывается вверх", () => {
  // Нижняя навигация съедает место: под кнопкой 54px, меню 300px.
  deepStrictEqual(card({ toggle: anchor(640), menuHeight: 300, navTop: 740 }).run(), { up: true, maxHeight: null });
});

test("окно диалога: меню не прячется под границу окна и открывается вверх", () => {
  // Окно 100..500, кнопка у его низа: снизу 14px, сверху 328px — меню из
  // восьми пунктов (361px) идёт вверх и ужимается до места сверху.
  deepStrictEqual(card({ toggle: anchor(440), menuHeight: 361, clip: { top: 100, bottom: 500 }, navTop: 740 }).run(),
    { up: true, maxHeight: "328px" });
});

test("внутри окна нижняя навигация не учитывается", () => {
  // В окне снизу до границы 154px — хватает; вне окна навигация оставила бы 94px.
  const inDialog = card({ toggle: anchor(600), menuHeight: 120, clip: { top: 100, bottom: 800 }, navTop: 740 });
  const onPage = card({ toggle: anchor(600), menuHeight: 120, navTop: 740 });
  deepStrictEqual(inDialog.run(), { up: false, maxHeight: null });
  deepStrictEqual(onPage.run(), { up: true, maxHeight: null });
});

test("не помещается никуда — остаётся на большей стороне и получает прокрутку", () => {
  // Кнопка у верха окна: снизу до границы 134px, сверху 8px.
  deepStrictEqual(card({ toggle: anchor(120), menuHeight: 200, clip: { top: 100, bottom: 300 } }).run(),
    { up: false, maxHeight: "134px" });
});

test("снизу и сверху поровну — меню остаётся вниз", () => {
  // Снизу 55px и сверху 55px: вверх идёт только при строго большем месте.
  // Предел высоты не бывает ниже 96px — иначе меню станет нерабочей щелью.
  deepStrictEqual(card({ toggle: anchor(67), menuHeight: 300, innerHeight: 168 }).run(), { up: false, maxHeight: "96px" });
});

test("открытие меню вызывает расчёт направления, закрытие его сбрасывает", () => {
  const open = appJs.slice(appJs.indexOf('action === "item-menu-toggle"'), appJs.indexOf('action === "seg-switch"'));
  match(open, /menu\.hidden = false;\s*btn\.setAttribute\("aria-expanded", "true"\);\s*placeItemMenu\(wrap\);/);
  const close = appJs.slice(appJs.indexOf("function closeItemMenus("), appJs.indexOf("function placeItemMenu("));
  match(close, /classList\.remove\("is-up"\);\s*menu\.style\.maxHeight = "";/);
  // Стиль направления: меню привязано к низу «⋮», когда снизу места нет.
  match(appCss, /\.item-actions\.is-up > \.item-menu \{\s*top: auto;\s*bottom: calc\(100% \+ 4px\);/);
  ok(/\.item-menu \{[^}]*overflow-y: auto;/.test(appCss), "меню без прокрутки не покажет обрезанные пункты");
});
