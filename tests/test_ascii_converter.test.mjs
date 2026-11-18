// Unit-тесты чистой логики ascii-converter.js: палитры, fitSize,
// pixelsToAscii, validateResult. Браузерный адаптер (Canvas/ImageBitmap)
// здесь не трогаем — он проверяется вручную в WebView (план §9.1).
//
// Запуск: node --test tests/test_ascii_converter.test.mjs
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { deepStrictEqual, equal, ok } from "node:assert/strict";
import { test } from "node:test";
import vm from "node:vm";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const source = readFileSync(join(root, "public", "ascii-converter.js"), "utf8");

const sandbox = { window: {}, module: { exports: {} }, console };
vm.createContext(sandbox);
vm.runInContext(source, sandbox);
const C = sandbox.window.AsciiConverter || sandbox.module.exports;

const { PALETTES, PALETTE_KEYS, LIMITS, fitSize, pixelsToAscii, validateResult } = C;

// RGBA-пиксели: все чёрные / все белые / градиент
function solidPixels(w, h, r, g, b) {
  const px = new Uint8ClampedArray(w * h * 4);
  for (let i = 0; i < px.length; i += 4) {
    px[i] = r; px[i + 1] = g; px[i + 2] = b; px[i + 3] = 255;
  }
  return px;
}

test("палитры: порядок от плотного к светлому, без смешения ASCII и блоков", () => {
  ok(PALETTES.detail.length > 10, "detail должна быть расширенной градацией");
  // Первый символ detail — самый плотный (не пробел и не точка)
  ok(PALETTES.detail[0] !== " " && PALETTES.detail[0] !== ".");
  // Последний — пробел или самый лёгкий символ
  equal(PALETTES.detail[PALETTES.detail.length - 1], " ");
  // classic — классическая Bourke градация
  equal(PALETTES.classic, "@%#*+=-:. ");
  // blocks — только unicode-блоки, не смешана с ASCII-градацией
  ok([...PALETTES.blocks].every((c) => "█▓▒░ ".includes(c)));
  ok(!PALETTES.blocks.includes("@") && !PALETTES.blocks.includes("#"));
  // detail не должен содержать unicode-блоки (они ломают градацию)
  ok(!/[█▓▒░]/.test(PALETTES.detail));
});

test("fitSize: вписывает в 48x40 с пропорциями, оба ограничения соблюдены", () => {
  const wide = fitSize(1600, 900, 48, 40);
  ok(wide.cols <= 48 && wide.rows <= 40);
  ok(wide.cols > 0 && wide.rows > 0);
  const tall = fitSize(900, 1600, 48, 40);
  ok(tall.cols <= 48 && tall.rows <= 40);
  ok(tall.cols < wide.cols, "портрет должен дать меньше столбцов");
});

test("fitSize: нулевые размеры -> 0x0", () => {
  // Объекты из vm-контекста имеют другой prototype — сравниваем поля.
  const a = fitSize(0, 100, 48, 40);
  const b = fitSize(100, 0, 48, 40);
  equal(a.cols, 0); equal(a.rows, 0);
  equal(b.cols, 0); equal(b.rows, 0);
});

test("pixelsToAscii: чёрный -> самый плотный символ, белый -> пробел", () => {
  const black = pixelsToAscii(solidPixels(10, 10, 0, 0, 0), 10, 10, { palette: "detail", cols: 4, rows: 4 });
  const blackChars = [...black.replace(/\n/g, "")];
  ok(blackChars.every((c) => c === PALETTES.detail[0]), `чёрный должен давать ${PALETTES.detail[0]}, получили ${blackChars[0]}`);

  const white = pixelsToAscii(solidPixels(10, 10, 255, 255, 255), 10, 10, { palette: "detail", cols: 4, rows: 4 });
  ok(white.split("\n").every((row) => row.trim() === ""), "белый должен давать пробелы");
});

test("pixelsToAscii: градации идут в правильном направлении", () => {
  // Горизонтальный градиент чёрный->белый: слева плотные, справа лёгкие
  const w = 40, h = 10;
  const px = new Uint8ClampedArray(w * h * 4);
  for (let x = 0; x < w; x++) {
    const v = Math.round((x / (w - 1)) * 255);
    for (let y = 0; y < h; y++) {
      const i = (y * w + x) * 4;
      px[i] = v; px[i + 1] = v; px[i + 2] = v; px[i + 3] = 255;
    }
  }
  const art = pixelsToAscii(px, w, h, { palette: "detail", cols: 20, rows: 5 });
  const rows = art.split("\n");
  const first = rows[0];
  const last = rows[0];
  const leftIdx = PALETTES.detail.indexOf(first[0]);
  const rightIdx = PALETTES.detail.indexOf(first[first.length - 1]);
  ok(leftIdx < rightIdx, `слева должен быть плотнее (${leftIdx} < ${rightIdx})`);
});

test("pixelsToAscii: invert переворачивает градацию", () => {
  const px = solidPixels(10, 10, 0, 0, 0);
  const normal = pixelsToAscii(px, 10, 10, { palette: "classic", cols: 2, rows: 2 });
  const inverted = pixelsToAscii(px, 10, 10, { palette: "classic", cols: 2, rows: 2, invert: true });
  const nChar = normal[0];
  const iChar = inverted[0];
  ok(nChar === "@" && iChar === " ", `инверсия: @->пробел, получили ${nChar}/${iChar}`);
});

