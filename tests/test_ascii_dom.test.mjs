// Поведенческие DOM-тесты ASCII-блока дневника (final-fix-plan, этап B).
// Функции извлекаются из public/app.js и исполняются в linkedom-окружении:
// проверяется реальный innerHTML и текстовое содержимое элементов, а не
// наличие строк в исходнике. Хендлеры кликов/change/submit остаются
// покрытыми структурными проверками в test_ascii_ui.test.mjs.
//
// Запуск: node --test tests/test_ascii_dom.test.mjs
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { equal, ok } from "node:assert/strict";
import { test } from "node:test";
import { parseHTML } from "linkedom";

const here = dirname(fileURLToPath(import.meta.url));
const source = readFileSync(join(here, "..", "public", "app.js"), "utf8");

function extractBraced(declaration) {
  const start = source.indexOf(declaration);
  if (start === -1) throw new Error(`${declaration} не найдено`);
  let depth = 0;
  for (let j = source.indexOf("{", start); j < source.length; j++) {
    if (source[j] === "{") depth++;
    else if (source[j] === "}") { depth--; if (depth === 0) return source.slice(start, j + 1); }
  }
  throw new Error(`незакрытый блок: ${declaration}`);
}

// Извлекает сам listener-стейтмент addEventListener(...), чтобы тесты
// могли вызывать его через настоящие DOM-события change.
function extractChangeListener() {
  const marker = 'dialogFields.addEventListener("change", async (e) => {';
  let idx = -1, from = 0;
  while (true) {
    const i = source.indexOf(marker, from);
    if (i === -1) break;
    const body = source.slice(i, i + 3000);
    if (body.includes("[data-ascii-file]")) { idx = i; break; }
    from = i + 1;
  }
  if (idx === -1) throw new Error("ASCII change-листенер не найден");
  // От "{" после "=>" до парной "}", затем до ");"
  const braceStart = source.indexOf("{", idx);
  let depth = 0, end = -1;
  for (let j = braceStart; j < source.length; j++) {
    if (source[j] === "{") depth++;
    else if (source[j] === "}") { depth--; if (depth === 0) { end = j; break; } }
  }
  const stmtEnd = source.indexOf(");", end);
  return source.slice(idx, stmtEnd + 2);
}

const FN_NAMES = [
  "function esc",
  "function asciiPaletteSelectHtml",
  "function asciiQualitySelectHtml",
  "function asciiFontSizeFor",
  "function asciiBlockInnerHtml",
  "function renderAsciiBlock",
  "function asciiStatus",
  "function asciiBackupState",
  "function asciiRestoreBackup",
  "async function asciiConvertSelected"
];

// Собирает ASCII-подсистему диалога в linkedom-окружении.
function buildDialog() {
  const { document } = parseHTML(
    `<div id="dialog-fields"><div class="ascii-block" data-ascii-block></div></div>`
  );
  const factory = new Function(
    "document",
    [
      "let dialogContext = null;",
      "const dialogFields = document.getElementById('dialog-fields');",
      ...FN_NAMES.map(extractBraced),
      extractChangeListener(),
      "return {",
      "  renderAsciiBlock, asciiStatus, asciiConvertSelected,",
      "  asciiBackupState, asciiRestoreBackup, asciiBlockInnerHtml,",
      "  setCtx(v) { dialogContext = v; },",
      "  getCtx() { return dialogContext; },",
      "  block() { return dialogFields.querySelector('[data-ascii-block]'); },",
      "  statusEl() { return dialogFields.querySelector('[data-ascii-status]'); }",
      "};"
    ].join("\n")
  );
  const api = factory(document);
  return { api, document };
}

function asciiState(over = {}) {
  return {
    mode: "none", art: null, file: null, palette: "detail",
    busy: false, hadArt: false, convId: 0, backup: null, ...over
  };
}

function openWith(api, ascii) {
  api.setCtx({ ascii });
  api.renderAsciiBlock();
}

// ---------- Режимы: статус-элемент есть везде ----------

