// EXP-01: экспорт раздела «Фло» обязан сохранять все пять типов записей
// (period/log/measurement/med/med_log) и их поля, включая bleeding_details.
// Файл — JSON-конверт (buildExportEnvelope): проверяем mapper всех типов
// и то, что секция целиком попадает в конверт — mapper-тест не ловит потери
// на этапе сборки файла.
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

function extractLine(prefix) {
  const start = source.indexOf(prefix);
  if (start === -1) throw new Error(`${prefix} не найдено`);
  return source.slice(start, source.indexOf("\n", start));
}

const build = new Function(
  [
    extractLine("const clean = "),
    extractLine("const EXPORT_FILE_SCHEMA = 1"),
    extractBraced("const EXPORT_LABELS = {"),
    extractBraced("function exportMemoryRow"),
    extractBraced("function exportDateRow"),
    extractBraced("const EXPORT_ROW_MAPPERS = {"),
    extractBraced("function buildExportEnvelope"),
    "return { EXPORT_ROW_MAPPERS, buildExportEnvelope };"
  ].join("\n")
);
const { EXPORT_ROW_MAPPERS, buildExportEnvelope } = build();

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
    med_dosage: "1 капс.", category: "supplement", form: "capsule", schedule: "1 раз в день", status: "active", created_at: 4
  },
  {
    kind: "med_log", day: "2026-11-03", note: "после еды", med_name: "Витамин | D3",
    med_time: "08:00", med_status: "taken", dose_taken: "1 капс.", created_at: 5
  }
];

test("mapper сохраняет kind и поля всех пяти типов Фло", () => {
  const mapped = rows.map(EXPORT_ROW_MAPPERS.cycle);
  deepStrictEqual(mapped.map((r) => r.kind), ["period", "log", "measurement", "med", "med_log"]);
  equal(mapped[1].bleeding_details.changes_per_day, 4);
  equal(mapped[1].sleep_hours, 7.5);
  equal(mapped[1].pain_score, 6);
  equal(mapped[2].m_value, 36.6);
  equal(mapped[3].category, "supplement");
  equal(mapped[3].name, "Витамин | D3", "имя препарата должно быть без склеенной дозы");
  equal(mapped[3].dosage, "1 капс.", "доза должна ехать отдельным полем");
  equal(mapped[4].dose_taken, "1 капс.");
});

test("конверт включает секцию Фло целиком, поля строк не теряются", () => {
  const mapped = rows.map(EXPORT_ROW_MAPPERS.cycle);
  const envelope = buildExportEnvelope("тест", { cycle: mapped });
  deepStrictEqual(envelope.sections.cycle, mapped, "строки Фло искажаются при сборке файла");
  const roundtrip = JSON.parse(JSON.stringify(envelope));
  // вертикальная черта в пользовательском тексте не ломает разбор файла
  equal(roundtrip.sections.cycle[1].note, "заметка | с вертикальной чертой\nи второй строкой");
  equal(roundtrip.sections.cycle[1].bleeding_details.changes_per_day, 4);
  equal((roundtrip.sections.cycle.match ? 0 : 5), 5, "в секции должно быть ровно 5 записей");
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
  deepStrictEqual(counts, [40, 40, 40, 40, 40], "колонки веток UNION разошлись (med_dosage добавлен во все)");
});
