// Проверки приватности партнёрского ответа Фло (переработка P0, план 18A/18E).
// Проверяется ПОЛНЫЙ состав ответа для каждого состояния общего доступа:
// не только отсутствие запрещённых полей, но и наличие всех разрешённых.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const source = readFileSync(new URL("../worker.js", import.meta.url), "utf8");
const block = source.slice(source.indexOf("// ---- Фло"), source.indexOf("async function ensureSchema(env)"));
const { cycleViewForPartner, cycleShareCategories, cycleExportPayload, cycleProfileContext, cycleOnboardPlan } =
  new Function("DEFAULT_TZ", `${block}; return { cycleViewForPartner, cycleShareCategories, cycleExportPayload, cycleProfileContext, cycleOnboardPlan };`)("Europe/Moscow");

const profile = { avg_cycle_length: 28, avg_period_length: 5 };

// Прогноз строится тем же cycleForecast из блока worker.js.
const { cycleForecast: forecastFn } = new Function("DEFAULT_TZ", `${block}; return { cycleForecast };`)("Europe/Moscow");
const rawPeriods = [
  { start_date: "2026-11-10", end_date: null, end_unknown: 0 },
  { start_date: "2026-10-12", end_date: "2026-10-16", end_unknown: 0 },
  { start_date: "2026-09-14", end_date: "2026-09-18", end_unknown: 0 }
];

// Насыщенное состояние: в дневнике есть всё, что вообще запрещено передавать.
const state = {
  today: "2026-11-13",
  disclaimer: "Прогноз приблизительный",
  forecast: forecastFn(rawPeriods.map(p => ({ start_date: p.start_date, end_date: p.end_date })), profile, "2026-11-13"),
  periods: rawPeriods,
  logs: [
    {
      date: "2026-11-12", flow: "light", clots: true, energy: "low", mood: "anxious",
      symptoms: ["cramps", "headache"], symptoms_clear: false, note: "личная заметка",
      sex: "protected", sex_count: 2, leakage: "night", pain_score: 7,
      pain_locations: ["lower_abdomen"], life_impact: "limited", mucus: { amount: "low" },
      sleep_hours: 5.5, sleep_quality: "poor", stress: "high", sick: true, travel: true, weight_kg: 64.2
    },
    { date: "2026-11-11", sex: "none", mood: "calm", sleep_quality: "good" }
  ],
  meds: [{ id: 1, name: "Секретный препарат" }],
  med_logs: [{ med_id: 1, date: "2026-11-12", status: "taken" }],
  measurements: [
    { date: "2026-11-12", time: "07:30", kind: "bbt", value: 36.6, unit: "C" },
    { date: "2026-11-12", time: "08:00", kind: "lh", result: "positive" }
  ]
};

const share = (enabled, confirmed, categories) => ({ enabled, confirmed, categories: categories ?? {} });
const allCats = { sex: true, mood: true, sleep: true, bbt: true };
const noCats = { sex: false, mood: false, sleep: false, bbt: false };

// Запрещённые поля: ни при каком состоянии не должны появляться в ответе.
// Значения дневниковых категорий (mood/sex/sleep/БТ) проверяются отдельно —
// в тестах своей категории они легитимны.
const FORBIDDEN_SNIPPETS = [
  "личная заметка", // note
  "cramps", "headache", // симптомы
  "Секретный препарат", // препараты
  "taken", // факт приёма
  "positive", // ЛГ
  "weight", "stress", "leakage", "pain_score", "mucus", "sleep_hours", "clots",
  "flow", "symptoms", "energy", "travel", "sick", "meds", "med_logs"
];

function assertNoForbidden(json) {
  for (const snippet of FORBIDDEN_SNIPPETS) {
    assert.equal(json.includes(snippet), false, `запрещённое поле «${snippet}» утекло в партнёрский ответ`);
  }
}

test("A1: выключенный шеринг — shared:false, никакого содержимого", () => {
  const v = cycleViewForPartner(state, share(false, true, allCats));
  assert.deepEqual(v, { shared: false });
});

