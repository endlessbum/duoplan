// Регресс P2 (повторный аудит): в интерактивном демо лендинга не должно
// быть кнопок, которые выглядят рабочими, но молча не реагируют.
//
// Тест собирает все data-action, которые генерирует public/demo.js
// (литеральные атрибуты, аргументы itemActionButton и тернарники внутри
// data-action="${...}"), и проверяет, что каждое действие либо имеет
// локальную реализацию в DEMO_ACTIONS, либо явно описано в DEMO_INERT
// (тост с причиной), либо обрабатывается отдельной веткой
// (DEMO_NATIVE_ACTIONS).

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const src = readFileSync(join(here, "..", "public", "demo.js"), "utf8");

function block(name) {
  const re = new RegExp(`${name}_BEGIN([\\s\\S]*?)${name}_END`);
  const m = src.match(re);
  assert.ok(m, `В demo.js не найден блок ${name}`);
  return m[1];
}

// Все data-action, реально генерируемые демо.
function collectActions() {
  const found = new Set();
  // Литеральные атрибуты: data-action="done-item".
  for (const m of src.matchAll(/data-action="([a-z][a-z0-9-]*)"/g)) found.add(m[1]);
  // Аргументы itemActionButton: action: "done-item".
  for (const m of src.matchAll(/action:\s*"([a-z][a-z0-9-]*)"/g)) found.add(m[1]);
  // Тернарники внутри data-action="${...}": data-action="${it.done ? "a" : "b"}".
  for (const m of src.matchAll(/data-action="\$\{([^}]*)\}"/g)) {
    for (const inner of m[1].matchAll(/"([a-z][a-z0-9-]*)"/g)) found.add(inner[1]);
  }
  return found;
}

function objectKeys(blockSrc) {
  const keys = new Set();
  for (const m of blockSrc.matchAll(/"([a-z][a-z0-9-]*)"\s*[:(]/g)) keys.add(m[1]);
  return keys;
}

test("каждый data-action демо реализован или явно inert", () => {
  const actions = collectActions();
  assert.ok(actions.size > 30, `ожидалось много действий, найдено ${actions.size}`);

  const implemented = objectKeys(block("DEMO_ACTIONS"));
  const inert = objectKeys(block("DEMO_INERT"));
  const nativeBlock = block("DEMO_NATIVE");
  const native = new Set([...nativeBlock.matchAll(/"([a-z][a-z0-9-]*)"/g)].map((m) => m[1]));

  const covered = new Set([...implemented, ...inert, ...native]);
  const missing = [...actions].filter((a) => !covered.has(a)).sort();
  assert.deepEqual(missing, [], `data-action без обработчика и без inert-статуса: ${missing.join(", ")}`);
});

test("реестр DEMO_ACTIONS не содержит мёртвых ключей", () => {
  const actions = collectActions();
  const inert = objectKeys(block("DEMO_INERT"));
  const native = new Set([...block("DEMO_NATIVE").matchAll(/"([a-z][a-z0-9-]*)"/g)].map((m) => m[1]));
  const dead = [...objectKeys(block("DEMO_ACTIONS"))]
    .filter((k) => !actions.has(k) && !inert.has(k) && !native.has(k));
  assert.deepEqual(dead, [], `ключи DEMO_ACTIONS без data-action в разметке: ${dead.join(", ")}`);
});

test("нативные ветки задокументированы и покрыты", () => {
  // Каждое действие из DEMO_NATIVE должно реально встречаться в коде
  // как обрабатываемая ветка (иначе запись в реестре бессмысленна).
  const native = [...block("DEMO_NATIVE").matchAll(/"([a-z][a-z0-9-]*)"/g)].map((m) => m[1]);
  for (const action of native) {
    assert.ok(
      src.includes(`[data-action="${action}"]`) || src.includes(`"${action}"`),
      `DEMO_NATIVE_ACTIONS содержит неиспользуемое действие: ${action}`
    );
  }
});
