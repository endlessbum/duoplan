// HTTP-level tests for the Cycle API (duoPlan)
// These tests cover the gender gate, input validation, and privacy constraints.
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

// Build the API function from worker.js, providing minimal shims for the imports used.
const buildApi = new Function(
  "json", "ensureSchemaOnce", "telegramUser", "validTimeZone", "ensureUser",
  "rateLimit", "readJson", "state", "membership", "ownerIds",
  "cycleState",
  [
    extractBraced("class HttpError"),
    extractLine("const ACCENT_KEYS"),
    extractLine("const now = "),
    extractLine("const clean = "),
    extractLine("const CYCLE_DATE_RE"),
    extractLine("const CYCLE_LEVELS"),
    extractLine("const CYCLE_SHARE_CATEGORIES"),
    extractLine("const CYCLE_SHARE_COLUMNS"),
    extractLine("const CYCLE_BLEEDING_SATURATION"),
    extractLine("const CYCLE_PERIOD_MAX_DAYS"),
    extractLine("const CYCLE_CONTEXT_KEYS"),
    extractLine("const CYCLE_FLOWS"),
    extractLine("const CYCLE_ENERGY"),
    extractLine("const CYCLE_MOOD_CODES"),
    extractLine("const CYCLE_SYMPTOM_CODES"),
    extractLine("const CYCLE_SEX"),
    extractLine("const CYCLE_LEAKAGE"),
    extractLine("const CYCLE_PAIN_LOCATIONS"),
    extractLine("const CYCLE_LIFE_IMPACT"),
    extractLine("const CYCLE_MUCUS_AMOUNTS"),
    extractLine("const CYCLE_MUCUS_CONSISTENCY"),
    extractLine("const CYCLE_MUCUS_COLORS"),
    extractLine("const CYCLE_SLEEP_QUALITY"),
    extractLine("const CYCLE_STRESS"),
    extractLine("const CYCLE_MEASUREMENT_KINDS"),
    extractLine("const CYCLE_LH_RESULTS"),
    extractLine("const CYCLE_MED_CATEGORIES"),
    extractLine("const CYCLE_MED_FORMS"),
    extractLine("const CYCLE_MED_STATUS"),
    extractLine("const NOTIFY_COLUMNS"),
    extractLine("const CYCLE_MS_DAY"),
    extractBraced("function cycleValidDate"),
    extractBraced("function cycleDayNum"),
    extractBraced("function cycleDateStr"),
    extractBraced("function cycleToday"),
    extractBraced("function cyclePhaseTip"),
    extractBraced("function cycleShareCategories"),
    extractBraced("function cycleViewForPartner"),
    extractBraced("async function cyclePartnerView"),
    extractBraced("function cyclePeriodItemsPlan"),
    extractBraced("function cyclePeriodsOverlapError"),
    extractBraced("function cycleOnboardPlan"),
    extractBraced("function validateSchema"),
    extractBraced("function ownerIds"),
    extractBraced("async function api"),
    "return api;"
  ].join("\n")
);

// Simple DB mock: gender for the gate, periods for overlap checks, and a
// write log so tests can assert what the route persisted.
function createMockDB(gender = null, periods = [], medExists = true) {
  const writes = [];
  return {
    writes,
    // Route-level batch (onboard/delete/bulk periods): statements were
    // already bind()ed; report one change per statement so bulk counts work.
    async batch(statements = []) {
      return statements.map(() => ({ meta: { changes: 1 } }));
    },
    prepare(sql) {
      return {
        bind(...args) {
          writes.push({ sql, args });
          return {
            async first() {
              if (sql.includes("SELECT gender FROM users")) {
                return { gender };
              }
              if (sql.includes("SELECT avg_cycle_length")) {
                return { avg_cycle_length: 28, avg_period_length: 5 };
              }
              // Препарат существует — med-log принимает записи.
              if (sql.includes("FROM cycle_meds")) {
                return medExists ? { id: 5 } : null;
              }
              return null;
            },
            async all() {
              // Overlap checks read the owner's periods.
              if (sql.includes("FROM cycle_periods")) return { results: periods };
              return { results: [] };
            },
            async run() {
              return { meta: { changes: 1 } };
            },
            async batch() {
              return {};
            }
          };
        },
        // For batch calls used in delete/onboard.
        async batch() {
          return {};
        }
      };
    }
  };
}

function makeEnv({ gender = null, body = {}, method = "POST", periods = [], medExists = true, shareRow = null, membershipPair = null, stateMock = null } = {}) {
  const db = createMockDB(gender, periods, medExists);
  const baseFirst = db.prepare.bind(db);
  if (shareRow) {
    const innerPrepare = db.prepare;
    db.prepare = (sql) => {
      const bound = innerPrepare(sql);
      if (sql.includes("FROM cycle_profiles p JOIN users u")) {
        return {
          bind: () => ({
            async first() { return shareRow; },
            async all() { return { results: [] }; },
            async run() { return { meta: { changes: 1 } }; }
          })
        };
      }
      return bound;
    };
  }
  const request = { method, headers: { get: () => null } };
  const api = buildApi(
    (data, status = 200) => ({ data, status }),
    async () => {},
    async () => ({ id: 777, first_name: "Тест" }),
    () => "Europe/Moscow",
    async () => ({ tg_id: 777, gender }),
    async () => {},
    async () => body,
    async () => ({ user: { tg_id: 777, gender }, pair: null }),
    async () => membershipPair,
    async () => [],
    // Mock DB does not store periods/logs, so state is always empty.
    stateMock || (async () => ({ periods: [], logs: [] }))
  );
  return { api, env: { DB: db }, request, writes: db.writes };
}

// Helper to extract the HttpError code from a rejected promise.
function isHttpError(error, status, code) {
  return error && error.status === status && error.code === code;
}

// 1. Gender gate: non‑female users cannot access any /api/cycle/* endpoint.
test("POST /api/cycle/state returns 403 for male gender", async () => {
  const { api, env, request } = makeEnv({ gender: "male" });
  await rejects(
    api(request, env, new URL("https://duoplan.test/api/cycle/state")),
    err => isHttpError(err, 403, "CYCLE_FORBIDDEN")
  );
});

