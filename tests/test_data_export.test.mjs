// Экспорт данных: POST /api/data/export (worker.js) — пользователь выбирает
// разделы и состав каждого, воркер собирает выбранные коллекции пары в один
// машиночитаемый JSON-конверт («Экспорт.json») через sendDocument; этот же
// файл читает импорт (POST /api/data/import). Проверяем нормализацию строк
// (флаги, заглушки автора), валидацию секций, SQL-фильтры приватности,
// содержимое multipart-формы (конверт с app/kind/schema) и счётчики в ответе.
//
// Запуск: node --test tests/test_data_export.test.mjs
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { deepStrictEqual, equal, match, ok, rejects, throws } from "node:assert/strict";
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

// ------------------------------------------------------------------
// 1. Нормализация строк по секциям
// ------------------------------------------------------------------
const loadMappers = new Function(
  [
    extractLine("const clean = "),
    extractBraced("function exportMemoryRow"),
    extractBraced("function exportDateRow"),
    extractBraced("const EXPORT_ROW_MAPPERS = {"),
    "return { EXPORT_ROW_MAPPERS };"
  ].join("\n")
);
const { EXPORT_ROW_MAPPERS } = loadMappers();
const APP_VERSION = source.match(/const APP_VERSION = "([^"]+)"/)[1];

test("нормализация строк: флаги к булевым, пустые заголовки — null", () => {
  const plan = EXPORT_ROW_MAPPERS.plans({
    id: 5, title: "Поездка", status: "open", day: "2026-12-01", time: null,
    monthly: 0, yearly: 1, is_private: 1, completed_at: null, created_at: 1790000000, author: "Аня"
  });
  // Выгружаются только незавершённые планы — поля статуса в файле нет.
  ok(!("status" in plan) && !("completed_at" in plan), "поля статуса быть не должно");
  equal(plan.yearly, true);
  equal(plan.is_private, true);
  equal(plan.day, "2026-12-01");

  const memory = EXPORT_ROW_MAPPERS.memories({
    id: 6, title: "   ", body: "Текст", day: "2026-11-01", created_at: 1, author: null
  });
  equal(memory.title, null);
  equal(memory.author, "Партнёр");
});

test("нормализация фильмов: watched в файл не попадает (там только не просмотренные)", () => {
  const movie = EXPORT_ROW_MAPPERS.movies({
    id: 9, imdb_id: "tt15398776", title: "Оппенгеймер", year: 2023, kind: "movie",
    rating: 8.4, runtime: 181, seasons: null, episodes: null, url: "https://www.imdb.com/title/tt15398776/",
    created_at: 1790000000, author: "Аня"
  });
  equal(movie.kind, "movie");
  equal(movie.rating, 8.4);
  ok(!("watched" in movie), "поля watched в файле быть не должно");
});

test("нормализация дат и дней рождения — одна и та же форма записи", () => {
  const row = { id: 7, title: "Годовщина", day: "2027-03-08", time: "12:00", recurs: 1, monthly: 0, is_private: 1, kind: "date", created_at: 1780000000, author: "Игорь" };
  deepStrictEqual(EXPORT_ROW_MAPPERS.dates(row), EXPORT_ROW_MAPPERS.birthdays(row));
});

test("тело — валидный JSON без потерь юникода", () => {
  const parsed = JSON.parse(JSON.stringify(EXPORT_ROW_MAPPERS.memories({
    id: 2, title: null, body: "🎄 & <кавычки> \"тут\"", day: "2026-11-01", created_at: 2, author: "Аня"
  })));
  equal(parsed.body, "🎄 & <кавычки> \"тут\"");
});

// ------------------------------------------------------------------
// 2. Валидация секций
// ------------------------------------------------------------------
const loadSections = new Function(
  [
    'class HttpError extends Error { constructor(status, message, code) { super(message); this.status = status; this.code = code; } }',
    extractBraced("const EXPORT_SECTIONS = {"),
    extractBraced("function exportSections("),
    "return { exportSections };"
  ].join("\n")
);
const { exportSections } = loadSections();

