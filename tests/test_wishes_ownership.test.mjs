// Права на желания: партнёр видит чужие желания в вишлисте, но менять их
// (PATCH, DELETE, done/reopen) может только автор.
//
// Репорт 2026-10-29: UI рендерил чужие желания без действий (wishItem(..., false)),
// а сервер в itemRoute проверял только pair_id — любой участник пары мог
// отредактировать, удалить или закрыть желание партнёра прямым запросом к API.
//
// itemRoute извлекается из worker.js как есть; хелперы валидации подменяются
// моками через параметры new Function, поэтому тест не зависит от D1.
//
// Запуск: node tests/test_wishes_ownership.test.mjs  (или node --test "tests/*.test.mjs")
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { equal, rejects } from "node:assert/strict";
import { test } from "node:test";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const source = readFileSync(join(root, "worker.js"), "utf8");

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

const buildItemRoute = new Function(
  "positiveId", "planSchedule", "textField", "validDate", "clean", "optionalTime", "now", "HttpError", "wishUrl",
  [
    extractBraced("async function ensureWishOwner"),
    extractBraced("async function ensureDateVisible"),
    extractBraced("async function ensureTaskVisible"),
    extractBraced("async function itemRoute"),
    "return itemRoute;"
  ].join("\n")
);

const HttpError = new Function(
  `${extractBraced("class HttpError")}\nreturn HttpError;`
)();

function makeHarness({ ownerId = 1, wishExists = true, changes = 1 } = {}) {
  const calls = [];
  const db = {
    prepare(sql) {
      return {
        bind(...args) {
          calls.push({ sql, args });
          return {
            first: async () => (wishExists ? { owner_id: ownerId } : null),
            run: async () => ({ meta: { changes } })
          };
        }
      };
    }
  };
  const route = buildItemRoute(
    n => Number.isInteger(n) && n > 0,
    () => ({ day: null, time: null }),
    (body, key) => String(body[key] ?? ""),
    () => true,
    s => String(s).trim(),
    () => null,
    () => 1_700_000_000,
    HttpError,
    v => String(v ?? "").trim()
  );
  return { route, env: { DB: db }, pair: { id: 10 }, user: { tg_id: 2 }, calls };
}

const notOwner = error => error.status === 403 && error.code === "WISH_NOT_OWNER";

for (const [label, method, path, body] of [
  ["PATCH", "PATCH", "/api/wishes/5", { body: "Чужое" }],
  ["DELETE", "DELETE", "/api/wishes/5", {}],
  ["done", "POST", "/api/wishes/5/done", {}],
  ["reopen", "POST", "/api/wishes/5/reopen", {}]
]) {
  test(`партнёр не может ${label} чужое желание`, async () => {
    const { route, env, pair, user, calls } = makeHarness({ ownerId: 1 });
    await rejects(route(env, pair, user, method, path, body), notOwner);
    // до записи дело не дошло: выполнен только SELECT владельца
    equal(calls.length, 1);
    equal(calls[0].sql, "SELECT owner_id FROM wishes WHERE id=? AND pair_id=?");
  });
}

test("автор может редактировать своё желание", async () => {
  const { route, env, pair, user, calls } = makeHarness({ ownerId: 2 });
  equal(await route(env, pair, user, "PATCH", "/api/wishes/5", { body: "Своё" }), true);
  const update = calls.find(c => c.sql.startsWith("UPDATE wishes SET body=?"));
  equal(update.args[0], "Своё");
});

test("автор обновляет текст и ссылку одним UPDATE", async () => {
  const { route, env, pair, user, calls } = makeHarness({ ownerId: 2 });
  equal(
    await route(env, pair, user, "PATCH", "/api/wishes/5", { body: "Своё", url: "https://example.com/gift" }),
    true
  );
  // Ссылка пишется в том же UPDATE, что и текст: иначе при неверном URL
  // текст уже изменился бы, а клиент получил бы ошибку.
  const updates = calls.filter((c) => c.sql.startsWith("UPDATE wishes SET"));
  equal(updates.length, 1, "ссылка и текст должны обновляться одним запросом");
  equal(updates[0].sql.includes("url=?"), true);
  equal(updates[0].args.includes("https://example.com/gift"), true);
});

test("автор может удалить своё желание", async () => {
  const { route, env, pair, user, calls } = makeHarness({ ownerId: 2 });
  equal(await route(env, pair, user, "DELETE", "/api/wishes/5", {}), true);
  equal(calls.at(-1).sql, "DELETE FROM wishes WHERE id=? AND pair_id=?");
});

test("автор может отметить своё желание исполненным и вернуть его", async () => {
  for (const action of ["done", "reopen"]) {
    const { route, env, pair, user, calls } = makeHarness({ ownerId: 2 });
    equal(await route(env, pair, user, "POST", `/api/wishes/5/${action}`, {}), true);
    equal(calls.at(-1).sql.startsWith("UPDATE wishes SET done="), true);
  }
});

test("несуществующее желание по-прежнему даёт 404", async () => {
  const { route, env, pair, user } = makeHarness({ wishExists: false });
  await rejects(
    route(env, pair, user, "PATCH", "/api/wishes/5", { body: "Нет" }),
    error => error.status === 404 && error.code === "NOT_FOUND"
  );
});

test("проверка автора не задевает общие разделы (tasks)", async () => {
  const { route, env, pair, user, calls } = makeHarness({ ownerId: 1 });
  equal(await route(env, pair, user, "PATCH", "/api/tasks/5", { title: "План" }), true);
  // Первый запрос — guard видимости личного плана, второй — сам UPDATE.
  equal(calls.length, 2);
  equal(calls[0].sql.startsWith("SELECT is_private,created_by FROM tasks"), true);
  equal(calls[1].sql.startsWith("UPDATE tasks SET"), true);
});
