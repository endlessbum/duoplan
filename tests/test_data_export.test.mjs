// Экспорт данных: POST /api/data/export (worker.js) — записи дневника и
// значимые даты пары одним JSON-файлом через sendDocument. Проверяем
// форматтер dataExportFile (структура, нормализация флагов, заглушки автора)
// и сам маршрут: SELECT с фильтром приватных дат партнёра, содержимое
// multipart-формы, точные счётчики в ответе.
//
// Запуск: node --test tests/test_data_export.test.mjs
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { deepStrictEqual, equal, match, ok } from "node:assert/strict";
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
// 1. Форматтер файла
// ------------------------------------------------------------------
const load = new Function(
  [
    extractLine("const APP_VERSION"),
    extractLine("const clean = "),
    extractBraced("function exportMemoryRow"),
    extractBraced("function exportDateRow"),
    extractBraced("function dataExportFile"),
    extractBraced("function privateDatesExportFile"),
    "return { dataExportFile, privateDatesExportFile, APP_VERSION };"
  ].join("\n")
);
const { dataExportFile, privateDatesExportFile, APP_VERSION } = load();

test("файл содержит структуру приложения, дневник и даты", () => {
  const file = JSON.parse(dataExportFile(
    [{ id: 5, title: "Выходные", body: "Тёплый **вечер** у реки", day: "2026-10-31", created_at: 1790000000, author: "Аня" }],
    [{ id: 7, title: "Годовщина", day: "2027-03-08", time: "12:00", recurs: 1, monthly: 0, is_private: 1, created_at: 1780000000, author: "Игорь" }]
  ));
  equal(file.app, "duoplan");
  equal(file.version, APP_VERSION);
  ok(!Number.isNaN(Date.parse(file.exported_at)), "exported_at — дата");
  deepStrictEqual(file.memories, [{
    id: 5,
    day: "2026-10-31",
    author: "Аня",
    title: "Выходные",
    body: "Тёплый **вечер** у реки",
    created_at: 1790000000
  }]);
  deepStrictEqual(file.dates, [{
    id: 7,
    day: "2027-03-08",
    time: "12:00",
    title: "Годовщина",
    kind: "date",     // вид записи: дата или день рождения
    recurs: true,     // 1 -> true
    monthly: false,   // 0 -> false
    is_private: true, // 1 -> true
    author: "Игорь",
    created_at: 1780000000
  }]);
});

test("файл «Личные даты» содержит только личные даты", () => {
  const file = JSON.parse(privateDatesExportFile([
    { id: 11, title: "Сюрприз", day: "2027-05-01", time: null, recurs: 0, monthly: 0, is_private: 1, created_at: 3, author: "Аня" }
  ]));
  equal(file.app, "duoplan");
  equal(file.version, APP_VERSION);
  ok(!Number.isNaN(Date.parse(file.exported_at)));
  deepStrictEqual(file.dates, [{
    id: 11,
    day: "2027-05-01",
    time: null,
    title: "Сюрприз",
    kind: "date",
    recurs: false,
    monthly: false,
    is_private: true,
    author: "Аня",
    created_at: 3
  }]);
  ok(!("memories" in file), "в файле личных дат дневника нет");
});

test("пустой заголовок — null, пустой автор — «Партнёр», пустые списки допустимы", () => {
  const file = JSON.parse(dataExportFile(
    [{ id: 1, title: "   ", body: "Текст", day: "2026-11-01", created_at: 1, author: null }],
    []
  ));
  equal(file.memories[0].title, null);
  equal(file.memories[0].author, "Партнёр");
  deepStrictEqual(file.dates, []);
  equal(Object.keys(file).length, 5);
});

test("тело — валидный JSON без потерь юникода", () => {
  const raw = dataExportFile(
    [{ id: 2, title: null, body: "🎄 & <кавычки> \"тут\"", day: "2026-11-01", created_at: 2, author: "Аня" }],
    []
  );
  const parsed = JSON.parse(raw);
  equal(parsed.memories[0].body, "🎄 & <кавычки> \"тут\"");
});

// ------------------------------------------------------------------
// 2. Маршрут: приватность, форма, счётчики
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
    extractBraced("function validateSchema"),
    extractBraced("function textField"),
    extractBraced("function validDate"),
    extractBraced("function optionalTime"),
    extractBraced("function validTimeZone"),
    extractBraced("function localDay"),
    extractBraced("function exportMemoryRow"),
    extractBraced("function exportDateRow"),
    extractBraced("function dataExportFile"),
    extractBraced("function privateDatesExportFile"),
    extractBraced("function ownerIds"),
    extractBraced("async function api"),
    "return api;"
  ].join("\n")
);