test("exportSections: составы валидируются по ключу и значению", () => {
  deepStrictEqual(exportSections({ sections: { plans: "all", movies: "open" } }), { plans: "all", movies: "open" });
  for (const bad of [
    undefined,                        // sections нет вовсе
    {},                               // пустой выбор
    { plans: "open" },                // недопустимый состав
    { savings: "all" },               // неизвестный раздел
    { plans: "all", dates: "open" }   // недопустимый состав второй секции
  ]) {
    throws(() => exportSections({ sections: bad }), `должен отбросить ${JSON.stringify(bad)}`);
  }
});

// ------------------------------------------------------------------
// 3. Маршрут: приватность, форма, счётчики
// ------------------------------------------------------------------
const buildApi = new Function(
  "json", "ensureSchemaOnce", "telegramUser", "validTimeZone", "ensureUser",
  "rateLimit", "readJson", "state", "membership", "ownerIds", "telegramForm",
  [
    extractBraced("class HttpError"),
    extractLine("const now = "),
    extractLine("const clean = "),
    extractLine("const DEFAULT_TZ"),
    extractLine("const APP_VERSION"),
    extractLine("const ACCENT_KEYS"),
    extractLine("const STATE_ACTIVE_LIMIT"),
    extractBraced("function validateSchema"),
    extractBraced("function textField"),
    extractBraced("function validDate"),
    extractBraced("function optionalTime"),
    extractBraced("function validTimeZone"),
    extractBraced("function localDay"),
    extractBraced("const EXPORT_SECTIONS = {"),
    extractBraced("const EXPORT_LABELS = {"),
    extractBraced("const EXPORT_SQL = {"),
    extractBraced("function exportSectionBinds("),
    extractBraced("function exportSections("),
    extractBraced("function exportMemoryRow"),
    extractBraced("function exportDateRow"),
    extractBraced("const EXPORT_ROW_MAPPERS = {"),
    extractLine("const EXPORT_FILE_SCHEMA = 1"),
    extractBraced("function buildExportEnvelope"),
    extractBraced("function ownerIds"),
    extractBraced("async function api"),
    "return api;"
  ].join("\n")
);

function resultsFor(sql, rows) {
  if (sql.includes("FROM tasks")) return rows.tasks || [];
  if (sql.includes("FROM movies")) return rows.movies || [];
  if (sql.includes("kind='birthday'")) return rows.birthdays || [];
  if (sql.includes("FROM dates")) return rows.dates || [];
  if (sql.includes("FROM places")) return rows.places || [];
  if (sql.includes("FROM memories")) return rows.memories || [];
  if (sql.includes("FROM quotes")) return rows.quotes || [];
  if (sql.includes("FROM wishes")) return rows.wishes || [];
  if (sql.includes("FROM health_meds")) return rows.health || [];
  return [];
}

function makeApiEnv({ pair, rows = {}, body = {}, tgId = 777 }) {
  const queries = [];
  const db = {
    prepare(sql) {
      return {
        bind(...args) {
          queries.push({ sql, args });
          return {
            run: async () => ({ meta: { changes: 1 } }),
            all: async () => ({ results: resultsFor(sql, rows) }),
            first: async () => null
          };
        }
      };
    }
  };
  const uploads = [];
  const request = { method: "POST", headers: { get: () => null } };
  const api = buildApi(
    (data, status = 200) => ({ data, status }),
    async () => {},
    async () => ({ id: tgId, first_name: "Тест" }),
    new Function(`${extractBraced("function validTimeZone")}; return validTimeZone;`)(),
    async () => ({ tg_id: tgId }),
    async () => {},
    async () => body,
    async () => ({ user: { tg_id: tgId }, pair }),
    async () => pair,
    async () => [],
    async (env, method, form) => {
      uploads.push({ env, method, form });
      return { ok: true };
    }
  );
  return { api, env: { DB: db }, queries, request, uploads };
}

