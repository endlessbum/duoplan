// Устойчивость Mini App: таймаут запроса, безопасное открытие ссылок и
// фоновое обновление во время жеста (public/app.js).
//
// Три отдельные истории:
//   1) fetch без таймаута оставлял спиннер навсегда при «спящем» воркере;
//   2) window.open(url) без проверки схемы — ссылка из старой записи или из
//      бота могла прийти с javascript:/data:;
//   3) refreshState перерисовывал вкладку раз в минуту и мог оборвать жест по
//      капле (переключатель пересоздаётся вместе с разметкой).
//
// Запуск: node --test tests/test_app_robustness.test.mjs
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { deepStrictEqual, equal, match, ok, rejects } from "node:assert/strict";
import { test } from "node:test";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const source = readFileSync(join(root, "public/app.js"), "utf8");

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

// Функция с фигурными скобками в списке параметров (options = {}): тело
// начинается только после закрывающей скобки списка, иначе срез оборвётся
// на параметрах и код не соберётся.
function extractFunction(declaration) {
  const start = source.indexOf(declaration);
  if (start === -1) throw new Error(`${declaration} не найдено`);
  const parenStart = source.indexOf("(", start);
  let depth = 0;
  let parenEnd = -1;
  for (let i = parenStart; i < source.length; i++) {
    if (source[i] === "(") depth++;
    else if (source[i] === ")") {
      depth--;
      if (depth === 0) { parenEnd = i; break; }
    }
  }
  if (parenEnd === -1) throw new Error(`не закрыт список параметров: ${declaration}`);
  let braces = 0;
  for (let i = source.indexOf("{", parenEnd); i < source.length; i++) {
    if (source[i] === "{") braces++;
    else if (source[i] === "}") {
      braces--;
      if (braces === 0) return source.slice(start, i + 1);
    }
  }
  throw new Error(`незакрытый блок: ${declaration}`);
}

function extractLine(prefix) {
  const start = source.indexOf(prefix);
  if (start === -1) throw new Error(`${prefix} не найдено`);
  return source.slice(start, source.indexOf("\n", start));
}

// ------------------------------------------------------------------ request

function buildRequest({ fetchImpl, controller, onTimeout }) {
  const bundle = [
    extractLine("const REQUEST_TIMEOUT_MS"),
    extractFunction("async function request(")
  ].join("\n");
  // AbortController в приложении вызывается через new, поэтому заглушка —
  // обычная функция: стрелка не конструируется.
  function FakeAbortController() { return controller; }
  return new Function(
    "tg", "fetch", "AbortController", "setTimeout", "clearTimeout",
    `${bundle}\nreturn request;`
  )(
    { initData: "query_id=1" },
    fetchImpl,
    FakeAbortController,
    (fn) => { onTimeout(fn); return 42; },
    () => { onTimeout.cleared = true; }
  );
}

function fakeController() {
  const listeners = [];
  const signal = {
    aborted: false,
    addEventListener: (type, fn) => { if (type === "abort") listeners.push(fn); }
  };
  return {
    signal,
    abort() {
      signal.aborted = true;
      for (const fn of listeners) fn();
    }
  };
}

test("зависший запрос обрывается по таймауту и даёт понятную ошибку", async () => {
  const controller = fakeController();
  let fire = null;
  const request = buildRequest({
    controller,
    onTimeout: (fn) => { fire = fn; },
    fetchImpl: (path, options) => new Promise((resolve, reject) => {
      options.signal.addEventListener("abort", () => {
        const error = new Error("aborted");
        error.name = "AbortError";
        reject(error);
      });
    })
  });
  const pending = request("/api/state");
  fire();
  await rejects(pending, (error) => {
    equal(error.status, 0);
    match(error.message, /Сервер не ответил/);
    return true;
  });
});

test("обычный ответ возвращается, таймер снимается", async () => {
  const controller = fakeController();
  let cleared = null;
  const bundle = [
    extractLine("const REQUEST_TIMEOUT_MS"),
    extractFunction("async function request(")
  ].join("\n");
  function FakeAbortController() { return controller; }
  const request = new Function("tg", "fetch", "AbortController", "setTimeout", "clearTimeout",
    `${bundle}\nreturn request;`)(
    { initData: "" },
    async () => ({ ok: true, status: 200, json: async () => ({ tasks: [] }) }),
    FakeAbortController,
    () => 7,
    (id) => { cleared = id; }
  );
  deepStrictEqual(await request("/api/state"), { tasks: [] });
  equal(cleared, 7, "таймер должен сниматься в finally");
});

test("HTTP-ошибка доносит статус и код", async () => {
  const controller = fakeController();
  const request = buildRequest({
    controller,
    onTimeout: () => {},
    fetchImpl: async () => ({
      ok: false,
      status: 400,
      json: async () => ({ error: "Проверьте дату", code: "INVALID_DATE" })
    })
  });
  await rejects(request("/api/dates", { method: "POST", body: {} }), (error) => {
    equal(error.status, 400);
    equal(error.code, "INVALID_DATE");
    equal(error.message, "Проверьте дату");
    return true;
  });
});

// -------------------------------------------------------------- openExternal

const openExternal = new Function(
  "window", "showToast",
  `${extractBraced("function openExternal(")}\nreturn openExternal;`
)({ open: (...args) => { openExternal.opened = args; } }, (message) => { openExternal.toast = message; });

const reset = () => { openExternal.opened = null; openExternal.toast = null; };

test("http(s) открывается в новой вкладке", () => {
  reset();
  openExternal("https://example.com/tickets?a=1");
  ok(openExternal.opened, "window.open должен вызваться");
  equal(openExternal.opened[0], "https://example.com/tickets?a=1");
  equal(openExternal.opened[1], "_blank");
  equal(openExternal.toast, null);
});

test("javascript: и data: не открываются", () => {
  for (const bad of ["javascript:alert(1)", "data:text/html,<b>x</b>", "  javascript:void(0)"]) {
    reset();
    openExternal(bad);
    equal(openExternal.opened, null, `не должно открываться: ${bad}`);
    match(openExternal.toast, /некорректна/);
  }
});

test("мусор вместо адреса — понятная ошибка, а не window.open", () => {
  reset();
  openExternal("не ссылка");
  equal(openExternal.opened, null);
  match(openExternal.toast, /некорректна/);
  reset();
  openExternal(null);
  equal(openExternal.opened, null);
});

// --------------------------------------------------------------- drag guard

test("фоновое обновление не перерисовывает вкладку во время жеста", () => {
  const start = source.indexOf("async function refreshState(");
  const body = source.slice(start, source.indexOf("async function", start + 10));
  match(body, /liquidNav\?\.getState\?\.\(\)\.dragging/);
  match(body, /wishSwitch\?\.getState\?\.\(\)\.dragging/);
});
