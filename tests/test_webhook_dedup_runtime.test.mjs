// WEBHOOK-01: временная ошибка конфигурации приватного режима не должна
// помечать Telegram update как обработанный. Иначе повтор после задания
// OWNER_IDS гасится дедупликацией и бизнес-логика не выполняется никогда.
// Тест исполняет саму функцию webhook() с подставным D1, а не проверяет
// порядок строк в исходнике.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { equal, ok, rejects } from "node:assert/strict";
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
    else if (source[j] === "}") { depth--; if (depth === 0) return source.slice(start, j + 1); }
  }
  throw new Error(`незакрытый блок: ${declaration}`);
}
function extractLine(prefix) {
  const start = source.indexOf(prefix);
  if (start === -1) throw new Error(`${prefix} не найдено`);
  return source.slice(start, source.indexOf("\n", start));
}

function makeDb() {
  const seen = new Set();
  const inserted = [];
  return {
    seen,
    inserted,
    prepare(sql) {
      return {
        bind(...args) {
          return {
            async run() {
              if (sql.includes("INSERT OR IGNORE INTO telegram_updates")) {
                const id = Number(args[0]);
                inserted.push(id);
                if (seen.has(id)) return { meta: { changes: 0 } };
                seen.add(id);
                return { meta: { changes: 1 } };
              }
              return { meta: { changes: 1 } };
            },
            async first() { return null; },
            async all() { return { results: [] }; }
          };
        }
      };
    }
  };
}

function buildWebhook(db, counters) {
  return new Function(
    "json", "ensureSchemaOnce", "safeEqual", "positiveId", "ownerIds",
    "startPayload", "telegram", "membership", "ensureUser", "joinPair",
    "openApp", "dropUnconfirmedUser", "claimJoinAttempt",
    [
      extractBraced("class HttpError"),
      extractLine("const now = "),
      extractLine("const clean = "),
      extractBraced("async function webhook"),
      "return webhook;"
    ].join("\n")
  )(
    (data, status = 200) => ({ data, status }),
    async () => {},
    (a, b) => a === b,
    (value) => Number.isSafeInteger(Number(value)) && Number(value) > 0,
    (env) => String(env?.OWNER_IDS || "").split(/[,\s;]+/).map((c) => c.trim()).filter(Boolean).map(Number).filter(Number.isFinite),
    () => "",
    async () => { counters.telegram++; return {}; },
    async () => null,
    async () => { counters.ensureUser++; return { tg_id: 123 }; },
    async () => {},
    async () => { counters.openApp++; },
    async () => {},
    async () => {}
  );
}

const update = (id) => ({
  update_id: id,
  message: {
    text: "/start",
    chat: { id: 123, type: "private" },
    from: { id: 123, first_name: "Тест" }
  }
});
const request = (value, secretOk = true) => ({
  headers: { get: (name) => name === "x-telegram-bot-api-secret-token" ? (secretOk ? "secret" : "bad") : null },
  json: async () => value
});

test("PRIVATE_BOT_MISCONFIGURED не фиксирует update_id; повтор после настройки обрабатывается", async () => {
  const db = makeDb();
  const counters = { ensureUser: 0, telegram: 0, openApp: 0 };
  const webhook = buildWebhook(db, counters);
  const env = { DB: db, WEBHOOK_SECRET: "secret", PRIVATE_BOT: "true", OWNER_IDS: "" };
  const url = { searchParams: new URLSearchParams() };

  // 1. Неверная конфигурация: 503, записи в дедупликации нет.
  await rejects(
    () => webhook(request(update(4242)), env, url),
    (error) => error.status === 503 && error.code === "PRIVATE_BOT_MISCONFIGURED"
  );
  equal(db.inserted.length, 0, "503 не должен писать update_id в telegram_updates");
  equal(counters.ensureUser, 0);

  // 2. Владелец задан — тот же update доставляется повторно и обрабатывается.
  env.OWNER_IDS = "123";
  const second = await webhook(request(update(4242)), env, url);
  equal(second.status, 200);
  equal(counters.ensureUser, 1, "повторный update должен дойти до ensureUser");
  ok(db.seen.has(4242), "успешно обработанный update помечен как увиденный");

  // 3. Третья доставка того же update — дедупликация по-прежнему работает.
  const third = await webhook(request(update(4242)), env, url);
  equal(third.status, 200);
  equal(counters.ensureUser, 1, "уже обработанный update не должен выполняться дважды");
});

test("неверный webhook secret не меняет таблицу дедупликации", async () => {
  const db = makeDb();
  const counters = { ensureUser: 0, telegram: 0, openApp: 0 };
  const webhook = buildWebhook(db, counters);
  const env = { DB: db, WEBHOOK_SECRET: "secret", PRIVATE_BOT: "true", OWNER_IDS: "123" };
  const result = await webhook(request(update(777), false), env, { searchParams: new URLSearchParams() });
  equal(result.status, 403);
  equal(db.inserted.length, 0);
  equal(counters.ensureUser, 0);
});
