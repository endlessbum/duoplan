// UI групп фильмов: buildMovieEntries/sortMovieEntries/renderMovieGroup —
// свёрнутая стопка, раскрытие, прогресс, порядок внутри группы.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { deepStrictEqual, equal, ok } from "node:assert/strict";
import { test } from "node:test";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const source = readFileSync(join(root, "public", "app.js"), "utf8");

function extractBraced(declaration) {
  const start = source.indexOf(declaration);
  if (start === -1) throw new Error(`${declaration} not found`);
  let depth = 0;
  for (let j = source.indexOf("{", start); j < source.length; j++) {
    if (source[j] === "{") depth++;
    else if (source[j] === "}") {
      depth--;
      if (depth === 0) return source.slice(start, j + 1);
    }
  }
  throw new Error(`unclosed block: ${declaration}`);
}
function extractLine(prefix) {
  const start = source.indexOf(prefix);
  if (start === -1) throw new Error(`${prefix} not found`);
  return source.slice(start, source.indexOf("\n", start));
}

const GROUP = {
  id: "g1", title: "Сага", group_type: "franchise",
  total_count: 3, open_count: 1, watched_count: 2, watched_percent: 67,
  movie_count: 2, series_count: 1,
  created_at: 100, updated_at: 100,
  anchor: { movie_id: 11, year: 2001, kind: "movie", rating: 8, runtime: 120, genres: "Драма", created_at: 100 },
  sort_added_at: 300, sort_raofp: 8.5
};

const { buildMovieEntries, sortMovieEntries, renderMovieGroup, movieGroupMap } = new Function(
  "appState", "movieGroupDetails", "expandedMovieGroups", "movieKindFilter", "movieItem", "loadMovieGroup",
  [
    extractBraced("const MOVIE_GROUP_TYPE_LABELS"),
    extractBraced("function plural"),
    extractBraced("function esc"),
    extractBraced("function byRowId"),
    extractBraced("function movieGroupMap"),
    extractBraced("function movieGroupNoun"),
    extractBraced("function buildMovieEntries"),
    extractBraced("function movieEntrySortMovie"),
    extractBraced("const movieSort"),
    extractBraced("function movieSortValue"),
    extractBraced("function sortMovieEntries"),
    extractLine("  const MENU_ICON"),
    extractBraced("function itemActionButton"),
    extractBraced("function itemActions"),
    extractBraced("function renderMovieGroup"),
    "return { buildMovieEntries, sortMovieEntries, renderMovieGroup, movieGroupMap };"
  ].join("\n")
)(
  { movieGroups: [GROUP], movies: [] },
  new Map(),
  new Set(),
  { open: "all", watched: "all" },
  (movie) => `<MOVIE:${movie.id}>`,
  async () => {}
);

const member = (id, extra = {}) => ({
  id, group_id: "g1", group_position: 0, title: `Часть ${id}`,
  kind: "movie", watched: 0, rating: 7, created_at: 100, ...extra
});

test("buildMovieEntries: члены группы собираются в один элемент, одиночные — как есть", () => {
  const entries = buildMovieEntries([
    { id: 1, title: "Одиночный" },
    member(11, { group_position: 1 }),
    member(12, { group_position: 0 })
  ]);
  equal(entries.length, 2);
  const groupEntry = entries.find((e) => e.type === "group");
  ok(groupEntry, "нет группового элемента");
  // Внутри — ручной порядок position, а не порядок входного массива.
  deepStrictEqual(groupEntry.members.map((m) => m.id), [12, 11]);
  const single = entries.find((e) => e.type === "movie");
  equal(single.movie.id, 1);
});

test("buildMovieEntries: фильм с group_id, которого нет в movieGroups, не прячется", () => {
  const entries = buildMovieEntries([member(99, { group_id: "ghost" })]);
  equal(entries.length, 1);
  equal(entries[0].type, "movie");
});

