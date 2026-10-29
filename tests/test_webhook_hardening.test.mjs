// Устойчивость вебхука и Telegram-вызовов (репорт 2026-10-29).
//
// 1. Тело вебхука может быть JSON-литералом "null": request.json() его
//    принимает, но update.message падал TypeError вне try → 500.
// 2. Повтор sendMessage при сетевой ошибке/таймауте мог отправить два сообщения.
// 3. ensureSchemaOnce() до проверки initData позволял анонимному запросу
//    запускать DDL на «холодном» изоляте.
// 4. DB_SCHEMA_VERSION опережала текущую дату и не совпадала с APP_VERSION.
//
// Запуск: node tests/test_webhook_hardening.test.mjs  (или node --test "tests/*.test.mjs")
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { deepStrictEqual, equal, match, ok, rejects } from "node:assert/strict";
import { test } from "node:test";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const source = readFileSync(join(root, "worker.js"), "utf8");

test("вебхук читает тело через update?.message и не падает на null", () => {
  const body = source.slice(source.indexOf("async function webhook"));
  // Комментарии объясняют баг и содержат «update.message» как текст — их не смотрим.
  const code = body.split("\n").filter(line => !line.trim().startsWith("//")).join("\n");
  ok(!/(?<![?.\w])update\.message/.test(code), "осталось обращение update.message без optional chaining");
  match(code, /const message = update\?\.message;/);
});

// telegram() извлекается как есть; fetch и setTimeout подменяются параметрами,
// чтобы проверить число попыток без реальной сети и без ожидания.
function loadTelegram(fetchImpl) {
  const idempotent = source.match(/const TELEGRAM_IDEMPOTENT = new Set\(\[[\s\S]*?\]\);/)?.[0];
  if (!idempotent) throw new Error("TELEGRAM_IDEMPOTENT не найден");
  const start = source.indexOf("async function telegram(");
  let depth = 0;
  let end = -1;
  for (let i = source.indexOf("{", start); i < source.length; i++) {
    if (source[i] === "{") depth++;
    else if (source[i] === "}") {
      depth--;
      if (depth === 0) { end = i + 1; break; }
    }
  }
  const body = source.slice(start, end);
  const calls = [];
  const factory = new Function("fetch", "setTimeout", `
    ${idempotent}
    ${body}
    return telegram;
  `);
  const telegram = factory(async (url, init) => {
    calls.push(init.body);
    return fetchImpl(calls.length, url, init);
  }, (fn) => fn());
  return { telegram, calls };
}

const env = { BOT_TOKEN: "test-token" };

test("сетевая ошибка не повторяет sendMessage (иначе дубликат сообщения)", async () => {
  const { telegram, calls } = loadTelegram(async () => { throw new Error("network down"); });
  await rejects(telegram(env, "sendMessage", { chat_id: 1, text: "привет" }), /network down/);
  equal(calls.length, 1, "sendMessage не должен ретраиться при сетевом сбое");
});

test("сетевая ошибка повторяет идемпотентный getMe", async () => {
  const { telegram, calls } = loadTelegram(async () => { throw new Error("network down"); });
  await rejects(telegram(env, "getMe", {}), /network down/);
  equal(calls.length, 3, "getMe ретраится: попытка + 2 повтора");
});

test("429 повторяется и для sendMessage: сообщение не было отправлено", async () => {
  const { telegram, calls } = loadTelegram(async () => ({
    ok: false,
    status: 429,
    text: async () => JSON.stringify({ ok: false, error_code: 429, parameters: { retry_after: 1 } })
  }));
  await rejects(telegram(env, "sendMessage", { chat_id: 1, text: "привет" }), /Telegram API 429/);
  equal(calls.length, 3);
});

test("api() поднимает схему только после проверки initData", () => {
  const apiBody = source.slice(source.indexOf("async function api"));
  const authPos = apiBody.indexOf("if (!tgUser) throw new HttpError(401");
  const schemaPos = apiBody.indexOf("await ensureSchemaOnce(env);");
  ok(authPos > 0 && schemaPos > 0, "не найдены вызовы");
  ok(authPos < schemaPos, "ensureSchemaOnce должен идти после проверки авторизации");
});

test("версии не опережают текущую дату и схема не новее приложения", () => {
  const read = (name) => source.match(new RegExp(`const ${name} = "([^"]+)";`))?.[1];
  const app = read("APP_VERSION");
  const schema = read("DB_SCHEMA_VERSION");
  ok(app && schema, "версии не найдены");
  const stamp = (value) => {
    match(value, /^\d{4}\.\d{2}\.\d{2}$/);
    return value.split(".").map(Number);
  };
  const appParts = stamp(app);
  const schemaParts = stamp(schema);
  const today = new Date().toISOString().slice(0, 10).split("-").map(Number);
  const compare = (a, b) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2];
  ok(compare(schemaParts, today) <= 0, `DB_SCHEMA_VERSION ${schema} в будущем`);
  ok(compare(appParts, today) <= 0, `APP_VERSION ${app} в будущем`);
  ok(compare(schemaParts, appParts) <= 0, "версия схемы новее версии приложения");
  deepStrictEqual(schema, app, "на релизе версии совпадают");
});
