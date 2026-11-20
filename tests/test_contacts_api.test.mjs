// HTTP-тесты телефонной книги (/api/contacts): формат «+7 ХХХ ХХХ ХХ ХХ»,
// запрет неполных номеров, максимум 3 номера, правила одинаковых имён.
// Паттерн тот же, что в test_cycle_api.test.mjs: блок api() со стабами.
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
  "cycleState",
  [
    extractBraced("class HttpError"),
    extractLine("const now = "),
    extractLine("const clean = "),
    extractLine("const CYCLE_DATE_RE"),
    extractLine("const CONTACT_MAX_PHONES"),
    extractBraced("function cycleValidDate"),
    extractBraced("function cycleDayNum"),
    extractBraced("function cycleDateStr"),
    extractBraced("function cycleToday"),
    extractBraced("function contactNormalizePhone"),
    extractBraced("function contactNewId"),
    extractBraced("async function contactWriteRetry"),
    extractBraced("async function contactsState"),
    extractBraced("function validateSchema"),
    extractBraced("function ownerIds"),
    extractBraced("async function api"),
    "return api;"
  ].join("\n")
);

// Мок БД: контакты владельца (для конфликта имён) + журнал записей.
function createMockDB(existing = [], pair = { id: 1, user_a: 1, user_b: 777 }) {
  const writes = [];
  return {
    writes,
    async batch(statements = []) { return statements.map(() => ({ meta: { changes: 1 } })); },
    prepare(sql) {
      return {
        bind(...args) {
          writes.push({ sql, args });
          return {
            async first() { return null; },
            async all() {
              if (sql.includes("FROM contacts WHERE pair_id=? AND owner_id IN")) return { results: [] };
              if (sql.includes("FROM contacts WHERE pair_id=? AND owner_id=?")) return { results: existing };
              if (sql.includes("FROM contact_phones")) return { results: [] };
              return { results: [] };
            },
            async run() { return { meta: { changes: 1, last_row_id: 42 } }; }
          };
        },
        async batch() { return {}; }
      };
    }
  };
}

function makeEnv({ body = {}, method = "POST", existing = [], hasPair = true } = {}) {
  const db = createMockDB(existing, hasPair ? { id: 1, user_a: 1, user_b: 777 } : null);
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
    // membership: пара есть, пользователь — user_b, партнёр — user_a=1.
    async () => (hasPair ? { id: 1, user_a: 1, user_b: 777 } : null),
    async () => [],
    async () => ({ periods: [], logs: [] })
  );
  return { api, env: { DB: db }, request, writes: db.writes };
}

function isHttpError(error, status, code) {
  return error && error.status === status && error.code === code;
}

const CONTACT = {
  name: "Анна",
  surname: "Петрова",
  comment: "с работы",
  phones: ["9151234567"]
};

test("без пары контакты недоступны", async () => {
  const { api, env, request } = makeEnv({ hasPair: false, body: CONTACT });
  await rejects(
    api(request, env, new URL("https://duoplan.test/api/contacts")),
    err => isHttpError(err, 400, "NO_PAIR")
  );
});

test("POST требует имя", async () => {
  const { api, env, request } = makeEnv({ body: { ...CONTACT, name: " " } });
  await rejects(
    api(request, env, new URL("https://duoplan.test/api/contacts")),
    err => isHttpError(err, 400, "INVALID_NAME")
  );
});

test("номер нормализуется к «+7 ХХХ ХХХ ХХ ХХ»", async () => {
  const { api, env, request, writes } = makeEnv({ body: { ...CONTACT, phones: ["+7 915 123 45 67"] } });
  const response = await api(request, env, new URL("https://duoplan.test/api/contacts"));
  ok(response.status === 200);
  const insert = writes.find(w => w.sql.includes("INSERT INTO contact_phones"));
  ok(insert, "номера вставляются");
  // contact_id — тот же сгенерированный id, что и в INSERT контакта (один batch).
  const contactInsert = writes.find(w => w.sql.includes("INSERT INTO contacts("));
  ok(contactInsert, "родитель вставляется тем же batch");
  deepStrictEqual(insert.args.slice(0, 3), [contactInsert.args[0], "+7 915 123 45 67", 0]);
  equal(insert.args[3], contactInsert.args[6], "created_at совпадает с контактом");
});

test("легаси-ввод «8 915 …» и «+7915…» сворачивается до 10 цифр", async () => {
  for (const raw of ["89151234567", "+79151234567", "79151234567"]) {
    const { api, env, request, writes } = makeEnv({ body: { ...CONTACT, phones: [raw] } });
    await api(request, env, new URL("https://duoplan.test/api/contacts"));
    const insert = writes.find(w => w.sql.includes("INSERT INTO contact_phones"));
    equal(insert.args[1], "+7 915 123 45 67", `ввод «${raw}» нормализован`);
  }
});

