// Приватные даты (is_private) и утренний дайджест (sendDigests) в worker.js.
//
// Личная дата видна только создавшему её партнёру: фильтр живёт в SQL
// state()/archivePage(), а mutating-маршруты (PATCH/DELETE) отбивают чужие
// приватные записи 404 — как для несуществующих, чтобы само их существование
// не раскрывалось. Дайджест собирается из дат (с учётом приватности) и открытых
// планов с дедлайном на сегодня-завтра.
//
// Функции извлекаются из worker.js как есть и исполняются против мока D1 —
// тот же приём, что в test_api_routing и test_state_archive_consistency.
//
// Запуск: node tests/test_private_dates.test.mjs  (или node --test "tests/*.test.mjs")
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { deepStrictEqual, equal, match, rejects } from "node:assert/strict";
import { test } from "node:test";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const source = readFileSync(join(root, "worker.js"), "utf8");

function extractBraced(declaration) {
  const start = source.indexOf(declaration);
  if (start === -1) throw new Error(`${declaration} не найдено`);
  let depth = 0;
  for (let j = source.indexOf("{", start); j < source.length; j++) {
    if (source[j] === "{") depth++;
    else if (source[j] === "}") {
      depth--;
      if (depth === 0) return source.slice(start, j + 1);
    }
  }
  throw new Error(`незакрытый блок: ${declaration}`);
}

function extractLine(prefix) {
  const start = source.indexOf(prefix);
  if (start === -1) throw new Error(`${prefix} не найдено`);
  return source.slice(start, source.indexOf("\n", start));
}

// ------------------------------------------------------------------
// 1. POST /api/dates: is_private и created_by попадают в INSERT
// ------------------------------------------------------------------
const buildApi = new Function(
  "json", "ensureSchemaOnce", "telegramUser", "validTimeZone", "ensureUser",
  "rateLimit", "readJson", "state", "membership",
  [
    extractBraced("class HttpError"),
    extractLine("const now = "),
    extractLine("const clean = "),
    extractLine("const ACCENT_KEYS"),
    extractBraced("function validateSchema"),
    extractBraced("function textField"),
    extractBraced("function validDate"),
    extractBraced("function optionalTime"),
    extractBraced("async function api"),
    "return api;"
  ].join("\n")
);

function makeApiEnv({ pair = null, body = {} } = {}) {
  const queries = [];
  const db = {
    prepare(sql) {
      return {
        bind(...args) {
          queries.push({ sql, args });
          return { run: async () => ({ meta: { changes: 1 } }) };
        }
      };
    }
  };
  const request = { method: "POST", headers: { get: () => null } };
  const api = buildApi(
    (data, status = 200) => ({ data, status }),
    async () => {},
    async () => ({ id: 777, first_name: "Тест" }),
    () => "Europe/Moscow",
    async () => ({ tg_id: 777, gender: null }),
    async () => {},
    async () => body,
    async () => ({ user: { tg_id: 777 }, pair }),
    async () => pair
  );
  return { api, env: { DB: db }, queries, request };
}

test("POST /api/dates с is_private пишет метку приватности и автора", async () => {
  const { api, env, queries, request } = makeApiEnv({
    pair: { id: 1 },
    body: { title: "Личная дата", day: "2026-11-01", recurs: true, is_private: true }
  });
  await api(request, env, new URL("https://duoplan.test/api/dates"));
  const insert = queries.find(q => q.sql.startsWith("INSERT INTO dates"));
  deepStrictEqual(insert.args.length, 9);
  equal(insert.args[4], 1); // recurs
  equal(insert.args[5], 0); // monthly не включён
  equal(insert.args[6], 1); // is_private
  equal(insert.args[7], 777); // created_by — автор
});

test("POST /api/dates без is_private остаётся общей, created_by всё равно пишется", async () => {
  const { api, env, queries, request } = makeApiEnv({
    pair: { id: 1 },
    body: { title: "Общая дата", day: "2026-11-01", recurs: true }
  });
  await api(request, env, new URL("https://duoplan.test/api/dates"));
  const insert = queries.find(q => q.sql.startsWith("INSERT INTO dates"));
  equal(insert.args[5], 0); // monthly
  equal(insert.args[6], 0); // is_private — не передан
  equal(insert.args[7], 777); // created_by
});

// ------------------------------------------------------------------
// 1b. POST /api/settings: персональные настройки (акцент, время сводок)
// ------------------------------------------------------------------
test("POST /api/settings сохраняет акцент, время и флаги сводок", async () => {
  const { api, env, queries, request } = makeApiEnv({
    pair: { id: 1 },
    body: { accent_color: "sage", digest_time: "08:30", digest_enabled: false, dates_digest_time: "21:00", dates_digest_enabled: true }
  });
  const response = await api(request, env, new URL("https://duoplan.test/api/settings"));
  deepStrictEqual(response.data.user.tg_id, 777);
  const update = queries.find(q => q.sql.startsWith("UPDATE users SET"));
  equal(update.sql.includes("accent_color=?"), true);
  equal(update.sql.includes("digest_time=?"), true);
  equal(update.sql.includes("digest_enabled=?"), true);
  equal(update.sql.includes("dates_digest_time=?"), true);
  deepStrictEqual(update.args.slice(0, 5), ["sage", "08:30", 0, "21:00", 1]);
});

