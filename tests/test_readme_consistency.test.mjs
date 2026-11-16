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
  const versions = readme.match(/20\d{2}\.\d{2}\.\d{2}\.\d+/g) || [];
  ok(versions.length > 0, "в README нет версии");
  for (const v of versions) equal(v, appVersion, `README содержит устаревшую версию ${v}`);
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