test("маршрут: фильтры приватности по составам, один файл «Экспорт.txt», счётчики", async () => {
  const env0 = makeApiEnv({
    pair: { id: 3, timezone: "Asia/Irkutsk" },
    body: { sections: { plans: "all", movies: "open", dates: "private", birthdays: "private", places: "mine", memories: "mine", quotes: "mine", wishes: "mine" } },
    rows: {
      tasks: [{ id: 5, title: "Поездка", status: "open", day: "2026-12-01", time: null, monthly: 0, yearly: 0, is_private: 0, completed_at: null, created_at: 1, author: "Аня" }],
      movies: [{ id: 6, imdb_id: "tt15398776", title: "Оппенгеймер", year: 2023, kind: "movie", rating: 8.4, runtime: 181, seasons: null, episodes: null, url: "https://x", created_at: 2, author: "Аня" }],
      memories: [{ id: 7, title: "Выходные", body: "Текст", day: "2026-10-31", created_at: 3, author: "Аня" }]
    }
  });
  const response = await env0.api(env0.request, env0.env, new URL("https://duoplan.test/api/data/export"));

  // «Все» планы/даты — видимость интерфейса; «личные» — жёстко свои.
  const plansQuery = env0.queries.find((q) => q.sql.includes("FROM tasks"));
  ok(plansQuery.sql.includes("(t.is_private=0 OR t.created_by=?)"), "планы «все» — видимость интерфейса");
  deepStrictEqual(plansQuery.args, [3, 777]);
  const datesQuery = env0.queries.find((q) => q.sql.includes("FROM dates d") && q.sql.includes("kind='date'"));
  ok(datesQuery.sql.includes("d.is_private=1 AND d.created_by=?"), "даты «личные» — только свои");
  deepStrictEqual(datesQuery.args, [3, 777]);
  const birthdayQuery = env0.queries.find((q) => q.sql.includes("kind='birthday'"));
  ok(birthdayQuery.sql.includes("kind='birthday'") && birthdayQuery.sql.includes("d.is_private=1 AND d.created_by=?"), "дни рождения с тем же приватным фильтром");
  // Общие коллекции «мои» — привязка к автору; кино — без второго бинда.
  const moviesQuery = env0.queries.find((q) => q.sql.includes("FROM movies"));
  ok(moviesQuery.sql.includes("m.watched=0"), "кино — только не просмотренные");
  deepStrictEqual(moviesQuery.args, [3], "у кино нет бинда пользователя");
  for (const [table, filter] of [["places", "p.created_by=?"], ["memories", "m.author_id=?"], ["quotes", "q.author_id=?"], ["wishes", "w.owner_id=?"]]) {
    const q = env0.queries.find((x) => x.sql.includes(`FROM ${table}`));
    ok(q && q.sql.includes(filter), `${table}: фильтр «мои»`);
    deepStrictEqual(q.args, [3, 777], `${table}: бинды пары и пользователя`);
  }
  ok(env0.queries.find((q) => q.sql.includes("FROM wishes")).sql.includes("w.done=0"), "желания — только не подаренные");

  // Один sendDocument с файлом «Экспорт.json» — машиночитаемый конверт.
  equal(env0.uploads.length, 1);
  const upload = env0.uploads[0];
  equal(upload.method, "sendDocument");
  equal(upload.form.get("chat_id"), "777");
  match(upload.form.get("caption"), /Экспорт данных — /);
  const doc = upload.form.get("document");
  equal(doc.name, "Экспорт.json");
  const envelope = JSON.parse(await doc.text());
  // Специальная валидация файла: импорт отличает файл DuoPlan по шапке.
  equal(envelope.app, "duoplan");
  equal(envelope.kind, "duoplan-export");
  equal(envelope.schema, 1);
  equal(envelope.version, APP_VERSION);
  ok(Number.isInteger(envelope.exported_at) && envelope.exported_at > 0, "нет времени выгрузки");
  // Пустые секции в файл не попадают.
  ok(!("places" in envelope.sections) && !("wishes" in envelope.sections), "пустые секции пропущены");
  equal(envelope.sections.plans[0].title, "Поездка");
  equal(envelope.sections.movies[0].title, "Оппенгеймер");
  equal(envelope.sections.movies[0].rating, 8.4);
  equal(envelope.sections.memories[0].title, "Выходные");
  equal(envelope.sections.memories[0].body, "Текст");
  deepStrictEqual(response.data, {
    ok: true,
    counts: { plans: 1, movies: 1, dates: 0, birthdays: 0, places: 0, memories: 1, quotes: 0, wishes: 0 }
  });
});

