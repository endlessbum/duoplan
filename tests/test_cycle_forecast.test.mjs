import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

// Берём блок Фло из worker.js и исполняем его отдельно: прогноз должен
// совпадать с тем, что видит владелица, без поднятого Worker'а.
const source = readFileSync(new URL("../worker.js", import.meta.url), "utf8");
const block = source.slice(source.indexOf("// ---- Фло"), source.indexOf("async function ensureSchema(env)"));
const { cycleForecast, cycleDayNum, cycleViewForPartner, cycleExportPayload, cycleOnboardPlan, cycleReminderKinds, cycleStats, cyclePhaseTip } = new Function("DEFAULT_TZ", `${block}; return { cycleForecast, cycleDayNum, cycleViewForPartner, cycleExportPayload, cycleOnboardPlan, cycleReminderKinds, cycleStats, cyclePhaseTip };`)("Europe/Moscow");
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

// Приватность: партнёр получает только выбранный уровень шеринга.
const shared = {
  today: "2026-11-12",
  periods: [{ start_date: "2026-11-10", end_date: null }, { start_date: "2026-10-12", end_date: "2026-10-16" }],
  logs: [{ date: "2026-11-12", flow: "light", symptoms: ["cramps"], note: "секретная заметка" }],
  disclaimer: "d",
  forecast: cycleForecast([{ start_date: "2026-10-12", end_date: "2026-10-16" }], profile, "2026-11-12"),
};

test("неизвестный уровень шеринга не открывает ничего", () => {
  assert.deepEqual(cycleViewForPartner(shared, "bogus"), { shared: false });
  assert.deepEqual(cycleViewForPartner(shared, undefined), { shared: false });
});

test("уровень phases: без дат, логов и заметок", () => {
  const v = cycleViewForPartner(shared, "phases");
  const json = JSON.stringify(v);
  assert.equal(v.shared, true);
  assert.equal("periods" in v, false);
  assert.equal("today_log" in v, false);
  assert.equal("next_period_start" in v.forecast, false);
  assert.equal(json.includes("2026-10-12"), false);
  assert.equal(json.includes("секретная"), false);
});

test("уровень periods: даты месячных есть, симптомов и заметок нет", () => {
  const v = cycleViewForPartner(shared, "periods");
  const json = JSON.stringify(v);
  assert.equal(v.periods.length, 2);
  assert.equal("today_log" in v, false);
  assert.equal(json.includes("секретная"), false);
  assert.equal(json.includes("cramps"), false);
});

test("уровень symptoms: флоу и симптомы за сегодня, заметки нет", () => {
  const v = cycleViewForPartner(shared, "symptoms");
  assert.deepEqual(v.today_log, { flow: "light", symptoms: ["cramps"] });
  assert.equal("note" in v.today_log, false);
  assert.equal(JSON.stringify(v).includes("секретная"), false);
});

test("уровень full: заметка за сегодня включается, история логов — нет", () => {
  const v = cycleViewForPartner(shared, "full");
  assert.equal(v.today_log.note, "секретная заметка");
  assert.equal("logs" in v, false);
});

test("экспорт: владелица получает полный журнал и настройки шеринга", () => {
  const payload = cycleExportPayload({
    profile: { avg_cycle_length: 30, avg_period_length: 4, cycle_length_known: 1 },
    share: { enabled: true, level: "periods" },
    periods: [{ start_date: "2026-10-12", end_date: "2026-10-16" }],
    logs: [{ date: "2026-10-13", flow: "heavy", symptoms: ["cramps"], note: "заметка" }],
  }, "2026-11-12T01:00:00.000Z");
  assert.equal(payload.format, "duoplan-cycle");
  assert.deepEqual(payload.profile, { avg_cycle_length: 30, avg_period_length: 4, cycle_length_known: true, share_enabled: true, share_level: "periods" });
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
  const base = { empty: false, phase: "luteal", next_period_in: 5, ovulation_in: 9, delay_days: 0 };
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
  assert.deepEqual(s.phases.menstruation, { days: 1, symptoms: { cramps: 1 }, moods: {}, energy: {}, avg_pain: null });
  assert.deepEqual(s.phases.fertile, { days: 1, symptoms: {}, moods: {}, energy: {}, avg_pain: null });
  assert.deepEqual(s.phases.ovulation, { days: 1, symptoms: { headache: 1 }, moods: {}, energy: {}, avg_pain: null });
  assert.deepEqual(s.phases.luteal, { days: 1, symptoms: { fatigue: 1, cramps: 1 }, moods: {}, energy: {}, avg_pain: null });
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
  const v = cycleViewForPartner(shared, "phases");
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
  const f = { empty: false, phase: "luteal", next_period_in: 3, ovulation_in: 0, delay_days: 0 };
  assert.deepEqual(cycleReminderKinds(f, { period_days: 3 }).map(r => r.kind), ["cycle_period", "cycle_ovulation"]);
  assert.deepEqual(cycleReminderKinds(f, { period_days: 3, ovulation: false }).map(r => r.kind), ["cycle_period"]);
  assert.deepEqual(cycleReminderKinds(f, { period: false, ovulation: false }).map(r => r.kind), []);
  assert.deepEqual(cycleReminderKinds({ empty: false, phase: "delay", next_period_in: -5, ovulation_in: 9, delay_days: 5 }, { delay_days: 5 }).map(r => r.kind), ["cycle_delay"]);
});

// Этап 6/P2: ПМС-паттерны и боль по фазам в статистике.
test("статистика: pms_patterns и avg_pain по фазам", () => {
  const periods = [
    { start_date: "2026-01-01", end_date: "2026-01-05" },
    { start_date: "2026-01-29", end_date: "2026-02-02" },
    { start_date: "2026-02-26", end_date: "2026-03-02" },
  ];
  const logs = [
    // День 25 каждого 28-дневного цикла — за 3 дня до следующего старта.
    { date: "2026-01-26", symptoms: ["bloating"], pain_score: 4 },
    { date: "2026-02-23", symptoms: ["bloating"], pain_score: 6 },
    // Симптом один раз — в паттерн не попадает (cycles < 2).
    { date: "2026-01-10", symptoms: ["headache"] },
  ];
  const s = cycleStats(periods, logs, "2026-03-10", { avg_cycle_length: 28, avg_period_length: 5 });
  const pms = s.pms_patterns.find(p => p.code === "bloating");
  assert.ok(pms, "bloating должен попасть в ПМС-паттерны");
  assert.equal(pms.avg_lead_days, 3);
  assert.equal(pms.cycles, 2);
  assert.ok(!s.pms_patterns.some(p => p.code === "headache"), "одиночный симптом — не паттерн");
  // Оба дня с болью — лютеиновая фаза (овуляция на 14-й день).
  assert.equal(s.phases.luteal.avg_pain, 5);
  assert.equal(s.phases.menstruation, undefined);
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
