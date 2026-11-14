// HTTP-тесты журнала «Здоровье» (/api/health/*): личный журнал препаратов
// каждого партнёра с настройкой напоминаний бота. Паттерн тот же, что в
// test_cycle_api.test.mjs: блок api() исполняется с минимальными стабами.
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

const buildApi = new Function(
  "json", "ensureSchemaOnce", "telegramUser", "validTimeZone", "ensureUser",
  "rateLimit", "readJson", "state", "membership", "ownerIds",
  "cycleState",
  [
    extractBraced("class HttpError"),
    extractLine("const now = "),
    extractLine("const clean = "),
    extractLine("const CYCLE_DATE_RE"),
    extractLine("const HEALTH_MED_FORMS"),
    extractLine("const HEALTH_MED_STATUS"),
    extractLine("const HEALTH_TIME_RE"),
    extractBraced("function optionalTime"),
    extractBraced("function cycleValidDate"),
    extractBraced("function cycleDayNum"),
    extractBraced("function cycleDateStr"),
    extractBraced("function cycleToday"),
    extractBraced("async function healthState"),
    extractBraced("function validateSchema"),
    extractBraced("function ownerIds"),
    extractBraced("async function api"),
    "return api;"
  ].join("\n")
);

function createMockDB(meds = [], medExists = true) {
  const writes = [];
  return {
    writes,
    async batch(statements = []) { return statements.map(() => ({ meta: { changes: 1 } })); },
    prepare(sql) {
      return {
        bind(...args) {
          writes.push({ sql, args });
          return {
            async first() {
              if (sql.includes("SELECT id FROM health_meds")) return medExists ? { id: 5 } : null;
              return null;
            },
            async all() {
              if (sql.includes("FROM health_meds")) return { results: meds };
              if (sql.includes("FROM health_med_logs")) return { results: [] };
              return { results: [] };
            },
            async run() { return { meta: { changes: 1 } }; }
          };
        },
        async batch() { return {}; }
      };
    }
  };
}

function makeEnv({ body = {}, method = "POST", meds = [], medExists = true } = {}) {
  const db = createMockDB(meds, medExists);
  const request = { method, headers: { get: () => null } };
  const api = buildApi(
    (data, status = 200) => ({ data, status }),
    async () => {},
    async () => ({ id: 777, first_name: "Тест" }),
    () => "Europe/Moscow",
    async () => ({ tg_id: 777, gender: null }),
    async () => {},
    async () => body,
    async () => ({ user: { tg_id: 777, gender: null }, pair: null }),
    async () => null,
    async () => [],
    async () => ({ periods: [], logs: [] })
  );
  return { api, env: { DB: db }, request, writes: db.writes };
}

function isHttpError(error, status, code) {
  return error && error.status === status && error.code === code;
}

const MED = {
  name: "Магний", dosage: "1 таблетка", form: "tablet", schedule: "1 раз в день после еды",
  start_date: "2026-11-10", end_date: "2026-12-10", status: "active",
  remind_enabled: true, remind_time: "09:00", note: null
};

test("POST /api/health/med требует название", async () => {
  const { api, env, request } = makeEnv({ body: { ...MED, name: "  " } });
  await rejects(
    api(request, env, new URL("https://duoplan.test/api/health/med")),
    err => isHttpError(err, 400, "INVALID_NAME")
  );
});

test("POST /api/health/med: напоминание без времени отклоняется", async () => {
  const { api, env, request } = makeEnv({ body: { ...MED, remind_time: null } });
  await rejects(
    api(request, env, new URL("https://duoplan.test/api/health/med")),
    err => isHttpError(err, 400, "INVALID_TIME")
  );
});

test("POST /api/health/med: время напоминания строго ЧЧ:ММ", async () => {
  const { api, env, request } = makeEnv({ body: { ...MED, remind_time: "25:00" } });
  await rejects(
    api(request, env, new URL("https://duoplan.test/api/health/med")),
    err => isHttpError(err, 400, "INVALID_TIME")
  );
});

test("POST /api/health/med: неизвестный статус и форма отклоняются", async () => {
  for (const patch of [{ status: "archived" }, { form: "syrup" }]) {
    const { api, env, request } = makeEnv({ body: { ...MED, ...patch } });
    await rejects(
      api(request, env, new URL("https://duoplan.test/api/health/med")),
      err => err && err.status === 400
    );
  }
});

test("POST /api/health/med сохраняет препарат с напоминанием", async () => {
  const { api, env, request, writes } = makeEnv({ body: MED });
  const response = await api(request, env, new URL("https://duoplan.test/api/health/med"));
  ok(response.status === 200);
  const insert = writes.find(w => w.sql.includes("INSERT INTO health_meds"));
  ok(insert, "вставка выполняется");
  equal(insert.args[0], 777, "запись принадлежит владельцу сессии (tg_id)");
  ok(insert.args.some(a => a === 1), "remind_enabled=1 сохраняется");
  ok(insert.args.includes("09:00"), "время напоминания сохраняется");
});

