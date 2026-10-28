// Тест авторизации Mini App (telegramUser в worker.js).
//
// Официальная схема (https://core.telegram.org/bots/webapps#validating-data-received-via-the-mini-app):
//   secret_key = HMAC_SHA256(key="WebAppData", msg=bot_token)
//   hash       = hex(HMAC_SHA256(key=secret_key, msg=data_check_string))
// то есть в промежуточной подписи КЛЮЧ — строка "WebAppData", а сообщение — токен бота
// (в формулировке документации: «signature of the bot's token with the key WebAppData»).
//
// telegramUser извлекается из worker.js как есть вместе с зависимостями
// (hmac, hex, safeEqual, now, positiveId) и исполняется против реальной
// Node-криптографии, которой генерируются подписи.
//
// Запуск: node tests/test_auth_init_data.test.mjs  (или node --test "tests/*.test.mjs")
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { createHmac } from "node:crypto";
import { deepStrictEqual, equal } from "node:assert/strict";
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

function extractLine(prefix) {
  const start = source.indexOf(prefix);
  if (start === -1) throw new Error(`${prefix} не найдено`);
  return source.slice(start, source.indexOf("\n", start));
}

const load = new Function(
  [
    extractLine("const now = "),
    extractLine("const positiveId = "),
    extractBraced("function safeEqual"),
    extractBraced("async function hmac"),
    extractBraced("function hex"),
    extractBraced("async function telegramUser")
  ].join("\n") + "\nreturn { telegramUser, hmac, hex };"
);
const { telegramUser, hmac, hex } = load();

const TOKEN = "123456:test-bot-token";
const USER = { id: 777, first_name: "Тест", username: "tester" };

// Подписывает fields ровно по официальной схеме Telegram.
// hash и signature в data-check-string не входят (по спецификации).
function signInitData(fields, token = TOKEN) {
  const secret = createHmac("sha256", "WebAppData").update(token).digest();
  const pairs = Object.entries(fields)
    .filter(([key]) => key !== "hash" && key !== "signature")
    .map(([key, value]) => [key, String(value)]);
  const check = pairs
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([key, value]) => `${key}=${value}`)
    .join("\n");
  const hash = createHmac("sha256", secret).update(check).digest("hex");
  return new URLSearchParams([...pairs, ["hash", hash]]).toString();
}

// Та же подпись, но с перепутанным направлением HMAC:
// secret_key = HMAC_SHA256(key=bot_token, msg="WebAppData").
// Именно такая интерпретация псевдокода HMAC_SHA256(<bot_token>, "WebAppData")
// из документации ошибочна: в ней HMAC_SHA256(данные, ключ).
function signInitDataReversed(fields, token = TOKEN) {
  const secret = createHmac("sha256", token).update("WebAppData").digest();
  const pairs = Object.entries(fields)
    .filter(([key]) => key !== "hash" && key !== "signature")
    .map(([key, value]) => [key, String(value)]);
  const check = pairs
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([key, value]) => `${key}=${value}`)
    .join("\n");
  const hash = createHmac("sha256", secret).update(check).digest("hex");
  return new URLSearchParams([...pairs, ["hash", hash]]).toString();
}

function baseFields(authDate = Math.floor(Date.now() / 1000)) {
  return { auth_date: authDate, query_id: "AAF:test", user: JSON.stringify(USER) };
}

test("хелпер hmac: первый аргумент — ключ, второй — данные (как в Node crypto)", async () => {
  const secret = createHmac("sha256", "WebAppData").update(TOKEN).digest();
  deepStrictEqual(hex(await hmac("WebAppData", TOKEN)), createHmac("sha256", "WebAppData").update(TOKEN).digest("hex"));
  deepStrictEqual(hex(await hmac(secret, "check\nstring")), createHmac("sha256", secret).update("check\nstring").digest("hex"));
});

test("валидная подпись по официальной схеме принимается", async () => {
  const user = await telegramUser(signInitData(baseFields()), TOKEN);
  deepStrictEqual(user, USER);
});

test("подпись с перепутанным порядком ключ/данные отклоняется", async () => {
  // Фиксирует направление: ключ промежуточной подписи — "WebAppData",
  // а не токен. Если поменять аргументы в telegramUser местами,
  // этот тест начнёт принимать неверные подписи, а предыдущий — падать.
  const user = await telegramUser(signInitDataReversed(baseFields()), TOKEN);
  equal(user, null);
});

test("изменённый hash отклоняется", async () => {
  const initData = signInitData(baseFields());
  const params = new URLSearchParams(initData);
  const hash = params.get("hash");
  params.set("hash", (hash.slice(0, -1) === "0" ? "1" : "0") + hash.slice(1));
  const user = await telegramUser(params.toString(), TOKEN);
  equal(user, null);
});

test("чужой токен бота отклоняется", async () => {
  const user = await telegramUser(signInitData(baseFields()), "123456:other-token");
  equal(user, null);
});

test("просроченный auth_date (больше 24 часов) отклоняется", async () => {
  const stale = Math.floor(Date.now() / 1000) - 90000;
  const user = await telegramUser(signInitData(baseFields(stale)), TOKEN);
  equal(user, null);
});

test("auth_date из будущего (больше 5 минут) отклоняется", async () => {
  const future = Math.floor(Date.now() / 1000) + 3600;
  const user = await telegramUser(signInitData(baseFields(future)), TOKEN);
  equal(user, null);
});

test("поле signature исключается из data-check-string (Bot API 9.x)", async () => {
  // В initData новых клиентов есть signature для сторонней валидации:
  // в data-check-string входят все поля, кроме hash и signature.
  const withSignature = signInitData({ ...baseFields(), signature: "c2lnbmF0dXJl" });
  deepStrictEqual(await telegramUser(withSignature, TOKEN), USER);
  // hash подписью не покрывается, поэтому значение signature можно менять.
  const tampered = withSignature.replace(/signature=[^&]+/, "signature=tampered");
  deepStrictEqual(await telegramUser(tampered, TOKEN), USER);
});

test("мусорные initData отклоняются", async () => {
  equal(await telegramUser("", TOKEN), null);
  equal(await telegramUser(undefined, TOKEN), null);
  equal(await telegramUser("user=%7B%22id%22%3A1%7D", TOKEN), null);
  equal(await telegramUser(signInitData({ ...baseFields(), user: "not-json" }), TOKEN), null);
});