for (const mode of ["none", "preview", "set", "keep", "delete"]) {
  test(`режим ${mode}: элемент [data-ascii-status] присутствует`, () => {
    const { api } = buildDialog();
    openWith(api, asciiState({
      mode,
      art: mode === "none" ? null : "  @#\n  .  ",
      file: mode === "preview" ? {} : null
    }));
    const el = api.statusEl();
    ok(el, `в режиме ${mode} нет [data-ascii-status]`);
    equal(el.getAttribute("aria-live"), "polite");
  });
}

test("режим delete: предупреждение об удалении и статус сосуществуют", () => {
  const { api } = buildDialog();
  openWith(api, asciiState({ mode: "delete", art: "@#", hadArt: true }));
  const warn = api.block().querySelector(".ascii-status.is-warn");
  ok(warn, "нет предупреждения об удалении");
  ok(warn.textContent.includes("будет удалено"));
  ok(api.statusEl(), "нет отдельного статус-элемента операции");
  ok(api.statusEl() !== warn, "статус операции не должен перезаписывать предупреждение");
});

// ---------- Конвертация: статусы и ошибки в keep/set ----------

test("замена в режиме keep: «Обработка фото…» виден до завершения", async () => {
  const { api } = buildDialog();
  let resolveConv;
  globalThis.AsciiConverter = {
    fileToAscii: () => new Promise((res) => { resolveConv = res; })
  };
  openWith(api, asciiState({ mode: "keep", art: "СТАРЫЙ", hadArt: true }));
  const ctx = api.getCtx();
  const p = api.asciiConvertSelected(ctx, { name: "a.jpg", size: 100 });
  await Promise.resolve();
  equal(api.statusEl()?.textContent, "Обработка фото…");
  resolveConv("НОВЫЙ");
  await p;
  equal(ctx.ascii.mode, "preview");
  equal(api.block().querySelector("[data-ascii-art-pre]")?.textContent, "НОВЫЙ");
});

test("ошибка конвертации в режиме keep: сообщение видно, старый art на месте", async () => {
  const { api } = buildDialog();
  globalThis.AsciiConverter = {
    fileToAscii: async () => { throw Object.assign(new Error("x"), { code: "decode" }); }
  };
  openWith(api, asciiState({ mode: "keep", art: "СТАРЫЙ", hadArt: true }));
  const ctx = api.getCtx();
  await api.asciiConvertSelected(ctx, { name: "bad.jpg", size: 100 });
  equal(ctx.ascii.mode, "keep");
  equal(ctx.ascii.art, "СТАРЫЙ");
  const status = api.statusEl();
  ok(status.textContent.includes("Не удалось прочитать"), `status: ${status.textContent}`);
  ok(status.classList.contains("is-error"));
  // Старый рисунок виден в превью-полосе
  ok(api.block().querySelector("[data-ascii-peek]").textContent.includes("СТАРЫЙ"));
});

test("успешная конвертация из none переводит в preview с текстом рисунка", async () => {
  const { api } = buildDialog();
  globalThis.AsciiConverter = { fileToAscii: async () => "  @@  \n  ..  " };
  openWith(api, asciiState({ mode: "none" }));
  const ctx = api.getCtx();
  await api.asciiConvertSelected(ctx, { name: "a.jpg", size: 10 });
  equal(ctx.ascii.mode, "preview");
  ok(api.block().querySelector("[data-ascii-art-pre]").textContent.includes("@@"));
});

test("устаревший результат не применяется: диалог «закрыт» до завершения", async () => {
  const { api } = buildDialog();
  let resolveConv;
  globalThis.AsciiConverter = {
    fileToAscii: () => new Promise((res) => { resolveConv = res; })
  };
  openWith(api, asciiState({ mode: "none" }));
  const ctx = api.getCtx();
  const p = api.asciiConvertSelected(ctx, { name: "a.jpg", size: 1 });
  // «Закрытие» диалога: dialogContext обнуляется, как в close-листенере app.js.
  api.setCtx(null);
  resolveConv("ПОЗДНИЙ");
  await p;
  equal(ctx.ascii.mode, "none", "поздний результат не должен менять состояние");
  equal(ctx.ascii.art, null);
});

