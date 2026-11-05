// Атомарность PATCH у желаний (worker.js, itemRoute).
//
// Раньше основной UPDATE выполнялся сразу, а ссылка валидировалась ПОСЛЕ него
// отдельным запросом: при некорректном URL клиент получал 400, но текст
// желания уже был изменён. Теперь ссылка проверяется до записи и пишется тем
// же UPDATE.
//
// Запуск: node --test tests/test_wish_patch.test.mjs
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { ok, match } from "node:assert/strict";
import { test } from "node:test";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const source = readFileSync(join(root, "worker.js"), "utf8");

const start = source.indexOf("async function itemRoute(");
const end = source.indexOf("async function api(", start);
const itemRoute = source.slice(start, end);

test("ссылка пишется тем же UPDATE, что и текст", () => {
  ok(
    !/UPDATE wishes SET url=\?/.test(source),
    "отдельного UPDATE для ссылки быть не должно — он ломал атомарность"
  );
  match(itemRoute, /fields\.push\("url=\?"\)/);
  match(itemRoute, /values\.push\(wishUrl\(body\.url\)\)/);
});

test("валидация ссылки идёт до выполнения UPDATE", () => {
  const validateAt = itemRoute.indexOf("wishUrl(body.url)");
  const updateAt = itemRoute.indexOf("await env.DB.prepare(`UPDATE ${table}");
  ok(validateAt !== -1, "wishUrl не вызывается в itemRoute");
  ok(updateAt !== -1, "UPDATE не найден");
  ok(validateAt < updateAt, "wishUrl должен вызываться до UPDATE");
});

test("без поля url ссылка не трогается", () => {
  match(itemRoute, /if \(body\.url !== undefined\) \{/);
});
