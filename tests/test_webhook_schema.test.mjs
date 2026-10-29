// Вебхук: схема (с индексом по received_at) создаётся до очистки дедупликации.
//
// Репорт 2026-10-29: каждый апдейт запускал
// DELETE FROM telegram_updates WHERE received_at < ? без индекса, а вебхук
// не вызывал ensureSchemaOnce.
//
// Запуск: node tests/test_webhook_schema.test.mjs  (или node --test "tests/*.test.mjs")
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { match, ok } from "node:assert/strict";
import { test } from "node:test";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const source = readFileSync(join(root, "worker.js"), "utf8");

test("ensureSchema создаёт индекс по received_at", () => {
  match(source, /CREATE INDEX IF NOT EXISTS idx_telegram_updates_received_at ON telegram_updates\(received_at\)/);
});

test("вебхук вызывает ensureSchemaOnce до DELETE дедупликации", () => {
  const webhookBody = source.slice(source.indexOf("async function webhook"));
  const ensurePos = webhookBody.indexOf("await ensureSchemaOnce(env);");
  const deletePos = webhookBody.indexOf('DELETE FROM telegram_updates WHERE received_at < ?');
  match(webhookBody, /await ensureSchemaOnce\(env\);/);
  ok(ensurePos > 0 && deletePos > ensurePos, "ensureSchemaOnce должен идти до DELETE");
});