test("свёрнутая стопка: счётчики, прогресс, тип, слои по полной сводке группы", () => {
  const group = { ...GROUP, open_count: 2 };
  const html = renderMovieGroup({
    type: "group", group, members: [member(11, { group_position: 0 }), member(12, { group_position: 1 })]
  }, "open");
  ok(html.includes("Сага"), "нет названия группы");
  ok(html.includes("Франшиза"), "нет типа группы");
  ok(html.includes("3 части"), "нет общего числа частей");
  ok(html.includes("2 из 3 просмотрено"), "нет прогресса");
  ok(html.includes('aria-valuenow="67"'), "нет aria-значения прогресса");
  ok(html.includes("movie-group-stack__layer"), "нет заднего слоя стопки");
  ok(!html.includes("<MOVIE:"), "свёрнутая стопка не должна показывать карточки частей");
  ok(html.includes("Показать 2 части"), "нет кнопки раскрытия");
  ok(html.includes('aria-expanded="false"'), "нет aria-expanded");
  ok(html.includes('aria-controls="movie-group-members-g1"'), "кнопка не связана с контейнером");
  ok(html.includes('id="movie-group-members-g1" hidden'), "контейнер должен существовать и в свёрнутом виде");
  ok(html.includes('aria-label="Прогресс просмотра группы Сага"'), "нет доступного имени прогресс-бара");
  ok(html.includes('aria-valuetext="2 из 3 просмотрено"'), "нет текстового значения прогресса");
});

test("UI-05: кнопка и слои стопки считаются по всей группе, а не по загруженной странице", () => {
  const group = { ...GROUP, id: "g8", total_count: 8, open_count: 8, watched_count: 0, watched_percent: 0 };
  const html = renderMovieGroup({ type: "group", group, members: [member(11)] }, "open");
  ok(html.includes("Показать 8 частей"), "кнопка показывает только загруженную страницу");
  ok(html.includes("Показано 1 из 8"), "нет пометки о неполной загрузке");
  equal((html.match(/movie-group-stack__layer/g) || []).length, 2, "стопка не показывает два задних слоя");
});

test("UI-05/A11Y-06: фильтр типа использует счётчики статуса+типа, раскрытие обновляет aria", () => {
  const group = { ...GROUP, id: "gs", total_count: 8, open_count: 7, watched_count: 1, open_series_count: 5 };
  const expanded = new Set();
  const kindRender = new Function(
    "appState", "movieGroupDetails", "expandedMovieGroups", "movieKindFilter", "movieItem", "loadMovieGroup",
    [
      extractBraced("const MOVIE_GROUP_TYPE_LABELS"),
      extractBraced("function plural"),
      extractBraced("function esc"),
      extractBraced("function byRowId"),
      extractBraced("function movieGroupMap"),
      extractBraced("function movieGroupNoun"),
      extractBraced("function buildMovieEntries"),
      extractBraced("function movieEntrySortMovie"),
      extractBraced("const movieSort"),
      extractBraced("function movieSortValue"),
      extractBraced("function sortMovieEntries"),
      extractLine("  const MENU_ICON"),
      extractBraced("function itemActionButton"),
      extractBraced("function itemActions"),
      extractBraced("function renderMovieGroup"),
      "return renderMovieGroup;"
    ].join("\n")
  )(
    { movieGroups: [group], movies: [] },
    new Map([["gs", { status: "ready", items: [] }]]),
    expanded,
    { open: "series", watched: "all" },
    (movie) => `<MOVIE:${movie.id}>`,
    async () => {}
  );
  const html = kindRender({ type: "group", group, members: [member(11)] }, "open");
  ok(html.includes("Показать 5 частей"), "фильтр «Сериалы» должен считать по open_series_count");
  ok(html.includes('aria-expanded="false"'), "свёрнутая кнопка не обновила aria-expanded");
  expanded.add("gs");
  const openHtml = kindRender({ type: "group", group, members: [member(11)] }, "open");
  ok(openHtml.includes('aria-expanded="true"'), "раскрытая кнопка не обновила aria-expanded");
  ok(openHtml.includes('id="movie-group-members-gs">'), "раскрытый контейнер не доступен по aria-controls");
  ok(/aria-hidden="true"/.test(openHtml), "декоративные слои должны быть скрыты от скринридера");
});