test("POST /api/cycle/state returns 403 for missing gender", async () => {
  const { api, env, request } = makeEnv({ gender: null });
  await rejects(
    api(request, env, new URL("https://duoplan.test/api/cycle/state")),
    err => isHttpError(err, 403, "CYCLE_FORBIDDEN")
  );
});

// 2. Female user passes the gender gate and receives a (empty) state.
test("GET /api/cycle/state succeeds for female gender", async () => {
  const { api, env, request } = makeEnv({ gender: "female", method: "GET" });
  const response = await api(request, env, new URL("https://duoplan.test/api/cycle/state"));
  // The mock DB returns empty periods/logs, so state should contain those keys.
  deepStrictEqual(response.data.periods, []);
  deepStrictEqual(response.data.logs, []);
});

// 3. Validation: POST /api/cycle/period with malformed dates.
test("POST /api/cycle/period validates dates", async () => {
  const { api, env, request } = makeEnv({ gender: "female", body: { start: "2026-13-01", end: "2026-13-05" } });
  await rejects(
    api(request, env, new URL("https://duoplan.test/api/cycle/period")),
    err => isHttpError(err, 400, "INVALID_DATE")
  );
});

// 4. Successful period creation for a female user.
test("POST /api/cycle/period creates a period for female", async () => {
  const { api, env, request } = makeEnv({ gender: "female", body: { start: "2026-11-01", end: "2026-11-05" } });
  const response = await api(request, env, new URL("https://duoplan.test/api/cycle/period"));
  // The mock DB does not store data, but the API returns the (empty) state.
  deepStrictEqual(response.data.periods, []);
});

// 5. Privacy: share settings are ignored for non‑female users (already blocked by gender gate).
test("POST /api/cycle/share respects gender gate", async () => {
  const { api, env, request } = makeEnv({ gender: "male", body: { enabled: true, level: "phases" } });
  await rejects(
    api(request, env, new URL("https://duoplan.test/api/cycle/share")),
    err => isHttpError(err, 403, "CYCLE_FORBIDDEN")
  );
});

// 6. Integrity (audit 3.1.A): actual periods and diary entries cannot be
// written to future dates, even by a direct API call.
test("POST /api/cycle/period rejects future start", async () => {
  const { api, env, request } = makeEnv({ gender: "female", body: { start: "2999-01-01", end: "2999-01-05" } });
  await rejects(
    api(request, env, new URL("https://duoplan.test/api/cycle/period")),
    err => isHttpError(err, 400, "INVALID_DATE")
  );
});

test("POST /api/cycle/period rejects future end", async () => {
  const { api, env, request } = makeEnv({ gender: "female", body: { start: "2026-01-01", end: "2999-01-05" } });
  await rejects(
    api(request, env, new URL("https://duoplan.test/api/cycle/period")),
    err => isHttpError(err, 400, "INVALID_DATE")
  );
});

test("PATCH /api/cycle/period rejects future end", async () => {
  const { api, env, request } = makeEnv({ gender: "female", body: { original_start: "2026-01-01", start: "2026-01-01", end: "2999-01-05" } });
  await rejects(
    api(request, env, new URL("https://duoplan.test/api/cycle/period")),
    err => isHttpError(err, 400, "INVALID_DATE")
  );
});

test("POST /api/cycle/log rejects future date", async () => {
  const { api, env, request } = makeEnv({ gender: "female", body: { date: "2999-01-01", flow: "light" } });
  await rejects(
    api(request, env, new URL("https://duoplan.test/api/cycle/log")),
    err => isHttpError(err, 400, "INVALID_DATE")
  );
});

// 7. Integrity (audit 3.1.B): no overlapping periods and no second open period.
test("POST /api/cycle/period rejects overlap with an existing period", async () => {
  const { api, env, request } = makeEnv({
    gender: "female",
    body: { start: "2026-11-05", end: "2026-11-09" },
    periods: [{ id: 1, start_date: "2026-11-03", end_date: "2026-11-07" }]
  });
  await rejects(
    api(request, env, new URL("https://duoplan.test/api/cycle/period")),
    err => isHttpError(err, 409, "PERIOD_OVERLAP")
  );
});

test("POST /api/cycle/period rejects a second open period", async () => {
  const { api, env, request } = makeEnv({
    gender: "female",
    body: { start: "2026-11-12" },
    periods: [{ id: 1, start_date: "2026-11-01", end_date: null }]
  });
  await rejects(
    api(request, env, new URL("https://duoplan.test/api/cycle/period")),
    err => isHttpError(err, 409, "PERIOD_OVERLAP")
  );
});

test("PATCH /api/cycle/period rejects edits that create an overlap", async () => {
  const { api, env, request } = makeEnv({
    gender: "female",
    method: "PATCH",
    body: { original_start: "2026-11-01", start: "2026-11-05", end: "2026-11-07" },
    periods: [
      { id: 1, start_date: "2026-11-01", end_date: "2026-11-04" },
      { id: 2, start_date: "2026-11-05", end_date: "2026-11-08" }
    ]
  });
  await rejects(
    api(request, env, new URL("https://duoplan.test/api/cycle/period")),
    err => isHttpError(err, 409, "PERIOD_OVERLAP")
  );
});

test("same-start period still updates its end date (upsert)", async () => {
  const { api, env, request } = makeEnv({
    gender: "female",
    body: { start: "2026-11-01", end: "2026-11-05" },
    periods: [{ id: 1, start_date: "2026-11-01", end_date: null }]
  });
  await api(request, env, new URL("https://duoplan.test/api/cycle/period"));
  ok(true); // no rejection: same start is an update, not an overlap
});

// 8. Integrity (audit 3.1.D): the profile records whether the cycle length
// was set by the user, not silently defaulted to 28.
test("onboard stores cycle_length_known when the user named a value", async () => {
  const { api, env, request, writes } = makeEnv({ gender: "female", body: { last_start: "2026-11-01", period_length: 4, cycle_length: 30 } });
  await api(request, env, new URL("https://duoplan.test/api/cycle/onboard"));
  const update = writes.find(w => w.sql.includes("cycle_length_known=?"));
  ok(update, "onboard должен писать cycle_length_known");
  equal(update.args[2], 1);
  const insert = writes.find(w => w.sql.includes("INSERT INTO cycle_periods"));
  ok(insert, "onboard должен создавать период");
  equal(insert.args[2], null, "онбординг не выдумывает дату окончания");
});

