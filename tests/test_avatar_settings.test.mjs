// Аватары из Telegram и личное имя партнёра (item 54).
//
// Фото профиля приходит из initData (user.photo_url): ensureUser сохраняет его
// при каждом открытии приложения, state() отдаёт pair.photo1/photo2. Личное
// имя партнёра (users.partner_custom_name) подставляется только в выдачу
// просматривающего: в name его пары и в подписи авторов воспоминаний/желаний.
// Клиент рисует фото в слоте аватара, пока включён show_avatar, иначе букву.
//
// Запуск: node --test tests/test_avatar_settings.test.mjs
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { deepStrictEqual, equal, ok, rejects } from "node:assert/strict";
import { test } from "node:test";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const workerSource = readFileSync(join(root, "worker.js"), "utf8");
const appSource = readFileSync(join(root, "public/app.js"), "utf8");

function extractBraced(source, declaration) {
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

function extractLine(source, prefix) {
  const start = source.indexOf(prefix);
  if (start === -1) throw new Error(`${prefix} не найдено`);
  return source.slice(start, source.indexOf("\n", start));
}

// Стрелочная функция с блочным телом: const foo = x => { ... };
function extractArrowBlock(source, prefix) {
  const start = source.indexOf(prefix);
  if (start === -1) throw new Error(`${prefix} не найдено`);
  let depth = 0;
  for (let j = source.indexOf("{", start); j < source.length; j++) {
    if (source[j] === "{") depth++;
    else if (source[j] === "}") {
      depth--;
      if (depth === 0) return source.slice(start, j + 1);
    }
  }
  throw new Error(`незакрытый блок: ${prefix}`);
}

// ------------------------------------------------------------------
// 1. POST /api/settings: show_avatar и partner_name
// ------------------------------------------------------------------
const buildApi = new Function(
  "json", "ensureSchemaOnce", "telegramUser", "validTimeZone", "ensureUser",
  "rateLimit", "readJson", "state", "membership", "ownerIds",
  [
    extractBraced(workerSource, "class HttpError"),
    extractLine(workerSource, "const now = "),
    extractLine(workerSource, "const clean = "),
    extractLine(workerSource, "const ACCENT_KEYS"),
    extractBraced(workerSource, "function validateSchema"),
    extractBraced(workerSource, "function textField"),
    extractBraced(workerSource, "function validDate"),
    extractBraced(workerSource, "function optionalTime"),
    extractBraced(workerSource, "function validTimeZone"),
    extractBraced(workerSource, "function ownerIds"),
    extractBraced(workerSource, "async function api"),
    "return api;"
  ].join("\n")
);

function makeApiEnv({ body = {} } = {}) {
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
    async () => ({ user: { tg_id: 777 }, pair: { id: 1 } }),
    async () => ({ id: 1 })
  );
  return { api, env: { DB: db }, queries, request };
}

test("POST /api/settings сохраняет show_avatar и личное имя партнёра", async () => {
  const { api, env, queries, request } = makeApiEnv({
    body: { show_avatar: false, partner_name: "Миша" }
  });
  await api(request, env, new URL("https://duoplan.test/api/settings"));
  const update = queries.find(q => q.sql.startsWith("UPDATE users SET"));
  ok(update, "ожидается UPDATE users");
  ok(update.sql.includes("show_avatar=?"), "нет show_avatar");
  ok(update.sql.includes("partner_custom_name=?"), "нет partner_custom_name");
  deepStrictEqual(update.args.slice(0, 2), [0, "Миша"]);
});

test("POST /api/settings: пустое или null имя партнёра сбрасывает его на NULL", async () => {
  for (const partner_name of [null, "", "   "]) {
    const { api, env, queries, request } = makeApiEnv({ body: { partner_name } });
    await api(request, env, new URL("https://duoplan.test/api/settings"));
    const update = queries.find(q => q.sql.startsWith("UPDATE users SET"));
    deepStrictEqual(update.args[0], null, `partner_name=${JSON.stringify(partner_name)}`);
  }
});

