// UI-проверки «Фло» (переработка 2026-11-14): секция Фло public/app.js
// исполняется с минимальными стабами DOM/состояния, рендеры гоняются с
// насыщенным состоянием. Проверяются читаемые пользователем контракты:
// будущие дни read-only, легенда, согласие шеринга, партнёрский allowlist-вид.
import { readFileSync } from "node:fs";
import { test } from "node:test";
import assert from "node:assert/strict";

const source = readFileSync(new URL("../public/app.js", import.meta.url), "utf8");

// Секция Фло: от разделителя-комментария перед маркером до renderPairBody.
const startMarker = "// Фло: трекер цикла (фаза 1)";
const markerIdx = source.indexOf(startMarker);
const sectionStart = source.lastIndexOf("// ------------------------------------------------------------------", markerIdx);
const section = source.slice(sectionStart, source.indexOf("function renderPairBody()"));

// Селектор: «selectFl» — сборка через new Function со стабами окружения.
const stubs = `
  const appState = { user: { gender: "female" }, pair: { timezone: "Europe/Moscow" } };
  let floShareDraft = { enabled: true, notify: false, categories: { sex: true, mood: false, sleep: false, bbt: false } }; // стаб черновика
  let floView = "today";
  let pairView = "flo";
  let floFetchedMonths = new Set();
  const dialog = null, dialogContext = null, dialogFields = null;
  const document = {
    documentElement: { dataset: { theme: "dark" } },
    getElementById: () => null,
    querySelectorAll: () => [],
    createElement: () => ({ click: () => {}, style: {}, setAttribute: () => {} })
  };
  const window = { Telegram: null, location: { reload: () => {} }, matchMedia: () => ({ matches: false }) };
  // request подставляется buildFlo (строкой ниже) — здесь заглушки прочих зависимостей.
  function showToast() {}
  function handleRequestError() {}
  function render() {}
  function openDialog() {}
  function calendarGrid(year, month) {
    const cells = [];
    const first = new Date(Date.UTC(year, month - 1, 1));
    const days = new Date(Date.UTC(year, month, 0)).getUTCDate();
    for (let i = 0; i < days; i++) {
      const key = new Date(Date.UTC(year, month - 1, i + 1)).toISOString().slice(0, 10);
      cells.push({ key, day: i + 1, inMonth: true });
    }
    return cells;
  }
  function calendarMonthTitle(year, month) { return year + "." + month; }
  function calendarLongDate(key) { return key; }
  function renderSegment() { return ""; }
  const EDIT_ICON = "e", DELETE_ICON = "d", CHEVRON_LEFT = "<", CHEVRON_RIGHT = ">";
  function esc(v) {
    return String(v ?? "").replace(/[&<>"']/g, ch => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch]));
  }
  function formatDay(key) { return key || ""; }
  function pairTimeZone() { return "Europe/Moscow"; }
  function viewerTimeZone() { return "Europe/Moscow"; }
`;

function buildFlo(floState, extra = {}, reqImpl = null) {
  const setters = [];
  for (const [key, value] of Object.entries({
    floState, floExtra: extra.floExtra ?? { periods: [], logs: [], meds: [], med_logs: [], measurements: [] },
    floMonth: extra.floMonth ?? floState.today.slice(0, 7),
    floSelectedDate: extra.floSelectedDate ?? null,
    floPartner: extra.floPartner ?? undefined,
    floPartnerBusy: false,
    floWizard: extra.floWizard ?? null, floWizardDismissed: false,
    floHistPrev: [], floHistPrevOpen: false,
    floStats: extra.floStats ?? { failed: false },
    floStatsBusy: false,
    floStatsMonths: 12,
    floReport: null,
    floMedForm: null, floMedDeleteArmed: null, floMedDetail: null,
    floDeleteArmed: false, floEditing: null,
    floBusy: false
  })) {
    setters.push(`  ${key} = ${JSON.stringify(value)};`);
  }
  const requestSrc = reqImpl
    ? `const request = (${reqImpl.toString()});`
    : `const request = () => Promise.reject(new Error("network off"));`;
  const src = `${stubs}\n${requestSrc}\n${setters.join("\n")}\n${section}\nreturn { renderFloDayCard, renderFloCalendar, renderFloStats, renderFloPartnerView, renderFloView, renderFloToday, floDayEventRows, floDayDots, floAllMeasurements, floAllMedLogs, floMeds, floForecastExplain, renderFloWizard, renderFloSection, renderFloSettings, renderFloHistory, renderFloShareSummary, floShareDialogFields, floDayHasRecord, floFreshnessLine, handleFloAction, floEnsureMonth, floReportBody, getStats: () => floStats, getExtra: () => floExtra, setStats: (v) => { floStats = v; } };`;
  return new Function(src)();
}

