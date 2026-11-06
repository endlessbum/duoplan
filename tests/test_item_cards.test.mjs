// Карточки планов/дат/желаний и их чипы (public/app.js) — rich-mock рендер.
//
// Тесты извлекают рендереры и гоняют их с насыщенными данными (приватные,
// просроченные, без даты, 29 февраля) — по уроку п.24: функции в изоляции и
// пустые моки не ловят ошибки рендер-пути.
//
// Запуск: node --test tests/test_item_cards.test.mjs
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { equal, ok } from "node:assert/strict";
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

function extractLine(prefix) {
  const start = source.indexOf(prefix);
  if (start === -1) throw new Error(`${prefix} не найдено`);
  return source.slice(start, source.indexOf("\n", start));
}

const load = new Function(
  [
    // pairTimeZone и applyAccent-путь читают appState/документ — минимальные стабы.
    'const appState = { pair: { timezone: "Europe/Moscow", user_b: 1 }, user: { tg_id: 1 } };',
    'const document = { documentElement: { dataset: { theme: "dark" } }, querySelectorAll: () => [] };',
    extractLine("  const RICH_TOKENS"),
    extractLine("  const REOPEN_ICON"),
    extractLine("  const DONE_ICON"),
    extractLine("  const EDIT_ICON"),
    extractLine("  const DELETE_ICON"),
    extractBraced("function esc"),
      extractBraced("function itemActionButton"),
      extractBraced("function itemActions"),
    extractBraced("function formatDay"),
    extractBraced("function formatTimestamp"),
    extractBraced("function completionMeta"),
    extractBraced("function richInline"),
    extractBraced("function renderRichText"),
    extractBraced("function pairTimeZone"),
    extractBraced("function timeZoneOffsetMs"),
    extractBraced("function makeDateInTimeZone"),
    extractBraced("function zonedToday"),
    extractBraced("function planTarget"),
    extractBraced("function taskRepeat"),
    extractBraced("function monthlyNext"),
    extractBraced("function yearlyNext"),
    extractBraced("function byRowId"),
    extractBraced("function dayTime"),
    extractBraced("function annualDate"),
    extractBraced("function nextOccurrence"),
    extractBraced("function plural"),
    extractBraced("function countdownFromDiff"),
    extractBraced("function countdownChip"),
    extractBraced("function calendarKeyFromDate"),
    extractBraced("function formatBirthday"),
    extractBraced("function nextDaysLabel"),
    extractBraced("function taskItem"),
    extractBraced("function dateItem"),
    extractBraced("function birthdayItem"),
    extractBraced("function wishItem"),
    extractBraced("function completedTaskItem"),
    extractBraced("function completedWishItem"),
    "return { taskItem, dateItem, birthdayItem, wishItem, completedTaskItem, completedWishItem, countdownChip, REOPEN_ICON, formatDay };"
  ].join("\n")
);
const { taskItem, dateItem, birthdayItem, wishItem, completedTaskItem, completedWishItem, countdownChip, REOPEN_ICON, formatDay } = load();

test("у плана с датой карточка-кнопка календаря, у плана без даты — нет", () => {
  const withDay = taskItem({ id: 1, title: "План", day: "2026-11-05", time: "19:30", is_private: 0 });
  // Кнопки «В календаре» больше нет — переход по тапу на саму карточку.
  ok(!withDay.includes("link-btn"), "кнопка «В календаре» вернулась");
  ok(withDay.includes('data-action="show-in-calendar"'), "карточка не ведёт в календарь");
  ok(withDay.includes('data-day="2026-11-05"'), "data-day не передан");
  ok(withDay.includes('role="button"'), "карточка без роли кнопки");
  const noDay = taskItem({ id: 2, title: "Идея", day: "", time: "", is_private: 0 });
  ok(!noDay.includes("show-in-calendar"), "карточка без даты не должна вести в календарь");
  ok(!noDay.includes('role="button"'), "карточка без даты не должна быть кнопкой");
});

test("у значимой даты вся карточка ведёт в календарь с её днём", () => {
  for (const item of [
    { id: 3, title: "Ежегодная", day: "2021-05-17", time: "", recurs: 1, is_private: 0 },
    { id: 4, title: "Разовая", day: "2024-01-01", time: "12:00", recurs: 0, is_private: 1 }
  ]) {
    const html = dateItem(item);
    ok(html.includes('data-action="show-in-calendar"'), item.title);
    ok(html.includes(`data-day="${item.day}"`), item.title);
    ok(!html.includes("link-btn"), "кнопка «В календаре» вернулась: " + item.title);
  }
});

