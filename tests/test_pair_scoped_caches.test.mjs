// DP-ADD-002/003: кэши контактов и партнёрского Фло живут в пространстве
// пары. Проверяем и сброс при смене pair.id, и отбрасывание ответов, которые
// прилетели после перехода в другую пару (гонка на сеть).
//
// Запуск: node --test tests/test_pair_scoped_caches.test.mjs
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { deepStrictEqual, equal } from "node:assert/strict";
import { test } from "node:test";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const source = readFileSync(join(root, "public/app.js"), "utf8");

// loadContacts/loadFloPartner принимают деструктурированный options = {} —
// первый «{» после имени относится к параметрам, а не к телу. Поэтому сначала
// закрываем список параметров, потом ищем фигурные скобки тела.
function extractBraced(declaration) {
  const start = source.indexOf(declaration);
  if (start === -1) throw new Error(`${declaration} не найдено`);
  const parenStart = source.indexOf("(", start);
  let parens = 0;
  let parenEnd = -1;
  for (let i = parenStart; i < source.length; i++) {
    if (source[i] === "(") parens++;
    else if (source[i] === ")" && --parens === 0) { parenEnd = i; break; }
  }
  if (parenEnd === -1) throw new Error(`не закрыт список параметров: ${declaration}`);
  let depth = 0;
  for (let j = source.indexOf("{", parenEnd); j < source.length; j++) {
    if (source[j] === "{") depth++;
    else if (source[j] === "}" && --depth === 0) return source.slice(start, j + 1);
  }
  throw new Error(`незакрытый блок: ${declaration}`);
}

function load(request, render, handleRequestError) {
  return new Function(
    "request", "render", "handleRequestError",
    [
      "let appState = null;",
      "let archiveCachePairId = null;",
      extractBraced("function emptyArchiveEntry"),
      "const archiveCache = { tasks: emptyArchiveEntry(), birthdays: emptyArchiveEntry() };",
      extractBraced("function resetArchiveCache"),
      "const movieGroupDetails = new Map();",
      "const movieGroupPending = new Map();",
      "let movieGroupSelection = null;",
      "let movieGroupSuggest = null;",
      "let movieGroupDraft = null;",
      "let contactsState = null;",
      "let contactsBusy = false;",
      "let floPartner = undefined;",
      "let floPartnerBusy = false;",
      extractBraced("function syncArchiveCachePair"),
      extractBraced("async function loadContacts"),
      extractBraced("async function loadFloPartner"),
      "return {",
      "  sync: syncArchiveCachePair,",
      "  loadContacts, loadFloPartner,",
      "  setAppState: (v) => { appState = v; },",
      "  setContacts: (v) => { contactsState = v; },",
      "  setFloPartner: (v) => { floPartner = v; },",
      "  getContacts: () => contactsState,",
      "  getFloPartner: () => floPartner,",
      "  getContactsBusy: () => contactsBusy,",
      "  getFloPartnerBusy: () => floPartnerBusy",
      "};"
    ].join("\n")
  )(request, render, handleRequestError);
}

function makeCtx(request = async () => ({})) {
  const calls = { render: 0, errors: [] };
  const ctx = load(
    async (path, options) => request(path, options),
    () => { calls.render += 1; },
    (error) => { calls.errors.push(error); }
  );
  return { ctx, calls };
}

test("DP-ADD-002: смена пары сбрасывает кэш контактов, та же пара — нет", () => {
  const { ctx } = makeCtx();
  ctx.setAppState({ pair: { id: 1 } });
  ctx.sync();
  ctx.setContacts({ mine: [{ id: 1, name: "Старый" }], partner: [] });

  ctx.setAppState({ pair: { id: 1 } });
  ctx.sync();
  deepStrictEqual(ctx.getContacts().mine[0].name, "Старый");

  ctx.setAppState({ pair: { id: 2 } });
  ctx.sync();
  equal(ctx.getContacts(), null);
  equal(ctx.getContactsBusy(), false);

  ctx.setAppState({ pair: null });
  ctx.setContacts({ mine: [{ id: 2, name: "Ещё один" }], partner: [] });
  ctx.sync();
  equal(ctx.getContacts(), null);
});

test("DP-ADD-003: смена пары сбрасывает партнёрский Фло, та же пара — нет", () => {
  const { ctx } = makeCtx();
  ctx.setAppState({ pair: { id: 1 } });
  ctx.sync();
  ctx.setFloPartner({ shared: true, confirmed: true, calendar_periods: [{ start: "2026-01-01" }] });

  ctx.setAppState({ pair: { id: 1 } });
  ctx.sync();
  equal(ctx.getFloPartner().shared, true);

  ctx.setAppState({ pair: { id: 2 } });
  ctx.sync();
  equal(ctx.getFloPartner(), undefined);
  equal(ctx.getFloPartnerBusy(), false);
});

