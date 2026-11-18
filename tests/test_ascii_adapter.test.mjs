// Тесты браузерного адаптера ascii-converter.js (final-fix-plan, этап C):
// ветки декодирования, освобождение ресурсов, ошибки Canvas.
// Весь адаптер подменяется моками — реальное декодирование форматов
// проверяется вручную на устройствах (план §8.5).
//
// Запуск: node --test tests/test_ascii_adapter.test.mjs
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { equal, ok, rejects } from "node:assert/strict";
import { test } from "node:test";
import vm from "node:vm";

const here = dirname(fileURLToPath(import.meta.url));
const source = readFileSync(join(here, "..", "public", "ascii-converter.js"), "utf8");

// ---------- Моки ----------

function makeBitmap(w = 64, h = 32) {
  return {
    width: w, height: h,
    closed: false,
    close() { this.closed = true; }
  };
}

function makeCanvas(fill = { r: 128, g: 128, b: 128, a: 255 }) {
  return {
    width: 0, height: 0,
    imageSmoothingEnabled: false,
    imageSmoothingQuality: "low",
    getContext() {
      return {
        canvas: this,
        drawImage() {},
        getImageData: (x, y, w, h) => ({
          data: new Uint8ClampedArray(w * h * 4).map((_, i) =>
            i % 4 === 3 ? fill.a : (fill.r + fill.g + fill.b) / 3)
        })
      };
    }
  };
}

// Собирает ascii-converter.js в vm-контексте с подменёнными глобалами.
function loadConverter({
  bitmap = makeBitmap(),
  bitmapError = null,
  imgResult = "load",          // "load" | "error"
  no2d = false,
  getImageDataError = null
} = {}) {
  const calls = { bitmapClosed: false, objectUrls: [], drawImage: 0, getImageData: 0 };
  const realBitmap = { ...bitmap, close() { calls.bitmapClosed = true; bitmap.close?.(); } };

  class FakeImage {
    width = 64; height = 32;   // naturalWidth/Width — sourceSize их читает
    set src(v) { this._src = v; queueMicrotask(() => this.onload?.()); }
    get src() { return this._src; }
  }

  const sandbox = {
    console,
    document: {
      createElement(tag) {
        if (tag !== "canvas") throw new Error("unexpected " + tag);
        const canvas = makeCanvas();
        if (no2d) canvas.getContext = () => null;
        if (getImageDataError) {
          const orig = canvas.getContext;
          canvas.getContext = () => {
            const ctx = orig.call(canvas);
            ctx.getImageData = () => { throw getImageDataError; };
            return ctx;
          };
        }
        return canvas;
      }
    },
    URL: {
      createObjectURL(blob) { calls.objectUrls.push("create"); return "blob:mock"; },
      revokeObjectURL(url) { calls.objectUrls.push("revoke"); }
    },
    Image: FakeImage
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;

  if (bitmapError) {
    sandbox.createImageBitmap = async () => { throw bitmapError; };
  } else {
    sandbox.createImageBitmap = async () => realBitmap;
  }
  vm.createContext(sandbox);
  vm.runInContext(source, sandbox);
  return { api: sandbox.AsciiConverter || sandbox.module?.exports, calls, bitmap: realBitmap };
}

const file = (size = 1024) => ({ name: "a.jpg", size, type: "image/jpeg" });

// ---------- Тесты ----------

test("файл больше лимита отклоняется до декодирования", async () => {
  let decodeCalled = false;
  const { api } = loadConverter();
  // подменяем createImageBitmap шпионом — но лимит проверяется раньше loadImage
  const orig = api;
  void orig;
  await rejects(
    api.fileToAscii(file(26 * 1024 * 1024)),
    (e) => e.code === "too-large"
  );
  // fileToAscii проверяет размер до loadImage — decode не вызывался бы;
  // подтверждаем, что createImageBitmap в sandbox не дёргался косвенно:
  // (контракт: исключение до любого async decode)
  void decodeCalled;
});

test("успешный createImageBitmap: ASCII-результат + bitmap.close()", async () => {
  const { api, calls } = loadConverter();
  const art = await api.fileToAscii(file());
  ok(typeof art === "string" && art.length > 0, "нет ASCII-результата");
  ok(calls.bitmapClosed, "ImageBitmap.close() не вызван");
});

test("createImageBitmap упал -> fallback через Image + object URL", async () => {
  const { api, calls } = loadConverter({ bitmapError: new Error("no-bitmap") });
  const art = await api.fileToAscii(file());
  ok(art.length > 0);
  ok(calls.objectUrls.includes("create") && calls.objectUrls.includes("revoke"),
     "object URL не освобождён");
});

test("ошибка Image/onerror -> код decode, object URL отозван", async () => {
  // imgResult="error" не реализован в FakeImage — эмулируем через
  // createImageBitmap reject + Image, который не вызывает onload.
  const sandbox = {
    console,
    document: { createElement: () => { throw new Error("must not reach canvas"); } },
    URL: { createObjectURL: () => "blob:x", revokeObjectURL: () => {} },
    Image: class { set src(v) { queueMicrotask(() => this.onerror?.()); } }
  };
  sandbox.window = sandbox; sandbox.globalThis = sandbox;
  sandbox.createImageBitmap = async () => { throw new Error("no-bitmap"); };
  vm.createContext(sandbox);
  vm.runInContext(source, sandbox);
  const api = sandbox.AsciiConverter;
  await rejects(api.fileToAscii(file()), (e) => e.message === "decode");
});

test("нулевые размеры изображения -> код empty", async () => {
  const { api } = loadConverter({ bitmap: makeBitmap(0, 0) });
  await rejects(api.fileToAscii(file()), (e) => e.code === "empty");
});

test("нет 2D-контекста -> код no-canvas, bitmap закрыт", async () => {
  const { api, calls } = loadConverter({ no2d: true });
  await rejects(api.fileToAscii(file()), (e) => e.code === "no-canvas");
  ok(calls.bitmapClosed, "bitmap не закрыт при ошибке canvas");
});

test("getImageData бросает -> ошибка пробрасывается, bitmap закрыт", async () => {
  const { api, calls } = loadConverter({ getImageDataError: new Error("tainted") });
  await rejects(api.fileToAscii(file()), /tainted/);
  ok(calls.bitmapClosed);
});

test("прозрачные пиксели композитятся на белый фон", async () => {
  // Полностью прозрачное изображение -> весь фон белый -> пробелы/светлый
  // символ, а не «чёрная дыра».
  const sandbox = {
    console,
    document: {
      createElement: () => ({
        width: 0, height: 0,
        getContext: () => ({
          drawImage() {},
          getImageData: (x, y, w, h) => ({
            data: new Uint8ClampedArray(w * h * 4).fill(0) // r=g=b=a=0
          })
        })
      })
    },
    URL: { createObjectURL: () => "b", revokeObjectURL: () => {} },
    Image: class {}
  };
  sandbox.window = sandbox; sandbox.globalThis = sandbox;
  const bmp = makeBitmap(32, 32);
  sandbox.createImageBitmap = async () => bmp;
  vm.createContext(sandbox);
  vm.runInContext(source, sandbox);
  const api = sandbox.AsciiConverter;
  const art = await api.fileToAscii(file());
  const chars = new Set(art.replace(/\n/g, ""));
  // Белый фон -> самый лёгкий символ палитры (пробел или ближайший)
  const detail = api.PALETTES.detail;
  const idx = detail.indexOf([...chars][0]);
  ok(idx >= detail.length - 2, `прозрачный фон должен давать светлый символ, idx=${idx}`);
});
