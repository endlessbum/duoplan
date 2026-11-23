// Регрессионные тесты аудита 2026-11-23 (второй проход, duoplan_audit_report.md).
//
// Покрывают BUG-2A-01…BUG-2A-08 и REL-2B-01/02 поведенчески: БД — настоящая
// SQLite (node:sqlite) через D1-совместимый shim (как test_movie_groups),
// маршруты гоняются через api/itemRoute. «Гонки» эмулируются последовательно:
// D1 сериализует записи, поэтому значимы инварианты после цепочки запросов.
//
// Запуск: node --test tests/test_audit_2026_11_23.test.mjs
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { deepStrictEqual, equal, ok, rejects } from "node:assert/strict";
import { test } from "node:test";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const source = readFileSync(join(root, "worker.js"), "utf8");
const appSource = readFileSync(join(root, "public/app.js"), "utf8");

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

// D1-совместимый shim поверх node:sqlite (копия приёма test_movie_groups).
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

let currentTgId = 1;
const json = (data, status = 200) => ({ data, status });
const readJsonReal = async (request) => JSON.parse(await request.text());

const bundle = new Function(
  "json", "ensureSchemaOnce", "telegramUser", "validTimeZone", "ensureUser",
  "rateLimit", "readJson", "state", "membership", "ownerIds", "cycleState",
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
    extractBraced("function textField"),
    extractBraced("function moneyAmount"),
    extractBraced("function wishUrl"),
    extractBraced("function validDate"),
    extractBraced("function optionalDay"),
    extractBraced("function optionalTime"),
    extractBraced("function showYearsValue"),
    extractBraced("function showYearsAllowed"),
    extractBraced("function planSchedule"),
    extractBraced("function movieRatingValue"),
    extractBraced("async function movieGroupOr404"),
    extractBraced("async function ensureWishOwner"),
    extractBraced("async function ensureSavingVisible"),
    extractBraced("async function ensureDateVisible"),
    extractBraced("async function ensureTaskVisible"),
    extractBraced("async function ensureGoalVisible"),
    extractBraced("async function disbandGroupIfSingleton"),
    extractBraced("async function itemRoute"),
    extractBraced("async function api"),
    "return { api };"
  ].join("\n")
)(
  json,
  async () => {},
  async () => ({ id: currentTgId, first_name: "Тест" }),
  () => "Europe/Moscow",
  async (e, tg) => ({ tg_id: typeof tg === "object" ? tg.id : tg, gender: "male", display_name: "Тест" }),
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
  const doCall = (who, method, path, body) => {
    currentTgId = who;
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
  const call = (method, path, body = null) => doCall(tgId, method, path, body);
  // callAs — вызов от другого участника той же пары (777 — партнёр, как в seed).
  return { env, call, callAs: (who, method, path, body = null) => doCall(who, method, path, body) };
}

// --- сиды --------------------------------------------------------------

const addSaving = (env, { kind = "shared", title = "Копилка", target = 1000, collected = 0, createdBy = 1 } = {}) =>
  Number(env.DB._db.prepare(
    "INSERT INTO savings(pair_id,created_by,kind,title,target,collected,created_at) VALUES(1,?,?,?,?,?,1)"
  ).run(createdBy, kind, title, target, collected).lastInsertRowid);

const addGoalWithItems = (env, { title = "Цель", items = ["Пункт"], createdBy = 1 } = {}) => {
  const db = env.DB._db;
  const goalId = Number(db.prepare(
    "INSERT INTO goals(pair_id,created_by,title,is_private,created_at) VALUES(1,?,?,0,1)"
  ).run(createdBy, title).lastInsertRowid);
  for (const item of items) {
    db.prepare("INSERT INTO goal_items(goal_id,pair_id,created_by,title,created_at) VALUES(?,1,?,?,1)")
      .run(goalId, createdBy, item);
  }
  return goalId;
};

const addMovie = (env, { imdb, title = "Фильм", kind = "movie" } = {}) =>
  Number(env.DB._db.prepare(
    "INSERT INTO movies(pair_id,created_by,imdb_id,title,kind,watched,created_at) VALUES(1,?,?,?,?,0,1)"
  ).run(1, imdb, title, kind).lastInsertRowid);

const addGroupWithItems = (env, movieIds, title = "Группа") => {
  const db = env.DB._db;
  const gid = `grp-${Math.random().toString(16).slice(2, 10)}`;
  db.prepare("INSERT INTO movie_groups(id,pair_id,title,group_type,created_by,created_at,updated_at) VALUES(?,?,?,?,?,?,?)")
    .run(gid, 1, title, "franchise", 1, 1, 1);
  for (const [pos, movieId] of movieIds.entries()) {
    db.prepare("INSERT INTO movie_group_items(pair_id,group_id,movie_id,position,added_by,created_at) VALUES(1,?,?,?,?,1)")
      .run(gid, movieId, pos, 1);
  }
  return gid;
};

const goalItems = (env, goalId) => env.DB._db.prepare("SELECT * FROM goal_items WHERE goal_id=? ORDER BY id").all(goalId);
const savingDeposits = (env, savingId) => env.DB._db.prepare("SELECT * FROM savings_deposits WHERE saving_id=? ORDER BY id").all(savingId);
const savingRowById = (env, savingId) => env.DB._db.prepare("SELECT * FROM savings WHERE id=?").get(savingId);

// --- BUG-2A-01: депозит в заполненную копилку --------------------------

test("BUG-2A-01: депозит в заполненную копилку — 409 SAVING_FULL, история не растёт", async () => {
  const { env, call } = makeEnv();
  const filled = addSaving(env, { target: 1000, collected: 1000 });
  await rejects(call("POST", `/api/savings/${filled}/deposit`, { amount: 100 }),
    (e) => e.status === 409 && e.code === "SAVING_FULL");
  equal(savingRowById(env, filled).collected, 1000, "collected вырос после достижения цели");
  equal(savingDeposits(env, filled).length, 0, "в истории появилась запись без изменения суммы");
});

test("BUG-2A-01: гонка за последний остаток — collected и история согласованы", async () => {
  const { env, call } = makeEnv();
  const saving = addSaving(env, { target: 1000, collected: 0 });
  // Два участника пополняют по очереди; collected строится только из истории.
  await call("POST", `/api/savings/${saving}/deposit`, { amount: 900 });
  await call("POST", `/api/savings/${saving}/deposit`, { amount: 100 });
  equal(savingRowById(env, saving).collected, 1000);
  // Третий (устаревшая форма) попадает в guard и не меняет ни сумму, ни историю.
  await rejects(call("POST", `/api/savings/${saving}/deposit`, { amount: 50 }),
    (e) => e.status === 409 && e.code === "SAVING_FULL");
  equal(savingRowById(env, saving).collected, 1000);
  const deposits = savingDeposits(env, saving);
  equal(deposits.length, 2, "в историю попала лишняя запись");
  // Инвариант отчёта: collected == SUM(истории пополнений).
  equal(deposits.reduce((acc, row) => acc + row.amount, 0), savingRowById(env, saving).collected,
    "история разошлась с collected");
});

// --- BUG-2A-04: shared_at при возврате желания в личные ----------------

test("BUG-2A-04: private → shared → private → shared, shared_at следует инварианту", async () => {
  const { env, call } = makeEnv();
  await call("POST", "/api/wishes", { body: "Плед", is_private: true });
  let wish = env.DB._db.prepare("SELECT * FROM wishes").get();
  equal(wish.is_private, 1);
  equal(wish.shared_at, null, "личное желание со shared_at на создании");

  // Клиент шлёт пустой JSON-объект на action-маршруты (как реальный request()).
  await call("POST", `/api/wishes/${wish.id}/share`, {});
  wish = env.DB._db.prepare("SELECT * FROM wishes").get();
  equal(wish.is_private, 0);
  const sharedAt = Number(wish.shared_at);
  ok(sharedAt > 0, "шеринг не записан");

  // Повторный PATCH уже общего желания не переписывает время шеринга.
  await call("PATCH", `/api/wishes/${wish.id}`, { is_private: false });
  wish = env.DB._db.prepare("SELECT * FROM wishes").get();
  equal(Number(wish.shared_at), sharedAt, "повторный PATCH сбросил/переписал время первого шеринга");

  // Возврат в личные обязан обнулять shared_at.
  await call("PATCH", `/api/wishes/${wish.id}`, { is_private: true });
  wish = env.DB._db.prepare("SELECT * FROM wishes").get();
  equal(wish.is_private, 1);
  equal(wish.shared_at, null, "остался stale shared_at после возврата в личные");

  // Новый шеринг снова ставит время.
  await call("POST", `/api/wishes/${wish.id}/share`, {});
  wish = env.DB._db.prepare("SELECT * FROM wishes").get();
  equal(wish.is_private, 0);
  ok(Number(wish.shared_at) > 0, "повторный шеринг не записал время");

  // Инвариант PD-WISHES-001: is_private=1 ⇒ shared_at IS NULL.
  await call("PATCH", `/api/wishes/${wish.id}`, { is_private: true });
  wish = env.DB._db.prepare("SELECT * FROM wishes").get();
  ok(!(Number(wish.is_private) === 1 && wish.shared_at !== null), "инвариант is_private=1 ⇒ shared_at IS NULL нарушен");
});

// --- BUG-2A-05: гонка удаления последних пунктов цели ------------------

test("BUG-2A-05: два удаления при двух пунктах — второй получает LAST_GOAL_ITEM", async () => {
  const { env, call } = makeEnv();
  const goalId = addGoalWithItems(env, { items: ["Первый", "Второй"] });
  const [itemA, itemB] = goalItems(env, goalId);

  // «Участник A» удаляет свой пункт — успех.
  await call("DELETE", `/api/goal_items/${itemA.id}`);
  equal(goalItems(env, goalId).length, 1, "после первого удаления пунктов больше одного");

  // «Участник B» успел прочитать count=2 и тоже удалает — теперь guard
  // атомарен: удаление не происходит и возвращается согласованный отказ.
  await rejects(call("DELETE", `/api/goal_items/${itemB.id}`),
    (e) => e.code === "LAST_GOAL_ITEM");
  equal(goalItems(env, goalId).length, 1, "цель осталась без пунктов");
  equal(goalItems(env, goalId)[0].id, itemB.id, "удалился не тот пункт");
});

test("BUG-2A-05: гонка одновременного удаления одного и того же пункта — 404, а не ложный LAST_GOAL_ITEM", async () => {
  const { env, call } = makeEnv();
  const goalId = addGoalWithItems(env, { items: ["Один", "Два"] });
  const [itemA] = goalItems(env, goalId);
  await call("DELETE", `/api/goal_items/${itemA.id}`);
  // Повторный DELETE того же — 404 (строки уже нет), последний пункт жив.
  await rejects(call("DELETE", `/api/goal_items/${itemA.id}`), (e) => e.status === 404);
  equal(goalItems(env, goalId).length, 1);
});

// --- BUG-2A-06: лимит 30 пунктов при конкурентном добавлении ------------

test("BUG-2A-06: 30-й пункт добавляется, 31-й — 409 GOAL_ITEMS_LIMIT, перевеса нет", async () => {
  const { env, call } = makeEnv();
  const goalId = addGoalWithItems(env, { items: Array.from({ length: 29 }, (_, i) => `Пункт ${i + 1}`) });
  // Последовательная эмуляция двух параллельных POST при 29 пунктах:
  // guard в INSERT-WHERE не даёт перейти через 30 ни в каком порядке.
  await call("POST", `/api/goals/${goalId}/items`, { title: "Тридцатый" });
  equal(goalItems(env, goalId).length, 30, "тридцатый пункт не вставился");
  await rejects(call("POST", `/api/goals/${goalId}/items`, { title: "Тридцать первый" }),
    (e) => e.status === 409 && e.code === "GOAL_ITEMS_LIMIT");
  equal(goalItems(env, goalId).length, 30, "число пунктов перевалило за 30");
});

// --- REL-2B-01: создание цели одним batch ------------------------------

test("REL-2B-01: POST /api/goals пишет цель и пункты одним batch, goal_id не нулевой", async () => {
  const { env, call } = makeEnv();
  await call("POST", "/api/goals", { title: "Ремонт", items: ["Купить краску", "Покрасить", "Отпраздновать"] });
  const goals = env.DB._db.prepare("SELECT * FROM goals").all();
  equal(goals.length, 1, "цель не создалась");
  const items = goalItems(env, goals[0].id);
  deepStrictEqual(items.map((i) => i.title), ["Купить краску", "Покрасить", "Отпраздновать"]);
  ok(Number(goals[0].id) > 0, "goal_id нулевой — пункты-сироты");
  equal(items.every((i) => Number(i.goal_id) === Number(goals[0].id)), true, "пункты привязаны не к той цели");
});

test("REL-2B-01 (валидация создания): пустые и лишние пункты отклоняются", async () => {
  const { env, call } = makeEnv();
  await rejects(call("POST", "/api/goals", { title: "X", items: ["  ", ""] }), (e) => e.status === 400);
  await rejects(call("POST", "/api/goals", { title: "X", items: Array.from({ length: 31 }, (_, i) => `П${i}`) }),
    (e) => e.status === 400);
  equal(env.DB._db.prepare("SELECT COUNT(*) n FROM goals").get().n, 0, "цель осталась без пунктов");
  equal(env.DB._db.prepare("SELECT COUNT(*) n FROM goal_items").get().n, 0);
});

// --- BUG-2A-07: конкурентное удаление частей группы фильмов ------------

test("BUG-2A-07: удаление двух частей из группы из трёх — расформирование, фильмы живы", async () => {
  const { env, call } = makeEnv();
  const m1 = addMovie(env, { imdb: "tt1", title: "Часть 1" });
  const m2 = addMovie(env, { imdb: "tt2", title: "Часть 2" });
  const m3 = addMovie(env, { imdb: "tt3", title: "Часть 3" });
  const gid = addGroupWithItems(env, [m1, m2, m3]);
  // Два «параллельных» запроса на удаление разных частей: оба читают count=3.
  await call("DELETE", `/api/movie-groups/${gid}/items/${m1}`);
  equal(env.DB._db.prepare("SELECT COUNT(*) n FROM movie_groups WHERE id=?").get(gid).n, 1,
    "группа из трёх после первого удаления преждевременно расформирована");
  equal(env.DB._db.prepare("SELECT COUNT(*) n FROM movie_group_items WHERE group_id=?").get(gid).n, 2);
  await call("DELETE", `/api/movie-groups/${gid}/items/${m2}`);
  equal(env.DB._db.prepare("SELECT COUNT(*) n FROM movie_groups WHERE id=?").get(gid).n, 0, "singleton-группа осталась");
  equal(env.DB._db.prepare("SELECT COUNT(*) n FROM movie_group_items WHERE group_id=?").get(gid).n, 0, "связи остались");
  for (const movieId of [m1, m2, m3]) {
    ok(env.DB._db.prepare("SELECT id FROM movies WHERE id=?").get(movieId), `фильм ${movieId} удалён из списка`);
  }
});

test("BUG-2A-07: удаление части из двух — фильм остаётся, группа уходит", async () => {
  const { env, call } = makeEnv();
  const m1 = addMovie(env, { imdb: "tt1" });
  const m2 = addMovie(env, { imdb: "tt2" });
  const gid = addGroupWithItems(env, [m1, m2]);
  await call("DELETE", `/api/movie-groups/${gid}/items/${m1}`);
  equal(env.DB._db.prepare("SELECT COUNT(*) n FROM movie_groups").get().n, 0);
  ok(env.DB._db.prepare("SELECT id FROM movies WHERE id=?").get(m1));
  ok(env.DB._db.prepare("SELECT id FROM movies WHERE id=?").get(m2));
});

// --- BUG-2A-08: двойной выбор копилки при создании поездки -------------

test("BUG-2A-08: saving_id и new_saving вместе — 400 INVALID_SAVING_CHOICE, ничего не создаётся", async () => {
  const { env, call } = makeEnv();
  const existing = addSaving(env, { kind: "shared", target: 5000, collected: 100 });
  await rejects(call("POST", "/api/trips", {
    title: "Байкал",
    saving_id: existing,
    new_saving: { title: "Новая копилка", target: 3000 }
  }), (e) => e.status === 400 && e.code === "INVALID_SAVING_CHOICE");
  equal(env.DB._db.prepare("SELECT COUNT(*) n FROM savings").get().n, 1, "лишняя копилка создана");
  equal(env.DB._db.prepare("SELECT COUNT(*) n FROM trips").get().n, 0, "поездка создана при отказе");
});

// --- REL-2B-02: поездка с новой копилкой одним batch -------------------

test("REL-2B-02: POST /api/trips с new_saving создаёт копилку и поездку одним batch", async () => {
  const { env, call } = makeEnv();
  await call("POST", "/api/trips", { title: "Италия", note: "Лето", new_saving: { title: "На Италию", target: 150000 } });
  const savings = env.DB._db.prepare("SELECT * FROM savings").all();
  const trips = env.DB._db.prepare("SELECT * FROM trips").all();
  equal(savings.length, 1);
  equal(savings[0].kind, "shared");
  equal(trips.length, 1);
  equal(Number(trips[0].saving_id), Number(savings[0].id), "поездка не связана с созданной копилкой");
});

test("REL-2B-02 (happy path): поездка с привязкой существующей копилки", async () => {
  const { env, call } = makeEnv();
  const saving = addSaving(env, { kind: "shared", target: 5000, collected: 100 });
  await call("POST", "/api/trips", { title: "Байкал", saving_id: saving });
  const trip = env.DB._db.prepare("SELECT * FROM trips").get();
  equal(Number(trip.saving_id), saving, "копилка не привязалась к поездке");
  equal(env.DB._db.prepare("SELECT COUNT(*) n FROM savings").get().n, 1, "создана лишняя копилка");
});

// --- BUG-2A-02: правка поездки сохраняет связь с копилкой --------------

test("BUG-2A-02: правка поездки не отвязывает заполненную копилку", async () => {
  const { env, call } = makeEnv();
  const saving = addSaving(env, { kind: "shared", target: 100, collected: 0 });
  await call("POST", "/api/trips", { title: "Япония", saving_id: saving });
  // Копилку заполнили после создания поездки.
  await call("POST", `/api/savings/${saving}/deposit`, { amount: 100 });
  equal(savingRowById(env, saving).collected, 100);

  // PATCH без saving_id (правка только заметки) трогать связь не должен.
  const tripId = env.DB._db.prepare("SELECT id FROM trips").get().id;
  await call("PATCH", `/api/trips/${tripId}`, { note: "На майские" });
  equal(Number(env.DB._db.prepare("SELECT * FROM trips").get().saving_id), saving,
    "PATCH без saving_id отвязал копилку");

  // PATCH с текущим (уже заполненным) id — сохранение связи разрешено.
  await call("PATCH", `/api/trips/${tripId}`, { note: "Ещё правка", saving_id: saving });
  equal(Number(env.DB._db.prepare("SELECT * FROM trips").get().saving_id), saving,
    "сохранение связи с заполненной копилкой получило отказ");

  // ЧУЖАЯ заполненная копилка для НОВОЙ привязки по-прежнему недоступна.
  const otherFull = addSaving(env, { kind: "shared", title: "Другая", target: 50, collected: 50 });
  await rejects(call("PATCH", `/api/trips/${tripId}`, { note: "x", saving_id: otherFull }),
    (e) => e.status === 404);

  // Явный сброс связи работает.
  await call("PATCH", `/api/trips/${tripId}`, { note: "x", saving_id: null });
  equal(env.DB._db.prepare("SELECT * FROM trips").get().saving_id, null, "сброс связи не сработал");
});

test("BUG-2A-02: копилку с привязанной поездкой нельзя спрятать в личные", async () => {
  const { env, call, callAs } = makeEnv();
  const saving = addSaving(env, { kind: "shared", target: 100, collected: 10 });
  await call("POST", "/api/trips", { title: "Италия", saving_id: saving });
  // Автор копилки не может сменить вид, пока поездка ссылается на неё.
  await rejects(call("PATCH", `/api/savings/${saving}`, { kind: "personal" }),
    (e) => e.status === 409 && e.code === "SAVING_TRIP_LINKED");
  // Партнёру — прежний 403 NOT_OWNER, а не 409.
  await rejects(callAs(777, "PATCH", `/api/savings/${saving}`, { kind: "personal" }),
    (e) => e.status === 403 && e.code === "NOT_OWNER");
  // После снятия связи смена вида работает.
  await call("PATCH", `/api/trips/${env.DB._db.prepare("SELECT id FROM trips").get().id}`, { saving_id: null });
  await call("PATCH", `/api/savings/${saving}`, { kind: "personal" });
  equal(env.DB._db.prepare("SELECT kind FROM savings WHERE id=?").get(saving).kind, "personal");
});

// --- BUG-2A-03: время у дня рождения ------------------------------------

test("BUG-2A-03: POST /api/dates birthday с time — время отброшено, recurs=1, monthly=0", async () => {
  const { env, call } = makeEnv();
  await call("POST", "/api/dates", { title: "Маша", day: "2000-05-10", kind: "birthday", time: "19:00" });
  const birthday = env.DB._db.prepare("SELECT * FROM dates WHERE kind='birthday'").get();
  equal(birthday.time, null, "день рождения создался со временем");
  equal(Number(birthday.recurs), 1);
  equal(Number(birthday.monthly), 0);
  // Обычная дата время сохраняет.
  await call("POST", "/api/dates", { title: "Кино", day: "2026-12-01", kind: "date", time: "19:00" });
  equal(env.DB._db.prepare("SELECT time FROM dates WHERE kind='date'").get().time, "19:00");
});

test("BUG-2A-03: PATCH вычищает legacy-время дня рождения", async () => {
  const { env, call } = makeEnv();
  await call("POST", "/api/dates", { title: "Маша", day: "2000-05-10", kind: "birthday" });
  const id = env.DB._db.prepare("SELECT id FROM dates WHERE kind='birthday'").get().id;
  // Готовим legacy-строку со временем (как будто создана старой версией).
  env.DB._db.prepare("UPDATE dates SET time='19:00' WHERE id=?").run(id);

  // PATCH одного названия обязан вычистить время.
  await call("PATCH", `/api/dates/${id}`, { title: "Мария" });
  equal(env.DB._db.prepare("SELECT time FROM dates WHERE id=?").get(id).time, null,
    "PATCH названия не вычистил legacy-время");

  // Прямой запрос time при PATCH дня рождения игнорируется.
  await call("PATCH", `/api/dates/${id}`, { title: "Мария", day: "2000-05-10", time: "19:00" });
  const row = env.DB._db.prepare("SELECT * FROM dates WHERE id=?").get(id);
  equal(row.time, null, "PATCH вернул время дню рождения");
  equal(Number(row.recurs), 1);
  equal(Number(row.monthly), 0);
});

test("BUG-2A-03: PATCH обычной даты время сохраняет (регрессия)", async () => {
  const { env, call } = makeEnv();
  await call("POST", "/api/dates", { title: "Кино", day: "2026-12-01", kind: "date", time: "19:00" });
  const id = env.DB._db.prepare("SELECT id FROM dates WHERE kind='date'").get().id;
  await call("PATCH", `/api/dates/${id}`, { title: "Кино", day: "2026-12-02", time: "20:30" });
  const row = env.DB._db.prepare("SELECT * FROM dates WHERE id=?").get(id);
  equal(row.day, "2026-12-02");
  equal(row.time, "20:30", "время обычной даты потерялось");
  // Название без расписания не сбрасывает день/время.
  await call("PATCH", `/api/dates/${id}`, { title: "Театр" });
  const after = env.DB._db.prepare("SELECT * FROM dates WHERE id=?").get(id);
  equal(after.day, "2026-12-02");
  equal(after.time, "20:30");
});

// --- клиент: форма поездки, депозит, импорт ----------------------------

function extractAppBraced(declaration) {
  const start = appSource.indexOf(declaration);
  if (start === -1) throw new Error(`${declaration} not found`);
  let depth = 0;
  for (let j = appSource.indexOf("{", start); j < appSource.length; j++) {
    if (appSource[j] === "{") depth++;
    else if (appSource[j] === "}") {
      depth--;
      if (depth === 0) return appSource.slice(start, j + 1);
    }
  }
  throw new Error(`unclosed block: ${declaration}`);
}

test("app: форма поездки показывает текущую копилку с честной подписью (BUG-2A-02)", () => {
  const tripSavingFormFields = new Function(
    [
      extractAppBraced("function esc"),
      "const formatAmount = (v) => String(v ?? 0);",
      extractAppBraced("function tripSavingFormFields"),
      "return tripSavingFormFields;"
    ].join("\n")
  )();
  // Текущая, недоступная для новых привязок копилка остаётся пунктом списка.
  const fields = tripSavingFormFields([
    { id: 1, kind: "shared", title: "Море", target: 500, collected: 0 },
    { id: 2, kind: "shared", title: "Море 2", target: 500, collected: 500, tripCurrent: true }
  ], 2);
  ok(fields.includes('<option value="2" selected>'), "текущая копилка не предвыбрана");
  ok(fields.includes("текущая (привязку можно только сохранить)"), "нет честной подписи текущей копилки");
  // Копилка, скрытая от зрителя (стала личной), — подпись без названия.
  const hidden = tripSavingFormFields([{ id: 9, tripCurrentHidden: true }], 9);
  ok(hidden.includes('<option value="9" selected>'), "скрытая текущая копилка не предвыбрана");
  ok(hidden.includes("Текущая копилка (привязку можно только сохранить)"), "нет подписи скрытой текущей копилки");
  ok(!hidden.includes("Море"), "скрытой копилке утекло название");
});

test("app: клиент обрабатывает SAVING_FULL в диалоге пополнения (BUG-2A-01)", () => {
  ok(appSource.includes('error?.code !== "SAVING_FULL"'),
    "депозитный диалог не различает SAVING_FULL и перебрасывает прочие ошибки");
  ok(appSource.includes("уже заполнена — цель закрыта"),
    "нет понятного тоста для SAVING_FULL");
});

test("app: диалог редактирования поездки подмешивает текущую копилку (BUG-2A-02)", () => {
  ok(appSource.includes("availableTripSavings().slice()"), "список выбора поездки не построен на копиях доступных");
  ok(appSource.includes("tripCurrentHidden: true"), "нет варианта для скрытой текущей копилки");
  ok(appSource.includes("tripSavingFormFields(tripChoices, item.saving_id || null)"),
    "edit-диалог поездки не использует подмешанный список");
});

test("worker: импорт очищает время у дней рождения (BUG-2A-03)", () => {
  ok(source.includes('kind === "birthday" ? null : optionalTime(row?.time ?? null)'),
    "импорт не нормализует время дня рождения");
});

