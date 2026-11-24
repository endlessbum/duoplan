// HTTP-тесты личных заметок (/api/notes): владелец = tg_id сессии,
// партнёр чужие заметки не видит и не правит, ответ — список заметок,
// а не /api/state. Паттерн тот же, что в test_contacts_api.test.mjs.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
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

const buildApi = new Function(
  "json", "ensureSchemaOnce", "telegramUser", "validTimeZone", "ensureUser",
  "rateLimit", "readJson", "state", "membership", "ownerIds",
  "cycleState", "notesState",
  [
    extractBraced("class HttpError"),
    extractLine("const now = "),
    extractLine("const clean = "),
    extractBraced("function ownerIds"),
    extractBraced("function wishUrl"),
    extractBraced("async function notesState"),
    extractBraced("async function api"),
    "return api;"
  ].join("\n")
);

// Мок БД: run() возвращает управляемый changes (владелец/чужая запись),
// all() отдаёт строки заметок для SELECT notesState.
function createMockDB({ changes = 1, rows = [] } = {}) {
  const writes = [];
  const db = {
    writes,
    storedRows: rows,
    async batch(statements = []) { return statements.map(() => ({ meta: { changes: 1 } })); },
    prepare(sql) {
      return {
        bind(...args) {
          writes.push({ sql, args });
          return {
            async first() { return null; },
            async all() {
              if (sql.includes("FROM notes WHERE tg_id=?")) return { results: rows };
              return { results: [] };
            },
            async run() { return { meta: { changes, last_row_id: 42 } }; }
          };
        },
        async batch() { return {}; }
      };
    }
  };
  return db;
}

function makeApi(db, body, method = "POST") {
  const request = { method, headers: { get: () => null } };
  const api = buildApi(
    (data, status = 200) => ({ data, status }),
    async () => {},
    async () => ({ id: 777, first_name: "Тест" }),
    () => "Europe/Moscow",
    async () => ({ tg_id: 777, gender: null }),
    async () => {},
    async () => body,
    async () => ({ user: { tg_id: 777, gender: null }, pair: null }),
    () => [], // ownerIds перекрывается извлечённой функцией из worker.js
    async () => ({ id: 1, user_a: 1, user_b: 777 }),
    async () => [],
    async () => ({ periods: [], logs: [] }),
    async (env, tgId) => {
      const fresh = db.writes.some(w => w.sql.includes("INSERT INTO notes"))
        ? [{ id: 42, title: "Новая", body: "", comment: "", created_at: 1, updated_at: 1 }]
        : db.storedRows;
      return { notes: fresh.map(r => ({ id: r.id, title: r.title, body: r.body || "", comment: r.comment || "", url: r.url || "", created_at: r.created_at, updated_at: r.updated_at })) };
    }
  );
  return { api, request, env: { DB: db }, writes: db.writes };
}

function isHttpError(error, status, code) {
  return error && error.status === status && error.code === code;
}

const NOTE = { title: "Идеи для отпуска", body: "Горы или море?", comment: "решить до декабря" };

test("POST без названия отклоняется", async () => {
  const db = createMockDB();
  const { api, request, env } = makeApi(db, { ...NOTE, title: "  " });
  await rejects(
    api(request, env, new URL("https://duoplan.test/api/notes")),
    err => isHttpError(err, 400, "INVALID_TITLE")
  );
});

test("создание: INSERT по tg_id сессии, ответ — список заметок", async () => {
  const db = createMockDB();
  const { api, request, env, writes } = makeApi(db, NOTE);
  const response = await api(request, env, new URL("https://duoplan.test/api/notes"));
  ok(response.status === 200);
  const insert = writes.find(w => w.sql.includes("INSERT INTO notes("));
  ok(insert, "заметка вставляется");
  equal(insert.args[0], 777, "владелец — tg_id сессии");
  deepStrictEqual(insert.args.slice(1, 4), [NOTE.title, NOTE.body, NOTE.comment]);
  ok(Array.isArray(response.data.notes), "ответ содержит список заметок");
  ok(!response.data.pair && !response.data.user, "ответ не является /api/state");
});

test("правка: UPDATE только своей записи, чужая — 404", async () => {
  const db = createMockDB({ changes: 0 });
  const { api, request, env, writes } = makeApi(db, { ...NOTE, id: 55 });
  await rejects(
    api(request, env, new URL("https://duoplan.test/api/notes")),
    err => isHttpError(err, 404, "NOT_FOUND")
  );
  const update = writes.find(w => w.sql.includes("UPDATE notes SET"));
  ok(update, "правка идёт UPDATE-ом");
  ok(update.sql.includes("WHERE id=? AND tg_id=?"), "UPDATE ограничен владельцем");
});

test("правка своей записи проходит", async () => {
  const db = createMockDB({ changes: 1 });
  const { api, request, env, writes } = makeApi(db, { ...NOTE, id: 42 });
  const response = await api(request, env, new URL("https://duoplan.test/api/notes"));
  ok(response.status === 200);
  const update = writes.find(w => w.sql.includes("UPDATE notes SET"));
  deepStrictEqual(update.args.slice(-2), [42, 777], "id и владелец в условии");
});

test("удаление: только владелец, чужая запись — 404", async () => {
  const db = createMockDB({ changes: 0 });
  const { api, request, env, writes } = makeApi(db, { id: 55 }, "POST");
  await rejects(
    api(request, env, new URL("https://duoplan.test/api/notes/delete")),
    err => isHttpError(err, 404, "NOT_FOUND")
  );
  const del = writes.find(w => w.sql.includes("DELETE FROM notes WHERE id=? AND tg_id=?"));
  ok(del, "удаление ограничено владельцем");
});