test("onboard without a known cycle length stores known=0", async () => {
  const { api, env, request, writes } = makeEnv({ gender: "female", body: { last_start: "2026-11-01" } });
  await api(request, env, new URL("https://duoplan.test/api/cycle/onboard"));
  const update = writes.find(w => w.sql.includes("cycle_length_known=?"));
  ok(update);
  equal(update.args[2], 0);
});

test("PATCH /api/cycle/profile marks the cycle length as known", async () => {
  const { api, env, request, writes } = makeEnv({ gender: "female", method: "PATCH", body: { avg_cycle_length: 26, avg_period_length: 4 } });
  await api(request, env, new URL("https://duoplan.test/api/cycle/profile"));
  const update = writes.find(w => w.sql.includes("cycle_length_known=1"));
  ok(update, "ручное сохранение профиля должно отмечать значение как известное");
});

// 9. Diary split (этап 4): сгустки, энергия и «симптомов не было» — свои поля;
// эмоции и сгустки больше не коды интенсивности/симптомов.
test("POST /api/cycle/log stores clots, energy and symptoms_clear", async () => {
  const { api, env, request, writes } = makeEnv({
    gender: "female",
    body: { date: "2026-11-01", flow: "heavy", clots: true, energy: "low", symptoms: [], symptoms_clear: false }
  });
  await api(request, env, new URL("https://duoplan.test/api/cycle/log"));
  const insert = writes.find(w => w.sql.includes("INSERT INTO cycle_logs"));
  ok(insert, "запись дня должна сохраниться");
  equal(insert.args[3], 1, "clots=1");          // clots
  equal(insert.args[4], "low", "энергия");       // energy
  equal(insert.args[7], 0, "symptoms_clear=0");  // symptoms_clear
});

test("POST /api/cycle/log rejects unknown energy", async () => {
  const { api, env, request } = makeEnv({ gender: "female", body: { date: "2026-11-01", energy: "energetic" } });
  await rejects(
    api(request, env, new URL("https://duoplan.test/api/cycle/log")),
    err => isHttpError(err, 400, "INVALID_ENERGY")
  );
});

test("POST /api/cycle/log rejects clots as a flow code", async () => {
  const { api, env, request } = makeEnv({ gender: "female", body: { date: "2026-11-01", flow: "clots" } });
  await rejects(
    api(request, env, new URL("https://duoplan.test/api/cycle/log")),
    err => isHttpError(err, 400, "INVALID_FLOW")
  );
});

test("POST /api/cycle/log rejects emotions as symptom codes", async () => {
  const { api, env, request } = makeEnv({ gender: "female", body: { date: "2026-11-01", symptoms: ["happy"] } });
  await rejects(
    api(request, env, new URL("https://duoplan.test/api/cycle/log")),
    err => isHttpError(err, 400, "INVALID_SYMPTOM")
  );
});

// 10. Добивка дневника (этап 4/P1): протекание, боль 0–10 с локализацией,
// влияние на жизнь — валидируются на сервере и сохраняются.
test("POST /api/cycle/log stores leakage, pain, locations and life_impact", async () => {
  const { api, env, request, writes } = makeEnv({
    gender: "female",
    body: {
      date: "2026-11-01", flow: "medium",
      leakage: "night", pain_score: 7, pain_locations: ["lower_abdomen", "lower_back"], life_impact: "limited"
    }
  });
  await api(request, env, new URL("https://duoplan.test/api/cycle/log"));
  const insert = writes.find(w => w.sql.includes("INSERT INTO cycle_logs"));
  ok(insert, "запись дня должна сохраниться");
  equal(insert.args[11], "night", "leakage");
  equal(insert.args[12], 7, "pain_score");
  equal(insert.args[13], '["lower_abdomen","lower_back"]', "pain_locations");
  equal(insert.args[14], "limited", "life_impact");
});

test("POST /api/cycle/log rejects invalid pain_score", async () => {
  for (const pain of [-1, 11, 1.5, "strong"]) {
    const { api, env, request } = makeEnv({ gender: "female", body: { date: "2026-11-01", pain_score: pain } });
    await rejects(
      api(request, env, new URL("https://duoplan.test/api/cycle/log")),
      err => isHttpError(err, 400, "INVALID_PAIN")
    );
  }
});

test("POST /api/cycle/log rejects unknown leakage, impact and pain location", async () => {
  const cases = [
    [{ leakage: "morning" }, "INVALID_LEAKAGE"],
    [{ life_impact: "a_lot" }, "INVALID_LIFE_IMPACT"],
    [{ pain_locations: ["knee"] }, "INVALID_PAIN_LOCATION"]
  ];
  for (const [extra, code] of cases) {
    const { api, env, request } = makeEnv({ gender: "female", body: { date: "2026-11-01", ...extra } });
    await rejects(
      api(request, env, new URL("https://duoplan.test/api/cycle/log")),
      err => isHttpError(err, 400, code)
    );
  }
});

// 11. Этап 6/P2: слизь и факторы дня в /api/cycle/log.
test("POST /api/cycle/log stores mucus and day factors", async () => {
  const { api, env, request, writes } = makeEnv({
    gender: "female",
    body: {
      date: "2026-11-02",
      mucus: { amount: "medium", consistency: "watery", color: "clear", discomfort: true },
      sleep_hours: 7.5, sleep_quality: "good", stress: "high",
      sick: true, travel: false, weight_kg: 62.4
    }
  });
  await api(request, env, new URL("https://duoplan.test/api/cycle/log"));
  const insert = writes.find(w => w.sql.includes("INSERT INTO cycle_logs"));
  ok(insert, "запись дня должна сохраниться");
  equal(insert.args[15], '{"amount":"medium","consistency":"watery","color":"clear","discomfort":true}', "mucus");
  equal(insert.args[16], 7.5, "sleep_hours");
  equal(insert.args[17], "good", "sleep_quality");
  equal(insert.args[18], "high", "stress");
  equal(insert.args[19], 1, "sick");
  equal(insert.args[20], 0, "travel");
  equal(insert.args[21], 62.4, "weight_kg");
});

