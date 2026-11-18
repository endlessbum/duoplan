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
const css = readFileSync(join(root, "public", "app.css"), "utf8");

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
  "appState", "movieGroupDetails", "movieKindFilter", "movieItem", "loadMovieGroup",
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

test("карточка стопки: счётчики, прогресс, тип, слои и кнопка окна", () => {
  const group = { ...GROUP, open_count: 2 };
  const html = renderMovieGroup({
    type: "group", group, members: [member(11, { group_position: 0 }), member(12, { group_position: 1 })]
  }, "open");
  ok(html.includes("Сага"), "нет названия группы");
  ok(html.includes("Франшиза"), "нет типа группы");
  ok(html.includes("3 части"), "нет общего числа частей");
  ok(html.includes("2 из 3 просмотрено"), "нет прогресса");
  ok(html.includes('aria-valuenow="67"'), "нет aria-значения прогресса");
  ok(html.includes('data-layers="1"'), "две части — один задний слой и расширенная передняя карточка");
  equal((html.match(/movie-group-stack__layer/g) || []).length, 1, "должен быть ровно один задний слой");
  ok(!html.includes("<MOVIE:"), "карточка не должна показывать части");
  ok(html.includes("Показать 2 части"), "нет кнопки просмотра частей");
  ok(html.includes('data-action="movie-group-open"'), "кнопка не открывает окно состава");
  ok(html.includes('data-view="open"'), "кнопка не передаёт вид списка");
  ok(html.includes('aria-haspopup="dialog"'), "кнопка не объявляет окно");
  ok(!html.includes("ещё в планах"), "под шкалой осталась подпись о планах");
  ok(!html.includes("Показано "), "под шкалой осталась подпись о загрузке");
  ok(!html.includes("movie-group-members"), "состав не должен разворачиваться в списке");
  ok(html.includes('aria-label="Прогресс просмотра группы Сага"'), "нет доступного имени прогресс-бара");
  ok(html.includes('aria-valuetext="2 из 3 просмотрено"'), "нет текстового значения прогресса");
});

test("UI-05: кнопка и слои стопки считаются по всей группе, а не по загруженной странице", () => {
  const group = { ...GROUP, id: "g8", total_count: 8, open_count: 8, watched_count: 0, watched_percent: 0 };
  const html = renderMovieGroup({ type: "group", group, members: [member(11)] }, "open");
  ok(html.includes("Показать 8 частей"), "кнопка показывает только загруженную страницу");
  ok(!html.includes("Показано "), "дубль счётчика под шкалой больше не нужен");
  equal((html.match(/movie-group-stack__layer/g) || []).length, 2, "стопка не показывает два задних слоя");
  ok(html.includes('data-layers="2"'), "3+ части — два задних слоя");
});

test("одна часть в группе: сплошная карточка без задних слоёв", () => {
  const group = { ...GROUP, id: "g1one", total_count: 1, open_count: 1, watched_count: 0, watched_percent: 0 };
  const html = renderMovieGroup({ type: "group", group, members: [member(11)] }, "open");
  ok(html.includes('data-layers="0"'), "один слой — карточка на полную ширину");
  ok(!html.includes("movie-group-stack__layer"), "у одной части не должно быть задних слоёв");
});

