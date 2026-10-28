// Тест порядка маршрутов api() в worker.js.
//
// Репорт 2026-10-29: POST /api/gender стоял ПОСЛЕ проверки членства в паре
// (409 NO_PAIR), а гейт пола в интерфейсе показывается до онбординга — новый
// пользователь не мог сохранить пол и застревал, не доходя до создания
// пространства. Маршруты, доступные пользователю без пары (pair/create,
// pair/join, gender), должны обрабатываться до membership-guard; парные
// маршруты — после него.
//
// api() извлекается из worker.js как есть; зависимости (json, state,
// membership и т.д.) подменяются моками через параметры new Function.
// Моков достаточно для достижимых веток: остальные маршруты отсекаются
// проверкой url.pathname и не вычисляются.
//
// Запуск: node tests/test_api_routing.test.mjs  (или node --test "tests/*.test.mjs")
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { deepStrictEqual, equal, rejects } from "node:assert/strict";
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
  "rateLimit", "readJson", "state", "membership",
  [
    extractBraced("class HttpError"),
    extractLine("const now = "),
    extractLine("const clean = "),
    extractBraced("async function api"),
    "return api;"
  ].join("\n")
);

function makeEnv({ pair = null, body = {} } = {}) {
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
    () => "Europe/Moscow",
    async () => ({ tg_id: 777, gender: null }),
    async () => {},
    async () => body,
    async () => ({ user: { tg_id: 777 }, pair }),
    async () => pair
  );
  return { api, env: { DB: db }, queries, request };
}

test("POST /api/gender сохраняет пол пользователю без пары (гейт до онбординга)", async () => {
  const { api, env, queries, request } = makeEnv({ body: { gender: "female" } });
  const response = await api(request, env, new URL("https://duoplan.test/api/gender"));
  // вернулся свежий state, а не 409 NO_PAIR
  deepStrictEqual(response.data.user.tg_id, 777);
  const update = queries.find(q => q.sql.startsWith("UPDATE users SET gender"));
  deepStrictEqual(update.args[0], "female");
  equal(update.args[2], 777);
});

test("POST /api/gender отклоняет недопустимое значение", async () => {
  const { api, env, request } = makeEnv({ body: { gender: "dragon" } });
  await rejects(
    api(request, env, new URL("https://duoplan.test/api/gender")),
    error => error.status === 400 && error.code === "INVALID_GENDER"
  );
});

test("парные маршруты по-прежнему требуют пару (409 NO_PAIR)", async () => {
  const { api, env, request } = makeEnv({ body: { title: "План" } });
  await rejects(
    api(request, env, new URL("https://duoplan.test/api/tasks")),
    error => error.status === 409 && error.code === "NO_PAIR"
  );
});

test("POST /api/gender работает и для пользователя в паре", async () => {
  const { api, env, queries, request } = makeEnv({ pair: { id: 1 }, body: { gender: "male" } });
  await api(request, env, new URL("https://duoplan.test/api/gender"));
  const update = queries.find(q => q.sql.startsWith("UPDATE users SET gender"));
  equal(update.args[0], "male");
});