test("A2: включённый, но не подтверждённый — только календарная оценка", () => {
  const v = cycleViewForPartner(state, share(true, false, allCats));
  const json = JSON.stringify(v);
  assert.equal(v.shared, true);
  assert.equal(v.confirmed, false);
  // Есть: фаза, день цикла, дни до события, подсказка, оговорки.
  assert.equal(v.forecast.empty, false);
  assert.equal(typeof v.forecast.cycle_day, "number");
  assert.equal(typeof v.tip, "string");
  assert.ok(v.forecast_disclaimer.length > 0);
  // Нет: дат месячных, дневника, категорийных отметок.
  assert.equal("periods" in v, false);
  assert.equal("days" in v, false);
  assert.equal("bbt" in v, false);
  assert.equal("next_period_start" in v.forecast, false);
  assertNoForbidden(json);
});

test("A3: календарь без дневниковых категорий — даты есть, отметок нет", () => {
  const v = cycleViewForPartner(state, share(true, true, noCats));
  const json = JSON.stringify(v);
  assert.equal(v.confirmed, true);
  assert.equal(v.periods.length, 3);
  assert.equal(v.calendar_periods.length, 3);
  assert.equal(v.last_period_start, "2026-11-10");
  assert.equal(v.forecast.next_period_start, "2026-12-09");
  assert.equal("days" in v, false);
  assert.equal("bbt" in v, false);
  assertNoForbidden(json);
  assert.equal(json.includes("2026-09-14"), true, "история месячных входит в календарную категорию");
});

test("A4: только секс — факты и явное «без секса», настроения и сна нет", () => {
  const v = cycleViewForPartner(state, share(true, true, { sex: true, mood: false, sleep: false, bbt: false }));
  const json = JSON.stringify(v);
  assert.deepEqual(v.days, [
    { date: "2026-11-12", sex: "protected", sex_count: 2 },
    { date: "2026-11-11", sex: "none", sex_count: 0 }
  ]);
  assert.equal(json.includes("anxious"), false);
  assert.equal(json.includes("good"), false, "сон не входит без своей категории");
  assertNoForbidden(json);
});

test("A5: только настроение", () => {
  const v = cycleViewForPartner(state, share(true, true, { sex: false, mood: true, sleep: false, bbt: false }));
  const json = JSON.stringify(v);
  assert.deepEqual(v.days, [
    { date: "2026-11-12", mood: "anxious" },
    { date: "2026-11-11", mood: "calm" }
  ]);
  assert.equal(json.includes("protected"), false);
  assert.equal(json.includes("poor"), false);
  assertNoForbidden(json);
});

test("A6: только сон — строго три значения, часы не передаются", () => {
  const v = cycleViewForPartner(state, share(true, true, { sex: false, mood: false, sleep: true, bbt: false }));
  const json = JSON.stringify(v);
  assert.deepEqual(v.days, [
    { date: "2026-11-12", sleep: "poor" },
    { date: "2026-11-11", sleep: "good" }
  ]);
  assert.equal(json.includes("5.5"), false, "длительность сна не передаётся");
  assert.equal(json.includes("protected"), false);
  assertNoForbidden(json);
});

test("A7: только температура — БТ с единицами и временем, ЛГ закрыт", () => {
  const v = cycleViewForPartner(state, share(true, true, { sex: false, mood: false, sleep: false, bbt: true }));
  const json = JSON.stringify(v);
  assert.deepEqual(v.bbt, [{ date: "2026-11-12", time: "07:30", value: 36.6, unit: "C" }]);
  assert.equal(json.includes("positive"), false);
  assert.equal(json.includes("lh"), false);
  assertNoForbidden(json);
});

test("A8: все категории — каждая передаётся ровно своим набором полей", () => {
  const v = cycleViewForPartner(state, share(true, true, allCats));
  const json = JSON.stringify(v);
  assert.equal(v.days.length, 2);
  assert.deepEqual(v.days[0], { date: "2026-11-12", sex: "protected", sex_count: 2, mood: "anxious", sleep: "poor" });
  assert.deepEqual(v.bbt, [{ date: "2026-11-12", time: "07:30", value: 36.6, unit: "C" }]);
  assert.equal(json.includes("личная заметка"), false);
  assertNoForbidden(json);
});