test("Просмотрено: стопка растёт как в «В планах», максимум три карточки", () => {
  const watched = (id) => member(id, { watched: 1 });
  const one = { ...GROUP, id: "gw1", total_count: 1, open_count: 0, open_movie_count: 0, watched_count: 1, watched_movie_count: 1, watched_percent: 100 };
  const h1 = renderMovieGroup({ type: "group", group: one, members: [watched(11)] }, "watched");
  ok(h1.includes('data-layers="0"'), "один просмотренный фильм — карточка на полную ширину");
  ok(!h1.includes("movie-group-stack__layer"), "у одного просмотренного нет задних слоёв");
  ok(h1.includes("Показать 1 часть"), "кнопка считает просмотренные, а не всю группу");

  const two = { ...GROUP, id: "gw2", total_count: 2, open_count: 0, open_movie_count: 0, watched_count: 2, watched_movie_count: 2, watched_percent: 100 };
  const h2 = renderMovieGroup({ type: "group", group: two, members: [watched(11), watched(12)] }, "watched");
  ok(h2.includes('data-layers="1"'), "два просмотренных — один задний слой");
  equal((h2.match(/movie-group-stack__layer/g) || []).length, 1, "ровно одна выглядывающая карточка");

  const four = { ...GROUP, id: "gw4", total_count: 4, open_count: 0, open_movie_count: 0, watched_count: 4, watched_movie_count: 4, watched_percent: 100 };
  const h4 = renderMovieGroup({ type: "group", group: four, members: [watched(11), watched(12), watched(13), watched(14)] }, "watched");
  ok(h4.includes('data-layers="2"'), "четыре просмотренных — максимум три карточки");
  equal((h4.match(/movie-group-stack__layer/g) || []).length, 2, "четвёртая карточка не добавляется");
});

test("стили стопки: запас под слои зависит от их числа", () => {
  ok(/data-layers="1"[\s\S]{0,160}--stack-reserve:\s*calc\(var\(--stack-peek\) \+ 4px\)/.test(css),
    "два фильма — запас на один слой");
  ok(/data-layers="0"[\s\S]{0,160}--stack-reserve:\s*0px/.test(css),
    "один фильм — карточка на полную ширину");
  ok(css.includes("right: calc(var(--stack-reserve) - var(--layer, 1) * var(--stack-peek))"),
    "правый край слоя считается от фактического запаса");
});

test("UI-05/A11Y-06: фильтр типа считает части для окна, слои скрыты от скринридера", () => {
  const group = { ...GROUP, id: "gs", total_count: 8, open_count: 7, watched_count: 1, open_series_count: 5 };
  const kindRender = new Function(
    "appState", "movieGroupDetails", "movieKindFilter", "movieItem", "loadMovieGroup",
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
    { open: "series", watched: "all" },
    (movie) => `<MOVIE:${movie.id}>`,
    async () => {}
  );
  const html = kindRender({ type: "group", group, members: [member(11)] }, "open");
  ok(html.includes("Показать 5 частей"), "фильтр «Сериалы» должен считать по open_series_count");
  ok(html.includes('data-action="movie-group-open"'), "кнопка не открывает окно состава");
  ok(html.includes('data-view="open"'), "окно не получит вид «В планах»");
  ok(/aria-hidden="true"/.test(html), "декоративные слои должны быть скрыты от скринридера");
});

test("окно состава: части фильтруются по статусу и типу текущего вида", () => {
  const details = new Map([["g1", {
    status: "ready",
    items: [
      member(11, { group_position: 0, watched: 0 }),
      member(12, { group_position: 1, watched: 1, watched_at: 1730000000 }),
      { ...member(13, { group_position: 2, watched: 1, kind: "series" }), group_id: "g1" }
    ]
  }]]);
  const partItems = new Function("movieGroupDetails", "movieKindFilter", [
    extractBraced("function movieGroupPartItems"),
    "return movieGroupPartItems;"
  ].join("\n"))(details, { open: "all", watched: "all" });
  // Вид «В планах»: только непросмотренные части.
  deepStrictEqual(partItems("g1", "open").map((m) => m.id), [11]);
  // Вид «Просмотрено»: обе просмотренные, включая сериал.
  deepStrictEqual(partItems("g1", "watched").map((m) => m.id), [12, 13]);
});

