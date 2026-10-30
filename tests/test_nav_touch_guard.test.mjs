// WebView-фолбэк для перетаскивания капли.
//
// На части WebView (старый WKWebView, Android WebView) `touch-action` не
// отключает прокрутку: браузер начинает пан и уводит pointer в pointercancel,
// из-за чего жест обрывается на первом же движении. Поэтому модуль:
//   1) ставит `touch-action: none` на саму вкладку — на child правило родителя
//      не наследуется, а default `auto` перебивает `pan-y` панели;
//   2) отменяет touchmove, пока жест жив, — это гарантирует отсутствие скролла
//      даже там, где touch-action игнорируется;
//   3) ищет .nav-item обходом предков, а не `closest()`: на SVG-капле часть
//      WebView не поднимается до <button>.
//
// Поведение в реальном браузере проверяет tests/nav-harness.html (сценарии
// 13–14), здесь — статические гарантии, чтобы правки не откатили фолбэк молча.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { equal, ok, match } from "node:assert/strict";
import { test } from "node:test";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const navSource = readFileSync(join(root, "public", "nav.js"), "utf8");
const appCss = readFileSync(join(root, "public", "app.css"), "utf8");

const ruleFor = (selector) => {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = appCss.match(new RegExp(`${escaped}\\s*\\{([^}]*)\\}`));
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

test("во время жеста панель тоже не отдаёт прокрутку", () => {
  match(ruleFor(".bottom-nav.is-dragging"), /touch-action:\s*none/);
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

test("цель жеста ищется обходом предков, а не closest()", () => {
  const body = functionBody("onPointerDown");
  ok(!/event\.target\.closest/.test(body), "closest() на SVG в WebView не поднимается до .nav-item");
  match(body, /let el = event\.target;/);
  match(body, /el\.classList\.contains\("nav-item"\)/);
  match(body, /el = el\.parentNode/);
});