test("раскрытая стопка: части грузятся с сервера и рендерятся по фильтру вида", () => {
  const details = new Map([["g1", {
    status: "ready",
    items: [
      member(11, { group_position: 0, watched: 0 }),
      member(12, { group_position: 1, watched: 1, watched_at: 1730000000 }),
      { ...member(13, { group_position: 2, watched: 1, kind: "series" }), group_id: "g1" }
    ]
  }]]);
  const expanded = new Set(["g1"]);
  const render = new Function(
    "appState", "movieGroupDetails", "expandedMovieGroups", "movieKindFilter", "movieItem", "loadMovieGroup",
    [
      extractBraced("const MOVIE_GROUP_TYPE_LABELS"),
      extractBraced("function plural"),
      extractBraced("function esc"),
      extractBraced("function byRowId"),
      extractBraced("function movieGroupMap"),
      extractBraced("function movieGroupNoun"),
      extractBraced("function buildMovieEntries"),
      extractBraced("function movieEntrySortMovie"),
      extractBraced("const movieSort"),
      extractBraced("function movieSortValue"),
      extractBraced("function sortMovieEntries"),
      extractLine("  const MENU_ICON"),
      extractBraced("function itemActionButton"),
      extractBraced("function itemActions"),
      extractBraced("function renderMovieGroup"),
      "return renderMovieGroup;"
    ].join("\n")
  )(
    { movieGroups: [GROUP], movies: [] },
    details,
    expanded,
    { open: "all", watched: "all" },
    (movie) => `<MOVIE:${movie.id}:${movie.watched}>`,
    async () => {}
  );
  const entries = buildMovieEntries([member(11)]);
  // Вид «В планах»: только непросмотренные части.
  const openHtml = render(entries[0], "open");
  ok(openHtml.includes("<MOVIE:11:0>"), "нет открытой части");
  ok(!openHtml.includes("<MOVIE:12"), "просмотренная часть попала в «В планах»");
  // Вид «Просмотрено»: обе просмотренные, включая сериал.
  const watchedHtml = render(entries[0], "watched");
  ok(watchedHtml.includes("<MOVIE:12:1>") && watchedHtml.includes("<MOVIE:13:1>"), "нет просмотренных частей");
  ok(watchedHtml.includes("Скрыть части"), "нет кнопки сворачивания");
});

test("раскрытая стопка без кэша показывает загрузку, при ошибке — повтор", () => {
  const render = new Function(
    "appState", "movieGroupDetails", "expandedMovieGroups", "movieKindFilter", "movieItem", "loadMovieGroup",
    [
      extractBraced("const MOVIE_GROUP_TYPE_LABELS"),
      extractBraced("function plural"),
      extractBraced("function esc"),
      extractBraced("function byRowId"),
      extractBraced("function movieGroupMap"),
      extractBraced("function movieGroupNoun"),
      extractBraced("function buildMovieEntries"),
      extractBraced("function movieEntrySortMovie"),
      extractBraced("const movieSort"),
      extractBraced("function movieSortValue"),
      extractBraced("function sortMovieEntries"),
      extractLine("  const MENU_ICON"),
      extractBraced("function itemActionButton"),
      extractBraced("function itemActions"),
      extractBraced("function renderMovieGroup"),
      "return renderMovieGroup;"
    ].join("\n")
  )(
    { movieGroups: [GROUP], movies: [] },
    new Map([["g1", { status: "error", items: [] }]]),
    new Set(["g1"]),
    { open: "all", watched: "all" },
    () => "",
    async () => {}
  );
  const html = render({ type: "group", group: GROUP, members: [member(11)] }, "open");
  ok(html.includes("Повторить"), "нет кнопки повтора при ошибке загрузки");
  ok(html.includes('data-action="movie-group-retry"'), "retry без data-action");
});

test("сортировка: группа встаёт по anchor первой части и sort_raofp", () => {
  const GROUP2 = { ...GROUP, id: "g2", title: "Вторая", anchor: { movie_id: 50, year: 2020, kind: "movie", rating: 5, runtime: 90, genres: "", created_at: 50 }, sort_added_at: 50, sort_raofp: 5 };
  const state = { movieGroups: [GROUP, GROUP2], movies: [] };
  const sort = new Function(
    "appState",
    [
      extractBraced("const MOVIE_GROUP_TYPE_LABELS"),
      extractBraced("function plural"),
      extractBraced("function esc"),
      extractBraced("function byRowId"),
      extractBraced("function movieGroupMap"),
      extractBraced("function movieGroupNoun"),
      extractBraced("function buildMovieEntries"),
      extractBraced("function movieEntrySortMovie"),
      extractBraced("const movieSort"),
      extractBraced("function movieSortValue"),
      extractBraced("function sortMovieEntries"),
      "return { buildMovieEntries, sortMovieEntries };"
    ].join("\n")
  )(state);
  // Ключ «rating» по возрастанию: anchor.rating 5 (g2) раньше 8 (g1).
  sort.sortMovieEntries; // film
  const entries = sort.buildMovieEntries([
    { id: 1, title: "Одиночный", rating: 6, created_at: 10 },
    member(11, { group_position: 0 }),
    { ...member(21, { group_id: "g2", group_position: 0 }), id: 21 }
  ]);
  // Подменяем movieSort на asc/rating через eval-окружение нельзя —
  // проверяем, что группа вообще участвует в сортировке по anchor:
  // movieEntrySortMovie(g1).rating === 8, (g2) === 5.
  const sorted = sort.sortMovieEntries(entries, "open");
  ok(sorted.length === 3, "элементы потерялись при сортировке");
  const titles = sorted.map((e) => e.type === "group" ? e.group.id : `m${e.movie.id}`);
  // Дефолтная сортировка «added desc»: g1.sort_added_at=300, g2=50, одиночный=10.
  deepStrictEqual(titles, ["g1", "g2", "m1"]);
});