test("неполный номер (9 цифр) отклоняется", async () => {
  const { api, env, request } = makeEnv({ body: { ...CONTACT, phones: ["915123456"] } });
  await rejects(
    api(request, env, new URL("https://duoplan.test/api/contacts")),
    err => isHttpError(err, 400, "INVALID_PHONE")
  );
});

test("максимум 3 номера на контакт", async () => {
  const { api, env, request } = makeEnv({
    body: { ...CONTACT, phones: ["9151234567", "9161234567", "9171234567", "9181234567"] }
  });
  await rejects(
    api(request, env, new URL("https://duoplan.test/api/contacts")),
    err => isHttpError(err, 400, "INVALID_PHONES")
  );
});

test("без номеров контакт не создаётся", async () => {
  const { api, env, request } = makeEnv({ body: { ...CONTACT, phones: [] } });
  await rejects(
    api(request, env, new URL("https://duoplan.test/api/contacts")),
    err => isHttpError(err, 400, "INVALID_PHONES")
  );
});

test("дубликаты номеров внутри контакта схлопываются", async () => {
  const { api, env, request, writes } = makeEnv({ body: { ...CONTACT, phones: ["9151234567", "+7 915 123 45 67"] } });
  await api(request, env, new URL("https://duoplan.test/api/contacts"));
  const inserts = writes.filter(w => w.sql.includes("INSERT INTO contact_phones"));
  equal(inserts.length, 1, "одинаковый номер сохранён один раз");
});

test("оба контакта без комментария: одинаковое имя запрещено (409)", async () => {
  const { api, env, request } = makeEnv({
    body: { ...CONTACT, comment: null },
    existing: [{ id: 10, name: "Анна", comment: null }]
  });
  await rejects(
    api(request, env, new URL("https://duoplan.test/api/contacts")),
    err => isHttpError(err, 409, "NAME_TAKEN")
  );
});

test("совпадение имени без учёта регистра тоже ловится", async () => {
  const { api, env, request } = makeEnv({
    body: { ...CONTACT, name: "анна", comment: null },
    existing: [{ id: 10, name: "Анна", comment: "" }]
  });
  await rejects(
    api(request, env, new URL("https://duoplan.test/api/contacts")),
    err => isHttpError(err, 409, "NAME_TAKEN")
  );
});

test("новый контакт с комментарием при безымянном-без-комментария — пропускается сервером", async () => {
  const { api, env, request } = makeEnv({
    body: { ...CONTACT, comment: "с работы" },
    existing: [{ id: 10, name: "Анна", comment: null }]
  });
  const response = await api(request, env, new URL("https://duoplan.test/api/contacts"));
  ok(response.status === 200, "решение об окне-предупреждении — на клиенте");
});

test("существующий с комментарием, новый без — сервер пропускает", async () => {
  const { api, env, request } = makeEnv({
    body: { ...CONTACT, comment: null },
    existing: [{ id: 10, name: "Анна", comment: "с работы" }]
  });
  const response = await api(request, env, new URL("https://duoplan.test/api/contacts"));
  ok(response.status === 200);
});

test("редактирование: то же имя самого контакта не считается конфликтом", async () => {
  const { api, env, request } = makeEnv({
    body: { ...CONTACT, id: 10, comment: null },
    existing: [{ id: 10, name: "Анна", comment: null }]
  });
  const response = await api(request, env, new URL("https://duoplan.test/api/contacts"));
  ok(response.status === 200, "конфликт ищется с исключением самого себя");
});

