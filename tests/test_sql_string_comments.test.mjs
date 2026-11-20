// Регрессия 2026-11-20: в stats-запросе state() внутри SQL template string
// оказался JS-комментарий `//`. SQLite не понимает // — запрос падал с syntax
// error, /api/state отвечал 500 INTERNAL_ERROR и Mini App показывала
// «Не удалось загрузить пространство» для всех пользователей с парой.
//
// Тест сканирует все SQL-строки worker.js и требует, чтобы внутри них не было
// JS-комментариев. SQLite понимает /* ... */, но для единообразия запрещаем и их.
//
// Запуск: node --test tests/test_sql_string_comments.test.mjs
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { ok } from "node:assert/strict";
import { test } from "node:test";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const source = readFileSync(join(root, "worker.js"), "utf8");

function sqlTemplateBodies(text) {
  const bodies = [];
  for (const match of text.matchAll(/`([^`]*)`/gs)) {
    const stripped = match[1].trimStart();
    if (/^(SELECT|INSERT|UPDATE|DELETE|WITH)\b/i.test(stripped)) {
      bodies.push({ body: match[1], offset: match.index });
    }
  }
  return bodies;
}

test("SQL-строки в worker.js не содержат JS-комментариев", () => {
  const bodies = sqlTemplateBodies(source);
  ok(bodies.length > 0, "SQL template strings не найдены");
  for (const { body, offset } of bodies) {
    const match = body.match(/\/\/|\/\*/);
    if (!match) continue;
    const line = source.slice(0, offset).split("\n").length
      + body.slice(0, match.index).split("\n").length - 1;
    ok(false, `JS-комментарий ${match[0]} внутри SQL на строке ${line}: ${match[0]}`);
  }
});
