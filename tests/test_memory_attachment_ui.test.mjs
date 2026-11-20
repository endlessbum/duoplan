// Отображение ASCII-вложения дневника (план «План_изменения_вложений_дневника.md»):
// 1) в карточке списка нет ASCII-символов, вместо них — скрепка после даты;
// 2) в окне чтения вложение полноширинное, без рамки/подложки/внутренней прокрутки;
// 3) компактный предпросмотр в форме добавления/редактирования не тронут.
//
// Поведенческие проверки (memoryItem, asciiColumnsOf) исполняются в linkedom;
// обработчик open-memory и CSS проверяются структурно по исходнику (app.js —
// монолитный IIFE, диалог чтения задаётся HTML-строкой в listener'е).
//
// Запуск: node --test tests/test_memory_attachment_ui.test.mjs
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { equal, ok } from "node:assert/strict";
import { test } from "node:test";
import { parseHTML } from "linkedom";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const source = readFileSync(join(root, "public", "app.js"), "utf8");
const css = readFileSync(join(root, "public", "app.css"), "utf8");

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

function cssBlock(selector) {
  const start = css.indexOf(`${selector} {`);
  if (start === -1) throw new Error(`${selector} не найден в app.css`);
  let depth = 0;
  for (let j = source.length, i = css.indexOf("{", start); i < css.length; i++) {
    if (css[i] === "{") depth++;
    else if (css[i] === "}") {
      depth--;
      if (depth === 0) return css.slice(start, i + 1);
    }
  }
  throw new Error(`незакрытый блок: ${selector}`);
}

// Собирает memoryItem() в linkedom-окружении: esc — настоящий (экранирование
// ASCII-символов важно), соседи по карточке — стабы с сохранением разметки.
function buildMemoryItem() {
  const factory = new Function(
    "renderRichText", "formatDay", "itemActions", "itemActionButton", "EDIT_ICON", "DELETE_ICON", "partnerMissing",
    [
      extractBraced("function esc"),
      extractBraced("function memoryItem"),
      "return memoryItem;"
    ].join("\n")
  );
  return factory(
    (s) => String(s ?? ""),
    (d) => String(d ?? ""),
    (html) => `<div class="item-actions">${html}</div>`,
    (o) => `<button data-action="${o.action}" data-type="${o.type}" data-id="${o.id}">${o.label}</button>`,
    "E", "D",
    () => false
  );
}

const ART = "▒▒▒▒▒\n▒ █ ▒\n▒▒▒▒▒";
const itemOf = (over = {}) => ({
  id: 1, title: "Заголовок", body: "Текст воспоминания",
  display_name: "Аня", day: "2026-11-19", ascii_art: null, ...over
});

// ---------- Карточка списка ----------

test("карточка с вложением: нет ASCII-превью, есть скрепка после даты", () => {
  const memoryItem = buildMemoryItem();
  const { document } = parseHTML(memoryItem(itemOf({ ascii_art: ART })));
  const card = document.querySelector(".memory-card");
  ok(card, "карточка не построилась");
  ok(!card.querySelector(".memory-ascii-peek"), "ASCII-превью осталось в карточке");
  ok(!card.textContent.includes("▒"), "символы ASCII-вложения попали в карточку");

  const meta = card.querySelector(".item-meta");
  ok(meta, "нет строки автора/даты");
  const kids = [...meta.children];
  const date = kids.find((el) => el.textContent.includes("·"));
  ok(date, "нет элемента с датой");
  const clip = card.querySelector(".memory-attachment");
  ok(clip, "нет значка вложения");
  equal(kids.indexOf(clip) > kids.indexOf(date), true, "скрепка стоит до даты");
  equal(clip.getAttribute("aria-label"), "Есть изображение", "нет доступного описания");
  equal(clip.getAttribute("title"), "Есть изображение", "нет title");
});

test("карточка без вложения: значка скрепки нет", () => {
  const memoryItem = buildMemoryItem();
  const { document } = parseHTML(memoryItem(itemOf()));
  ok(!document.querySelector(".memory-attachment"), "скрепка показана у записи без вложения");
  ok(!document.querySelector(".memory-ascii-peek"), "peek-элемент появился без вложения");
});

test("карточка сохраняет заголовок, текст, автора и действия", () => {
  const memoryItem = buildMemoryItem();
  const { document } = parseHTML(memoryItem(itemOf({ ascii_art: ART })));
  const card = document.querySelector(".memory-card");
  equal(card.querySelector(".item-title")?.textContent, "Заголовок");
  equal(card.querySelector(".memory-body")?.textContent, "Текст воспоминания");
  ok(card.querySelector(".memory-author")?.textContent.includes("Аня"), "автор потерян");
  equal(card.querySelector('[data-action="edit-item"]')?.getAttribute("data-action"), "edit-item", "нет действия редактирования");
  equal(card.querySelector('[data-action="delete-item"]')?.getAttribute("data-action"), "delete-item", "нет действия удаления");
});