test("POST /api/settings: можно сохранить только часть полей", async () => {
  const { api, env, queries, request } = makeApiEnv({
    pair: { id: 1 },
    body: { digest_time: "07:15" }
  });
  await api(request, env, new URL("https://duoplan.test/api/settings"));
  const update = queries.find(q => q.sql.startsWith("UPDATE users SET"));
  equal(update.sql.includes("digest_time=?"), true);
  equal(update.sql.includes("accent_color=?"), false);
});

test("POST /api/settings отклоняет неизвестный акцент и битое время", async () => {
  const badAccent = makeApiEnv({ pair: { id: 1 }, body: { accent_color: "rainbow" } });
  await rejects(
    badAccent.api(badAccent.request, badAccent.env, new URL("https://duoplan.test/api/settings")),
    error => error.status === 400 && error.code === "INVALID_ACCENT"
  );
  const badTime = makeApiEnv({ pair: { id: 1 }, body: { digest_time: "25:99" } });
  await rejects(
    badTime.api(badTime.request, badTime.env, new URL("https://duoplan.test/api/settings")),
    error => error.status === 400 && error.code === "INVALID_TIME"
  );
});

test("POST /api/settings без полей даёт 400", async () => {
  const { api, env, request } = makeApiEnv({ pair: { id: 1 }, body: {} });
  await rejects(
    api(request, env, new URL("https://duoplan.test/api/settings")),
    error => error.status === 400 && error.code === "EMPTY_SETTINGS"
  );
});

// ------------------------------------------------------------------
// 2. state()/archivePage(): приватные даты партнёра не попадают в выдачу
// ------------------------------------------------------------------
const constsStart = source.indexOf("const STATE_ACTIVE_LIMIT");
const constsEnd = source.indexOf("const schemaReady");
if (constsStart === -1 || constsEnd === -1 || constsEnd < constsStart) {
  throw new Error("не найден блок констант лимитов");
}

const loadState = new Function(
  `${source.slice(constsStart, constsEnd)}\n` +
  [
    'const DEFAULT_TZ = "Europe/Moscow";',
    extractBraced("class HttpError"),
    extractBraced("function validTimeZone"),
    extractBraced("function localDay"),
    extractBraced("function byRowId"),
    extractBraced("function timeZoneOffsetMs"),
    extractBraced("function makeDateInTimeZone"),
    extractBraced("function taskTargetMs"),
    extractBraced("function sortByTaskDeadline"),
    extractBraced("function nextDateOccurrence"),
    extractBraced("function isPastDate"),
    extractBraced("function sortDateRows"),
    extractBraced("function displayStreak"),
    extractBraced("function publicUser"),
    extractBraced("async function membership"),
    extractBraced("async function state"),
    extractBraced("async function archivePage")
  ].join("\n") +
  "\nreturn { state, archivePage };"
);
const { state, archivePage } = loadState();

const TZ = "Europe/Moscow";
const USER_ID = 777;
const PAIR = {
  id: 1, role: "a", user_a: USER_ID, user_b: 0, code: "ABC123",
  name1: "Один", name2: "", started_at: "2026-01-01", together_pts: 0,
  timezone: TZ, owner_name: "Один", partner_name: ""
};

const DATE_ROWS = [
  { id: 1, title: "Общая", day: "2030-05-01", time: null, recurs: 1, is_private: 0, created_by: 777, created_at: 1 },
  { id: 2, title: "Моя личная", day: "2030-05-02", time: null, recurs: 1, is_private: 1, created_by: 777, created_at: 2 },
  { id: 3, title: "Чужая личная", day: "2030-05-03", time: null, recurs: 1, is_private: 1, created_by: 999, created_at: 3 }
];