test("маршрут: состав «all» общих коллекций — один бинд, дни рождения попадают в файл", async () => {
  const env0 = makeApiEnv({
    pair: { id: 9, timezone: "Europe/Moscow" },
    body: { sections: { places: "all", memories: "all", quotes: "all", wishes: "all", birthdays: "all" } },
    rows: {
      birthdays: [{ id: 30, title: "День рождения Маши", day: "1996-12-03", time: null, recurs: 1, monthly: 0, is_private: 0, kind: "birthday", created_at: 5, author: "Миша" }],
      memories: [{ id: 31, title: "Выходные", body: "Текст", day: "2026-10-31", created_at: 6, author: "Миша" }]
    }
  });
  const response = await env0.api(env0.request, env0.env, new URL("https://duoplan.test/api/data/export"));

  // Регрессия H1: в составе «all» у общих коллекций в SQL один плейсхолдер —
  // лишний бинд с tg_id ронял запрос (SQLITE_RANGE).
  for (const table of ["places", "memories", "quotes", "wishes"]) {
    const q = env0.queries.find((x) => x.sql.includes(`FROM ${table}`));
    deepStrictEqual(q.args, [9], `${table}: состав «all» — только бинд пары`);
    ok(!q.sql.includes("created_by=?") && !q.sql.includes("author_id=?") && !q.sql.includes("owner_id=?"), `${table}: без фильтра автора`);
  }
  equal(env0.queries.find((x) => x.sql.includes("kind='birthday'")).args.length, 2, "дни рождения: фильтр видимости в обоих составах");

  // Секция дней рождения попадает в конверт (регрессия H1: раньше TypeError).
  const envelope = JSON.parse(await env0.uploads[0].form.get("document").text());
  equal(envelope.sections.birthdays[0].title, "День рождения Маши");
  equal(envelope.sections.birthdays[0].day, "1996-12-03");
  deepStrictEqual(response.data.counts, { places: 0, memories: 1, quotes: 0, wishes: 0, birthdays: 1 });
});

test("уточнение к желанию попадает в SQL и в файл экспорта", async () => {
  const env0 = makeApiEnv({
    pair: { id: 9, timezone: "Europe/Moscow" },
    body: { sections: { wishes: "all" } },
    rows: {
      wishes: [{ id: 40, body: "Плед", url: null, comment: "Серый, 150×200", created_at: 5, author: "Аня" }]
    }
  });
  const response = await env0.api(env0.request, env0.env, new URL("https://duoplan.test/api/data/export"));
  const query = env0.queries.find((x) => x.sql.includes("FROM wishes"));
  ok(query.sql.includes("w.comment"), "SELECT желаний должен читать comment");
  const envelope = JSON.parse(await env0.uploads[0].form.get("document").text());
  equal(envelope.sections.wishes[0].body, "Плед");
  equal(envelope.sections.wishes[0].comment, "Серый, 150×200");
  equal(response.data.counts.wishes, 1);
});

test("маршрут без выбранных секций — 400 и без запросов к базе", async () => {
  const env0 = makeApiEnv({ pair: { id: 4, timezone: "Europe/Moscow" }, body: {} });
  await rejects(
    env0.api(env0.request, env0.env, new URL("https://duoplan.test/api/data/export")),
    (error) => error.status === 400 && error.code === "INVALID_EXPORT"
  );
  equal(env0.queries.length, 0, "до SQL-запросов дело не доходит");
});

test("конверт: пустые секции не попадают в файл, шапка валидации на месте", () => {
  const build = new Function([
    extractLine("const EXPORT_FILE_SCHEMA = 1"),
    extractBraced("const EXPORT_LABELS = {"),
    extractBraced("function buildExportEnvelope"),
    "return buildExportEnvelope;"
  ].join("\n"))();
  const envelope = build("2026.11.20.119", { plans: [{ id: 1 }], places: [], memories: [{ id: 2 }] });
  equal(envelope.app, "duoplan");
  equal(envelope.kind, "duoplan-export");
  equal(envelope.schema, 1);
  equal(envelope.version, "2026.11.20.119");
  ok(Number.isInteger(envelope.exported_at));
  deepStrictEqual(Object.keys(envelope.sections), ["plans", "memories"], "пустые секции должны пропускаться");
});

