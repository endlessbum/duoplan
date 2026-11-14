import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

// Берём блок Фло из worker.js и исполняем его отдельно: прогноз должен
// совпадать с тем, что видит владелица, без поднятого Worker'а.
const source = readFileSync(new URL("../worker.js", import.meta.url), "utf8");
const block = source.slice(source.indexOf("// ---- Фло"), source.indexOf("async function ensureSchema(env)"));
const { cycleForecast, cycleDayNum, cycleViewForPartner, cycleExportPayload, cycleOnboardPlan, cycleReminderKinds, cycleStats, cyclePhaseTip, cycleInsights } = new Function("DEFAULT_TZ", `${block}; return { cycleForecast, cycleDayNum, cycleViewForPartner, cycleExportPayload, cycleOnboardPlan, cycleReminderKinds, cycleStats, cyclePhaseTip, cycleInsights };`)("Europe/Moscow");
const profile = { avg_cycle_length: 28, avg_period_length: 5 };

test("без данных прогноз пустой, профиль используется как есть", () => {
  const f = cycleForecast([], profile, "2026-11-12");
  assert.equal(f.empty, true);
  assert.equal(f.avg_cycle_length, 28);
});

test("один старт: прогноз от профиля, овуляция за 14 дней до следующих", () => {
  const f = cycleForecast([{ start_date: "2026-10-20", end_date: "2026-10-24" }], profile, "2026-11-12");
  assert.equal(f.next_period_start, "2026-11-17");
  assert.equal(f.ovulation_date, "2026-11-03");
  assert.equal(f.phase, "luteal");
});

test("регулярные циклы усредняются и не помечаются нерегулярными", () => {
  const periods = [
    { start_date: "2026-08-01", end_date: "2026-08-05" },
    { start_date: "2026-08-30", end_date: "2026-09-03" },
    { start_date: "2026-09-27", end_date: "2026-10-01" },
    { start_date: "2026-10-25", end_date: "2026-10-29" },
  ];
  const f = cycleForecast(periods, profile, "2026-10-30");
  assert.equal(f.avg_cycle_length, 28);
  assert.equal(f.irregular, false);
  assert.equal(f.next_period_start, "2026-11-22");
});

test("разброс циклов больше недели помечается как нерегулярный", () => {
  const periods = [
    { start_date: "2026-08-01", end_date: "2026-08-05" },
    { start_date: "2026-08-25", end_date: "2026-08-29" },
    { start_date: "2026-10-01", end_date: "2026-10-05" },
  ];
  assert.equal(cycleForecast(periods, profile, "2026-10-06").irregular, true);
});

test("открытые месячные — фаза менструации; после прогноза — задержка", () => {
  const open = [{ start_date: "2026-11-10", end_date: null }];
  assert.equal(cycleForecast(open, profile, "2026-11-11").phase, "menstruation");
  const late = [{ start_date: "2026-10-01", end_date: "2026-10-05" }];
  const f = cycleForecast(late, profile, "2026-10-40".replace("40", "31"));
  assert.equal(f.phase, "delay");
  assert.equal(f.delay_days, 2);
});

test("незакрытые месячные дольше 14 дней остаются менструацией, а не задержкой", () => {
  const open = [{ start_date: "2026-10-20", end_date: null }];
  assert.equal(cycleForecast(open, profile, "2026-11-13").phase, "menstruation");
  // Даже после расчётной даты следующих месячных: кровотечение и задержка
  // не показываются одновременно (аудит 3.1.E).
  assert.equal(cycleForecast(open, profile, "2026-11-20").phase, "menstruation");
});

test("исторический период с неизвестным концом не считается открытым", () => {
  // end_date=NULL + end_unknown=1 — «конец не помним», а не «менструация идёт».
  const hist = [{ start_date: "2026-09-01", end_date: null, end_unknown: true }];
  const f = cycleForecast(hist, profile, "2026-11-12");
  assert.notEqual(f.phase, "menstruation");
});

test("прошлые периоды дают интервалы: 3 старта → based_on=history", () => {
  const periods = [
    { start_date: "2026-08-01", end_date: "2026-08-05" },
    { start_date: "2026-08-30", end_date: null, end_unknown: true },
    { start_date: "2026-09-28", end_date: "2026-10-02" },
  ];
  const f = cycleForecast(periods, profile, "2026-10-10");
  assert.equal(f.based_on, "history");
  assert.equal(f.usable_cycles, 2);
});

test("необычный интервал сохраняется, но не входит в usable", () => {
  const periods = [
    { start_date: "2026-01-01", end_date: "2026-01-05" },
    { start_date: "2026-03-01", end_date: "2026-03-05" }, // 59 дней — usable (<60? ровно 59)
    { start_date: "2026-08-01", end_date: "2026-08-05" }, // 153 дня — unusual
    { start_date: "2026-08-30", end_date: "2026-09-03" },
    { start_date: "2026-09-27", end_date: "2026-10-01" },
  ];
  const f = cycleForecast(periods, profile, "2026-10-05");
  assert.equal(f.based_on, "history");
  assert.equal(f.usable_cycles, 3);
  assert.equal(f.unusual_intervals, 1, "необычный интервал виден, но не участвует в среднем");
});

test("дни считаются по календарю без сдвига часовых поясов", () => {
  assert.equal(cycleDayNum("2026-03-01") - cycleDayNum("2026-02-28"), 1);
});

// Приватность: партнёр получает строго согласованные категории (allowlist).
const shared = {
  today: "2026-11-12",
  periods: [{ start_date: "2026-11-10", end_date: null }, { start_date: "2026-10-12", end_date: "2026-10-16" }],
  logs: [
    { date: "2026-11-12", flow: "light", symptoms: ["cramps"], note: "секретная заметка", sex: "protected", sex_count: 2, mood: "calm", sleep_quality: "good", stress: "high", weight_kg: 65.5, sick: false },
    { date: "2026-11-11", sex: "none", mood: "sad", sleep_quality: "poor" },
  ],
  measurements: [
    { kind: "bbt", date: "2026-11-10", time: "07:30", value: 36.6, unit: "C" },
    { kind: "lh", date: "2026-11-10", result: "positive" },
  ],
  disclaimer: "d",
  forecast: cycleForecast([{ start_date: "2026-10-12", end_date: "2026-10-16" }], profile, "2026-11-12"),
};
const fullShare = {
  enabled: true,
  confirmed: true,
  categories: { sex: true, mood: true, sleep: true, bbt: true }
};

test("выключенный или неизвестный шеринг не открывает ничего", () => {
  assert.deepEqual(cycleViewForPartner(shared, { enabled: false, confirmed: true, categories: fullShare.categories }), { shared: false });
  assert.deepEqual(cycleViewForPartner(shared, null), { shared: false });
  assert.deepEqual(cycleViewForPartner(shared, undefined), { shared: false });
});

test("без подтверждения состава партнёру отдаётся только календарная оценка", () => {
  const v = cycleViewForPartner(shared, { enabled: true, confirmed: false, categories: fullShare.categories });
  const json = JSON.stringify(v);
  assert.equal(v.shared, true);
  assert.equal(v.confirmed, false);
  assert.equal("periods" in v, false);
  assert.equal("days" in v, false);
  assert.equal("bbt" in v, false);
  // Даже forecast не раскрывает точный диапазон без подтверждения.
  assert.equal("next_period_start" in v.forecast, false);
  assert.equal(json.includes("2026-10-12"), false);
  assert.equal(json.includes("секретная"), false);
});

test("календарь подтверждён: даты месячных есть, дневниковых полей нет", () => {
  const v = cycleViewForPartner(shared, { enabled: true, confirmed: true, categories: { sex: false, mood: false, sleep: false, bbt: false } });
  const json = JSON.stringify(v);
  assert.equal(v.shared, true);
  assert.equal(v.periods.length, 2);
  assert.equal(v.calendar_periods.length, 2);
  assert.equal(v.forecast.next_period_start !== undefined, true);
  assert.equal(v.last_period_start, "2026-11-10");
  assert.equal("days" in v, false);
  assert.equal("bbt" in v, false);
  assert.equal("today_log" in v, false);
  assert.equal(json.includes("секретная"), false);
  assert.equal(json.includes("cramps"), false);
  assert.equal(json.includes("симптом"), false);
});

