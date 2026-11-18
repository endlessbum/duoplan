// Регрессионные проверки UI-сценариев ASCII-блока дневника (fix-plan P0).
// app.js — монолитный IIFE, поэтому тесты читают исходник и проверяют
// наличие защитных конструкций; поведенческие проверки ручные/WebView.
//
// Запуск: node --test tests/test_ascii_ui.test.mjs
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { ok } from "node:assert/strict";
import { test } from "node:test";

const here = dirname(fileURLToPath(import.meta.url));
const source = readFileSync(join(here, "..", "public", "app.js"), "utf8");

// Вырезает тело функции по имени — чтобы проверки были привязаны к коду,
// а не к файлу целиком.
function fnBody(name) {
  const start = source.indexOf(`function ${name}(`);
  if (start === -1) throw new Error(`${name} не найден`);
  let depth = 0;
  for (let j = source.indexOf("{", start); j < source.length; j++) {
    if (source[j] === "{") depth++;
    else if (source[j] === "}") { depth--; if (depth === 0) return source.slice(start, j + 1); }
  }
  throw new Error(`незакрытый блок: ${name}`);
}

test("P0.1: ascii-pick/ascii-replace не сбрасывают mode до выбора файла", () => {
  const handler = source.slice(source.indexOf('action === "ascii-pick"'), source.indexOf('action === "ascii-apply"'));
  ok(!handler.includes('mode = "none"'), "picker-ветка не должна обнулять mode");
  ok(!handler.includes("renderAsciiBlock"), "picker-ветка не должна перерисовывать блок");
  ok(handler.includes("input?.click()"), "picker-ветка должна открывать file input");
});

test("P0.2: ошибка конвертации показывается ПОСЛЕ renderAsciiBlock", () => {
  const body = fnBody("asciiConvertSelected");
  const catchIdx = body.indexOf("} catch");
  const catchBody = body.slice(catchIdx);
  const renderIdx = catchBody.indexOf("renderAsciiBlock()");
  const errIdx = catchBody.indexOf("asciiStatus(msg, true)");
  ok(renderIdx > 0 && errIdx > renderIdx,
     "порядок в catch: renderAsciiBlock() -> asciiStatus(msg, true)");
});

test("P0.3: submit-обработчик блокируется при ascii.busy", () => {
  const submitIdx = source.indexOf('dialogForm.addEventListener("submit"');
  const submitBody = source.slice(submitIdx, submitIdx + 3000);
  const busyIdx = submitBody.indexOf("dialogContext.ascii?.busy");
  const submittingIdx = submitBody.indexOf("dialogSubmitting = true");
  ok(busyIdx > 0 && busyIdx < submittingIdx, "проверка busy до dialogSubmitting=true");
  ok(submitBody.includes("Дождитесь окончания обработки"));
});

test("P0.4: convId инвалидирует устаревшие конвертации", () => {
  const body = fnBody("asciiConvertSelected");
  ok(body.includes("convId"), "нет счётчика операций");
  ok(body.includes("dialogContext !== ctx"), "нет проверки актуальности контекста");
  // Результат применяется только после stale()-проверки
  const staleIdx = body.indexOf("if (stale()) return");
  const applyIdx = body.indexOf('ctx.ascii.mode = "preview"');
  ok(staleIdx > 0 && applyIdx > staleIdx, "stale-проверка должна precede применению результата");
});

test("P0.4: смена палитры и повторный файл заблокированы при busy", () => {
  // В файле два change-листенера на dialogFields — берём ASCII-ветку.
  const anchor = source.indexOf('e.target.matches?.("[data-ascii-file]")');
  ok(anchor > 0, "ASCII change-ветка не найдена");
  const changeBody = source.slice(anchor - 500, anchor + 2500);
  ok(changeBody.includes("ctx.ascii.busy"), "change-обработчик не проверяет busy");
});

test("P0.5: backup/restore состояний для отмены preview и ошибки", () => {
  ok(source.includes("function asciiBackupState"), "нет asciiBackupState");
  ok(source.includes("function asciiRestoreBackup"), "нет asciiRestoreBackup");
  const cancelIdx = source.indexOf('action === "ascii-cancel-preview"');
  const cancelBody = source.slice(cancelIdx, cancelIdx + 400);
  ok(cancelBody.includes("asciiRestoreBackup"), "отмена preview не восстанавливает backup");
});

test("ascii_art в PATCH шлётся только при реальном изменении", () => {
  // Семантика контракта: mode "set" -> строка, "delete" -> null,
  // "none"/"keep"/"preview" -> ключ отсутствует.
  ok(source.includes('mode === "set" && dialogContext.ascii.art'), "нет ветки set");
  ok(source.includes('body.ascii_art = dialogContext.ascii.art'), "set не пишет art");
  ok(source.includes('mode === "delete"'), "нет ветки delete");
  ok(source.includes("body.ascii_art = null"), "delete не пишет null");
});

test("P1.6: статусы ASCII доступны скринридеру (aria-live)", () => {
  ok(source.includes('data-ascii-status aria-live="polite"'), "нет aria-live на статусе");
});
