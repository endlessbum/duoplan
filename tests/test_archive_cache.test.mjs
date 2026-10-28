// Тест кэша архивов мини-аппа (public/app.js).
//
// archiveCache живёт в пределах одной пары: при смене пары (выход, создание,
// вход по коду) кэш обязан сбрасываться — иначе записи прежнего пространства
// попадут в новое, а счётчик страниц исказит /api/archive. Удаление и правка
// записи должны синхронно обновлять кэш.
//
// Функции извлекаются из app.js как есть и исполняются против локальных
// appState/archiveCache из преамбулы.
//
// Запуск: node tests/test_archive_cache.test.mjs  (или node --test "tests/*.test.mjs")
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { deepStrictEqual, equal } from "node:assert/strict";
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

const load = new Function(
  "request", "render", "STATE_RECENT_LIMIT", "STATE_ACTIVE_LIMIT",
  [
    "let appState = null;",
    "let archiveCachePairId = null;",
    extractBraced("function emptyArchiveEntry"),
    "const archiveCache = { tasks: emptyArchiveEntry(), dates: emptyArchiveEntry(), wishes: emptyArchiveEntry(), memories: emptyArchiveEntry(), done_tasks: emptyArchiveEntry(), done_wishes: emptyArchiveEntry() };",
    "const ARCHIVE_KEYS_BY_TYPE = { memories: ['memories'], dates: ['dates'], tasks: ['tasks', 'done_tasks'], wishes: ['wishes', 'done_wishes'] };",
    extractBraced("function syncArchiveCachePair"),
    extractBraced("function removeFromArchiveCache"),
    extractBraced("function patchArchiveItem"),
    extractBraced("async function loadArchivePage"),
    extractBraced("function mergedArchive"),
    extractBraced("function archiveMoreHtml"),
    "return { setAppState: (v) => { appState = v; }, archiveCache, syncArchiveCachePair, mergedArchive, archiveMoreHtml, removeFromArchiveCache, patchArchiveItem, loadArchivePage };"
  ].join("\n")
);

function makeCtx(requestMock = async () => ({ items: [], hasMore: false }), renderMock = () => {}) {
  return load(requestMock, renderMock, 10, 200);
}

test("смена пары сбрасывает кэш, та же пара — нет", () => {
  const ctx = makeCtx();
  ctx.setAppState({ pair: { id: 1 }, memories: [] });
  ctx.syncArchiveCachePair();
  ctx.archiveCache.memories.items.push({ id: 100, body: "старая запись" });
  ctx.archiveCache.memories.page = 2;
  ctx.archiveCache.memories.hasMore = false;

  // Тот же pair.id (фоновый refresh) — кэш сохраняется.
  ctx.setAppState({ pair: { id: 1 }, memories: [] });
  ctx.syncArchiveCachePair();
  equal(ctx.archiveCache.memories.items.length, 1);
  equal(ctx.archiveCache.memories.page, 2);

  // Новая пара — полный сброс, включая счётчик страниц.
  ctx.setAppState({ pair: { id: 2 }, memories: [] });
  ctx.syncArchiveCachePair();
  deepStrictEqual(ctx.archiveCache.memories, { items: [], page: -1, hasMore: null });
  deepStrictEqual(ctx.archiveCache.done_tasks, { items: [], page: -1, hasMore: null });
  deepStrictEqual(ctx.archiveCache.done_wishes, { items: [], page: -1, hasMore: null });
});

test("выход из пары (pair=null) сбрасывает кэш", () => {
  const ctx = makeCtx();
  ctx.setAppState({ pair: { id: 1 }, memories: [] });
  ctx.syncArchiveCachePair();
  ctx.archiveCache.done_wishes.items.push({ id: 9, body: "желание" });
  ctx.setAppState({ pair: null });
  ctx.syncArchiveCachePair();
  equal(ctx.archiveCache.done_wishes.items.length, 0);
});