test("категория секс: факты и явное «без секса», без лишних полей", () => {
  const v = cycleViewForPartner(shared, { enabled: true, confirmed: true, categories: { sex: true, mood: false, sleep: false, bbt: false } });
  assert.equal(v.days.length, 2);
  assert.deepEqual(v.days[0], { date: "2026-11-12", sex: "protected", sex_count: 2 });
  assert.deepEqual(v.days[1], { date: "2026-11-11", sex: "none", sex_count: 0 });
  const json = JSON.stringify(v);
  // Значения настроения/сна в днях отсутствуют (в метаданных категорий ключи
  // есть всегда — это состав общего доступа, не данные).
  assert.equal(json.includes("calm"), false);
  assert.equal(json.includes("good"), false);
  assert.equal(json.includes("секретная"), false);
});

test("настроение и сон передаются только своими категориями", () => {
  const v = cycleViewForPartner(shared, { enabled: true, confirmed: true, categories: { sex: false, mood: true, sleep: true, bbt: false } });
  assert.deepEqual(v.days[0], { date: "2026-11-12", mood: "calm", sleep: "good" });
  assert.deepEqual(v.days[1], { date: "2026-11-11", mood: "sad", sleep: "poor" });
  assert.equal(JSON.stringify(v).includes("sex_count"), false);
});

test("температура: только БТ, с единицами и временем; ЛГ не отдаётся", () => {
  const v = cycleViewForPartner(shared, { enabled: true, confirmed: true, categories: { sex: false, mood: false, sleep: false, bbt: true } });
  assert.deepEqual(v.bbt, [{ date: "2026-11-10", time: "07:30", value: 36.6, unit: "C" }]);
  assert.equal(JSON.stringify(v).includes("lh"), false);
});

test("легаси-уровень не открывает дневниковые категории через старый формат вызова", () => {
  // Старый клиент передаёт строку уровня вместо объекта — такого ответа нет.
  assert.deepEqual(cycleViewForPartner(shared, "periods"), { shared: false });
  assert.deepEqual(cycleViewForPartner(shared, "full"), { shared: false });
});

test("партнёрский прогноз несёт качество данных и оговорку о контрацепции", () => {
  const v = cycleViewForPartner(shared, fullShare);
  assert.equal(typeof v.forecast.quality, "string");
  assert.equal(v.forecast.ovulation_estimated, true);
  assert.equal(typeof v.forecast.based_on, "string");
  assert.ok(v.forecast_disclaimer.includes("не является") || v.forecast_disclaimer.includes("не метод"));
});

test("экспорт: владелица получает полный журнал и настройки шеринга", () => {
  const payload = cycleExportPayload({
    profile: { avg_cycle_length: 30, avg_period_length: 4, cycle_length_known: 1 },
    share: { enabled: true, level: "periods", categories: { sex: true, mood: false, sleep: true, bbt: false }, confirmed: true },
    periods: [{ start_date: "2026-10-12", end_date: "2026-10-16" }],
    logs: [{ date: "2026-10-13", flow: "heavy", symptoms: ["cramps"], note: "заметка" }],
    context: { context: { pregnancy: false, hormonal_contraception: true } },
  }, "2026-11-12T01:00:00.000Z");
  assert.equal(payload.format, "duoplan-cycle");
  assert.deepEqual(payload.profile, {
    avg_cycle_length: 30, avg_period_length: 4, cycle_length_known: true,
    share_enabled: true, share_level: "periods",
    share_categories: { sex: true, mood: false, sleep: true, bbt: false },
    share_confirmed: true
  });
  assert.deepEqual(payload.context, { pregnancy: false, postpartum: false, breastfeeding: false, perimenopause: false, hormonal_contraception: true, cycle_affecting_meds: false, very_irregular: false, unusual_bleeding: false });
  assert.deepEqual(payload.periods, [{ start_date: "2026-10-12", end_date: "2026-10-16", end_unknown: false }]);
  assert.equal(payload.logs[0].note, "заметка");
});

test("экспорт: открытый период и пустые поля выгружаются без undefined", () => {
  const payload = cycleExportPayload({
    profile: { avg_cycle_length: 28, avg_period_length: 5 },
    share: { enabled: false, level: "phases" },
    periods: [{ start_date: "2026-11-10", end_date: null }],
    logs: [{ date: "2026-11-10", flow: null, symptoms: undefined, note: undefined }],
  }, "t");
  assert.equal(payload.periods[0].end_date, null);
  assert.equal(payload.periods[0].end_unknown, false);
  assert.deepEqual(payload.logs[0].symptoms, []);
  assert.equal(payload.logs[0].note, "");
  assert.equal(JSON.stringify(payload).includes("undefined"), false);
});

test("мастер: ответы превращаются в план записи, шеринг по умолчанию выключен", () => {
  const plan = cycleOnboardPlan({ last_start: "2026-11-05", period_length: 4, cycle_length: 30 }, "2026-11-12");
  assert.equal(plan.error, undefined);
  assert.deepEqual([plan.start, plan.end, plan.periodLen, plan.cycle, plan.cycleKnown], ["2026-11-05", null, 4, 30, true]);
  assert.equal(plan.shareEnabled, false);
  assert.equal(plan.shareLevel, "phases");
});

test("мастер: обычная продолжительность месячных не превращается в факт окончания", () => {
  // Последняя менструация началась 5 ноября, «обычно длятся 4 дня» —
  // это не значит, что она закончилась 8-го: период остаётся открытым.
  const plan = cycleOnboardPlan({ last_start: "2026-11-05", period_length: 4 }, "2026-11-12");
  assert.equal(plan.end, null);
});

test("мастер: «не знаю» про цикл даёт 28 и отметку, что значение не задано", () => {
  const plan = cycleOnboardPlan({ last_start: "2026-11-10", cycle_length: null }, "2026-11-12");
  assert.equal(plan.cycle, 28);
  assert.equal(plan.cycleKnown, false);
  assert.equal(plan.periodLen, 5);
});

test("мастер: период, который ещё идёт, остаётся открытым", () => {
  const plan = cycleOnboardPlan({ last_start: "2026-11-12" }, "2026-11-12");
  assert.equal(plan.end, null);
});

test("мастер: будущая дата, выход за пределы и неизвестный уровень отклоняются", () => {
  assert.equal(cycleOnboardPlan({ last_start: "2026-11-13" }, "2026-11-12").error, "INVALID_DATE");
  assert.equal(cycleOnboardPlan({ last_start: "2026-11-01", period_length: 11 }, "2026-11-12").error, "INVALID_CYCLE");
  assert.equal(cycleOnboardPlan({ last_start: "2026-11-01", cycle_length: 19 }, "2026-11-12").error, "INVALID_CYCLE");
  assert.equal(cycleOnboardPlan({ last_start: "2026-11-01", share_level: "everything" }, "2026-11-12").error, "INVALID_SHARE");
});

test("напоминания: месячные за 2 дня, овуляция, начало окна и задержка", () => {
  const base = { empty: false, phase: "luteal", next_period_in: 5, ovulation_in: 9, delay_days: 0, quality: "few", based_on: "history" };
  assert.deepEqual(cycleReminderKinds({ ...base, next_period_in: 2 }).map(r => r.kind), ["cycle_period"]);
  assert.deepEqual(cycleReminderKinds({ ...base, next_period_in: 1 }, { period_days: 1 }).map(r => r.text), ["Завтра ожидаются месячные"]);
  assert.deepEqual(cycleReminderKinds({ ...base, ovulation_in: 0 }).map(r => r.kind), ["cycle_ovulation"]);
  assert.deepEqual(cycleReminderKinds({ ...base, ovulation_in: 5 }).map(r => r.kind), ["cycle_fertile"]);
  assert.deepEqual(cycleReminderKinds({ ...base, phase: "delay", next_period_in: -3, delay_days: 3 }).map(r => r.kind), ["cycle_delay"]);
});

test("напоминания: месячные идут или данных нет — ничего не шлём", () => {
  assert.deepEqual(cycleReminderKinds({ empty: true }), []);
  assert.deepEqual(cycleReminderKinds({ empty: false, phase: "menstruation", next_period_in: 2, ovulation_in: 9, delay_days: 0 }), []);
  assert.deepEqual(cycleReminderKinds({ empty: false, phase: "luteal", next_period_in: 9, ovulation_in: 3, delay_days: 0 }), []);
});

