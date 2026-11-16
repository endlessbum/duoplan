// Аудит 2026-11-16: регрессии приватного гейта webhook.
//
// INV-SEC-01: неверный, но корректно сформированный invite-код в /start CODE
// раньше завершался отказом ДО joinPair/claimJoinAttempt — перебор шёл мимо
// счётчика попыток. Теперь гейт сам резервирует слот лимитера.
//
// INV-ROB-02: dropUnconfirmedUser стоял после await openApp — исключение
// отправки сообщения пропускало очистку, и повторная доставка видела
// созданную строку users как knownUser. Теперь очистка в finally.
//
// Тест исполняет настоящие claimJoinAttempt и webhook(), подставляя только
// окружение и внешние сервисы — как test_webhook_dedup_runtime.test.mjs.
//
// Запуск: node --test tests/test_private_gate_attempts.test.mjs
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { equal, ok } from "node:assert/strict";
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

const limitDecl = source.match(/const JOIN_ATTEMPT_LIMIT = [^;]+;/)?.[0];
const windowDecl = source.match(/const JOIN_ATTEMPT_WINDOW = [^;]+;/)?.[0];
if (!limitDecl || !windowDecl) throw new Error("константы лимита не найдены");

// webhook + настоящий claimJoinAttempt (с мокнутым env.DB внутри).
const factory = new Function(
  "json", "ensureSchemaOnce", "safeEqual", "positiveId", "ownerIds",
  "telegram", "membership", "ensureUser", "joinPair",
  "openApp", "dropUnconfirmedUser",
  [
    extractBraced("class HttpError"),
    extractLine("const now = "),
    extractLine("const clean = "),
    extractLine("const START_PAYLOAD_RE = "),
    limitDecl,
    windowDecl,
    extractBraced("async function claimJoinAttempt"),
    extractBraced("function startPayload"),
    extractBraced("async function webhook"),
    "return { webhook, HttpError };"
  ].join("\n")
);

// Мок D1: дедупликация, users (knownUser), pairs (openPair), rate_limits.
function makeDb({ users = {}, pairs = {} } = {}) {
  const rateLimits = new Map();
  const seenUpdates = new Set();
  const deletedUpdates = [];
  return {
    rateLimits,
    seenUpdates,
    deletedUpdates,
    prepare(sql) {
      return {
        bind(...args) {
          return {
            async run() {
              if (sql.includes("INSERT OR IGNORE INTO telegram_updates")) {
                const id = Number(args[0]);
                if (seenUpdates.has(id)) return { meta: { changes: 0 } };
                seenUpdates.add(id);
                return { meta: { changes: 1 } };
              }
              if (sql.includes("DELETE FROM telegram_updates")) {
                deletedUpdates.push(Number(args[0]));
                seenUpdates.delete(Number(args[0]));
                return { meta: { changes: 1 } };
              }
              throw new Error("неожиданный run(): " + sql);
            },
            async first() {
              if (sql.startsWith("INSERT INTO rate_limits") && sql.includes("RETURNING count")) {
                const count = (rateLimits.get(args[0]) || 0) + 1;
                rateLimits.set(args[0], count);
                return { count };
              }
              if (sql === "SELECT count FROM rate_limits WHERE bucket_key=?") {
                const prev = rateLimits.get(args[0]);
                return prev ? { count: prev } : null;
              }
              if (sql.includes("FROM users WHERE tg_id=?")) {
                return users[args[0]] ? { tg_id: args[0] } : null;
              }
              if (sql.includes("FROM pairs WHERE code=?")) {
                return pairs[String(args[0]).toUpperCase()] || null;
              }
              throw new Error("неожиданный first(): " + sql);
            },
            async all() { return { results: [] }; }
          };
        }
      };
    }
  };
}

function buildWebhook(overrides = {}) {
  const counters = { telegram: [], ensureUser: 0, joinPair: 0, openApp: 0, drop: [] };
  const { webhook, HttpError } = factory(
    (data, status = 200) => ({ data, status }),
    async () => {},
    (a, b) => a === b,
    (value) => Number.isSafeInteger(Number(value)) && Number(value) > 0,
    (env) => String(env?.OWNER_IDS || "").split(/[,\s;]+/).map((c) => c.trim()).filter(Boolean).map(Number).filter(Number.isFinite),
    async (env, method, payload) => { counters.telegram.push({ method, payload }); return {}; },
    overrides.membership || (async () => null),
    overrides.ensureUser || (async (env, from) => { counters.ensureUser++; return { tg_id: from.id, display_name: from.first_name || "Тест" }; }),
    overrides.joinPair || (async () => { counters.joinPair++; }),
    overrides.openApp || (async () => { counters.openApp++; }),
    overrides.dropUnconfirmedUser || (async (env, tgId) => { counters.drop.push(tgId); })
  );
  return { webhook, HttpError, counters };
}

