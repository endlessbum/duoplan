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
  function showToast(m) { globalThis.__toasts.push(m); }
  globalThis.__toasts = [];
  globalThis.__dialogs = [];
  function openDialog(cfg) { globalThis.__dialogs.push(cfg); }
  const dialog = { close: () => {} };
  function handleRequestError() {}
  function render() {}
  const EDIT_ICON = "e", DELETE_ICON = "d", COPY_ICON = "c";
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
    `  healthBusy = false;`
  ].join("\n");
  const src = `${stubs}\n${requestSrc}\n${setters}\n${section}\nreturn { renderHealthBody, healthMedDialogFields, healthMedBodyFromForm, openHealthMedDialog, handleHealthAction, loadHealth, getState: () => healthState, getDialogs: () => globalThis.__dialogs, healthToday };`;
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
  assert.ok(!html.includes("Пока нет препаратов"), "пустой список не сопровождается подписью");
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

test("H5: диалог препарата содержит настройку напоминания", () => {
  const ui = buildHealth({ meds: [], med_logs: [] });
  const fields = ui.healthMedDialogFields(null);
  assert.ok(fields.includes('name="remind_time"'), "время напоминания вводится");
  assert.ok(fields.includes('name="remind_enabled"'), "переключатель напоминания есть");
  assert.ok(fields.includes("Бот напомнит о приёме в указанное время"));
  assert.ok(fields.includes("Удалить препарат") === false, "для нового препарата кнопки удаления нет");
  const editing = ui.healthMedDialogFields({ id: 7, name: "Магний", remind_enabled: true, remind_time: "09:00" });
  assert.ok(editing.includes("Удалить препарат"), "в правке есть удаление");
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

test("H7: включение напоминания без времени открывает диалог", async () => {
  const noTime = { meds: [{ ...richState.meds[0], remind_enabled: false, remind_time: null }], med_logs: [] };
  const ui = buildHealth(noTime);
  await ui.handleHealthAction("health-remind-toggle", { dataset: { med: "7", enabled: "true" } });
  const dialogs = ui.getDialogs();
  assert.equal(dialogs.length, 1, "диалог открыт поверх");
  assert.ok(dialogs[0].fields.includes('name="remind_time"'), "в диалоге есть время напоминания");
  assert.ok(dialogs[0].fields.includes(" checked"), "напоминание предвключено");
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

test("H9: сохранение препарата — напоминание выключено, время не уходит", () => {
  const ui = buildHealth({ meds: [], med_logs: [] });
  const fd = new FormData();
  fd.set("name", "Магний");
  fd.set("start_date", today);
  fd.set("remind_time", "09:00");
  fd.set("status", "active");
  // Чекбокс не отмечен — напоминание выключено.
  const body = ui.healthMedBodyFromForm(fd, null);
  assert.equal(body.remind_enabled, false);
  assert.equal(body.remind_time, null, "выключенное напоминание шлёт null");
  // Включённое с пустым временем отклоняется с понятным текстом.
  fd.set("remind_enabled", "on");
  fd.set("remind_time", "");
  assert.throws(() => ui.healthMedBodyFromForm(fd, null), /Укажите время напоминания/);
  fd.set("remind_time", "09:00");
  const on = ui.healthMedBodyFromForm(fd, 7);
  assert.equal(on.remind_time, "09:00");
  assert.equal(on.id, 7);
});

test("H10: ошибка загрузки — повторить; загрузка — «Загружаем список…»", () => {
  const failed = buildHealth({ failed: true });
  assert.ok(failed.renderHealthBody().includes("Повторить"));
  const loading = buildHealth(null);
  assert.ok(loading.renderHealthBody().includes("Загружаем список"));
});