test("записи прежней пары не попадают в mergedArchive новой пары", () => {
  const ctx = makeCtx();
  ctx.setAppState({ pair: { id: 1 }, memories: [] });
  ctx.syncArchiveCachePair();
  ctx.archiveCache.memories.items.push({ id: 100, body: "чужое воспоминание" });
  // В пределах той же пары кэш склеивается с недавними (текущее поведение).
  const samePair = ctx.mergedArchive("memories", [{ id: 101, body: "свежее" }]);
  equal(samePair.length, 2);

  ctx.setAppState({ pair: { id: 2 }, memories: [] });
  ctx.syncArchiveCachePair();
  const newPair = ctx.mergedArchive("memories", [{ id: 200, body: "новое воспоминание" }]);
  deepStrictEqual(newPair, [{ id: 200, body: "новое воспоминание" }]);
});

test("removeFromArchiveCache удаляет запись только из кэшей своего типа", () => {
  const ctx = makeCtx();
  // id в разных таблицах D1 независимы: tasks.id=5 и memories.id=5 — разные записи.
  ctx.archiveCache.done_tasks.items.push({ id: 5, title: "план" });
  ctx.archiveCache.tasks.items.push({ id: 5, title: "хвост активных" });
  ctx.archiveCache.memories.items.push({ id: 5, body: "дневник" });
  ctx.removeFromArchiveCache("tasks", 5);
  equal(ctx.archiveCache.done_tasks.items.length, 0);
  equal(ctx.archiveCache.tasks.items.length, 0);
  equal(ctx.archiveCache.memories.items.length, 1);
  // У dates архива нет — вызов безопасен.
  ctx.removeFromArchiveCache("dates", 5);
});

test("patchArchiveItem обновляет архивную копию, сохраняя остальные поля", () => {
  const ctx = makeCtx();
  ctx.archiveCache.memories.items.push({ id: 7, body: "старый текст", day: "2026-01-01" });
  ctx.patchArchiveItem("memories", 7, { body: "новый текст" });
  equal(ctx.archiveCache.memories.items[0].body, "новый текст");
  equal(ctx.archiveCache.memories.items[0].day, "2026-01-01");
  // Несуществующий id — просто без изменений.
  ctx.patchArchiveItem("memories", 999, { body: "мимо" });
  equal(ctx.archiveCache.memories.items.length, 1);
});

test("после сброса кэша кнопка «Показать ещё» и hasMore стартуют с нуля", () => {
  const ctx = makeCtx();
  ctx.setAppState({ pair: { id: 1 }, memories: [] });
  ctx.syncArchiveCachePair();
  ctx.archiveCache.done_tasks.page = 4;
  ctx.archiveCache.done_tasks.hasMore = false;
  ctx.setAppState({ pair: { id: 2 }, completedTasks: [] });
  ctx.syncArchiveCachePair();
  // page=-1 и hasMore=null: следующая загрузка начнётся с первой страницы,
  // кнопка появится по правилам archiveMoreHtml.
  equal(ctx.archiveCache.done_tasks.page, -1);
  equal(ctx.archiveCache.done_tasks.hasMore, null);
  equal(ctx.archiveMoreHtml("done_tasks", 3), "");
});