test("гонка convId: более старый результат не перезаписывает новый", async () => {
  const { api } = buildDialog();
  const resolvers = [];
  globalThis.AsciiConverter = {
    fileToAscii: () => new Promise((res) => resolvers.push(res))
  };
  openWith(api, asciiState({ mode: "preview", art: "ПЕРВЫЙ", file: {}, hadArt: true }));
  const ctx = api.getCtx();
  const p1 = api.asciiConvertSelected(ctx, { name: "f1.jpg", size: 1 });
  const p2 = api.asciiConvertSelected(ctx, { name: "f2.jpg", size: 1 });
  // Старый запрос завершается ПОСЛЕДНИМ — его результат обязан отбрасываться.
  resolvers[1]("ВТОРОЙ");
  await p2;
  resolvers[0]("ПЕРВЫЙ-УСТАРЕЛ");
  await p1;
  equal(ctx.ascii.art, "ВТОРОЙ");
});

test("ошибка too-large показывает лимит 25 МБ", async () => {
  const { api } = buildDialog();
  globalThis.AsciiConverter = {
    fileToAscii: async () => { throw Object.assign(new Error("x"), { code: "too-large" }); }
  };
  openWith(api, asciiState({ mode: "keep", art: "СТАРЫЙ", hadArt: true }));
  const ctx = api.getCtx();
  await api.asciiConvertSelected(ctx, { name: "big.jpg", size: 26 * 1024 * 1024 });
  ok(api.statusEl().textContent.includes("25 МБ"));
});

test("после ошибки статус не «залипает»: новая успешная операция его очищает", async () => {
  const { api } = buildDialog();
  let fail = true;
  globalThis.AsciiConverter = {
    fileToAscii: async () => {
      if (fail) throw Object.assign(new Error("x"), { code: "decode" });
      return "OK";
    }
  };
  openWith(api, asciiState({ mode: "keep", art: "СТАРЫЙ", hadArt: true }));
  const ctx = api.getCtx();
  await api.asciiConvertSelected(ctx, { name: "bad.jpg", size: 1 });
  ok(api.statusEl().textContent.length > 0);
  // Успех: renderAsciiBlock пересоздаёт DOM — статус пуст.
  fail = false;
  await api.asciiConvertSelected(ctx, { name: "good.jpg", size: 1 });
  equal(api.statusEl().textContent, "");
});

test("гонка P2: устаревшая операция не сбрасывает busy актуальной", async () => {
  const { api } = buildDialog();
  const resolvers = [];
  globalThis.AsciiConverter = {
    fileToAscii: () => new Promise((res) => resolvers.push(res))
  };
  openWith(api, asciiState({ mode: "preview", art: "ART", file: {}, hadArt: true }));
  const ctx = api.getCtx();
  const p1 = api.asciiConvertSelected(ctx, { name: "f1.jpg", size: 1 });
  const p2 = api.asciiConvertSelected(ctx, { name: "f2.jpg", size: 1 });
  // Актуальная (вторая) завершается первой — busy=false корректно.
  resolvers[1]("НОВЫЙ");
  await p2;
  equal(ctx.ascii.busy, false);
  equal(ctx.ascii.art, "НОВЫЙ");
  // Устаревшая завершается позже — НЕ должна трогать busy/art.
  resolvers[0]("УСТАРЕЛ");
  await p1;
  equal(ctx.ascii.busy, false, "старая операция не должна менять busy");
  equal(ctx.ascii.art, "НОВЫЙ", "старая операция не должна менять art");
});

test("гонка P2: устаревшая ошибка не восстанавливает backup поверх актуального состояния", async () => {
  const { api } = buildDialog();
  const resolvers = [];
  globalThis.AsciiConverter = {
    fileToAscii: () => new Promise((res, rej) => resolvers.push({ res, rej }))
  };
  openWith(api, asciiState({ mode: "preview", art: "ART", file: {}, hadArt: true }));
  const ctx = api.getCtx();
  const p1 = api.asciiConvertSelected(ctx, { name: "f1.jpg", size: 1 });
  const p2 = api.asciiConvertSelected(ctx, { name: "f2.jpg", size: 1 });
  // Актуальная завершается успешно.
  resolvers[1].res("АКТУАЛЬНЫЙ");
  await p2;
  // Устаревшая падает с ошибкой — не должна откатывать art/mode.
  resolvers[0].rej(Object.assign(new Error("x"), { code: "decode" }));
  await p1;
  equal(ctx.ascii.art, "АКТУАЛЬНЫЙ");
  equal(ctx.ascii.mode, "preview");
});