function makeStateDb(dateRows = DATE_ROWS) {
  const queries = [];
  const pick = (sql, args) => {
    if (sql.includes("FROM dates WHERE pair_id=?")) {
      // Мок исполняет ту же клаузу, что и реальный SQLite: приватность
      // фильтруется только если она есть в SQL и userId реально привязан.
      if (!sql.includes("(is_private=0 OR created_by=?)")) return dateRows;
      const userId = Number(args[1]);
      return dateRows.filter(r => Number(r.is_private) !== 1 || Number(r.created_by) === userId);
    }
    if (sql.includes("FROM tasks WHERE pair_id=? AND status='open'")) return [];
    if (sql.includes("FROM tasks WHERE pair_id=? AND status='done'")) return [];
    if (sql.includes("FROM memories")) return [];
    if (sql.includes("w.done=1")) return [];
    if (sql.includes("FROM wishes")) return [];
    if (sql.includes("FROM users WHERE tg_id=?")) return [{ tg_id: USER_ID, display_name: "Тест", gender: "female", points: 0 }];
    if (sql.includes("FROM pair_members pm JOIN pairs")) return [PAIR];
    return [];
  };
  return {
    queries,
    env: {
      DB: {
        prepare(sql) {
          return {
            bind(...args) {
              queries.push({ sql, args });
              return {
                all: async () => ({ results: [...pick(sql, args)] }),
                first: async () => pick(sql, args)[0] ?? null
              };
            }
          };
        }
      }
    }
  };
}

test("state() отдаёт пользователю общие и свои личные даты, чужие личные — нет", async () => {
  const { env, queries } = makeStateDb();
  const result = await state(env, USER_ID);
  deepStrictEqual(result.dates.map(d => d.id), [1, 2]);
  const datesQuery = queries.find(q => q.sql.includes("FROM dates WHERE pair_id=?"));
  equal(datesQuery.sql.includes("(is_private=0 OR created_by=?)"), true);
  deepStrictEqual(datesQuery.args, [PAIR.id, USER_ID]);
});

test("archivePage('dates') фильтрует приватные даты по userId из запроса", async () => {
  // Страница 0 архива продолжается после первых 200 записей из state: набираем
  // 205 общих дат, а приватные партнёра делаем самыми поздними — без фильтра
  // они попали бы именно в хвост (позиции 200+), с фильтром там только общие.
  const archiveRows = [
    ...Array.from({ length: 205 }, (_, i) => ({
      id: i + 1, title: `Общая ${i}`, day: `2035-12-${String((i % 28) + 1).padStart(2, "0")}`,
      time: null, recurs: 0, is_private: 0, created_by: 777, created_at: i
    })),
    ...[1, 2, 3].map(i => ({
      id: 9000 + i, title: `Чужая личная ${i}`, day: `2040-01-0${i}`,
      time: null, recurs: 0, is_private: 1, created_by: 999, created_at: 900 + i
    }))
  ];
  const { env, queries } = makeStateDb(archiveRows);
  const page = await archivePage(env, PAIR, "dates", 0, USER_ID);
  equal(page.items.length, 5);
  equal(page.items.some(d => d.id >= 9000), false);
  const datesQuery = queries.find(q => q.sql.includes("FROM dates WHERE pair_id=?"));
  equal(datesQuery.sql.includes("(is_private=0 OR created_by=?)"), true);
  deepStrictEqual(datesQuery.args, [PAIR.id, USER_ID]);
});

test("строки дат в state несут is_private — интерфейс рисует метку «Личная»", async () => {
  const { env } = makeStateDb();
  const result = await state(env, USER_ID);
  deepStrictEqual(result.dates.map(d => Boolean(d.is_private)), [false, true]);
});

// ------------------------------------------------------------------
// 3. itemRoute(): чужую приватную дату нельзя изменить или удалить по id
// ------------------------------------------------------------------
const loadItemRoute = new Function(
  "now",
  [
    extractLine("const clean = "),
    extractLine("const positiveId = "),
    extractBraced("class HttpError"),
    extractBraced("function validateSchema"),
    extractBraced("function textField"),
    extractBraced("function validDate"),
    extractBraced("function optionalDay"),
    extractBraced("function optionalTime"),
    extractBraced("function planSchedule"),
    extractBraced("async function ensureWishOwner"),
    extractBraced("async function ensureDateVisible"),
    extractBraced("async function itemRoute"),
    "return itemRoute;"
  ].join("\n")
)(() => 1760000000);

function makeItemDb({ privateRow = null } = {}) {
  const queries = [];
  return {
    queries,
    env: {
      DB: {
        prepare(sql) {
          return {
            bind(...args) {
              queries.push({ sql, args });
              return {
                first: async () => (sql.includes("SELECT is_private,created_by") ? privateRow : null),
                run: async () => ({ meta: { changes: 1 } })
              };
            }
          };
        }
      }
    }
  };
}

const editBody = { title: "Правка", day: "2026-11-01", recurs: false, time: null, is_private: true };

test("PATCH своей личной даты проходит и пишет is_private", async () => {
  const { env, queries } = makeItemDb({ privateRow: { is_private: 1, created_by: 777 } });
  const handled = await loadItemRoute(env, PAIR, { tg_id: 777 }, "PATCH", "/api/dates/5", editBody);
  equal(handled, true);
  const update = queries.find(q => q.sql.startsWith("UPDATE dates"));
  equal(update.sql.includes("is_private=?"), true);
  deepStrictEqual(update.args, ["Правка", "2026-11-01", 0, null, 1, 5, 1]);
});

