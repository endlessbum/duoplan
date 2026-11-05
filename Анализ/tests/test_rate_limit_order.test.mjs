// Лимит запросов: rateLimit должен срабатывать до записи пользователя,
// иначе флуд создаёт строки в users, а счётчик читается после.
//
// Запуск: node tests/test_rate_limit_order.test.mjs  (или node --test "tests/*.test.mjs")
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { ok } from "node:assert/strict";
import { test } from "node:test";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const source = readFileSync(join(root, "worker.js"), "utf8");

test("rateLimit вызывается до ensureUser в api()", () => {
  const apiStart = source.indexOf("async function api");
  const apiBody = source.slice(apiStart);
  const ratePos = apiBody.indexOf("await rateLimit(env");
  const ensurePos = apiBody.indexOf("const user = await ensureUser");
  ok(ratePos > 0 && ensurePos > 0, "не найдены вызовы");
  ok(ratePos < ensurePos, "rateLimit должен идти до ensureUser");
});

test("rateLimit читает счётчик через RETURNING, а не отдельным SELECT", () => {
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
const fn = extractBraced("async function rateLimit");
  ok(/RETURNING count/.test(fn), "в UPSERT нет RETURNING count");
  ok(!/SELECT count FROM rate_limits/.test(fn), "остался отдельный SELECT счётчика");
});
