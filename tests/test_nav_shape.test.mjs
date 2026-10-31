// Геометрия капли при вытяжении пальцем (public/nav.js) — регрессия TDZ.
//
// Репорт аудита 2026-10-31: блок сплющивания читал `cy` до объявления
// (`const cy = ... + squashShift` ниже), и любой drag с |dy| > 8px ронял
// dropletShape с ReferenceError, убивая rAF-цикл. Тест извлекает реальный
// dropletShape и гоняет драги по всем осям.
//
// Запуск: node --test tests/test_nav_shape.test.mjs
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { ok } from "node:assert/strict";
import { test } from "node:test";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const source = readFileSync(join(root, "public/nav.js"), "utf8");

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

const CONSTANTS = ["STRETCH_ZONE", "STRETCH_RANGE", "SQUASH_H", "SQUASH_W", "PULL_SHIFT",
  "SIZE_W", "SIZE_H", "SIZE_EXTRA_W", "MAX_SPEED", "MAX_LEAD", "MAX_TRAIL",
  "MAX_SQUASH", "MAX_SHIFT", "REST_NARROW", "IMPACT_GAIN", "IMPACT_PINCH"];

const preamble = [
  ...CONSTANTS.map((n) => extractLine(`const ${n}`)),
  "const clamp = (v, a, b) => Math.min(Math.max(v, a), b);",
  "const round2 = (v) => Math.round(v * 100) / 100;",
  extractBraced("function dropletShape"),
  "const geom = { slotW: 97.6, inner: { x: 5, y: 5, h: 52, w: 488 }, height: 62 };"
].join("\n");

const load = new Function(
  [
    preamble,
    "const state = { impact: 0, reduced: false, geom };",
    "function shapeFor(drag, impact) { state.drag = drag; state.impact = impact || 0; const s = dropletShape(100, 0, 1); state.drag = null; return s; }",
    "function extentOf(s) {",
    "  const ys = [...s.d.matchAll(/,-?[\\d.]+/g)].map((m) => Number(m[0].slice(1)));",
    "  const xs = [...s.d.matchAll(/-?[\\d.]+,/g)].map((m) => Number(m[0].slice(0, -1)));",
    "  return { top: Math.min(...ys), bottom: Math.max(...ys), left: Math.min(...xs), right: Math.max(...xs) };",
    "}",
    "return { shapeFor, extentOf, geom };"
  ].join("\n")
);
const { shapeFor, extentOf, geom } = load();

test("drag по вертикали больше не роняет dropletShape (регрессия TDZ)", () => {
  for (const dy of [40, -40, 200, -200, 0, 9, -9]) {
    let shape;
    try {
      shape = shapeFor({ dy });
    } catch (error) {
      ok(false, `dy=${dy}: ${error.message}`);
      return;
    }
    ok(shape.d.length > 20, `dy=${dy}: пустой контур`);
  }
});

test("при вытяжении капля остаётся в границах бара", () => {
  for (const dy of [40, -40, 200, -200]) {
    const ext = extentOf(shapeFor({ dy }));
    ok(ext.top >= -0.6, `dy=${dy}: yT ${ext.top} вышел за верх бара`);
    ok(ext.bottom <= geom.height + 0.6, `dy=${dy}: yB ${ext.bottom} вышел за низ бара`);
  }
});

test("сплющивание растёт с натяжением: капля ниже и шире, чем без вытяжения", () => {
  const calm = extentOf(shapeFor({ dy: 0 }));
  const pulled = extentOf(shapeFor({ dy: 200 }));
  const height = (e) => e.bottom - e.top;
  const width = (e) => e.right - e.left;
  ok(height(pulled) < height(calm), "высота не уменьшилась при вытяжении");
  ok(width(pulled) > width(calm), "ширина не растекла при вытяжении");
});

test("прилунение (impact) поднимает каплю по вертикали и не ломает контур", () => {
  const shape = shapeFor(null, 0.8);
  const ext = extentOf(shape);
  ok(ext.bottom - ext.top > geom.inner.h, "impact не увеличил высоту");
  ok(ext.bottom - ext.top < geom.height * 1.1, "impact раздул каплю за пределы бара");
});
