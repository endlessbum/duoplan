// Реgression-тесты красных капель месячных в основном календаре.
// Проверяют три момента: предзагрузка Фло при входе, обновление доступа
// партнёрши и полная история периодов для старых месяцев сетки.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { equal, ok } from "node:assert/strict";
import { test } from "node:test";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const source = readFileSync(join(root, "public", "app.js"), "utf8");

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

// У функций с деструктурированными параметрами ({ silent = false } = {})
// первая «{» относится к параметру, а не к телу — ищем начало тела после ") {".
function extractWithOptions(declaration) {
  const start = source.indexOf(declaration);
  if (start === -1) throw new Error(`${declaration} не найдено`);
  const brace = source.indexOf("{", source.indexOf(") {", start));
  let depth = 0;
  for (let j = brace; j < source.length; j++) {
    if (source[j] === "{") depth++;
    else if (source[j] === "}") {
      depth--;
      if (depth === 0) return source.slice(start, j + 1);
    }
  }
  throw new Error(`незакрытый блок: ${declaration}`);
}

test("капли видны сразу после входа: initApp предзагружает Фло владелице", () => {
  const init = source.slice(source.indexOf("async function initApp"));
  ok(init.includes('gender === "female"'), "нет проверки пола в initApp");
  ok(init.includes("loadFloState({ silent: true })"), "нет тихой предзагрузки Фло в initApp");
});

test("мужской календарь берёт полную историю периодов, а не только 6 последних", () => {
  const fn = extractBraced("function renderPairCalendar");
  ok(fn.includes("floPartner.calendar_periods"), "не используется calendar_periods");
  ok(fn.includes("floPartner.calendar_periods || floPartner.periods"), "нет fallback на periods");
});

test("loadFloState silent: данные приходят до первого render(), ошибка не блокирует запуск", async () => {
  const make = (request, render, handleRequestError) => new Function(
    "request", "render", "handleRequestError",
    [
      "let floBusy = false;",
      "let floState = null;",
      "let floExtra = {};",
      "let floFetchedMonths = new Set();",
      "let floMonth = null;",
      extractWithOptions("async function loadFloState"),
      "return { loadFloState, get: () => floState };"
    ].join("\n")
  )(request, render, handleRequestError);

  let renders = 0;
  const good = make(
    async () => ({ today: "2026-11-16", periods: [{ start_date: "2026-11-10" }] }),
    () => { renders++; },
    () => {}
  );
  await good.loadFloState({ silent: true });
  equal(renders, 0, "silent-загрузка не должна перерисовывать");
  equal(good.get().periods.length, 1);

  let errors = 0;
  const bad = make(
    async () => { throw new Error("offline"); },
    () => { renders++; },
    () => { errors++; }
  );
  await bad.loadFloState({ silent: true });
  equal(bad.get(), null, "после сбоя floState должен быть пустым — Фло повторит сама");
  equal(renders, 0);
  equal(errors, 0, "при старте ошибка сети не должна уходить в тосты");
});

test("loadFloPartner silent: кратковременный сбой не отключает выданный доступ", async () => {
  let renders = 0;
  const ctx = new Function(
    "request", "render",
    [
      "let floPartnerBusy = false;",
      "let floPartner = null;",
      extractWithOptions("async function loadFloPartner"),
      "return { loadFloPartner, set: (v) => { floPartner = v; }, get: () => floPartner };"
    ].join("\n")
  )(async () => { throw new Error("offline"); }, () => { renders++; });

  const granted = { shared: true, confirmed: true, periods: [], calendar_periods: [] };
  ctx.set(granted);
  await ctx.loadFloPartner({ silent: true });
  equal(ctx.get(), granted, "последний удачный ответ должен сохраниться");
  equal(renders, 0);
});
