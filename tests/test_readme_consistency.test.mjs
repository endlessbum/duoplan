// README не должен отставать от кода: версия и список миграций сверяются
// с источником истины (worker.js и каталог migrations/).
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { equal, deepStrictEqual, ok } from "node:assert/strict";
import { test } from "node:test";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const readme = readFileSync(join(root, "README.md"), "utf8");
const worker = readFileSync(join(root, "worker.js"), "utf8");
const appVersion = worker.match(/const APP_VERSION = "([^"]+)";/)?.[1];
const schemaVersion = worker.match(/const DB_SCHEMA_VERSION = "([^"]+)";/)?.[1];

test("версия в README совпадает с APP_VERSION и DB_SCHEMA_VERSION", () => {
  ok(appVersion && schemaVersion, "версии в worker.js не найдены");
  equal(appVersion, schemaVersion, "на релизе версии должны совпадать");
  // TEST-README-01: сравниваем ТОЛЬКО поле текущей версии. Исторические
  // даты версий (например, граница SHARE_BACKFILL_INTRODUCED) — не текущая
  // версия релиза и не должны ломать тест.
  const current = readme.match(/Текущая версия — `([^`]+)`/)?.[1];
  ok(current, "в README нет поля «Текущая версия»");
  equal(current, appVersion, `README: текущая версия ${current} ≠ APP_VERSION ${appVersion}`);
});

test("граница backfill в README совпадает с SHARE_BACKFILL_INTRODUCED", () => {
  // Историческая контрольная версия одноразового backfill категорий —
  // полезна в документации, но должна совпадать с константой в worker.js.
  const cutoff = worker.match(/const SHARE_BACKFILL_INTRODUCED = "([^"]+)";/)?.[1];
  ok(cutoff, "SHARE_BACKFILL_INTRODUCED в worker.js не найдена");
  ok(readme.includes(cutoff), `README не упоминает границу backfill ${cutoff}`);
});

test("список миграций в README совпадает с файлами migrations/*.sql", () => {
  const start = readme.indexOf("| Миграция | Что добавляет |");
  ok(start !== -1, "таблица миграций в README не найдена");
  const lines = readme.slice(start).split(/\r?\n/);
  const documented = [];
  for (const line of lines.slice(2)) {
    if (!line.startsWith("|")) break;
    const name = line.match(/^\|\s*`(\d{4}_[a-z0-9_]+)`/)?.[1];
    if (name) documented.push(name);
  }
  const actual = readdirSync(join(root, "migrations"))
    .filter((f) => f.endsWith(".sql"))
    .map((f) => f.replace(/\.sql$/, ""))
    .sort();
  deepStrictEqual(documented.sort(), actual, "README и migrations/ расходятся");
  ok(readme.includes(`${actual.length} мигра`), `в README не указано число ${actual.length}`);
});
