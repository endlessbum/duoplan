// UI-проверки вкладки «Здоровье» («Дневник → Записи/Цитаты/Здоровье»):
// личный журнал препаратов, отметки приёма, настройка напоминаний.
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { ok } from "node:assert/strict";
import assert from "node:assert/strict";

const source = readFileSync(new URL("../public/app.js", import.meta.url), "utf8");

// Секция «Здоровье» между renderMemoriesBody и quoteAuthorOptions.
const markerIdx = source.indexOf("// Здоровье: личный журнал препаратов");
const sectionStart = source.lastIndexOf("// ------------------------------------------------------------------", markerIdx);
const section = source.slice(sectionStart, source.indexOf("function quoteAuthorOptions"));

const stubs = `
  const appState = { user: { gender: "female" }, pair: { timezone: "Europe/Moscow" } };
  let memoriesView = "health";
  const document = {
    documentElement: { dataset: { theme: "dark" } },
    addEventListener: () => {},
    getElementById: (id) => ({ value: globalThis.__inputs?.[id] ?? "" }),
    querySelectorAll: () => [],
    createElement: () => ({ click: () => {}, style: {}, setAttribute: () => {} })
  };
  function showToast() {}
  function handleRequestError() {}
  function render() {}
  const EDIT_ICON = "e", DELETE_ICON = "d";
  function esc(v) {
    return String(v ?? "").replace(/[&<>"']/g, ch => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch]));
  }
  function viewerTimeZone() { return "Europe/Moscow"; }
`;

function buildHealth(healthStateValue, extra = {}, reqImpl = null) {
  const requestSrc = reqImpl
    ? `const request = (${reqImpl.toString()});`
    : `const request = () => Promise.reject(new Error("network off"));`;
  const setters = [
    `  healthState = ${JSON.stringify(healthStateValue)};`,
    `  healthBusy = false;`,
    `  healthMedForm = ${JSON.stringify(extra.healthMedForm ?? null)};`,
    `  healthMedDeleteArmed = ${JSON.stringify(extra.healthMedDeleteArmed ?? null)};`
  ].join("\n");
  const src = `${stubs}\n${requestSrc}\n${setters}\n${section}\nreturn { renderHealthBody, renderHealthMedForm, handleHealthAction, loadHealth, getState: () => healthState, getForm: () => healthMedForm, healthToday };`;
  return new Function(src)();
}

const today = new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Moscow", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());

const richState = {
  meds: [
    { id: 7, name: "Магний", dosage: "1 таблетка", form: "tablet", schedule: "после еды", remind_enabled: true, remind_time: "09:00", start_date: "2026-11-01", end_date: null, status: "active", note: "" },
    { id: 9, name: "Витамин D", dosage: "", form: "capsule", schedule: "", remind_enabled: false, remind_time: null, start_date: "2026-10-01", end_date: "2026-11-30", status: "paused", note: "" }
  ],
  med_logs: [{ med_id: 7, date: today, time: null, status: "taken", note: null }]
};

test("H1: сегмент «Дневник» содержит третий вид «Здоровье»", () => {
  ok(source.includes('["quotes", "Цитаты"], ["health", "Здоровье"]'), "сегмент Записи/Цитаты/Здоровье");
  ok(source.includes('memoriesView === "health"'), "переключение вида обслуживается");
});

test("H2: пустой список — приглашение добавить, приватность объяснена", () => {
  const ui = buildHealth({ meds: [], med_logs: [] });
  const html = ui.renderHealthBody();
  assert.ok(html.includes("Пока нет препаратов"));
  assert.ok(html.includes("Добавить препарат"));
  assert.ok(html.includes("не видны партнёру"), "личный журнал: партнёр не видит");
});

test("H3: список препаратов — статус, напоминание, отметки за сегодня", () => {
  const ui = buildHealth(richState);
  const html = ui.renderHealthBody();
  assert.ok(html.includes("Магний"));
  assert.ok(html.includes("Витамин D"));
  assert.ok(html.includes("Напоминание: 09:00"), "включённое напоминание видно");
  assert.ok(html.includes("принято 1 · пропущено 0"));
  const takenChip = html.match(/<button[^>]*data-action="health-intake"[^>]*data-med="7"[^>]*>/);
  assert.ok(takenChip && /is-on/.test(takenChip[0]), "отметка «принят» подсвечена");
  assert.ok(html.includes("общий итог за день"), "дневной статус честно подписан");
});

