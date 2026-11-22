// Импорт данных: POST /api/data/import (worker.js) — читает JSON-конверт
// экспорта (buildExportEnvelope), валидирует каждую строку и вставляет
// выбранные секции. Проверяем: настройки записей восстанавливаются
// (приватность, время, напоминания препаратов), валидация строки отменяет
// импорт целиком (ничего не вставляется), дубли по уникальным индексам
// уходят в skipped, мед-логи Фло ссылаются на препарат из той же поставки,
// доступ к Фло только у владелицы.
//
// api() извлекается из worker.js как есть и исполняется против мока D1 —
// тот же приём, что в test_data_export и test_memory_title.
//
// Запуск: node --test tests/test_data_import.test.mjs
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { deepStrictEqual, equal, ok, rejects } from "node:assert/strict";
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

const buildApi = new Function(
  "json", "ensureSchemaOnce", "telegramUser", "validTimeZone", "ensureUser",
  "rateLimit", "readJson", "state", "membership", "ownerIds",
  [
    extractBraced("class HttpError"),
    extractLine("const now = "),
    extractLine("const clean = "),
    extractLine("const DEFAULT_TZ"),
    extractLine("const APP_VERSION"),
    extractLine("const ACCENT_KEYS"),
    extractLine("const STATE_ACTIVE_LIMIT"),
    extractLine("const ASCII_ART_MAX_COLUMNS = 144"),
    extractLine("const ASCII_ART_MAX_ROWS = 120"),
    extractLine("const ASCII_ART_MAX_LENGTH = 18000"),
    extractBraced("function validateSchema"),
    extractBraced("function textField"),
    extractBraced("function validDate"),
    extractBraced("function optionalTime"),
    extractBraced("function validateAsciiArt"),
    extractBraced("function wishUrl"),
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

// Мок D1: INSERT-ы собираются в queries для проверки биндов; changesFor
// позволяет сымитировать уникальный индекс (changes: 0 — дубль).
function makeApiEnv({ pair, body, tgId = 777, gender = "male", changesFor = () => 1, medLookup = null }) {
  const queries = [];
  let rowId = 1000;
  const db = {
    prepare(sql) {
      return {
        bind(...args) {
          queries.push({ sql, args });
          return {
            run: async () => ({ meta: { changes: changesFor(sql, args), last_row_id: ++rowId } }),
            all: async () => ({ results: [] }),
            first: async () => (sql.includes("FROM cycle_meds WHERE tg_id=? AND name=?") ? medLookup : null)
          };
        }
      };
    }
  };
  const request = { method: "POST", headers: { get: () => null } };
  const api = buildApi(
    (data, status = 200) => ({ data, status }),
    async () => {},
    async () => ({ id: tgId, first_name: "Тест" }),
    new Function(`${extractBraced("function validTimeZone")}; return validTimeZone;`)(),
    async () => ({ tg_id: tgId, gender }),
    async () => {},
    async () => body,
    async () => ({ user: { tg_id: tgId, gender }, pair }),
    async () => pair,
    async () => []
  );
  return { api, env: { DB: db }, queries, request };
}

const callImport = (env0) => env0.api(env0.request, env0.env, new URL("https://duoplan.test/api/data/import"));
const insertsFor = (env0, table) => env0.queries.filter((q) => q.sql.includes(`INSERT INTO ${table}`) || q.sql.includes(`INSERT OR IGNORE INTO ${table}`));

test("импорт планов: настройки (время, повтор, приватность) восстанавливаются из файла", async () => {
  const env0 = makeApiEnv({
    pair: { id: 3, timezone: "Europe/Moscow" },
    body: { sections: { plans: [{
      id: 5, title: "Поездка на Байкал", day: "2027-02-01", time: "09:30",
      monthly: true, yearly: false, is_private: true, author: "Аня", created_at: 1790000000
    }] } }
  });
  const response = await callImport(env0);
  const inserts = insertsFor(env0, "tasks");
  equal(inserts.length, 1, "план не вставлен");
  ok(inserts[0].sql.includes("status) VALUES"), "план должен вставляться незавершённым");
  // Порядок binds = порядок колонок SQL (pair_id,title,day,time,monthly,
  // yearly,is_private,created_by,created_at) — сдвиг здесь кладёт tg_id
  // в title (репорт e2e-проверки 2026-11-22).
  deepStrictEqual(inserts[0].args, [3, "Поездка на Байкал", "2027-02-01", "09:30", 1, 0, 1, 777, 1790000000]);
  deepStrictEqual(response.data, { ok: true, counts: { plans: 1 }, skipped: {} });
});

test("импорт здоровья: напоминания препарата восстанавливаются", async () => {
  const env0 = makeApiEnv({
    pair: { id: 3, timezone: "Europe/Moscow" },
    body: { sections: { health: [{
      id: 9, name: "Магний", form: "tablet", dosage: "400 мг", schedule: "2 раза в день",
      status: "active", start_date: "2026-11-01", end_date: null,
      remind_enabled: true, remind_time: "08:00,20:00", note: "после еды", created_at: 1790000000
    }] } }
  });
  const response = await callImport(env0);
  const inserts = insertsFor(env0, "health_meds");
  equal(inserts.length, 1, "препарат не вставлен");
  ok(inserts[0].sql.includes("remind_enabled"), "колонки напоминаний не вставляются");
  // tg_id — импортёр, напоминания — из файла, обновлённая метка — now()
  deepStrictEqual(inserts[0].args.slice(0, 8), [777, "Магний", "tablet", "400 мг", "2 раза в день", 1, "08:00,20:00", "2026-11-01"]);
  deepStrictEqual(response.data.counts, { health: 1 });
});

test("импорт дат: kind секции принудителен (birthdays → birthday)", async () => {
  const env0 = makeApiEnv({
    pair: { id: 3, timezone: "Europe/Moscow" },
    body: { sections: { birthdays: [{
      id: 7, title: "День рождения Маши", day: "1996-12-03", time: null,
      recurs: true, monthly: false, is_private: false, kind: "birthday", created_at: 5
    }] } }
  });
  await callImport(env0);
  const inserts = insertsFor(env0, "dates");
  equal(inserts.length, 1, "дата не вставлена");
  ok(inserts[0].sql.includes("kind"), "kind не вставляется");
  deepStrictEqual(inserts[0].args, [3, "День рождения Маши", "1996-12-03", null, 1, 0, "birthday", 0, 777, 5]);
});

test("импорт кино с точкой просмотра; дубль по imdb_id уходит в skipped", async () => {
  const env0 = makeApiEnv({
    pair: { id: 3, timezone: "Europe/Moscow" },
    body: { sections: { movies: [{ id: 6, imdb_id: "tt15398776", title: "Оппенгеймер", year: 2023, kind: "movie", rating: 8.4, rating_source: "imdb", runtime: 181, resume_position: "1:12:00", created_at: 2 }] } },
    changesFor: (sql) => (sql.includes("INSERT OR IGNORE INTO movies") ? 0 : 1)
  });
  const response = await callImport(env0);
  equal(insertsFor(env0, "movies").length, 1, "INSERT OR IGNORE не выполнен");
  const binds = insertsFor(env0, "movies")[0].args;
  equal(binds[3], "Оппенгеймер");
  equal(binds[12], "1:12:00", "точка просмотра потеряна");
  deepStrictEqual(response.data, { ok: true, counts: {}, skipped: { movies: 1 } });
});

test("контакты: телефоны разбираются в contact_phones по порядку", async () => {
  const env0 = makeApiEnv({
    pair: { id: 3, timezone: "Europe/Moscow" },
    body: { sections: { contacts: [{ id: 8, name: "Маша", surname: "Иванова", comment: "друг", phones: "+7 900 000-00-00, +7 911 111-11-11" }] } }
  });
  await callImport(env0);
  const phoneInserts = env0.queries.filter((q) => q.sql.includes("INSERT OR IGNORE INTO contact_phones"));
  equal(phoneInserts.length, 2, "телефоны не разобраны");
  deepStrictEqual(phoneInserts.map((q) => [q.args[1], q.args[2]]), [["+7 900 000-00-00", 0], ["+7 911 111-11-11", 1]], "порядок телефонов и sort");
});

test("битая строка отменяет импорт целиком: валидация до первой вставки", async () => {
  const env0 = makeApiEnv({
    pair: { id: 3, timezone: "Europe/Moscow" },
    body: { sections: {
      plans: [{ id: 1, title: "Хороший план", day: "2027-01-01", created_at: 1 }],
      dates: [{ id: 2, title: "Битая дата", day: "не дата", recurs: true, monthly: false, is_private: false, kind: "date", created_at: 2 }]
    } }
  });
  await rejects(
    callImport(env0),
    (error) => error.status === 400 && error.code === "INVALID_ROW"
  );
  equal(insertsFor(env0, "tasks").length, 0, "валидный план вставился до валидации остального файла");
  equal(insertsFor(env0, "dates").length, 0, "битая дата вставилась");
});

test("чужой ключ секции — 400, пустой файл — 400", async () => {
  for (const body of [{ sections: { savings: [{ id: 1 }] } }, { sections: {} }]) {
    const env0 = makeApiEnv({ pair: { id: 3, timezone: "Europe/Moscow" }, body });
    await rejects(
      callImport(env0),
      (error) => error.status === 400 && error.code === "INVALID_IMPORT"
    );
    equal(env0.queries.length, 0);
  }
});

test("Фло — только владелица: мужчина получает 403", async () => {
  const env0 = makeApiEnv({
    pair: { id: 3, timezone: "Europe/Moscow" },
    body: { sections: { cycle: [{ kind: "period", start_date: "2026-10-01", end_date: "2026-10-05", end_unknown: false, created_at: 1 }] } }
  });
  await rejects(
    callImport(env0),
    (error) => error.status === 403 && error.code === "FORBIDDEN"
  );
  equal(env0.queries.length, 0);
});

test("Фло: мед-лог ссылается на препарат из той же поставки", async () => {
  const env0 = makeApiEnv({
    pair: { id: 3, timezone: "Europe/Moscow" }, gender: "female",
    body: { sections: { cycle: [
      { kind: "med", start_date: "2026-10-01", end_date: null, name: "Эстроген", dosage: "2 мг", category: "hormonal", form: "tablet", schedule: "1 раз в день", status: "active", created_at: 5 },
      { kind: "med_log", date: "2026-10-02", med_name: "Эстроген", time: "08:00", status: "taken", dose_taken: "2 мг", note: "", created_at: 6 }
    ] } }
  });
  const response = await callImport(env0);
  const medInsert = insertsFor(env0, "cycle_meds")[0];
  ok(medInsert, "препарат Фло не вставлен");
  deepStrictEqual(medInsert.args.slice(0, 3), [777, "Эстроген", "2 мг"], "доза должна восстанавливаться отдельным полем");
  const logInsert = env0.queries.find((q) => q.sql.includes("INSERT OR IGNORE INTO cycle_med_logs"));
  ok(logInsert, "мед-лог не вставлен");
  equal(logInsert.args[0], 1001, "med_id не ссылается на препарат из поставки");
  deepStrictEqual(response.data.counts, { cycle: 2 });
});

test("Фло: мед-лог без препарата в базе и файле — пропускается, а не падает", async () => {
  const env0 = makeApiEnv({
    pair: { id: 3, timezone: "Europe/Moscow" }, gender: "female",
    body: { sections: { cycle: [
      { kind: "med_log", date: "2026-10-02", med_name: "Неизвестный", time: null, status: "taken", dose_taken: null, note: "", created_at: 6 }
    ] } },
    medLookup: null
  });
  const response = await callImport(env0);
  equal(env0.queries.filter((q) => q.sql.includes("INSERT OR IGNORE INTO cycle_med_logs")).length, 0, "лог вставлен без препарата");
  deepStrictEqual(response.data, { ok: true, counts: {}, skipped: { cycle: 1 } });
});

test("Фло: дубль дня дневника по UNIQUE(tg_id,date) — в skipped", async () => {
  const env0 = makeApiEnv({
    pair: { id: 3, timezone: "Europe/Moscow" }, gender: "female",
    body: { sections: { cycle: [
      { kind: "log", date: "2026-10-02", flow: "light", clots: false, symptoms: [], symptoms_clear: true, note: "", sex: null, sex_count: 0, leakage: null, pain_score: null, pain_locations: [], life_impact: null, mucus: "{}", sleep_hours: 7.5, sleep_quality: "good", stress: "low", sick: false, travel: false, weight_kg: 55.4, bleeding_details: null, created_at: 6 }
    ] } },
    changesFor: (sql) => (sql.includes("INSERT OR IGNORE INTO cycle_logs") ? 0 : 1)
  });
  const response = await callImport(env0);
  deepStrictEqual(response.data, { ok: true, counts: {}, skipped: { cycle: 1 } });
});

test("SOLO-доступ: импорт разрешён без партнёра", () => {
  ok(source.includes('"/api/data/import"'), "импорт не добавлен в SOLO_ALLOWED_PATHS");
});