test("A9: выключение категории прекращает передачу именно её", () => {
  const full = cycleViewForPartner(state, share(true, true, allCats));
  const noSex = cycleViewForPartner(state, share(true, true, { sex: false, mood: true, sleep: true, bbt: true }));
  assert.equal(noSex.days.some(d => "sex" in d), false, "секс исчезает из ответа");
  assert.equal(noSex.days.length, full.days.length, "остальные категории на месте");
  assert.equal(JSON.stringify(noSex).includes("protected"), false);
});

test("A10: отзыв доступа — данные не отдаются (кэш не в ответе)", () => {
  const v = cycleViewForPartner(state, share(false, false, noCats));
  assert.deepEqual(v, { shared: false });
  assert.equal(JSON.stringify(v).includes("2026"), false);
});

test("E1: сон нормализуется строго к good/ok/poor — прочие значения молча не проходят", () => {
  const weird = {
    ...state,
    logs: [{ date: "2026-11-12", sleep_quality: "deep" }, { date: "2026-11-11", sleep_quality: "good" }]
  };
  const v = cycleViewForPartner(weird, share(true, true, { sex: false, mood: false, sleep: true, bbt: false }));
  assert.deepEqual(v.days, [{ date: "2026-11-11", sleep: "good" }]);
});

test("E2: легаси-числовые категории (1/0) из БД разбираются как булевы", () => {
  assert.deepEqual(cycleShareCategories({ sex: 1, mood: 0, sleep: 1, bbt: "true" }), {
    sex: true, mood: false, sleep: true, bbt: false
  });
  assert.deepEqual(cycleShareCategories(null), { sex: false, mood: false, sleep: false, bbt: false });
  // Неизвестный ключ-«паразит» игнорируется: в ответ он попасть не может.
  const cats = cycleShareCategories({ sex: true, everything: true, root: 1 });
  assert.equal("everything" in cats, false);
  assert.equal("root" in cats, false);
});

test("E3: подсказка фазы не содержит стереотипов о самочувствии", () => {
  const v = cycleViewForPartner(state, share(true, true, allCats));
  const tip = String(v.tip || "");
  assert.equal(/усталост|раздражит|энергии больше|перепады настроения|утомлен/i.test(tip), false, "стереотипная формулировка в подсказке");
});

test("A11: экспорт всегда принадлежит владелице и содержит полный журнал", () => {
  const payload = cycleExportPayload({
    profile,
    share: { enabled: true, level: "phases", categories: allCats, confirmed: true },
    periods: state.periods,
    logs: state.logs,
    meds: state.meds,
    med_logs: state.med_logs,
    measurements: state.measurements,
    context: { context: { hormonal_contraception: true } }
  }, "t");
  const json = JSON.stringify(payload);
  // Экспорт — для самой владелицы: здесь личные данные допустимы.
  assert.equal(json.includes("личная заметка"), true);
  assert.equal(json.includes("Секретный препарат"), true);
  assert.equal(payload.profile.share_categories.sex, true);
  assert.equal(payload.profile.share_confirmed, true);
  // Категории в экспорте — только булевы флаги, «паразитов» нет.
  assert.deepEqual(Object.keys(payload.profile.share_categories).sort(), ["bbt", "mood", "sex", "sleep"]);
});

test("A12: онбординг с категориями подтверждает состав только при включённом шеринге", () => {
  const plan = cycleOnboardPlan({
    last_start: "2026-11-05",
    share_enabled: true,
    share_categories: { sex: true, mood: true }
  }, "2026-11-12");
  assert.equal(plan.shareEnabled, true);
  assert.equal(plan.shareConfirmed, true);
  assert.deepEqual(plan.shareCategories, { sex: 1, mood: 1 });

  const planOff = cycleOnboardPlan({
    last_start: "2026-11-05",
    share_enabled: false,
    share_categories: { sex: true }
  }, "2026-11-12");
  assert.equal(planOff.shareEnabled, false);
  assert.equal(planOff.shareConfirmed, false);

  const bad = cycleOnboardPlan({
    last_start: "2026-11-05",
    share_enabled: true,
    share_categories: { sex: "да" }
  }, "2026-11-12");
  assert.equal(bad.error, "INVALID_SHARE");
});