test("PATCH приватности не-автором игнорируется: поле не попадает в UPDATE", async () => {
  // Общая дата партнёра: править её можно, но «личной» сделать нельзя —
  // иначе переключивший мгновенно терял бы её из своих списков.
  const { env, queries } = makeItemDb({ privateRow: { is_private: 0, created_by: 999 } });
  const handled = await loadItemRoute(env, PAIR, { tg_id: 777 }, "PATCH", "/api/dates/5", editBody);
  equal(handled, true);
  const update = queries.find(q => q.sql.startsWith("UPDATE dates"));
  equal(update.sql.includes("is_private=?"), false);
});

test("у дат без автора (created_by=0, до миграции) приватность не переключается никем", async () => {
  // created_by=0 не совпадает ни с одним пользователем: если такую дату
  // сделать личной, фильтр видимости скрыл бы её у ОБОИХ партнёров.
  const { env, queries } = makeItemDb({ privateRow: { is_private: 0, created_by: 0 } });
  const handled = await loadItemRoute(env, PAIR, { tg_id: 777 }, "PATCH", "/api/dates/5", editBody);
  equal(handled, true);
  const update = queries.find(q => q.sql.startsWith("UPDATE dates"));
  equal(update.sql.includes("is_private=?"), false);
});

test("PATCH без is_private не сбрасывает приватность", async () => {
  const { env, queries } = makeItemDb({ privateRow: { is_private: 1, created_by: 777 } });
  const { is_private, ...withoutFlag } = editBody;
  await loadItemRoute(env, PAIR, { tg_id: 777 }, "PATCH", "/api/dates/5", withoutFlag);
  const update = queries.find(q => q.sql.startsWith("UPDATE dates"));
  equal(update.sql.includes("is_private=?"), false);
});

test("PATCH чужой приватной даты даёт 404 и не выполняет UPDATE", async () => {
  const { env, queries } = makeItemDb({ privateRow: { is_private: 1, created_by: 999 } });
  await rejects(
    loadItemRoute(env, PAIR, { tg_id: 777 }, "PATCH", "/api/dates/5", editBody),
    error => error.status === 404 && error.code === "NOT_FOUND"
  );
  equal(queries.some(q => q.sql.startsWith("UPDATE dates")), false);
});

test("DELETE чужой приватной даты даёт 404, общей — проходит", async () => {
  const partnerPrivate = makeItemDb({ privateRow: { is_private: 1, created_by: 999 } });
  await rejects(
    loadItemRoute(partnerPrivate.env, PAIR, { tg_id: 777 }, "DELETE", "/api/dates/5", {}),
    error => error.status === 404 && error.code === "NOT_FOUND"
  );
  equal(partnerPrivate.queries.some(q => q.sql.startsWith("DELETE FROM dates")), false);

  const shared = makeItemDb({ privateRow: { is_private: 0, created_by: 777 } });
  equal(await loadItemRoute(shared.env, PAIR, { tg_id: 777 }, "DELETE", "/api/dates/5", {}), true);
  equal(shared.queries.some(q => q.sql.startsWith("DELETE FROM dates")), true);
});

// ------------------------------------------------------------------
// 4. Дайджест: вхождения дат и сборка текста
// ------------------------------------------------------------------
const loadDigest = new Function(
  [
    'const DEFAULT_TZ = "Europe/Moscow";',
    extractLine("const DIGEST_MAX_ITEMS"),
    extractLine("const DIGEST_MAX_CHARS"),
    extractLine("const RICH_MASKED"),
    extractLine("const maskTitle"),
    "const RICH_TOKENS = " + source.match(/const RICH_TOKENS = (\[\[.*\]\]);/)?.[1] + ";",
    extractBraced("function validTimeZone"),
    extractBraced("function localDay"),
    extractBraced("function timeZoneOffsetMs"),
    extractBraced("function makeDateInTimeZone"),
    extractBraced("function escapeHtml"),
    extractBraced("function richInline"),
    extractBraced("function richToHtml"),
    extractBraced("function monthlyOccursOnDay"),
    extractBraced("function nextMonthlyOccurrenceMs"),
    extractBraced("function dateOccursOnDay"),
    extractBraced("function digestText"),
    extractBraced("function datesDigestText"),
    "return { dateOccursOnDay, digestText, datesDigestText, richToHtml };"
  ].join("\n")
);
const { dateOccursOnDay, digestText, datesDigestText, richToHtml } = loadDigest();

