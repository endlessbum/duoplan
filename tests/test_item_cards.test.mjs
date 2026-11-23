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
import { equal, notEqual, ok } from "node:assert/strict";
import { test } from "node:test";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const source = readFileSync(join(root, "public/app.js"), "utf8");
const cssSource = readFileSync(join(root, "public/app.css"), "utf8");

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

const RENDER_DEPS = [
    // pairTimeZone и applyAccent-путь читают appState/документ — минимальные стабы.
    'const document = { documentElement: { dataset: { theme: "dark" } }, querySelectorAll: () => [] };',
    "const RECURRENCE_YEARS = 10;",
    "function partnerMissing() { return false; }",
    extractLine("  const RICH_TOKENS"),
    extractLine("  const REOPEN_ICON"),
    extractLine("  const DONE_ICON"),
    extractLine("  const EDIT_ICON"),
    extractLine("  const DELETE_ICON"),
    extractLine("  const COPY_ICON"),
    extractLine("  const LINK_TEXT_ICON"),
    extractLine("  const RESUME_ICON"),
    extractBraced("function esc"),
      extractBraced("function itemActionButton"),
      extractBraced("function itemActions"),
    extractBraced("function formatDay"),
    extractBraced("function formatTimestamp"),
    extractBraced("function completionMeta"),
    extractBraced("function richInline"),
    extractBraced("function renderRichText"),
    extractBraced("function pairTimeZone"),
    extractBraced("function viewerTimeZone"),
    extractBraced("function validTimeZoneLite"),
    extractBraced("function viewerTimeHint"),
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
    extractBraced("function calendarDaysFromNow"),
    extractBraced("function countdownFromDiff"),
    extractBraced("function countdownChip"),
    extractBraced("function calendarKeyFromDate"),
    extractBraced("function formatBirthday"),
    extractBraced("function nextDaysLabel"),
    extractBraced("function yearsChip"),
    extractBraced("function taskItem"),
    extractBraced("function dateItem"),
    extractBraced("function birthdayItem"),
    extractBraced("function quoteItem"),
    extractBraced("function wishItem"),
    extractBraced("function completedTaskItem"),
    extractBraced("function completedWishItem"),
    "return { taskItem, dateItem, birthdayItem, quoteItem, wishItem, completedTaskItem, completedWishItem, countdownChip, REOPEN_ICON, formatDay, monthlyNext, yearlyNext, nextOccurrence, calendarKeyFromDate, viewerTimeHint };"
  ];

const load = () => new Function([
    'const appState = { pair: { timezone: "Europe/Moscow", user_b: 1 }, user: { tg_id: 1 } };',
    ...RENDER_DEPS
  ].join("\n"))();
// Вариант с разными поясами пары и зрителя — для проверок data-day.
const loadTZ = (stateLine) => new Function([stateLine, ...RENDER_DEPS].join("\n"))();
const { taskItem, dateItem, birthdayItem, quoteItem, wishItem, completedTaskItem, completedWishItem, countdownChip, REOPEN_ICON, formatDay, monthlyNext, yearlyNext, nextOccurrence, calendarKeyFromDate, viewerTimeHint } = load();

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