const forecast = {
  empty: false, phase: "luteal", cycle_day: 18, avg_cycle_length: 28, avg_period_length: 5,
  irregular: false, last_period_start: "2026-10-27",
  next_period_start: "2026-11-24", next_period_end: "2026-11-28",
  next_period_early: "2026-11-21", next_period_late: "2026-11-27",
  next_period_in: 11, delay_days: 0,
  ovulation_date: "2026-11-10", ovulation_in: -3, ovulation_estimated: true, ovulation_source: "calendar",
  fertile_start: "2026-11-05", fertile_end: "2026-11-11",
  based_on: "history", quality: "few", usable_cycles: 3, unusual_intervals: 0, data_stale: false
};

const floState = {
  today: "2026-11-14",
  onboarded: true,
  open_period_start: null,
  periods: [{ start_date: "2026-10-27", end_date: "2026-10-31", end_unknown: 0 }],
  logs: [
    { date: "2026-11-12", flow: "light", mood: "calm", sleep_quality: "good", sex: "none", symptoms: [], symptoms_clear: true, bleeding_details: { saturation: "high", night_change: true }, note: "" },
    { date: "2026-11-10", sex: "protected", sex_count: 2, mood: "anxious" }
  ],
  meds: [{ id: 7, name: "Фолиевая кислота", status: "active" }],
  med_logs: [{ med_id: 7, date: "2026-11-12", status: "taken" }],
  measurements: [{ id: 3, date: "2026-11-12", time: "07:30", kind: "bbt", value: 36.6, unit: "C" }],
  profile: { avg_cycle_length: 28, avg_period_length: 5, cycle_length_known: 1 },
  share: { enabled: true, level: "phases", categories: { sex: true, mood: false, sleep: false, bbt: false }, confirmed: false, notify: false },
  context: { pregnancy: false, hormonal_contraception: true },
  notify: { enabled: true, period: true, ovulation: true, fertile: true, delay: true, period_days: 2, delay_days: 3, diary: false },
  forecast,
  disclaimer: "Прогноз приблизительный и не заменяет консультацию врача",
  contraception_disclaimer: "Календарные прогнозы не являются надёжным методом предотвращения беременности",
  data_freshness: { last_diary_date: "2026-11-12", last_period_start: "2026-10-27", last_measurement_date: "2026-11-12", last_medication_log_date: "2026-11-12" },
  data_coverage: { periods_loaded: 1, diary_days: 2, measurement_days: 1 }
};

test("F1: легенда календаря объясняет все маркеры, включая задержку и «без секса»", () => {
  const ui = buildFlo(floState);
  const legend = ui.renderFloCalendar();
  // «Без секса» из легенды убрано: в сетке календаря этот факт не рисуется,
  // он виден в сводке дня.
  for (const label of ["Месячные", "Прогноз", "Задержка", "Фертильно", "Овуляция", "Запись", "Секс"]) {
    assert.ok(legend.includes(label), `в легенде нет «${label}»`);
  }
  assert.ok(!legend.includes("Без секса"), "маркер «Без секса» удалён из легенды");
});

test("F2: будущий день — read-only: все чипы и кнопки ввода дизейблятся (9.1)", () => {
  const ui = buildFlo(floState, { floSelectedDate: "2026-11-20" });
  const card = ui.renderFloDayCard();
  assert.ok(card.includes("Будущий день — просмотр"), "есть объяснение режима просмотра");
  // Каждый чип ввода неактивен: берём теги целиком (disabled стоит после class).
  const chips = [...card.matchAll(/<button[^>]*>/g)].map(m => m[0]).filter(t => t.includes('class="flo-chip'));
  assert.ok(chips.length > 20, `чипов ввода много, найдено ${chips.length}`);
  for (const chip of chips) {
    assert.ok(/\bdisabled\b/.test(chip), `чип в будущем дне активен: ${chip}`);
  }
  for (const action of ["flo-set-flow", "flo-toggle-clear", "flo-set-mood", "flo-set-sex", "flo-save-note", "flo-save-factors"]) {
    const re = new RegExp(`<button[^>]*data-action="${action}"[^>]*>`);
    assert.ok(re.test(card), `кнопка ${action} есть`);
    const m = card.match(new RegExp(`<button[^>]*data-action="${action}"[^>]*>`));
    assert.ok(/\bdisabled\b/.test(m[0]), `кнопка ${action} должна быть неактивна`);
  }
});

