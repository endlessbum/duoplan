// EXP-01: TXT-экспорт раздела «Фло» обязан сохранять все пять типов записей
// (period/log/measurement/med/med_log) и их поля, включая bleeding_details.
// Проверяем и mapper, и готовый документ — только mapper-тест не ловит потери
// на этапе рендера.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { deepStrictEqual, equal, ok } from "node:assert/strict";
import { test } from "node:test";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const source = readFileSync(join(root, "worker.js"), "utf8");

function extractBraced(declaration) {
  const start = source.indexOf(declaration);
  if (start === -1) throw new Error(`${declaration} не найдено`);
  let depth = 0;
  for (let j = source.indexOf("{", start); j < source.length; j++) {
    if (source[j] === "{") depth++;
    else if (source[j] === "}") { depth--; if (depth === 0) return source.slice(start, j + 1); }
  }
  throw new Error(`незакрытый блок: ${declaration}`);
}

const passthrough = () => new Proxy({}, { get: (_, key) => key });
const build = new Function(
  "CYCLE_FLOW_LABELS", "CYCLE_ENERGY_LABELS", "CYCLE_MOOD_LABELS", "CYCLE_SYMPTOM_LABELS",
  "CYCLE_LEAKAGE_LABELS", "CYCLE_PAIN_LOCATION_LABELS", "CYCLE_LIFE_IMPACT_LABELS",
  "CYCLE_SLEEP_QUALITY_LABELS", "CYCLE_STRESS_LABELS", "CYCLE_SEX_LABELS", "cycleMucusLabel",
  [
    extractLine("const clean = "),
    extractBraced("function exportTxtTime"),
    extractBraced("const EXPORT_LABELS = {"),
    extractBraced("function exportMemoryRow"),
    extractBraced("function exportDateRow"),
    extractBraced("const EXPORT_ROW_MAPPERS = {"),
    extractBraced("const EXPORT_TXT_ROWS = {"),
    extractBraced("function exportTxtRecord"),
    extractBraced("function exportTxtDoc"),
    "return { EXPORT_ROW_MAPPERS, EXPORT_TXT_ROWS, exportTxtDoc };"
  ].join("\n")
)(
  passthrough(), passthrough(), passthrough(), passthrough(), passthrough(),
  passthrough(), passthrough(), passthrough(), passthrough(), passthrough(),
  (v) => JSON.stringify(v)
);
function extractLine(prefix) {
  const start = source.indexOf(prefix);
  if (start === -1) throw new Error(`${prefix} не найдено`);
  return source.slice(start, source.indexOf("\n", start));
}

const rows = [
  { kind: "period", day: "2026-11-01", end_date: "2026-11-05", end_unknown: 0, created_at: 1 },
  {
    kind: "log", day: "2026-11-01", flow: "heavy", clots: 1, energy: "good", mood: "calm",
    symptoms: '["cramps"]', symptoms_clear: 0, note: "заметка | с вертикальной чертой\nи второй строкой",
    sex: "protected", sex_count: 2, leakage: "light", pain_score: 6,
    pain_locations: '["back"]', life_impact: "high", mucus: '{"kind":"creamy"}',
    sleep_hours: 7.5, sleep_quality: "good", stress: "medium", sick: 1, travel: 0,
    weight_kg: 62.4, bleeding_details: '{"changes_per_day":4,"saturation":"medium","night_change":true}',
    created_at: 2
  },
  {
    kind: "measurement", day: "2026-11-02", note: "температура | утром",
    m_kind: "bbt", m_value: 36.6, m_unit: "C", m_result: null, m_time: "07:10", created_at: 3
  },
  {
    kind: "med", day: "2026-11-03", end_date: "2026-12-01", note: "Витамин | D3",
    category: "supplement", form: "capsule", schedule: "1 раз в день", status: "active", created_at: 4
  },
  {
    kind: "med_log", day: "2026-11-03", note: "после еды", med_name: "Витамин | D3",
    med_time: "08:00", med_status: "taken", dose_taken: "1 капс.", created_at: 5
  }
];

test("mapper сохраняет kind и поля всех пяти типов Фло", () => {
  const mapped = rows.map(build.EXPORT_ROW_MAPPERS.cycle);
  deepStrictEqual(mapped.map((r) => r.kind), ["period", "log", "measurement", "med", "med_log"]);
  equal(mapped[1].bleeding_details.changes_per_day, 4);
  equal(mapped[1].sleep_hours, 7.5);
  equal(mapped[1].pain_score, 6);
  equal(mapped[2].m_value, 36.6);
  equal(mapped[3].category, "supplement");
  equal(mapped[4].dose_taken, "1 капс.");
});

test("итоговый TXT печатает измерения/препараты/приёмы отдельными записями", () => {
  const mapped = rows.map(build.EXPORT_ROW_MAPPERS.cycle);
  const txt = build.exportTxtDoc("тест", { cycle: mapped });

  ok(txt.includes("Месячные с 2026-11-01"), "нет периода");
  ok(txt.includes("Смен в день: 4"), "нет смен в день");
  ok(txt.includes("Пропитывание: среднее"), "нет пропитывания");
  ok(txt.includes("Ночная смена: отмечено"), "нет ночной смены");
  ok(txt.includes("заметка | с вертикальной чертой"),
    "вертикальная черта в пользовательском тексте должна сохраниться");
  ok(txt.includes("Базальная температура — 2026-11-02"), "измерение напечатано как День ...");
  ok(txt.includes("Значение: 36.6°C"), "нет значения измерения");
  ok(txt.includes("Препарат: Витамин | D3"), "нет названия препарата");
  ok(txt.includes("Категория: БАД"), "нет категории");
  ok(txt.includes("Статус: принят"), "нет статуса приёма");
  ok(txt.includes("Фактическая доза: 1 капс."), "нет фактической дозы");
  ok(!txt.includes("День 2026-11-02"), "measurement не должен быть дневниковой записью");
  equal((txt.match(/^\d+\. /gm) || []).length, 5, "в TXT должно быть ровно 5 записей");
});

test("UNION ALL в EXPORT_SQL.cycle имеет одинаковое число колонок", () => {
  const start = source.indexOf("  cycle: () => `SELECT");
  const end = source.indexOf("    ORDER BY day ASC`", start);
  const branches = source.slice(start, end).split(/UNION ALL/);
  const counts = branches.map((part) => {
    const body = part.slice(part.indexOf("SELECT"), part.indexOf("FROM "));
    let depth = 0, count = 1;
    for (const ch of body) {
      if (ch === "(") depth++;
      else if (ch === ")") depth--;
      else if (ch === "," && depth === 0) count++;
    }
    return count;
  });
  deepStrictEqual(counts, [39, 39, 39, 39, 39]);
});