test("POST /api/cycle/log rejects invalid mucus, sleep, stress and weight", async () => {
  const cases = [
    [{ mucus: { amount: "lots" } }, "INVALID_MUCUS"],
    [{ mucus: { consistency: "slimy" } }, "INVALID_MUCUS"],
    [{ mucus: { color: "pink" } }, "INVALID_MUCUS"],
    [{ sleep_hours: 30 }, "INVALID_SLEEP"],
    [{ sleep_quality: "great" }, "INVALID_SLEEP_QUALITY"],
    [{ stress: "extreme" }, "INVALID_STRESS"],
    [{ weight_kg: 500 }, "INVALID_WEIGHT"]
  ];
  for (const [extra, code] of cases) {
    const { api, env, request } = makeEnv({ gender: "female", body: { date: "2026-11-02", ...extra } });
    await rejects(
      api(request, env, new URL("https://duoplan.test/api/cycle/log")),
      err => isHttpError(err, 400, code)
    );
  }
});

// 12. Этап 6/P2: измерения БТ/ЛГ.
test("POST /api/cycle/measurement stores BBT and validates range", async () => {
  const { api, env, request, writes } = makeEnv({
    gender: "female",
    body: { date: "2026-11-02", kind: "bbt", value: 36.6, unit: "C", time: "07:30" }
  });
  await api(request, env, new URL("https://duoplan.test/api/cycle/measurement"));
  const insert = writes.find(w => w.sql.includes("INSERT INTO cycle_measurements"));
  ok(insert, "измерение должно сохраниться");
  equal(insert.args[3], "bbt", "kind");
  equal(insert.args[4], 36.6, "value");
  equal(insert.args[5], "C", "unit");

  const bad = makeEnv({ gender: "female", body: { date: "2026-11-02", kind: "bbt", value: 50 } });
  await rejects(
    bad.api(bad.request, bad.env, new URL("https://duoplan.test/api/cycle/measurement")),
    err => isHttpError(err, 400, "INVALID_VALUE")
  );
});

test("POST /api/cycle/measurement stores LH result and rejects bad kind/result", async () => {
  const { api, env, request, writes } = makeEnv({
    gender: "female",
    body: { date: "2026-11-02", kind: "lh", result: "positive" }
  });
  await api(request, env, new URL("https://duoplan.test/api/cycle/measurement"));
  const insert = writes.find(w => w.sql.includes("INSERT INTO cycle_measurements"));
  ok(insert);
  equal(insert.args[6], "positive", "result");

  const badKind = makeEnv({ gender: "female", body: { date: "2026-11-02", kind: "weight" } });
  await rejects(
    badKind.api(badKind.request, badKind.env, new URL("https://duoplan.test/api/cycle/measurement")),
    err => isHttpError(err, 400, "INVALID_KIND")
  );
  const badResult = makeEnv({ gender: "female", body: { date: "2026-11-02", kind: "lh", result: "maybe" } });
  await rejects(
    badResult.api(badResult.request, badResult.env, new URL("https://duoplan.test/api/cycle/measurement")),
    err => isHttpError(err, 400, "INVALID_RESULT")
  );
});

test("POST /api/cycle/measurement/delete removes by id", async () => {
  const { api, env, request, writes } = makeEnv({ gender: "female", body: { id: 9 } });
  await api(request, env, new URL("https://duoplan.test/api/cycle/measurement/delete"));
  const del = writes.find(w => w.sql.includes("DELETE FROM cycle_measurements"));
  ok(del, "должен быть DELETE");
  equal(del.args[0], 9, "id");
});

// 13. Этап 6/P2: препараты и факт приёма.
test("POST /api/cycle/med creates a course and validates fields", async () => {
  const { api, env, request, writes } = makeEnv({
    gender: "female",
    body: { name: "Магний B6", category: "supplement", dosage: "1 табл.", form: "tablet", schedule: "1 раз в день", start_date: "2026-11-01", status: "active" }
  });
  await api(request, env, new URL("https://duoplan.test/api/cycle/med"));
  const insert = writes.find(w => w.sql.includes("INSERT INTO cycle_meds"));
  ok(insert, "курс должен сохраниться");
  equal(insert.args[1], "Магний B6", "name");

  const bad = makeEnv({ gender: "female", body: { name: "X", category: "magic", start_date: "2026-11-01" } });
  await rejects(
    bad.api(bad.request, bad.env, new URL("https://duoplan.test/api/cycle/med")),
    err => isHttpError(err, 400, "INVALID_CATEGORY")
  );
  const badDate = makeEnv({ gender: "female", body: { name: "X", start_date: "2999-01-01" } });
  await rejects(
    badDate.api(badDate.request, badDate.env, new URL("https://duoplan.test/api/cycle/med")),
    err => isHttpError(err, 400, "INVALID_DATE")
  );
});

test("POST /api/cycle/med-log records taken/skipped and distinguishes dose", async () => {
  const { api, env, request, writes } = makeEnv({
    gender: "female",
    body: { med_id: 5, date: "2026-11-02", status: "skipped", dose_taken: "0 табл.", note: "забыла" }
  });
  await api(request, env, new URL("https://duoplan.test/api/cycle/med-log"));
  const insert = writes.find(w => w.sql.includes("INSERT INTO cycle_med_logs"));
  ok(insert, "запись приёма должна сохраниться");
  equal(insert.args[0], 5, "med_id");
  equal(insert.args[4], "skipped", "status");
  equal(insert.args[5], "0 табл.", "dose_taken — факт, не назначение");

  const bad = makeEnv({ gender: "female", body: { med_id: 5, date: "2026-11-02", status: "maybe" } });
  await rejects(
    bad.api(bad.request, bad.env, new URL("https://duoplan.test/api/cycle/med-log")),
    err => isHttpError(err, 400, "INVALID_STATUS")
  );
  const noMed = makeEnv({ gender: "female", medExists: false, body: { med_id: 5, date: "2026-11-02", status: "taken" } });
  await rejects(
    noMed.api(noMed.request, noMed.env, new URL("https://duoplan.test/api/cycle/med-log")),
    err => isHttpError(err, 404, "NOT_FOUND")
  );
});