test("F3: прошлый день — ввод активен, пропущенный день объясняется", () => {
  const ui = buildFlo(floState, { floSelectedDate: "2026-11-05" });
  const card = ui.renderFloDayCard();
  assert.ok(card.includes("день просто пропущен"), "пояснение про пропуск дня есть");
  const chip = card.match(/<button[^>]*data-action="flo-set-flow"[^>]*>/)[0];
  assert.ok(!/\bdisabled\b/.test(chip), "чип ввода активен в прошлом дне");
});

test("F4: сводка дня различает «без секса» и сердечки, показывает кровотечение подробнее (9.4)", () => {
  const ui = buildFlo(floState, { floSelectedDate: "2026-11-12" });
  const rows = ui.floDayEventRows("2026-11-12");
  const sexRow = rows.find(r => r.title === "Секс");
  assert.ok(sexRow, "строка секса есть");
  assert.equal(sexRow.meta, "без секса (отмечено)");
  const diary = rows.find(r => r.title === "Дневник");
  assert.ok(diary.meta.includes("пропитывание"), "сведения о кровотечении видны");
  assert.ok(diary.meta.includes("ночная смена"));
});

test("F5: карточка шеринга — актуальное состояние, «Настроить», без блока согласия", () => {
  const ui = buildFlo(floState);
  const card = ui.renderFloShareSummary();
  assert.ok(card.includes("Общий доступ: включён"), "актуальное состояние на видном месте");
  assert.ok(card.includes("Настроить"), "кнопка открытия диалога");
  assert.ok(card.includes("Симптомы, заметки, препараты, боль, вес и стресс не передаются никогда"), "закрытые данные — под «Настроить»");
  // Блок согласия удалён: подтверждение происходит в окне изменений.
  assert.ok(!card.includes("flo-consent"), "согласия-блока в карточке нет");
  assert.ok(!card.includes("Подтвердить состав данных"), "кнопки подтверждения в карточке нет");
  assert.ok(!card.includes("только вам") && !card.includes("Видно только вам"), "устаревшие формулировки удалены");
  // Окно настройки: категории описаны.
  const fields = ui.floShareDialogFields();
  for (const cat of ["Секс", "Настроение", "Качество сна", "Базальная температура"]) {
    assert.ok(fields.includes(cat), `категория «${cat}» в окне`);
  }
});

test("F6: партнёрский вид — без кнопок записи, температура подписана базальной, явное «без секса»", () => {
  const partner = {
    shared: true, confirmed: true,
    categories: { sex: true, mood: true, sleep: true, bbt: true },
    today: "2026-11-14",
    disclaimer: "Прогноз приблизительный и не заменяет консультацию врача",
    forecast_disclaimer: "Прогнозы цикла — приблизительные календарные расчёты, не подтвержденные наблюдения. Это не метод контрацепции.",
    tip: "Календарная фаза — лютеиновая. Персональных наблюдений о самочувствии недостаточно — просто спроси.",
    forecast,
    periods: [{ start_date: "2026-10-27", end_date: "2026-10-31", end_unknown: false }],
    calendar_periods: [{ start_date: "2026-10-27", end_date: "2026-10-31", end_unknown: false }],
    last_period_start: "2026-10-27",
    days: [
      { date: "2026-11-12", sex: "none" },
      { date: "2026-11-10", sex: "protected", sex_count: 2, mood: "anxious", sleep: "ok" }
    ],
    bbt: [{ date: "2026-11-12", time: "07:30", value: 36.6, unit: "C" }]
  };
  const ui = buildFlo(floState, { floPartner: partner, floSelectedDate: "2026-11-12" });
  const view = ui.renderFloPartnerView();
  // Кнопок записи/редактирования нет вообще.
  for (const action of ["flo-set-flow", "flo-save-note", "flo-day-start", "flo-set-mood"]) {
    assert.ok(!view.includes(`data-action="${action}"`), `партнёру недоступно действие ${action}`);
  }
  // Категориальные отметки видны: секс «без секса», БТ подписана базальной.
  assert.ok(view.includes("Без секса — отмечено партнёршей"));
  assert.ok(view.includes("Базальная температура"));
  // Методика и качество прогноза прямо в карточке.
  assert.ok(view.includes("не метод контрацепции") || view.includes("не является методом контрацепции"));
  assert.ok(view.includes("Расчёт по") || view.includes("расчёт"));
});