test("health: напоминания препараты выгружаются с настройками приёма", () => {
  ok(source.includes('health: ["all"]'), "нет секции здоровья в EXPORT_SECTIONS");
  ok(source.includes('health: "здоровье (препараты)"'), "нет подписи секции здоровья");
  const med = EXPORT_ROW_MAPPERS.health({
    id: 9, name: "Магний", form: "tablet", dosage: "400 мг", schedule: "2 раза в день",
    status: "active", start_date: "2026-11-01", end_date: null,
    remind_enabled: 1, remind_time: "08:00,20:00", note: "после еды", created_at: 1790000000
  });
  equal(med.remind_enabled, true);
  equal(med.remind_time, "08:00,20:00");
  equal(med.start_date, "2026-11-01");
  ok(source.includes("FROM health_meds"), "нет SQL секции здоровья");
  ok(source.includes('if (key === "health") return [userId];'), "бинды здоровья не по tg_id");
});

test("cycle: дозировка препарата Фло — отдельным полем (нужна импорту)", () => {
  const med = EXPORT_ROW_MAPPERS.cycle({
    kind: "med", day: "2026-10-01", end_date: null,
    note: "Эстроген", med_dosage: "2 мг", category: "hormonal", form: "tablet",
    schedule: "1 раз в день", status: "active", created_at: 5
  });
  equal(med.name, "Эстроген", "имя препарата склеено с дозой");
  equal(med.dosage, "2 мг", "доза не вынесена отдельным полем");
  ok(source.includes("md.dosage AS med_dosage"), "в SQL нет отдельной колонки дозы");
});

test("PD-PROFILE-001: экспорт включает контакты (все/мои) с телефонами", () => {
  ok(exportSections({ sections: { contacts: "all" } }).contacts === "all");
  ok(exportSections({ sections: { contacts: "mine" } }).contacts === "mine");
  ok(source.includes("contacts: [\"all\", \"mine\"]"), "нет секции контактов в EXPORT_SECTIONS");
  ok(source.includes("GROUP_CONCAT(p.phone, ', ')"), "телефоны не собраны в экспорт");
  ok(source.includes('contacts: "контакты"'), "нет подписи секции контактов");
  ok(source.includes('contacts: (row) => ({'), "нет маппера контактов");
});

// ------------------------------------------------------------------
// Импорт в клиенте: кнопка в профиле, файл-пикер и валидация конверта
// ------------------------------------------------------------------
const appJs = readFileSync(join(root, "public", "app.js"), "utf8");

test("клиент: кнопка «Импортировать» в карте экспорта", () => {
  const exportCard = appJs.slice(
    appJs.indexOf("function renderPairExport()"),
    appJs.indexOf("function renderPairTimezone()")
  );
  ok(exportCard.includes('data-action="import-data"'), "нет кнопки импорта");
  ok(exportCard.includes(">Импортировать</button>"), "нет подписи кнопки импорта");
  ok(exportCard.includes(">Экспортировать</button>"), "кнопка экспорта пропала");
});

test("клиент: чужой JSON отсеивается до диалога импорта", () => {
  const dialog = appJs.slice(
    appJs.indexOf("function openImportDialog("),
    appJs.indexOf("function renderPairExport()")
  );
  ok(dialog.includes('envelope?.app !== "duoplan"'), "нет проверки app в конверте");
  ok(dialog.includes('envelope?.kind !== "duoplan-export"'), "нет проверки kind в конверте");
  ok(dialog.includes("Не удалось прочитать файл"), "нет сообщения о нечитаемом файле");
  ok(dialog.includes("Это не файл экспорта DuoPlan"), "нет сообщения про чужой файл");
  ok(dialog.includes("/api/data/import"), "нет запроса импорта");
  // Чекбоксы секций с количеством найденных записей
  ok(dialog.includes("imp_${esc(key)}"), "нет чекбоксов секций");
  ok(dialog.includes("imp_${key}") && dialog.includes("fd.get(`imp_${key}`)"), "выбор секций не читается из формы");
  // Файл-пикер: json + скрытый input
  const handler = appJs.slice(appJs.indexOf('action === "import-data"'), appJs.indexOf('action === "save-pair-timezone"'));
  ok(handler.includes('input.accept = ".json,application/json"'), "пикер не ограничен JSON");
  ok(handler.includes("openImportDialog"), "пикер не открывает диалог импорта");
});