test("карточка дня рождения ведёт в календарь на ближайшее наступление", () => {
  // Регрессия 2026-11-06: у birthdayCard тапа не было вовсе — карточка
  // «Дней рождения» и главная не открывали календарь.
  const html = birthdayItem({ id: 11, title: "Маша", day: "1990-05-14", time: "", is_private: 0 });
  ok(html.includes('data-action="show-in-calendar"'), "тап не повешен");
  ok(html.includes('role="button"'), "карточка без роли кнопки");
  ok(!html.includes("link-btn"), "кнопка «В календаре» вернулась");
  // Сырой день рождения увёл бы календарь в 1990 год: проекция — месяц/день
  // в текущем или следующем году.
  const day = html.match(/data-day="(\d{4}-\d{2}-\d{2})"/)?.[1];
  ok(day, "data-day без валидной даты");
  const currentYear = new Date().getFullYear();
  const year = Number(day.slice(0, 4));
  ok((year === currentYear || year === currentYear + 1) && day.slice(5) === "05-14",
    `проекция неверна: ${day}`);
});

test("карточки рендерятся без ошибок на богатом наборе состояний", () => {
  const mocks = [
    () => taskItem({ id: 5, title: "**Сюрприз** ||скрытый||", day: "2026-11-05", time: "19:30", is_private: 1 }),
    () => taskItem({ id: 6, title: "Просрочка за год", day: "2025-10-30", time: "10:00", is_private: 0 }),
    () => dateItem({ id: 7, title: "29 февраля", day: "2020-02-29", time: "", recurs: 1, is_private: 1 }),
    () => dateItem({ id: 8, title: "Будущее", day: "2027-01-01", time: "", recurs: 1, is_private: 0 })
  ];
  for (const render of mocks) {
    const html = render();
    ok(html.includes("item-row"), "карточка не отрендерилась");
    ok(!html.includes("undefined") && !html.includes("NaN"), "в разметке undefined/NaN");
  }
});

test("просрочка старше недели — приглушённый is-stale, свежая и будущая — нет", () => {
  // Даты относительные: фиксированная «свежая просрочка» устаревала вместе с
  // календарём и сама превращалась в недельную (2026-10-30 сломалось 2026-11-06).
  const day = (offsetDays) => new Date(Date.now() + offsetDays * 86400000).toISOString().slice(0, 10);
  ok(countdownChip(day(-365), "10:00").includes("is-stale"), "годовалая просрочка без is-stale");
  ok(!countdownChip(day(-2), "00:01").includes("is-stale"), "свежая просрочка помечена stale");
  ok(!countdownChip(day(30), "12:00").includes("is-stale"), "будущий план помечен stale");
  equal(countdownChip("", ""), "");
});

test("кнопка возврата — SVG в стиле приложения, а не эмодзи-глиф ↩ (U+21A9)", () => {
  // Регрессия: U+21A9 на мобильных рендерится эмодзи и выпадает из стиля
  // текстовых кнопок ✓ ✎ ✕. Заменён на инлайн-SVG (stroke 1.9, как в app.html).
  const task = completedTaskItem({ id: 9, title: "План", day: "2026-11-05", time: "", is_private: 0 });
  const wish = completedWishItem({ id: 10, body: "Желание", owner_id: 1, url: "" }, true);
  for (const [name, html] of [["план", task], ["желание", wish]]) {
    ok(html.includes('data-action="reopen-item"'), `${name}: нет кнопки возврата`);
    ok(html.includes("<svg"), `${name}: возврат не в SVG-стиле приложения`);
    ok(!html.includes("\u21A9"), `${name}: остался эмодзи-глиф U+21A9`);
  }
  ok(REOPEN_ICON.includes('stroke-width="1.9"'), "SVG возврата не в толщине иконок приложения");
});