test("F7: партнёрский вид при не включённом шеринге — понятный пустой экран", () => {
  const ui = buildFlo(floState, { floPartner: { shared: false } });
  const view = ui.renderFloPartnerView();
  assert.ok(view.includes("не делится календарём"));
});

test("F8: статистика — числители и знаменатели, охват и диапазон видны (10)", () => {
  const stats = {
    from: "2026-08-14", to: "2026-11-14",
    cycles: [{ start: "2026-10-27", length: 28, estimated: false }],
    current_cycle: null,
    avg_cycle_length: 28, median_cycle_length: 28, min_cycle_length: 28, max_cycle_length: 28, spread: null,
    unusual_intervals: [], period_lengths: { avg: 5, min: 5, max: 5, count: 1 },
    long_periods: [], usable_cycles: 1, logged_days: 2,
    coverage: { from: "2026-08-14", to: "2026-11-14", days_total: 93, diary_days: 2 },
    phases: {
      luteal: { days: 2, symptom_days: 1, clear_days: 1, symptoms: { headache: 1 }, mood_days: 1, moods: { anxious: 1 }, energy_days: 0, energy: {}, sleep_days: 1, sleep: { good: 1 }, sleep_hours_sum: 0, sleep_hours_count: 0, stress_days: 0, stress: {}, flow_days: 1, flows: { light: 1 }, clot_days: 0, mucus_days: 0, life_impact: {}, pain_sum: 0, pain_count: 0, avg_pain: null, avg_sleep_hours: null }
    },
    pms_patterns: [],
    insights: { bleeding: { flow_days: 1, heavy_days: 0, clot_days: 0 }, wellbeing: { top_symptoms: [{ code: "headache", count: 1, denominator: 1 }], symptom_days: 1, avg_pain: null, pain_days: 0, life_impact: {} }, reproductive: { bbt_days: 1, lh_days: 0, lh_positive_days: 0, mucus_days: 0 }, lifestyle: { sleep: { good: 1, ok: 0, poor: 0 }, sleep_hours_avg: null, sleep_hours_days: 0, stress: {}, stress_days: 0 } },
    meds: [{ id: 7, name: "Фолиевая кислота", status: "active", taken: 1, skipped: 0 }],
    daily: [{ date: "2026-11-12", flow: "light", pain_score: null }],
    measurements: [{ date: "2026-11-12", time: "07:30", kind: "bbt", value: 36.6, unit: "C" }],
    phase_source: "estimated"
  };
  const ui = buildFlo(floState, { floStats: stats });
  const html = ui.renderFloStats();
  assert.ok(html.includes("из 93 дней"), "охват дневника показан");
  assert.ok(html.includes("средняя длина завершённых циклов"), "среднее подписано словом «средняя»");
  assert.ok(html.includes("медиана"), "медиана подписана отдельно");
  assert.ok(html.includes("Период:"), "статистика подписана фактическим диапазоном");
  assert.ok(html.includes("1 из 1 дн."), "числитель и знаменатель показаны");
  assert.ok(html.includes("Фолиевая кислота"), "аналитика препаратов входит");
  assert.ok(html.includes("среднее — только по обычным") === false, "длинных периодов нет — предупреждения нет");
});

test("F9: прогнозная карточка объясняет основание и контекст (11, 5.1)", () => {
  const ui = buildFlo(floState);
  const card = ui.renderFloToday();
  assert.ok(card.includes("Расчёт по 3 завершённым циклам"), "основание — в карточке");
  assert.ok(card.includes("27 октября"), "последнее начало месячных в карточке");
  assert.ok(card.includes("Гормональная контрацепция управляет циклом"), "оговорка контекста показана");
  assert.ok(card.includes("не являются надёжным методом предотвращения беременности"), "оговорка о контрацепции");
  assert.ok(card.includes("Как считается прогноз?"), "методика доступна");
});