test("POST /api/cycle/med/delete removes course and its logs", async () => {
  const { api, env, request, writes } = makeEnv({ gender: "female", body: { id: 5 } });
  await api(request, env, new URL("https://duoplan.test/api/cycle/med/delete"));
  ok(writes.some(w => w.sql.includes("DELETE FROM cycle_med_logs")), "логи приёма удаляются");
  ok(writes.some(w => w.sql.includes("DELETE FROM cycle_meds")), "курс удаляется");
});

test("POST /api/cycle/delete clears P2 tables too", async () => {
  const { api, env, request, writes } = makeEnv({ gender: "female", body: { confirm: "DELETE" } });
  await api(request, env, new URL("https://duoplan.test/api/cycle/delete"));
  for (const table of ["cycle_med_logs", "cycle_meds", "cycle_measurements"]) {
    ok(writes.some(w => w.sql.includes(`DELETE FROM ${table}`)), `${table} очищается`);
  }
});

// 14. P3: настраиваемое напоминание о дневнике (notify_diary).
test("PATCH /api/cycle/notify accepts diary flag", async () => {
  const { api, env, request, writes } = makeEnv({
    gender: "female",
    body: { diary: true },
    method: "PATCH"
  });
  await api(request, env, new URL("https://duoplan.test/api/cycle/notify"));
  const upd = writes.find(w => w.sql.includes("UPDATE cycle_profiles") && w.sql.includes("notify_diary"));
  ok(upd, "UPDATE должен содержать notify_diary");
  equal(upd.args[0], 1, "notify_diary=1");
});

// 15. История прошлых циклов: previous_periods в onboard и bulk-эндпоинт.
// «Конец не помним» (end_unknown=1) — не открытый период и не выдуманная дата.
test("onboard inserts previous_periods atomically with end_unknown flag", async () => {
  const { api, env, request, writes } = makeEnv({
    gender: "female",
    body: {
      last_start: "2026-11-01",
      previous_periods: [
        { start: "2026-09-03", end: "2026-09-07" },
        { start: "2026-08-06", end_unknown: true },
        { start: "2026-07-09", end: "2026-07-13" }
      ]
    }
  });
  const response = await api(request, env, new URL("https://duoplan.test/api/cycle/onboard"));
  equal(response.data.previous_imported, 3);
  const inserts = writes.filter(w => w.sql.includes("INSERT INTO cycle_periods"));
  // 1 upsert последней + 3 вставки прошлых.
  equal(inserts.length, 4);
  const unknown = inserts.find(w => w.sql.includes("end_unknown") && w.args[1] === "2026-08-06");
  ok(unknown, "запись с неизвестным концом должна вставляться");
  equal(unknown.args[2], null, "end_date остаётся NULL — дата не выдумывается");
  equal(unknown.args[3], 1, "end_unknown=1");
});

test("onboard rejects duplicate start inside previous_periods", async () => {
  const { api, env, request } = makeEnv({
    gender: "female",
    body: {
      last_start: "2026-11-01",
      previous_periods: [
        { start: "2026-09-03", end: "2026-09-07" },
        { start: "2026-09-03", end_unknown: true }
      ]
    }
  });
  await rejects(
    api(request, env, new URL("https://duoplan.test/api/cycle/onboard")),
    err => isHttpError(err, 400, "PERIOD_DUPLICATE")
  );
});

test("onboard rejects open period inside previous_periods", async () => {
  const { api, env, request } = makeEnv({
    gender: "female",
    body: {
      last_start: "2026-11-01",
      previous_periods: [{ start: "2026-09-03" }]
    }
  });
  await rejects(
    api(request, env, new URL("https://duoplan.test/api/cycle/onboard")),
    err => isHttpError(err, 400, "INVALID_PERIOD")
  );
});

test("onboard rejects previous period overlapping last_start", async () => {
  const { api, env, request } = makeEnv({
    gender: "female",
    body: {
      last_start: "2026-11-01",
      previous_periods: [{ start: "2026-10-30", end: "2026-11-02" }]
    }
  });
  // Ошибка внутри пакета — 400 (конфликт с БД был бы 409).
  await rejects(
    api(request, env, new URL("https://duoplan.test/api/cycle/onboard")),
    err => isHttpError(err, 400, "PERIOD_OVERLAP")
  );
});

test("onboard regression: no previous_periods still works", async () => {
  const { api, env, request, writes } = makeEnv({ gender: "female", body: { last_start: "2026-11-01" } });
  const response = await api(request, env, new URL("https://duoplan.test/api/cycle/onboard"));
  equal(response.data.previous_imported, 0);
  const inserts = writes.filter(w => w.sql.includes("INSERT INTO cycle_periods"));
  equal(inserts.length, 1, "только текущий открытый период");
});

test("POST /api/cycle/periods bulk-inserts package and reports counts", async () => {
  const { api, env, request, writes } = makeEnv({
    gender: "female",
    body: {
      periods: [
        { start: "2026-08-01", end: "2026-08-05" },
        { start: "2026-09-01", end_unknown: true },
        { start: "2026-10-01", end: "2026-10-04" }
      ]
    }
  });
  const response = await api(request, env, new URL("https://duoplan.test/api/cycle/periods"));
  equal(response.data.periods_imported, 3);
  equal(response.data.periods_skipped, 0);
  const inserts = writes.filter(w => w.sql.includes("INSERT INTO cycle_periods"));
  equal(inserts.length, 3);
  ok(inserts.every(w => w.sql.includes("ON CONFLICT(tg_id,start_date) DO NOTHING")), "bulk не перезаписывает существующие");
});