test("единый вид дат завершённых карточек: серая пилюля создания + зелёная завершения", () => {
  // Единый язык с посещёнными местами: дата создания — is-muted, завершение —
  // обычная зелёная .day-chip; текстовые строки «Завершён»/«Исполнено» ушли.
  const task = completedTaskItem({ id: 20, title: "План", created_at: 1730000000, completed_at: 1730100000 });
  ok(task.includes('class="day-chip is-muted"'), "план: нет серой пилюли даты создания");
  ok(task.includes('<span class="day-chip">'), "план: нет зелёной пилюли завершения");
  ok(!task.includes("Завершён"), "план: осталась текстовая метка «Завершён»");
  const wish = completedWishItem({ id: 21, body: "Желание", owner_id: 1, url: "", created_at: 1730000000, done_at: 1730100000 }, true);
  ok(wish.includes('class="day-chip is-muted"'), "желание: нет серой пилюли даты создания");
  ok(wish.includes('<span class="day-chip">'), "желание: нет зелёной пилюли завершения");
  ok(!wish.includes("Исполнено"), "желание: осталась текстовая метка «Исполнено»");
  // Без дат пилюль нет вовсе — пустой .item-meta не отрисовывается.
  const bare = completedTaskItem({ id: 22, title: "План" });
  ok(!bare.includes("day-chip"), "карточка без дат отрисовывает пустые пилюли");
});

test("quoteAuthorOptions: только пользователи пространства, старый источник не затирается", () => {
  const loadQuote = new Function(
    [
      'const appState = { pair: { name1: "Аня", name2: "Боря" }, user: { tg_id: 1 } };',
      extractBraced("function esc"),
      extractBraced("function itemActionButton"),
      extractBraced("function itemActions"),
      extractBraced("function quoteAuthorOptions"),
      "return quoteAuthorOptions;"
    ].join("\n")
  );
  const quoteAuthorOptions = loadQuote();
  const fresh = quoteAuthorOptions("");
  ok(fresh.includes("<option"), "select без вариантов");
  // «Не указан» больше нет: автор из партнёров установлен всегда.
  ok(!fresh.includes("Не указан"), "пустой вариант «Не указан» вернулся");
  ok(!(fresh.match(/value=""/g) || []).length, "пустое значение в select");
  ok(fresh.includes('value="Аня"') && fresh.includes('value="Боря"'), "нет обоих пользователей пространства");
  ok(!fresh.includes("Антуан"), "свободный источник остался в выборе");
  ok(quoteAuthorOptions("Аня").includes('value="Аня" selected'), "выбранный автор не подставляется");
  // Цитата из старых данных с текстовым источником: он остаётся вариантом,
  // иначе select при сохранении молча затёр бы его пустой строкой.
  const legacy = quoteAuthorOptions("Антуан де Сент-Экзюпери");
  ok(legacy.includes('value="Антуан де Сент-Экзюпери"'), "старый источник потерян");
  // Партнёр ещё не присоединился: второго варианта нет.
  const loadSolo = new Function(
    [
      'const appState = { pair: { name1: "Аня", name2: "" }, user: { tg_id: 1 } };',
      extractBraced("function esc"),
      extractBraced("function itemActionButton"),
      extractBraced("function itemActions"),
      extractBraced("function quoteAuthorOptions"),
      "return quoteAuthorOptions;"
    ].join("\n")
  );
  const solo = loadSolo()("");
  ok(solo.includes('value="Аня"'), "свой вариант потерян");
  ok(!(solo.match(/value=""/g) || []).length, "пустое имя партнёра попало в select как пустой вариант");
});

test("у чужого исполненного желания кнопок нет, у своего — есть", () => {
  const own = completedWishItem({ id: 11, body: "Моё", owner_id: 1, url: "" }, true);
  ok(own.includes('data-action="reopen-item"'), "у своего нет кнопок");
  const alien = completedWishItem({ id: 12, body: "Чужое", owner_id: 2, url: "" }, true);
  ok(!alien.includes('data-action="reopen-item"'), "у чужого остались кнопки");
  const readonly = completedWishItem({ id: 13, body: "Партнёра", owner_id: 2, url: "" }, false);
  ok(!readonly.includes('data-action="reopen-item"'), "read-only вид отрисовывает кнопки");
});

test("приватная запись помечается чипом «Личное»", () => {
  ok(taskItem({ id: 14, title: "x", day: "2026-11-05", time: "", is_private: 1 }).includes(">Личное</span>"));
  ok(dateItem({ id: 15, title: "x", day: "2026-11-05", time: "", recurs: 0, is_private: 1 }).includes(">Личное</span>"));
});

