// Расхождения с обещаниями лендинга и документацией.
//
// Запуск: node tests/test_promises.test.mjs  (или node --test "tests/*.test.mjs")
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { equal, match, ok } from "node:assert/strict";
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

test("лендинг ведёт на одного бота и содержит якоря разделов", () => {
  const telegramLinks = [...indexHtml.matchAll(/href="(https:\/\/t\.me\/[^"]+)"/g)].map((m) => m[1]);
  ok(telegramLinks.length > 0, "на лендинге должна быть ссылка на Telegram");
  for (const link of telegramLinks) {
    equal(link, "https://t.me/duoplanbot", "все ссылки ведут на одного бота");
  }
  match(indexHtml, /id="possibilities"/);
  match(indexHtml, /href="#possibilities"/);
  match(indexHtml, /id="main"/);
});

test("лендинг обещает ключевые разделы приложения", () => {
  for (const feature of [
    "Общие планы",
    "Значимые даты",
    "Общий дневник",
    "Вишлист",
    "Ритуал дня",
    "Места",
    "Кино на вечер",
    "Путешествия",
    "Цели",
    "Копилка",
    "Фло",
  ]) {
    match(indexHtml, new RegExp(feature), `лендинг должен обещать раздел «${feature}»`);
  }
});

test("лендинг доступен: язык, вьюпорт и skip-link", () => {
  match(indexHtml, /<html lang="ru">/);
  match(indexHtml, /<meta name="viewport" content="width=device-width, initial-scale=1">/);
  match(indexHtml, /class="skip-link" href="#main"/);
});

test("приложение умеет копировать ссылку для партнёра", () => {
  match(appJs, /data-action="copy-link"/);
  match(appJs, /action === "copy-link"/);
  // Ссылка формируется как `https://t.me/${appState?.pair?.bot_username || "duoplanbot"}?start=code`
  match(appJs, /\$\{appState/);
});

test("миграция rate_limits содержит expires_at", () => {
  match(migration, /expires_at INTEGER NOT NULL DEFAULT 0/);
});

test("README содержит команду запуска Node-тестов", () => {
  match(readme, /node --test "tests\/\*\.test\.mjs"/);
});