test("POST /api/cycle/periods rejects invalid package atomically", async () => {
  const cases = [
    [{ periods: [{ start: "2999-01-01", end_unknown: true }] }, "INVALID_DATE"],
    [{ periods: [{ start: "2026-08-01" }] }, "INVALID_PERIOD"],
    [{ periods: [
      { start: "2026-08-01", end: "2026-08-05" },
      { start: "2026-08-03", end_unknown: true }
    ] }, "PERIOD_OVERLAP"],
    [{ periods: [{ start: "2026-08-01", end: "2026-08-20" }] }, "INVALID_PERIOD"]
  ];
  for (const [body, code] of cases) {
    const { api, env, request, writes } = makeEnv({ gender: "female", body });
    // Ошибки внутри пакета — 400; 409 остаётся для конфликта с БД.
    await rejects(
      api(request, env, new URL("https://duoplan.test/api/cycle/periods")),
      err => isHttpError(err, 400, code)
    );
    equal(writes.filter(w => w.sql.includes("INSERT INTO cycle_periods")).length, 0, "при ошибке ничего не пишется");
  }
});

test("POST /api/cycle/periods rejects overlap with existing period", async () => {
  const { api, env, request } = makeEnv({
    gender: "female",
    body: { periods: [{ start: "2026-11-03", end: "2026-11-06" }] },
    periods: [{ id: 1, start_date: "2026-11-01", end_date: "2026-11-05", end_unknown: 0 }]
  });
  await rejects(
    api(request, env, new URL("https://duoplan.test/api/cycle/periods")),
    err => isHttpError(err, 409, "PERIOD_OVERLAP")
  );
});

test("end_unknown historical period does not block a new open period", async () => {
  const { api, env, request } = makeEnv({
    gender: "female",
    method: "POST",
    body: { start: "2026-11-01" },
    periods: [{ id: 1, start_date: "2026-09-01", end_date: null, end_unknown: 1 }]
  });
  // Раньше NULL-end считался открытым → 409 «второй открытый период».
  // Теперь end_unknown=1 — историческая запись, новый открытый разрешён.
  await api(request, env, new URL("https://duoplan.test/api/cycle/period"));
});

test("end_unknown historical period does not overlap later closed period", async () => {
  const { api, env, request } = makeEnv({
    gender: "female",
    method: "POST",
    body: { start: "2026-11-01", end: "2026-11-05" },
    periods: [{ id: 1, start_date: "2026-09-01", end_date: null, end_unknown: 1 }]
  });
  await api(request, env, new URL("https://duoplan.test/api/cycle/period"));
});

// 16. P2: конфликт прошлого периода с уже существующей записью не блокирует
// онбординг — он пропускается и считается, а не роняет весь пакет.
test("onboard skips previous period conflicting with existing data", async () => {
  const { api, env, request, writes } = makeEnv({
    gender: "female",
    body: {
      last_start: "2026-11-01",
      previous_periods: [
        { start: "2026-08-01", end: "2026-08-05" },
        { start: "2026-09-10", end: "2026-09-14" } // пересекается с существующим
      ]
    },
    periods: [{ id: 9, start_date: "2026-09-12", end_date: "2026-09-16", end_unknown: 0 }]
  });
  const response = await api(request, env, new URL("https://duoplan.test/api/cycle/onboard"));
  // Конфликтующий пропущен, чистый — вставлен (mock batch: changes=1 на stmt).
  equal(response.data.previous_imported, 1);
  equal(response.data.previous_skipped, 1);
  const inserts = writes.filter(w => w.sql.includes("INSERT INTO cycle_periods"));
  // upsert последней + 1 kept previous; конфликтующий не доходит до batch.
  ok(inserts.every(w => w.args[1] !== "2026-09-10"), "конфликтующий период не пишется");
});

// ---------------------------------------------------------------------------
// Партнёрский вид Фло (cycleViewForPartner): категориальный allowlist —
// календарь (после подтверждения), секс, настроение, качество сна и БТ —
// и ничего лишнего из дневника.
// ---------------------------------------------------------------------------
const buildPartnerView = new Function(
  [
    extractLine("const CYCLE_LEVELS"),
    extractLine("const CYCLE_SHARE_CATEGORIES"),
    extractLine("const CYCLE_SLEEP_QUALITY"),
    extractBraced("function cyclePhaseTip"),
    extractBraced("function cycleShareCategories"),
    extractBraced("function cycleViewForPartner"),
    "return cycleViewForPartner;"
  ].join("\n")
);

const PARTNER_STATE = {
  today: "2026-11-13",
  disclaimer: "Прогноз приблизительный",
  forecast: {
    empty: false, phase: "follicular", cycle_day: 10, next_period_in: 18,
    delay_days: 0, ovulation_in: 6, irregular: false,
    fertile_start: "2026-11-15", fertile_end: "2026-11-19", ovulation_date: "2026-11-17",
    next_period_start: "2026-11-28", next_period_end: "2026-12-02",
    based_on: "history", quality: "full", usable_cycles: 5
  },
  periods: Array.from({ length: 8 }, (_, i) => ({
    start_date: `2026-0${(i % 9) + 1}-0${(i % 8) + 1}`, end_date: "2026-01-05", end_unknown: 0
  })),
  logs: [{
    date: "2026-11-12", sex: "protected", sex_count: 2, mood: "calm",
    sleep_quality: "good", flow: "medium", symptoms: ["cramps"], note: "секрет"
  }, {
    date: "2026-11-10", sex: "none", sex_count: 0, mood: null, sleep_quality: "ok",
    flow: null, symptoms: [], note: ""
  }],
  measurements: [
    { date: "2026-11-12", time: "07:30", kind: "bbt", value: 36.6, unit: "C" },
    { date: "2026-11-11", time: "08:00", kind: "lh", value: 25, unit: null },
    { date: "2026-11-10", time: null, kind: "bbt", value: null, unit: "C" }
  ]
};

const CONFIRMED_ALL = { enabled: true, confirmed: true, categories: { sex: true, mood: true, sleep: true, bbt: true } };
const CALENDAR_ONLY = { enabled: true, confirmed: true, categories: { sex: false, mood: false, sleep: false, bbt: false } };
const UNCONFIRMED = { enabled: true, confirmed: false, categories: { sex: true, mood: true, sleep: true, bbt: true } };

