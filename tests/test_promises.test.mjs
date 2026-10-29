// Расхождения с обещаниями лендинга и документацией.
//
// Запуск: node tests/test_promises.test.mjs  (или node --test "tests/*.test.mjs")
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { match, ok } from "node:assert/strict";
import { test } from "node:test";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const indexHtml = readFileSync(join(root, "public", "index.html"), "utf8");
const appJs = readFileSync(join(root, "public", "app.js"), "utf8");
const migration = readFileSync(join(root, "migrations", "0002_pair_members_and_safety.sql"), "utf8");
const readme = readFileSync(join(root, "README.md"), "utf8");

test("лендинг обещает приглашение по коду или ссылке", () => {
  match(indexHtml, /по личному коду или ссылке/);
});

test("приложение умеет копировать ссылку для партнёра", () => {
  match(appJs, /data-action="copy-link"/);
  match(appJs, /action === "copy-link"/);
  match(appJs, /t\.me\/duoplanbot\?start=/);
});

test("миграция rate_limits содержит expires_at", () => {
  match(migration, /expires_at INTEGER NOT NULL DEFAULT 0/);
});

test("README содержит команду запуска Node-тестов", () => {
  match(readme, /node --test "tests\/\*\.test\.mjs"/);
});