test("POST /api/settings отклоняет не-булев show_avatar и слишком длинное имя", async () => {
  // Строку вместо boolean ловит ещё validateSchema (как и у digest_enabled).
  const badFlag = makeApiEnv({ body: { show_avatar: "yes" } });
  await rejects(
    badFlag.api(badFlag.request, badFlag.env, new URL("https://duoplan.test/api/settings")),
    error => error.status === 400
  );
  // null проходит validateSchema (null разрешён), но не является булевым.
  const nullFlag = makeApiEnv({ body: { show_avatar: null } });
  await rejects(
    nullFlag.api(nullFlag.request, nullFlag.env, new URL("https://duoplan.test/api/settings")),
    error => error.status === 400 && error.code === "INVALID_SETTING"
  );
  const badName = makeApiEnv({ body: { partner_name: "😀".repeat(81) } });
  await rejects(
    badName.api(badName.request, badName.env, new URL("https://duoplan.test/api/settings")),
    error => error.status === 400 && error.code === "INVALID_NAME"
  );
});

// ------------------------------------------------------------------
// 2. ensureUser: photo_url из initData обновляется и очищается
// ------------------------------------------------------------------
const buildEnsureUser = new Function(
  [
    extractLine(workerSource, "const now = "),
    extractLine(workerSource, "const clean = "),
    extractArrowBlock(workerSource, "const displayName = user =>"),
    extractBraced(workerSource, "function validTimeZone"),
    extractBraced(workerSource, "async function ensureUser"),
    "return ensureUser;"
  ].join("\n")
);

function makeEnsureUserDb() {
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
                run: async () => {},
                first: async () => ({ tg_id: 1, timezone: "Europe/Moscow" })
              };
            }
          };
        }
      }
    }
  };
}

test("ensureUser пишет валидный https photo_url из initData", async () => {
  const { env, queries } = makeEnsureUserDb();
  const db0 = buildEnsureUser();
  await db0(env, { id: 1, first_name: "Тест", photo_url: "https://t.me/i/userpic/abc.jpg" }, "Europe/Moscow");
  const insert = queries.find(q => q.sql.startsWith("INSERT INTO users"));
  ok(insert.sql.includes("photo_url"), "photo_url не в INSERT");
  ok(insert.sql.includes("photo_url=excluded.photo_url"), "photo_url не в ON CONFLICT");
  deepStrictEqual(insert.args[4], "https://t.me/i/userpic/abc.jpg");
});

test("ensureUser очищает photo_url, когда аватар удалён (ссылка не https)", async () => {
  for (const photo_url of [undefined, "", "http://insecure.example/x.jpg", "javascript:alert(1)"]) {
    const { env, queries } = makeEnsureUserDb();
    await buildEnsureUser()(env, { id: 1, first_name: "Тест", photo_url }, "Europe/Moscow");
    const insert = queries.find(q => q.sql.startsWith("INSERT INTO users"));
    deepStrictEqual(insert.args[4], null, `photo_url=${JSON.stringify(photo_url)}`);
  }
});

// ------------------------------------------------------------------
// 3. state(): подмена имени партнёра и фото пары
// ------------------------------------------------------------------
const constsStart = workerSource.indexOf("const STATE_ACTIVE_LIMIT");
const constsEnd = workerSource.indexOf("const schemaReady");
if (constsStart === -1 || constsEnd === -1 || constsEnd < constsStart) {
  throw new Error("не найден блок констант лимитов");
}