// Переработка 4.2: гейтинг уведомлений об овуляции качеством данных.
test("напоминания: овуляция не анонсируется при недостаточных данных", () => {
  const base = { empty: false, phase: "luteal", next_period_in: 5, ovulation_in: 0, delay_days: 0 };
  // Fail-safe: нет quality/based_on — не шлём.
  assert.deepEqual(cycleReminderKinds({ ...base }), []);
  assert.deepEqual(cycleReminderKinds({ ...base, quality: "insufficient", based_on: "default" }), []);
  // Достаточная история — шлём; устаревшая — нет.
  const few = { ...base, quality: "few", based_on: "history" };
  assert.deepEqual(cycleReminderKinds(few).map(r => r.kind), ["cycle_ovulation"]);
  assert.deepEqual(cycleReminderKinds({ ...few, data_stale: true }), []);
});

test("статистика: длины циклов и симптомы по фазам по дням с записями", () => {
  const periods = [
    { start_date: "2026-01-01", end_date: "2026-01-05" },
    { start_date: "2026-01-29", end_date: "2026-02-02" },
    { start_date: "2026-02-26", end_date: "2026-03-02" },
  ];
  const logs = [
    { date: "2026-02-09", symptoms: [] },
    { date: "2026-02-12", symptoms: ["headache"] },
    { date: "2026-02-20", symptoms: ["fatigue", "cramps"] },
    { date: "2026-02-26", symptoms: ["cramps"] },
  ];
  const s = cycleStats(periods, logs, "2026-03-10", { avg_cycle_length: 28, avg_period_length: 5 });
  assert.equal(s.cycles.length, 2);
  assert.equal(s.avg_cycle_length, 28);
  assert.equal(s.logged_days, 4);
  // Знаменатель симптомов — дни с заполненным дневником симптомов:
  // день без симптомов и без «симптомов не было» в знаменатель не входит.
  assert.deepEqual(s.phases.menstruation.symptoms, { cramps: 1 });
  assert.deepEqual(s.phases.ovulation.symptoms, { headache: 1 });
  assert.deepEqual(s.phases.luteal.symptoms, { fatigue: 1, cramps: 1 });
  assert.equal(s.phases.luteal.symptom_days, 1);
  assert.equal(s.phases.menstruation.avg_pain, null);
  assert.equal(s.phases.fertile.days, 1);
});

test("статистика: symptoms_clear входит в знаменатель как явное отсутствие", () => {
  const periods = [
    { start_date: "2026-01-01", end_date: "2026-01-05" },
    { start_date: "2026-01-29", end_date: "2026-02-02" },
  ];
  const logs = [
    { date: "2026-01-30", symptoms: ["headache"], symptoms_clear: false },
    { date: "2026-01-31", symptoms: [], symptoms_clear: true },
    { date: "2026-02-01", symptoms: [], symptoms_clear: false },
  ];
  const s = cycleStats(periods, logs, "2026-02-20", { avg_cycle_length: 28, avg_period_length: 5 });
  assert.equal(s.phases.menstruation.symptom_days, 2, "день с symptom_clear — заполненный день, пропущенный — нет");
  assert.equal(s.phases.menstruation.clear_days, 1);
  assert.deepEqual(s.phases.menstruation.symptoms, { headache: 1 });
  // Покрытие дневника: заполнены 2 из 51 дня периода.
  assert.equal(s.coverage.diary_days, 3);
  assert.ok(s.coverage.days_total > 40);
});

test("статистика: настроение и энергия считаются отдельно от симптомов", () => {
  const periods = [
    { start_date: "2026-01-01", end_date: "2026-01-05" },
    { start_date: "2026-01-29", end_date: "2026-02-02" },
  ];
  const logs = [
    { date: "2026-02-01", symptoms: [], mood: "anxious", energy: "low" },
    { date: "2026-01-30", symptoms: [], mood: "irritable", energy: "low" },
    { date: "2026-02-14", symptoms: ["cramps"], mood: "sad", energy: "normal" },
  ];
  const s = cycleStats(periods, logs, "2026-02-20", { avg_cycle_length: 28, avg_period_length: 5 });
  // Менструация: дни 29.01–02.02 — оба дня с тревожностью/раздражительностью и низкой энергией.
  assert.deepEqual(s.phases.menstruation.moods, { anxious: 1, irritable: 1 });
  assert.deepEqual(s.phases.menstruation.energy, { low: 2 });
  assert.equal(s.phases.menstruation.mood_days, 2);
  assert.equal(s.phases.menstruation.energy_days, 2);
  // Лютеиновая: 14.02 — грусть, обычная энергия.
  assert.deepEqual(s.phases.luteal.moods, { sad: 1 });
  assert.deepEqual(s.phases.luteal.energy, { normal: 1 });
});

test("статистика: без данных — пустые циклы и фазы, без падения", () => {
  const s = cycleStats([], [], "2026-03-10", { avg_cycle_length: 28, avg_period_length: 5 });
  assert.deepEqual(s.cycles, []);
  assert.equal(s.logged_days, 0);
  assert.deepEqual(s.phases, {});
});

test("подсказки партнёру: есть для каждой фазы, для неизвестной фазы нет", () => {
  for (const phase of ["menstruation", "follicular", "fertile", "ovulation", "luteal", "delay"]) {
    assert.equal(typeof cyclePhaseTip(phase), "string");
  }
  assert.equal(cyclePhaseTip("unknown"), null);
});

test("подсказка партнёру не раскрывает даты и заметки", () => {
  const v = cycleViewForPartner(shared, fullShare);
  assert.equal(typeof v.tip, "string");
  assert.equal(JSON.stringify(v.tip).includes("2026"), false);
  assert.equal(JSON.stringify(v.tip).includes("секретная"), false);
});

// Этап 5/P1: единый модуль расчётов — качество данных, диапазон прогноза,
// необычные интервалы и фазы по каждому конкретному циклу.
test("прогноз: based_on/quality и диапазон дат", () => {
  // Один интервал — истории мало: профиль/дефолт, качество insufficient.
  const one = cycleForecast([{ start_date: "2026-10-20", end_date: "2026-10-24" }], profile, "2026-11-12");
  assert.equal(one.based_on, "default");
  assert.equal(one.quality, "insufficient");
  assert.equal(one.ovulation_estimated, true);
  assert.ok(one.next_period_early < one.next_period_start);
  assert.ok(one.next_period_late > one.next_period_start);
  // Два и более пригодных интервала — расчёт по истории.
  const periods = [
    { start_date: "2026-08-01", end_date: "2026-08-05" },
    { start_date: "2026-08-30", end_date: "2026-09-03" },
    { start_date: "2026-09-27", end_date: "2026-10-01" },
    { start_date: "2026-10-25", end_date: "2026-10-29" },
  ];
  const f = cycleForecast(periods, profile, "2026-10-30");
  assert.equal(f.based_on, "history");
  assert.equal(f.quality, "few"); // 3 пригодных интервала — мало для «full»
  assert.equal(f.usable_cycles, 3);
});

test("прогноз: необычные интервалы сохраняются, но не входят в среднее", () => {
  const periods = [
    { start_date: "2026-01-01", end_date: "2026-01-05" },
    { start_date: "2026-01-20", end_date: "2026-01-24" },   // интервал 19 — пригодный
    { start_date: "2026-03-01", end_date: "2026-03-05" },   // интервал 40 — пригодный
    { start_date: "2026-03-10", end_date: "2026-03-14" },   // интервал 9 — unusual
  ];
  const f = cycleForecast(periods, profile, "2026-03-15");
  assert.equal(f.unusual_intervals, 1);
  // Среднее считается по пригодным (19 и 40 → 30), а не по всем трём.
  assert.equal(f.avg_cycle_length, 30);
});