function makeApiEnv({ pair, memories, dates, privateDates, tgId = 777 }) {
  const queries = [];
  const db = {
    prepare(sql) {
      return {
        bind(...args) {
          queries.push({ sql, args });
          return {
            run: async () => ({ meta: { changes: 1 } }),
            // Порядок выборок маршрута: дневник, даты архива, личные даты.
            all: async () => ({ results: queries.length === 1 ? memories : queries.length === 2 ? dates : privateDates }),
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
    async () => ({}),
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

test("маршрут шлёт два файла: «Архив» и «Личные даты», с фильтрами приватности", async () => {
  const env0 = makeApiEnv({
    pair: { id: 3, timezone: "Asia/Irkutsk" },
    memories: [{ id: 5, title: "Выходные", body: "Текст", day: "2026-10-31", created_at: 1, author: "Аня" }],
    dates: [{ id: 9, title: "Общая", day: "2027-01-15", time: null, recurs: 0, monthly: 0, is_private: 0, created_at: 2, author: "Игорь" }],
    privateDates: [{ id: 12, title: "Сюрприз", day: "2027-05-01", time: null, recurs: 0, monthly: 0, is_private: 1, created_at: 3, author: "Аня" }]
  });
  const response = await env0.api(env0.request, env0.env, new URL("https://duoplan.test/api/data/export"));

  // Даты архива — с фильтром видимости; личные — строго свои.
  const datesQuery = env0.queries.find(q => q.sql.includes("FROM dates d") && q.sql.includes("(d.is_private=0 OR d.created_by=?)"));
  ok(datesQuery, "фильтр видимости дат архива в SQL");
  deepStrictEqual(datesQuery.args, [3, 777]);
  const privateQuery = env0.queries.find(q => q.sql.includes("d.is_private=1 AND d.created_by=?"));
  ok(privateQuery, "личные даты — отдельным запросом только свои");
  deepStrictEqual(privateQuery.args, [3, 777]);

  // Ровно два sendDocument: «Архив» и «Личные даты».
  equal(env0.uploads.length, 2);
  const [archive, personal] = env0.uploads;
  for (const upload of env0.uploads) equal(upload.method, "sendDocument");

  equal(archive.form.get("chat_id"), "777");
  match(archive.form.get("caption"), /Архив — записи дневника: 1, значимые даты: 1/);
  const archiveDoc = archive.form.get("document");
  equal(archiveDoc.name, "Архив.json");
  const archivePayload = JSON.parse(await archiveDoc.text());
  equal(archivePayload.app, "duoplan");
  equal(archivePayload.memories.length, 1);
  equal(archivePayload.dates.length, 1);
  equal(archivePayload.memories[0].title, "Выходные");

  equal(personal.form.get("caption"), "Личные даты — только ваши личные значимые даты: 1.");
  const personalDoc = personal.form.get("document");
  equal(personalDoc.name, "Личные даты.json");
  const personalPayload = JSON.parse(await personalDoc.text());
  deepStrictEqual(personalPayload.dates.length, 1);
  equal(personalPayload.dates[0].title, "Сюрприз");
  ok(!("memories" in personalPayload));

  // Ответ — счётчики для интерфейса.
  deepStrictEqual(response.data, { ok: true, memories: 1, dates: 1, private_dates: 1 });
});

test("маршрут без записей всё равно шлёт оба валидных файла", async () => {
  const env0 = makeApiEnv({ pair: { id: 4, timezone: "Europe/Moscow" }, memories: [], dates: [], privateDates: [] });
  const response = await env0.api(env0.request, env0.env, new URL("https://duoplan.test/api/data/export"));
  equal(env0.uploads.length, 2);
  const archive = JSON.parse(await env0.uploads[0].form.get("document").text());
  const personal = JSON.parse(await env0.uploads[1].form.get("document").text());
  deepStrictEqual(archive.memories, []);
  deepStrictEqual(archive.dates, []);
  deepStrictEqual(personal.dates, []);
  deepStrictEqual(response.data, { ok: true, memories: 0, dates: 0, private_dates: 0 });
});