const loadState = new Function(
  `${workerSource.slice(constsStart, constsEnd)}\n` +
  [
    'const DEFAULT_TZ = "Europe/Moscow";',
    extractLine(workerSource, "const clean = "),
    extractBraced(workerSource, "class HttpError"),
    extractBraced(workerSource, "function validTimeZone"),
    extractBraced(workerSource, "function localDay"),
    extractBraced(workerSource, "function byRowId"),
    extractLine(workerSource, "const dateTimeFormatCache = new Map();"),
    extractBraced(workerSource, "function cachedFormatter"),
    extractBraced(workerSource, "function timeZoneOffsetMs"),
    extractBraced(workerSource, "function makeDateInTimeZone"),
    extractBraced(workerSource, "function taskTargetMs"),
    extractBraced(workerSource, "function sortByTaskDeadline"),
    extractBraced(workerSource, "function nextDateOccurrence"),
    extractBraced(workerSource, "function isPastDate"),
    extractBraced(workerSource, "function sortDateRows"),
    extractBraced(workerSource, "function displayStreak"),
    extractBraced(workerSource, "function publicUser"),
    extractBraced(workerSource, "function withPartnerOverride"),
    extractBraced(workerSource, "async function membership"),
    extractBraced(workerSource, "async function state"),
    // Ритуал в этих тестах не участвует: пара с user_b есть, поэтому state()
    // вызывает dailyFor — глушим его моком.
    "const dailyFor = async () => null;",
    "return { state, publicUser, withPartnerOverride };"
  ].join("\n")
);
const { state, publicUser, withPartnerOverride } = loadState();

const TZ = "Europe/Moscow";

// Пара, где владелец 100, партнёр 200. Роль просматривающего задаётся тестом.
function makePair(role) {
  return {
    id: 1, role, user_a: 100, user_b: 200, code: "ABC123",
    name1: "Оля", name2: "@nikita", started_at: "2026-01-01", together_pts: 0,
    timezone: TZ, owner_name: "Оля", partner_name: "@nikita",
    owner_photo: "https://t.me/i/userpic/olya.jpg", partner_photo: "https://t.me/i/userpic/nikita.jpg"
  };
}

const MEMORIES = [
  { id: 1, title: null, body: "Партнёрское", day: "2026-11-01", created_at: 1, author_id: 200, display_name: "@nikita" },
  { id: 2, title: null, body: "Моё", day: "2026-11-02", created_at: 2, author_id: 100, display_name: "Оля" }
];
const WISHES = [
  { id: 1, body: "Партнёрское желание", owner_id: 200, created_at: 1, done_at: null, url: "", display_name: "@nikita" },
  { id: 2, body: "Моё желание", owner_id: 100, created_at: 2, done_at: null, url: "", display_name: "Оля" }
];

function makeStateDb({ role, override = null, withCompletedWish = false } = {}) {
  const userId = role === "b" ? 200 : 100;
  const pair = makePair(role);
  const pick = (sql) => {
    if (sql.includes("FROM tasks WHERE pair_id=? AND status='open'")) return [];
    if (sql.includes("FROM tasks WHERE pair_id=? AND status='done'")) return [];
    if (sql.includes("FROM dates WHERE pair_id=?")) return [];
    if (sql.includes("FROM memories")) return MEMORIES;
    if (sql.includes("w.done=1")) return withCompletedWish ? [{ ...WISHES[0], done: 1 }] : [];
    if (sql.includes("FROM wishes")) return WISHES;
    if (sql.includes("FROM users WHERE tg_id=?")) {
      // Двойное использование: строка просматривающего (SELECT *) и партнёра.
      return [{
        tg_id: userId, display_name: "Я", gender: "female", points: 0,
        photo_url: "https://t.me/i/userpic/me.jpg", show_avatar: 1,
        partner_custom_name: override, timezone: TZ, digest_enabled: 1, dates_digest_enabled: 1
      }];
    }
    if (sql.includes("FROM pair_members pm JOIN pairs")) return [pair];
    return [];
  };
  return {
    env: {
      DB: {
        prepare(sql) {
          return {
            bind() {
              return {
                all: async () => ({ results: [...pick(sql)] }),
                first: async () => pick(sql)[0] ?? null
              };
            }
          };
        }
      }
    }
  };
}

test("state(): личное имя владельца настройки подставляется в имя его партнёра (role a)", async () => {
  const { env } = makeStateDb({ role: "a", override: "Миша" });
  const result = await state(env, 100);
  deepStrictEqual([result.pair.name1, result.pair.name2], ["Оля", "Миша"]);
  // Подменяется и подпись автора воспоминаний/желаний-партнёра; свои — нет.
  deepStrictEqual(result.memories.map(m => m.display_name), ["Миша", "Оля"]);
  deepStrictEqual(result.wishes.map(w => w.display_name), ["Миша", "Оля"]);
});