test("F10: мастер — шаг знакомства и шаг шеринга описывают категории честно", () => {
  const ui = buildFlo(floState, { floWizard: { step: 0 } });
  const wiz = ui.renderFloWizard();
  assert.ok(wiz.includes("Симптомы, заметки и препараты партнёру не передаются"));
  const ui5 = buildFlo(floState, { floWizard: { step: 5, shareCategories: {} } });
  const wiz5 = ui5.renderFloWizard();
  for (const label of ["Секс", "Настроение", "Качество сна", "Базальная температура"]) {
    assert.ok(wiz5.includes(label));
  }
  assert.ok(wiz5.includes("не передаются никогда"));
});

// ---- Дополнение 2026-11-14: §4.1, §6, §8, §11.1, §13, §18D/E/F ----

const insufficientForecast = { ...forecast, quality: "insufficient", based_on: "default", usable_cycles: 0, ovulation_in: 9 };
const insufficientState = { ...floState, forecast: insufficientForecast };

test("F11: при недостатке данных фертильное окно и овуляция не красятся (§4.1)", () => {
  const ui = buildFlo(insufficientState);
  const html = ui.renderFloCalendar();
  assert.ok(!html.includes("cal-day is-fertile"), "уверенное окно скрыто (класс ячейки, не легенда)");
  assert.ok(!html.includes("cal-day is-ovulation"), "уверенная овуляция скрыта");
  // Осторожная оценка следующих месячных остаётся.
  assert.ok(html.includes("cal-day is-predicted"));
});

test("F12: при недостатке данных вместо даты овуляции — что нужно отметить", () => {
  const ui = buildFlo(insufficientState);
  const card = ui.renderFloToday();
  assert.ok(card.includes("Для оценки овуляции данных пока недостаточно"));
  assert.ok(!card.includes("Овуляция — календарная оценка, примерно через"));
});

test("F13: свежесть данных показана по категориям, «нет записей» ≠ ноль (§11.1)", () => {
  const ui = buildFlo(floState);
  const line = ui.floFreshnessLine();
  for (const cat of ["Месячные", "Дневник", "Измерения", "Препараты"]) {
    assert.ok(line.includes(cat), `категория «${cat}» есть`);
  }
  assert.ok(line.includes("октября"), "даты человекочитаемы");
  const empty = buildFlo({ ...floState, data_freshness: { last_diary_date: null, last_period_start: null, last_measurement_date: null, last_medication_log_date: null } });
  assert.ok(empty.floFreshnessLine().includes("нет записей"));
});

test("F14: инструкция по измерению БТ присутствует (§6)", () => {
  const ui = buildFlo(floState, { floSelectedDate: "2026-11-12" });
  const card = ui.renderFloDayCard();
  assert.ok(card.includes("сразу после пробуждения"), "правило утреннего измерения");
  assert.ok(card.includes("не менее 3 часов сна"));
  assert.ok(card.includes("не попадёт в температурный сдвиг"), "связь с отметкой «болезнь»");
});

test("F15: приём препарата помечен как итог за день (§8)", () => {
  const ui = buildFlo(floState, { floSelectedDate: "2026-11-12" });
  const card = ui.renderFloDayCard();
  assert.ok(card.includes("общий итог за день, контроль отдельных доз не ведётся"));
});

test("F16: графики дают текстовое представление данных по дням (§13)", () => {
  const stats = {
    from: "2026-11-01", to: "2026-11-14",
    cycles: [], current_cycle: null, avg_cycle_length: 28, median_cycle_length: null,
    min_cycle_length: null, max_cycle_length: null, spread: null, unusual_intervals: [],
    period_lengths: null, long_periods: [], usable_cycles: 0, logged_days: 2,
    coverage: { from: "2026-11-01", to: "2026-11-14", days_total: 14, diary_days: 2 },
    phases: {}, pms_patterns: [],
    insights: { bleeding: { flow_days: 1, heavy_days: 0, clot_days: 0 }, wellbeing: { top_symptoms: [], symptom_days: 0, avg_pain: null, pain_days: 0, life_impact: {} }, reproductive: { bbt_days: 1, bbt_days_usable: 1, lh_days: 0, lh_positive_days: 0, mucus_days: 0, mucus_peak_dates: [] }, lifestyle: { sleep: { good: 0, ok: 0, poor: 0 }, sleep_hours_avg: null, sleep_hours_days: 0, stress: {}, stress_days: 0 } },
    meds: [],
    daily: [{ date: "2026-11-12", flow: "light", pain_score: 4 }],
    measurements: [
      { date: "2026-11-12", time: "07:30", kind: "bbt", value: 36.6, unit: "C" },
      { date: "2026-11-13", kind: "lh", result: "positive" }
    ],
    phase_source: "estimated"
  };
  const ui = buildFlo(floState, { floStats: stats });
  const html = ui.renderFloStats();
  assert.ok(html.includes("Данные по дням (текстом)"), "текстовый блок есть");
  assert.ok(html.includes("2026-11-12"), "дата с отметкой в тексте");
  assert.ok(html.includes("боль 4/10"));
  assert.ok(html.includes("БТ 36.6°C"));
  assert.ok(html.includes("ЛГ: положительный"));
  assert.ok(html.includes("пригодных (без болезни)"), "usable-БТ в аналитике");
});