test("правка и удаление чужого контакта отклоняются (только свой список)", async () => {
  // Мок: UPDATE/DELETE с owner_id=777 не находят строк → 404 NOT_FOUND.
  const db = createMockDB();
  // batch возвращает changes:0 — UPDATE/DELETE чужой записи не меняют строк.
  db.batch = async (statements = []) => statements.map(() => ({ meta: { changes: 0 } }));
  db.prepare = (sql) => ({
    bind(...args) {
      return {
        async first() { return null; },
        async all() {
          if (sql.includes("FROM contacts WHERE pair_id=? AND owner_id IN")) return { results: [] };
          if (sql.includes("FROM contacts WHERE pair_id=? AND owner_id=?")) return { results: [] };
          return { results: [] };
        },
        async run() {
          // UPDATE/DELETE чужой записи не меняют строк: owner_id не совпадает.
          return { meta: { changes: sql.includes("UPDATE contacts") || sql.includes("DELETE FROM contacts") ? 0 : 1 } };
        }
      };
    },
    async batch() { return {}; }
  });
  const request = { method: "POST", headers: { get: () => null } };
  const api = buildApi(
    (data, status = 200) => ({ data, status }),
    async () => {},
    async () => ({ id: 777, first_name: "Тест" }),
    () => "Europe/Moscow",
    async () => ({ tg_id: 777, gender: null }),
    async () => {},
    async () => ({ ...CONTACT, id: 55 }),
    async () => ({ user: { tg_id: 777, gender: null }, pair: null }),
    async () => ({ id: 1, user_a: 1, user_b: 777 }),
    async () => [],
    async () => ({ periods: [], logs: [] })
  );
  await rejects(
    api(request, { DB: db }, new URL("https://duoplan.test/api/contacts")),
    err => isHttpError(err, 404, "NOT_FOUND")
  );
});

test("удаление: только владелец, номера чистятся вместе с контактом", async () => {
  const { api, env, request, writes } = makeEnv({ body: { id: 10 } });
  const response = await api(request, env, new URL("https://duoplan.test/api/contacts/delete"));
  ok(response.status === 200);
  ok(writes.some(w => w.sql.includes("DELETE FROM contacts WHERE id=? AND pair_id=? AND owner_id=?")), "удаление с проверкой владельца");
  ok(writes.some(w => w.sql.includes("DELETE FROM contact_phones WHERE contact_id=?")), "номера удаляются");
});

// ---------- CONTACT-TXN-01: атомарность записи контакта и телефонов ----------

// Мок с управляемым batch: может падать на телефонах или возвращать
// произвольные meta.changes по позициям операторов.
function createFailingDB({ batchError = null, changes = null } = {}) {
  const writes = [];
  return {
    writes,
    async batch(statements = []) {
      if (batchError) throw batchError;
      return statements.map((_, i) => ({ meta: { changes: changes ? changes[i] : 1, last_row_id: 42 } }));
    },
    prepare(sql) {
      return {
        bind(...args) {
          writes.push({ sql, args });
          return {
            async first() { return null; },
            async all() {
              if (sql.includes("FROM contacts WHERE pair_id=? AND owner_id=?")) return { results: [] };
              return { results: [] };
            },
            async run() { return { meta: { changes: 1, last_row_id: 42 } }; }
          };
        }
      };
    }
  };
}

function apiWithDb(db, body, url = "https://duoplan.test/api/contacts") {
  const request = { method: "POST", headers: { get: () => null } };
  const api = buildApi(
    (data, status = 200) => ({ data, status }),
    async () => {},
    async () => ({ id: 777, first_name: "Тест" }),
    () => "Europe/Moscow",
    async () => ({ tg_id: 777, gender: null }),
    async () => {},
    async () => body,
    async () => ({ user: { tg_id: 777, gender: null }, pair: null }),
    async () => ({ id: 1, user_a: 1, user_b: 777 }),
    async () => [],
    async () => ({ periods: [], logs: [] })
  );
  return api(request, { DB: db }, new URL(url));
}

test("CONTACT-TXN-02: создание — родитель и номера одним batch, без компенсации", async () => {
  // batch падает → ошибка уходит наружу; частичной записи нет, потому что
  // INSERT контакта и INSERT телефонов были операторами одной транзакции
  // (D1 batch атомарен), а не двумя последовательными операциями.
  const db = createFailingDB({ batchError: new Error("d1 boom") });
  await rejects(
    apiWithDb(db, CONTACT),
    err => !(err instanceof Error && err.status) // исходная ошибка D1, не HttpError
  );
  const contactIns = db.writes.find(w => w.sql.includes("INSERT INTO contacts("));
  const phoneIns = db.writes.filter(w => w.sql.includes("INSERT INTO contact_phones"));
  ok(contactIns, "родитель подготовлен");
  ok(phoneIns.length >= 1, "номера подготовлены в том же batch");
  equal(phoneIns[0].args[0], contactIns.args[0], "номера ссылаются на id нового контакта");
  // Компенсационного DELETE больше нет — откат делает сама транзакция.
  ok(!db.writes.some(w => w.sql.includes("DELETE FROM contacts WHERE id=? AND pair_id=? AND owner_id=?")),
    "компенсирующего удаления нет — атомарность на уровне batch");
});