test("H4: у препарата на паузе нет чипов приёма", () => {
  const ui = buildHealth(richState);
  const html = ui.renderHealthBody();
  const row = html.slice(html.indexOf("Витамин D"), html.indexOf("Витамин D") + 1200);
  assert.ok(!row.includes('data-action="health-intake"'), "пауза — отметок приёма нет");
});

test("H5: форма препарата содержит настройку напоминания", () => {
  const form = { name: "", dosage: "", form: "", schedule: "", remind_enabled: true, remind_time: "09:00", start_date: today, end_date: "", status: "active", note: "" };
  const ui = buildHealth({ meds: [], med_logs: [] }, { healthMedForm: form });
  const html = ui.renderHealthMedForm();
  assert.ok(html.includes("health-med-remind-time"), "время напоминания вводится");
  assert.ok(html.includes("Напоминание: включено"));
  assert.ok(html.includes("Бот напомнит о приёме в указанное время"));
  assert.ok(html.includes("Точно удалить") === false, "для нового препарата кнопки удаления нет");
});

test("H6: отметка приёма уходит в /api/health/med-log с личной датой", async () => {
  globalThis.__calls = [];
  globalThis.__healthState = richState;
  const ui = buildHealth(richState, {}, async (url, opts) => {
    globalThis.__calls.push({ url, body: opts?.body });
    return { ...globalThis.__healthState, med_logs: [] };
  });
  await ui.handleHealthAction("health-intake", { dataset: { med: "7", status: "taken" } });
  const call = globalThis.__calls[0];
  assert.ok(call.url.includes("/api/health/med-log"));
  assert.equal(call.body.med_id, 7);
  assert.equal(call.body.status, "taken");
  assert.ok(/^\d{4}-\d{2}-\d{2}$/.test(call.body.date), "дата — личный день зрителя");
  delete globalThis.__calls;
  delete globalThis.__healthState;
});

test("H7: включение напоминания без времени открывает форму", async () => {
  const noTime = { meds: [{ ...richState.meds[0], remind_enabled: false, remind_time: null }], med_logs: [] };
  const ui = buildHealth(noTime);
  await ui.handleHealthAction("health-remind-toggle", { dataset: { med: "7", enabled: "true" } });
  const form = ui.getForm();
  assert.ok(form && form.remind_enabled === true, "форма открыта с включённым напоминанием");
  assert.equal(form.id, 7);
});

test("H8: переключение напоминания сохраняет препарат целиком", async () => {
  globalThis.__calls = [];
  const ui = buildHealth(richState, {}, async (url, opts) => {
    globalThis.__calls.push({ url, body: opts?.body });
    return richState;
  });
  await ui.handleHealthAction("health-remind-toggle", { dataset: { med: "7", enabled: "false" } });
  const call = globalThis.__calls[0];
  assert.ok(call.url.includes("/api/health/med"));
  assert.equal(call.body.id, 7);
  assert.equal(call.body.remind_enabled, false);
  assert.equal(call.body.name, "Магний", "поля препарата передаются на сервер целиком");
  delete globalThis.__calls;
});

test("H9: сохранение препарата — напоминание выключено, время не уходит", async () => {
  globalThis.__inputs = { "health-med-name": "Магний", "health-med-dosage": "", "health-med-form": "tablet", "health-med-status": "active", "health-med-schedule": "", "health-med-start": today, "health-med-end": "", "health-med-note": "", "health-med-remind-time": "09:00" };
  globalThis.__calls = [];
  const ui = buildHealth({ meds: [], med_logs: [] }, { healthMedForm: { name: "", remind_enabled: false, start_date: today } }, async (url, opts) => {
    globalThis.__calls.push({ url, body: opts?.body });
    return { meds: [], med_logs: [] };
  });
  await ui.handleHealthAction("health-med-save", { dataset: {} });
  const call = globalThis.__calls[0];
  assert.ok(call.url.includes("/api/health/med"));
  assert.equal(call.body.remind_enabled, false);
  assert.equal(call.body.remind_time, null, "выключенное напоминание шлёт null");
  delete globalThis.__inputs;
  delete globalThis.__calls;
});

test("H10: ошибка загрузки — повторить; загрузка — «Загружаем список…»", () => {
  const failed = buildHealth({ failed: true });
  assert.ok(failed.renderHealthBody().includes("Повторить"));
  const loading = buildHealth(null);
  assert.ok(loading.renderHealthBody().includes("Загружаем список"));
});
