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
  assert.ok(!html.includes("Мои препараты"), "заголовок карточки убран");
});

test("H3: список препаратов — статус, имя заголовком, полноширинные отметки", () => {
  const ui = buildHealth(richState);
  const html = ui.renderHealthBody();
  assert.ok(html.includes("Магний"));
  assert.ok(html.includes("Витамин D"));
  // Имя препарата — заголовком карточки (h3), не подписью.
  assert.ok(html.includes('<h3 class="health-med-name">Магний</h3>'), "имя препарата — заголовок");
  // Чип «Напоминание» из карточки убран — настройка только в диалоге.
  assert.ok(!html.includes("Напоминание:"), "чип напоминания в карточке отсутствует");
  assert.ok(!html.includes("health-remind-toggle"), "переключателя напоминания в списке нет");
  assert.ok(html.includes("принято 1 · пропущено 0"));
  // «Принят» — primary (цвет акцента), «Пропущен» — secondary, обе full.
  const takenBtn = html.match(/<button[^>]*data-action="health-intake"[^>]*data-med="7"[^>]*data-status="taken"[^>]*>/);
  assert.ok(takenBtn && /primary/.test(takenBtn[0]), "«Принят» — primary-кнопка");
  const skippedBtn = html.match(/<button[^>]*data-action="health-intake"[^>]*data-med="7"[^>]*data-status="skipped"[^>]*>/);
  assert.ok(skippedBtn && /secondary/.test(skippedBtn[0]), "«Пропущен» — secondary-кнопка");
  assert.ok(/is-on/.test(takenBtn[0]), "отметка «принят» помечена");
  // Кнопка добавления — над карточкой списка, как в других вкладках.
  const addIdx = html.indexOf('data-action="health-med-new"');
  const cardIdx = html.indexOf('<section class="card">');
  assert.ok(addIdx > -1 && cardIdx > -1 && addIdx < cardIdx, "«Добавить препарат» над карточкой");
  assert.ok(html.includes("общий итог за день"), "дневной статус честно подписан");
});

test("H4: у препарата на паузе нет чипов приёма", () => {
  const ui = buildHealth(richState);
  const html = ui.renderHealthBody();
  const row = html.slice(html.indexOf("Витамин D"), html.indexOf("Витамин D") + 1200);
  assert.ok(!row.includes('data-action="health-intake"'), "пауза — отметок приёма нет");
});

test("H5: диалог препарата — схема и доза селектами, время по числу приёмов", () => {
  const ui = buildHealth({ meds: [], med_logs: [] });
  const fields = ui.healthMedDialogFields(null);
  assert.ok(fields.includes('name="schedule"'), "схема приёма — выбор");
  assert.ok(fields.includes("4 раза в день"), "варианты схемы 1–4 раза");
  assert.ok(fields.includes('name="dosage"'), "доза — выбор");
  assert.ok(fields.includes('name="remind_times"'), "поля времени приёма есть");
  assert.ok(fields.includes('name="remind_enabled"'), "переключатель напоминания есть");
  assert.ok(fields.includes("Бот напомнит о приёме в каждое указанное время"));
  assert.ok(fields.includes("Удалить препарат") === false, "для нового препарата кнопки удаления нет");
  const editing = ui.healthMedDialogFields({ id: 7, name: "Магний", remind_enabled: true, remind_time: "09:00", schedule: "2 раза в день", form: "tablet" });
  assert.ok(editing.includes("Удалить препарат"), "в правке есть удаление");
  // Схема «2 раза в день» → два поля времени, сохранённое время в первом.
  const timeInputs = editing.match(/name="remind_times"/g) || [];
  assert.equal(timeInputs.length, 2, "два приёма — два поля времени");
  assert.ok(editing.includes('value="09:00"'), "сохранённое время подставлено");
  // Без формы доза задизейблена.
  const noForm = ui.healthMedDialogFields(null);
  assert.ok(/name="dosage"[^>]*disabled/.test(noForm), "без формы доза недоступна");
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

test("H9: сохранение препарата — список времён по схеме, выключено → null", () => {
  const ui = buildHealth({ meds: [], med_logs: [] });
  const fd = new FormData();
  fd.set("name", "Магний");
  fd.set("start_date", today);
  fd.set("schedule", "2 раза в день");
  fd.set("remind_times", "08:00");
  fd.append("remind_times", "20:00");
  fd.set("status", "active");
  // Чекбокс не отмечен — напоминание выключено, времена не уходят.
  const body = ui.healthMedBodyFromForm(fd, null);
  assert.equal(body.remind_enabled, false);
  assert.equal(body.remind_time, null, "выключенное напоминание шлёт null");
  assert.equal(body.schedule, "2 раза в день");
  // Включённое без времён отклоняется.
  fd.set("remind_enabled", "on");
  const fdEmpty = new FormData();
  for (const [k, v] of [["name", "Магний"], ["start_date", today], ["schedule", "1 раз в день"], ["status", "active"], ["remind_enabled", "on"]]) fdEmpty.set(k, v);
  assert.throws(() => ui.healthMedBodyFromForm(fdEmpty, null), /Укажите время приёма/);
  // Неполный набор времён под схему «2 раза» отклоняется.
  const fdOne = new FormData();
  for (const [k, v] of [["name", "Магний"], ["start_date", today], ["schedule", "2 раза в день"], ["status", "active"], ["remind_enabled", "on"], ["remind_times", "08:00"]]) fdOne.set(k, v);
  assert.throws(() => ui.healthMedBodyFromForm(fdOne, null), /каждого приёма/);
  // Полный набор — remind_time хранится списком.
  const on = ui.healthMedBodyFromForm(fd, 7);
  assert.equal(on.remind_time, "08:00,20:00");
  assert.equal(on.id, 7);
});

test("H10: ошибка загрузки — повторить; загрузка — «Загружаем список…»", () => {
  const failed = buildHealth({ failed: true });
  assert.ok(failed.renderHealthBody().includes("Повторить"));
  const loading = buildHealth(null);
  assert.ok(loading.renderHealthBody().includes("Загружаем список"));
});