test("статистика: фазы считаются по длине каждого цикла, а не по средней", () => {
  // Завершённые циклы разной длины: 20 и два по 35 дней. Во втором цикле
  // овуляция — 21-й день (35−14); по старой логике со средней ~30 она
  // пришлась бы на 16-й. Длина текущего (незавершённого) цикла — только оценка.
  const periods = [
    { start_date: "2026-01-01", end_date: "2026-01-05" },
    { start_date: "2026-01-21", end_date: "2026-01-25" },   // цикл 20 дней
    { start_date: "2026-02-25", end_date: "2026-03-01" },   // цикл 35 дней
    { start_date: "2026-04-01", end_date: null },           // текущий, длина неизвестна
  ];
  const logs = [
    { date: "2026-02-27", symptoms: [] },      // день 2 цикла 35д — менструация
    { date: "2026-03-10", symptoms: ["cramps"] }, // день 13 — фолликулярная (овул. на 21-й)
    { date: "2026-03-18", symptoms: [] },      // день 21 — овуляция по длине этого цикла
  ];
  const s = cycleStats(periods, logs, "2026-04-05", { avg_cycle_length: 28, avg_period_length: 5 });
  assert.equal(s.phases.menstruation.days, 1);
  assert.equal(s.phases.follicular.days, 1);
  assert.equal(s.phases.ovulation.days, 1);
  assert.equal(s.phase_source, "estimated");
  // Текущий цикл — оценочный, в завершённые не входит (три полных интервала).
  assert.equal(s.cycles.length, 3);
  assert.equal(s.current_cycle.partial, true);
  assert.equal(s.current_cycle.estimated, true);
  // Границы и разброс отдаём фактические.
  assert.equal(s.min_cycle_length, 20);
  assert.equal(s.max_cycle_length, 35);
  assert.equal(s.spread, 15);
});

test("статистика: необычные интервалы видны в unusual_intervals", () => {
  const periods = [
    { start_date: "2026-01-01", end_date: "2026-01-05" },
    { start_date: "2026-01-29", end_date: "2026-02-02" },
    { start_date: "2026-04-01", end_date: "2026-04-05" },   // интервал 63 — unusual
  ];
  const s = cycleStats(periods, [], "2026-04-10", { avg_cycle_length: 28, avg_period_length: 5 });
  assert.equal(s.unusual_intervals.length, 1);
  assert.equal(s.unusual_intervals[0].length, 62);
});

test("напоминания: свои дни до события и выключенные виды", () => {
  const f = { empty: false, phase: "luteal", next_period_in: 3, ovulation_in: 0, delay_days: 0, quality: "few", based_on: "history" };
  assert.deepEqual(cycleReminderKinds(f, { period_days: 3 }).map(r => r.kind), ["cycle_period", "cycle_ovulation"]);
  assert.deepEqual(cycleReminderKinds(f, { period_days: 3, ovulation: false }).map(r => r.kind), ["cycle_period"]);
  assert.deepEqual(cycleReminderKinds(f, { period: false, ovulation: false }).map(r => r.kind), []);
  assert.deepEqual(cycleReminderKinds({ empty: false, phase: "delay", next_period_in: -5, ovulation_in: 9, delay_days: 5 }, { delay_days: 5 }).map(r => r.kind), ["cycle_delay"]);
});

// Этап 6/P2 + переработка 10.2: ПМС-паттерны агрегируются по циклам, не по дням.
test("статистика: pms_patterns считаются по циклам и avg_pain по фазам", () => {
  const periods = [
    { start_date: "2026-01-01", end_date: "2026-01-05" },
    { start_date: "2026-01-29", end_date: "2026-02-02" },
    { start_date: "2026-02-26", end_date: "2026-03-02" },
  ];
  const logs = [
    // День 25 каждого 28-дневного цикла — за 3 дня до следующего старта.
    { date: "2026-01-26", symptoms: ["bloating"], pain_score: 4 },
    { date: "2026-02-23", symptoms: ["bloating"], pain_score: 6 },
    // Симптом один раз — в паттерн не попадает (циклов < 2).
    { date: "2026-01-10", symptoms: ["headache"] },
  ];
  const s = cycleStats(periods, logs, "2026-03-10", { avg_cycle_length: 28, avg_period_length: 5 });
  const pms = s.pms_patterns.find(p => p.code === "bloating");
  assert.ok(pms, "bloating должен попасть в ПМС-паттерны");
  assert.equal(pms.avg_lead_days, 3);
  assert.equal(pms.cycles_with_symptom, 2);
  assert.equal(pms.cycles_with_data, 2);
  assert.equal(pms.confidence, "low", "два цикла — предварительный вывод");
  assert.ok(!s.pms_patterns.some(p => p.code === "headache"), "одиночный симптом — не паттерн");
  // Оба дня с болью — лютеиновая фаза (овуляция на 14-й день).
  assert.equal(s.phases.luteal.avg_pain, 5);
  assert.equal(s.phases.menstruation, undefined);
});

test("статистика: многодневная отметка в одном цикле — не три повторения", () => {
  const periods = [
    { start_date: "2026-01-01", end_date: "2026-01-05" },
    { start_date: "2026-01-29", end_date: "2026-02-02" },
    { start_date: "2026-02-26", end_date: "2026-03-02" },
  ];
  const logs = [
    // Три дня подряд в одном цикле — это ОДИН цикл с симптомом, не три.
    { date: "2026-01-24", symptoms: ["bloating"] },
    { date: "2026-01-25", symptoms: ["bloating"] },
    { date: "2026-01-26", symptoms: ["bloating"] },
    { date: "2026-02-23", symptoms: ["bloating"] },
  ];
  const s = cycleStats(periods, logs, "2026-03-10", { avg_cycle_length: 28, avg_period_length: 5 });
  const pms = s.pms_patterns.find(p => p.code === "bloating");
  assert.ok(pms);
  assert.equal(pms.cycles_with_symptom, 2, "симптом в двух циклах, не в четырёх");
  assert.equal(pms.days, 4, "дневные отметки видны отдельно");
});

test("статистика: 3 цикла с симптомом дают уверенный паттерн", () => {
  const periods = [
    { start_date: "2026-01-01", end_date: "2026-01-05" },
    { start_date: "2026-01-29", end_date: "2026-02-02" },
    { start_date: "2026-02-26", end_date: "2026-03-02" },
    { start_date: "2026-03-26", end_date: "2026-03-30" },
  ];
  const logs = [
    { date: "2026-01-26", symptoms: ["bloating"] },
    { date: "2026-02-23", symptoms: ["bloating"] },
    { date: "2026-03-23", symptoms: ["bloating"] },
  ];
  const s = cycleStats(periods, logs, "2026-04-10", { avg_cycle_length: 28, avg_period_length: 5 });
  const pms = s.pms_patterns.find(p => p.code === "bloating");
  assert.ok(pms);
  assert.equal(pms.cycles_with_symptom, 3);
  assert.equal(pms.confidence, "good");
});

// Переработка 10.3: диапазон статистики ограничен выбранным периодом.
test("статистика: циклы вне выбранного периода не попадают в среднее", () => {
  const periods = [
    { start_date: "2025-08-01", end_date: "2025-08-05" },
    { start_date: "2025-08-29", end_date: "2025-09-02" }, // цикл в прошлом годе, вне 3 мес.
    { start_date: "2026-10-01", end_date: "2026-10-05" },
    { start_date: "2026-10-29", end_date: "2026-11-02" }, // цикл внутри 3 мес.
  ];
  const logs = [];
  const s = cycleStats(periods, logs, "2026-11-12", { avg_cycle_length: 28, avg_period_length: 5 }, { from: "2026-08-14" });
  assert.equal(s.cycles.length, 1, "только цикл со стартом внутри периода");
  assert.equal(s.cycles[0].start, "2026-10-01");
  assert.equal(s.avg_cycle_length, 28);
});

// Переработка 7: длинные периоды не отбрасываются молча.
test("статистика: длинные периоды видны отдельно от средних", () => {
  const periods = [
    { start_date: "2026-01-01", end_date: "2026-01-05" },  // 5 дн.
    { start_date: "2026-01-29", end_date: "2026-02-02" },  // 5 дн.
    { start_date: "2026-02-26", end_date: "2026-03-15" },  // 18 дн. — длинный
  ];
  const s = cycleStats(periods, [], "2026-04-10", { avg_cycle_length: 28, avg_period_length: 5 });
  assert.equal(s.long_periods.length, 1);
  assert.equal(s.long_periods[0].length, 18);
  assert.equal(s.period_lengths.count, 2, "среднее — только по обычным длительностям");
});

// ---- P1: точность прогноза ----

