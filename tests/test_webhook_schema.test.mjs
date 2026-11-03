// Вебхук и дедупликация telegram_updates.
//
// Репорт 2026-10-29: каждый апдейт запускал
// DELETE FROM telegram_updates WHERE received_at < ? без индекса, а вебхук
// не вызывал ensureSchemaOnce.
// Репорт 2026-11-03 (§5.5): чистка уехала из вебхука в cron (sendDigests) —
// минус один запрос на каждый апдейт; в вебхуке остаётся INSERT OR IGNORE.
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

test("вебхук вызывает ensureSchemaOnce до INSERT дедупликации и сам не чистит таблицу", () => {
  const webhookStart = source.indexOf("async function webhook");
  // Тело ограничиваем следующей функцией: срез до EOF захватил бы sendDigests
  // с её законным DELETE (репорт 2026-11-03, §5.5).
  const nextFn = source.indexOf("\nasync function ", webhookStart + 1);
  const webhookBody = source.slice(webhookStart, nextFn === -1 ? undefined : nextFn);
  const ensurePos = webhookBody.indexOf("await ensureSchemaOnce(env);");
  const insertPos = webhookBody.indexOf("INSERT OR IGNORE INTO telegram_updates");
  match(webhookBody, /await ensureSchemaOnce\(env\);/);
  ok(ensurePos > 0 && insertPos > ensurePos, "ensureSchemaOnce должен идти до INSERT");
  ok(!webhookBody.includes("DELETE FROM telegram_updates WHERE received_at"), "полную чистку дедупа (received_at) вебхук не делает");
});

test("чистка дедуп-таблицы выполняется в cron (sendDigests)", () => {
  const cronBody = source.slice(source.indexOf("async function sendDigests"));
  ok(cronBody.includes("DELETE FROM telegram_updates WHERE received_at < ?"), "DELETE дедупа должен быть в sendDigests");
});