test("dateOccursOnDay: ежегодная совпадает по месяцу-дню, обычная — только точным днём", () => {
  equal(dateOccursOnDay({ day: "2021-06-12", recurs: 1 }, "2026-06-12"), true);
  equal(dateOccursOnDay({ day: "2021-06-12", recurs: 0 }, "2026-06-12"), false);
  equal(dateOccursOnDay({ day: "2026-06-12", recurs: 0 }, "2026-06-12"), true);
  equal(dateOccursOnDay({ day: "2021-06-12", recurs: 1 }, "2026-06-13"), false);
  equal(dateOccursOnDay({ day: "мусор", recurs: 1 }, "2026-06-12"), false);
  equal(dateOccursOnDay(null, "2026-06-12"), false);
});

test("digestText не принимает неиспользуемый timeZone", () => {
  // Параметр был мёртвым: часовой пояс и так берётся из даты наступления.
  match(source, /function digestText\(today, tomorrow, dates, tasks\)/);
});

test("digestText: два абзаца — даты и планы, внутри каждого сегодня/завтра", () => {
  const text = digestText(
    "2026-03-01",
    "2026-03-02",
    [
      { id: 1, title: "День знакомства", day: "2020-03-01", time: "14:00", recurs: 1 },
      { id: 2, title: "Годовщина", day: "2020-03-02", time: null, recurs: 1 },
      { id: 3, title: "Не в эти дни", day: "2030-03-05", time: null, recurs: 0 }
    ],
    [
      { id: 10, title: "Купить билеты", day: "2026-03-01", time: "19:30" },
      { id: 11, title: "План без времени", day: "2026-03-01", time: null },
      { id: 12, title: "Завтрашний план", day: "2026-03-02", time: "09:00" }
    ]
  );
  equal(text.includes("Доброе утро!"), true);
  equal(text.includes("📅 Значимые даты"), true);
  equal(text.includes("• Сегодня — День знакомства (14:00)"), true);
  equal(text.includes("• Завтра — Годовщина"), true);
  equal(text.includes("✅ Планы"), true);
  equal(text.includes("• Сегодня, до 19:30 — Купить билеты"), true);
  equal(text.includes("• Сегодня — План без времени"), true);
  equal(text.includes("• Завтра, до 09:00 — Завтрашний план"), true);
  equal(text.includes("Не в эти дни"), false);
  // Даты и планы — раздельные абзацы: заголовок дат идёт раньше плана.
  equal(text.indexOf("📅 Значимые даты") < text.indexOf("✅ Планы"), true);
});

test("digestText: абзац планов без дат — заголовок дат не печатается", () => {
  const text = digestText("2026-03-01", "2026-03-02", [], [
    { id: 10, title: "Только план", day: "2026-03-01", time: null }
  ]);
  equal(text.includes("📅 Значимые даты"), false);
  equal(text.includes("✅ Планы"), true);
});

test("datesDigestText: сводка о датах за сутки — только завтрашние", () => {
  const text = datesDigestText(TZ, "2026-03-02", [
    { id: 1, title: "Годовщина", day: "2020-03-02", time: "18:00", recurs: 1 },
    { id: 2, title: "Не завтра", day: "2020-03-05", recurs: 1 }
  ]);
  equal(text.startsWith("Напоминаю: завтра значимые даты:"), true);
  equal(text.includes("📅 Завтра · 2 марта"), true);
  equal(text.includes("• Годовщина (18:00)"), true);
  equal(text.includes("Не завтра"), false);
});

test("datesDigestText без завтрашних дат возвращает пустую строку", () => {
  equal(datesDigestText(TZ, "2026-03-02", [{ id: 1, title: "Сегодняшняя", day: "2026-03-01", recurs: 0 }]), "");
});

test("digestText без событий возвращает пустую строку — дайджест не отправляется", () => {
  const text = digestText("2026-03-01", "2026-03-02", [{ id: 1, title: "Далеко", day: "2030-01-01", recurs: 0 }], []);
  equal(text, "");
});

test("digestText обрезает длинный список: не больше 18 строк и хвост «…и ещё»", () => {
  const dates = Array.from({ length: 25 }, (_, i) => ({
    id: i + 1, title: `Событие ${i + 1}`, day: "2020-03-01", time: null, recurs: 1
  }));
  const text = digestText("2026-03-01", "2026-03-02", dates, []);
  const itemLines = text.split("\n").filter(l => l.startsWith("• "));
  equal(itemLines.length, 18);
  equal(text.includes("…и ещё 7 — полный список в приложении"), true);
  equal(text.includes("Событие 18"), true);
  equal(text.includes("Событие 19"), false);
  // Укладываемся в лимит Telegram даже с худшими заголовками планов (180 символов).
  const longTasks = Array.from({ length: 30 }, (_, i) => ({
    id: 100 + i, title: "П".repeat(180), day: "2026-03-01", time: "23:59"
  }));
  const capped = digestText("2026-03-01", "2026-03-02", [], longTasks);
  equal([...capped].length <= 4096, true);
});