test("DP-ADD-002: ответ контактов после смены пары не перезаписывает новую книгу", async () => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const { ctx, calls } = makeCtx(async () => { await gate; return { mine: [{ id: 99, name: "Прежняя пара" }], partner: [] }; });
  ctx.setAppState({ pair: { id: 1 } });
  ctx.sync();
  const flight = ctx.loadContacts({ force: true, silent: true });

  ctx.setAppState({ pair: { id: 2 } });
  ctx.sync();
  ctx.setContacts({ mine: [{ id: 200, name: "Новая пара" }], partner: [] });
  release();
  await flight;

  equal(ctx.getContacts().mine[0].name, "Новая пара");
  equal(ctx.getContactsBusy(), false);
  equal(calls.render, 0, "silent-загрузка не перерисовывает экран");
});

test("DP-ADD-002: смена пары разблокирует загрузку контактов, старый запрос не мешает новому", async () => {
  const releases = [];
  const paths = [];
  const { ctx } = makeCtx(async (path) => {
    paths.push(path);
    await new Promise((resolve) => releases.push(resolve));
    return { mine: [{ id: paths.length, name: paths.length === 1 ? "Старая пара" : "Новая пара" }], partner: [] };
  });
  ctx.setAppState({ pair: { id: 1 } });
  ctx.sync();
  const old = ctx.loadContacts({ force: true, silent: true });
  equal(ctx.getContactsBusy(), true);

  ctx.setAppState({ pair: { id: 2 } });
  ctx.sync();
  equal(ctx.getContactsBusy(), false, "busy-флаг не должен пережить смену пары");
  const fresh = ctx.loadContacts({ force: true, silent: true });

  releases[1]();
  await fresh;
  equal(ctx.getContacts().mine[0].name, "Новая пара");
  releases[0]();
  await old;
  equal(ctx.getContacts().mine[0].name, "Новая пара", "старый ответ не должен победить");
  deepStrictEqual(paths, ["/api/contacts", "/api/contacts"]);
});

test("DP-ADD-002/003: старый ответ не снимает busy-флаг новой пары", async () => {
  const contactReleases = [];
  const floReleases = [];
  const { ctx } = makeCtx(async (path) => {
    const releases = path === "/api/contacts" ? contactReleases : floReleases;
    await new Promise((resolve) => releases.push(resolve));
    return { mine: [], partner: [], shared: true };
  });
  ctx.setAppState({ pair: { id: 1 } });
  ctx.sync();
  const oldContacts = ctx.loadContacts({ force: true, silent: true });
  const oldFlo = ctx.loadFloPartner({ silent: true });

  ctx.setAppState({ pair: { id: 2 } });
  ctx.sync();
  const freshContacts = ctx.loadContacts({ force: true, silent: true });
  const freshFlo = ctx.loadFloPartner({ silent: true });
  equal(ctx.getContactsBusy(), true);
  equal(ctx.getFloPartnerBusy(), true);

  contactReleases[0]();
  floReleases[0]();
  await Promise.all([oldContacts, oldFlo]);
  equal(ctx.getContactsBusy(), true, "старый запрос контактов снял busy новой пары");
  equal(ctx.getFloPartnerBusy(), true, "старый запрос Фло снял busy новой пары");

  contactReleases[1]();
  floReleases[1]();
  await Promise.all([freshContacts, freshFlo]);
  equal(ctx.getContactsBusy(), false);
  equal(ctx.getFloPartnerBusy(), false);
});

test("DP-ADD-002: ошибка после смены пары не пишет failed в новую книгу", async () => {
  let fail;
  const gate = new Promise((_, reject) => { fail = reject; });
  const { ctx } = makeCtx(async () => { await gate; });
  ctx.setAppState({ pair: { id: 1 } });
  ctx.sync();
  const flight = ctx.loadContacts({ force: true, silent: true });

  ctx.setAppState({ pair: { id: 2 } });
  ctx.sync();
  ctx.setContacts({ mine: [{ id: 200, name: "Новая пара" }], partner: [] });
  fail(new Error("сеть"));
  await flight;
  equal(ctx.getContacts().mine[0].name, "Новая пара");
});

test("DP-ADD-003: ответ Фло после смены пары отбрасывается", async () => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const { ctx, calls } = makeCtx(async () => { await gate; return { shared: true, confirmed: true }; });
  ctx.setAppState({ pair: { id: 1 } });
  ctx.sync();
  const flight = ctx.loadFloPartner({ silent: true });

  ctx.setAppState({ pair: { id: 2 } });
  ctx.sync();
  ctx.setFloPartner({ shared: false });
  release();
  await flight;
  deepStrictEqual(ctx.getFloPartner(), { shared: false });
  equal(ctx.getFloPartnerBusy(), false);
  equal(calls.render, 0);
});

test("DP-ADD-003: ошибка Фло после смены пары не отключает доступ новой пары", async () => {
  let fail;
  const gate = new Promise((_, reject) => { fail = reject; });
  const { ctx } = makeCtx(async () => { await gate; });
  ctx.setAppState({ pair: { id: 1 } });
  ctx.sync();
  const flight = ctx.loadFloPartner({ silent: true });

  ctx.setAppState({ pair: { id: 2 } });
  ctx.sync();
  ctx.setFloPartner({ shared: true, confirmed: true });
  fail(new Error("сеть"));
  await flight;
  equal(ctx.getFloPartner().shared, true);
});
