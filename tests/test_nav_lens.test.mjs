// Док: статичные иконки и подписи + линза капли с перекраской по накрытию.
//
// Правила, которые держим:
//   1) в доке меняется ТОЛЬКО цвет — никакого масштаба при нажатии, сдвигов
//      и фильтров; геометрия вкладки неизменна всегда;
//   2) контент внутри капли увеличивается (линза), у краёв ловится перспектива;
//   3) вкладка красится не «включилась/выключилась», а пропорционально доле,
//      накрытой каплей.
//
// Запуск: node --test tests/test_nav_lens.test.mjs
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { equal, ok, match } from "node:assert/strict";
import { test } from "node:test";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const source = readFileSync(join(root, "public", "nav.js"), "utf8");
const appCss = readFileSync(join(root, "public", "app.css"), "utf8");

const factory = new Function("window", `${source}\nreturn window.createLiquidNav;`)({});
const { parseColor, mixColor, coverageOf } = factory.lens;

const ruleFor = (selector) => {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const found = appCss.match(new RegExp(`^${escaped}\\s*\\{([^}]*)\\}`, "m"));
  return found ? found[1] : "";
};

// --------------------------------------------------------------- цвет

test("цвет разбирается из hex и rgb()", () => {
  equal(JSON.stringify(parseColor("#766e68")), "[118,110,104]");
  equal(JSON.stringify(parseColor("#b85464")), "[184,84,100]");
  equal(JSON.stringify(parseColor("#fff")), "[255,255,255]");
  equal(JSON.stringify(parseColor("rgb(1, 2, 3)")), "[1,2,3]");
  equal(JSON.stringify(parseColor("rgba(10, 20, 30, 0.5)")), "[10,20,30]");
  equal(parseColor(""), null);
  equal(parseColor("не цвет"), null);
});

test("смешение идёт от обычного цвета к акцентному", () => {
  const idle = [118, 110, 104];
  const accent = [184, 84, 100];
  equal(mixColor(idle, accent, 0), "rgb(118, 110, 104)");
  equal(mixColor(idle, accent, 1), "rgb(184, 84, 100)");
  equal(mixColor(idle, accent, 0.5), "rgb(151, 97, 102)");
  // Выход за границы зажимается: цвет не должен «перелиться» в мусор.
  equal(mixColor(idle, accent, -3), "rgb(118, 110, 104)");
  equal(mixColor(idle, accent, 4), "rgb(184, 84, 100)");
});

test("доля накрытия вкладки считается по горизонтальному отрезку", () => {
  const rect = { left: 100, right: 200, width: 100 };
  equal(coverageOf({ left: 100, right: 200 }, rect), 1);
  equal(coverageOf({ left: 150, right: 200 }, rect), 0.5);
  equal(coverageOf({ left: 50, right: 300 }, rect), 1);
  equal(coverageOf({ left: 200, right: 300 }, rect), 0);
  equal(coverageOf({ left: 0, right: 100 }, rect), 0);
  equal(coverageOf({ left: 100, right: 200 }, { left: 100, right: 100, width: 0 }), 0);
  equal(coverageOf(null, rect), 0);
});

// --------------------------------------------------------------- статика дока

test("нажатие на вкладку ничего не увеличивает", () => {
  ok(!/^\.nav-item:active\s*\{/m.test(appCss), "правила .nav-item:active быть не должно");
  ok(!/transform:\s*scale/.test(ruleFor(".nav-item")), "у вкладки нет масштаба");
});

test("иконка статична: размер задан, масштаба нет", () => {
  const rule = ruleFor(".nav-icon");
  match(rule, /transform:\s*none/);
  ok(!/scale\(/.test(rule));
});

test("активная вкладка не меняет начертание — подпись не прыгает", () => {
  ok(!/font-weight/.test(ruleFor(".nav-item.is-active")), "font-weight сдвигал бы текст");
});

test("переходы только по цвету", () => {
  const rule = ruleFor(".nav-item");
  match(rule, /transition:\s*color/);
  ok(!/transform/.test(rule.split("transition:")[1] || ""), "transform в transition не нужен");
});

// --------------------------------------------------------------- линза

test("линза сделана трансформацией вкладки, без копии контента", () => {
  // Копия + SVG-маска ломались в WebView: маска не применялась, слой накрывал
  // панель и красил все вкладки акцентом. Теперь копии нет вообще.
  ok(!/cloneNode/.test(source), "копии контента быть не должно");
  ok(!/\.style\.mask/.test(source), "маски быть не должно");
  ok(!/nav-lens/.test(source));
  ok(!/nav-lens/.test(appCss), "правил .nav-lens быть не должно");
});

test("вкладка под каплей увеличивается, у краёв ловится перспектива", () => {
  match(source, /function applyItems\(shape\)/);
  match(source, /const scale = 1 \+ boost \* ratio;/);
  match(source, /const tilt = -offset \* LENS_TILT \* ratio/);
  match(source, /perspective\(\$\{LENS_PERSPECTIVE\}px\) rotateY/);
  // В покое — чистый 2D-scale: иначе 3D-контекст мылит иконку.
  match(source, /Math\.abs\(tilt\) < 0\.05/);
});

test("акцент получает только вкладка под каплей", () => {
  match(source, /const isLeader = index === leader && leaderRatio > LEADER_MIN;/);
  match(source, /const color = isLeader\s*\? mixColor\(state\.palette\.idle, state\.palette\.accent, ratio\)\s*: idle;/);
  match(source, /const idle = mixColor\(state\.palette\.idle, state\.palette\.accent, 0\);/);
});

test("увеличенная вкладка не искажает замер рамок", () => {
  // Перед замером трансформация снимается, иначе getBoundingClientRect()
  // вернул бы увеличенный прямоугольник и сбил расчёт накрытия.
  match(source, /for \(const item of items\) item\.style\.transform = "";/);
});

test("цвета вкладок читаются из CSS-переменных панели", () => {
  match(source, /getPropertyValue\("--muted"\)/);
  match(source, /getPropertyValue\("--berry"\)/);
});