test("state(): личное имя подставляется в имя владельца пары (role b)", async () => {
  const { env } = makeStateDb({ role: "b", override: "Милая Оля" });
  const result = await state(env, 200);
  deepStrictEqual([result.pair.name1, result.pair.name2], ["Милая Оля", "@nikita"]);
});

test("state(): без личного имени имена остаются из Telegram", async () => {
  const { env } = makeStateDb({ role: "a", override: null });
  const result = await state(env, 100);
  deepStrictEqual([result.pair.name1, result.pair.name2], ["Оля", "@nikita"]);
});

test("state(): отдаёт photo1/photo2 пары и своё photo_url/show_avatar", async () => {
  const { env } = makeStateDb({ role: "a", override: null });
  const result = await state(env, 100);
  deepStrictEqual(result.pair.photo1, "https://t.me/i/userpic/olya.jpg");
  deepStrictEqual(result.pair.photo2, "https://t.me/i/userpic/nikita.jpg");
  deepStrictEqual(result.user.photo_url, "https://t.me/i/userpic/me.jpg");
  deepStrictEqual(result.user.show_avatar, true);
  deepStrictEqual(result.user.partner_custom_name, null);
});

test("publicUser несёт show_avatar как boolean и partner_custom_name", () => {
  const on = publicUser({ tg_id: 1, display_name: "Я", points: 0, show_avatar: 1, partner_custom_name: "Миша" });
  deepStrictEqual([on.show_avatar, on.partner_custom_name], [true, "Миша"]);
  const off = publicUser({ tg_id: 1, display_name: "Я", points: 0, show_avatar: 0, partner_custom_name: "" });
  deepStrictEqual([off.show_avatar, off.partner_custom_name], [false, null]);
});

test("withPartnerOverride не подменяет имя без пары/роли", () => {
  const viewer = { partner_custom_name: "Миша" };
  const pair = makePair("a");
  deepStrictEqual(withPartnerOverride(viewer, pair), { name1: "Оля", name2: "Миша" });
  const blank = { ...viewer, partner_custom_name: "   " };
  deepStrictEqual(withPartnerOverride(blank, pair), { name1: "Оля", name2: "@nikita" });
});

// ------------------------------------------------------------------
// 4. Клиент: слот аватара и карточка настроек
// ------------------------------------------------------------------
const loadAvatarSlot = new Function(
  [
    // appState живёт в замыкании загрузчика: наружу отдаём сеттер и краситель.
    "let appState;",
    extractBraced(appSource, "function esc"),
    extractBraced(appSource, "function firstLetter"),
    extractBraced(appSource, "function paintAvatarSlot"),
    "return { paint: paintAvatarSlot, setState: (v) => { appState = v; } };"
  ].join("\n")
);

function makeEl() {
  const el = {
    classes: new Set(),
    style: {},
    textContent: "",
    classList: {
      add: (c) => el.classes.add(c),
      remove: (c) => el.classes.delete(c)
    }
  };
  return el;
}

test("paintAvatarSlot: при включённом флаге и https-фото рисуется фото", () => {
  const slot = loadAvatarSlot();
  slot.setState({ user: { show_avatar: true } });
  const el = makeEl();
  slot.paint(el, "Миша", "М", "https://t.me/i/userpic/x.jpg");
  ok(el.classes.has("has-photo"), "нет класса has-photo");
  ok(el.style.backgroundImage.includes("https://t.me/i/userpic/x.jpg"), "фото не в background-image");
  equal(el.textContent, "");
});

