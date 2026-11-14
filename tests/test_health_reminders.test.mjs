// Правила напоминаний о приёме препаратов («Дневник → Здоровье»).
// healthReminderKinds — чистая функция: исполняется вне Worker'а, дедуп на
// день остаётся в deliverNotification (notification_log), как у Фло.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const source = readFileSync(new URL("../worker.js", import.meta.url), "utf8");
// Константы объявлены в блоке Фло, функции — в блоке «Здоровье»: собираем оба.
const constants = [
  source.slice(source.indexOf('const HEALTH_MED_FORMS'), source.indexOf("\n", source.indexOf('const HEALTH_MED_FORMS'))),
  source.slice(source.indexOf('const HEALTH_MED_STATUS ='), source.indexOf("\n", source.indexOf('const HEALTH_MED_STATUS ='))),
  source.slice(source.indexOf('const HEALTH_TIME_RE'), source.indexOf("\n", source.indexOf('const HEALTH_TIME_RE')))
].join("\n");
const block = source.slice(source.indexOf("// ---- Здоровье"), source.indexOf("async function ensureSchema(env)"));
const { healthReminderKinds } = new Function("DEFAULT_TZ", `${constants}\n${block}; return { healthReminderKinds };`)("Europe/Moscow");

const med = (patch = {}) => ({
  id: 7,
  name: "Магний",
  dosage: "1 таблетка",
  schedule: "после еды",
  remind_enabled: true,
  remind_time: "09:00",
  start_date: "2026-11-01",
  end_date: null,
  status: "active",
  ...patch
});

test("активный курс с включённым напоминанием: время достигло — напомнить", () => {
  const out = healthReminderKinds([med()], "2026-11-10", "09:00");
  assert.equal(out.length, 1);
  assert.equal(out[0].kind, "health_med_7");
  assert.ok(out[0].text.includes("Магний"));
  assert.ok(out[0].text.includes("после еды"));
  assert.ok(out[0].text.includes("Дневник → Здоровье"), "текст подсказывает, где отметить приём");
});

test("время ещё не наступило — не напоминать (крон 15-минутный)", () => {
  assert.deepEqual(healthReminderKinds([med()], "2026-11-10", "08:45"), []);
});

test("пауза, завершённый курс и выключенное напоминание — молчание", () => {
  assert.deepEqual(healthReminderKinds([med({ status: "paused" })], "2026-11-10", "09:00"), []);
  assert.deepEqual(healthReminderKinds([med({ status: "completed" })], "2026-11-10", "09:00"), []);
  assert.deepEqual(healthReminderKinds([med({ remind_enabled: false })], "2026-11-10", "09:00"), []);
});

test("курс ещё не начался или уже закончился — не напоминать", () => {
  assert.deepEqual(healthReminderKinds([med({ start_date: "2026-11-11" })], "2026-11-10", "09:00"), []);
  assert.deepEqual(healthReminderKinds([med({ end_date: "2026-11-09" })], "2026-11-10", "09:00"), []);
  // Граничные дни входят: старт сегодня и последний день курса напоминают.
  assert.equal(healthReminderKinds([med({ start_date: "2026-11-10" })], "2026-11-10", "09:00").length, 1);
  assert.equal(healthReminderKinds([med({ end_date: "2026-11-10" })], "2026-11-10", "09:00").length, 1);
});

test("битое или отсутствующее время напоминания — молчание (fail-safe)", () => {
  assert.deepEqual(healthReminderKinds([med({ remind_time: null })], "2026-11-10", "09:00"), []);
  assert.deepEqual(healthReminderKinds([med({ remind_time: "9 утра" })], "2026-11-10", "09:00"), []);
});

test("несколько препаратов в одном тике — по одному напоминанию на препарат", () => {
  const out = healthReminderKinds([med(), med({ id: 8, name: "Омега-3", remind_time: "09:10" })], "2026-11-10", "09:14");
  assert.deepEqual(out.map(r => r.kind), ["health_med_7", "health_med_8"]);
  assert.ok(out[1].text.includes("Омега-3"));
});