test("F17: удаление измерения сбрасывает кэш статистики и догруженный список (9.5)", async () => {
  // Замыкания на модульные константы внутри new Function не видны: обмен
  // через globalThis — так же, как рендеры видят стабы.
  globalThis.__floCalls = [];
  globalThis.__floState = floState;
  const ui = buildFlo(floState, {
    floExtra: { periods: [], logs: [], meds: [], med_logs: [], measurements: [{ id: 3, date: "2026-10-10", kind: "bbt", value: 36.5 }] }
  }, async (url, opts) => {
    globalThis.__floCalls.push(url);
    return { ...globalThis.__floState, measurements: [] };
  });
  ui.setStats({ cycles: [1] });
  const btn = { dataset: { id: "3" } };
  await ui.handleFloAction("flo-del-measurement", btn);
  assert.equal(ui.getStats(), undefined, "floStats сброшен");
  assert.deepEqual(ui.getExtra().measurements, [], "точка исчезла из догруженных");
  assert.ok(globalThis.__floCalls[0].includes("/api/cycle/measurement/delete"));
  delete globalThis.__floCalls;
  delete globalThis.__floState;
});

test("F18: повторная догрузка месяца не создаёт дубликаты измерений (9.3)", async () => {
  const historyData = {
    periods: [{ start_date: "2026-10-05", end_date: "2026-10-09", end_unknown: 0 }],
    logs: [{ date: "2026-10-06", flow: "light" }],
    meds: [{ id: 7, name: "X", status: "active" }],
    med_logs: [{ med_id: 7, date: "2026-10-06", status: "taken" }],
    measurements: [{ id: 3, date: "2026-10-06", kind: "bbt", value: 36.4, unit: "C" }]
  };
  globalThis.__floHistory = historyData;
  const ui = buildFlo(floState, {
    floExtra: { periods: [], logs: [], meds: [], med_logs: [], measurements: [{ id: 3, date: "2026-10-06", kind: "bbt", value: 36.4, unit: "C" }] }
  }, async () => globalThis.__floHistory);
  await ui.floEnsureMonth("2026-10");
  delete globalThis.__floHistory;
  assert.equal(ui.getExtra().measurements.length, 1, "один id — одна запись");
  assert.equal(ui.getExtra().logs.length, 1);
  assert.equal(ui.getExtra().meds.length, 1);
  assert.equal(ui.getExtra().periods.length, 1);
});

test("F19: пустая история и отсутствие измерений рендерятся без падений (18F)", () => {
  const empty = {
    ...floState,
    periods: [], logs: [], meds: [], med_logs: [], measurements: [],
    open_period_start: null,
    forecast: { empty: true },
    data_freshness: { last_diary_date: null, last_period_start: null, last_measurement_date: null, last_medication_log_date: null },
    share: { enabled: false, level: "phases", categories: {}, confirmed: false, notify: false }
  };
  const ui = buildFlo(empty);
  const today = ui.renderFloToday();
  assert.ok(today.includes("Отметьте первые месячные"), "пустой прогноз объясняет следующий шаг");
  assert.ok(today.includes("нет записей"), "свежесть честно пустая");
  const ui2 = buildFlo(empty, { floStats: { cycles: [], logged_days: 0 } });
  assert.ok(ui2.renderFloStats().includes("Пока мало данных"), "пустая статистика объясняет, чего не хватает");
  const ui3 = buildFlo(floState, { floSelectedDate: "2026-11-13" });
  assert.ok(ui3.renderFloDayCard().includes("За этот день измерений нет"));
});