test("CONTACT-TXN-01: сбой batch при редактировании — одна транзакция, 404 по changes", async () => {
  // batch падает → ошибка уходит наружу, частичной записи нет (D1 batch атомарен).
  const db = createFailingDB({ batchError: new Error("d1 boom") });
  await rejects(apiWithDb(db, { ...CONTACT, id: 10 }), /d1 boom/);
  // UPDATE и запись телефонов ушли одним batch — не двумя операциями.
  const batchCalls = db.writes.filter(w => w.sql.includes("UPDATE contacts") || w.sql.includes("contact_phones"));
  ok(batchCalls.length >= 2, "UPDATE и телефоны подготовлены для одного batch");
  ok(batchCalls.some(w => w.sql.includes("EXISTS(SELECT 1 FROM contacts")),
    "дочерние записи защищены EXISTS-проверкой владельца");
});

test("CONTACT-TXN-01: редактирование чужого контакта — 404, телефоны не трогаются", async () => {
  // UPDATE вернул changes=0 → 404; DELETE/INSERT под EXISTS ничего не пишут.
  const db = createFailingDB({ changes: [0, 0, 0] });
  await rejects(
    apiWithDb(db, { ...CONTACT, id: 55 }),
    err => isHttpError(err, 404, "NOT_FOUND")
  );
});

test("CONTACT-TXN-01: удаление — телефоны первыми под EXISTS, контакт вторым", async () => {
  const db = createMockDB();
  const response = await apiWithDb(db, { id: 10 }, "https://duoplan.test/api/contacts/delete");
  ok(response.status === 200);
  const phonesIdx = db.writes.findIndex(w => w.sql.includes("DELETE FROM contact_phones"));
  const contactIdx = db.writes.findIndex(w => w.sql.includes("DELETE FROM contacts WHERE"));
  ok(phonesIdx !== -1 && contactIdx !== -1, "оба DELETE подготовлены");
  ok(phonesIdx < contactIdx, "номера удаляются до контакта (EXISTS видит живую запись)");
  ok(db.writes[phonesIdx].sql.includes("EXISTS"), "удаление номеров под проверкой владельца");
});

test("CONTACT-TXN-01: удаление чужого контакта — 404, номера чужого не трогаются", async () => {
  const db = createFailingDB({ changes: [0, 0] });
  await rejects(
    apiWithDb(db, { id: 55 }, "https://duoplan.test/api/contacts/delete"),
    err => isHttpError(err, 404, "NOT_FOUND")
  );
});

// ---------- транзиентные сбои D1: одна повторная попытка ----------

test("CONTACT-RETRY: разовый сбой batch при создании — повтор проходит, контакт один", async () => {
  let batchCalls = 0;
  const batchSizes = [];
  const db = createMockDB();
  const innerBatch = db.batch;
  db.batch = async (statements = []) => {
    batchCalls += 1;
    batchSizes.push(statements.length);
    if (batchCalls === 1) throw new Error("d1 transient");
    return innerBatch(statements);
  };
  // Первый batch (контакт + номера) упал целиком → транзакция откатилась,
  // повтор создаёт всё заново одним batch.
  const response = await apiWithDb(db, CONTACT);
  ok(response.status === 200, "повторная попытка успешна");
  equal(batchCalls, 2, "ровно две попытки batch");
  // CONTACT: 1 контакт + 1 номер = 2 оператора в каждом batch.
  deepStrictEqual(batchSizes, [2, 2], "оба batch содержат контакт и номера");
  const inserts = db.writes.filter(w => w.sql.includes("INSERT INTO contacts("));
  equal(inserts.length, 2, "по одному INSERT контакта на попытку");
  ok(!db.writes.some(w => w.sql.includes("DELETE FROM contacts WHERE id=?")), "компенсации нет — атомарный batch");
  ok(db.writes.some(w => w.sql.includes("INSERT INTO contact_phones")), "телефоны записаны");
});

test("CONTACT-RETRY: HttpError не повторяется (404 не ретраится)", async () => {
  let batchCalls = 0;
  const db = createFailingDB({ changes: [0, 0, 0] });
  const innerBatch = db.batch;
  db.batch = async (s) => { batchCalls += 1; return innerBatch(s); };
  await rejects(
    apiWithDb(db, { ...CONTACT, id: 55 }),
    err => isHttpError(err, 404, "NOT_FOUND")
  );
  equal(batchCalls, 1, "404 выброшен без повторной попытки");
});

test("контакты сортируются по имени, затем по фамилии", () => {
  ok(source.includes("ORDER BY name COLLATE NOCASE ASC, surname COLLATE NOCASE ASC, id ASC"),
    "сервер не сортирует по фамилии");
});