test("медиана устойчивее среднего к выбросам внутри диапазона", () => {
  // Интервалы 15/60 допустимы, но среднее (32) смещено; медиана = 28.
  const periods = [
    { start_date: "2026-01-01", end_date: "2026-01-05" },
    { start_date: "2026-01-16", end_date: "2026-01-20" },   // +15
    { start_date: "2026-03-17", end_date: "2026-03-21" },   // +60
    { start_date: "2026-04-14", end_date: "2026-04-18" },   // +28
    { start_date: "2026-05-12", end_date: "2026-05-16" },   // +28
    { start_date: "2026-06-09", end_date: "2026-06-13" },   // +28
  ];
  const f = cycleForecast(periods, profile, "2026-06-20");
  assert.equal(f.avg_cycle_length, 28);
  assert.equal(f.irregular, true);
});

test("один пригодный интервал используется, качество остаётся низким", () => {
  const periods = [
    { start_date: "2026-10-01", end_date: "2026-10-05" },
    { start_date: "2026-10-31", end_date: "2026-11-04" }, // +30
  ];
  const f = cycleForecast(periods, profile, "2026-11-10");
  assert.equal(f.based_on, "history");
  assert.equal(f.usable_cycles, 1);
  assert.equal(f.quality, "insufficient");
  assert.equal(f.next_period_start, "2026-11-30"); // 31.10 + 30, не 28
});

test("длина месячных считается по последним закрытым периодам", () => {
  const mk = (s, len) => {
    const d = new Date(s + "T00:00:00Z");
    d.setUTCDate(d.getUTCDate() + len - 1);
    return { start_date: s, end_date: d.toISOString().slice(0, 10) };
  };
  // 7 периодов: первый длиной 9, остальные по 5. За всей историей среднее 6,
  // по последним 6 — 5.
  const periods = [
    mk("2026-01-01", 9), mk("2026-01-30", 5), mk("2026-03-01", 5),
    mk("2026-03-30", 5), mk("2026-04-28", 5), mk("2026-05-27", 5),
    mk("2026-06-25", 5),
  ];
  const f = cycleForecast(periods, profile, "2026-07-10");
  assert.equal(f.avg_period_length, 5);
});

test("давно не было записей — фаза stale вместо вечной задержки", () => {
  const periods = [{ start_date: "2026-07-01", end_date: "2026-07-05" }];
  const f = cycleForecast(periods, profile, "2026-10-15");
  assert.equal(f.phase, "stale");
  assert.equal(f.data_stale, true);
  // Задержка (не stale): прошло заметно больше avgCycle, но в пределах grace.
  const f2 = cycleForecast([{ start_date: "2026-09-20", end_date: "2026-09-24" }], profile, "2026-11-05");
  assert.equal(f2.phase, "delay");
  assert.equal(f2.data_stale, false);
});

test("положительный ЛГ уточняет дату овуляции, не меняя следующий период", () => {
  const periods = [
    { start_date: "2026-08-04", end_date: "2026-08-08" },
    { start_date: "2026-09-01", end_date: "2026-09-05" }, // цикл 28 → ov 15.09
  ];
  const meas = [{ kind: "lh", result: "positive", date: "2026-09-13" }];
  const f = cycleForecast(periods, profile, "2026-09-14", meas);
  assert.equal(f.ovulation_source, "lh");
  assert.equal(f.ovulation_date, "2026-09-14"); // ЛГ+ 13.09 → овуляция ~+1 день
  assert.equal(f.next_period_start, "2026-09-29"); // интервалы не тронуты
  assert.equal(f.fertile_start, "2026-09-09");
});

test("ЛГ вне окна цикла игнорируется", () => {
  const periods = [
    { start_date: "2026-08-04", end_date: "2026-08-08" },
    { start_date: "2026-09-01", end_date: "2026-09-05" },
  ];
  const meas = [{ kind: "lh", result: "positive", date: "2026-10-20" }]; // после next-7
  const f = cycleForecast(periods, profile, "2026-09-10", meas);
  assert.equal(f.ovulation_source, "calendar");
  assert.equal(f.ovulation_date, "2026-09-15");
});

test("устойчивый подъём БТ уточняет овуляцию", () => {
  const periods = [
    { start_date: "2026-08-04", end_date: "2026-08-08" },
    { start_date: "2026-09-01", end_date: "2026-09-05" }, // ov 15.09
  ];
  // Базовая линия 36.5 (6–9.09), подъём до 36.9 с 11.09 → овуляция ~10.09.
  const meas = [
    ...["2026-09-06", "2026-09-07", "2026-09-08", "2026-09-09"].map(d => ({ kind: "bbt", value: 36.5, unit: "C", date: d })),
    { kind: "bbt", value: 36.9, unit: "C", date: "2026-09-11" },
    { kind: "bbt", value: 36.9, unit: "C", date: "2026-09-12" },
    { kind: "bbt", value: 36.9, unit: "C", date: "2026-09-13" },
  ];
  const f = cycleForecast(periods, profile, "2026-09-14", meas);
  assert.equal(f.ovulation_source, "bbt");
  assert.equal(f.ovulation_date, "2026-09-10");
});

// ---- Самообучение прогноза и независимые оценки овуляции (2026-11-14) ----

test("самообучение: два цикла с ЛГ+ подбирают личное смещение овуляции", () => {
  // Циклы 28 дней, ЛГ+ на 16-й день каждого завершённого цикла →
  // овуляция на 17-й день (offset 16). Текущий цикл: старт 26.03.
  const periods = [
    { start_date: "2026-01-01", end_date: "2026-01-05" },
    { start_date: "2026-01-29", end_date: "2026-02-02" },
    { start_date: "2026-02-26", end_date: "2026-03-02" },
    { start_date: "2026-03-26", end_date: null },
  ];
  // LH+ в завершённых циклах: 16.01 (день 16), 13.02 (день 19? нет: 13.02 − 29.01 = день 16)… берём день 16 каждого.
  const meas = [
    { kind: "lh", result: "positive", date: "2026-01-16" },
    { kind: "lh", result: "positive", date: "2026-02-13" },
    { kind: "lh", result: "positive", date: "2026-03-13" },
  ];
  const f = cycleForecast(periods, profile, "2026-04-05", meas);
  assert.equal(f.ovulation_offset_learned, 16);
  assert.equal(f.ovulation_offset_observations, 3, "три завершённых цикла с наблюдениями");
  // Без обучения было бы next − 14 = 11.04; со смещением 16 → 26.03 + 16.
  assert.equal(f.ovulation_date, "2026-04-11");
  assert.equal(f.ovulation_source, "calendar");
  assert.equal(f.ovulation_estimated, true, "самообучение не делает овуляцию подтверждённой");
});

test("самообучение: одно наблюдение не меняет стандартные −14 дней", () => {
  const periods = [
    { start_date: "2026-01-01", end_date: "2026-01-05" },
    { start_date: "2026-01-29", end_date: "2026-02-02" },
    { start_date: "2026-02-26", end_date: null },
  ];
  const meas = [{ kind: "lh", result: "positive", date: "2026-01-16" }];
  const f = cycleForecast(periods, profile, "2026-03-10", meas);
  assert.equal(f.ovulation_offset_learned, null);
  assert.equal(f.ovulation_date, "2026-03-12"); // 26.02 + 28 − 14
});

test("самообучение: смещение вне санити-границ 9–17 отбрасывается", () => {
  const periods = [
    { start_date: "2026-01-01", end_date: "2026-01-05" },
    { start_date: "2026-01-29", end_date: "2026-02-02" },
    { start_date: "2026-02-26", end_date: "2026-03-02" },
    { start_date: "2026-03-26", end_date: null },
  ];
  // LH+ на 6-й день → смещение 7 — вне границ, в обучение не попадает.
  const meas = [
    { kind: "lh", result: "positive", date: "2026-01-06" },
    { kind: "lh", result: "positive", date: "2026-02-03" },
  ];
  const f = cycleForecast(periods, profile, "2026-04-05", meas);
  assert.equal(f.ovulation_offset_learned, null);
});