const strangerUpdate = (id, text, fromId = 777) => ({
  update_id: id,
  message: {
    text,
    chat: { id: fromId, type: "private" },
    from: { id: fromId, first_name: "Гость" }
  }
});
const req = (value) => ({
  headers: { get: (name) => name === "x-telegram-bot-api-secret-token" ? "secret" : null },
  json: async () => value
});
const envFor = (db) => ({
  DB: db,
  WEBHOOK_SECRET: "secret",
  PRIVATE_BOT: "true",
  OWNER_IDS: "999"
});
const URL_STUB = { origin: "https://app.example", searchParams: new URLSearchParams() };

test("INV-SEC-01: шесть несуществующих валидных кодов через /start — шестой отклонён лимитером", async () => {
  const db = makeDb();
  const { webhook, counters } = buildWebhook();
  const env = envFor(db);
  const denials = [];
  for (let i = 1; i <= 6; i++) {
    const result = await webhook(req(strangerUpdate(5000 + i, `/start AAAA000${i}`)), env, URL_STUB);
    equal(result.status, 200, "гейт отвечает 200 даже при отказе — дедуп не должен ретраить");
    denials.push(counters.telegram.at(-1)?.payload?.text || "");
  }
  equal(counters.ensureUser, 0, "гейт не доходит до ensureUser — отказ до регистрации");
  equal(counters.joinPair, 0, "joinPair не вызывается: кода нет среди открытых пар");
  for (let i = 0; i < 5; i++) {
    ok(denials[i].includes("приватный бот"), `попытка ${i + 1}: обычный отказ`);
  }
  ok(denials[5].includes("15 минут"), "шестая попытка — отказ лимитера, а не обычный");
  // Счётчик реально пополнялся: ключ jf:<user>:<bucket> есть в rate_limits.
  ok([...db.rateLimits.keys()].some((key) => key.startsWith("jf:777:")), "слоты лимитера записаны");
});

test("INV-SEC-01: битый формат кода не расходует лимит", async () => {
  const db = makeDb();
  const { webhook, counters } = buildWebhook();
  const env = envFor(db);
  for (let i = 1; i <= 3; i++) {
    await webhook(req(strangerUpdate(6000 + i, "/start НЕ-КОД-123")), env, URL_STUB);
  }
  ok(db.rateLimits.size === 0, "некорректный формат не пишет rate_limits");
  equal(counters.telegram.length, 3);
});

test("INV-ROB-02: сбой openApp не пропускает очистку временного пользователя", async () => {
  const db = makeDb({ pairs: { BBBB0001: { id: 1 } } });
  const { webhook, HttpError, counters } = buildWebhook({
    joinPair: async () => { counters.joinPair++; throw new HttpError(404, "Код не найден", "CODE_NOT_FOUND"); },
    openApp: async () => { counters.openApp++; throw new Error("telegram api down"); }
  });
  const env = envFor(db);
  const result = await webhook(req(strangerUpdate(7001, "/start BBBB0001")), env, URL_STUB);
  equal(result.status, 500, "сбой доставки → 500 для повторной отправки Telegram");
  deepEqualDrop(counters, [777]);
  equal(db.deletedUpdates.includes(7001), true, "update_id снят с дедупа — Telegram повторит");
});

test("INV-ROB-02: неудачный вход без сбоя openApp тоже чистит временного пользователя", async () => {
  const db = makeDb({ pairs: { BBBB0002: { id: 2 } } });
  const { webhook, HttpError, counters } = buildWebhook({
    joinPair: async () => { counters.joinPair++; throw new HttpError(404, "Код не найден", "CODE_NOT_FOUND"); }
  });
  const env = envFor(db);
  const result = await webhook(req(strangerUpdate(7002, "/start BBBB0002")), env, URL_STUB);
  equal(result.status, 200);
  deepEqualDrop(counters, [777]);
});

test("INV-ROB-02: успешный вход не удаляет пользователя даже при сбое openApp", async () => {
  const db = makeDb({ pairs: { BBBB0003: { id: 3 } } });
  const { webhook, counters } = buildWebhook({
    joinPair: async () => { counters.joinPair++; },
    openApp: async () => { counters.openApp++; throw new Error("telegram api down"); }
  });
  const env = envFor(db);
  const result = await webhook(req(strangerUpdate(7003, "/start BBBB0003")), env, URL_STUB);
  equal(result.status, 500);
  equal(counters.drop.length, 0, "joined=true — очистка не трогает участника пары");
});

function deepEqualDrop(counters, expected) {
  equal(JSON.stringify(counters.drop), JSON.stringify(expected));
}