// ------------------------------------------------------------------
// 5. processPairNotifications/deliverNotification: приватность по участникам,
//    персональное время сводок, напоминания 3ч/1ч, дедуп и ошибки
// ------------------------------------------------------------------
// Фиксированный момент: 08:05 UTC = 11:05 по Москве → локальный день
// 2026-03-02, завтра 2026-03-03, локальные минуты 665 (после дефолтных 09:00).
const STAMP_MORNING = Date.UTC(2026, 2, 2, 8, 5);
const STAMP_NOON = Date.UTC(2026, 2, 2, 10, 5);  // 13:05 MSK: внутри обоих окон плана на 14:00
const STAMP_AFTER = Date.UTC(2026, 2, 2, 12, 5); // 15:05 MSK — план на 14:00 уже прошёл
const PAIR_TODAY = "2026-03-02";
const PAIR_TOMORROW = "2026-03-03";

function makeNotificationDb({ dates = [], tasks = [], users = [], logChanges = 1, sendError = null, queries = [] } = {}) {
  return {
    env: {
      DB: {
        prepare(sql) {
          return {
            bind(...args) {
              queries.push({ sql, args });
              return {
                all: async () => ({
                  results: sql.includes("FROM users WHERE tg_id IN") ? users
                    : sql.includes("FROM dates WHERE pair_id=?") ? dates
                    : sql.includes("FROM tasks WHERE pair_id=?") ? tasks : []
                }),
                first: async () => null,
                run: async () => {
                  if (sendError && sql.startsWith("DELETE FROM notification_log")) throw new Error("cleanup boom");
                  return { meta: { changes: logChanges } };
                }
              };
            }
          };
        }
      }
    }
  };
}

const DIGEST_PAIR = { id: 1, timezone: TZ, user_a: 111, user_b: 222 };
const U111 = { tg_id: 111, digest_time: null, digest_enabled: 1, dates_digest_time: null, dates_digest_enabled: 1 };
const U222 = { tg_id: 222, digest_time: null, digest_enabled: 1, dates_digest_time: null, dates_digest_enabled: 1 };

function notificationHarness({ dates = [], tasks = [], users = [U111, U222], logChanges = 1, sendError = null, stamp = STAMP_MORNING } = {}) {
  const sent = [];
  const openApp = async (env, chatId, url, text) => {
    if (sendError) throw new Error(sendError);
    sent.push({ chatId, text });
  };
  const load = new Function(
    "openApp", "now", "positiveId",
    [
      'const DEFAULT_TZ = "Europe/Moscow";',
      extractBraced("function escapeHtml"),
      extractLine("const RICH_TOKENS"),
      extractBraced("function richInline"),
      extractBraced("function richToHtml"),
      extractLine("const RICH_MASKED"),
      extractLine("const maskTitle"),
      extractLine("const DIGEST_MAX_ITEMS"),
      extractLine("const DIGEST_MAX_CHARS"),
      extractBraced("function validTimeZone"),
      extractBraced("function localDay"),
      extractBraced("function timeZoneOffsetMs"),
      extractBraced("function makeDateInTimeZone"),
      extractBraced("function taskTargetMs"),
      extractBraced("function monthlyOccursOnDay"),
      extractBraced("function nextMonthlyOccurrenceMs"),
      extractLine("const REMINDER_3H"),
      extractLine("const REMINDER_1H"),
      extractBraced("function planTaskReminders"),
      extractBraced("function dateOccursOnDay"),
      extractBraced("function parseTimeMinutes"),
      extractBraced("function localMinutesOfDay"),
      extractBraced("function digestText"),
      extractBraced("function datesDigestText"),
      extractBraced("async function deliverNotification"),
      extractBraced("async function processPairNotifications"),
      "return { processPairNotifications };"
    ].join("\n")
  )(openApp, () => 1760000000, (v) => Number.isSafeInteger(Number(v)) && Number(v) > 0);
  const queries = [];
  const db = makeNotificationDb({ dates, tasks, users, logChanges, sendError, queries });
  return {
    run: (pair = DIGEST_PAIR) => load.processPairNotifications(db.env, pair, new Date(stamp), { left: 44 }),
    sent,
    queries
  };
}

const N_DATES = [
  { id: 1, title: "Общая дата", day: "2020-03-02", time: "10:00", recurs: 1, is_private: 0, created_by: 111 },
  { id: 2, title: "Личная первого", day: "2020-03-02", time: null, recurs: 1, is_private: 1, created_by: 111 },
  { id: 3, title: "Личная второго", day: "2020-03-02", time: null, recurs: 1, is_private: 1, created_by: 222 },
  { id: 4, title: "Завтрашняя общая", day: "2020-03-03", time: "18:00", recurs: 1, is_private: 0, created_by: 111 }
];