test("расхождение ЛГ и БТ показывается по отдельности, берётся ЛГ", () => {
  const periods = [
    { start_date: "2026-08-04", end_date: "2026-08-08" },
    { start_date: "2026-09-01", end_date: "2026-09-05" }, // календарная ов 15.09
  ];
  const meas = [
    { kind: "lh", result: "positive", date: "2026-09-13" }, // → ов 14.09 (±1 от календаря)
    ...["2026-09-05", "2026-09-06", "2026-09-07", "2026-09-08"].map(d => ({ kind: "bbt", value: 36.5, unit: "C", date: d })),
    { kind: "bbt", value: 36.9, unit: "C", date: "2026-09-10" },
    { kind: "bbt", value: 36.9, unit: "C", date: "2026-09-11" },
    { kind: "bbt", value: 36.9, unit: "C", date: "2026-09-12" },
  ];
  const f = cycleForecast(periods, profile, "2026-09-14", meas);
  assert.equal(f.ovulation_source, "lh");
  assert.equal(f.ovulation_date, "2026-09-14");
  assert.ok(f.ovulation_conflict, "расхождение не замалчивается");
  assert.equal(f.ovulation_conflict.lh, "2026-09-14");
  assert.equal(f.ovulation_conflict.bbt, "2026-09-09");
});

test("болезнь в день замера исключает БТ-сдвиг (18B)", () => {
  const periods = [
    { start_date: "2026-08-04", end_date: "2026-08-08" },
    { start_date: "2026-09-01", end_date: "2026-09-05" },
  ];
  const meas = [
    ...["2026-09-05", "2026-09-06", "2026-09-07", "2026-09-08"].map(d => ({ kind: "bbt", value: 36.5, unit: "C", date: d })),
    { kind: "bbt", value: 36.9, unit: "C", date: "2026-09-10" },
    { kind: "bbt", value: 36.9, unit: "C", date: "2026-09-11" },
    { kind: "bbt", value: 36.9, unit: "C", date: "2026-09-12" },
  ];
  const withoutSick = cycleForecast(periods, profile, "2026-09-14", meas);
  assert.equal(withoutSick.ovulation_source, "bbt");
  // Средний день подъёма «болен» — сдвиг не распознаётся, остаётся календарь.
  const withSick = cycleForecast(periods, profile, "2026-09-14", meas, ["2026-09-11"]);
  assert.equal(withSick.ovulation_source, "calendar");
  assert.equal(withSick.ovulation_date, "2026-09-15");
});

// ---- Улучшения (этапы 3–5): персональный прогноз окончания месячных ----

const mkPeriod = (s, len) => {
  const d = new Date(s + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + len - 1);
  return { start_date: s, end_date: d.toISOString().slice(0, 10) };
};

test("длительность месячных — взвешенная медиана 8 свежих, выброс не смещает (P1.2)", () => {
  // 7 завершённых: самый старый — 9 дней, остальные 5. Все 7 в окне (≤8):
  // медиана ядра = 5; 9 дней — выброс за полосой ±50%, но min/max честно
  // его учитывают, а разброс 5–9 помечает статистику нестабильной.
  const periods = [
    mkPeriod("2026-01-01", 9), mkPeriod("2026-01-30", 5), mkPeriod("2026-03-01", 5),
    mkPeriod("2026-03-30", 5), mkPeriod("2026-04-28", 5), mkPeriod("2026-05-27", 5),
    mkPeriod("2026-06-25", 5),
  ];
  const f = cycleForecast(periods, profile, "2026-07-10");
  assert.equal(f.avg_period_length, 5);
  assert.equal(f.period_samples, 7, "берутся не более 8 свежих завершённых");
  assert.equal(f.period_confidence, "low", "разброс ≥4 — достоверность низкая");
  assert.equal(f.period_source, "history");
  assert.equal(f.period_min, 5);
  assert.equal(f.period_max, 9, "min/max — по всем наблюдениям, включая выброс");
  assert.equal(f.period_unstable, true, "выброс + разброс ≥4 — предупреждение");
  assert.equal(f.next_period_end, "2026-07-28"); // 24.07 + 5 − 1
  assert.ok(f.next_period_end_early < f.next_period_end);
  assert.ok(f.next_period_end_late > f.next_period_end);
});

test("end_unknown и открытый период не входят в статистику длительности", () => {
  const periods = [
    { start_date: "2026-01-01", end_date: "2026-01-08" },              // 8 дн., завершённый
    { start_date: "2026-01-29", end_date: null, end_unknown: true },   // «конец не помним»
    { start_date: "2026-02-26", end_date: null },                      // открытый
  ];
  const f = cycleForecast(periods, profile, "2026-03-10");
  assert.equal(f.period_samples, 1, "только завершённый период с известным концом");
  assert.equal(f.avg_period_length, 8);
  assert.equal(f.period_confidence, "low");
  assert.equal(f.period_source, "history");
  // Открытый период даёт прогноз окончания — и не закрывается им.
  const cp = f.current_period;
  assert.ok(cp, "прогноз текущего периода отсутствует");
  assert.equal(f.phase, "menstruation", "прогноз не завершает фактический период");
  assert.equal(cp.start, "2026-02-26");
  assert.equal(cp.days_elapsed, 13);
  assert.equal(cp.expected_end, "2026-03-05"); // 26.02 + 8 − 1
  assert.equal(cp.overdue, true, "ожидаемое окончание прошло — нейтральный overdue");
});

test("нет завершённых месячных — профиль с явным предупреждением", () => {
  const f = cycleForecast([{ start_date: "2026-11-10", end_date: null }], profile, "2026-11-12");
  assert.equal(f.period_samples, 0);
  assert.equal(f.period_confidence, "none");
  assert.equal(f.period_source, "profile");
  assert.equal(f.avg_period_length, 5, "берётся значение профиля");
  const cp = f.current_period;
  assert.ok(cp);
  assert.equal(cp.expected_end, "2026-11-14"); // 10.11 + 5 − 1
  assert.equal(cp.overdue, false);
  assert.equal(cp.days_elapsed, 3);
});

test("диапазон окончания учитывает разброс и начала, и длительности", () => {
  const periods = [
    mkPeriod("2026-01-01", 3),   // 3 дн.
    mkPeriod("2026-01-29", 7),   // 7 дн.
    mkPeriod("2026-02-26", 5),   // 5 дн.
    { start_date: "2026-03-26", end_date: null }, // открытый
  ];
  const f = cycleForecast(periods, profile, "2026-04-10");
  assert.equal(f.avg_period_length, 5, "медиана 3/5/7");
  assert.equal(f.period_samples, 3);
  assert.equal(f.period_confidence, "low", "разброс 3–7 ≥ 4 — достоверность низкая (P1.2)");
  assert.equal(f.period_unstable, true, "разброс 3–7 ≥ 4 — предупреждение");
  assert.equal(f.period_min, 3);
  assert.equal(f.period_max, 7);
  // Циклы ровно по 28 → разброса нет (rng=3):
  // начало 23.04 ±3, длительность 3–7 → конец 22.04 — 02.05.
  assert.equal(f.next_period_end, "2026-04-27");
  assert.equal(f.next_period_end_early, "2026-04-22");
  assert.equal(f.next_period_end_late, "2026-05-02");
  // Текущий период: 16 дней идёт, ожидаемое окончание 30.03, диапазон 28.03–01.04.
  const cp = f.current_period;
  assert.equal(cp.days_elapsed, 16);
  assert.equal(cp.expected_end, "2026-03-30");
  assert.equal(cp.end_early, "2026-03-28");
  assert.equal(cp.end_late, "2026-04-01");
  assert.equal(cp.overdue, true);
});

test("длительность считается включительно и на границах месяцев/високосного года", () => {
  // 28.02–01.03 високосного 2028: 28, 29, 01 = 3 дня.
  const leap = cycleForecast([mkPeriod("2028-02-28", 3)], profile, "2028-03-10");
  assert.equal(leap.avg_period_length, 3);
  assert.equal(leap.period_samples, 1);
  // Январь → февраль: 30.01–02.02 = 4 дня.
  const across = cycleForecast([mkPeriod("2026-01-30", 4)], profile, "2026-03-10");
  assert.equal(across.avg_period_length, 4);
});