test("POST /api/health/med: выключенное напоминание сбрасывает время в NULL", async () => {
  const { api, env, request, writes } = makeEnv({ body: { ...MED, remind_enabled: false, remind_time: "09:00" } });
  await api(request, env, new URL("https://duoplan.test/api/health/med"));
  const insert = writes.find(w => w.sql.includes("INSERT INTO health_meds"));
  ok(!insert.args.includes("09:00"), "время не сохраняется при выключенном напоминании");
});

test("POST /api/health/med: end_date раньше start_date отклоняется", async () => {
  const { api, env, request } = makeEnv({ body: { ...MED, end_date: "2026-11-01" } });
  await rejects(
    api(request, env, new URL("https://duoplan.test/api/health/med")),
    err => isHttpError(err, 400, "INVALID_DATE")
  );
});

test("POST /api/health/med: курс может заканчиваться в будущем", async () => {
  const { api, env, request, writes } = makeEnv({ body: MED });
  await api(request, env, new URL("https://duoplan.test/api/health/med"));
  const insert = writes.find(w => w.sql.includes("INSERT INTO health_meds"));
  ok(insert.args.includes("2026-12-10"), "конец курса в будущем допустим (курс запланирован)");
});

test("GET /api/health/meds: только свои препараты, флаг напоминания — булев", async () => {
  const { api, env, request } = makeEnv({
    method: "GET",
    meds: [{ id: 5, name: "Магний", remind_enabled: 1, remind_time: "09:00", status: "active" }]
  });
  const response = await api(request, env, new URL("https://duoplan.test/api/health/meds"));
  equal(response.data.meds.length, 1);
  equal(response.data.meds[0].remind_enabled, true, "0/1 из БД нормализуется в булево");
  ok(Array.isArray(response.data.med_logs));
});

test("POST /api/health/med-log: чужой или несуществующий препарат — 404", async () => {
  const { api, env, request } = makeEnv({ body: { med_id: 99, date: "2026-11-10", status: "taken" }, medExists: false });
  await rejects(
    api(request, env, new URL("https://duoplan.test/api/health/med-log")),
    err => isHttpError(err, 404, "NOT_FOUND")
  );
});

test("POST /api/health/med-log: будущая дата отклоняется", async () => {
  const { api, env, request } = makeEnv({ body: { med_id: 5, date: "2999-01-01", status: "taken" } });
  await rejects(
    api(request, env, new URL("https://duoplan.test/api/health/med-log")),
    err => isHttpError(err, 400, "INVALID_DATE")
  );
});

test("POST /api/health/med-log: неизвестный статус отклоняется", async () => {
  const { api, env, request } = makeEnv({ body: { med_id: 5, date: "2026-11-10", status: "forgot" } });
  await rejects(
    api(request, env, new URL("https://duoplan.test/api/health/med-log")),
    err => isHttpError(err, 400, "INVALID_STATUS")
  );
});

test("POST /api/health/med-log сохраняет факт приёма за день", async () => {
  const { api, env, request, writes } = makeEnv({ body: { med_id: 5, date: "2026-11-10", status: "taken", time: "09:15" } });
  const response = await api(request, env, new URL("https://duoplan.test/api/health/med-log"));
  ok(response.status === 200);
  const insert = writes.find(w => w.sql.includes("INSERT INTO health_med_logs"));
  ok(insert, "факт приёма сохраняется");
  ok(insert.sql.includes("ON CONFLICT(med_id,date)"), "один итог за день (upsert)");
  equal(insert.args[0], 5);
  equal(insert.args[1], 777);
});

test("POST /api/health/med-log: время приёма строго ЧЧ:ММ или пусто", async () => {
  // Регресс P2: раньше String(body.time).slice(0,5) сохранял любой ввод —
  // «25:99», «abcde» и обрезанные длинные строки попадали в базу.
  for (const bad of ["25:99", "12:60", "abcde", "9:30", "2026-11-10T09:15:00", "123456"]) {
    const { api, env, request } = makeEnv({ body: { med_id: 5, date: "2026-11-10", status: "taken", time: bad } });
    await rejects(
      api(request, env, new URL("https://duoplan.test/api/health/med-log")),
      err => isHttpError(err, 400, "INVALID_TIME"),
      `time=${bad} должен отклоняться`
    );
  }
  // Границы и пустое значение: валидное время сохраняется, пустое — NULL.
  for (const [time, expected] of [["00:00", "00:00"], ["23:59", "23:59"], ["", null], [undefined, null]]) {
    const { api, env, request, writes } = makeEnv({ body: { med_id: 5, date: "2026-11-10", status: "taken", time } });
    await api(request, env, new URL("https://duoplan.test/api/health/med-log"));
    const insert = writes.find(w => w.sql.includes("INSERT INTO health_med_logs"));
    ok(insert, "запись сохраняется");
    equal(insert.args[3], expected, `time=${time}`);
  }
});

test("POST /api/health/med/delete удаляет препарат и историю атомарно", async () => {
  const { api, env, request, writes } = makeEnv({ body: { id: 5 } });
  const response = await api(request, env, new URL("https://duoplan.test/api/health/med/delete"));
  ok(response.status === 200);
  const batch = writes.filter(w => w.sql.includes("DELETE FROM health_med_logs") || w.sql.includes("DELETE FROM health_meds"));
  equal(batch.length, 2, "удаляются и журнал, и запись");
});