// ---------- Полный показ в окне чтения ----------

test("open-memory: полное вложение в обёртке, без старого фиксированного размера", () => {
  const branch = source.slice(
    source.indexOf('action === "open-memory"'),
    source.indexOf('action === "reopen-item"')
  );
  ok(branch.includes('class="memory-ascii-wrap"'), "нет обёртки .memory-ascii-wrap");
  ok(branch.includes("esc(item.ascii_art)"), "вложение выводится не целиком/не экранированно");
  ok(!branch.includes("slice("), "в окне чтения есть обрезка вложения");
  ok(!branch.includes("asciiFontSizeFor(item.ascii_art)"), "старый фиксированный размер 320px остался");
  // fit вызывается после openDialog, чтобы размер считался от уже вставленного DOM
  const openIdx = branch.indexOf("openDialog({");
  const fitIdx = branch.indexOf("fitMemoryAsciiArt()");
  ok(openIdx > -1 && fitIdx > openIdx, "fitMemoryAsciiArt не вызван после openDialog");
});

test("fitMemoryAsciiArt: размер от ширины обёртки, клампы, no-op гварды", () => {
  const body = extractBraced("function fitMemoryAsciiArt");
  ok(body.includes("memory-ascii-wrap"), "не смотрит обёртку");
  ok(body.includes("clientWidth"), "размер не берётся из фактической ширины");
  ok(body.includes("asciiColumnsOf"), "не учитывает число колонок");
  ok(body.includes("if (!wrap || !pre) return;"), "нет no-op гварда отсутствия вложения");
  ok(body.includes("if (!width) return;"), "нет гварда нулевой ширины");
  // Верхняя граница поднята с 14 до 64: картинка должна заполнять всю ширину
  // окна записи даже при небольшом числе колонок. Нижняя — от схлопывания.
  ok(/Math\.max\(3, Math\.min\(64, /.test(body), "нет полноширинного клампа размера символов");
  ok(body.includes('pre.style.fontSize'), "размер шрифта не применяется");
});

test("resize пересчитывает размер символов", () => {
  ok(
    source.includes('window.addEventListener("resize", fitMemoryAsciiArt)'),
    "нет подписки на resize для пересчёта"
  );
});

test("asciiColumnsOf: максимум длины строки в кодовых точках", () => {
  const factory = new Function(`${extractBraced("function asciiColumnsOf")}; return asciiColumnsOf;`);
  const asciiColumnsOf = factory();
  equal(asciiColumnsOf("ab\nабвг\nz"), 4, "не максимум строк");
  // эмодзи — 2 кодовые единицы, 1 кодовая точка (как [...row].length)
  equal(asciiColumnsOf("🙂🙂"), 2, "сурогатные пары считаются как 2 колонки");
  equal(asciiColumnsOf(""), 1, "пустой текст не даёт ноль колонок");
});

// ---------- CSS ----------

test("стили .memory-ascii-art: полноширинность, без рамки/подложки/прокрутки", () => {
  const block = cssBlock(".memory-ascii-art");
  ok(!/\bborder\s*:/.test(block), "рамка вокруг вложения осталась");
  ok(!/\bbackground\s*:/.test(block), "подложка вокруг вложения осталась");
  ok(!/\bborder-radius\s*:/.test(block), "скругление вложения осталось");
  ok(!/\bpadding\s*:/.test(block), "внутренние отступы остались");
  ok(!/\bmax-height\s*:/.test(block), "ограничение высоты осталось");
  ok(!/\boverflow\s*:/.test(block), "внутренняя прокрутка осталась");
  ok(/width\s*:\s*100%/.test(block), "нет полноширинности");
  ok(/max-width\s*:\s*100%/.test(block), "нет max-width: 100%");
  ok(/box-sizing\s*:\s*border-box/.test(block), "нет box-sizing: border-box");
  ok(/white-space\s*:\s*pre/.test(block), "white-space: pre потерян — сетка развалится");
  ok(cssBlock(".memory-ascii-wrap"), "нет обёртки .memory-ascii-wrap");
});

test("значок скрепки оформлен и не ломает строку меты", () => {
  const block = cssBlock(".memory-attachment");
  ok(block.includes("font-size"), "нет компактного размера значка");
});

test("компактный предпросмотр формы не тронут", () => {
  // peek остался в форме добавления/редактирования (data-ascii-peek)
  ok(
    /memory-ascii-peek[^`]*data-ascii-peek[^`]*\$\{asciiFontSizeFor/.test(source.replace(/\s+/g, " ")),
    "предпросмотр в форме потерял размер по asciiFontSizeFor"
  );
  ok(cssBlock(".memory-ascii-peek"), "стили .memory-ascii-peek удалены");
  ok(cssBlock(".memory-ascii-preview"), "стили .memory-ascii-preview удалены");
});
