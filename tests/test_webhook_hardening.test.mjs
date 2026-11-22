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
    // Суффикс .N — вторая и дальнейшие смены схемы за тот же день: строка
    // обязана отличаться от записанной в app_meta, иначе ensureSchema
    // пропустит ALTER'ы (см. комментарий к DB_SCHEMA_VERSION в worker.js).
    match(value, /^\d{4}\.\d{2}\.\d{2}(\.\d+)?$/);
    return value.split(".").map(Number);
  };
  const appParts = stamp(app);
  const schemaParts = stamp(schema);
  // Дедлайн «не в будущем» считаем только по UTC — локальная календарная дата
  // зависит от часового пояса машины и давала ложные падения (TEST-01).
  // Допуск +1 день: у часовых поясов восточнее UTC локальная дата может
  // опережать UTC на сутки, и версия, проставленная разработчиком «сегодня»
  // локально, не должна считаться будущей.
  const now = new Date();
  const utcTomorrow = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1));
  const today = [utcTomorrow.getUTCFullYear(), utcTomorrow.getUTCMonth() + 1, utcTomorrow.getUTCDate()];
  const compare = (a, b) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2];
  ok(compare(schemaParts, today) <= 0, `DB_SCHEMA_VERSION ${schema} в будущем`);
  ok(compare(appParts, today) <= 0, `APP_VERSION ${app} в будущем`);
  ok(compare(schemaParts, appParts) <= 0, "версия схемы новее версии приложения");
  // Версии схемы и приложения совпадают на релизе (текущая версия — 2026.11.20.115).
  deepStrictEqual(schema, "2026.11.20.115", "версия схемы обновлена");
  deepStrictEqual(app, "2026.11.20.115", "версия приложения обновлена");
});

// Резерв кода на этапе гейта: зарезервированный код открывает приватный бот
// только прежнему партнёру — посторонний не регистрируется в users
// (репорт 2026-11-06: вечный «известный» пользователь без членства).
test("гейт вебхука проверяет резерв кода (awaiting_return/last_partner)", () => {
  ok(
    source.includes("AND (awaiting_return=0 OR last_partner=?)"),
    "openPair-запрос гейта не проверяет резерв кода",
  );
});

// Аудит 2026-11-11 (P2): допущенный по коду, но проигравший гонку пользователь
// не должен остаться в users — иначе /api/* пустит его как knownUser.
test("гонка приглашения снимает регистрацию проигравшего", () => {
  const webhook = source.slice(source.indexOf("async function webhook"));
  match(webhook, /const invitedNow = Boolean\(ownerIdList\.length && !isBotOwner && !knownUser\)/);
  // Аудит 2026-11-16 (INV-ROB-02): очистка в finally — сбой openApp не должен
  // её пропускать; ошибка самой очистки гасится отдельным catch.
  match(webhook, /finally \{[\s\S]*?if \(invitedNow && !joined\) \{[\s\S]*?await dropUnconfirmedUser\(env, user\.tg_id\)/);
});

test("dropUnconfirmedUser удаляет только запись без пары и без членства", async () => {
  const start = source.indexOf("async function dropUnconfirmedUser");
  ok(start > 0, "dropUnconfirmedUser не найдена");
  let depth = 0;
  let end = -1;
  for (let i = source.indexOf("{", start); i < source.length; i++) {
    if (source[i] === "{") depth++;
    else if (source[i] === "}") { depth--; if (depth === 0) { end = i + 1; break; } }
  }
  const calls = [];
  const env = {
    DB: {
      prepare(sql) {
        return {
          bind(...params) {
            return { async run() { calls.push({ sql, params }); return { meta: { changes: 1 } }; } };
          }
        };
      }
    }
  };
  const drop = new Function("env", `${source.slice(start, end)}\nreturn dropUnconfirmedUser;`)(env);
  await drop(env, 777);
  equal(calls.length, 1);
  match(calls[0].sql, /DELETE FROM users WHERE tg_id=\? AND pair_id IS NULL/);
  match(calls[0].sql, /NOT EXISTS\(SELECT 1 FROM pair_members WHERE tg_id=\?\)/);
  deepStrictEqual(calls[0].params, [777, 777]);
});

test("PRIVATE_BOT без OWNER_IDS — ошибка конфигурации, а не открытый бот", () => {
  // Проверка встроена в api() и webhook() без отдельной функции: тестовые
  // харнессы извлекают их через new Function и передают только ownerIds.
  const api = source.slice(source.indexOf("async function api("), source.indexOf("async function webhook("));
  const webhook = source.slice(source.indexOf("async function webhook("));
  for (const [name, body] of [["api", api], ["webhook", webhook]]) {
    ok(body.includes('String(env?.PRIVATE_BOT || "") === "true"'),
      `${name}: нет fail-closed проверки`);
    ok(body.includes("PRIVATE_BOT_MISCONFIGURED"), `${name}: нет кода ошибки`);
  }
  // Порядок важен: проверка до допуска пользователя.
  ok(api.indexOf("PRIVATE_BOT_MISCONFIGURED") < api.indexOf("ensureUser(env"),
    "api: проверка должна быть до ensureUser");
  // WEBHOOK-01: 503 не должен фиксировать update_id в дедупликации.
  ok(webhook.indexOf("PRIVATE_BOT_MISCONFIGURED") < webhook.indexOf("INSERT OR IGNORE INTO telegram_updates"),
    "webhook: проверка должна быть до INSERT в telegram_updates");
});

test("OWNER_IDS вынесен из wrangler.jsonc в окружение", () => {
  const cfg = readFileSync(join(root, "wrangler.jsonc"), "utf8");
  ok(!/"OWNER_IDS"\s*:/.test(cfg), "ID владельца снова лежит в конфигурации репозитория");
  match(cfg, /"PRIVATE_BOT"\s*:\s*"true"/, "нет флага приватного режима");
  // Оба гейта используют флаг; проверка живёт рядом с ownerIds в api/webhook.
  equal((source.match(/PRIVATE_BOT_MISCONFIGURED/g) || []).length, 2,
    "ожидается по одной проверке в api() и webhook()");
});

