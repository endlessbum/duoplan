// Сессия Telegram: initData живёт дольше суток, а фоновое обновление не молчит
// при истёкшей сессии.
//
// Репорт 2026-10-29: auth_date старше суток отклонялся, приложение переставало
// работать и просило открыть его заново, а setInterval-обновление глотало
// ошибку.
//
// Запуск: node tests/test_session_expiry.test.mjs  (или node --test "tests/*.test.mjs")
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { match } from "node:assert/strict";
import { test } from "node:test";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const worker = readFileSync(join(root, "worker.js"), "utf8");
const app = readFileSync(join(root, "public", "app.js"), "utf8");

test("worker принимает initData двухдневной давности", () => {
  match(worker, /const MAX_AGE = 7 \* 86400;/);
  match(worker, /now\(\) - authDate > MAX_AGE/);
});

test("request помечает ошибку статусом для обработчиков", () => {
  match(app, /error\.status = response\.status/);
  match(app, /error\.code = payload\.code/);
});

test("фоновое обновление явно сообщает об истёкшей сессии", () => {
  match(app, /if \(error\?\.status === 401\) handleRequestError\(error\);/);
});
