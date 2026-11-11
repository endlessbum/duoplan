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
import { equal, ok, match } from "node:assert/strict";
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
  match(itemRoute, /field\("url", wishUrl\(body\.url\) \|\| null\)/);
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

test("уточнение редактируется тем же UPDATE, пустое снимается в NULL", () => {
  match(itemRoute, /if \(body\.comment !== undefined\) \{/);
  match(itemRoute, /field\("comment", clean\(body\.comment\) \|\| null\)/);
  ok(
    !/UPDATE wishes SET comment=\?/.test(source),
    "отдельного UPDATE для уточнения быть не должно — он ломает атомарность"
  );
});

// Блок POST /api/wishes запускается Against мока D1: проверяем не только
// наличие колонки в SQL, но и реальные значения биндов.
const postStart = source.indexOf('if (request.method === "POST" && url.pathname === "/api/wishes")');
const postEnd = source.indexOf('if (request.method === "POST" && url.pathname === "/api/quotes")', postStart);
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
const postWish = new AsyncFunction(
  "request", "url", "body", "validateSchema", "textField", "wishUrl", "clean",
  "env", "pair", "user", "json", "state", "now",
  source.slice(postStart, postEnd) + "\nreturn null;"
);

async function runPostWish(body) {
  const calls = [];
  const env = {
    DB: {
      prepare(sql) {
        return {
          bind(...args) {
            calls.push({ sql, args });
            return { run: async () => ({ meta: { changes: 1 } }) };
          }
        };
      }
    }
  };
  const trim = (value) => String(value ?? "").trim();
  await postWish(
    { method: "POST" }, { pathname: "/api/wishes" }, body,
    () => {}, // правила validateSchema проверены отдельно
    (payload, key) => trim(payload[key]),
    trim, trim,
    env, { id: 7 }, { tg_id: 42 },
    (data) => data, async () => ({ ok: true }), () => 1_700_000_000
  );
  return calls;
}

test("POST /api/wishes пишет уточнение в INSERT, пустое — NULL", async () => {
  const calls = await runPostWish({ body: "Плед", comment: "Серый, 150×200", url: "" });
  equal(calls.length, 1);
  ok(calls[0].sql.includes("comment"), "INSERT должен содержать колонку comment");
  equal(calls[0].args[3], null, "пустая ссылка нормализуется в NULL");
  equal(calls[0].args[4], "Серый, 150×200");

  const empty = await runPostWish({ body: "Плед", comment: "   " });
  equal(empty[0].args[4], null, "пробельное уточнение не должно попадать в базу");
});