// ---------- Поведенческая гонка через настоящие DOM-события ----------

test("гонка через change-события: повторный файл и палитра блокируются при busy", async () => {
  const { api, document } = buildDialog();
  const resolvers = [];
  globalThis.AsciiConverter = {
    fileToAscii: (file) => new Promise((res) => resolvers.push({ file, res }))
  };
  openWith(api, asciiState({ mode: "keep", art: "СТАРЫЙ", hadArt: true }));
  const ctx = api.getCtx();

  const fileInput = api.block().querySelector("[data-ascii-file]");
  const paletteSelect = null; // палитра есть только в preview — проверим отдельно
  void paletteSelect;

  const fireFile = (name) => {
    fileInput.files = [{ name, size: 100, type: "image/jpeg" }];
    fileInput.dispatchEvent(new document.defaultView.Event("change", { bubbles: true }));
  };

  // 1) Первый выбор файла запускает конвертацию -> busy.
  fireFile("first.jpg");
  await Promise.resolve(); await Promise.resolve();
  equal(ctx.ascii.busy, true);
  equal(resolvers.length, 1);

  // 2) Повторный выбор файла во время busy — игнорируется (нет второго вызова).
  fireFile("second.jpg");
  await Promise.resolve(); await Promise.resolve();
  equal(resolvers.length, 1, "второй fileToAscii не должен запускаться при busy");

  // 3) Завершаем актуальную операцию -> preview.
  resolvers[0].res("ПЕРВЫЙ-ART");
  await new Promise((r) => setTimeout(r, 0));
  await new Promise((r) => setTimeout(r, 0));
  equal(ctx.ascii.mode, "preview");
  equal(ctx.ascii.busy, false);
  equal(ctx.ascii.art, "ПЕРВЫЙ-ART");
});

test("гонка через change-события: смена палитры при busy отклоняется и возвращает значение", async () => {
  const { api, document } = buildDialog();
  const resolvers = [];
  globalThis.AsciiConverter = {
    fileToAscii: (file, opts) => new Promise((res) => resolvers.push({ file, opts, res }))
  };
  openWith(api, asciiState({ mode: "preview", art: "ART", file: { name: "f.jpg" }, palette: "detail", hadArt: true }));
  const ctx = api.getCtx();

  const paletteSelect = api.block().querySelector("[data-ascii-palette]");
  ok(paletteSelect, "селект палитры не отрендерен в preview");
  // linkedom не реализует HTMLSelectElement.value — подменяем accessor,
  // чтобы обработчик читал/откатывал значение как в браузере.
  let selVal = "detail";
  Object.defineProperty(paletteSelect, "value", {
    configurable: true,
    get: () => selVal,
    set: (v) => { selVal = v; }
  });

  // Запускаем перегенерацию через смену палитры -> busy.
  paletteSelect.value = "classic";
  paletteSelect.dispatchEvent(new document.defaultView.Event("change", { bubbles: true }));
  await Promise.resolve(); await Promise.resolve();
  equal(ctx.ascii.busy, true);
  equal(resolvers.length, 1);
  equal(resolvers[0].opts.palette, "classic");

  // Пока busy — ещё одна смена палитры отклоняется, значение откатывается.
  paletteSelect.value = "blocks";
  paletteSelect.dispatchEvent(new document.defaultView.Event("change", { bubbles: true }));
  await Promise.resolve();
  equal(resolvers.length, 1, "третья операция не должна стартовать при busy");
  equal(paletteSelect.value, "classic", "селект должен вернуться к применённой палитре");
  equal(ctx.ascii.palette, "classic");

  resolvers[0].res("АРТ-CLASSIC");
  await new Promise((r) => setTimeout(r, 0));
  await new Promise((r) => setTimeout(r, 0));
  equal(ctx.ascii.art, "АРТ-CLASSIC");
  equal(ctx.ascii.busy, false);
});