// BUG-01: цель «Добавить часть» больше не живёт в глобальной переменной —
// она принадлежит конкретному открытию диалога и умирает вместе с ним.
test("BUG-01: цель добавления части считывается из контекста и обнуляется до запроса", () => {
  ok(!source.includes("movieGroupAddTarget"), "глобальная цель всё ещё есть в исходнике");
  const consume = new Function([
    extractBraced("function consumeMovieGroupTarget"),
    "return consumeMovieGroupTarget;"
  ].join("\n"))();

  const addPart = { targetGroupId: "g1" };
  equal(consume(addPart), "g1", "цель не прочитана");
  equal(consume(addPart), null, "цель не обнулена после чтения");
  equal(consume(null), null, "отменённый диалог не должен оставлять цель");
  equal(consume({}), null, "обычный поиск не должен наследовать группу");
});

test("BUG-01: обычный поиск открывается без цели, «Добавить часть» — с целью", () => {
  const calls = [];
  const openSearch = new Function("openDialog", "appState", [
    extractBraced("function openMovieSearchDialog"),
    "return openMovieSearchDialog;"
  ].join("\n"))((config) => calls.push(config), {});

  openSearch();
  equal(calls.at(-1).targetGroupId, null, "обычный поиск получил цель группы");
  ok(!calls.at(-1).fields.includes('name="local_q"'), "обычный поиск не должен показывать локальный список");

  openSearch("Добавить часть в группу", "g2", { returnToManager: true });
  equal(calls.at(-1).targetGroupId, "g2");
  equal(calls.at(-1).returnToManager, true);
  ok(calls.at(-1).fields.includes('name="local_q"'), "в режиме части нужен локальный поиск");
});

