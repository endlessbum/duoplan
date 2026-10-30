// Тест конкурентной первичной миграции D1 из разных Worker-isolate.
//
// ensureSchema/ensureSchemaOnce извлекаются из worker.js как есть и
// исполняются против мока D1, который воспроизводит гонку: другой isolate
// добавляет колонку между PRAGMA table_info и ALTER TABLE.
//
// Запуск: node tests/test_schema_migration.test.mjs  (или node --test tests/)
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { deepStrictEqual, rejects } from "node:assert/strict";
import { test } from "node:test";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const source = readFileSync(join(root, "worker.js"), "utf8");

function extractFunction(name) {
  // Берём вместе с "async", иначе new Function увидит await вне async-функции.
  let start = source.indexOf(`async function ${name}(`);
  const declaration = start === -1 ? `function ${name}(` : `async function ${name}(`;
  if (start === -1) start = source.indexOf(declaration);
  if (start === -1) throw new Error(`function ${name} не найдена`);
  let depth = 0;
  for (let j = source.indexOf("{", start); j < source.length; j++) {
    if (source[j] === "{") depth++;
    else if (source[j] === "}") {
      depth--;
      if (depth === 0) return source.slice(start, j + 1);
    }
  }
  throw new Error(`незакрытая функция ${name}`);
}

const schemaVersion = source.match(/const DB_SCHEMA_VERSION = "[^"]+";/)?.[0];
const weakMap = "const schemaReady = new WeakMap();";
if (!schemaVersion) throw new Error("DB_SCHEMA_VERSION не найдена");
const load = new Function(
  `${schemaVersion}\n${weakMap}\n${extractFunction("ensureSchema")}\n${extractFunction("ensureSchemaOnce")}\n` +
  "return { ensureSchemaOnce, DB_SCHEMA_VERSION };"
);
const { ensureSchemaOnce, DB_SCHEMA_VERSION } = load();

// Мок D1: SELECT app_meta всегда "таблицы нет" (полная инициализация),
// ALTER racing-колонок имитирует выигравший конкурентный isolate.
function makeMockDb({ racingColumns = new Set(), failingColumns = new Set() } = {}) {
  const tables = {
    pairs: new Set(["id", "code", "name1", "name2", "user_a", "user_b", "started_at", "together_pts", "created_at", "updated_at"]),
    users: new Set(["tg_id", "display_name", "role", "pair_id", "points", "streak", "last_activity", "best_streak", "created_at", "updated_at"]),
    tasks: new Set(["id", "pair_id", "title", "status", "created_by", "created_at", "completed_by", "completed_at"]),
    dates: new Set(["id", "pair_id", "title", "day", "recurs", "created_at"]),
    wishes: new Set(["id", "pair_id", "owner_id", "body", "done", "created_at"]),
    rate_limits: new Set(["bucket_key", "count"])
  };
  const failedOnce = new Set();
  const log = { alters: [], versionWrite: null };
  const db = {
    prepare(sql) {
      return {
        sql,
        bind(value) {
          log.versionWrite = value;
          return { run: async () => ({}) };
        },
        async first() {
          throw new Error("no such table: app_meta");
        },
        async all() {
          const table = sql.match(/^PRAGMA table_info\((\w+)\)$/)?.[1];
          return { results: [...(tables[table] ?? [])].map((name) => ({ name })) };
        },
        async run() {
          if (!sql.startsWith("ALTER TABLE")) return {};
          const [, table, column] = sql.match(/^ALTER TABLE (\w+) ADD COLUMN (\w+)/);
          log.alters.push(column);
          if (failingColumns.has(column) && !failedOnce.has(column)) {
            failedOnce.add(column);
            throw new Error(`some d1 failure: ${column}`);
          }
          if (racingColumns.has(column)) {
            tables[table].add(column); // конкурентный isolate успел раньше
            throw new Error(`duplicate column name: ${column}`);
          }
          tables[table].add(column);
          return {};
        }
      };
    },
    async batch(statements) {
      return statements.map(() => ({ meta: { changes: 0 } }));
    }
  };
  return { db, log };
}

test("гонка isolate: duplicate column name обрабатывается повторным чтением схемы", async () => {
  const { db, log } = makeMockDb({ racingColumns: new Set(["timezone"]) });
  await ensureSchemaOnce({ DB: db });
  deepStrictEqual(log.versionWrite, DB_SCHEMA_VERSION);
  // users.timezone упал с "duplicate column name" и был отработан,
  // pairs.timezone добавлен этим isolate штатно.
  deepStrictEqual(log.alters.sort(), [
    "accent_color", "created_by", "dates_digest_enabled", "dates_digest_time", "day",
    "digest_enabled", "digest_time", "done_at", "expires_at", "gender", "is_private",
    "is_private", "time", "time", "timezone", "timezone", "url"
  ]);
});

test("чистый проход миграции без гонки записывает версию схемы", async () => {
  const { db, log } = makeMockDb();
  await ensureSchemaOnce({ DB: db });
  deepStrictEqual(log.versionWrite, DB_SCHEMA_VERSION);
  // time + is_private (tasks) + time/is_private/created_by (dates) + done_at (wishes)
  // + url (wishes) + timezone (users, pairs) + expires_at (rate_limits) + 5 настроек (users)
  deepStrictEqual(log.alters.length, 17);
});

test("остальные ошибки ALTER не глушатся", async () => {
  const { db } = makeMockDb({ failingColumns: new Set(["gender"]) });
  await rejects(ensureSchemaOnce({ DB: db }), /some d1 failure: gender/);
});

test("после неудачной миграции следующий вызов повторяет попытку", async () => {
  const { db, log } = makeMockDb({ failingColumns: new Set(["gender"]) });
  await rejects(ensureSchemaOnce({ DB: db }), /some d1 failure: gender/);
  // Тот же env.DB: схема не запомнена как готовая, миграция выполняется заново.
  await ensureSchemaOnce({ DB: db });
  deepStrictEqual(log.versionWrite, DB_SCHEMA_VERSION);
});