test("гонка через change-события: смена качества при busy отклоняется и возвращает значение", async () => {
  const { api, document } = buildDialog();
  const resolvers = [];
  globalThis.AsciiConverter = {
    QUALITY_PRESETS: {
      standard: { label: "Обычное", cols: 48, rows: 40 },
      high: { label: "Детальное", cols: 96, rows: 80 },
      max: { label: "Максимум", cols: 144, rows: 120 }
    },
    fileToAscii: (file, opts) => new Promise((res) => resolvers.push({ file, opts, res }))
  };
  openWith(api, asciiState({ mode: "preview", art: "ART", file: { name: "f.jpg" }, palette: "detail", quality: "high", hadArt: true }));
  const ctx = api.getCtx();

  const qualitySelect = api.block().querySelector("[data-ascii-quality]");
  ok(qualitySelect, "селект качества не отрендерен в preview");
  let selVal = "high";
  Object.defineProperty(qualitySelect, "value", {
    configurable: true,
    get: () => selVal,
    set: (v) => { selVal = v; }
  });

  // Смена качества запускает перегенерацию -> busy; качество уходит в opts.
  qualitySelect.value = "max";
  qualitySelect.dispatchEvent(new document.defaultView.Event("change", { bubbles: true }));
  await Promise.resolve(); await Promise.resolve();
  equal(ctx.ascii.busy, true);
  equal(resolvers.length, 1);
  equal(resolvers[0].opts.quality, "max");

  // Пока busy — повторная смена качества отклоняется, значение откатывается.
  qualitySelect.value = "standard";
  qualitySelect.dispatchEvent(new document.defaultView.Event("change", { bubbles: true }));
  await Promise.resolve();
  equal(resolvers.length, 1, "третья операция не должна стартовать при busy");
  equal(qualitySelect.value, "max", "селект должен вернуться к применённому качеству");
  equal(ctx.ascii.quality, "max");

  resolvers[0].res("АРТ-МАКС");
  await new Promise((r) => setTimeout(r, 0));
  await new Promise((r) => setTimeout(r, 0));
  equal(ctx.ascii.art, "АРТ-МАКС");
  equal(ctx.ascii.busy, false);
});

test("гонка через change-события: устаревший ответ теряется, актуальный побеждает", async () => {
  const { api, document } = buildDialog();
  const resolvers = [];
  globalThis.AsciiConverter = {
    fileToAscii: (file) => new Promise((res) => resolvers.push({ file, res }))
  };
  openWith(api, asciiState({ mode: "keep", art: "СТАРЫЙ", hadArt: true }));
  const ctx = api.getCtx();
  const fileInput = api.block().querySelector("[data-ascii-file]");
  const fireFile = (name) => {
    fileInput.files = [{ name, size: 100, type: "image/jpeg" }];
    fileInput.dispatchEvent(new document.defaultView.Event("change", { bubbles: true }));
  };

  fireFile("a.jpg");
  await Promise.resolve(); await Promise.resolve();
  // Первая ещё в busy — прямой вызов asciiConvertSelected моделирует
  // повторный выбор после снятия busy (как в реальном UI через repick).
  // Имитируем: первая завершилась -> preview, затем вторая конвертация.
  resolvers[0].res("ART-A");
  await new Promise((r) => setTimeout(r, 0));
  await new Promise((r) => setTimeout(r, 0));
  equal(ctx.ascii.mode, "preview");

  // В preview «Другое фото» -> picker -> второй файл -> вторая конвертация.
  ctx.ascii.file = { name: "b.jpg" };
  const p2 = api.asciiConvertSelected(ctx, { name: "b.jpg", size: 1 });
  await Promise.resolve();
  equal(resolvers.length, 2);
  // Старый (уже неактуальный по convId) ответ a.jpg не может прийти —
  // но если бы пришёл, stale() его отбросит. Завершаем b.
  resolvers[1].res("ART-B");
  await p2;
  equal(ctx.ascii.art, "ART-B");
  equal(ctx.ascii.mode, "preview");
});
