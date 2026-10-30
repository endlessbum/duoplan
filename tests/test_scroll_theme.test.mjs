// Непрерывный фон страницы: цвет WebView в Telegram и корневые стили.
//
// Причина «полос» при длинном свайпе: Telegram красит область за краями
// документа цветом из setBackgroundColor, а туда уходил ключ "bg_color" —
// цвет темы Telegram (в тёмной теме чёрный), а не фон приложения (--bg).
// На отскоке прокрутки это давало полосы другого цвета сверху и снизу.
//
// Запуск: node --test tests/test_scroll_theme.test.mjs
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { equal } from "node:assert/strict";
import { test } from "node:test";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const appJs = readFileSync(join(root, "public/app.js"), "utf8");
const appCss = readFileSync(join(root, "public/app.css"), "utf8");
const appHtml = readFileSync(join(root, "public/app.html"), "utf8");

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

function loadThemeBackground(value) {
  const fn = new Function(
    "window",
    "document",
    [
      extractBraced(appJs, "function themeBackground"),
      "return themeBackground;"
    ].join("\n")
  )(
    { getComputedStyle: () => ({ getPropertyValue: () => value }) },
    { documentElement: {} }
  );
  return fn();
}

test("цвет фона берётся из --bg без пробелов", () => {
  equal(loadThemeBackground(" #161514 "), "#161514");
  equal(loadThemeBackground("#f7f3ed"), "#f7f3ed");
  equal(loadThemeBackground("#fff"), "#fff");
});

test("непонятное значение не превращается в мусорный цвет", () => {
  equal(loadThemeBackground("rgb(22, 21, 20)"), null);
  equal(loadThemeBackground(""), null);
  equal(loadThemeBackground("var(--bg)"), null);
});

test("applyTheme отдаёт в Telegram фактический фон, а не ключ темы", () => {
  const theme = extractBraced(appJs, "function applyTheme");
  equal(theme.includes("themeBackground()"), true);
  equal(/setBackgroundColor\(\s*background\s*\|\|/.test(theme), true);
  equal(/setHeaderColor\(\s*background\s*\|\|/.test(theme), true);
  // Ключ остаётся только запасным вариантом, если --bg не hex.
  equal(theme.includes('"bg_color"'), true);
});

test("цвет адресной строки обновляется тем же значением", () => {
  const theme = extractBraced(appJs, "function applyTheme");
  equal(theme.includes('meta[name="theme-color"]'), true);
});

test("корень закрашивает всю область и оставляет нативный отскок", () => {
  const htmlRule = appCss.match(/\nhtml\s*\{([^}]*)\}/);
  equal(Boolean(htmlRule), true);
  const body = htmlRule[1];
  equal(/background-color:\s*var\(--bg\)/.test(body), true);
  // rubber-band включён — overscroll-behavior-y: none убран.
  equal(/overscroll-behavior-y:\s*none/.test(body), false);
  // Прокрутка одним пальцем должна остаться.
  equal(/touch-action:\s*pan-x pan-y/.test(body), true);
});

test("body не короче вьюпорта при коротком содержимом", () => {
  const bodyRule = appCss.match(/\nbody\s*\{([^}]*)\}/);
  equal(Boolean(bodyRule), true);
  equal(/min-height:\s*100dvh/.test(bodyRule[1]), true);
  equal(/background-color:\s*var\(--bg\)/.test(bodyRule[1]), true);
  // rubber-band включён и на body.
  equal(/overscroll-behavior-y:\s*none/.test(bodyRule[1]), false);
});

test("темы задают --bg и он совпадает у корня и оболочки", () => {
  equal(/:root\s*\{[^}]*--bg:\s*#f7f3ed/.test(appCss), true);
  equal(/:root\[data-theme="dark"\]\s*\{[^}]*--bg:\s*#161514/.test(appCss), true);
  // .app-shell не красит себя другим цветом — фон идёт от body.
  const shell = appCss.match(/\n\.app-shell\s*\{([^}]*)\}/);
  equal(Boolean(shell), true);
  equal(/background(-color)?:/.test(shell[1]), false);
});

test("в разметке есть theme-color, который обновляет applyTheme", () => {
  equal(/<meta name="theme-color" content="#[0-9a-f]{6}">/i.test(appHtml), true);
});

// ------------------------------------------------------------------
// Акцентные свотчи: фон образца следует теме (в тёмной теме светлый
// вариант палитры выглядел темнее фактического акцента).
// ------------------------------------------------------------------
test("свотчи акцента перекрашиваются вариантом текущей темы", () => {
  const swatches = [
    { dataset: { accent: "ocean" }, style: {} },
    { dataset: { accent: "berry" }, style: {} }
  ];
  const makeDocument = (theme) => ({
    documentElement: {
      dataset: { theme },
      style: { setProperty() {}, removeProperty() {} }
    },
    querySelectorAll: (selector) => (selector === ".swatch[data-accent]" ? swatches : [])
  });
  const run = (theme) => new Function(
    "document",
    [
      'const appState = { user: { accent_color: "ocean" } };',
      extractBraced(appJs, "const ACCENT_PALETTES"),
      extractBraced(appJs, "function hexRgb"),
      extractBraced(appJs, "function shadeHex"),
      extractBraced(appJs, "function applyAccent"),
      "applyAccent();"
    ].join("\n")
  )(makeDocument(theme));

  // Тёмная тема: образцы показывают dark-варианты палитр.
  run("dark");
  equal(swatches[0].style.background, "#7fa3c0", "ocean.dark");
  equal(swatches[1].style.background, "#d97383", "berry.dark");

  // Светлая тема: light-варианты.
  run("light");
  equal(swatches[0].style.background, "#4a6f8f", "ocean.light");
  equal(swatches[1].style.background, "#b85464", "berry.light");
});
