// Запрет pinch-to-zoom: viewport, CSS touch-action и обработчики мультитача.
//
// Модуль public/zoom-guard.js — классический скрипт: при загрузке вешает
// слушатели на document и выставляет window.DuoPlanZoomGuard. В тесте фабрика
// исполняется с поддельным document, поэтому проверяются именно обработчики:
// что они отменяют и с какими опциями зарегистрированы.
//
// Запуск: node --test tests/test_zoom_guard.test.mjs
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { equal } from "node:assert/strict";
import { test } from "node:test";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const guardSource = readFileSync(join(root, "public/zoom-guard.js"), "utf8");
const appHtml = readFileSync(join(root, "public/app.html"), "utf8");
const appCss = readFileSync(join(root, "public/app.css"), "utf8");

// document намеренно не передан: модуль не должен требовать DOM при загрузке.
const guard = new Function("window", `${guardSource}\nreturn window.DuoPlanZoomGuard;`)({});

function fakeDocument() {
  const listeners = new Map();
  return {
    listeners,
    addEventListener(type, handler, options) {
      listeners.set(type, { handler, options });
    },
    removeEventListener(type) {
      listeners.delete(type);
    },
    fire(type, event) {
      const entry = listeners.get(type);
      if (!entry) return false;
      entry.handler(event);
      return Boolean(event.defaultPrevented);
    }
  };
}

const touchEvent = (count) => ({
  touches: Array.from({ length: count }, (_, index) => ({ identifier: index + 1 })),
  defaultPrevented: false,
  preventDefault() {
    this.defaultPrevented = true;
  }
});

const plainEvent = () => ({
  defaultPrevented: false,
  preventDefault() {
    this.defaultPrevented = true;
  }
});

test("два пальца: touchstart и touchmove отменяются", () => {
  const doc = fakeDocument();
  guard.install(doc);
  equal(doc.fire("touchstart", touchEvent(2)), true);
  equal(doc.fire("touchmove", touchEvent(2)), true);
});

test("один палец: прокрутка и тапы не блокируются", () => {
  const doc = fakeDocument();
  guard.install(doc);
  equal(doc.fire("touchstart", touchEvent(1)), false);
  equal(doc.fire("touchmove", touchEvent(1)), false);
});

test("три и более касаний тоже блокируются", () => {
  const doc = fakeDocument();
  guard.install(doc);
  equal(doc.fire("touchmove", touchEvent(3)), true);
});

test("Safari gesture-события отменяются", () => {
  const doc = fakeDocument();
  guard.install(doc);
  for (const type of ["gesturestart", "gesturechange", "gestureend"]) {
    equal(doc.fire(type, plainEvent()), true, type);
  }
});

test("Ctrl+wheel отменяется, обычный wheel — нет", () => {
  const doc = fakeDocument();
  guard.install(doc);
  const zoom = { ctrlKey: true, defaultPrevented: false, preventDefault() { this.defaultPrevented = true; } };
  equal(doc.fire("wheel", zoom), true);
  const scroll = { ctrlKey: false, defaultPrevented: false, preventDefault() { this.defaultPrevented = true; } };
  equal(doc.fire("wheel", scroll), false);
});

test("слушатели с passive: false — иначе preventDefault игнорируется", () => {
  const doc = fakeDocument();
  guard.install(doc);
  for (const type of ["touchstart", "touchmove", "gesturestart", "gesturechange", "gestureend", "wheel"]) {
    equal(doc.listeners.get(type)?.options?.passive, false, type);
  }
});

test("uninstall снимает все обработчики", () => {
  const doc = fakeDocument();
  const uninstall = guard.install(doc);
  uninstall();
  equal(doc.listeners.size, 0);
});

// ------------------------------------------------------------- статика

test("viewport приложения запрещает масштабирование", () => {
  const metas = [...appHtml.matchAll(/<meta\s+name="viewport"[^>]*>/gi)];
  equal(metas.length, 1, "viewport-тег должен быть один");
  const content = metas[0][0];
  equal(/maximum-scale=1/.test(content), true);
  equal(/user-scalable=no/.test(content), true);
  equal(/viewport-fit=cover/.test(content), true);
  equal(/width=device-width/.test(content), true);
  equal(/initial-scale=1/.test(content), true);
});

test("zoom-guard подключён до app.js", () => {
  const guardAt = appHtml.indexOf("/zoom-guard.js");
  const appAt = appHtml.indexOf("/app.js");
  equal(guardAt > 0, true);
  equal(appAt > guardAt, true);
});

test("корень не отдаёт pinch-zoom, но оставляет прокрутку", () => {
  const rule = appCss.match(/html\s*\{[^}]*touch-action:\s*([^;]+);/);
  equal(Boolean(rule), true);
  equal(rule[1].trim(), "pan-x pan-y");
});

test("панель навигации сохраняет свой touch-action", () => {
  const rule = appCss.match(/\.bottom-nav\s*\{[^}]*touch-action:\s*([^;]+);/);
  equal(Boolean(rule), true);
  equal(rule[1].trim(), "pan-y");
});