test("окно состава: загрузка, ошибка с повтором и карточки через movieItem", () => {
  const details = new Map([["g1", { status: "ready", items: [member(11)] }]]);
  const fields = { innerHTML: "" };
  const dialog = { open: true };
  const context = {};
  const partItems = (groupId, view) => details.get(groupId).items;
  const renderParts = new Function(
    "dialogContext", "dialog", "dialogFields", "esc", "movieGroupDetails", "movieGroupPartItems", "movieItem",
    [
      extractBraced("function renderMovieGroupParts"),
      "return renderMovieGroupParts;"
    ].join("\n")
  )(context, dialog, fields, (s) => s, details, partItems, (m) => `<MOVIE:${m.id}>`);
  details.set("g1", { status: "loading", items: [] });
  renderParts("g1", "open", context);
  ok(fields.innerHTML.includes("Загружаем части группы"), "нет состояния загрузки");
  details.set("g1", { status: "error", items: [] });
  renderParts("g1", "open", context);
  ok(fields.innerHTML.includes("Повторить"), "нет кнопки повтора при ошибке загрузки");
  ok(fields.innerHTML.includes('data-action="movie-group-retry"'), "retry без data-action");
  ok(fields.innerHTML.includes('data-view="open"'), "retry потерял вид списка");
  details.set("g1", { status: "ready", items: [member(11)] });
  renderParts("g1", "open", context);
  ok(fields.innerHTML.includes('<div class="movie-group-members">'), "нет списка карточек в окне");
  ok(fields.innerHTML.includes("<MOVIE:11>"), "карточка части не отрисована через movieItem");
  // Устаревший ответ не должен затирать другое открытое окно.
  fields.innerHTML = "<b>другое окно</b>";
  renderParts("g1", "open", {});
  equal(fields.innerHTML, "<b>другое окно</b>", "старый ответ перезаписал другое окно");
});

test("окно состава открывается через общий openDialog и грузит полный список", async () => {
  const calls = [];
  const rendered = [];
  const parts = new Function("calls", "rendered", "movieGroupMap", "loadMovieGroup", [
    "let dialogContext;",
    "const openDialog = (config) => { calls.push(config); dialogContext = { ...config }; };",
    extractBraced("async function openMovieGroupParts"),
    "const renderMovieGroupParts = (groupId, view, context) => rendered.push({ groupId, view, context });",
    "return openMovieGroupParts;"
  ].join("\n"))(
    calls, rendered,
    () => new Map([["g1", GROUP]]),
    async () => {}
  );
  await parts("g1", "watched");
  equal(calls.length, 1, "окно должно открываться один раз");
  equal(calls[0].title, "Сага", "в заголовке окна нет названия группы");
  equal(calls[0].submitLabel, null, "окно просмотра не должно быть формой сохранения");
  equal(calls[0].readOnly, true, "окно просмотра должно быть read-only");
  deepStrictEqual(calls[0].groupParts, { groupId: "g1", view: "watched" });
  ok(calls[0].fields.includes("Загружаем части группы"), "нет заглушки до ответа сервера");
  equal(rendered.length, 1, "после загрузки окно не заполнено");
  equal(rendered[0].groupId, "g1");
  equal(rendered[0].view, "watched");
  deepStrictEqual(rendered[0].context.groupParts, { groupId: "g1", view: "watched" });
});

// P2-04: группа участвует в сортировке через псевдо-фильм якоря — год,
// рейтинг, длительность (у сериала — число серий), жанр, RAofp и «добавлено»
// должны реально менять её позицию, а не только проверять added desc.
const SORT_GROUPS = [
  { ...GROUP, id: "gHigh", title: "Высокая",
    anchor: { movie_id: 501, year: 2020, kind: "movie", rating: 9, runtime: 200, episodes: null, genres: "Драма", created_at: 1 },
    sort_added_at: 100, sort_raofp: 9 },
  { ...GROUP, id: "gLow", title: "Низкая",
    anchor: { movie_id: 502, year: 1990, kind: "movie", rating: 5, runtime: 80, episodes: null, genres: "Комедия", created_at: 2 },
    sort_added_at: 200, sort_raofp: 5 },
  { ...GROUP, id: "gSeries", title: "Сериаловая",
    anchor: { movie_id: 503, year: 2015, kind: "series", rating: 7, runtime: null, episodes: 300, genres: "Фантастика", created_at: 3 },
    sort_added_at: 300, sort_raofp: 7 }
];
const SORT_MOVIES = [
  { id: 1, title: "Альфа", year: 2010, kind: "movie", rating: 7, runtime: 150, genres: "Боевик", created_at: 400, pair_rating: 8, watched: 0 },
  { id: 2, title: "Бета", year: 1980, kind: "movie", rating: 8.5, runtime: 250, genres: "Ужасы", created_at: 50, pair_rating: 6, watched: 0 }
];
const SORT_MEMBERS = [
  { id: 601, group_id: "gHigh", group_position: 0, watched: 0 },
  { id: 602, group_id: "gLow", group_position: 0, watched: 0 },
  { id: 603, group_id: "gSeries", group_position: 0, watched: 0 }
];