test("movieItem: пилюля рейтинга по порогам оценки", () => {
  const loadMovie = new Function(
    [
      extractBraced("function esc"),
      extractBraced("function itemActionButton"),
      extractBraced("function itemActions"),
      extractBraced("function plural"),
      'const pairTimeZone = () => "UTC";',
      extractBraced("function formatTimestamp"),
      extractBraced("function scorePill"),
      extractBraced("function ratingPill"),
      extractBraced("function raofpPill"),
      extractBraced("function formatMovieLength"),
      extractBraced("function movieItem"),
      "return { ratingPill, formatMovieLength, movieItem };"
    ].join("\n")
  );
  const { ratingPill, formatMovieLength, movieItem } = loadMovie();
  ok(ratingPill(2.1).includes("is-rating-gray"), "2.1 — серая пилюля");
  ok(ratingPill(4.2).includes("is-rating-red"), "4.2 — красная пилюля");
  ok(ratingPill(7.5).includes("is-rating-yellow"), "7.5 — жёлтая пилюля");
  ok(ratingPill(8.9).includes("is-rating-green"), "8.9 — зелёная пилюля");
  const none = ratingPill(null);
  ok(none.includes("is-rating-gray") && none.includes("—"), "без рейтинга — серая пилюля «—»");
  ok(ratingPill(8).includes("8.0"), "оценка форматируется с одним знаком");
  const pill = ratingPill(8.9);
  ok(pill.includes("IMDb"), "в пилюле подпись «IMDb» вместо звёздочки");
  ok(!pill.includes("★") && !pill.includes("svg"), "ни текстового ★ (U+2605), ни иконки — только текст (п.35)");
});

test("ratingPill: фолбэк TMDB подписан «TMDB», а не «IMDb»", () => {
  const ratingPill = new Function(
    `${extractBraced("function scorePill")}\n${extractBraced("function ratingPill")}\nreturn ratingPill;`
  )();
  const tmdb = ratingPill(7.5, "tmdb");
  ok(tmdb.includes("TMDB 7.5"), "оценка TMDB подписана источником");
  ok(!tmdb.includes("IMDb"), "оценка TMDB не выдаётся за IMDb");
  ok(tmdb.includes("is-rating-yellow"), "порог цвета тот же, что у IMDb");
  ok(ratingPill(null, "tmdb").includes("TMDB —"), "пустая оценка TMDB — «TMDB —»");
});

test("raofpPill: подпись RAofP и те же пороги цвета, что у IMDb", () => {
  const { raofpPill } = new Function(
    `${extractBraced("function scorePill")}
${extractBraced("function raofpPill")}
return { raofpPill };`
  )();
  ok(raofpPill({ pair_rating: 9.1 }).includes("RAofP 9.1"), "RAofP с оценкой");
  ok(raofpPill({ pair_rating: 9.1 }).includes("is-rating-green"), "9.1 — зелёная");
  ok(raofpPill({ pair_rating: 5 }).includes("is-rating-red"), "5 — красная");
  ok(raofpPill({ pair_rating: 7.5 }).includes("is-rating-yellow"), "7.5 — жёлтая");
  ok(raofpPill({}).includes("RAofP —"), "без оценки — «RAofP —»");
});

