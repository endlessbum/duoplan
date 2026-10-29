// Валидация диалога до запроса к API.
//
// Репорт 2026-10-29: на <form id="item-form"> стоял novalidate, поэтому
// required и type=date игнорировались и пустая форма уходила на сервер
// (ответ — тост «Заполните поле»). Комментарий в app.js предполагал, что
// браузер проверяет форму сам.
//
// Запуск: node tests/test_dialog_validation.test.mjs  (или node --test "tests/*.test.mjs")
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { match, ok } from "node:assert/strict";
import { test } from "node:test";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const html = readFileSync(join(root, "public", "app.html"), "utf8");
const app = readFileSync(join(root, "public", "app.js"), "utf8");

test("форма диалога не отключает нативную валидацию", () => {
  const formTag = html.match(/<form[^>]*id="item-form"[^>]*>/)?.[0];
  ok(formTag, "не найден <form id=\"item-form\">");
  ok(!/\bnovalidate\b/i.test(formTag), "у формы диалога снова стоит novalidate");
});

test("submit-обработчик явно проверяет форму перед запросом", () => {
  const handler = app.slice(app.indexOf('dialogForm.addEventListener("submit"'));
  ok(handler.length > 0, "не найден submit-обработчик диалога");
  match(handler, /if \(!dialogForm\.reportValidity\(\)\) return;/);
});