function loadMovieSort(groups) {
  return new Function(
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
      "return { buildMovieEntries, sortMovieEntries, movieSort };"
    ].join("\n")
  )({ movieGroups: groups, movies: [] });
}

test("P2-04: группа сортируется по anchor/сводке для каждого ключа", () => {
  const sort = loadMovieSort(SORT_GROUPS);
  const order = (view = "open") => sort.sortMovieEntries(
    sort.buildMovieEntries([...SORT_MOVIES, ...SORT_MEMBERS]), view
  ).map((e) => e.type === "group" ? e.group.id : `m${e.movie.id}`);
  const setSort = (view, key, dir) => { sort.movieSort[view].key = key; sort.movieSort[view].dir = dir; };

  // «Добавлено»: по самой свежей части группы (sort_added_at), не по anchor.
  setSort("open", "added", "desc");
  deepStrictEqual(order(), ["m1", "gSeries", "gLow", "gHigh", "m2"]);

  // Год — из anchor первой части.
  setSort("open", "year", "desc");
  deepStrictEqual(order(), ["gHigh", "gSeries", "m1", "gLow", "m2"]);

  // Рейтинг IMDb/TMDB — из anchor; равные значения разводит id (m1=1 < 503).
  setSort("open", "rating", "desc");
  deepStrictEqual(order(), ["gHigh", "m2", "m1", "gSeries", "gLow"]);

  // Длительность: фильм — runtime, сериал — число серий (episodes якоря).
  // gSeries с 300 сериями обгоняет все фильмы — без episodes в anchor
  // группа ушла бы в конец.
  setSort("open", "runtime", "desc");
  deepStrictEqual(order(), ["gSeries", "m2", "gHigh", "m1", "gLow"]);

  // Жанр — первая часть genres якоря, по алфавиту (русская коллация:
  // боевик < драма < комедия < ужасы < фантастика).
  setSort("open", "genre", "asc");
  deepStrictEqual(order(), ["m1", "gHigh", "gLow", "m2", "gSeries"]);

  // RAofP — только вид «Просмотрено», значение sort_raofp сводки группы.
  setSort("watched", "raofp", "desc");
  deepStrictEqual(order("watched"), ["gHigh", "m1", "gSeries", "m2", "gLow"]);
});

test("P2-04: пустые значения сортировки уходят в конец, тай-брейк по id", () => {
  const groups = [
    { ...GROUP, id: "gNoRating", title: "Без рейтинга",
      anchor: { movie_id: 510, year: null, kind: "movie", rating: null, runtime: null, genres: "", created_at: 9 },
      sort_added_at: 900, sort_raofp: null }
  ];
  const sort = loadMovieSort(groups);
  sort.movieSort.open.key = "rating";
  sort.movieSort.open.dir = "asc";
  const entries = sort.buildMovieEntries([
    { id: 7, title: "Нет оценки", rating: null, created_at: 10 },
    { id: 3, title: "Низкая", rating: 5, created_at: 20 },
    { id: 9, title: "Тоже низкая", rating: 5, created_at: 30 },
    { id: 4, title: "Высокая", rating: 9, created_at: 40 },
    { id: 601, group_id: "gNoRating", group_position: 0, watched: 0 }
  ]);
  const order = sort.sortMovieEntries(entries, "open")
    .map((e) => e.type === "group" ? e.group.id : `m${e.movie.id}`);
  // rating asc: 5 (id 3), 5 (id 9), 9, затем null-ы по id: m7, gNoRating(510).
  deepStrictEqual(order, ["m3", "m9", "m4", "m7", "gNoRating"]);
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