test("у значимой даты карточка ведёт в календарь: разовая — в исходный день, повтор — в ближайший", () => {
  const recurring = { id: 3, title: "Ежегодная", day: "2021-05-17", time: "", recurs: 1, is_private: 0 };
  const oneShot = { id: 4, title: "Разовая", day: "2024-01-01", time: "12:00", recurs: 0, is_private: 1 };
  for (const item of [recurring, oneShot]) {
    const html = dateItem(item);
    ok(html.includes('data-action="show-in-calendar"'), item.title);
    ok(!html.includes("link-btn"), "кнопка «В календаре» вернулась: " + item.title);
  }
  // PD-DATES-001: разовая дата — исходный день, повторяющаяся — nextOccurrence.
  ok(dateItem(oneShot).includes('data-day="2024-01-01"'), "разовая дата не ведёт в исходный день");
  const recurringHtml = dateItem(recurring);
  const dayAttr = /data-day="(\d{4}-\d{2}-\d{2})"/.exec(recurringHtml)?.[1];
  ok(dayAttr && dayAttr !== recurring.day, "ежегодная дата ведёт в год якоря");
  ok(dayAttr.endsWith("-05-17"), "ежегодная дата ведёт не на ближайшее 17 мая");
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

// BUG-03: nextOccurrence возвращает абсолютный момент в поясе ПАРЫ; data-day
// обязан извлекаться в том же поясе. 11.11 01:00 по Токио — это ещё 10.11
// по Лос-Анджелесу: ключ зрителя сдвигал бы карточку на соседний день.
test("карточка дня рождения: data-day считается в поясе пары, не зрителя", () => {
  const { birthdayItem: birthdayItemTZ } = loadTZ(
    'const appState = { pair: { timezone: "Asia/Tokyo", user_b: 2 }, user: { tg_id: 1, timezone: "America/Los_Angeles" } };'
  );
  const html = birthdayItemTZ({ id: 12, title: "Маша", day: "1990-11-11", time: "01:00", is_private: 0 });
  const day = html.match(/data-day="(\d{4}-\d{2}-\d{2})"/)?.[1];
  ok(day, "data-day без валидной даты");
  const currentYear = new Date().getFullYear();
  const year = Number(day.slice(0, 4));
  ok((year === currentYear || year === currentYear + 1) && day.slice(5) === "11-11",
    `дата съехала на соседний день пояса зрителя: ${day}`);
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

test("завершённый план показывает исходные дату/время и чип «Личное»", () => {
  const rich = completedTaskItem({
    id: 30,
    title: "План",
    day: "2026-11-05",
    time: "19:30",
    is_private: 1,
    created_at: 1730000000,
    completed_at: 1730100000
  });
  ok(rich.includes("05.11.2026"), "нет даты исходного плана");
  ok(rich.includes("19:30"), "нет времени исходного плана");
  ok(rich.includes('class="day-chip is-private">Личное'), "нет чипа «Личное»");
  ok(!rich.includes("Время пришло") && !rich.includes("Через "), "отсчёт завершённому плану не нужен");
  // Чип приватности показывается и без даты, но без пустых meta-пилюль.
  const privateNoDay = completedTaskItem({ id: 31, title: "План", is_private: 1 });
  ok(privateNoDay.includes('class="day-chip is-private">Личное'), "личный план без даты потерял чип");
  ok(!privateNoDay.includes("undefined"), "в разметке undefined");
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
  // PD-QUOTES-001: «Не указан» — легальный вариант, по умолчанию выбранный.
  ok(fresh.includes("Не указан"), "нет варианта «Не указан»");
  ok(fresh.includes('value="" selected'), "пустой вариант не выбран по умолчанию");
  ok(quoteAuthorOptions("Аня").includes('value=""') && !quoteAuthorOptions("Аня").includes('value="" selected'),
    "при выбранном партнёре «Не указан» не должен быть active");
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
  ok((solo.match(/value=""/g) || []).length === 1, "«Не указан» должен оставаться даже с одним партнёром");
});

test("PD-QUOTES-001: карточка цитаты копируется, меню блокируется без партнёра", () => {
  ok(source.includes('action: "copy-quote"'), "нет действия «Скопировать текст»");
  ok(source.includes('action === "copy-quote"'), "нет обработчика копирования");
  ok(source.includes("Кто сказал"), "подпись поля не переименована");
  const quoteCard = source.slice(source.indexOf("function quoteItem("), source.indexOf("function formatBirthday"));
  ok((quoteCard.match(/disabled: partnerMissing\(\)/g) || []).length === 2,
    "меню цитаты не заблокировано без партнёра");
  ok(!quoteCard.includes("memory-author") && !quoteCard.includes("display_name"),
    "карточка цитаты показывает создателя записи — убрано решением 2026-11-23");
});

test("PD-QUOTES-001: в карточке цитаты — только автор и дата, без создателя записи", () => {
  const html = quoteItem({ id: 7, body: "Скаловские", source: "Ди", author_id: 100002, display_name: "Dev100002", created_at: 1793995140 });
  ok(html.includes("quote-source") && html.includes("— Ди"), "подпись автора цитаты пропала");
  ok(!html.includes("Dev100002") && !html.includes("memory-author"), "создатель записи показан в карточке");
  const noSource = quoteItem({ id: 8, body: "Без автора", source: null, author_id: 1, display_name: "Dev100001", created_at: 1793995140 });
  ok(!noSource.includes("quote-source"), "пустой источник рисуется");
  ok(!noSource.includes("Dev100001"), "создатель показан без источника");
});

test("PD-MENU-001: ⋮ карточки цитаты — в правом верхнем углу, как у других карточек", () => {
  const html = quoteItem({ id: 9, body: "Цитата", source: "Ди", created_at: 1793995140 });
  const rowStart = html.indexOf('<div class="item-row">');
  const menuPos = html.indexOf('class="item-actions"');
  const datePos = html.indexOf('class="item-meta"');
  ok(rowStart !== -1 && menuPos > rowStart && menuPos < datePos,
    "⋮ должен быть в верхнем ряду карточки, до даты");
  ok(html.indexOf("quote-text") < menuPos, "текст цитаты должен быть в том же верхнем ряду слева от ⋮");
  ok(!/\.quote-card \.item-row\s*\{[^}]*align-items:\s*center/.test(cssSource),
    "ряд цитаты по-прежнему центрирует ⋮ по строке даты");
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
      'const viewerTimeZone = () => "UTC";',
      extractBraced("function formatTimestamp"),
      extractBraced("function scorePill"),
      extractBraced("function ratingPill"),
      extractBraced("function raofpPill"),
      extractBraced("function formatMovieLength"),
      "const partnerMissing = () => false;",
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
      extractLine("  const RESUME_ICON"),
      extractBraced("function esc"),
      extractBraced("function itemActionButton"),
      extractBraced("function itemActions"),
      extractBraced("function plural"),
      'const pairTimeZone = () => "UTC";',
      'const viewerTimeZone = () => "UTC";',
      extractBraced("function formatTimestamp"),
      extractBraced("function scorePill"),
      extractBraced("function ratingPill"),
      extractBraced("function raofpPill"),
      extractBraced("function formatMovieLength"),
      // movieItem читает режим группового выбора и иконку ссылки — без них
      // карточка упала бы на ReferenceError ещё до рендера.
      "let movieGroupSelection = null;",
      extractLine("  const LINK_ICON"),
      "const partnerMissing = () => false;",
      extractBraced("function movieItem"),
      "return { formatMovieLength, movieItem, setSelection: (s) => { movieGroupSelection = s; } };"
    ].join("\n")
  );
  const { formatMovieLength, movieItem, setSelection } = loadMovie();
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
  // PD-MOVIES-001: после оценки появляется «Изменить оценку» (тот же rate).
  ok(!rated.includes('>Оценить</button>'), "кнопка первого голосования осталась после оценки");
  ok(rated.includes('data-action="rate-movie"') && rated.includes("Изменить оценку"), "нет повторной оценки");
  ok(!card.includes("RAofP"), "у непросмотренного фильма не должно быть RAofP");
  // Ни жанра, ни года, ни длительности — карточка не падает.
  const bare = movieItem({ id: 32, title: "Без данных", watched: 0 });
  ok(bare.includes("is-rating-gray"), "карточка без данных отрисовывается с серой пилюлей");

  // Режим создания группы: видимая круглая метка, понятное состояние выбора
  // и тап по всей карточке, а не только по крошечному чекбоксу.
  setSelection(new Set([30]));
  const picked = movieItem({ id: 30, title: "Оппенгеймер", kind: "movie", watched: 0 });
  const unpicked = movieItem({ id: 34, title: "Дюна", kind: "series", watched: 0 });
  ok(picked.includes('class="group-check is-on"'), "нет видимой метки выбранного фильма");
  ok(unpicked.includes('class="group-check"') && !unpicked.includes('class="group-check is-on"'),
    "неотмеченный фильм должен иметь пустую метку");
  ok(picked.includes('data-action="group-toggle-movie"'), "тап по карточке не снимает выбор");
  ok(picked.includes('aria-checked="true"') && unpicked.includes('aria-checked="false"'),
    "состояние выбора не доступно скринридеру");
  ok(picked.includes("is-selecting is-selected"), "выбранная карточка не подсвечена");
  ok(!picked.includes('data-action="open-movie"'), "в режиме выбора карточка не должна открывать описание");
  // Часть существующей группы не выбирается и остаётся обычной карточкой.
  const grouped = movieItem({ id: 35, title: "Часть саги", group_id: "g1", watched: 0 });
  ok(grouped.includes('data-action="open-movie"') && !grouped.includes("group-check"),
    "часть группы не должна получать чекбокс");
  setSelection(null);
  ok(movieItem({ id: 30, title: "Оппенгеймер", watched: 0 }).includes('data-action="open-movie"'),
    "после выхода из режима выбора карточка снова открывает описание");

  // P2-03: карточка — контейнер, а не role="button": внутри живут
  // самостоятельные кнопки (просмотрено/ссылка/удалить/оценить), вложенный
  // интерактив недопустим. Открытие — отдельная кнопка в заголовке.
  ok(!card.includes('role="button"'), "карточка не должна быть role=button");
  ok(!card.includes('tabindex="0"'), "у карточки не должно быть tabindex");
  ok(card.includes('class="movie-title-open"'), "нет кнопки открытия в заголовке");
  ok(card.includes('aria-label="Открыть описание: Оппенгеймер"'),
    "кнопка открытия без понятного имени");
  ok(picked.includes('class="movie-title-open"'), "в режиме выбора заголовок не кликабелен");

  // Метка позиционируется внутри карточки, а ⋮ при наведении — круглая.
  ok(/^\.movie-card,\s*\.movie-pick \{[\s\S]*?\}\s*\.movie-card \{\s*position: relative;\s*\}/m.test(cssSource),
    "у карточки нет position: relative — чекбокс уедет за пределы карточки");
  ok(/\.group-check\.is-on::after \{[\s\S]*?opacity: 1;\s*\}/.test(cssSource),
    "у выбранной метки нет видимой галочки");
  const menuRules = cssSource.slice(
    cssSource.indexOf(".item-menu-toggle {"),
    cssSource.indexOf(".section-head", cssSource.indexOf(".item-menu-toggle {"))
  );
  ok(/width: 34px;[\s\S]*height: 34px;/.test(menuRules), "у ⋮ нет фиксированного круглого размера");
  ok(/border-radius: 50%;/.test(menuRules), "⋮ не скруглён");
  ok(/place-items: center;/.test(menuRules), "⋮ не отцентрован внутри круга");
  ok(/letter-spacing: 0;/.test(menuRules), "разреженный ⋮ смещает точки от центра");
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

test("wishItem: у партнёра только «Поделиться», у своего — полный набор", () => {
  const own = wishItem({ id: 16, body: "Моё", owner_id: 1, url: "" }, true);
  for (const action of ["share-wish", "done-item", "edit-item", "delete-item"]) {
    ok(own.includes(`data-action="${action}"`), action);
  }
  const alien = wishItem({ id: 17, body: "Чужое", owner_id: 2, url: "" }, true);
  ok(alien.includes('data-action="share-wish"'), "у чужого желания нет «Поделиться»");
  for (const action of ["done-item", "edit-item", "delete-item"]) {
    ok(!alien.includes(`data-action="${action}"`), `${action} не должен быть у чужого желания`);
  }
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
      "function partnerMissing() { return false; }",
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

test("карточка «Ваша история»: тап открывает окно с рекордом серии", () => {
  // Тапабельна только парная карточка героя; окно — начало истории + рекорд.
  ok(source.includes('class="card hero-card" role="button" tabindex="0" data-action="open-history"'), "нет тапа на карточке истории");
  ok(source.includes('action === "open-history"'), "нет обработчика open-history");
  ok(source.includes("Рекорд серии"), "в окне нет рекорда серии");
  // Огонёк остаётся только на главной карточке, внутри окна его нет.
  ok(!/Рекорд серии[\s\S]{0,120}FLAME_ICON/.test(source), "огонёк попал в строку рекорда внутри окна");
  // «Начало истории» переехало из карточки в окно.
  const heroStart = source.indexOf('class="card hero-card" role="button"');
  const heroBody = source.slice(heroStart, source.indexOf("</section>", heroStart));
  ok(!heroBody.includes("Начало истории"), "«Начало истории» осталось на карточке");
  ok(source.includes("Начало истории</span><span>"), "нет строки «Начало истории» в окне");
  // PD-HOME-001: два состояния ожидания — первый вход и возвращение.
  ok(source.includes("Отправьте код партнёру. После его присоединения"), "потеряна подсказка первого входа");
  ok(source.includes("Пространство ждёт вашего партнёра"), "нет подсказки ожидания возвращения");
});

test("карточки role=button активируются с клавиатуры (Enter/Space)", () => {
  // Регресс P2-03: у role="button" tabindex="0" не было ни видимого фокуса,
  // ни клавиатурной активации — Tab-стоп без действия.
  ok(source.includes('addEventListener("keydown"'), "нет keydown-обработчика активации");
  ok(source.includes('addEventListener("keyup"'), "Space активируется по keyup (анти-автоповтор)");
  ok(source.includes('card.click()'), "нет синтеза click для карточки");
  // Нативные контролы исключены — иначе Enter на кнопке внутри карточки
  // сработал бы дважды (нативно + через карточку).
  ok(source.includes('closest("button, a[href], input, select, textarea, summary, [contenteditable]")'),
    "нет защиты от дабл-активации на нативных контролах");
  ok(source.includes('preventDefault()'), "Space не глушит прокрутку страницы");
  // Видимый фокус: глобальный reset обнулял outline у [tabindex] —
  // возвращаем :focus-visible-стиль для карточек. У окна диалога фокусное
  // кольцо намеренно подавлено (programmatic dialog.focus() давал синее
  // кольцо по периметру — репорт пользователя).
  ok(cssSource.includes('[tabindex]:not([tabindex="-1"]):focus-visible'), "нет фокус-стиля для карточек");
  ok(cssSource.includes('.sheet-dialog:focus-visible'), "нет подавления фокуса у диалога");
  const accentBlock = cssSource.slice(cssSource.indexOf(".flo-chip:focus-visible"), cssSource.indexOf("[tabindex]:not"));
  ok(!accentBlock.includes("sheet-dialog"), "у диалога снова accent-кольцо");
});

test("удержание Enter не повторяет клик по карточке (e.repeat)", () => {
  // Регресс P3: keydown по Enter стреляет автоповтором при удержании —
  // без проверки e.repeat один тап превращался в серию кликов по карточке.
  ok(/if \(e\.key === "Enter"\) \{\s*if \(!e\.repeat\) card\.click\(\)/.test(source),
    "Enter по карточке не защищён от автоповтора (нет e.repeat)");
});

test("PD-MOVIES-001: карточка показывает отметившего и блокирует действия без партнёра", () => {
  const load = new Function([
    "const appState = { user: { tg_id: 1 } };",
    "const partnerMissing = () => false;",
    [
      extractLine("  const REOPEN_ICON"),
      extractLine("  const DONE_ICON"),
      extractLine("  const EDIT_ICON"),
      extractLine("  const DELETE_ICON"),
      extractLine("  const LINK_ICON"),
      extractLine("  const RESUME_ICON"),
      extractLine("  const LINK_TEXT_ICON"),
      extractLine("  const COPY_ICON"),
      "let movieGroupSelection = null;",
      extractBraced("function esc"),
      extractBraced("function itemActionButton"),
      extractBraced("function itemActions"),
      extractBraced("function plural"),
      'const pairTimeZone = () => "UTC";',
      'const viewerTimeZone = () => "UTC";',
      extractBraced("function formatTimestamp"),
      extractBraced("function scorePill"),
      extractBraced("function ratingPill"),
      extractBraced("function raofpPill"),
      extractBraced("function formatMovieLength"),
      extractBraced("function movieItem"),
      "return movieItem;"
    ].join("\n")
  ].join("\n"))();
  const alien = load({ id: 90, title: "Дюна", watched: 1, watched_at: 1730000000, watched_by: 999, my_rating: 8, pair_rating: 8 });
  ok(alien.includes("отметил партнёр"), "нет подписи отметившего");
  const own = load({ id: 91, title: "Дюна", watched: 1, watched_at: 1730000000, watched_by: 1, my_rating: 8, pair_rating: 8 });
  ok(!own.includes("отметил партнёр"), "своя отметка названа чужой");
  ok(source.includes("disabled: locked"), "действия карточки не блокируются без партнёра");
});

test("PD-DATES-002: карточка даты — заголовок, Личное, серая пилюля ближайшего наступления", () => {
  const html = dateItem({
    id: 31, title: "День знакомства", day: "2020-11-20", time: "19:30",
    recurs: 1, monthly: 0, is_private: 1
  });
  const title = html.indexOf('<h3 class="item-title"');
  const privateChip = html.indexOf(">Личное</span>");
  const datePill = html.indexOf('class="day-chip is-muted"');
  ok(title !== -1 && privateChip !== -1 && datePill !== -1, "не все части карточки на месте");
  ok(title < privateChip && privateChip < datePill, "порядок карточки: заголовок → Личное → дата");
  ok(html.includes("Таймер · 20 ноября · 19:30"), "пилюля не показывает ближайшее наступление со временем");
  ok(!html.includes("2020-11-20"), "CARD раскрыла технический год якоря");
  ok(html.includes('class="item-when-line"'), "пилюли не собраны в одну строку");
});

test("PD-DATES-002: без времени пилюля — только дата, без «Отсчёта»", () => {
  const html = dateItem({ id: 32, title: "Годовщина", day: "2021-05-17", time: "", recurs: 1, monthly: 0, is_private: 0 });
  ok(html.includes(">17 мая</span>"), "пилюля без времени не показывает просто дату");
  ok(!html.includes("Отсчёт"), "подпись Отсчёт осталась в пилюле (решение 2026-11-23: убрать)");
  ok(!html.includes(" · Ежегодно"), "старая подпись повтора осталась");
  ok(!html.includes(">Личное</span>"), "Личное показано у общей даты");
  ok(!html.includes("Таймер"), "Таймер показан без времени");
});

test("PD-DATES-002: карточка дня рождения показывает имя и день/месяц без года", () => {
  const html = birthdayItem({ id: 33, title: "Маша", day: "1990-05-14", time: "", is_private: 0 });
  const title = html.indexOf('<h3 class="item-title"');
  const datePill = html.indexOf(">14 мая</span>");
  ok(title !== -1 && datePill > title, "заголовок должен быть до пилюли");
  ok(!html.includes("Отсчёт"), "подпись Отсчёт осталась в пилюле дня рождения (решение 2026-11-23: убрать)");
  ok(!html.includes("1990"), "карточка раскрыла год рождения");
  ok(html.includes('class="day-chip is-muted"'), "пилюля не нейтральная");
});

// ------------------------------------------------------------------
// BUG-3-01 (аудит 2026-11-23): серая пилюля лет в Mini App
// ------------------------------------------------------------------

function pluralYears(n) {
  const mod100 = n % 100, mod10 = n % 10;
  if (mod100 >= 11 && mod100 <= 14) return "лет";
  if (mod10 === 1) return "год";
  if (mod10 >= 2 && mod10 <= 4) return "года";
  return "лет";
}

// Дата «N лет назад сегодня» в поясе пары: наступление — сегодня, поэтому
// количество лет детерминировано в любой день запуска теста.
function dayYearsAgo(n) {
  const key = new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Moscow", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
  return `${Number(key.slice(0, 4)) - n}${key.slice(4)}`;
}

test("BUG-3-01: день рождения с show_years показывает серую пилюлю лет", () => {
  const years = 20;
  const html = birthdayItem({ id: 40, title: "Маша", day: dayYearsAgo(years), kind: "birthday", show_years: 1, is_private: 0 });
  ok(html.includes(`is-muted">${years} ${pluralYears(years)}</span>`), `нет пилюли «${years}»: ${html}`);
  const pill = html.indexOf(`is-muted">${years} `);
  ok(pill !== -1, "нет пилюли лет");
  ok(!html.includes("Отсчёт"), "подпись Отсчёт осталась в пилюле (решение 2026-11-23: убрать)");
  ok(!html.includes(dayYearsAgo(years)), "пилюля лет раскрыла исходный год");
});

test("BUG-3-01: ежегодная дата с show_years показывает годы, год якоря не раскрывается", () => {
  const years = 6;
  const item = { id: 41, title: "Годовщина", day: dayYearsAgo(years), time: "", recurs: 1, monthly: 0, kind: "date", show_years: 1, is_private: 0 };
  const html = dateItem(item);
  ok(html.includes(`is-muted">${years} ${pluralYears(years)}</span>`), "нет пилюли лет у ежегодной даты");
  ok(!html.includes(item.day), "карточка раскрыла технический год якоря");
});

test("BUG-3-01: без show_years пилюли лет нет", () => {
  const pill = /is-muted">\d+ (?:год|года|лет)</;
  ok(!pill.test(birthdayItem({ id: 42, title: "Маша", day: dayYearsAgo(20), kind: "birthday", show_years: 0, is_private: 0 })), "пилюля лет у birthday без флага");
  ok(!pill.test(dateItem({ id: 43, title: "Годовщина", day: dayYearsAgo(6), time: "", recurs: 1, monthly: 0, kind: "date", show_years: 0, is_private: 0 })), "пилюля лет у даты без флага");
});

test("BUG-3-01: monthly и разовая даты не показывают годы даже с флагом", () => {
  const pill = /is-muted">\d+ (?:год|года|лет)</;
  ok(!pill.test(dateItem({ id: 44, title: "Ежемесячно", day: dayYearsAgo(3), time: "", recurs: 1, monthly: 1, kind: "date", show_years: 1, is_private: 0 })), "пилюля лет у ежемесячной даты");
  ok(!pill.test(dateItem({ id: 45, title: "Разовая", day: dayYearsAgo(3), time: "", recurs: 0, monthly: 0, kind: "date", show_years: 1, is_private: 0 })), "пилюля лет у разовой даты");
});

// ------------------------------------------------------------------
// BUG-3-02 (аудит 2026-11-23): повтор не раньше исходной даты (Mini App)
// ------------------------------------------------------------------

test("BUG-3-02: ежегодная дата с будущим началом не наступает раньше него", () => {
  const next = nextOccurrence({ id: 46, title: "Годовщина", day: "2033-06-10", time: "", recurs: 1, monthly: 0, is_private: 0 });
  ok(next, "наступление не найдено");
  equal(calendarKeyFromDate(next, "Europe/Moscow"), "2033-06-10");
});

test("BUG-3-02: ежемесячная дата с будущим началом не наступает раньше него", () => {
  const next = monthlyNext("2033-06-10", "");
  ok(next, "наступление не найдено");
  equal(calendarKeyFromDate(next, "Europe/Moscow"), "2033-06-10");
});

test("BUG-3-02: ежегодный план с будущим началом не срабатывает годом раньше", () => {
  const next = yearlyNext("2033-06-10", "");
  ok(next, "наступление не найдено");
  equal(calendarKeyFromDate(next, "Europe/Moscow"), "2033-06-10");
});

// ------------------------------------------------------------------
// BUG-3-03 (аудит 2026-11-23): подсказка пояса по дате наступления
// ------------------------------------------------------------------

test("BUG-3-03: подсказка пояса считается по ближайшему наступлению, не по исходному году", () => {
  const { dateItem: dateItemTZ, viewerTimeHint: hintTZ } = loadTZ(
    'const appState = { pair: { timezone: "Europe/Warsaw", user_b: 2 }, user: { tg_id: 1, timezone: "America/New_York" } };'
  );
  // 29 марта 01:30 в Варшаве: 2020 — ещё CET (+1), 2027 — уже CEST (+2).
  // Значит подсказка обязана зависеть от года наступления.
  notEqual(hintTZ("2020-03-29", "01:30"), hintTZ("2027-03-29", "01:30"),
    "подсказка не зависит от года — тест потерял смысл");
  const item = { id: 50, title: "Годовщина", day: "2020-03-29", time: "01:30", recurs: 1, monthly: 0, kind: "date", is_private: 0 };
  const html = dateItemTZ(item);
  const occDay = /data-day="(\d{4}-\d{2}-\d{2})"/.exec(html)?.[1];
  ok(occDay, "нет data-day");
  ok(html.includes(`>${hintTZ(occDay, "01:30")}</span>`),
    `подсказка не по наступлению ${occDay}: ожидалось «${hintTZ(occDay, "01:30")}»`);
  ok(html.split(hintTZ(occDay, "01:30")).length === 2, "подсказка отрендерена дважды");
});
