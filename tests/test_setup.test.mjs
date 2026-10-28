// Тест настройки бота (/api/setup в worker.js): вебхук, команды, меню-кнопка
// с web_app и отчёт has_main_web_app из getMe.
//
// setup извлекается из worker.js как есть и исполняется против моков
// telegram/json и фиктивных request/env.
//
// Запуск: node tests/test_setup.test.mjs  (или node --test "tests/*.test.mjs")
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { deepStrictEqual } from "node:assert/strict";
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

function loadSetup({ me }) {
  const calls = [];
  const telegram = async (_env, method, payload) => {
    calls.push({ method, payload });
    if (method === "getMe") return me;
    return {};
  };
  const json = (data, status = 200) => ({ __json: data, status });
  const setup = new Function(
    "rateLimit", "safeEqual", "ensureSchema", "telegram", "json", "DB_SCHEMA_VERSION", "APP_VERSION",
    `${extractBraced("async function setup")}\nreturn setup;`
  )(async () => {}, () => true, async () => {}, telegram, json, 3, "test");
  return { calls, setup };
}

const env = {
  BOT_TOKEN: "t",
  WEBHOOK_SECRET: "w",
  SETUP_TOKEN: "secret",
  APP_ORIGIN: "https://app.example.com",
  DB: { prepare: () => ({ bind: () => ({ run: async () => {} }) }) }
};
const url = new URL("https://app.example.com/api/setup");

function makeRequest() {
  return { headers: { get: (name) => (name === "x-setup-token" ? "secret" : null) } };
}

test("setup ставит меню-кнопку с web_app на /app и вебхук", async () => {
  const { calls, setup } = loadSetup({ me: { id: 1, username: "duoplanbot" } });
  const response = await setup(makeRequest(), env, url);
  deepStrictEqual(response.status, 200);
  const menu = calls.find((c) => c.method === "setChatMenuButton");
  deepStrictEqual(menu.payload.menu_button.type, "web_app");
  deepStrictEqual(menu.payload.menu_button.text, "DuoPlan");
  deepStrictEqual(menu.payload.menu_button.web_app.url, "https://app.example.com/app");
  deepStrictEqual(calls.some((c) => c.method === "setWebhook"), true);
  deepStrictEqual(calls.some((c) => c.method === "setMyCommands"), true);
});

test("setup возвращает has_main_web_app из getMe", async () => {
  const { calls, setup } = loadSetup({ me: { id: 1, has_main_web_app: true } });
  const response = await setup(makeRequest(), env, url);
  deepStrictEqual(calls.some((c) => c.method === "getMe"), true);
  deepStrictEqual(response.__json.has_main_web_app, true);
});

test("без Main Mini App в BotFather has_main_web_app = false", async () => {
  const { setup } = loadSetup({ me: { id: 1 } });
  const response = await setup(makeRequest(), env, url);
  deepStrictEqual(response.__json.has_main_web_app, false);
});
