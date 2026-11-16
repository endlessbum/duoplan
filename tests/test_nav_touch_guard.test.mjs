// WebView-фолбэк для перетаскивания капли.
//
// На части WebView (старый WKWebView, Android WebView) `touch-action` не
// отключает прокрутку: браузер начинает пан и уводит pointer в pointercancel,
// из-за чего жест обрывается на первом же движении. Поэтому модуль:
//   1) ставит `touch-action: none` на саму вкладку — на child правило родителя
//      не наследуется, а default `auto` перебивает `pan-y` панели;
//   2) отменяет touchmove, пока жест жив, — это гарантирует отсутствие скролла
//      даже там, где touch-action игнорируется;
//   3) ищет вкладку обходом предков по data-tab, а не `closest()`: на SVG-капле часть
//      WebView не поднимается до <button>.
//
// Поведение в реальном браузере проверяет tests/nav-harness.html (сценарии
// 13–14), здесь — статические гарантии, чтобы правки не откатили фолбэк молча.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { deepStrictEqual, equal, ok, match } from "node:assert/strict";
import { test } from "node:test";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const navSource = readFileSync(join(root, "public", "nav.js"), "utf8");
const appCss = readFileSync(join(root, "public", "app.css"), "utf8");

const ruleFor = (selector) => {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  // Якорь на начало строки: иначе `.nav-item` совпадёт с хвостом
  // `.nav-lens-track .nav-item`, у которого своих правил нет.
  const match = appCss.match(new RegExp(`^${escaped}\\s*\\{([^}]*)\\}`, "m"));
  return match ? match[1] : "";
};

const functionBody = (name) => {
  const start = navSource.indexOf(`function ${name}(`);
  ok(start !== -1, `в nav.js нет функции ${name}`);
  const brace = navSource.indexOf("{", start);
  let depth = 0;
  for (let i = brace; i < navSource.length; i += 1) {
    if (navSource[i] === "{") depth += 1;
    else if (navSource[i] === "}") {
      depth -= 1;
      if (depth === 0) return navSource.slice(brace, i + 1);
    }
  }
  return "";
};

test("вкладка сама гасит touch-action: родительское правило не наследуется", () => {
  match(ruleFor(".nav-item"), /touch-action:\s*none/);
});

test("панель не отдаёт прокрутку — в том числе во время жеста", () => {
  // touch-action не наследуется: задаём и на панели, и на каждой вкладке,
  // поэтому панель не скроллится и в состоянии is-dragging. Отдельное
  // правило-дубль для .is-dragging удалено (аудит 2026-11-01).
  match(ruleFor(".bottom-nav"), /touch-action:\s*none/);
});

test("touchmove слушается с passive: false, иначе preventDefault игнорируется", () => {
  match(navSource, /addEventListener\("touchmove",\s*onTouchMove,\s*\{\s*passive:\s*false\s*\}\)/);
});

test("touchmove отменяется только пока жест жив", () => {
  const body = functionBody("onTouchMove");
  match(body, /preventDefault\(\)/);
  match(body, /if\s*\(state\.press\s*\|\|\s*state\.drag\)/);
});

test("destroy снимает обработчик touchmove", () => {
  const body = functionBody("destroy");
  match(body, /removeEventListener\("touchmove",\s*onTouchMove\)/);
});

test("lostpointercapture от дочернего элемента не считается отменой жеста", () => {
  // Палец попадает в иконку внутри вкладки — браузер ставит неявный capture
  // на неё, а setPointerCapture(nav) его снимает. Событие всплывает до панели,
  // и без проверки target жест умирал сразу после старта (реальный touch это
  // и ловил: капля дёргалась на пару пикселей и возвращалась).
  const body = functionBody("onPointerCancel");
  match(body, /event\.type === "lostpointercapture" && event\.target !== nav/);
  match(body, /if \(event\.type === "lostpointercapture"[^\n]*\) return;/);
});

test("цель жеста ищется обходом предков, а не closest()", () => {
  const body = functionBody("onPointerDown");
  ok(!/event\.target\.closest/.test(body), "closest() на SVG в WebView не поднимается до .nav-item");
  match(body, /let el = event\.target;/);
  // Цель ищется по data-tab: так капля работает и в переключателях
  // внутри страницы, где кнопки не имеют класса .nav-item.
  match(body, /el\.dataset && el\.dataset\.tab/);
  match(body, /el = el\.parentNode/);
});

test("настольный бар поднимается по классу приложения, мобильная геометрия не тронута", () => {
  // Мобильная формула (погружение на треть высоты) обязана остаться нетронутой.
  match(ruleFor(".bottom-nav"), /8px\s*-\s*\(62px\s*\/\s*3\)/);

  const desktop = appCss.match(/\.is-desktop-app\s+\.bottom-nav\s*\{([\s\S]*?)\}/);
  ok(desktop, "нет правила .is-desktop-app .bottom-nav");
  match(desktop[1], /bottom:\s*calc\([^;]*\+\s*20px\)/);
  ok(!/62px\s*\/\s*3/.test(desktop[1]), "настольная формула всё ещё опускает бар");
  match(desktop[1], /safe-area-inset-bottom/);
  ok(!/@media\s*\(min-width:\s*768px\)/.test(appCss), "подъём всё ещё завязан на ширину окна");
});

test("класс is-desktop-app ставится по платформе Telegram, а не по ширине", () => {
  const appSource = readFileSync(join(root, "public", "app.js"), "utf8");
  const start = appSource.indexOf("// DESKTOP_BAR_BEGIN");
  const end = appSource.indexOf("// DESKTOP_BAR_END");
  ok(start !== -1 && end > start, "в app.js нет блока DESKTOP_BAR");
  const code = appSource.slice(start, end);

  // Площадка для теста: подменяем tg, matchMedia и document.documentElement.
  const run = (platform, matchMediaMatches, hasTg = true) => {
    const added = [];
    new Function("tg", "window", "document", code)(
      hasTg ? { platform } : null,
      { matchMedia: () => ({ matches: matchMediaMatches }) },
      { documentElement: { classList: { add: (c) => added.push(c) } } }
    );
    return added;
  };

  for (const platform of ["tdesktop", "macos", "weba", "webr", "UNIGRAM"]) {
    deepStrictEqual(run(platform, false), ["is-desktop-app"], `платформа ${platform} должна поднимать бар`);
  }
  // Широкий экран сам по себе десктопом не делает — решает платформа.
  deepStrictEqual(run("android", true), [], " широкий телефон не должен получать десктопный бар");
  deepStrictEqual(run("ios", true), []);
  deepStrictEqual(run("unknown", true), []);
  // Без Telegram (обычный браузер) — мышь + широкое окно.
  deepStrictEqual(run(undefined, true, false), ["is-desktop-app"]);
  deepStrictEqual(run(undefined, false, false), []);
  match(code, /tg\?\.platform/);
});