test("paintAvatar красит подложку longhand-ом и не стирает background-image с фото", () => {
  // Регрессия: el.style.background = ... (shorthand) сбрасывал background-image,
  // а themeChanged приходит без render() — фото аватаров пропадало при смене
  // темы Telegram до следующего обновления state.
  const loadPaint = new Function(
    [
      'const document = { documentElement: { dataset: { theme: "dark" } } };',
      'const ACCENT_PALETTES = { sage: { dark: "#7ba394" } };',
      extractBraced(appSource, "function hexRgb"),
      extractBraced(appSource, "function paintAvatar"),
      "return paintAvatar;"
    ].join("\n")
  );
  const paint = loadPaint();
  const makeStyled = () => {
    const style = { backgroundImage: 'url("https://t.me/i/userpic/x.jpg")' };
    style.removeProperty = (name) => { delete style[name]; };
    return style;
  };
  const withPhoto = { style: makeStyled() };
  paint(withPhoto, "sage");
  ok(withPhoto.style.backgroundImage.includes("t.me"), "перекраска акцента стёрла фото");
  ok(withPhoto.style.backgroundColor, "подложка не покрашена");
  const noPalette = { style: makeStyled() };
  paint(noPalette, "");
  ok(noPalette.style.backgroundImage.includes("t.me"), "ветка без палитры стёрла фото");
  ok(!("backgroundColor" in noPalette.style), "ветка без палитры оставила инлайн-цвет");
});

test("paintAvatarSlot: выключенный флаг, нет фото или не-https — буква", () => {
  const slot = loadAvatarSlot();
  slot.setState({ user: { show_avatar: false } });
  const off = makeEl();
  slot.paint(off, "Миша", "М", "https://t.me/i/userpic/x.jpg");
  ok(!off.classes.has("has-photo"), "фото при выключенном флаге");
  equal(off.textContent, "М");
  ok(!off.style.backgroundImage, "background-image не снят");

  slot.setState({ user: { show_avatar: true } });
  const noPhoto = makeEl();
  slot.paint(noPhoto, "Миша", "М", null);
  equal(noPhoto.textContent, "М");
  const badScheme = makeEl();
  slot.paint(badScheme, "Миша", "М", "http://x/y.jpg");
  equal(badScheme.textContent, "М");

  // Слоты без имени: null-фото всегда даёт букву-фолбэк.
  const fallback = makeEl();
  slot.paint(fallback, "", "Б", null);
  equal(fallback.textContent, "Б");
});

test("в карточке настроек есть переключатель аватара и поле имени партнёра", () => {
  const start = appSource.indexOf("function renderPairSettings");
  const end = appSource.indexOf("function renderPairExport");
  ok(start !== -1 && end > start, "renderPairSettings не найдена");
  const card = appSource.slice(start, end);
  ok(card.includes('id="show-avatar"'), "нет чекбокса аватара");
  ok(card.includes('id="partner-name-input"'), "нет поля имени партнёра");
  ok(card.includes("Отображение аватара"), "нет подписи пункта");
  ok(card.includes("Имя партнёра"), "нет подписи поля");
});

test("save-settings отправляет show_avatar и partner_name", () => {
  const start = appSource.indexOf('action === "save-settings"');
  const end = appSource.indexOf('action === "set-theme"');
  ok(start !== -1 && end > start, "обработчик save-settings не найден");
  const handler = appSource.slice(start, end);
  ok(handler.includes("show_avatar"), "нет show_avatar в теле запроса");
  ok(handler.includes("partner_name"), "нет partner_name в теле запроса");
});

test("в слотах пилюли пары рисуется paintAvatarSlot с фото из state", () => {
  const start = appSource.indexOf("function syncTopControls");
  ok(start !== -1, "syncTopControls не найдена");
  // Следующее объявление функции закрывает диапазон — внутри самой функции
  // вложенных function-деклараций нет.
  const end = appSource.indexOf("function ", start + 30);
  ok(end > start, "не найден конец syncTopControls");
  const fn = appSource.slice(start, end);
  ok(fn.includes("paintAvatarSlot(avatarA"), "слот A не через paintAvatarSlot");
  ok(fn.includes("paintAvatarSlot(avatarB"), "слот B не через paintAvatarSlot");
  ok(fn.includes("pair.photo1") && fn.includes("pair.photo2"), "фото партнёров не передаются в слоты");
  ok(fn.includes("appState.user.photo_url"), "своё фото не передаётся в слоты");
});
