// POST /api/pair/timezone: общий часовой пояс пары (DP-02).
//
// pairs.timezone задаётся при создании пары и больше нигде не менялся — переезд
// или разные пояса партнёров оставляли календарь и напоминания на старом поясе.
// Маршрут валидирует IANA-пояс настоящей validTimeZone и пишет pairs.timezone.
// api() извлекается из worker.js как есть и исполняется против мока D1 —
// тот же приём, что в test_private_dates и test_api_routing.
//
// Запуск: node --test tests/test_pair_timezone.test.mjs
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { deepStrictEqual, equal, ok, rejects } from "node:assert/strict";
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

const buildApi = new Function(
  "json", "ensureSchemaOnce", "telegramUser", "validTimeZone", "ensureUser",
  "rateLimit", "readJson", "state", "membership", "ownerIds",
  [
    extractBraced("class HttpError"),
    extractLine("const now = "),
    extractLine("const clean = "),
    extractLine("const ACCENT_KEYS"),
    extractBraced("function validateSchema"),
    extractBraced("function textField"),
    extractBraced("function validDate"),
    extractBraced("function optionalTime"),
    extractBraced("function validTimeZone"),
    extractBraced("function ownerIds"),
    extractBraced("async function api"),
    "return api;"
  ].join("\n")
);

function makeApiEnv({ pair = null, body = {} } = {}) {
  const queries = [];
  const db = {
    prepare(sql) {
      return {
        bind(...args) {
          queries.push({ sql, args });
          return { run: async () => ({ meta: { changes: 1 } }) };
        }
      };
    }
  };
  const request = { method: "POST", headers: { get: () => null } };
  const api = buildApi(
    (data, status = 200) => ({ data, status }),
    async () => {},
    async () => ({ id: 777, first_name: "Тест" }),
    new Function(`${extractBraced("function validTimeZone")}; return validTimeZone;`)(),
    async () => ({ tg_id: 777, gender: null }),
    async () => {},
    async () => body,
    async () => ({ user: { tg_id: 777 }, pair }),
    async () => pair
  );
  return { api, env: { DB: db }, queries, request };
}

test("POST /api/pair/timezone пишет пояс пары и возвращает state", async () => {
  const { api, env, queries, request } = makeApiEnv({
    pair: { id: 1, timezone: "Europe/Moscow" },
    body: { timezone: "Asia/Irkutsk" }
  });
  const response = await api(request, env, new URL("https://duoplan.test/api/pair/timezone"));
  const update = queries.find(q => q.sql.startsWith("UPDATE pairs SET"));
  ok(update, "ожидается UPDATE pairs");
  ok(update.sql.includes("timezone=?"), "пишется pairs.timezone");
  deepStrictEqual(update.args[0], "Asia/Irkutsk");
  deepStrictEqual(update.args[2], 1); // id пары
  deepStrictEqual(response.data.user.tg_id, 777); // вернулся state
});

test("POST /api/pair/timezone отклоняет неизвестный пояс", async () => {
  const bad = makeApiEnv({ pair: { id: 1 }, body: { timezone: "Марс/Фобос" } });
  await rejects(
    bad.api(bad.request, bad.env, new URL("https://duoplan.test/api/pair/timezone")),
    error => error.status === 400 && error.code === "INVALID_TIMEZONE"
  );
});

test("POST /api/pair/timezone отклоняет пустое и слишком длинное значение", async () => {
  for (const timezone of ["", "x".repeat(65)]) {
    const env0 = makeApiEnv({ pair: { id: 1 }, body: { timezone } });
    await rejects(
      env0.api(env0.request, env0.env, new URL("https://duoplan.test/api/pair/timezone")),
      error => error.status === 400
    );
  }
  const empty = makeApiEnv({ pair: { id: 1 }, body: {} });
  await rejects(
    empty.api(empty.request, empty.env, new URL("https://duoplan.test/api/pair/timezone")),
    error => error.status === 400
  );
});

test("validTimeZone принимает IANA-пояса и смещения, отклоняет мусор", () => {
  const fn = new Function(`${extractBraced("function validTimeZone")}; return validTimeZone;`)();
  equal(fn("Europe/Moscow"), "Europe/Moscow");
  equal(fn("Asia/Irkutsk"), "Asia/Irkutsk");
  equal(fn("America/New_York"), "America/New_York");
  equal(fn("Марс/Фобос"), null);
  equal(fn(""), null);
  equal(fn(null), null);
  equal(fn("x".repeat(65)), null);
});