test("утренняя сводка: каждый видит только свои личные даты, формат — два абзаца", async () => {
  const h = notificationHarness({ dates: N_DATES });
  await h.run();
  // Каждому уходит и сводка дат за сутки (завтрашняя дата в наборе) —
  // утренние сводки фильтруем по первому сообщению.
  const digests = h.sent.filter(s => s.text.startsWith("Доброе утро!"));
  deepStrictEqual(digests.map(s => s.chatId), [111, 222]);
  for (const s of digests) {
    equal(s.text.includes("📅 Значимые даты"), true);
    equal(s.text.includes("• Сегодня — Общая дата (10:00)"), true);
    equal(s.text.includes("• Завтра — Завтрашняя общая (18:00)"), true);
  }
  equal(digests[0].text.includes("Личная первого"), false);
  equal(digests[0].text.includes("Личная второго"), false);
  equal(digests[1].text.includes("Личная второго"), false);
  equal(digests[1].text.includes("Личная первого"), false);
  // Свой личный план виден, но под спойлером: с экрана блокировки не читается.
  for (const s of digests) equal(s.text.includes("<tg-spoiler>Скрытый</tg-spoiler>"), true);
});

test("участник без событий в дайджесте не получает пустое сообщение", async () => {
  // Личная дата только у первого: второму отправлять нечего.
  const h = notificationHarness({ dates: [N_DATES[1]] });
  await h.run();
  deepStrictEqual(h.sent.map(s => s.chatId), [111]);
});

test("персональное время сводки: до него сводка не уходит", async () => {
  const h = notificationHarness({ dates: N_DATES, users: [{ ...U111, digest_time: "12:00" }, U222] });
  await h.run();
  deepStrictEqual(h.sent.filter(s => s.text.startsWith("Доброе утро!")).map(s => s.chatId), [222]);
});

test("выключенная сводка не отправляется, включённая — отправляется", async () => {
  const h = notificationHarness({ dates: N_DATES, users: [{ ...U111, digest_enabled: 0 }, U222] });
  await h.run();
  deepStrictEqual(h.sent.filter(s => s.text.startsWith("Доброе утро!")).map(s => s.chatId), [222]);
});

test("сводка о датах за сутки: завтрашние даты отдельным сообщением в своё время", async () => {
  const h = notificationHarness({
    dates: N_DATES,
    users: [U111, { ...U222, dates_digest_enabled: 0 }]
  });
  await h.run();
  const datesDigest = h.sent.filter(s => s.text.startsWith("Напоминаю: завтра значимые даты:"));
  deepStrictEqual(datesDigest.map(s => s.chatId), [111]);
  equal(datesDigest[0].text.includes("📅 Завтра · 3 марта"), true);
  equal(datesDigest[0].text.includes("• Завтрашняя общая (18:00)"), true);
});

test("напоминание о плане за 3 часа: уходит обоим в окне [цель-3ч, цель)", async () => {
  const h = notificationHarness({ tasks: [{ id: 5, title: "Купить билеты", day: PAIR_TODAY, time: "14:00" }] });
  await h.run(); // 11:05 MSK, цель 14:00 → 3 часа уже «наступили», час — нет
  const reminders = h.sent.filter(s => s.text.startsWith("⏰ Через 3 часа"));
  deepStrictEqual(reminders.map(s => s.chatId), [111, 222]);
  equal(reminders[0].text.includes("Купить билеты (14:00)"), true);
  equal(h.sent.some(s => s.text.startsWith("⏰ Через час")), false);
});

test("за час до плана уходит только «через час» — «через 3 часа» больше не врёт", async () => {
  const h = notificationHarness({
    tasks: [{ id: 5, title: "Купить билеты", day: PAIR_TODAY, time: "14:00" }],
    stamp: STAMP_NOON // 13:05 MSK: до цели 55 минут
  });
  await h.run();
  // Окна не пересекаются: событие через 55 минут не должно получать
  // сообщение «Через 3 часа» — раньше приходили оба, и первое врало.
  equal(h.sent.filter(s => s.text.startsWith("⏰ Через 3 часа")).length, 0);
  equal(h.sent.filter(s => s.text.startsWith("⏰ Через час")).length, 2);
});

test("план с временем без времени/прошедший не напоминается", async () => {
  const h = notificationHarness({
    tasks: [
      { id: 6, title: "Без времени", day: PAIR_TODAY, time: null },
      { id: 7, title: "Уже прошло", day: PAIR_TODAY, time: "14:00" }
    ],
    stamp: STAMP_AFTER // 15:05 MSK — цель 14:00 позади
  });
  await h.run();
  equal(h.sent.some(s => s.text.startsWith("⏰")), false);
});

test("журнал уже отмечен — повторной отправки нет", async () => {
  const h = notificationHarness({ dates: N_DATES, logChanges: 0 });
  await h.run();
  deepStrictEqual(h.sent, []);
  equal(h.queries.some(q => q.sql.startsWith("INSERT OR IGNORE INTO notification_log")), true);
});