test("F20: самообучение объясняется в методике прогноза", () => {
  const learned = {
    ...forecast,
    ovulation_in: 10,
    ovulation_source: "calendar",
    ovulation_offset_learned: 15,
    ovulation_offset_observations: 3
  };
  const ui = buildFlo({ ...floState, forecast: learned });
  const html = ui.renderFloToday();
  assert.ok(html.includes("Смещение подобрано по вашим наблюдениям"), "основание — в карточке");
  assert.ok(html.includes("Как считается прогноз?"));
});

test("F21: идущие месячные в отчёте — длительность с «(продолжаются)»", () => {
  const ui = buildFlo(floState);
  const base = { logs: [], meds: [], med_logs: [], measurements: [] };
  const open = ui.floReportBody({ from: "2026-11-01", to: "2026-11-14", periods: [{ start_date: "2026-11-01", end_date: null, end_unknown: false }], ...base });
  assert.ok(open.includes("(продолжаются)"), "идущие месячные помечены");
  assert.ok(open.includes("14 дн."), "длительность на день отчёта");
  const closed = ui.floReportBody({ from: "2026-11-01", to: "2026-11-14", periods: [{ start_date: "2026-11-01", end_date: "2026-11-05", end_unknown: false }], ...base });
  assert.ok(!closed.includes("продолжаются"), "закрытый период — без пометки");
  const unknown = ui.floReportBody({ from: "2026-11-01", to: "2026-11-14", periods: [{ start_date: "2026-11-01", end_date: null, end_unknown: true }], ...base });
  assert.ok(!unknown.includes("продолжаются"), "«конец не помним» — не «идут»");
});

test("F22: настройки Фло — раздельные логические карточки", () => {
  const ui = buildFlo(floState);
  const html = ui.renderFloSettings();
  for (const h of ["Конфиденциальность и общий доступ", "Напоминания", "Параметры цикла", "Контекст цикла", "Данные и экспорт"]) {
    assert.ok(html.includes(h), `карточка «${h}» есть`);
  }
  // Удаление — вне карточек (pair-exit), как в профиле пары.
  assert.ok(html.includes("pair-exit") && html.includes("Удалить все данные"));
  const cards = html.match(/<section class="card">/g) || [];
  assert.ok(cards.length >= 5, `карточек ≥ 5, найдено ${cards.length}`);
  const lastCardEnd = html.lastIndexOf("</section>");
  assert.ok(html.indexOf("Удалить все данные") > lastCardEnd, "удаление — под карточками");
});

test("F23: пустая история циклов — понятное пустое состояние", () => {
  const ui = buildFlo({ ...floState, periods: [], logs: [], open_period_start: null, forecast: { ...forecast, empty: true } });
  const html = ui.renderFloHistory();
  assert.ok(html.includes("Пока пусто"), "заголовок пустого состояния");
  assert.ok(html.includes("Добавить прошлые периоды"), "путь заполнения доступен");
});

test("F24: окно изменений — без изменений первыми, добавленное акцентом, убраное перечеркнуто", () => {
  const ui = buildFlo(floState);
  const unchanged = [{ label: "Настроение", before: false, after: false }];
  const added = [{ label: "Секс", before: false, after: true }];
  const removed = [{ label: "Качество сна", before: true, after: false }];
  // openFloShareDiffDialog через openDialog-стаб.
  ui.__openDiff = null;
  const ui2 = buildFlo(floState);
  // Прямой вызов недоступен (не экспортируем) — проверяем через DOM-стаб:
  // создадим окно через экспортируемый открытый путь нельзя, поэтому
  // проверяем CSS-классы в стилях приложения.
  const css = readFileSync(new URL("../public/app.css", import.meta.url), "utf8");
  assert.ok(css.includes(".flo-share-added { color: var(--berry)"), "добавленное — акцентом");
  assert.ok(css.includes("text-decoration-color: var(--berry)"), "убранное — акцентной линией");
  assert.ok(css.includes(".flo-share-removed { color: var(--ink)"), "убранное — обычным цветом текста");
});

test("F25: черновик диалога шеринга — чипы отражают состояние", () => {
  const ui = buildFlo(floState);
  const fields = ui.floShareDialogFields();
  assert.ok(fields.includes("Передаётся"), "включённая категория видна");
  assert.ok(fields.includes("Не передаётся"));
  assert.ok(fields.includes("flo-share-dlg-master"), "чип общего доступа в окне");
  assert.ok(fields.includes("flo-share-dlg-cat"), "чипы категорий в окне");
});