test("исправление прошлой записи пересчитывает статистику без кеша", () => {
  const before = [
    { start_date: "2026-01-01", end_date: "2026-01-05" },
    { start_date: "2026-01-29", end_date: "2026-02-02" },
  ];
  const f1 = cycleForecast(before, profile, "2026-03-10");
  assert.equal(f1.avg_period_length, 5);
  // Пользователь исправил окончание второго периода: 5 → 8 дней.
  const edited = [before[0], { start_date: "2026-01-29", end_date: "2026-02-05" }];
  const f2 = cycleForecast(edited, profile, "2026-03-10");
  // Взвешенная медиана по свежести (P1.2): свежая запись 8 дн. весит
  // больше старой 5 дн. — оценка 8, а не округлённое среднее 7.
  assert.equal(f2.avg_period_length, 8, "взвешенная медиана отдаёт вес свежей записи");
  assert.equal(f2.period_samples, 2);
  // Удаление записи тоже пересчитывает: остался один период.
  const f3 = cycleForecast([before[0]], profile, "2026-03-10");
  assert.equal(f3.period_samples, 1);
  assert.equal(f3.period_confidence, "low");
});

test("статистика: period_lengths отдаёт медиану рядом со средним", () => {
  const periods = [
    { start_date: "2026-01-01", end_date: "2026-01-03" },
    { start_date: "2026-01-29", end_date: "2026-02-04" },
    { start_date: "2026-02-26", end_date: "2026-03-02" },
  ];
  const s = cycleStats(periods, [], "2026-04-10", { avg_cycle_length: 28, avg_period_length: 5 });
  assert.equal(s.period_lengths.median, 5);
  assert.equal(s.period_lengths.min, 3);
  assert.equal(s.period_lengths.max, 7);
});

test("дневные паттерны: симптом в одном дне цикла в разных циклах", () => {
  const periods = [
    { start_date: "2026-01-01", end_date: "2026-01-05" },
    { start_date: "2026-01-29", end_date: "2026-02-02" },
    { start_date: "2026-02-26", end_date: "2026-03-02" },
  ];
  // День 10 цикла (c.d=9) — bloating в двух циклах; одиночный headache — нет.
  const logs = [
    { date: "2026-01-10", symptoms: ["bloating"] },
    { date: "2026-02-07", symptoms: ["bloating"] },
    { date: "2026-01-15", symptoms: ["headache"] },
  ];
  const s = cycleStats(periods, logs, "2026-03-10", { avg_cycle_length: 28, avg_period_length: 5 });
  const p = (s.day_patterns || []).find(x => x.code === "bloating");
  assert.ok(p, "bloating должен попасть в дневные паттерны");
  assert.equal(p.day_offset, 10);
  assert.equal(p.cycles_with_symptom, 2);
  assert.equal(p.cycles_with_data, 2, "знаменатель — циклы с дневником симптомов (третий цикл без записей)");
  assert.ok(!(s.day_patterns || []).some(x => x.code === "headache"), "одиночный симптом — не паттерн");
});

test("партнёрский вид: диапазон окончания только после подтверждения", () => {
  const v = cycleViewForPartner(shared, fullShare);
  assert.ok(v.forecast.next_period_end_early <= v.forecast.next_period_end);
  assert.ok(v.forecast.next_period_end <= v.forecast.next_period_late
    || v.forecast.next_period_end <= v.forecast.next_period_end_late);
  const denied = cycleViewForPartner(shared, { enabled: true, confirmed: false, categories: fullShare.categories });
  assert.equal("next_period_end_early" in denied.forecast, false);
});

test("интенсивность по дням месячных: распределение уровней по смещению", () => {
  const periods = [
    { start_date: "2026-01-01", end_date: "2026-01-05" },
    { start_date: "2026-01-29", end_date: "2026-02-02" },
    { start_date: "2026-02-26", end_date: "2026-03-02" },
  ];
  const logs = [
    { date: "2026-01-01", flow: "heavy" }, { date: "2026-01-02", flow: "heavy" },
    { date: "2026-01-03", flow: "medium" }, { date: "2026-01-04", flow: "light" },
    { date: "2026-01-29", flow: "heavy" }, { date: "2026-01-30", flow: "medium" },
    { date: "2026-01-31", flow: "light" },
    { date: "2026-02-26", flow: "heavy" }, { date: "2026-02-27", flow: "medium" },
  ];
  const s = cycleStats(periods, logs, "2026-03-10", { avg_cycle_length: 28, avg_period_length: 5 });
  const fp = s.flow_profile;
  assert.ok(fp, "flow_profile должен быть при >=2 периодах с отметками");
  assert.equal(fp.periods, 3);
  assert.equal(fp.typical_days, 3, "медиана последних дней со flow: 4,3,2 → 3");
  const d1 = fp.days.find(d => d.day === 1);
  assert.equal(d1.dominant, "heavy");
  assert.equal(d1.total, 3);
  assert.equal(d1.periods, 3);
  const d2 = fp.days.find(d => d.day === 2);
  assert.equal(d2.dominant, "medium", "heavy 1 / medium 2 → medium");
  assert.ok(!fp.days.some(d => d.day === 4), "день с одной отметкой (<2) не показывается");
});

test("интенсивность по дням: один период — профиль не строится", () => {
  const periods = [{ start_date: "2026-01-01", end_date: "2026-01-05" }];
  const logs = [
    { date: "2026-01-01", flow: "heavy" }, { date: "2026-01-02", flow: "heavy" },
    { date: "2026-01-03", flow: "light" }, { date: "2026-01-04", flow: "light" },
  ];
  const s = cycleStats(periods, logs, "2026-03-10", { avg_cycle_length: 28, avg_period_length: 5 });
  assert.equal(s.flow_profile, null, "один период — недостаточная база");
});

test("интенсивность по дням: вне периода и end_unknown не выдумывают дни", () => {
  const periods = [
    { start_date: "2026-01-01", end_date: "2026-01-04" },
    { start_date: "2026-01-29", end_date: "2026-02-02" },
    { start_date: "2026-02-10", end_date: null, end_unknown: 1 },
  ];
  const logs = [
    { date: "2026-01-01", flow: "heavy" }, { date: "2026-01-02", flow: "heavy" },
    { date: "2026-01-29", flow: "medium" }, { date: "2026-01-30", flow: "medium" },
    // flow вне периодов и после «не помним конца» — не учитываются.
    { date: "2026-01-15", flow: "heavy" }, { date: "2026-02-12", flow: "heavy" },
  ];
  const s = cycleStats(periods, logs, "2026-03-10", { avg_cycle_length: 28, avg_period_length: 5 });
  const fp = s.flow_profile;
  assert.ok(fp);
  assert.equal(fp.periods, 2, "end_unknown-период даёт максимум день 1, здесь записей на него нет");
  assert.ok(!fp.days.some(d => d.day > 4), "смещения вне фактических диапазонов не появляются");
  const d1 = fp.days.find(d => d.day === 1);
  assert.equal(d1.total, 2);
  assert.equal(d1.heavy, 1);
  assert.equal(d1.medium, 1);
});

// ---- План улучшения прогнозов (P1): контекст, алиасы, новые пороги ----

test("P1.1: current_period отдаёт алиасы спецификации и источник (день N, early/late, source)", () => {
  const periods = [
    { start_date: "2026-01-01", end_date: "2026-01-05" },
    { start_date: "2026-01-29", end_date: "2026-02-02" },
    { start_date: "2026-03-26", end_date: null }, // открытый
  ];
  const f = cycleForecast(periods, profile, "2026-04-01");
  const cp = f.current_period;
  assert.ok(cp);
  assert.equal(cp.day_in_period, cp.days_elapsed, "day_in_period — алиас days_elapsed");
  assert.equal(cp.expected_end_early, cp.end_early);
  assert.equal(cp.expected_end_late, cp.end_late);
  assert.equal(cp.source, "history");
  assert.equal(cp.confidence, "low", "2 наблюдения → low");
});

test("P1.2: ≥5 наблюдений с разбросом ≤2 — high; свежая запись перевешивает", () => {
  // 5 завершённых по 5 дней + свежий цикл другой длины не ломает оценку.
  const periods = [
    mkPeriod("2026-01-01", 5), mkPeriod("2026-01-30", 5), mkPeriod("2026-03-01", 5),
    mkPeriod("2026-03-30", 5), mkPeriod("2026-04-28", 6),
    { start_date: "2026-05-27", end_date: null },
  ];
  const f = cycleForecast(periods, profile, "2026-06-10");
  assert.equal(f.period_samples, 5);
  assert.equal(f.period_confidence, "high", "5 наблюдений, разброс 5–6 ≤2");
  assert.equal(f.period_unstable, false);
  // Четыре свежих/старых наблюдения по 5 дн. суммарно весят больше одного
  // свежего 6-дневного — взвешенная медиана остаётся 5 (большинство важнее
  // одного свежего замера; перевес свежести виден в тесте «исправление»).
  assert.equal(f.avg_period_length, 5);
});