test("pixelsToAscii: результат всегда в лимитах API", () => {
  const px = solidPixels(200, 200, 128, 128, 128);
  for (const palette of PALETTE_KEYS) {
    const art = pixelsToAscii(px, 200, 200, { palette });
    const check = validateResult(art);
    ok(check.ok, `${palette}: ${check.reason}`);
    ok(art.split("\n").length <= LIMITS.maxRows);
    ok(Math.max(...art.split("\n").map((r) => [...r].length)) <= LIMITS.maxColumns);
  }
});

test("validateResult: отклоняет пустое и превышения", () => {
  equal(validateResult("").ok, false);
  equal(validateResult("   \n   ").ok, true); // пробелы — валидный (серый) арт
  equal(validateResult("x".repeat(LIMITS.maxColumns + 1)).ok, false);
  equal(validateResult(Array(LIMITS.maxRows + 1).fill("x").join("\n")).ok, false);
});

test("adjustBrightness: контраст и яркость в ожидаемом направлении", () => {
  const { adjustBrightness } = C;
  const mid = 128;
  ok(adjustBrightness(mid, 0, 0) === mid);
  ok(adjustBrightness(mid, 50, 0) > mid, "яркость + двигает вверх");
  ok(adjustBrightness(mid, -50, 0) < mid);
  ok(adjustBrightness(200, 0, 50) > 200, "контраст + усиливает светлое");
  ok(adjustBrightness(50, 0, 50) < 50, "контраст + затемняет тёмное");
  ok(adjustBrightness(255, 100, 0) <= 255, "clamp сверху");
  ok(adjustBrightness(0, -100, 0) >= 0, "clamp снизу");
});

test("pixelsToAscii: box-усреднение — шахматка чёрный/белый даёт средний символ", () => {
  // 2x2: чёрный, белый / белый, чёрный. Средняя яркость ~127 -> средний
  // символ палитры. Выбор одного пикселя давал бы крайние символы.
  const px = new Uint8ClampedArray(2 * 2 * 4);
  const set = (x, y, v) => { const i = (y * 2 + x) * 4; px[i] = px[i+1] = px[i+2] = v; px[i+3] = 255; };
  set(0, 0, 0); set(1, 0, 255); set(0, 1, 255); set(1, 1, 0);
  const art = pixelsToAscii(px, 2, 2, { palette: "detail", cols: 1, rows: 1, contrast: 0, brightness: 0 });
  const ch = art[0];
  const idx = PALETTES.detail.indexOf(ch);
  ok(idx > 0 && idx < PALETTES.detail.length - 1,
     `ожидался средний символ, получен idx=${idx} char=${JSON.stringify(ch)}`);
});

test("pixelsToAscii: контрастная граница — левая половина плотная, правая светлая", () => {
  const w = 20, h = 10;
  const px = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const v = x < w / 2 ? 0 : 255;
    const i = (y * w + x) * 4;
    px[i] = px[i+1] = px[i+2] = v; px[i+3] = 255;
  }
  const art = pixelsToAscii(px, w, h, { palette: "classic", cols: 10, rows: 5, contrast: 0 });
  const row = art.split("\n")[0];
  const leftIdx = PALETTES.classic.indexOf(row[0]);
  const rightIdx = PALETTES.classic.indexOf(row[row.length - 1]);
  ok(leftIdx < rightIdx, `граница: слева idx=${leftIdx}, справа idx=${rightIdx}`);
});

test("pixelsToAscii: однородная область любого цвета даёт один символ на всю сетку", () => {
  const px = solidPixels(8, 8, 100, 100, 100);
  const art = pixelsToAscii(px, 8, 8, { palette: "blocks", cols: 4, rows: 3, contrast: 0 });
  const chars = new Set(art.replace(/\n/g, ""));
  equal(chars.size, 1);
});

test("fitSize: физические пропорции соответствуют исходнику (fix-plan P1)", () => {
  // ratio=0.5: физическое соотношение сетки = (cols*0.5)/rows.
  // Целочисленная сетка допускает отклонение — проверяем в пределах 15%
  // либо точное совпадение, когда ограничение maxRows не сработало.
  const RATIO = 0.5;
  for (const [w, h] of [[1600, 900], [900, 1600], [1000, 1000], [4000, 1000], [800, 800], [500, 3000]]) {
    const { cols, rows } = fitSize(w, h, 48, 40);
    ok(cols > 0 && rows > 0 && cols <= 48 && rows <= 40, `${w}x${h}: ${cols}x${rows}`);
    const phys = (cols * RATIO) / rows;
    const src = w / h;
    const relErr = Math.abs(phys - src) / src;
    // Допуск: не более одного «пикселя» сетки по каждой оси.
    ok(relErr < 0.25, `${w}x${h}: phys=${phys.toFixed(3)} src=${src.toFixed(3)} err=${(relErr*100).toFixed(0)}%`);
  }
});

test("fitSize: квадрат остаётся квадратным, портрет — вертикальным", () => {
  const sq = fitSize(1000, 1000, 48, 40);
  ok(Math.abs((sq.cols * 0.5) / sq.rows - 1) < 0.1, `квадрат: ${sq.cols}x${sq.rows}`);
  const port = fitSize(900, 1600, 48, 40);
  ok((port.cols * 0.5) / port.rows < 0.7, `портрет не должен быть шире высоты: ${port.cols}x${port.rows}`);
  const land = fitSize(1600, 900, 48, 40);
  ok((land.cols * 0.5) / land.rows > 1.2, `альбом не должен быть выше ширины: ${land.cols}x${land.rows}`);
});
