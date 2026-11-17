// «Остановились» (migrations/0048): POST /api/movies/:id/resume — точка
// прерванного просмотра фильма/сериала. БД — настоящая SQLite (node:sqlite)
// через D1-совместимый shim, как в test_movie_groups.test.mjs.
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { deepStrictEqual, equal, ok, rejects } from "node:assert/strict";
import { test } from "node:test";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const source = readFileSync(join(root, "worker.js"), "utf8");

function extractBraced(declaration) {
  const start = source.indexOf(declaration);
  if (start === -1) throw new Error(`${declaration} not found`);
  let depth = 0;
  for (let j = source.indexOf("{", start); j < source.length; j++) {
    if (source[j] === "{") depth++;
    else if (source[j] === "}") {
      depth--;
      if (depth === 0) return source.slice(start, j + 1);
    }
  }
  throw new Error(`unclosed block: ${declaration}`);
}
function extractLine(prefix) {
  const start = source.indexOf(prefix);
  if (start === -1) throw new Error(`${prefix} not found`);
  return source.slice(start, source.indexOf("\n", start));
}

function createD1() {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys=ON");
  for (const file of readdirSync(join(root, "migrations")).filter((f) => f.endsWith(".sql")).sort()) {
    db.exec(readFileSync(join(root, "migrations", file), "utf8"));
  }
  const wrap = (sql, args = []) => ({
    async first() {
      const row = db.prepare(sql).get(...args);
      return row === undefined ? null : row;
    },
    async all() {
      return { results: db.prepare(sql).all(...args) };
    },
    async run() {
      const result = db.prepare(sql).run(...args);
      return { meta: { changes: Number(result.changes), last_row_id: Number(result.lastInsertRowid) } };
    }
  });
  return {
    _db: db,
    prepare(sql) {
      return {
        bind(...args) { return wrap(sql, args); },
        ...wrap(sql)
      };
    },
    async batch(statements) {
      db.exec("BEGIN");
      try {
        const out = [];
        for (const statement of statements) out.push(await statement.run());
        db.exec("COMMIT");
        return out;
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
    }
  };
}

function seed(env) {
  const db = env.DB._db;
  db.prepare("INSERT INTO users(tg_id,username,display_name,created_at,updated_at) VALUES(?,?,?,?,?)")
    .run(1, "owner", "Owner", 1, 1);
  db.prepare("INSERT INTO users(tg_id,username,display_name,created_at,updated_at) VALUES(?,?,?,?,?)")
    .run(777, "partner", "Partner", 1, 1);
  db.prepare("INSERT INTO pairs(id,code,name1,name2,user_a,user_b,started_at,timezone,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?)")
    .run(1, "ABCD", "Owner", "Partner", 1, 777, "2026-01-01", "Europe/Moscow", 1, 1);
  db.prepare("INSERT INTO pair_members(tg_id,pair_id,role,joined_at) VALUES(?,?,?,?)").run(1, 1, "a", 1);
  db.prepare("INSERT INTO pair_members(tg_id,pair_id,role,joined_at) VALUES(?,?,?,?)").run(777, 1, "b", 1);
}

function addMovie(env, { pairId = 1, imdb = "tt1", title = "Фильм", kind = "movie", watched = 0, resume = null } = {}) {
  const row = env.DB._db.prepare(
    "INSERT INTO movies(pair_id,created_by,imdb_id,title,kind,watched,resume_position,created_at) VALUES(?,?,?,?,?,?,?,?)"
  ).run(pairId, 1, imdb, title, kind, watched, resume, 100);
  return Number(row.lastInsertRowid);
}

const json = (data, status = 200) => ({ data, status });
const readJsonReal = async (request) => JSON.parse(await request.text());
let currentTgId = 1;

const bundle = new Function(
  "json", "ensureSchemaOnce", "telegramUser", "validTimeZone", "ensureUser",
  "rateLimit", "readJson", "state", "membership", "ownerIds",
  "cycleState",
  [
    extractBraced("class HttpError"),
    extractLine("const now = "),
    extractLine("const clean = "),
    extractLine("const positiveId = "),
    extractBraced("function validateSchema"),
    extractBraced("function movieRatingValue"),
    extractBraced("async function itemRoute"),
    extractBraced("async function api"),
    "return { api };"
  ].join("\n")
)(
  json,
  async () => {},
  async () => ({ id: currentTgId, first_name: "Тест" }),
  () => "Europe/Moscow",
  async (e, tg) => ({ tg_id: tg.id, gender: "male", display_name: "Тест" }),
  async () => {},
  readJsonReal,
  async () => ({ stub: true }),
  async (e, uid) => {
    const row = e.DB._db.prepare(
      "SELECT p.*, pm.role AS member_role FROM pairs p JOIN pair_members pm ON pm.pair_id=p.id WHERE pm.tg_id=?"
    ).get(uid);
    if (!row) return null;
    return { ...row, role: row.member_role === "a" ? "a" : "b" };
  },
  () => [],
  async () => ({})
);

const { api } = bundle;

function makeEnv(tgId = 1) {
  const env = { DB: createD1(), BOT_TOKEN: "test" };
  seed(env);
  const call = (method, path, body = null) => {
    currentTgId = tgId;
    return api(
      {
        method,
        headers: { get: (name) => (name === "x-telegram-init-data" ? "init" : name === "x-timezone" ? "Europe/Moscow" : null) },
        text: async () => (body === null ? "" : JSON.stringify(body)),
        body: null
      },
      env,
      new URL("https://duoplan.test" + path),
      null
    );
  };
  return { env, call };
}

const resumeOf = (env, id) =>
  env.DB._db.prepare("SELECT resume_position FROM movies WHERE id=?").get(id).resume_position;

test("resume: отметка ставится, читается из базы, меняется и снимается", async () => {
  const { env, call } = makeEnv();
  const id = addMovie(env, { imdb: "tt1" });

  let res = await call("POST", `/api/movies/${id}/resume`, { position: "1:23:45" });
  equal(res.status, 200);
  equal(resumeOf(env, id), "1:23:45");

  // Свободный текст: у сериала — сезон/серия/момент.
  res = await call("POST", `/api/movies/${id}/resume`, { position: "  2 сезон, 5 серия · 34:12  " });
  equal(res.status, 200);
  equal(resumeOf(env, id), "2 сезон, 5 серия · 34:12", "края обрезаются");

  // null и пустая строка — снять отметку.
  await call("POST", `/api/movies/${id}/resume`, { position: null });
  equal(resumeOf(env, id), null);
  await call("POST", `/api/movies/${id}/resume`, { position: "45 мин" });
  // Пустая/пробельная строка — то же снятие отметки, что и null.
  await call("POST", `/api/movies/${id}/resume`, { position: "   " });
  equal(resumeOf(env, id), null);
});

test("resume: валидация — не-строка, пусто после trim и >120 символов → 400", async () => {
  const { env, call } = makeEnv();
  const id = addMovie(env, { imdb: "tt1" });
  await call("POST", `/api/movies/${id}/resume`, { position: "12:00" });

  for (const body of [
    { position: 123 },
    { position: "x".repeat(121) }
  ]) {
    await rejects(call("POST", `/api/movies/${id}/resume`, body), (e) => e.status === 400 && e.code === "INVALID_POSITION");
  }
  equal(resumeOf(env, id), "12:00", "невалидные значения не затирают отметку");
});

test("resume: чужая пара и несуществующий фильм — 404", async () => {
  const { env, call } = makeEnv();
  // Вторая пара — только для FK: фильм «чужого» пространства.
  env.DB._db.prepare("INSERT INTO pairs(id,code,name1,name2,user_a,user_b,started_at,timezone,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?)")
    .run(2, "WXYZ", "A", "B", 777, 0, "2026-01-01", "Europe/Moscow", 1, 1);
  const foreign = addMovie(env, { pairId: 2, imdb: "tt9" });
  await rejects(call("POST", `/api/movies/${foreign}/resume`, { position: "1:00" }), (e) => e.status === 404);
  await rejects(call("POST", "/api/movies/99999/resume", { position: "1:00" }), (e) => e.status === 404);
  equal(resumeOf(env, foreign), null);
});

test("resume: «Просмотрено» сбрасывает точку, возврат в планы её не воскрешает", async () => {
  const { env, call } = makeEnv();
  const id = addMovie(env, { imdb: "tt1" });
  await call("POST", `/api/movies/${id}/resume`, { position: "58:20" });
  await call("POST", `/api/movies/${id}/watched`, { rating: 8 });
  equal(resumeOf(env, id), null, "просмотренный фильм точки не хранит");
  await call("POST", `/api/movies/${id}/unwatched`, {});
  equal(resumeOf(env, id), null, "возврат в «Хотим посмотреть» отметку не возвращает");
});

test("resume: отметка доступна обоим участникам пары", async () => {
  const { env, call } = makeEnv(1);
  const id = addMovie(env, { imdb: "tt1" });
  await call("POST", `/api/movies/${id}/resume`, { position: "10:00" });
  await call("POST", `/api/movies/${id}/resume`, { position: "11:30" });
  // Партнёр (tg_id=777) правит ту же запись пары.
  const { call: callPartner } = makeEnvPartner(env);
  await callPartner("POST", `/api/movies/${id}/resume`, { position: "12:15" });
  equal(resumeOf(env, id), "12:15");
});

function makeEnvPartner(env) {
  const call = (method, path, body = null) => {
    currentTgId = 777;
    return api(
      {
        method,
        headers: { get: (name) => (name === "x-telegram-init-data" ? "init" : name === "x-timezone" ? "Europe/Moscow" : null) },
        text: async () => (body === null ? "" : JSON.stringify(body)),
        body: null
      },
      { DB: env.DB, BOT_TOKEN: "test" },
      new URL("https://duoplan.test" + path),
      null
    );
  };
  return { call };
}

test("resume: колонка в state/архиве/деталях группы и в ensureSchema", () => {
  // SELECT-списки фильмов отдают resume_position — иначе чип не появится.
  const selects = source.match(/SELECT m\.id,m\.imdb_id[\s\S]*?FROM movies m/g) || [];
  ok(selects.length >= 3, `ожидалось ≥3 выборок фильмов, найдено ${selects.length}`);
  for (const sql of selects) {
    ok(sql.includes("resume_position"), "выборка фильмов без resume_position");
  }
  ok(source.includes("resume_position TEXT"), "нет колонки в CREATE TABLE movies");
  ok(source.includes('["movies", "resume_position", "TEXT"]'), "нет ALTER в ensureSchema");
  ok(source.includes('"resume"'), "resume нет в regex itemRoute");
  const migration = readFileSync(join(root, "migrations", "0048_movie_resume.sql"), "utf8");
  ok(migration.includes("ALTER TABLE movies ADD COLUMN resume_position"), "миграция 0048 не совпадает");
});