test("formatMovieLength: хронометраж фильма и сезоны/серии сериала", () => {
  const loadMovie = new Function(
    [
      extractLine("  const REOPEN_ICON"),
      extractLine("  const DONE_ICON"),
      extractLine("  const EDIT_ICON"),
      extractLine("  const DELETE_ICON"),
      extractBraced("function esc"),
      extractBraced("function itemActionButton"),
      extractBraced("function itemActions"),
      extractBraced("function plural"),
      'const pairTimeZone = () => "UTC";',
      extractBraced("function formatTimestamp"),
      extractBraced("function scorePill"),
      extractBraced("function ratingPill"),
      extractBraced("function raofpPill"),
      extractBraced("function formatMovieLength"),
      extractBraced("function movieItem"),
      "return { formatMovieLength, movieItem };"
    ].join("\n")
  );
  const { formatMovieLength, movieItem } = loadMovie();
  equal(formatMovieLength({ kind: "movie", runtime: 142 }), "2 ч 22 мин");
  equal(formatMovieLength({ kind: "movie", runtime: 120 }), "2 ч");
  equal(formatMovieLength({ kind: "movie", runtime: 45 }), "45 мин");
  equal(formatMovieLength({ kind: "movie", runtime: null }), "");
  equal(formatMovieLength({ kind: "series", seasons: 2, episodes: 18 }), "2 сезона · 18 серий");
  equal(formatMovieLength({ kind: "series", seasons: 1, episodes: 8 }), "1 сезон · 8 серий");
  equal(formatMovieLength({ kind: "series", seasons: null, episodes: null }), "");
  // Карточка: жанр и год — одинаковые серые пилюли, длительность рядом с
  // рейтингом без пилюли, кнопки «Просмотрено»/«Удалить», редактирования нет.
  const card = movieItem({ id: 30, title: "Оппенгеймер", year: 2023, kind: "movie", rating: 8.4, genres: "Драма, История", runtime: 181, watched: 0 });
  ok(card.includes('class="day-chip is-muted">Драма'), "жанр — в серой пилюле, как год");
  ok(card.includes('class="day-chip is-muted">2023'), "год — в серой пилюле");
  ok(card.includes('is-rating-green') && card.includes("8.4"), "рейтинг в зелёной пилюле");
  ok(card.includes("<span>3 ч 1 мин</span>"), "длительность — без пилюли");
  ok(card.includes('data-action="open-movie"'), "карточка не открывает описание");
  ok(card.includes('data-action="movie-watched"'), "нет кнопки «Просмотрено»");
  ok(card.includes('data-action="delete-item"'), "нет кнопки удаления");
  ok(!card.includes("edit-item"), "у фильма нет кнопки редактирования");
  const watched = movieItem({ id: 31, title: "Дюна", year: 2021, kind: "movie", rating: 8, genres: "Фантастика", runtime: 155, watched: 1, watched_at: 1730000000 });
  ok(watched.includes("movie-watched"), "нет класса просмотренной карточки");
  ok(watched.includes('data-action="movie-unwatched"'), "нет кнопки возврата");
  ok(watched.includes(">27.10.2024</span>"), "нет зелёной пилюли с датой просмотра");
  ok(watched.includes("RAofP"), "нет пилюли RAofP у просмотренного");
  ok(watched.includes('data-action="rate-movie"'), "нет кнопки «Оценить» для второго партнёра");
  const rated = movieItem({ id: 33, title: "Дюна", rating: 8, watched: 1, watched_at: 1730000000, my_rating: 9, pair_rating: 8.5 });
  ok(rated.includes("RAofP 8.5"), "RAofP не показан");
  ok(!rated.includes('data-action="rate-movie"'), "кнопка «Оценить» осталась после оценки");
  ok(!card.includes("RAofP"), "у непросмотренного фильма не должно быть RAofP");
  // Ни жанра, ни года, ни длительности — карточка не падает.
  const bare = movieItem({ id: 32, title: "Без данных", watched: 0 });
  ok(bare.includes("is-rating-gray"), "карточка без данных отрисовывается с серой пилюлей");
});

test("renderMovieDetails: описание, актёры, все жанры, режиссёр и рейтинги", () => {
  const renderMovieDetails = new Function(
    [
      extractBraced("const MOVIE_STATUS_RU = "),
      extractBraced("function esc"),
      extractBraced("function itemActionButton"),
      extractBraced("function itemActions"),
      extractBraced("function plural"),
      extractBraced("function formatDay"),
      extractBraced("function scorePill"),
      extractBraced("function ratingPill"),
      extractBraced("function raofpPill"),
      extractBraced("function formatMovieLength"),
      extractBraced("function renderMovieDetails"),
      "return renderMovieDetails;"
    ].join("\n")
  )();
  const movie = { id: 1, title: "Оппенгеймер", kind: "movie", rating: 8.4, rating_source: "imdb", pair_rating: 9, runtime: 181 };
  const html = renderMovieDetails(movie, {
    plot: "История жизни физика.", plot_lang: "ru", tagline: "Мир изменится.",
    genres: ["драма", "история"], actors: ["Киллиан Мёрфи", "Эмили Блант"],
    director: ["Кристофер Нолан"], released: "2023-07-19", status: "Released", rt: "93%", metascore: 89
  });
  ok(html.includes("История жизни физика."), "нет описания");
  ok(html.includes("драма") && html.includes("история"), "не все жанры");
  ok(html.includes("Киллиан Мёрфи"), "нет актёров");
  ok(html.includes("Режиссёр") && html.includes("Кристофер Нолан"), "нет режиссёра");
  ok(html.includes("19.07.2023"), "дата премьеры не в дд.мм.гггг");
  ok(html.includes("RT 93%") && html.includes("Metacritic 89"), "нет RT/Metacritic");
  ok(html.includes("Вышел"), "статус не переведён");
  ok(html.includes("RAofP 9.0"), "нет RAofP");
  ok(!html.includes("Описание на английском"), "русское описание помечено как английское");

  const series = renderMovieDetails({ ...movie, kind: "series", seasons: 2, episodes: 18, runtime: null }, { plot: "Сюжет", plot_lang: "en", director: ["Создатель"] });
  ok(series.includes("Создатели") && series.includes("Создатель"), "у сериала нет создателей");
  ok(series.includes("Описание на английском"), "английское описание не помечено");
  ok(renderMovieDetails(movie, null).includes("Описание пока недоступно"), "нет заглушки");
});