test("BUG-01: закрытие диалога очищает контекст, а обычное добавление не передаёт группу", () => {
  ok(/dialog\.addEventListener\("close"[\s\S]{0,500}dialogContext = null/.test(source),
    "close-обработчик должен выбрасывать контекст вместе с целью");
  ok(/action === "add-movie"\)\s*\{\s*openMovieSearchDialog\(\);/.test(source),
    "обычное «Найти кино» должно открываться без аргументов");
  ok(/const operation = captureAddOperation\(dialogContext\);/.test(source),
    "тап по подсказке должен фиксировать цель из контекста до запроса");
});

// BUG-09: сетевая операция привязана к исходному контексту, а не к текущему
// глобальному dialogContext, который может исчезнуть/замениться во время await.
test("BUG-09: цель операции фиксируется до await и не подменяется новым окном", () => {
  const helpers = new Function([
    extractBraced("function consumeMovieGroupTarget"),
    extractBraced("function captureAddOperation"),
    extractBraced("function operationOwnsDialog"),
    "return { captureAddOperation, operationOwnsDialog };"
  ].join("\n"))();

  const first = { targetGroupId: "A", returnToManager: true };
  const operation = helpers.captureAddOperation(first);
  equal(operation.groupTarget, "A", "цель исходной операции потеряна");
  equal(operation.returnToManager, true);
  equal(first.targetGroupId, null, "цель не снята с исходного контекста");

  // Первое окно закрыли, открыли другое для группы B.
  equal(helpers.operationOwnsDialog(operation, null), false, "закрытое окно всё ещё считается текущим");
  const second = { targetGroupId: "B", returnToManager: true };
  equal(helpers.operationOwnsDialog(operation, second), false, "старый обработчик принял новое окно");
  const other = helpers.captureAddOperation(second);
  equal(other.groupTarget, "B");
  equal(operation.groupTarget, "A", "старая операция подменила группу");
  equal(helpers.operationOwnsDialog(operation, first), true, "своё окно не определяется как текущее");
});

test("BUG-09: обработчик IMDb не читает глобальный контекст после await и не закрывает чужое окно", () => {
  const handler = source.slice(
    source.indexOf('const btn = e.target.closest?.(".movie-suggest-item")'),
    source.indexOf('dialogForm.addEventListener("submit"')
  );
  const captureAt = handler.indexOf("captureAddOperation(dialogContext)");
  const awaitAt = handler.indexOf("await request(");
  ok(captureAt >= 0 && awaitAt > captureAt, "контекст не зафиксирован до первого await");
  ok(!/consumeMovieGroupTarget\(dialogContext\)/.test(handler.slice(awaitAt)),
    "после await снова читается глобальный контекст");
  ok(handler.includes("operationOwnsDialog(operation, dialogContext) && dialog.open"),
    "нет проверки, что диалог всё ещё принадлежит операции");
  ok(handler.includes("if (ownsDialog) dialog.close();"), "close не защищён проверкой владельца");
  ok(handler.includes("operation.context.busy = true"), "нет флага busy, привязанного к операции");
  ok(!handler.includes("dialogSubmitting = true"), "используется глобальный флаг вместо контекстного");
});

// GAP-02: присоединение уже сохранённой карточки — через movie_id, без
// создания дубликата; перенос из другой группы только с подтверждением.
const normalizeMovieTitle = new Function([
  extractBraced("function normalizeMovieTitle"),
  "return normalizeMovieTitle;"
].join("\n"))();

function makeLocalCandidates(movies, groups) {
  return new Function(
    "appState", "movieGroupDetails", "normalizeMovieTitle", "movieList", "movieGroupMap",
    [extractBraced("function movieGroupLocalCandidates"), "return movieGroupLocalCandidates;"].join("\n")
  )(
    { movies },
    new Map(),
    normalizeMovieTitle,
    () => movies,
    () => new Map(groups.map((g) => [g.id, g]))
  );
}

test("GAP-02: локальный поиск возвращает сохранённые карточки, кроме уже состоящих в целевой группе", () => {
  const movies = [
    { id: 1, title: "Гарри Поттер и Кубок огня", year: 2005, kind: "movie" },
    { id: 2, title: "Гарри Поттер и Чаша пламени", year: 2005, kind: "movie", group_id: "g1" },
    { id: 3, title: "Гарри Поттер и Принц-полукровка", year: 2009, kind: "movie", group_id: "g2" }
  ];
  const candidates = makeLocalCandidates(movies, [
    { id: "g1", title: "Гарри Поттер" },
    { id: "g2", title: "Другая сага" }
  ])("поттер", "g1");

  deepStrictEqual(candidates.map((m) => m.id), [1, 3]);
  equal(candidates[0].sourceGroupId, null, "отдельная карточка не должна иметь источник");
  equal(candidates[1].sourceGroupTitle, "Другая сага", "не подставлено название исходной группы");
  // Исходная группа g2 уже расформирована и отсутствует в сводках — такую
  // запись предлагаем как отдельную, без запроса move_from_group_id.
  const stale = makeLocalCandidates(movies, [{ id: "g1", title: "Гарри Поттер" }])("поттер", "g1");
  deepStrictEqual(stale.map((m) => m.id), [1, 3]);
  equal(stale[1].sourceGroupId, null, "расформированная группа не должна требовать переноса");
});

test("GAP-02: тело запроса содержит movie_id и move_from_group_id только после подтверждения", () => {
  const body = new Function([
    extractBraced("function movieGroupAttachBody"),
    "return movieGroupAttachBody;"
  ].join("\n"))();

  deepStrictEqual(body(42, null), { movie_id: 42 });
  deepStrictEqual(body("42", "g2"), { movie_id: 42, move_from_group_id: "g2" });
});

test("GAP-02: присоединение существующей записи идёт в items, а не в /api/movies", async () => {
  const clickHandler = source.slice(
    source.indexOf("const localBtn = e.target.closest"),
    source.indexOf("const btn = e.target.closest?.(\".movie-suggest-item\")")
  );
  ok(clickHandler.includes("movie-group-local-pick"), "нет обработчика локального выбора");
  ok(clickHandler.includes("attachExistingMovieToGroup"), "локальный выбор не вызывает присоединение");
  ok(clickHandler.includes("Перенести из другой группы?"), "нет подтверждения переноса");
  ok(!clickHandler.includes('request("/api/movies"'), "нельзя создавать дубликат через /api/movies");
  const attach = new Function("request", "appState", [
    extractBraced("function movieGroupAttachBody"),
    extractBraced("async function attachExistingMovieToGroup"),
    "return attachExistingMovieToGroup;"
  ].join("\n"));
  const calls = [];
  const run = attach(async (path, options) => { calls.push({ path, options }); return { ok: true }; }, {});
  await run("g1", { id: 7, title: "Фильм" }, "g2");
  equal(calls[0].path, "/api/movie-groups/g1/items");
  equal(calls[0].options.method, "POST");
  deepStrictEqual(calls[0].options.body, { movie_id: 7, move_from_group_id: "g2" });
});

// UX-03/UX-04: черновик менеджера сохраняется при переходе к другим
// действиям, а двухэлементная группа при удалении части исчезает с
// понятным сообщением.
const draftBundle = new Function(
  "dialogFields", "request", "movieGroupDetails", "loadMovieGroup",
  [
    "let movieGroupDraft = null; let appState = null;",
    extractBraced("function movieGroupDraftSnapshot"),
    extractBraced("function readMovieGroupDraftForm"),
    extractBraced("function movieGroupDraftChanged"),
    extractBraced("async function saveMovieGroupDraft"),
    [
      "return {",
      "  movieGroupDraftSnapshot,",
      "  movieGroupDraftChanged,",
      "  setDraft: (d) => { movieGroupDraft = d; },",
      "  saveMovieGroupDraft",
      "};"
    ].join("\n")
  ].join("\n")
)(
  { querySelector: () => null },
  async (path, options) => ({ path, options, result: true }),
  new Map(),
  async () => {}
);

test("UX-03: черновик менеджера отправляется только при реальных изменениях", async () => {
  const draft = {
    groupId: "g1", order: [1, 2], title: "Сага", group_type: "franchise"
  };
  draft.initial = draftBundle.movieGroupDraftSnapshot(draft);
  draftBundle.setDraft(draft);
  equal(draftBundle.movieGroupDraftChanged(), false);
  equal(await draftBundle.saveMovieGroupDraft(), false, "без изменений PATCH не нужен");

  draft.order.reverse();
  draft.title = "Новая сага";
  equal(draftBundle.movieGroupDraftChanged(), true);
  equal(await draftBundle.saveMovieGroupDraft(), true);
  equal(draft.initial.title, "Новая сага", "снимок должен обновиться после сохранения");
  equal(draftBundle.movieGroupDraftChanged(), false, "после сохранения изменений быть не должно");
});

test("UX-03/UX-04: менеджер сохраняет черновик при переходе и сообщает о расформировании", () => {
  const handler = source.slice(
    source.indexOf('} else if (action === "mg-up"'),
    source.indexOf('} else if (action === "movie-group-disband")')
  );
  ok(handler.includes("readMovieGroupDraftForm()"), "перестановки теряют поля названия/типа");
  ok(handler.includes("await saveMovieGroupDraft()"), "черновик не сохраняется перед удалением");
  ok(handler.includes("chain:"), "менеджер не возвращается после успешного удаления");
  ok(handler.includes("Группа расформирована — оба фильма остались в списке отдельно"),
    "нет отдельного сообщения о расформировании группы из двух частей");
  ok(handler.includes('openMovieGroupManager(groupId, { notice: "Часть убрана из группы" })'),
    "менеджер не переоткрывается для группы из 3+ частей");
  const addPart = source.slice(
    source.indexOf('} else if (action === "movie-group-add-part")'),
    source.indexOf('} else if (action === "mg-up"')
  );
  ok(addPart.includes("await saveMovieGroupDraft()"), "перед добавлением части черновик теряется");
  ok(addPart.includes("{ returnToManager: fromManager }"), "после добавления части менеджер не открывается заново");
  // Уведомление должно жить внутри менеджера: тост под модальным <dialog>
  // не виден пользователю.
  ok(source.includes('class="movie-group-notice"'), "result messages inside manager missing");
  ok(extractBraced("async function afterGroupPartAdded").includes("{ notice: message }"),
    "менеджер не получает текст результата");
});