test("удаление своей записи проходит", async () => {
  const db = createMockDB({ changes: 1 });
  const { api, request, env, writes } = makeApi(db, { id: 42 });
  const response = await api(request, env, new URL("https://duoplan.test/api/notes/delete"));
  ok(response.status === 200);
  const del = writes.find(w => w.sql.includes("DELETE FROM notes WHERE id=? AND tg_id=?"));
  deepStrictEqual(del.args, [42, 777]);
});

test("GET отдаёт список по tg_id сессии", async () => {
  const db = createMockDB({ rows: [{ id: 7, title: "Личное", body: "текст", comment: "", created_at: 5, updated_at: 6 }] });
  const { api, request, env, writes } = makeApi(db, {}, "GET");
  const response = await api(request, env, new URL("https://duoplan.test/api/notes"));
  ok(response.status === 200);
  equal(response.data.notes[0].title, "Личное");
  const select = writes.find(w => w.sql.includes("FROM notes WHERE tg_id=?"));
  ok(select, "список читается по владельцу");
  deepStrictEqual(select.args, [777]);
});

test("список сортируется по свежей правке", () => {
  ok(source.includes("FROM notes WHERE tg_id=? ORDER BY updated_at DESC, id DESC"),
    "порядок: updated_at DESC, id DESC");
});

// ---------- пароль заметок живёт на клиенте: сервер не хранит ----------

test("сервер не хранит и не запрашивает пароль заметок", () => {
  ok(!/notesPin|notes_pin|notes_password/i.test(source), "в worker.js нет пароля заметок");
});

test("заметки не попадают в /api/state", () => {
  // state() собирает разделы состояния: FROM notes там быть не должно.
  const stateBlock = extractBraced("async function state");
  ok(!stateBlock.includes("FROM notes"), "state() не читает таблицу notes");
});

test("схема: таблица и индекс создаются в ensureSchema и миграцией 0054", () => {
  ok(source.includes("CREATE TABLE IF NOT EXISTS notes (id INTEGER PRIMARY KEY AUTOINCREMENT,tg_id INTEGER NOT NULL,title TEXT NOT NULL"), "ensureSchema создаёт notes");
  ok(source.includes("CREATE INDEX IF NOT EXISTS idx_notes_tg ON notes(tg_id,updated_at)"), "индекс владельца");
  const migration = readFileSync(join(root, "migrations", "0054_notes.sql"), "utf8");
  ok(migration.includes("CREATE TABLE IF NOT EXISTS notes"), "миграция 0054 существует");
  ok(migration.includes("idx_notes_tg"), "миграция создаёт индекс");
});

// ---------- ссылка заметки (миграция 0055): та же валидация, что у желаний ----------

test("ссылка сохраняется: INSERT и UPDATE пишут url, пустая — NULL", async () => {
  const db = createMockDB();
  const { api, request, env, writes } = makeApi(db, { ...NOTE, url: "https://example.com/ideas" });
  const response = await api(request, env, new URL("https://duoplan.test/api/notes"));
  ok(response.status === 200);
  const insert = writes.find(w => w.sql.includes("INSERT INTO notes("));
  ok(insert.sql.includes("url"), "INSERT содержит колонку url");
  equal(insert.args[4], "https://example.com/ideas", "ссылка на пятой позиции INSERT");

  const dbEdit = createMockDB();
  const { api: apiEdit, request: reqEdit, env: envEdit, writes: wEdit } = makeApi(dbEdit, { ...NOTE, id: 9, url: "https://example.com/new" });
  await apiEdit(reqEdit, envEdit, new URL("https://duoplan.test/api/notes"));
  const update = wEdit.find(w => w.sql.includes("UPDATE notes SET"));
  ok(update.sql.includes("url=?"), "UPDATE переписывает url");
  equal(update.args[3], "https://example.com/new", "новая ссылка в UPDATE");

  const dbEmpty = createMockDB();
  const { api: apiEmpty, request: reqEmpty, env: envEmpty, writes: wEmpty } = makeApi(dbEmpty, NOTE);
  await apiEmpty(reqEmpty, envEmpty, new URL("https://duoplan.test/api/notes"));
  const insertEmpty = wEmpty.find(w => w.sql.includes("INSERT INTO notes("));
  equal(insertEmpty.args[4], null, "без ссылки сохраняется NULL");
});

test("опасная или неполная схема ссылки отклоняется (INVALID_URL)", async () => {
  for (const bad of ["javascript:alert(1)", "ftp://example.com", "not a url"]) {
    const db = createMockDB();
    const { api, request, env } = makeApi(db, { ...NOTE, url: bad });
    await rejects(
      api(request, env, new URL("https://duoplan.test/api/notes")),
      err => isHttpError(err, 400, "INVALID_URL"),
      `схема «${bad}» не отклонена`
    );
  }
});

test("state() не читает notes и после появления url: заметки остаются личным контуром", () => {
  const stateBlock = extractBraced("async function state");
  ok(!stateBlock.includes("FROM notes"), "state() не читает таблицу notes");
});

test("схема: колонка url добавляется ensureSchema и миграцией 0055", () => {
  ok(source.includes('["notes", "url", "TEXT"]'), "ALTER-список ensureSchema содержит notes.url");
  const migration = readFileSync(join(root, "migrations", "0055_notes_url.sql"), "utf8");
  ok(migration.includes("ALTER TABLE notes"), "миграция 0055 существует");
  ok(migration.includes("ADD COLUMN url TEXT"), "миграция добавляет url");
  ok(source.includes("url, created_at, updated_at FROM notes WHERE tg_id=?"), "notesState отдаёт url");
});