test("wishItem: у желания партнёра нет кнопок, у своего — полный набор", () => {
  const own = wishItem({ id: 16, body: "Моё", owner_id: 1, url: "" }, true);
  for (const action of ["done-item", "edit-item", "delete-item"]) {
    ok(own.includes(`data-action="${action}"`), action);
  }
  const alien = wishItem({ id: 17, body: "Чужое", owner_id: 2, url: "" }, true);
  ok(!alien.includes("icon-btn"), "у чужого желания отрисовались кнопки");
});

// ------------------------------------------------------------------
// Дневник: карточка с заголовком, свёрнутым телом и разворотом по клику.
// ------------------------------------------------------------------
test("memoryItem: заголовок, свёрнутое тело и клик-разворот", async () => {
  // memoryItem извлекается тем же экстрактором — перезагружаем с ним.
  const source2 = source;
  const loadMemory = new Function(
    [
      'const appState = { pair: { timezone: "Europe/Moscow", user_b: 1 }, user: { tg_id: 1 } };',
      'const document = { documentElement: { dataset: { theme: "dark" } }, querySelectorAll: () => [] };',
      extractLine("  const RICH_TOKENS"),
      extractLine("  const DONE_ICON"),
      extractLine("  const EDIT_ICON"),
      extractLine("  const DELETE_ICON"),
      extractBraced("function esc"),
      extractBraced("function itemActionButton"),
      extractBraced("function itemActions"),
      extractBraced("function formatDay"),
      extractBraced("function richInline"),
      extractBraced("function renderRichText"),
      extractBraced("function memoryItem"),
      "return memoryItem;"
    ].join("\n")
  );
  const memoryItem = loadMemory();
  const html = memoryItem({
    id: 20, title: "Тёплый вечер", body: "Строка 1\nСтрока 2\nСтрока 3\nСтрока 4\nСтрока 5\nСтрока 6",
    day: "2026-10-01", display_name: "Оля"
  });
  ok(html.includes('data-action="open-memory"'), "карточка не кликабельна");
  ok(html.includes('data-id="20"'), "data-id не передан");
  ok(html.includes("memory-body"), "нет класса свёрнутого тела (line-clamp в CSS)");
  ok(html.includes(">Тёплый вечер<"), "заголовок не отрисован");
  ok(html.includes("memory-card"), "нет класса карточки дневника");
  // Старая запись без заголовка — без пустого h3.
  const noTitle = memoryItem({ id: 21, title: "", body: "Текст", day: "2026-09-20", display_name: "Игорь" });
  ok(!noTitle.includes("<h3"), "пустой заголовок отрисовался пустым h3");
});


test("formatDay: все даты приложения — дд.мм.гггг", () => {
  equal(formatDay("2026-11-05"), "05.11.2026");
  equal(formatDay("2020-02-29"), "29.02.2020");
  // Мусор проходит как есть: чипы не должны показывать «undefined/NaN».
  equal(formatDay(""), "");
  equal(formatDay("мусор"), "мусор");
  equal(formatDay(null), "");
});

test("чип таймера кодирует repeat в data-countdown — тик не теряет контекст", () => {
  // Регрессия аудита 2026-10-31: refreshCountdowns пересобирает чип из
  // data-countdown каждые 30 секунд; без repeat внутри атрибута чип
  // ежемесячного плана «мигал» оранжевым «Время пришло».
  const chip = countdownChip("2026-11-05", "19:30", "month");
  ok(/data-countdown="2026-11-05\|19:30\|month"/.test(chip), "repeat не попал в атрибут");
  // Обратный путь тика: split("|") и повторный вызов сохраняют месячную цель.
  const m = /data-countdown="([^"]+)"/.exec(chip)[1].split("|");
  const reparsed = countdownChip(m[0], m[1], m[2] || null);
  equal(reparsed, chip, "пересборка чипа изменила контекст повтора");
  // Разовые планы — пустой repeat: обратная совместимость формата.
  const plain = countdownChip("2027-01-01", "", null);
  ok(/data-countdown="2027-01-01\|\|"/.test(plain), "разовый чип без repeat");
});
