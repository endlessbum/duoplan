// Группы фильмов/сериалов: API /api/movie-groups*, сводки в state,
// singleton-расформирование, изоляция пар. БД — настоящая SQLite (node:sqlite)
// через тонкий D1-совместимый shim: SQL и UNIQUE/FK работают по-настоящему.
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

// D1-совместимый shim поверх node:sqlite: prepare/bind → first/all/run,
// batch — одной транзакцией, как в D1.
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

function addMovie(env, { pairId = 1, imdb, title = "Фильм", kind = "movie", watched = 0, createdAt = 100 } = {}) {
  const row = env.DB._db.prepare(
    "INSERT INTO movies(pair_id,created_by,imdb_id,title,kind,watched,created_at) VALUES(?,?,?,?,?,?,?)"
  ).run(pairId, 1, imdb, title, kind, watched, createdAt);
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
    extractLine("const MOVIE_GROUP_TYPES = "),
    extractLine("const MOVIE_GROUP_TITLE_MAX = "),
    extractLine("const MOVIE_GROUP_MAX_ITEMS = "),
    extractLine("const MOVIE_GROUP_ID_RE = "),
    extractBraced("function validateSchema"),
    extractBraced("function attachMovieRatings"),
    extractBraced("function movieGroupType"),
    extractBraced("async function movieGroupOr404"),
    extractBraced("async function movieGroupSummaries"),
    extractBraced("async function movieGroupDetail"),
    extractBraced("async function disbandGroupIfSingleton"),
    extractBraced("async function itemRoute"),
    extractBraced("async function api"),
    "return { api, movieGroupSummaries, movieGroupDetail };"
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

const { api, movieGroupSummaries, movieGroupDetail } = bundle;

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

const groups = (env) => env.DB._db.prepare("SELECT * FROM movie_groups").all();
const items = (env, groupId) =>
  env.DB._db.prepare("SELECT * FROM movie_group_items WHERE group_id=? ORDER BY position").all(groupId);

test("POST /api/movie-groups: создание группы из двух фильмов", async () => {
  const { env, call } = makeEnv();
  const m1 = addMovie(env, { imdb: "tt1", title: "Часть 1" });
  const m2 = addMovie(env, { imdb: "tt2", title: "Часть 2" });
  const res = await call("POST", "/api/movie-groups", { title: "Серия", group_type: "franchise", movie_ids: [m1, m2] });
  equal(res.status, 200);
  const g = groups(env);
  equal(g.length, 1);
  equal(g[0].title, "Серия");
  equal(g[0].group_type, "franchise");
  equal(items(env, g[0].id).length, 2);
});

test("создание: один элемент, пустое/длинное имя, дубли ID — 400, группа не остаётся", async () => {
  const { env, call } = makeEnv();
  const m1 = addMovie(env, { imdb: "tt1" });
  const m2 = addMovie(env, { imdb: "tt2" });
  for (const body of [
    { title: "X", movie_ids: [m1] },
    { title: "   ", movie_ids: [m1, m2] },
    { title: "X".repeat(101), movie_ids: [m1, m2] },
    { title: "X", group_type: "bogus", movie_ids: [m1, m2] },
    { title: "X", movie_ids: [m1, m1] }
  ]) {
    await rejects(call("POST", "/api/movie-groups", body), (e) => e.status === 400);
  }
  equal(groups(env).length, 0, "частичной группы не осталось");
});

test("создание: несуществующий и чужой фильм — 400, группа не создаётся", async () => {
  const { env, call } = makeEnv();
  const m1 = addMovie(env, { imdb: "tt1" });
  env.DB._db.prepare("INSERT INTO pairs(id,code,name1,name2,user_a,user_b,started_at,timezone,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?)")
    .run(2, "WXYZ", "A", "B", 5, 6, "2026-01-01", "Europe/Moscow", 1, 1);
  const foreign = addMovie(env, { pairId: 2, imdb: "tt9", title: "Чужой" });
  await rejects(call("POST", "/api/movie-groups", { title: "X", movie_ids: [m1, 99999] }), (e) => e.status === 400);
  await rejects(call("POST", "/api/movie-groups", { title: "X", movie_ids: [m1, foreign] }), (e) => e.status === 400);
  equal(groups(env).length, 0);
});

test("создание: фильм уже в группе — 409, вторая группа не создаётся", async () => {
  const { env, call } = makeEnv();
  const m1 = addMovie(env, { imdb: "tt1" });
  const m2 = addMovie(env, { imdb: "tt2" });
  const m3 = addMovie(env, { imdb: "tt3" });
  await call("POST", "/api/movie-groups", { title: "Первая", movie_ids: [m1, m2] });
  const res = await call("POST", "/api/movie-groups", { title: "Вторая", movie_ids: [m2, m3] });
  equal(res.status, 409);
  equal(groups(env).length, 1);
});

test("GET /api/movie-groups/:id — полный состав; чужая пара — 404", async () => {
  const { env, call } = makeEnv();
  const m1 = addMovie(env, { imdb: "tt1", title: "А" });
  const m2 = addMovie(env, { imdb: "tt2", title: "Б", watched: 1 });
  await call("POST", "/api/movie-groups", { title: "Дуэт", movie_ids: [m1, m2] });
  const gid = groups(env)[0].id;
  const detail = await call("GET", `/api/movie-groups/${gid}`);
  equal(detail.status, 200);
  equal(detail.data.items.length, 2);
  ok("my_rating" in detail.data.items[0] && "pair_rating" in detail.data.items[0]);
  // Группа другой пары по известному UUID не отдаётся.
  env.DB._db.prepare("INSERT INTO pairs(id,code,name1,name2,user_a,user_b,started_at,timezone,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?)")
    .run(2, "WXYZ", "A", "B", 5, 6, "2026-01-01", "Europe/Moscow", 1, 1);
  env.DB._db.prepare("INSERT INTO movie_groups(id,pair_id,title,group_type,created_by,created_at,updated_at) VALUES(?,?,?,?,?,?,?)")
    .run("foreign-group", 2, "Чужая", "collection", 5, 1, 1);
  await rejects(call("GET", "/api/movie-groups/foreign-group"), (e) => e.status === 404);
});

test("PATCH: название/тип/порядок; order — строго перестановка состава", async () => {
  const { env, call } = makeEnv();
  const m1 = addMovie(env, { imdb: "tt1" });
  const m2 = addMovie(env, { imdb: "tt2" });
  const m3 = addMovie(env, { imdb: "tt3" });
  await call("POST", "/api/movie-groups", { title: "Сага", movie_ids: [m1, m2, m3] });
  const gid = groups(env)[0].id;
  await rejects(call("PATCH", `/api/movie-groups/${gid}`, { order: [m1, m2, 424242] }), (e) => e.status === 400);
  await rejects(call("PATCH", `/api/movie-groups/${gid}`, { order: [m1, m2] }), (e) => e.status === 400);
  const res = await call("PATCH", `/api/movie-groups/${gid}`, {
    title: "Сага — новая", group_type: "story", order: [m3, m1, m2]
  });
  equal(res.status, 200);
  const g = groups(env)[0];
  equal(g.title, "Сага — новая");
  equal(g.group_type, "story");
  deepStrictEqual(items(env, gid).map((r) => r.movie_id), [m3, m1, m2]);
});

test("POST items: в конец; дубль 409; перенос с подтверждением и уборкой источника", async () => {
  const { env, call } = makeEnv();
  const m1 = addMovie(env, { imdb: "tt1" });
  const m2 = addMovie(env, { imdb: "tt2" });
  const m3 = addMovie(env, { imdb: "tt3" });
  await call("POST", "/api/movie-groups", { title: "G1", movie_ids: [m1, m2] });
  const gid = groups(env)[0].id;
  await call("POST", `/api/movie-groups/${gid}/items`, { movie_id: m3 });
  equal(items(env, gid).at(-1).movie_id, m3);
  const dup = await call("POST", `/api/movie-groups/${gid}/items`, { movie_id: m3 });
  equal(dup.status, 409);
  // Источник из двух частей: после переноса m4 останется m5 одна → G2 уходит.
  const m4 = addMovie(env, { imdb: "tt4" });
  const m5 = addMovie(env, { imdb: "tt5" });
  await call("POST", "/api/movie-groups", { title: "G2", movie_ids: [m4, m5] });
  const gid2 = groups(env).find((g) => g.id !== gid).id;
  const conflict = await call("POST", `/api/movie-groups/${gid}/items`, { movie_id: m4 });
  equal(conflict.status, 409);
  equal(conflict.data.code, "ALREADY_GROUPED");
  equal(conflict.data.group_id, gid2);
  await call("POST", `/api/movie-groups/${gid}/items`, { movie_id: m4, move_from_group_id: gid2 });
  ok(!groups(env).some((g) => g.id === gid2), "источник из 2 частей расформирован");
  ok(items(env, gid).some((r) => r.movie_id === m4));
  ok(env.DB._db.prepare("SELECT id FROM movies WHERE id=?").get(m5), "оставшийся фильм не удалён");
});

test("DELETE item: связь удаляется, фильм остаётся; остаток 1 → группа расформирована", async () => {
  const { env, call } = makeEnv();
  const m1 = addMovie(env, { imdb: "tt1" });
  const m2 = addMovie(env, { imdb: "tt2" });
  await call("POST", "/api/movie-groups", { title: "G", movie_ids: [m1, m2] });
  const gid = groups(env)[0].id;
  await call("DELETE", `/api/movie-groups/${gid}/items/${m1}`);
  equal(groups(env).length, 0);
  ok(env.DB._db.prepare("SELECT id FROM movies WHERE id=?").get(m1));
});

test("DELETE group: расформирование без удаления фильмов", async () => {
  const { env, call } = makeEnv();
  const m1 = addMovie(env, { imdb: "tt1" });
  const m2 = addMovie(env, { imdb: "tt2" });
  await call("POST", "/api/movie-groups", { title: "G", movie_ids: [m1, m2] });
  const gid = groups(env)[0].id;
  await call("DELETE", `/api/movie-groups/${gid}`);
  equal(groups(env).length, 0);
  equal(env.DB._db.prepare("SELECT COUNT(*) n FROM movie_group_items").get().n, 0);
  equal(env.DB._db.prepare("SELECT COUNT(*) n FROM movies").get().n, 2);
});

test("удаление фильма через itemRoute: singleton-группа расформировывается", async () => {
  const { env, call } = makeEnv();
  const m1 = addMovie(env, { imdb: "tt1" });
  const m2 = addMovie(env, { imdb: "tt2" });
  const m3 = addMovie(env, { imdb: "tt3" });
  await call("POST", "/api/movie-groups", { title: "G", movie_ids: [m1, m2, m3] });
  const gid = groups(env)[0].id;
  await call("DELETE", `/api/movies/${m1}`);
  ok(groups(env).some((g) => g.id === gid), "после первого удаления группа жива");
  await call("DELETE", `/api/movies/${m2}`);
  equal(groups(env).length, 0, "singleton расформирована");
  ok(env.DB._db.prepare("SELECT id FROM movies WHERE id=?").get(m3));
});

test("movieGroupSummaries: счётчики и anchor по всей группе", async () => {
  const { env, call } = makeEnv();
  const m1 = addMovie(env, { imdb: "tt1", watched: 1 });
  const m2 = addMovie(env, { imdb: "tt2" });
  const m3 = addMovie(env, { imdb: "tt3", kind: "series" });
  await call("POST", "/api/movie-groups", { title: "G", movie_ids: [m1, m2, m3] });
  const summaries = await movieGroupSummaries(env, 1);
  equal(summaries.length, 1);
  const g = summaries[0];
  equal(g.total_count, 3);
  equal(g.watched_count, 1);
  equal(g.open_count, 2);
  equal(g.watched_percent, 33);
  equal(g.movie_count, 2);
  equal(g.series_count, 1);
  // Счётчики по статусу+типу нужны интерфейсу, чтобы кнопка стопки не
  // считала части только по загруженной странице при фильтре «Фильмы/Сериалы».
  equal(g.watched_movie_count, 1);
  equal(g.watched_series_count, 0);
  equal(g.open_movie_count, 1);
  equal(g.open_series_count, 1);
  ok(g.anchor && g.anchor.movie_id !== undefined);
});

test("movieGroupDetail: порядок position, оценки my/pair", async () => {
  const { env, call } = makeEnv();
  const m1 = addMovie(env, { imdb: "tt1" });
  const m2 = addMovie(env, { imdb: "tt2" });
  await call("POST", "/api/movie-groups", { title: "G", movie_ids: [m1, m2] });
  const gid = groups(env)[0].id;
  const detail = await movieGroupDetail(env, { id: 1 }, gid, 1);
  equal(detail.items.length, 2);
  deepStrictEqual(detail.items.map((m) => m.id), [m1, m2]);
});

test("второй участник пары читает группу", async () => {
  const { env, call } = makeEnv(777);
  const m1 = addMovie(env, { imdb: "tt1" });
  const m2 = addMovie(env, { imdb: "tt2" });
  const { call: callOwner } = makeEnv(1);
  // Группу создаёт первый участник — используем его env? Нет: env общий через call.
  // Проще: создаём групповые строки напрямую через SQL.
  void callOwner;
  const gid = "shared-group";
  env.DB._db.prepare("INSERT INTO movie_groups(id,pair_id,title,group_type,created_by,created_at,updated_at) VALUES(?,?,?,?,?,?,?)")
    .run(gid, 1, "Общая", "collection", 1, 1, 1);
  for (const [pos, mid] of [[0, m1], [1, m2]]) {
    env.DB._db.prepare("INSERT INTO movie_group_items(pair_id,group_id,movie_id,position,added_by,created_at) VALUES(?,?,?,?,?,?)")
      .run(1, gid, mid, pos, 1, 1);
  }
  const res = await call("GET", `/api/movie-groups/${gid}`);
  equal(res.status, 200);
  equal(res.data.items.length, 2);
});
