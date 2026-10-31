// Паритет колонок в SELECT открытых планов и дат (worker.js) — регрессия
// рассинхронизации миграции 0013.
//
// Репорт аудита 2026-10-31: state() не включал `yearly`, а нотификационный
// SELECT — `monthly`/`yearly`; напоминания, сводки и клиент считали
// повторяющиеся планы разовыми. Инвариант: ЛЮБОЙ SELECT открытых планов
// обязан нести monthly и yearly, любой списковый SELECT дат (с колонкой day)
// — monthly. Исключения: done_* (завершённым повтор не нужен), guard-SELECTы
// (is_private/created_by для 404-проверок) и COUNT-агрегаты.
//
// Запуск: node --test tests/test_column_parity.test.mjs
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { equal, ok } from "node:assert/strict";
import { test } from "node:test";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const source = readFileSync(join(root, "worker.js"), "utf8");

// Разрыв SELECT..FROM не может пересекать границы SQL-строки: внутри списка
// колонок нет ни закрывающих кавычек, ни скобок (COUNT(*) даёт ")" — но это
// агрегат, он ниже отфильтрован отдельно).
function statementWindows(table) {
  const re = new RegExp("SELECT[^)\"`]*?FROM " + table + "(?![a-z_])", "g");
  const out = [];
  for (const match of source.matchAll(re)) {
    // Окно: совпадение + хвост WHERE (до закрывающей кавычки строки).
    const tail = source.slice(match.index, match.index + 500);
    out.push(tail.slice(0, tail.search(/["`]\)/) === -1 ? tail.length : tail.search(/["`]\)/) + 2));
  }
  return out;
}

function columnList(windowText) {
  return windowText.slice(0, windowText.indexOf("FROM")).toLowerCase();
}

const taskWindows = statementWindows("tasks");
const openTasks = taskWindows.filter((w) => w.includes("status='open'"));
const doneTasks = taskWindows.filter((w) => w.includes("status='done'"));
const dateListSelects = statementWindows("dates")
  .filter((w) => !w.includes("COUNT(*)"))
  .filter((w) => columnList(w).includes("day")); // списковые: guard-SELECT без day отсеивается

test("SELECT открытых планов найден хотя бы в трёх местах (state, архив, нотификации)", () => {
  equal(openTasks.length >= 3, true, `найдено только ${openTasks.length}`);
});

test("каждый SELECT открытых планов несёт monthly и yearly", () => {
  for (const sql of openTasks) {
    ok(columnList(sql).includes("monthly"), `monthly пропал: ${sql.slice(0, 90).replace(/\s+/g, " ")}…`);
    ok(columnList(sql).includes("yearly"), `yearly пропал: ${sql.slice(0, 90).replace(/\s+/g, " ")}…`);
  }
});

test("списковый SELECT дат несёт monthly (везде, включая нотификации)", () => {
  equal(dateListSelects.length >= 3, true, `найдено только ${dateListSelects.length}`);
  for (const sql of dateListSelects) {
    ok(columnList(sql).includes("monthly"), `monthly пропал в датах: ${sql.slice(0, 90).replace(/\s+/g, " ")}…`);
  }
});

test("guard-SELECTы дат (is_private/created_by) не считаются списковыми", () => {
  const guards = statementWindows("dates").filter((w) => !w.includes("COUNT(*)") && !columnList(w).includes("day"));
  equal(guards.length >= 1, true, "ожидался хотя бы один guard-SELECT (ensureDateVisible)");
});

test("завершённым планам повтор не нужен (исключение задокументировано)", () => {
  equal(doneTasks.length >= 1, true, "SELECT done-планов не найден");
});