test("partner view: days expose only sex/mood/sleep, never diary fields", () => {
  const view = buildPartnerView()(PARTNER_STATE, CONFIRMED_ALL);
  ok(view.shared === true);
  equal(view.today, "2026-11-13");
  deepStrictEqual(view.days, [
    { date: "2026-11-12", sex: "protected", sex_count: 2, mood: "calm", sleep: "good" },
    { date: "2026-11-10", sex: "none", sex_count: 0, sleep: "ok" }
  ]);
  // Ни одно разрешённое поле не должно протаскивать дневник.
  for (const d of view.days) {
    ok(!("flow" in d) && !("symptoms" in d) && !("note" in d) && !("sleep_quality" in d), "дневник не утекает");
  }
});

test("partner view: bbt contains only bbt measurements with value", () => {
  const view = buildPartnerView()(PARTNER_STATE, CONFIRMED_ALL);
  deepStrictEqual(view.bbt, [{ date: "2026-11-12", time: "07:30", value: 36.6, unit: "C" }]);
});

test("partner view: calendar_periods covers full history, periods stays short", () => {
  const view = buildPartnerView()(PARTNER_STATE, CALENDAR_ONLY);
  equal(view.periods.length, 6);
  equal(view.calendar_periods.length, 8);
  ok(view.days === undefined && view.bbt === undefined);
});

test("partner view: unconfirmed share keeps day marks closed", () => {
  const view = buildPartnerView()(PARTNER_STATE, UNCONFIRMED);
  ok(view.days === undefined && view.bbt === undefined && view.calendar_periods === undefined);
  ok(view.confirmed === false);
});

test("partner view: forecast carries fertile/ovulation windows for the calendar", () => {
  const view = buildPartnerView()(PARTNER_STATE, CONFIRMED_ALL);
  equal(view.forecast.fertile_start, "2026-11-15");
  equal(view.forecast.fertile_end, "2026-11-19");
  equal(view.forecast.ovulation_date, "2026-11-17");
  equal(view.forecast.next_period_start, "2026-11-28");
  equal(view.forecast.quality, "full");
  ok(view.forecast_disclaimer.length > 0);
});

// ---------------------------------------------------------------------------
// Переработка «Фло» (P0/P1): категории шеринга, конфликт symptoms_clear,
// единый предел длительности периода, дополнительные сведения о кровотечении.
// ---------------------------------------------------------------------------

test("PATCH /api/cycle/share validates categories are booleans", async () => {
  const { api, env, request } = makeEnv({
    gender: "female", method: "PATCH",
    body: { enabled: true, categories: { sex: "да" } }
  });
  await rejects(
    api(request, env, new URL("https://duoplan.test/api/cycle/share")),
    err => isHttpError(err, 400, "INVALID_SHARE")
  );
});

test("PATCH /api/cycle/share rejects unknown shape of categories", async () => {
  const { api, env, request } = makeEnv({
    gender: "female", method: "PATCH",
    body: { enabled: true, categories: ["sex"] }
  });
  await rejects(
    api(request, env, new URL("https://duoplan.test/api/cycle/share")),
    err => isHttpError(err, 400, "INVALID_SHARE")
  );
});

test("PATCH /api/cycle/share persists categories and confirmation", async () => {
  const { api, env, request, writes } = makeEnv({
    gender: "female", method: "PATCH",
    body: { enabled: true, categories: { sex: true, bbt: false }, confirmed: true }
  });
  const response = await api(request, env, new URL("https://duoplan.test/api/cycle/share"));
  ok(response.status === 200, "маршрут отвечает состоянием");
  const update = writes.find(w => w.sql.includes("UPDATE cycle_profiles SET"));
  ok(update, "запись в cycle_profiles выполняется");
  ok(update.sql.includes("share_enabled=?"), "главный выключатель сохраняется");
  ok(update.sql.includes("share_sex=?"), "категория секс сохраняется");
  ok(update.sql.includes("share_confirmed=?"), "подтверждение состава сохраняется");
});

test("PATCH /api/cycle/share master off does not touch categories", async () => {
  const { api, env, request, writes } = makeEnv({
    gender: "female", method: "PATCH", body: { enabled: false }
  });
  await api(request, env, new URL("https://duoplan.test/api/cycle/share"));
  const update = writes.find(w => w.sql.includes("UPDATE cycle_profiles SET"));
  ok(update.sql.includes("share_enabled=?"));
  ok(!update.sql.includes("share_sex=?"), "выключение не переписывает категории");
  ok(!update.sql.includes("share_confirmed=?"));
});

test("POST /api/cycle/log rejects symptoms_clear together with symptoms (9.2)", async () => {
  const { api, env, request } = makeEnv({
    gender: "female", method: "POST",
    body: { date: "2026-11-01", symptoms: ["cramps"], symptoms_clear: true }
  });
  await rejects(
    api(request, env, new URL("https://duoplan.test/api/cycle/log")),
    err => isHttpError(err, 400, "INVALID_SYMPTOMS_CONFLICT")
  );
});

test("POST /api/cycle/log accepts explicit symptoms_clear without symptoms", async () => {
  const { api, env, request, writes } = makeEnv({
    gender: "female", method: "POST",
    body: { date: "2026-11-01", symptoms: [], symptoms_clear: true }
  });
  await api(request, env, new URL("https://duoplan.test/api/cycle/log"));
  const insert = writes.find(w => w.sql.includes("INSERT INTO cycle_logs"));
  ok(insert, "дневник сохраняется");
  ok(insert.args.includes("[]") || insert.args.some(a => String(a) === "[]"), "пустой список симптомов сохраняется");
});

test("POST /api/cycle/log accepts explicit sex=none without count (9.4)", async () => {
  const { api, env, request, writes } = makeEnv({
    gender: "female", method: "POST",
    body: { date: "2026-11-01", sex: "none" }
  });
  await api(request, env, new URL("https://duoplan.test/api/cycle/log"));
  const insert = writes.find(w => w.sql.includes("INSERT INTO cycle_logs"));
  ok(insert);
  const sexIdx = insert.sql.split(",").findIndex(col => col.trim() === "sex");
  equal(insert.args[sexIdx], "none");
});

