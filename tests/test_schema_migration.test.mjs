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
const nowDecl = source.match(/const now = \(\) => [^;]+;/)?.[0];
const weakMap = "const schemaReady = new WeakMap();";
if (!schemaVersion) throw new Error("DB_SCHEMA_VERSION не найдена");
if (!nowDecl) throw new Error("now() не найдена");
const load = new Function(
  `${schemaVersion}\n${nowDecl}\n${weakMap}\n${extractFunction("ensureSchema")}\n${extractFunction("ensureSchemaOnce")}\n` +
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
    memories: new Set(["id", "pair_id", "author_id", "body", "day", "created_at"]),
    movies: new Set(["id", "pair_id", "created_by", "imdb_id", "title", "year", "kind", "rating", "genres", "runtime", "seasons", "episodes", "url", "watched", "watched_at", "watched_by", "created_at"]),
    cycle_profiles: new Set(["tg_id", "avg_cycle_length", "avg_period_length", "share_enabled", "share_level", "onboarded", "notify_enabled", "notify_period", "notify_ovulation", "notify_fertile", "notify_delay", "notify_period_days", "notify_delay_days", "share_notify", "created_at", "updated_at"]),
    cycle_logs: new Set(["id", "tg_id", "date", "flow", "symptoms", "mood", "note", "sex", "created_at", "updated_at"]),
    cycle_periods: new Set(["id", "tg_id", "start_date", "end_date", "created_at", "updated_at"]),
    tasks: new Set(["id", "pair_id", "title", "status", "created_by", "created_at", "completed_by", "completed_at"]),
    dates: new Set(["id", "pair_id", "title", "day", "recurs", "created_at"]),
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
    "accent_color", "awaiting_return", "clots", "comment", "created_by", "custom_name", "cycle_length_known", "dates_digest_enabled", "dates_digest_time", "day",
    "details", "digest_enabled", "digest_time", "done_at", "end_unknown", "energy", "expires_at", "gender", "is_private",
    "is_private", "kind", "last_partner", "leakage", "life_impact", "monthly", "monthly", "mucus",
    "notify_diary",
    "pain_locations", "pain_score", "partner_custom_name", "photo_url",
    "rating_checked_at", "rating_source", "show_avatar", "sick", "sleep_hours", "sleep_quality", "stress", "symptoms_clear",
    "time", "time", "timezone", "timezone", "title", "travel", "url", "weekly_digest_day", "weekly_digest_enabled", "weekly_digest_time", "weight_kg", "yearly"
  ]);
});

test("чистый проход миграции без гонки записывает версию схемы", async () => {
  const { db, log } = makeMockDb();
  await ensureSchemaOnce({ DB: db });
  deepStrictEqual(log.versionWrite, DB_SCHEMA_VERSION);
  // time + is_private (tasks) + time/is_private/created_by/kind (dates) + done_at
  // (wishes) + url/comment (wishes) + timezone (users, pairs) + expires_at (rate_limits)
  // + 5 настроек (users) + photo_url/show_avatar/partner_custom_name/custom_name (users)
  // + rating_source/rating_checked_at/details (movies, items 88/89/92)
  // + awaiting_return/last_partner (pairs, заморозка контента после выхода
  // партнёра и резерв кода за ушедшим)
  // + 3 настройки недельной сводки (users)
  // + cycle_length_known (cycle_profiles, аудит 3.1.D)
  // + clots/energy/symptoms_clear (cycle_logs, этап 4: разделение дневника)
  // + leakage/pain_score/pain_locations/life_impact (cycle_logs, этап 4/P1)
  // + mucus/sleep_hours/sleep_quality/stress/sick/travel/weight_kg
  //   (cycle_logs, этап 6/P2: слизь и факторы дня)
  // + notify_diary (cycle_profiles, P3: напоминание о дневнике)
  // + end_unknown (cycle_periods, история прошлых циклов: «конец не помним»)
  deepStrictEqual(log.alters.length, 52);
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