test("двойной клик по «Показать ещё» загружает страницу один раз и не пропускает следующую", async () => {
  const calls = [];
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const requestMock = async (path) => {
    calls.push(path);
    await gate;
    const page = Number(new URL(path, "http://x").searchParams.get("page"));
    return { items: page === 0 ? [{ id: 11, title: "a" }] : [{ id: 21, title: "c" }], hasMore: page === 0, page };
  };
  let renderCalls = 0;
  const ctx = makeCtx(requestMock, () => { renderCalls += 1; });
  ctx.setAppState({ pair: { id: 1 } });
  ctx.syncArchiveCachePair();

  const first = ctx.loadArchivePage("done_tasks");
  const second = ctx.loadArchivePage("done_tasks"); // флаг loading: выходит сразу
  release();
  await Promise.all([first, second]);

  equal(calls.length, 1);
  deepStrictEqual(calls[0].includes("page=0"), true);
  equal(ctx.archiveCache.done_tasks.items.length, 1);
  equal(ctx.archiveCache.done_tasks.page, 0);
  equal(ctx.archiveCache.done_tasks.loading, false);
  equal(renderCalls, 1);

  // Следующий клик запрашивает страницу 1, а не перепрыгивает её.
  await ctx.loadArchivePage("done_tasks");
  deepStrictEqual(calls[1].includes("page=1"), true);
  deepStrictEqual(ctx.archiveCache.done_tasks.items, [{ id: 11, title: "a" }, { id: 21, title: "c" }]);
  equal(ctx.archiveCache.done_tasks.page, 1);
  equal(ctx.archiveCache.done_tasks.hasMore, false);
});

test("дедуп по id не даёт записи задвоиться в кэше", async () => {
  const ctx = makeCtx(async () => ({ items: [{ id: 5, title: "x" }], hasMore: true }));
  ctx.setAppState({ pair: { id: 1 } });
  ctx.syncArchiveCachePair();
  await ctx.loadArchivePage("done_tasks");
  await ctx.loadArchivePage("done_tasks");
  await ctx.loadArchivePage("done_tasks");
  deepStrictEqual(ctx.archiveCache.done_tasks.items, [{ id: 5, title: "x" }]);
  equal(ctx.archiveCache.done_tasks.page, 2);
});

test("ответ, прилетевший после смены пары, отбрасывается", async () => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const ctx = makeCtx(async () => { await gate; return { items: [{ id: 99 }], hasMore: false }; });
  ctx.setAppState({ pair: { id: 1 } });
  ctx.syncArchiveCachePair();
  const flight = ctx.loadArchivePage("memories");
  ctx.setAppState({ pair: { id: 2 } });
  ctx.syncArchiveCachePair();
  release();
  await flight;
  // Кэш новой пары остался чистым: page=-1, элементов нет.
  deepStrictEqual(ctx.archiveCache.memories, { items: [], page: -1, hasMore: null });
});

test("кнопка «Показать ещё» у активных наборов появляется на границе 200", () => {
  const ctx = makeCtx();
  ctx.setAppState({ pair: { id: 1 } });
  ctx.syncArchiveCachePair();
  equal(ctx.archiveMoreHtml("tasks", 199), "");
  deepStrictEqual(ctx.archiveMoreHtml("tasks", 200).includes("load-archive"), true);
  // Архивный порог не изменился: 10 недавних.
  deepStrictEqual(ctx.archiveMoreHtml("memories", 10).includes("load-archive"), true);
  // После пустой страницы (ровно 200 записей) кнопка исчезает.
  ctx.archiveCache.tasks.page = 0;
  ctx.archiveCache.tasks.hasMore = false;
  equal(ctx.archiveMoreHtml("tasks", 200), "");
});

test("хвост активных планов скрывается, когда запись завершили", () => {
  const ctx = makeCtx();
  const base = Array.from({ length: 200 }, (_, i) => ({ id: i + 1 }));
  ctx.setAppState({ pair: { id: 1 }, tasks: base, completedTasks: [] });
  ctx.syncArchiveCachePair();
  ctx.archiveCache.tasks.items.push({ id: 500, title: "хвост" });
  equal(ctx.mergedArchive("tasks", base).length, 201);
  // id 500 завершили: он уехал в completedTasks и из активного хвоста исчез.
  ctx.setAppState({ pair: { id: 1 }, tasks: base.slice(0, 199), completedTasks: [{ id: 500 }] });
  equal(ctx.mergedArchive("tasks", base.slice(0, 199)).length, 199);
});