test("POST /api/cycle/log validates bleeding_details shape (7)", async () => {
  const { api, env, request } = makeEnv({
    gender: "female", method: "POST",
    body: { date: "2026-11-01", bleeding_details: { changes_per_day: 99 } }
  });
  await rejects(
    api(request, env, new URL("https://duoplan.test/api/cycle/log")),
    err => isHttpError(err, 400, "INVALID_BLEEDING")
  );
});

test("POST /api/cycle/log persists bleeding_details", async () => {
  const { api, env, request, writes } = makeEnv({
    gender: "female", method: "POST",
    body: { date: "2026-11-01", bleeding_details: { changes_per_day: 4, saturation: "high", night_change: true } }
  });
  await api(request, env, new URL("https://duoplan.test/api/cycle/log"));
  const insert = writes.find(w => w.sql.includes("INSERT INTO cycle_logs"));
  ok(insert.sql.includes("bleeding_details"), "колонка bleeding_details сохраняется");
  ok(JSON.stringify(insert.args).includes("saturation"), "значения сохраняются");
});

test("POST /api/cycle/period rejects longer than 14 days (7)", async () => {
  const { api, env, request } = makeEnv({
    gender: "female", method: "POST",
    body: { start: "2026-10-01", end: "2026-10-20" }
  });
  await rejects(
    api(request, env, new URL("https://duoplan.test/api/cycle/period")),
    err => isHttpError(err, 400, "INVALID_PERIOD")
  );
});

test("PATCH /api/cycle/period rejects longer than 14 days (7)", async () => {
  const { api, env, request } = makeEnv({
    gender: "female", method: "PATCH",
    body: { original_start: "2026-10-01", start: "2026-10-01", end: "2026-10-20" }
  });
  await rejects(
    api(request, env, new URL("https://duoplan.test/api/cycle/period")),
    err => isHttpError(err, 400, "INVALID_PERIOD")
  );
});

test("PATCH /api/cycle/context validates keys and persists flags (5.1)", async () => {
  const { api, env, request, writes } = makeEnv({
    gender: "female", method: "PATCH",
    body: { context: { pregnancy: true, bogus_key: true, hormonal_contraception: false } }
  });
  await api(request, env, new URL("https://duoplan.test/api/cycle/context"));
  const update = writes.find(w => w.sql.includes("UPDATE cycle_profiles SET context=?"));
  ok(update, "контекст сохраняется");
  deepStrictEqual(JSON.parse(update.args[0]), { pregnancy: true }, "неизвестные ключи отбрасываются, false не сохраняется");
});

test("GET /api/cycle/partner: полный allowlist-ответ по HTTP, без запрещённых полей (E)", async () => {
  const { api, env, request } = makeEnv({
    gender: "male", method: "GET",
    membershipPair: { user_a: 1, user_b: 777 },
    shareRow: {
      share_enabled: 1, share_level: "phases",
      share_sex: 1, share_mood: 1, share_sleep: 1, share_bbt: 1, share_confirmed: 1,
      gender: "female"
    },
    stateMock: async () => ({
      today: "2026-11-13",
      disclaimer: "d",
      forecast: {
        empty: false, phase: "follicular", cycle_day: 10, next_period_in: 18, delay_days: 0,
        ovulation_in: 6, irregular: false, ovulation_source: "calendar",
        fertile_start: "2026-11-15", fertile_end: "2026-11-19", ovulation_date: "2026-11-17",
        next_period_start: "2026-11-28", next_period_end: "2026-12-02",
        based_on: "history", quality: "full", usable_cycles: 5, data_stale: false
      },
      periods: [{ start_date: "2026-10-27", end_date: "2026-10-31", end_unknown: 0 }],
      logs: [{
        date: "2026-11-12", flow: "light", symptoms: ["cramps"], note: "секрет",
        sex: "protected", sex_count: 2, mood: "calm", sleep_quality: "good",
        weight_kg: 64.4, stress: "high", pain_score: 5
      }],
      meds: [{ id: 1, name: "Секретный препарат" }],
      med_logs: [{ med_id: 1, date: "2026-11-12", status: "taken" }],
      measurements: [
        { date: "2026-11-12", time: "07:30", kind: "bbt", value: 36.6, unit: "C" },
        { date: "2026-11-12", kind: "lh", result: "positive" }
      ]
    })
  });
  const response = await api(request, env, new URL("https://duoplan.test/api/cycle/partner"));
  const json = JSON.stringify(response.data);
  // Разрешённое присутствует.
  ok(response.data.shared === true);
  ok(response.data.days.some(d => d.sex === "protected" && d.sex_count === 2 && d.mood === "calm" && d.sleep === "good"));
  ok(response.data.bbt.length === 1 && response.data.periods.length === 1);
  ok(response.data.forecast.quality === "full");
  // Запрещённое отсутствует даже при прямом обращении к API.
  for (const bad of ["секрет", "cramps", "light", "Секретный препарат", "taken", "positive", "weight", "stress", "pain_score", "meds", "med_logs"]) {
    equal(json.includes(bad), false, `запрещённое поле «${bad}» утекло через /api/cycle/partner`);
  }
});

test("GET /api/cycle/partner: неподтверждённый шеринг не отдаёт дневниковые данные", async () => {
  const { api, env, request } = makeEnv({
    gender: "male", method: "GET",
    membershipPair: { user_a: 1, user_b: 777 },
    shareRow: {
      share_enabled: 1, share_level: "full",
      share_sex: 1, share_mood: 1, share_sleep: 1, share_bbt: 1, share_confirmed: 0,
      gender: "female"
    },
    stateMock: async () => ({
      today: "2026-11-13",
      disclaimer: "d",
      forecast: { empty: true },
      periods: [{ start_date: "2026-10-27", end_date: "2026-10-31", end_unknown: 0 }],
      logs: [{ date: "2026-11-12", note: "секрет", sex: "none" }],
      meds: [], med_logs: [], measurements: []
    })
  });
  const response = await api(request, env, new URL("https://duoplan.test/api/cycle/partner"));
  const json = JSON.stringify(response.data);
  ok(response.data.shared === true && response.data.confirmed === false);
  ok("periods" in response.data === false && "days" in response.data === false);
  equal(json.includes("секрет"), false);
  equal(json.includes("2026-10-27"), false);
});