test("P1.2: одиночный сильный выброс отсекается из оценки, но виден в min/max", () => {
  // 4 обычных по 5 дней + один 12-дневный (вне полосы ±50% от медианы 5).
  const periods = [
    mkPeriod("2026-01-01", 12), mkPeriod("2026-01-30", 5), mkPeriod("2026-02-27", 5),
    mkPeriod("2026-03-27", 5), mkPeriod("2026-04-25", 5),
    { start_date: "2026-05-24", end_date: null },
  ];
  const f = cycleForecast(periods, profile, "2026-06-05");
  assert.equal(f.avg_period_length, 5, "выброс 12 не смещает оценку");
  assert.equal(f.period_min, 5);
  assert.equal(f.period_max, 12, "выброс остаётся в честном диапазоне");
  assert.equal(f.period_unstable, true, "после отсева разброс 5–12 ≥4");
});

test("P1.3: активный контекст понижает качество и расширяет диапазоны", () => {
  const periods = [
    { start_date: "2026-01-01", end_date: "2026-01-05" },
    { start_date: "2026-01-29", end_date: "2026-02-02" },
    { start_date: "2026-02-26", end_date: "2026-03-02" },
    { start_date: "2026-03-26", end_date: "2026-03-30" },
    { start_date: "2026-04-23", end_date: null }, // открытый
  ];
  const plain = cycleForecast(periods, profile, "2026-04-28");
  const ctxProfile = { ...profile, context: JSON.stringify({ very_irregular: true }) };
  const ctx = cycleForecast(periods, ctxProfile, "2026-04-28");
  assert.equal(plain.context_adjusted, false);
  assert.equal(ctx.context_adjusted, true);
  assert.equal(ctx.quality, "few", "full → few при активном контексте");
  assert.ok(ctx.next_period_early < plain.next_period_early, "ранняя граница расширена");
  assert.ok(ctx.next_period_late > plain.next_period_late, "поздняя граница расширена");
  const cp = ctx.current_period;
  assert.ok(cp.expected_end_early < plain.current_period.expected_end_early
    || cp.expected_end_late > plain.current_period.expected_end_late,
    "границы окончания текущего периода тоже шире");
});

test("P1.3: контекст insufficient не «улучшается» и пустой прогноз тоже помечается", () => {
  const one = [{ start_date: "2026-04-23", end_date: null }];
  const f = cycleForecast(one, { ...profile, context: { hormonal_contraception: true } }, "2026-04-28");
  assert.equal(f.context_adjusted, true);
  assert.equal(f.quality, "insufficient", "few → insufficient, ниже не бывает");
  const empty = cycleForecast([], { ...profile, context: { pregnancy: true } }, "2026-04-28");
  assert.equal(empty.context_adjusted, true);
});

// ---------- cycleInsights: прямая агрегация ----------

test("I1: cycleInsights агрегирует кровотечение, симптомы, боль, сон и стресс", () => {
  const logs = [
    { date: "2026-11-01", flow: "heavy", clots: true, symptoms: ["cramps", "headache"], symptoms_clear: false, pain_score: 8, life_impact: "limited", sleep_quality: "poor", sleep_hours: 5, stress: "high", mucus: { consistency: "stringy", amount: "medium" }, sick: true },
    { date: "2026-11-02", flow: "light", clots: false, symptoms: ["cramps"], symptoms_clear: false, pain_score: 4, life_impact: "little", sleep_quality: "good", sleep_hours: 8, stress: "low", mucus: null, sick: false },
    { date: "2026-11-03", flow: null, clots: 0, symptoms: [], symptoms_clear: true, pain_score: null, life_impact: null, sleep_quality: "ok", sleep_hours: null, stress: "medium", mucus: { consistency: "watery", amount: "high" }, sick: true }
  ];
  const ins = cycleInsights(logs, [
    { date: "2026-11-01", kind: "bbt" },
    { date: "2026-11-01", kind: "lh", result: "positive" },
    { date: "2026-11-02", kind: "lh", result: "negative" }
  ]);
  assert.equal(ins.bleeding.flow_days, 2);
  assert.equal(ins.bleeding.heavy_days, 1);
  assert.equal(ins.bleeding.clot_days, 1);
  assert.equal(ins.wellbeing.symptom_days, 3, "symptoms_clear тоже даёт знаменатель");
  assert.equal(ins.wellbeing.top_symptoms[0].code, "cramps");
  assert.equal(ins.wellbeing.top_symptoms[0].count, 2);
  assert.equal(ins.wellbeing.top_symptoms[0].denominator, 3);
  assert.equal(ins.wellbeing.avg_pain, 6);
  assert.equal(ins.wellbeing.pain_days, 2);
  assert.equal(ins.wellbeing.life_impact.limited, 1);
  assert.equal(ins.wellbeing.life_impact.little, 1);
  assert.equal(ins.reproductive.bbt_days, 1);
  assert.equal(ins.reproductive.bbt_days_usable, 0, "день болезни исключён из пригодных БТ");
  assert.equal(ins.reproductive.lh_days, 2);
  assert.equal(ins.reproductive.lh_positive_days, 1);
  assert.equal(ins.reproductive.mucus_days, 2);
  assert.deepEqual(ins.reproductive.mucus_peak_dates, ["2026-11-01", "2026-11-03"]);
  assert.equal(ins.lifecycle?.sleep?.good, undefined);
  assert.equal(ins.lifestyle.sleep.good, 1);
  assert.equal(ins.lifestyle.sleep.ok, 1);
  assert.equal(ins.lifestyle.sleep.poor, 1);
  assert.equal(ins.lifestyle.sleep_hours_avg, 6.5);
  assert.equal(ins.lifestyle.sleep_hours_days, 2);
  assert.equal(ins.lifestyle.stress_days, 3);
  assert.equal(ins.lifestyle.stress.high, 1);
});

test("I2: cycleInsights на пустых и битых данных не падает и отдаёт нули/null", () => {
  const ins = cycleInsights([], []);
  assert.equal(ins.bleeding.flow_days, 0);
  assert.equal(ins.wellbeing.avg_pain, null);
  assert.equal(ins.wellbeing.symptom_days, 0);
  assert.equal(ins.wellbeing.top_symptoms.length, 0);
  assert.equal(ins.reproductive.bbt_days, 0);
  assert.equal(ins.reproductive.mucus_peak_dates.length, 0);
  assert.equal(ins.lifestyle.sleep_hours_avg, null);
  assert.equal(ins.lifestyle.stress_days, 0);
  // Мусорные значения не должны ломать агрегацию.
  const dirty = cycleInsights([
    { date: "2026-11-01", flow: "weird", pain_score: "abc", sleep_hours: "x", mucus: "broken", stress: "extreme", symptoms: null, symptoms_clear: null }
  ], [{ date: "2026-11-01", kind: "unknown" }]);
  assert.equal(dirty.bleeding.flow_days, 1, "неизвестный flow всё равно считается днём с записью");
  assert.equal(dirty.wellbeing.pain_days, 1, "строковая боль считается, avg может быть NaN→null проверяем ниже");
  assert.equal(dirty.reproductive.bbt_days, 0);
});

test("I3:Plugin mucus_peak только для тягучей или обильной водянистой слизи", () => {
  const logs = [
    { date: "2026-11-01", mucus: { consistency: "sticky", amount: "high" } },
    { date: "2026-11-02", mucus: { consistency: "watery", amount: "low" } },
    { date: "2026-11-03", mucus: { consistency: "creamy", amount: "medium" } },
    { date: "2026-11-04", mucus: { consistency: "stringy", amount: "low" } }
  ];
  const ins = cycleInsights(logs, []);
  assert.equal(ins.reproductive.mucus_days, 4);
  assert.deepEqual(ins.reproductive.mucus_peak_dates, ["2026-11-04"], "только stringy и watery+high — пик");
});