test("заблокированный бот: отметка остаётся, ретрая в тот же день не будет", async () => {
  const h = notificationHarness({ dates: N_DATES, sendError: "Forbidden: bot was blocked by the user" });
  await h.run();
  deepStrictEqual(h.sent, []);
  equal(h.queries.some(q => q.sql.startsWith("DELETE FROM notification_log")), false);
});

test("сетевой сбой: отметка снимается — следующий тик повторит доставку", async () => {
  const h = notificationHarness({ dates: N_DATES, sendError: "The operation was aborted due to timeout" });
  await h.run();
  deepStrictEqual(h.sent, []);
  equal(h.queries.some(q => q.sql.startsWith("DELETE FROM notification_log")), true);
});

test("user_b=0: уведомления уходят только владельцу", async () => {
  const h = notificationHarness({ dates: N_DATES, tasks: [{ id: 5, title: "План", day: PAIR_TODAY, time: "14:00" }] });
  await h.run({ ...DIGEST_PAIR, user_b: 0 });
  deepStrictEqual([...new Set(h.sent.map(s => s.chatId))], [111]);
});

// ------------------------------------------------------------------
// 6. Личные планы: маскировка в сводке и напоминаниях, приватность
// ------------------------------------------------------------------
const N_TASKS = [
  { id: 11, title: "Общий план", day: PAIR_TODAY, time: null, is_private: 0, created_by: 111 },
  { id: 12, title: "Секрет первого", day: PAIR_TODAY, time: null, is_private: 1, created_by: 111 },
  { id: 13, title: "Секрет второго", day: PAIR_TODAY, time: null, is_private: 1, created_by: 222 }
];

test("сводка планов: личный план автора под спойлером, партнёру не показывается", async () => {
  const h = notificationHarness({ tasks: N_TASKS });
  await h.run();
  const digests = h.sent.filter(s => s.text.startsWith("Доброе утро!"));
  deepStrictEqual(digests.map(s => s.chatId), [111, 222]);
  for (const s of digests) equal(s.text.includes("• Сегодня — Общий план"), true);
  equal(digests[0].text.includes("Секрет первого"), false);
  equal(digests[1].text.includes("Секрет первого"), false);
  equal(digests[0].text.includes("Секрет второго"), false);
  equal(digests[1].text.includes("Секрет второго"), false);
  // Каждый видит ровно один скрытый план — свой.
  for (const s of digests) {
    equal(s.text.split("<tg-spoiler>Скрытый</tg-spoiler>").length - 1, 1);
  }
});

test("сводка о датах за сутки: личная завтрашняя дата скрыта спойлером", async () => {
  const h = notificationHarness({
    dates: [
      { id: 21, title: "Годовщина", day: "2020-03-03", time: "19:00", recurs: 1, is_private: 0, created_by: 111 },
      { id: 22, title: "Сюрприз", day: "2020-03-03", time: null, recurs: 1, is_private: 1, created_by: 111 }
    ],
    users: [U111, { ...U222, dates_digest_enabled: 0 }]
  });
  await h.run();
  const msg = h.sent.find(s => s.text.startsWith("Напоминаю: завтра значимые даты:"));
  equal(Boolean(msg), true);
  equal(msg.text.includes("• Годовщина (19:00)"), true);
  equal(msg.text.includes("Сюрприз"), false);
  equal(msg.text.includes("• <tg-spoiler>Скрытый</tg-spoiler>"), true);
});

test("напоминание о личном плане: только автору и со скрытым заголовком", async () => {
  const h = notificationHarness({
    tasks: [{ id: 31, title: "Купить кольцо", day: PAIR_TODAY, time: "14:00", is_private: 1, created_by: 111 }]
  });
  await h.run();
  const reminders = h.sent.filter(s => s.text.startsWith("⏰ Через 3 часа"));
  deepStrictEqual(reminders.map(s => s.chatId), [111]);
  equal(reminders[0].text.includes("Купить кольцо"), false);
  equal(reminders[0].text.includes("⏰ Через 3 часа: <tg-spoiler>Скрытый</tg-spoiler> (14:00)"), true);
});

test("публичный план с разметкой уходит в Telegram как HTML", async () => {
  const h = notificationHarness({
    tasks: [{ id: 32, title: "**Важное** и ||секретик||", day: PAIR_TODAY, time: "14:00", is_private: 0, created_by: 111 }]
  });
  await h.run();
  const reminders = h.sent.filter(s => s.text.startsWith("⏰ Через 3 часа"));
  equal(reminders.length, 2);
  for (const r of reminders) {
    equal(r.text.includes("<b>Важное</b>"), true);
    equal(r.text.includes("<tg-spoiler>секретик</tg-spoiler>"), true);
    equal(r.text.includes("**"), false);
  }
});
