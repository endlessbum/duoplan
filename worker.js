const DAILY_ACTIONS = [
  "Выделите 15 минут только друг для друга — без телефонов и дел.",
  "Назовите друг другу три вещи, за которые вы благодарны этой неделе.",
  "Запланируйте маленькое совместное удовольствие на ближайшие выходные.",
  "Поделитесь воспоминанием, к которому хочется возвращаться.",
  "Сделайте друг другу неожиданный комплимент — конкретный и честный.",
  "Выберите общее дело и сделайте первый маленький шаг вместе.",
  "Устройте мини-свидание: чай, прогулка или любимый фильм."
];

// Действие дня детерминировано парой и датой, чтобы одна и та же пара получала
// одно и то же задание на любой поверхности: полиномиальный хеш по кодовым
// точкам (база 31, переполнение по 32 битам беззнаково), индекс — остаток.
// Точно такой же алгоритм в duoplan/services.py::_daily_action. Менять только
// вместе: tests/test_daily_parity.test.mjs и tests/test_daily_parity.py держат
// обе реализации на общих векторах из tests/fixtures/daily_actions.json.
function dailyAction(pairId, day) {
  let seed = 0;
  for (const char of `${pairId}:${day}`) seed = (seed * 31 + char.charCodeAt(0)) >>> 0;
  return DAILY_ACTIONS[seed % DAILY_ACTIONS.length];
}

const APP_VERSION = "2026.10.30.16";
// Версия схемы D1 — дата последнего изменения структуры таблиц, формат YYYY.MM.DD
// (суффикс .N — вторая и дальнейшие смены схемы за тот же день: строка обязана
// отличаться от уже записанной в app_meta, иначе ensureSchema пропустит ALTER'ы
// и новая колонка никогда не появится на работающей базе).
// Она не может опережать текущую дату: записанная «на будущее» версия совпадёт
// с проверкой в ensureSchema() раньше, чем схема реально изменится, и следующая
// миграция с той же датой будет молча пропущена. На релизе обе версии совпадают.
const DB_SCHEMA_VERSION = "2026.10.30.16";
const DEFAULT_TZ = "Europe/Moscow";

// Акцентные цвета интерфейса: ключ хранится в users.accent_color (NULL = «berry»),
// палитры под светлую/тёмную тему живут на клиенте в public/app.js.
const ACCENT_KEYS = ["berry", "sage", "ocean", "violet", "amber"];

// /api/state отдаёт активные наборы с потолком STATE_ACTIVE_LIMIT и только
// последние записи архивов; остальное догружается страницами через /api/archive
// (у активных наборов база смещения — STATE_ACTIVE_LIMIT, у архивов — STATE_RECENT_LIMIT).
const STATE_ACTIVE_LIMIT = 200;
const STATE_RECENT_LIMIT = 10;
const ARCHIVE_PAGE_SIZE = 20;
const ARCHIVE_QUERIES = {
  memories: {
    sql: `SELECT m.id,m.body,m.day,m.created_at,u.display_name FROM memories m
      LEFT JOIN users u ON u.tg_id=m.author_id WHERE m.pair_id=? ORDER BY m.created_at DESC, m.id DESC LIMIT ? OFFSET ?`
  },
  done_tasks: {
    userScoped: true,
    sql: "SELECT id,title,status,day,time,is_private,created_by,completed_at FROM tasks WHERE pair_id=? AND status='done' AND (is_private=0 OR created_by=?) ORDER BY completed_at DESC, id DESC LIMIT ? OFFSET ?"
  },
  done_wishes: {
    sql: `SELECT w.id,w.body,w.owner_id,w.created_at,w.done_at,w.url,u.display_name FROM wishes w
      LEFT JOIN users u ON u.tg_id=w.owner_id WHERE w.pair_id=? AND w.done=1 ORDER BY w.created_at DESC, w.id DESC LIMIT ? OFFSET ?`
  },
  // Активные наборы: продолжение списков /api/state после 200-й записи.
  // Порядок wishes совпадает со state (SQL). Для tasks/dates И state(), И эта
  // страница сортируют ОДНИМ хелпером полный набор без SQL-лимита: state отдаёт
  // первые 200, страница — сдвиг от 200-й. Разные последовательности дают дубли
  // и потерянные записи (репорт 2026-10-29), поэтому SQL здесь намеренно без LIMIT.
  tasks: {
    active: true,
    sort: "deadline",
    userScoped: true,
    sql: "SELECT id,title,status,day,time,is_private,created_by,created_at FROM tasks WHERE pair_id=? AND status='open' AND (is_private=0 OR created_by=?) ORDER BY created_at DESC"
  },
  dates: {
    active: true,
    sort: "date",
    // Личные даты видит только создатель: фильтр в SQL, а не после запроса —
    // иначе приватная запись успевает попасть в сортируемый набор.
    userScoped: true,
    sql: "SELECT id,title,day,time,recurs,is_private,created_by,created_at FROM dates WHERE pair_id=? AND (is_private=0 OR created_by=?) ORDER BY day"
  },
  wishes: {
    active: true,
    sql: `SELECT w.id,w.body,w.owner_id,w.created_at,w.done_at,w.url,u.display_name FROM wishes w
      LEFT JOIN users u ON u.tg_id=w.owner_id WHERE w.pair_id=? AND w.done=0 ORDER BY w.created_at DESC, w.id DESC LIMIT ? OFFSET ?`
  }
};

// Схема D1 поднимается один раз на изолят Worker (CREATE IF NOT EXISTS + ADD COLUMN).
// Это закрывает случай, когда миграции 0003/0004/0005 ещё не применены на remote.
const schemaReady = new WeakMap();
async function ensureSchemaOnce(env) {
  if (!env?.DB) return;
  let pending = schemaReady.get(env.DB);
  if (!pending) {
    pending = ensureSchema(env).catch(error => {
      schemaReady.delete(env.DB);
      throw error;
    });
    schemaReady.set(env.DB, pending);
  }
  await pending;
}

class HttpError extends Error {
  constructor(status, message, code = "REQUEST_ERROR") {
    super(message);
    this.status = status;
    this.code = code;
  }
}

const json = (data, status = 200, extra = {}) => new Response(JSON.stringify(data), {
  status,
  headers: {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
    ...extra
  }
});
const now = () => Math.floor(Date.now() / 1000);
const positiveId = value => Number.isSafeInteger(Number(value)) && Number(value) > 0;
const clean = value => String(value ?? "").trim();
const displayName = user => {
  const name = clean(user.first_name) || clean(user.username) || "Без имени";
  return Array.from(name).slice(0, 80).join("");
};

function textField(body, key, max, label) {
  const value = clean(body?.[key]);
  if (!value) throw new HttpError(400, `Заполните поле «${label}»`, "VALIDATION_ERROR");
  if (Array.from(value).length > max) throw new HttpError(400, `«${label}»: не больше ${max} символов`, "VALIDATION_ERROR");
  return value;
}

// Ссылка желания: опциональна (пусто — у желания нет ссылки), но если
// указана — должна быть корректным http(s) адресом. Иначе через window.open
// через Mini App можно было бы доставить javascript: и прочие опасные схемы.
function wishUrl(value) {
  const url = clean(value);
  if (!url) return "";
  if (Array.from(url).length > 2048) throw new HttpError(400, "Ссылка: не больше 2048 символов", "INVALID_URL");
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    throw new HttpError(400, "Ссылка должна быть корректным адресом", "INVALID_URL");
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new HttpError(400, "Ссылка должна быть адресом http или https", "INVALID_URL");
  }
  return url;
}

function validTimeZone(value) {
  if (!value || typeof value !== "string" || value.length > 64) return null;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: value }).format();
    return value;
  } catch {
    return null;
  }
}

function localDay(timeZone = DEFAULT_TZ, atMs = Date.now()) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: validTimeZone(timeZone) || DEFAULT_TZ,
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).formatToParts(new Date(atMs));
  const values = Object.fromEntries(parts.map(part => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
}

function validDate(value) {
  const day = clean(value);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return false;
  const parsed = new Date(`${day}T00:00:00Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === day;
}

// Дата и время у плана необязательны: пустая строка означает «не задано».
function optionalDay(value) {
  const day = clean(value);
  if (!day) return null;
  if (!validDate(day)) throw new HttpError(400, "Проверьте дату плана", "INVALID_DATE");
  return day;
}

function optionalTime(value) {
  const time = clean(value);
  if (!time) return null;
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(time)) throw new HttpError(400, "Проверьте время плана", "INVALID_TIME");
  return time;
}

function planSchedule(body) {
  const day = optionalDay(body?.day);
  const time = optionalTime(body?.time);
  if (time && !day) throw new HttpError(400, "Выберите дату, чтобы указать время", "INVALID_DATE");
  return { day, time };
}

function safeEqual(left, right) {
  const a = new TextEncoder().encode(String(left ?? ""));
  const b = new TextEncoder().encode(String(right ?? ""));
  if (!a.length || a.length !== b.length) return false;
  let difference = 0;
  for (let i = 0; i < a.length; i++) difference |= a[i] ^ b[i];
  return difference === 0;
}

async function hmac(keyData, data) {
  const key = await crypto.subtle.importKey("raw", typeof keyData === "string" ? new TextEncoder().encode(keyData) : keyData,
    { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return crypto.subtle.sign("HMAC", key, new TextEncoder().encode(data));
}

function hex(buffer) {
  return [...new Uint8Array(buffer)].map(byte => byte.toString(16).padStart(2, "0")).join("");
}

async function telegramUser(initData, token) {
  if (!initData || !token) return null;
  const params = new URLSearchParams(initData);
  const received = params.get("hash");
  const authDate = Number(params.get("auth_date"));
  if (!received || !Number.isFinite(authDate)) return null;
  // Mini App может оставаться открытым сутками, а initData обновляется только
  // при запуске: суточный порог обрывал живую сессию на второй день. Неделя
  // покрывает нормальную работу и всё ещё ограничивает replay украденных данных.
  const MAX_AGE = 7 * 86400;
  if (authDate > now() + 300 || now() - authDate > MAX_AGE) return null;
  params.delete("hash");
  // Поле signature (Bot API 9.x, Ed25519-валидация третьими сторонами) при HMAC-проверке
  // не исключается: data-check-string — это «chain of all received fields», кроме hash.
  // Исключать signature нужно только в Ed25519-схеме из раздела third-party документации.
  const check = [...params.entries()]
    .sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
    .map(([key, value]) => `${key}=${value}`)
    .join("\n");
  const secret = await hmac("WebAppData", token);
  const expected = hex(await hmac(secret, check));
  if (!safeEqual(expected, received)) return null;
  try {
    const user = JSON.parse(params.get("user") || "null");
    return positiveId(user?.id) ? user : null;
  } catch {
    return null;
  }
}

async function rateLimit(env, key, limit, windowSeconds = 60) {
  const nowSeconds = now();
  const bucket = Math.floor(nowSeconds / windowSeconds);
  const bucketKey = `${key}:${bucket}`;
  const expiresAt = (bucket + 1) * windowSeconds;
  // Счётчик читается через RETURNING в том же UPSERT: отдельный SELECT давал
  // лишний запрос и мог прочитать устаревшее значение при гонке (репорт 2026-10-29).
  const upsert = () => env.DB.prepare(`INSERT INTO rate_limits(bucket_key,count,expires_at) VALUES(?,1,?)
    ON CONFLICT(bucket_key) DO UPDATE SET count=count+1, expires_at=excluded.expires_at
    RETURNING count`).bind(bucketKey, expiresAt).first();
  let row;
  try {
    row = await upsert();
  } catch (error) {
    // На чистой D1 таблица rate_limits может ещё не существовать (ensureSchema
    // вызывается позже). Создаём минимальную схему и повторяем попытку,
    // чтобы защита от перебора секретов работала с первого запуска.
    const message = String(error?.message || error).toLowerCase();
    if (message.includes("no such table")) {
      await env.DB.prepare("CREATE TABLE IF NOT EXISTS rate_limits (bucket_key TEXT PRIMARY KEY, count INTEGER NOT NULL, expires_at INTEGER NOT NULL DEFAULT 0)").run();
      row = await upsert();
    } else if (message.includes("no column named expires_at")) {
      await env.DB.prepare("ALTER TABLE rate_limits ADD COLUMN expires_at INTEGER NOT NULL DEFAULT 0").run();
      row = await upsert();
    } else {
      throw error;
    }
  }
  if (bucket % 10 === 0) {
    // Удаляем только устаревшие окна того же ключа, сравнивая номер окна численно,
    // а не лексикографически по всей строке bucket_key (иначе затрагиваются другие ключи).
    await env.DB.prepare("DELETE FROM rate_limits WHERE expires_at < ?").bind(nowSeconds).run();
  }
  if ((row?.count || 0) > limit) {
    console.log(`[metric] rate_limit_hit key=${key} count=${row?.count || 0} limit=${limit}`);
    throw new HttpError(429, "Слишком много запросов. Подождите минуту.", "RATE_LIMITED");
  }
}

// Вход по коду — главная точка перебора: успешный подбор открывает чужое
// пространство целиком. Код — 4 байта (2^32 вариантов), общий лимит 240/мин
// на аккаунт даёт сотни тысяч попыток в сутки, а путь /start CODE в вебхуке
// общего лимита не имеет вовсе. Считаем только неудачные попытки («код не
// найден»): опечатки пользователя почти не задевает, перебор упирается в
// 5 неудач за 15 минут на аккаунт. Таблица rate_limits общая с rateLimit —
// устаревшие окна чистятся тем же механизмом по expires_at.
const JOIN_ATTEMPT_LIMIT = 5;
const JOIN_ATTEMPT_WINDOW = 15 * 60;

async function checkJoinAttempts(env, userId) {
  const bucket = Math.floor(now() / JOIN_ATTEMPT_WINDOW);
  const row = await env.DB.prepare("SELECT count FROM rate_limits WHERE bucket_key=?")
    .bind(`jf:${userId}:${bucket}`).first();
  if ((row?.count || 0) >= JOIN_ATTEMPT_LIMIT) {
    throw new HttpError(429, "Слишком много неудачных попыток входа по коду. Попробуйте снова через 15 минут.", "JOIN_RATE_LIMITED");
  }
}

async function recordJoinFailure(env, userId) {
  const bucket = Math.floor(now() / JOIN_ATTEMPT_WINDOW);
  await env.DB.prepare(`INSERT INTO rate_limits(bucket_key,count,expires_at) VALUES(?,1,?)
    ON CONFLICT(bucket_key) DO UPDATE SET count=count+1, expires_at=excluded.expires_at`)
    .bind(`jf:${userId}:${bucket}`, (bucket + 1) * JOIN_ATTEMPT_WINDOW).run();
}

async function ensureUser(env, tgUser, requestedTimeZone) {
  const timestamp = now();
  const existing = await env.DB.prepare("SELECT * FROM users WHERE tg_id=?").bind(tgUser.id).first();
  const timezone = validTimeZone(requestedTimeZone) || existing?.timezone || DEFAULT_TZ;
  await env.DB.prepare(`INSERT INTO users(tg_id,username,display_name,timezone,created_at,updated_at) VALUES(?,?,?,?,?,?)
    ON CONFLICT(tg_id) DO UPDATE SET username=excluded.username,display_name=excluded.display_name,
      timezone=excluded.timezone,updated_at=excluded.updated_at`)
    .bind(tgUser.id, tgUser.username || null, displayName(tgUser), timezone, timestamp, timestamp).run();
  return env.DB.prepare("SELECT * FROM users WHERE tg_id=?").bind(tgUser.id).first();
}

async function membership(env, userId) {
  return env.DB.prepare(`SELECT p.*,pm.role,pm.tg_id,
    (SELECT display_name FROM users WHERE tg_id=p.user_a) AS owner_name,
    (SELECT display_name FROM users WHERE tg_id=p.user_b) AS partner_name
    FROM pair_members pm JOIN pairs p ON p.id=pm.pair_id WHERE pm.tg_id=? LIMIT 1`).bind(userId).first();
}

async function createPair(env, user) {
  const existing = await membership(env, user.tg_id);
  if (existing) return existing;
  const timestamp = now();
  const timezone = user.timezone || DEFAULT_TZ;
  for (let attempt = 0; attempt < 3; attempt++) {
    const code = hex(crypto.getRandomValues(new Uint8Array(4))).toUpperCase();
    try {
      await env.DB.batch([
        env.DB.prepare(`INSERT INTO pairs(code,name1,user_a,started_at,timezone,created_at,updated_at)
          VALUES(?,?,?,?,?,?,?)`).bind(code, user.display_name, user.tg_id, localDay(timezone), timezone, timestamp, timestamp),
        env.DB.prepare(`INSERT INTO pair_members(tg_id,pair_id,role,joined_at)
          SELECT ?,id,'a',? FROM pairs WHERE code=?`).bind(user.tg_id, timestamp, code),
        env.DB.prepare(`UPDATE users SET pair_id=(SELECT id FROM pairs WHERE code=?),role='a',updated_at=? WHERE tg_id=?`)
          .bind(code, timestamp, user.tg_id)
      ]);
      return membership(env, user.tg_id);
    } catch (error) {
      const raced = await membership(env, user.tg_id);
      if (raced) return raced;
      if (attempt === 2) throw error;
    }
  }
  throw new HttpError(500, "Не удалось создать пространство", "PAIR_CREATE_FAILED");
}

async function joinPair(env, user, rawCode) {
  const code = clean(rawCode).toUpperCase().slice(0, 16);
  if (!/^[A-F0-9]{8}$/.test(code)) throw new HttpError(400, "Код должен состоять из 8 символов", "INVALID_CODE");
  if (await membership(env, user.tg_id)) throw new HttpError(409, "Вы уже состоите в пространстве", "ALREADY_PAIRED");
  await checkJoinAttempts(env, user.tg_id);
  const pair = await env.DB.prepare("SELECT * FROM pairs WHERE code=?").bind(code).first();
  if (!pair) {
    await recordJoinFailure(env, user.tg_id);
    throw new HttpError(404, "Код не найден", "CODE_NOT_FOUND");
  }
  if (pair.user_a === user.tg_id) throw new HttpError(400, "Это ваш собственный код", "OWN_CODE");
  if (pair.user_b) throw new HttpError(409, "Пространство уже соединено", "PAIR_FULL");
  const timestamp = now();
  let results;
  try {
    results = await env.DB.batch([
      env.DB.prepare("UPDATE pairs SET user_b=?,name2=?,updated_at=? WHERE id=? AND user_b=0")
        .bind(user.tg_id, user.display_name, timestamp, pair.id),
      env.DB.prepare("INSERT INTO pair_members(tg_id,pair_id,role,joined_at) VALUES(?,?,'b',?)")
        .bind(user.tg_id, pair.id, timestamp),
      env.DB.prepare("UPDATE users SET pair_id=?,role='b',updated_at=? WHERE tg_id=?")
        .bind(pair.id, timestamp, user.tg_id)
    ]);
  } catch (error) {
    const message = String(error?.message || error).toLowerCase();
    if (message.includes("unique") || message.includes("constraint") || message.includes("foreign key")) {
      throw new HttpError(409, "Не удалось войти: пространство уже занято", "JOIN_CONFLICT");
    }
    throw error;
  }
  if (!results?.[0]?.meta?.changes) {
    throw new HttpError(409, "Не удалось войти: пространство уже занято", "JOIN_CONFLICT");
  }
  return membership(env, user.tg_id);
}

async function leavePair(env, member, requestUrl) {
  const partnerId = member.role === "a" ? member.user_b : member.user_a;
  // Имя ушедшего для уведомления: display_name из users свежее, чем
  // денормализованные name1/name2 в pairs.
  const leaverName = (member.role === "a" ? member.owner_name : member.partner_name)
    || (member.role === "a" ? member.name1 : member.name2)
    || "Партнёр";
  const timestamp = now();
  const operations = [];
  if (!partnerId) {
    // Последний держатель покидает пространство: данные пары удаляются
    // полностью, освобождая место в базе (восстановить пару по коду нельзя).
    operations.push(
      env.DB.prepare("DELETE FROM tasks WHERE pair_id=?").bind(member.id),
      env.DB.prepare("DELETE FROM dates WHERE pair_id=?").bind(member.id),
      env.DB.prepare("DELETE FROM memories WHERE pair_id=?").bind(member.id),
      env.DB.prepare("DELETE FROM wishes WHERE pair_id=?").bind(member.id),
      env.DB.prepare("DELETE FROM daily_rolls WHERE pair_id=?").bind(member.id),
      env.DB.prepare("DELETE FROM daily_completions WHERE pair_id=?").bind(member.id),
      env.DB.prepare("DELETE FROM pair_members WHERE pair_id=?").bind(member.id),
      env.DB.prepare("DELETE FROM pairs WHERE id=?").bind(member.id)
    );
  } else if (member.role === "a") {
    operations.push(
      env.DB.prepare("DELETE FROM pair_members WHERE tg_id=? AND pair_id=?").bind(member.tg_id, member.id),
      env.DB.prepare(`UPDATE pairs SET user_a=user_b,name1=(SELECT display_name FROM users WHERE tg_id=?),
        user_b=0,name2='',updated_at=? WHERE id=?`).bind(partnerId, timestamp, member.id),
      env.DB.prepare("UPDATE pair_members SET role='a' WHERE tg_id=? AND pair_id=?").bind(partnerId, member.id),
      env.DB.prepare("UPDATE users SET role='a',updated_at=? WHERE tg_id=?").bind(timestamp, partnerId)
    );
  } else {
    operations.push(
      env.DB.prepare("UPDATE pairs SET user_b=0,name2='',updated_at=? WHERE id=?").bind(timestamp, member.id),
      env.DB.prepare("DELETE FROM pair_members WHERE tg_id=? AND pair_id=?").bind(member.tg_id, member.id)
    );
  }
  operations.push(env.DB.prepare("UPDATE users SET pair_id=NULL,role='a',updated_at=? WHERE tg_id=?").bind(timestamp, member.tg_id));
  await env.DB.batch(operations);
  // Оставшийся партнёр узнаёт о выходе сообщением бота — иначе он просто
  // однажды не находит партнёра в пространстве. Сбой Telegram не отменяет
  // сам выход: запись в базе уже применена.
  if (partnerId) {
    try {
      await openApp(env, partnerId, requestUrl,
        `<b>${escapeHtml(leaverName)}</b> больше не в вашем пространстве.\n\n`
        + "Общие планы, даты и воспоминания остались у вас. "
        + "Чтобы позвать партнёра снова, отправьте ему код приглашения.");
    } catch (error) {
      // Молча: уведомление вторично по отношению к самому выходу.
    }
  }
}

// Ритуал теперь отмечается каждым партнёром отдельно: daily_rolls хранит общее
// действие дня, daily_completions — кто уже отметил. done отражает отметку
// текущего пользователя (userId), partnerDone — отметку второго участника.
async function dailyFor(env, pairId, timeZone, userId = null) {
  const day = localDay(timeZone);
  let row = await env.DB.prepare("SELECT * FROM daily_rolls WHERE pair_id=? AND day=?").bind(pairId, day).first();
  if (!row) {
    await env.DB.prepare("INSERT OR IGNORE INTO daily_rolls(pair_id,day,daily_value) VALUES(?,?,?)")
      .bind(pairId, day, dailyAction(pairId, day)).run();
    row = await env.DB.prepare("SELECT * FROM daily_rolls WHERE pair_id=? AND day=?").bind(pairId, day).first();
  }
  const completions = await env.DB.prepare("SELECT tg_id FROM daily_completions WHERE pair_id=? AND day=?").bind(pairId, day).all();
  const completed = new Set((completions.results || []).map((r) => Number(r.tg_id)));
  const myDone = userId != null && completed.has(Number(userId));
  const partnerDone = userId != null ? completed.size > (myDone ? 1 : 0) : completed.size > 0;
  return { day, action: row.daily_value, done: myDone, partnerDone, completedCount: completed.size };
}

// users.streak хранит последнее достигнутое значение и не обнуляется сам по
// себе: после пропущенных дней там остаётся «7», пока кто-то не отметит ритуал.
// Для вывода считаем серию прерванной, если last_activity не сегодня и не
// вчера — иначе интерфейс показывает устаревшую серию (репорт 2026-10-29).
function displayStreak(user) {
  const streak = Number(user?.streak || 0);
  if (streak <= 0) return 0;
  const last = String(user?.last_activity || "").slice(0, 10);
  const today = localDay(user?.timezone);
  const yesterday = new Date(Date.parse(`${today}T00:00:00Z`) - 86400000).toISOString().slice(0, 10);
  return last === today || last === yesterday ? streak : 0;
}

function publicUser(user) {
  return {
    tg_id: user.tg_id,
    display_name: user.display_name,
    points: user.points,
    streak: displayStreak(user),
    best_streak: user.best_streak,
    timezone: user.timezone,
    gender: user.gender || null,
    digest_time: user.digest_time || null,
    digest_enabled: Number(user.digest_enabled ?? 1) === 1,
    dates_digest_time: user.dates_digest_time || null,
    dates_digest_enabled: Number(user.dates_digest_enabled ?? 1) === 1,
    accent_color: user.accent_color || null
  };
}

function timeZoneOffsetMs(timeZone, date) {
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone: timeZone || "UTC",
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false
  });
  const parts = formatter.formatToParts(date);
  const get = (type) => parts.find((part) => part.type === type)?.value || "0";
  const asUtc = Date.UTC(
    Number(get("year")), Number(get("month")) - 1, Number(get("day")),
    Number(get("hour")), Number(get("minute")), Number(get("second"))
  );
  return asUtc - date.getTime();
}

function makeDateInTimeZone(year, monthIndex, day, hour, minute, timeZone) {
  const tz = timeZone || "UTC";
  const desiredUtc = Date.UTC(year, monthIndex, day, hour, minute, 0, 0);
  function localMatches(utcMs) {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit", hour12: false
    }).formatToParts(new Date(utcMs));
    const get = (type) => parts.find((p) => p.type === type)?.value || "0";
    return Number(get("year")) === year &&
      Number(get("month")) === monthIndex + 1 &&
      Number(get("day")) === day &&
      Number(get("hour")) === hour &&
      Number(get("minute")) === minute;
  }
  // Обычный случай: итеративно уточняем смещение.
  let utc = desiredUtc;
  for (let i = 0; i < 3; i++) {
    const offset = timeZoneOffsetMs(tz, new Date(utc));
    const next = desiredUtc - offset;
    if (next === utc) break;
    utc = next;
  }
  if (localMatches(utc)) return new Date(utc);
  // Несуществующее локальное время (весенний перевод часов):
  // используем смещение до перехода, сдвигая момент вперёд.
  const preOffset = timeZoneOffsetMs(tz, new Date(desiredUtc - 24 * 3600000));
  const shifted = desiredUtc - preOffset;
  return new Date(shifted);
}

function taskTargetMs(item, timeZone) {
  if (!item || !item.day) return Number.MAX_SAFE_INTEGER;
  const parts = String(item.day).split("-");
  if (parts.length !== 3) return Number.MAX_SAFE_INTEGER;
  const year = Number(parts[0]);
  const month = Number(parts[1]) - 1;
  const date = Number(parts[2]);
  if (![year, month + 1, date].every(Number.isFinite)) return Number.MAX_SAFE_INTEGER;
  let hours = 23, minutes = 59;
  if (item.time && /^\d{2}:\d{2}$/.test(item.time)) {
    const [hh, mm] = String(item.time).split(":").map(Number);
    if (Number.isFinite(hh) && Number.isFinite(mm)) { hours = hh; minutes = mm; }
  }
  return makeDateInTimeZone(year, month, date, hours, minutes, timeZone).getTime();
}

// Стабильный tie-break по id: годится и для числовых rowid, и для строковых id.
function byRowId(a, b) {
  return a < b ? -1 : a > b ? 1 : 0;
}

// Единая сортировка открытых планов для state() и archivePage(): по ближайшему
// дедлайну, равные ключи — по id. Хелпер один, чтобы первая страница списка и
// архивное продолжение были согласованными последовательностями (репорт 2026-10-29).
// Ключ считается один раз на запись: taskTargetMs строит Intl.DateTimeFormat
// (несколько на вызов) и слишком дорог, чтобы вызывать его из компаратора
// на каждое сравнение.
function sortByTaskDeadline(rows, timeZone) {
  const decorated = rows.map((row) => ({ row, at: taskTargetMs(row, timeZone) }));
  decorated.sort((a, b) => {
    const ta = a.at, tb = b.at;
    if (Number.isFinite(ta) && Number.isFinite(tb)) return ta - tb;
    // Обе Infinity равны, сортируем по id.
    if (!Number.isFinite(ta) && !Number.isFinite(tb)) return byRowId(a.row.id, b.row.id);
    // Только одна Infinity — она уходит в конец (больше любое число).
    return ta === Infinity ? 1 : -1;
  });
  return decorated.map(({ row }) => row);
}

function nextDateOccurrence(item, timeZone) {
  if (!item || !item.day) return Number.MAX_SAFE_INTEGER;
  const parts = String(item.day).split("-");
  if (parts.length !== 3) return Number.MAX_SAFE_INTEGER;
  const month = Number(parts[1]) - 1;
  const date = Number(parts[2]);
  if (!Number.isFinite(month) || !Number.isFinite(date)) return Number.MAX_SAFE_INTEGER;
  const tz = timeZone || "UTC";
  const now = new Date();
  const todayParts = new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
  const [todayYear, todayMonth, todayDay] = todayParts.split("-").map(Number);
  const today = makeDateInTimeZone(todayYear, todayMonth - 1, todayDay, 0, 0, tz);
  let hours = 12, minutes = 0;
  if (item.time && /^\d{2}:\d{2}$/.test(item.time)) {
    const [hh, mm] = String(item.time).split(":").map(Number);
    if (Number.isFinite(hh) && Number.isFinite(mm)) { hours = hh; minutes = mm; }
  }
  const isRecurring = !!item.recurs;
  const currentYear = Number(new Intl.DateTimeFormat("en-US", { timeZone: tz, year: "numeric" }).format(now));
  const years = isRecurring
    ? Array.from({ length: 9 }, (_, index) => currentYear + index)
    : [Number(parts[0])];
  for (const year of years) {
    const candidate = makeDateInTimeZone(year, month, date, hours, minutes, tz);
    const fmt = new Intl.DateTimeFormat("en-US", { timeZone: tz, month: "2-digit", day: "2-digit" });
    const cparts = fmt.formatToParts(candidate);
    const cm = Number(cparts.find((p) => p.type === "month")?.value);
    const cd = Number(cparts.find((p) => p.type === "day")?.value);
    if (cm !== month + 1 || cd !== date) continue;
    if (!isRecurring || candidate >= today) return candidate.getTime();
  }
  // Для ежегодного события не используем исходную (возможно прошедшую) дату как результат.
  if (isRecurring) return Number.MAX_SAFE_INTEGER;
  const fallback = makeDateInTimeZone(Number(parts[0]), month, date, hours, minutes, tz);
  return Number.isNaN(fallback.getTime()) ? Number.MAX_SAFE_INTEGER : fallback.getTime();
}

// Дата — событие дня, а не момента: не-ежегодная запись прошедшая только когда
// прошёл её календарный день. Сравнение по timestamp отправляло «сегодня» в
// прошедшие уже после полудня (12:00 — время по умолчанию), хотя интерфейс
// подписывает её «Сегодня» (репорт 2026-10-29).
function isPastDate(row, timeZone, nowMs) {
  if (!row || row.recurs) return false;
  const day = String(row.day || "");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return false;
  return day < localDay(timeZone || "UTC", nowMs);
}

// Сортировка дат для /api/state: сначала будущие по ближайшему наступлению,
// затем прошедшие не-ежегодные от свежих к старым. Timestamp считается один
// раз на запись: nextDateOccurrence строит Intl.DateTimeFormat и слишком
// дорог, чтобы вызывать его из компаратора на каждое сравнение. Равные ключи
// разбираются по id: порядок в state() и в архивном продолжении обязан совпадать.
function sortDateRows(rows, timeZone, nowMs = Date.now()) {
  const decorated = rows.map((row) => ({ row, at: nextDateOccurrence(row, timeZone) }));
  decorated.sort(({ row: a, at: ta }, { row: b, at: tb }) => {
    const aPast = isPastDate(a, timeZone, nowMs);
    const bPast = isPastDate(b, timeZone, nowMs);
    if (aPast !== bPast) return aPast ? 1 : -1;
    if (aPast && bPast) return tb - ta || byRowId(a.id, b.id);
    return ta - tb || byRowId(a.id, b.id);
  });
  return decorated.map(({ row }) => row);
}

async function state(env, userId) {
  const user = await env.DB.prepare("SELECT * FROM users WHERE tg_id=?").bind(userId).first();
  const pair = await membership(env, userId);
  if (!pair) return { user: publicUser(user), pair: null };
  const partnerId = pair.role === "a" ? pair.user_b : pair.user_a;
  const [tasks, completedTasks, dates, memories, wishes, completedWishes, daily, partnerUser] = await Promise.all([
    // Личные планы (is_private=1) — только для создателя, как и личные даты.
    env.DB.prepare("SELECT id,title,status,day,time,is_private,created_by,created_at FROM tasks WHERE pair_id=? AND status='open' AND (is_private=0 OR created_by=?)").bind(pair.id, user.tg_id).all(),
    env.DB.prepare("SELECT id,title,status,day,time,is_private,created_by,completed_at FROM tasks WHERE pair_id=? AND status='done' AND (is_private=0 OR created_by=?) ORDER BY completed_at DESC, id DESC LIMIT ?").bind(pair.id, user.tg_id, STATE_RECENT_LIMIT).all(),
    // Личные даты (is_private=1) уходят из выдачи партнёру ещё в SQL:
    // владелец видит и свои личные, и общие, партнёр — только общие.
    // created_by нужен интерфейсу, чтобы показывать чекбокс приватности только автору.
    env.DB.prepare("SELECT id,title,day,time,recurs,is_private,created_by,created_at FROM dates WHERE pair_id=? AND (is_private=0 OR created_by=?)").bind(pair.id, user.tg_id).all(),
    env.DB.prepare(`SELECT m.id,m.body,m.day,m.created_at,u.display_name FROM memories m
      LEFT JOIN users u ON u.tg_id=m.author_id WHERE m.pair_id=? ORDER BY m.created_at DESC, m.id DESC LIMIT ?`).bind(pair.id, STATE_RECENT_LIMIT).all(),
    env.DB.prepare(`SELECT w.id,w.body,w.owner_id,w.created_at,w.done_at,w.url,u.display_name FROM wishes w
      LEFT JOIN users u ON u.tg_id=w.owner_id WHERE w.pair_id=? AND w.done=0 ORDER BY w.created_at DESC, w.id DESC LIMIT ?`).bind(pair.id, STATE_ACTIVE_LIMIT).all(),
    env.DB.prepare(`SELECT w.id,w.body,w.owner_id,w.created_at,w.done_at,w.url,u.display_name FROM wishes w
      LEFT JOIN users u ON u.tg_id=w.owner_id WHERE w.pair_id=? AND w.done=1 ORDER BY w.created_at DESC, w.id DESC LIMIT ?`).bind(pair.id, STATE_RECENT_LIMIT).all(),
    // Ритуал — совместное действие: пока партнёр не присоединился, карточки нет.
    // dailyFor учитывает отметку текущего пользователя (user.tg_id).
    pair.user_b ? dailyFor(env, pair.id, pair.timezone, user.tg_id) : null,
    // Пол партнёра — для обращений «Его/Её желания» в вишлисте.
    partnerId ? env.DB.prepare("SELECT gender FROM users WHERE tg_id=?").bind(partnerId).first() : null
  ]);
  const sortedDates = sortDateRows(dates.results || [], pair.timezone).slice(0, STATE_ACTIVE_LIMIT);
  return {
    user: publicUser(user),
    pair: {
      id: pair.id,
      code: pair.user_b ? null : pair.code,
      name1: pair.owner_name || pair.name1,
      name2: pair.partner_name || pair.name2,
      user_b: pair.user_b,
      role: pair.role,
      started_at: pair.started_at,
      together_pts: pair.together_pts,
      timezone: pair.timezone,
      partner_gender: partnerUser?.gender || null,
      bot_name: env.BOT_NAME || "DuoPlan",
      bot_username: env.BOT_USERNAME || "duoplanbot"
    },
    tasks: sortByTaskDeadline(tasks.results || [], pair.timezone).slice(0, STATE_ACTIVE_LIMIT),
    completedTasks: completedTasks.results,
    dates: sortedDates,
    memories: memories.results,
    wishes: wishes.results,
    completedWishes: completedWishes.results,
    daily
  };
}

// Страница догрузки: архивы продолжают первые STATE_RECENT_LIMIT записей
// из /api/state, активные наборы — записи после STATE_ACTIVE_LIMIT.

// Счётчики для точного остатка на кнопке «Показать ещё»: совпадают с
// фильтрами соответствующих запросов ARCHIVE_QUERIES. tasks/dates (sort-путь)
// считают остаток по уже загруженному полному набору — COUNT им не нужен.
const ARCHIVE_COUNT_SQL = {
  memories: "SELECT COUNT(*) AS n FROM memories WHERE pair_id=?",
  done_tasks: "SELECT COUNT(*) AS n FROM tasks WHERE pair_id=? AND status='done' AND (is_private=0 OR created_by=?)",
  done_wishes: "SELECT COUNT(*) AS n FROM wishes WHERE pair_id=? AND done=1",
  wishes: "SELECT COUNT(*) AS n FROM wishes WHERE pair_id=? AND done=0"
};

async function archivePage(env, pair, type, page, userId = null) {
  // Object.hasOwn, а не ARCHIVE_QUERIES[type]: имена из прототипа
  // ("constructor", "toString", "__proto__") дают truthy-функцию, проходят
  // проверку и падают на config.sql уже внутри D1 — 500 вместо 400.
  if (!Object.hasOwn(ARCHIVE_QUERIES, type)) {
    throw new HttpError(400, "Неизвестный тип архива", "INVALID_ARCHIVE_TYPE");
  }
  const config = ARCHIVE_QUERIES[type];
  if (config.sort) {
    // tasks/dates: сервер сортирует весь набор тем же способом, что и state(),
    // и отрезает страницу — порядок продолжения совпадает с порядком списка.
    const bindArgs = config.userScoped ? [pair.id, userId] : [pair.id];
    const all = await env.DB.prepare(config.sql).bind(...bindArgs).all();
    const ordered = config.sort === "date"
      ? sortDateRows(all.results || [], pair.timezone)
      : sortByTaskDeadline(all.results || [], pair.timezone);
    const start = STATE_ACTIVE_LIMIT + page * ARCHIVE_PAGE_SIZE;
    const shown = Math.min(ordered.length, start + ARCHIVE_PAGE_SIZE);
    return {
      items: ordered.slice(start, shown),
      hasMore: ordered.length > start + ARCHIVE_PAGE_SIZE,
      page,
      // Сколько записей ещё не показано после этой страницы — клиент
      // подписывает им кнопку «Показать ещё (N из M)».
      remaining: Math.max(0, ordered.length - shown)
    };
  }
  const offset = (config.active ? STATE_ACTIVE_LIMIT : STATE_RECENT_LIMIT) + page * ARCHIVE_PAGE_SIZE;
  const rows = await env.DB.prepare(config.sql).bind(pair.id, ARCHIVE_PAGE_SIZE + 1, offset).all();
  const results = rows.results || [];
  const shown = offset + Math.min(results.length, ARCHIVE_PAGE_SIZE);
  const totalRow = await env.DB.prepare(ARCHIVE_COUNT_SQL[type])
    .bind(...(config.userScoped ? [pair.id, userId] : [pair.id])).first();
  return {
    items: results.slice(0, ARCHIVE_PAGE_SIZE),
    hasMore: results.length > ARCHIVE_PAGE_SIZE,
    page,
    remaining: Math.max(0, Number(totalRow?.n || 0) - shown)
  };
}

async function readJson(request) {
  try {
    const body = await request.json();
    if (!body || typeof body !== "object" || Array.isArray(body)) throw new Error("not object");
    return body;
  } catch {
    throw new HttpError(400, "Некорректный запрос", "INVALID_JSON");
  }
}

// Желания личные: партнёр видит их в вишлисте, но менять (PATCH, DELETE,
// done/reopen) может только автор. Условия pair_id в SQL недостаточно — оно
// подтверждает лишь, что запись из общего пространства, а не право на правку
// (репорт 2026-10-29: чужие желания менялись через API при read-only UI).
async function ensureWishOwner(env, pair, user, id) {
  const wish = await env.DB.prepare("SELECT owner_id FROM wishes WHERE id=? AND pair_id=?")
    .bind(id, pair.id).first();
  if (!wish) throw new HttpError(404, "Запись не найдена", "NOT_FOUND");
  if (Number(wish.owner_id) !== Number(user.tg_id)) {
    throw new HttpError(403, "Желание принадлежит партнёру", "WISH_NOT_OWNER");
  }
}

// Приватная дата принадлежит автору: партнёр не видит её в списках и не должен
// иметь доступа по прямому id — отвечаем 404, как для несуществующей записи,
// чтобы само существование чужой личной даты не раскрывалось. Возвращает строку
// даты: PATCH использует created_by, чтобы разрешить смену приватности только автору.
async function ensureDateVisible(env, pair, user, id) {
  const row = await env.DB.prepare("SELECT is_private,created_by FROM dates WHERE id=? AND pair_id=?")
    .bind(id, pair.id).first();
  if (!row) return null; // 404 отдаст сам UPDATE/DELETE
  if (Number(row.is_private) === 1 && Number(row.created_by) !== Number(user.tg_id)) {
    throw new HttpError(404, "Запись не найдена", "NOT_FOUND");
  }
  return row;
}

// Личный план — зеркально личной дате: партнёр не видит его в списках и не
// может выполнить/изменить по прямому id; 404 вместо 403 не раскрывает факт
// существования.
async function ensureTaskVisible(env, pair, user, id) {
  const row = await env.DB.prepare("SELECT is_private,created_by FROM tasks WHERE id=? AND pair_id=?")
    .bind(id, pair.id).first();
  if (!row) return null;
  if (Number(row.is_private) === 1 && Number(row.created_by) !== Number(user.tg_id)) {
    throw new HttpError(404, "Запись не найдена", "NOT_FOUND");
  }
  return row;
}

async function itemRoute(env, pair, user, method, pathname, body) {
  const match = pathname.match(/^\/api\/(tasks|dates|memories|wishes)\/(\d+)(?:\/(done|reopen))?$/);
  if (!match) return false;
  const [, type, rawId, action] = match;
  const id = Number(rawId);
  if (!positiveId(id)) throw new HttpError(400, "Некорректный идентификатор", "INVALID_ID");
  const table = { tasks: "tasks", dates: "dates", memories: "memories", wishes: "wishes" }[type];
  // Проверяем владельца до любой записи, чтобы чужая строка не менялась даже
  // частично (UPDATE ... WHERE не сработал бы, но 403 точнее 404).
  const mutating = method === "DELETE" || method === "PATCH" || (method === "POST" && action);
  if (type === "wishes" && mutating) await ensureWishOwner(env, pair, user, id);
  const dateRow = type === "dates" && mutating ? await ensureDateVisible(env, pair, user, id) : null;
  const taskRow = type === "tasks" && mutating ? await ensureTaskVisible(env, pair, user, id) : null;
  if (method === "DELETE") {
    const result = await env.DB.prepare(`DELETE FROM ${table} WHERE id=? AND pair_id=?`).bind(id, pair.id).run();
    if (!result.meta.changes) throw new HttpError(404, "Запись не найдена", "NOT_FOUND");
    return true;
  }
  if (method === "PATCH") {
    const patchSchemas = {
      tasks: { title: { type: "string", maxLength: 180 }, day: { type: "string" }, time: { type: "string" }, is_private: { type: "boolean" } },
      dates: { title: { type: "string", maxLength: 120 }, day: { type: "string" }, time: { type: "string" }, recurs: { type: "boolean" }, is_private: { type: "boolean" } },
      memories: { body: { type: "string", maxLength: 2000 } },
      wishes: { body: { type: "string", maxLength: 300 }, url: { type: "string" } }
    };
    if (patchSchemas[type]) validateSchema(body, patchSchemas[type]);
    const fields = [];
    const values = [];
    if (type === "tasks") {
      const { day, time } = planSchedule(body);
      fields.push("title=?", "day=?", "time=?");
      values.push(textField(body, "title", 180, "План"), day, time);
      // Приватность переключает только автор (зеркально личным датам).
      if (body.is_private !== undefined && Number(taskRow?.created_by) === Number(user.tg_id)) {
        fields.push("is_private=?");
        values.push(body.is_private === true || body.is_private === 1 ? 1 : 0);
      }
    } else if (type === "dates") {
      fields.push("title=?");
      values.push(textField(body, "title", 120, "Название"));
      if (!validDate(body.day)) throw new HttpError(400, "Проверьте дату", "INVALID_DATE");
      fields.push("day=?", "recurs=?", "time=?");
      values.push(clean(body.day), body.recurs === false || body.recurs === 0 ? 0 : 1, optionalTime(body.time));
      // Приватность переключает только автор: партнёр, пометивший чужую общую
      // дату личной, мгновенно терял бы её из своих списков, а у дат без автора
      // (созданы до миграции 0007, created_by=0) фильтр видимости совпадал бы
      // с никем — дата исчезла бы у обоих. Чужие/старые флаги молча игнорируем:
      // диалог партнёра чекбокс не показывает, поле приходит только от автора.
      if (body.is_private !== undefined && Number(dateRow?.created_by) === Number(user.tg_id)) {
        fields.push("is_private=?");
        values.push(body.is_private === true || body.is_private === 1 ? 1 : 0);
      }
    } else if (type === "memories") {
      fields.push("body=?");
      values.push(textField(body, "body", 2000, "Воспоминание"));
    } else {
      fields.push("body=?");
      values.push(textField(body, "body", 300, "Желание"));
      // Ссылка валидируется ДО UPDATE и пишется тем же запросом: иначе при
      // некорректном URL текст уже был бы изменён, а клиент получил бы 400.
      if (body.url !== undefined) {
        fields.push("url=?");
        values.push(wishUrl(body.url));
      }
    }
    const result = await env.DB.prepare(`UPDATE ${table} SET ${fields.join(",")} WHERE id=? AND pair_id=?`)
      .bind(...values, id, pair.id).run();
    if (!result.meta.changes) throw new HttpError(404, "Запись не найдена", "NOT_FOUND");
    return true;
  }
  if (method === "POST" && action) {
    if (!["tasks", "wishes"].includes(type)) throw new HttpError(404, "Действие недоступно", "NOT_FOUND");
    let result;
    if (type === "tasks") {
      result = action === "done"
        ? await env.DB.prepare("UPDATE tasks SET status='done',completed_by=?,completed_at=? WHERE id=? AND pair_id=? AND status='open'")
          .bind(user.tg_id, now(), id, pair.id).run()
        : await env.DB.prepare("UPDATE tasks SET status='open',completed_by=NULL,completed_at=NULL WHERE id=? AND pair_id=? AND status='done'")
          .bind(id, pair.id).run();
    } else {
      result = action === "done"
        ? await env.DB.prepare("UPDATE wishes SET done=1,done_at=? WHERE id=? AND pair_id=? AND owner_id=? AND done=0").bind(now(), id, pair.id, user.tg_id).run()
        : await env.DB.prepare("UPDATE wishes SET done=0,done_at=NULL WHERE id=? AND pair_id=? AND owner_id=? AND done=1").bind(id, pair.id, user.tg_id).run();
    }
    if (!result.meta.changes) throw new HttpError(409, "Запись уже в этом состоянии", "NO_CHANGE");
    return true;
  }
  throw new HttpError(405, "Метод не поддерживается", "METHOD_NOT_ALLOWED");
}

function validateSchema(body, schema) {
  if (typeof body !== "object" || body === null) throw new HttpError(400, "Тело запроса должно быть объектом JSON", "INVALID_BODY");
  for (const [key, rule] of Object.entries(schema)) {
    const code = rule.errorCode || "MISSING_FIELD";
    if (rule.required && !(key in body)) throw new HttpError(400, `Отсутствует обязательное поле: ${key}`, code);
    if (key in body && body[key] !== null) {
      const value = body[key];
      if (rule.type === "string" && typeof value !== "string") throw new HttpError(400, `Поле ${key} должно быть строкой`, code);
      if (rule.type === "boolean" && typeof value !== "boolean") throw new HttpError(400, `Поле ${key} должно быть булевым`, code);
      if (rule.type === "number" && typeof value !== "number") throw new HttpError(400, `Поле ${key} должно быть числом`, code);
      if (rule.enum && !rule.enum.includes(value)) throw new HttpError(400, `Недопустимое значение для ${key}`, code);
      if (rule.maxLength && String(value).length > rule.maxLength) throw new HttpError(400, `Поле ${key} превышает ${rule.maxLength} символов`, code);
    }
  }
}

async function api(request, env, url) {
  if (!env.DB) throw new HttpError(503, "База данных ещё не подключена", "DB_UNAVAILABLE");
  const initData = request.headers.get("x-telegram-init-data");
  const tgUser = await telegramUser(initData, env.BOT_TOKEN);
  if (!tgUser) throw new HttpError(401, "Сессия Telegram истекла. Откройте приложение заново.", "AUTH_EXPIRED");
  // Схема поднимается только после проверки подписи initData: ensureSchema
  // выполняет DDL, и вызов до авторизации позволял любому анонимному запросу
  // запускать миграцию на «холодном» изоляте. rateLimit ниже сам создаёт
  // минимальную таблицу rate_limits, поэтому защита от перебора не страдает.
  await ensureSchemaOnce(env);
  const timezone = validTimeZone(request.headers.get("x-timezone"));
  // Лимит проверяем ДО записи пользователя: иначе флуд всё равно создаёт
  // строки в users, а rate limit срабатывает только после (репорт 2026-10-29).
  await rateLimit(env, `u:${tgUser.id}`, 240, 60);
  const user = await ensureUser(env, tgUser, timezone);

  if (request.method === "GET" && url.pathname === "/api/state") {
    const t0 = Date.now();
    const result = await state(env, user.tg_id);
    console.log(`[metric] api_state_ms=${Date.now() - t0}`);
    return json(result);
  }

  const body = ["POST", "PATCH"].includes(request.method) ? await readJson(request) : {};
  if (request.method === "POST" && url.pathname === "/api/pair/create") {
    await createPair(env, user);
    return json(await state(env, user.tg_id));
  }
  if (request.method === "POST" && url.pathname === "/api/pair/join") {
    validateSchema(body, { code: { type: "string", required: true } });
    await joinPair(env, user, body.code);
    return json(await state(env, user.tg_id));
  }
  // Пол запрашивается гейтом до онбординга, поэтому маршрут обязан работать
  // без пары — как pair/create и pair/join: иначе новый пользователь не сможет
  // его сохранить и не попадёт к созданию пространства.
  if (request.method === "POST" && url.pathname === "/api/gender") {
    validateSchema(body, { gender: { type: "string", required: true, enum: ["male", "female"], errorCode: "INVALID_GENDER" } });
    const gender = clean(body.gender);
    await env.DB.prepare("UPDATE users SET gender = ?, updated_at = ? WHERE tg_id = ?").bind(gender, now(), user.tg_id).run();
    return json(await state(env, user.tg_id));
  }
  // Персональные настройки (карточка «Настройки» на вкладке «Наша пара»):
  // время сводок, их вкл/выкл и акцентный цвет. Доступно и без пары.
  if (request.method === "POST" && url.pathname === "/api/settings") {
    validateSchema(body, {
      accent_color: { type: "string" },
      digest_time: { type: "string" },
      digest_enabled: { type: "boolean" },
      dates_digest_time: { type: "string" },
      dates_digest_enabled: { type: "boolean" }
    });
    const updates = [];
    const values = [];
    if (body?.accent_color !== undefined) {
      if (body.accent_color !== null && !ACCENT_KEYS.includes(body.accent_color)) {
        throw new HttpError(400, "Неизвестный акцентный цвет", "INVALID_ACCENT");
      }
      updates.push("accent_color=?");
      values.push(body.accent_color);
    }
    for (const [timeColumn, enabledColumn, enabledKey] of [
      ["digest_time", "digest_enabled", "digest_enabled"],
      ["dates_digest_time", "dates_digest_enabled", "dates_digest_enabled"]
    ]) {
      if (body?.[timeColumn] !== undefined) {
        if (body[timeColumn] !== null && !/^([01]\d|2[0-3]):[0-5]\d$/.test(clean(body[timeColumn]))) {
          throw new HttpError(400, "Время указывается в формате ЧЧ:ММ", "INVALID_TIME");
        }
        updates.push(`${timeColumn}=?`);
        values.push(body[timeColumn] === null ? null : clean(body[timeColumn]));
      }
      if (body?.[enabledKey] !== undefined) {
        if (typeof body[enabledKey] !== "boolean") throw new HttpError(400, "Флаг включённости должен быть булевым", "INVALID_SETTING");
        updates.push(`${enabledColumn}=?`);
        values.push(body[enabledKey] ? 1 : 0);
      }
    }
    if (!updates.length) throw new HttpError(400, "Нет настроек для сохранения", "EMPTY_SETTINGS");
    updates.push("updated_at=?");
    values.push(now(), user.tg_id);
    await env.DB.prepare(`UPDATE users SET ${updates.join(", ")} WHERE tg_id=?`).bind(...values).run();
    return json(await state(env, user.tg_id));
  }

  const pair = await membership(env, user.tg_id);
  if (!pair) throw new HttpError(409, "Сначала создайте или соедините пространство", "NO_PAIR");
  if (request.method === "GET" && url.pathname === "/api/archive") {
    const type = String(url.searchParams.get("type") || "");
    const page = Math.min(500, Math.max(0, Math.floor(Number(url.searchParams.get("page")) || 0)));
    return json(await archivePage(env, pair, type, page, user.tg_id));
  }
  if (request.method === "POST" && url.pathname === "/api/pair/leave") {
    await leavePair(env, pair, url);
    return json(await state(env, user.tg_id));
  }
  // Резервная копия дневника: записи пары высылаются сообщениями от бота
  // запрашивающему партнёру. Дневник общий — выгружаются все записи, включая
  // записи партнёра: он их и так видит во вкладке «Дневник».
  if (request.method === "POST" && url.pathname === "/api/diary/export") {
    await rateLimit(env, `diary:${user.tg_id}`, 5, 3600);
    const rows = (await env.DB.prepare(`SELECT m.body,m.day,u.display_name FROM memories m
      LEFT JOIN users u ON u.tg_id=m.author_id WHERE m.pair_id=? ORDER BY m.created_at ASC, m.id ASC`)
      .bind(pair.id).all()).results || [];
    for (const text of diaryExportMessages(rows)) {
      await telegram(env, "sendMessage", { chat_id: user.tg_id, text, parse_mode: "HTML" });
    }
    return json({ ok: true });
  }
  if (request.method === "POST" && url.pathname === "/api/tasks") {
    validateSchema(body, { title: { type: "string", required: true, maxLength: 180 }, day: { type: "string" }, time: { type: "string" }, is_private: { type: "boolean" } });
    const title = textField(body, "title", 180, "План");
    const { day, time } = planSchedule(body);
    const isPrivate = body.is_private === true || body.is_private === 1 ? 1 : 0;
    await env.DB.prepare("INSERT INTO tasks(pair_id,title,day,time,is_private,created_by,created_at) VALUES(?,?,?,?,?,?,?)")
      .bind(pair.id, title, day, time, isPrivate, user.tg_id, now()).run();
    return json(await state(env, user.tg_id));
  }
  if (request.method === "POST" && url.pathname === "/api/dates") {
    validateSchema(body, { title: { type: "string", required: true, maxLength: 120 }, day: { type: "string", required: true }, time: { type: "string" }, recurs: { type: "boolean" }, is_private: { type: "boolean" } });
    const title = textField(body, "title", 120, "Название");
    if (!validDate(body.day)) throw new HttpError(400, "Проверьте дату", "INVALID_DATE");
    const time = optionalTime(body.time);
    const isPrivate = body.is_private === true || body.is_private === 1 ? 1 : 0;
    await env.DB.prepare("INSERT INTO dates(pair_id,title,day,time,recurs,is_private,created_by,created_at) VALUES(?,?,?,?,?,?,?,?)")
      .bind(pair.id, title, clean(body.day), time, body.recurs === false || body.recurs === 0 ? 0 : 1, isPrivate, user.tg_id, now()).run();
    return json(await state(env, user.tg_id));
  }
  if (request.method === "POST" && url.pathname === "/api/memories") {
    validateSchema(body, { body: { type: "string", required: true, maxLength: 2000 } });
    const text = textField(body, "body", 2000, "Воспоминание");
    await env.DB.prepare("INSERT INTO memories(pair_id,author_id,body,day,created_at) VALUES(?,?,?,?,?)")
      .bind(pair.id, user.tg_id, text, localDay(pair.timezone), now()).run();
    return json(await state(env, user.tg_id));
  }
  if (request.method === "POST" && url.pathname === "/api/wishes") {
    validateSchema(body, { body: { type: "string", required: true, maxLength: 300 }, url: { type: "string" } });
    const text = textField(body, "body", 300, "Желание");
    const wishLink = wishUrl(body.url);
    await env.DB.prepare("INSERT INTO wishes(pair_id,owner_id,body,url,created_at) VALUES(?,?,?,?,?)")
      .bind(pair.id, user.tg_id, text, wishLink, now()).run();
    return json(await state(env, user.tg_id));
  }
  if (request.method === "POST" && url.pathname === "/api/daily/done") {
    if (!pair.user_b) throw new HttpError(409, "Ритуал дня откроется, когда партнёр присоединится", "PAIR_INCOMPLETE");
    const daily = await dailyFor(env, pair.id, pair.timezone, user.tg_id);
    if (daily.done) return json({ ...(await state(env, user.tg_id)), awarded: false });

    const stamp = now();
    // Захват ритуала и начисление XP выполняются в одной транзакции (D1 batch).
    // Если этап начисления завершится ошибкой, захват откатится вместе с ним,
    // и повторный запрос сможет корректно повторить начисление.
    // changes() отражает результат предыдущего UPDATE в той же транзакции:
    // XP начисляется только если захват ритуала сработал (changes > 0),
    // что исключает дубли и повторное начисление при гонках.
    const batchResults = await env.DB.batch([
      env.DB.prepare("INSERT OR IGNORE INTO daily_completions(pair_id,tg_id,day,completed_at) VALUES(?,?,?,?)")
        .bind(pair.id, user.tg_id, daily.day, stamp),
      env.DB.prepare(`UPDATE users SET
        points = points + 10,
        streak = CASE
          WHEN last_activity IS NULL THEN 1
          WHEN last_activity = ? THEN MAX(1, streak)
          WHEN julianday(?) - julianday(last_activity) = 1 THEN streak + 1
          ELSE 1
        END,
        best_streak = MAX(best_streak, CASE
          WHEN last_activity IS NULL THEN 1
          WHEN last_activity = ? THEN MAX(1, streak)
          WHEN julianday(?) - julianday(last_activity) = 1 THEN streak + 1
          ELSE 1
        END),
        last_activity = ?,
        updated_at = ?
        WHERE tg_id = ?
          AND (SELECT changes()) > 0`)
        .bind(daily.day, daily.day, daily.day, daily.day, daily.day, stamp, user.tg_id),
      env.DB.prepare(`UPDATE pairs SET together_pts=together_pts+10,updated_at=?
        WHERE id = ?
          AND (SELECT changes()) > 0`)
        .bind(stamp, pair.id)
    ]);
    const captured = Number(batchResults?.[0]?.meta?.changes || 0) > 0;
    if (!captured) {
      // Ритуал уже был отмечен — повторный запрос полностью идемпотентен.
      return json({ ...(await state(env, user.tg_id)), awarded: false });
    }
    return json({ ...(await state(env, user.tg_id)), awarded: true });
  }
  if (await itemRoute(env, pair, user, request.method, url.pathname, body)) {
    return json(await state(env, user.tg_id));
  }
  throw new HttpError(404, "Раздел не найден", "NOT_FOUND");
}

// Повтор при сетевой ошибке безопасен только для методов, у которых нет
// побочного эффекта в чате: обрыв соединения и таймаут (AbortSignal) не говорят,
// дошёл ли запрос до Telegram. Для sendMessage повтор после таймаута давал бы
// второе сообщение, поэтому сеть ретраится только для идемпотентных методов,
// а 429 — для всех: там Telegram явно отверг вызов и ничего не отправил.
const TELEGRAM_IDEMPOTENT = new Set([
  "getMe", "getWebhookInfo", "setWebhook", "deleteWebhook", "setMyCommands", "setChatMenuButton"
]);

async function telegram(env, method, payload, attempt = 0) {
  const retryOnNetwork = TELEGRAM_IDEMPOTENT.has(method);
  let response;
  try {
    response = await fetch(`https://api.telegram.org/bot${env.BOT_TOKEN}/${method}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(12000)
    });
  } catch (error) {
    if (retryOnNetwork && attempt < 2) {
      await new Promise(resolve => setTimeout(resolve, 250 * (attempt + 1)));
      return telegram(env, method, payload, attempt + 1);
    }
    throw error;
  }
  const raw = await response.text();
  let result;
  try {
    result = JSON.parse(raw);
  } catch {
    throw new Error(`Telegram вернул не JSON (${response.status})`);
  }
  if (result.error_code === 429 && attempt < 2) {
    const wait = Math.min(3000, Math.max(500, Number(result.parameters?.retry_after || 1) * 1000));
    await new Promise(resolve => setTimeout(resolve, wait));
    return telegram(env, method, payload, attempt + 1);
  }
  if (!response.ok || !result.ok) throw new Error(result.description || `Telegram API ${response.status}`);
  return result.result;
}

function appUrl(env, requestUrl) {
  return `${(env.APP_ORIGIN || requestUrl.origin).replace(/\/$/, "")}/app`;
}

async function openApp(env, chatId, requestUrl, text) {
  // parse_mode HTML: сводки и напоминания собираются через richToHtml
  // (всё экранировано, теги закрыты статически). Статические тексты вебхука
  // не содержат <>& и безопасны в HTML-режиме.
  return telegram(env, "sendMessage", {
    chat_id: chatId,
    text,
    parse_mode: "HTML",
    reply_markup: { inline_keyboard: [[{ text: "Открыть наше пространство", web_app: { url: appUrl(env, requestUrl) } }]] }
  });
}

async function webhook(request, env, url) {
  if (!env.WEBHOOK_SECRET || !safeEqual(request.headers.get("x-telegram-bot-api-secret-token"), env.WEBHOOK_SECRET)) {
    return new Response("Forbidden", { status: 403 });
  }
  // Схема (включая индекс по received_at) создаётся до очистки: иначе
  // DELETE бьёт по таблице без индекса на каждый апдейт (репорт 2026-10-29).
  await ensureSchemaOnce(env);
  // Ограничиваем рост таблицы дедупликации: храним отметки около недели.
  try {
    await env.DB.prepare("DELETE FROM telegram_updates WHERE received_at < ?").bind(now() - 7 * 24 * 60 * 60).run();
  } catch {}

  let update;
  try {
    update = await request.json();
  } catch {
    return json({ ok: true });
  }
  const updateId = positiveId(update?.update_id) ? update.update_id : null;
  let recorded = false;
  if (updateId) {
    const seen = await env.DB.prepare("INSERT OR IGNORE INTO telegram_updates(update_id,received_at) VALUES(?,?)")
      .bind(updateId, now()).run();
    if (!seen.meta.changes) return json({ ok: true });
    recorded = true;
  }
  // Тело апдейта может быть любым JSON: "null" парсится успешно и даёт
  // update === null, поэтому обращение к update.message падало бы TypeError
  // вне try и отдавало 500 вместо тихого {ok:true}.
  const message = update?.message;
  const msgText = message?.text || message?.caption;
  if (!msgText || message.chat?.type !== "private" || !positiveId(message.from?.id)) {
    return json({ ok: true });
  }
  try {
    const user = await ensureUser(env, message.from, null);
    const text = clean(msgText);
    const code = text.startsWith("/start ") ? text.slice(7).trim() : "";
    if (code) {
      let joined = false;
      const existingMembership = await membership(env, user.tg_id);
      if (existingMembership) {
        joined = clean(existingMembership.code).toUpperCase() === code.toUpperCase();
      } else {
        try {
          await joinPair(env, user, code);
          joined = true;
        } catch (error) {
          const racedMembership = await membership(env, user.tg_id);
          joined = !!racedMembership && clean(racedMembership.code).toUpperCase() === code.toUpperCase();
          if (!racedMembership) {
            if (error instanceof HttpError) joined = false;
            else throw error;
          }
        }
      }
      await openApp(env, message.chat.id, url, joined
        ? "Готово — теперь у вас одно пространство на двоих."
        : "Это приглашение недоступно. Проверьте код у партнёра.");
    } else if (text.startsWith("/help")) {
      await telegram(env, "sendMessage", {
        chat_id: message.chat.id,
        text: "DuoPlan хранит ваши общие планы, даты, воспоминания и желания. Откройте Mini App кнопкой ниже: там можно добавлять, редактировать и завершать записи."
      });
      await openApp(env, message.chat.id, url, "Ваше пространство всегда под рукой.");
    } else {
      await openApp(env, message.chat.id, url, "Совместные планы, воспоминания и желания — в одном месте.");
    }
  } catch (error) {
    console.error("webhook delivery failed", error);
    // Снимаем отметку об обработке, чтобы Telegram мог повторить доставку.
    if (recorded && updateId) {
      try {
        await env.DB.prepare("DELETE FROM telegram_updates WHERE update_id=?").bind(updateId).run();
      } catch (cleanupError) {
        console.error("webhook dedup cleanup failed", cleanupError);
      }
    }
    return json({ ok: false, error: "delivery_failed" }, 500);
  }
  return json({ ok: true });
}

// ------------------------------------------------------------------
// Уведомления в боте (cron каждые 15 минут): утренняя сводка (планы и даты
// на сегодня-завтра, двумя абзацами) в персональное время, отдельная сводка
// о датах за сутки до наступления в своё время и напоминания о планах
// с точным временем — за 3 часа и за 1 час. Личные даты получает их автор.
// ------------------------------------------------------------------

// Ежегодная дата совпадает по месяцу и дню независимо от года (29 февраля
// уведомляется только в високосный год — так же, как в интерфейсе, где
// nextDateOccurrence отбрасывает несуществующие календарные даты).
function dateOccursOnDay(item, targetDay) {
  const day = String(item?.day || "");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return false;
  if (day === targetDay) return true;
  return Boolean(item.recurs) && day.slice(5) === targetDay.slice(5);
}

function parseTimeMinutes(value, fallbackMinutes = 9 * 60) {
  const match = /^(\d{1,2}):(\d{2})$/.exec(String(value ?? ""));
  if (!match) return fallbackMinutes;
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  if (hours > 23 || minutes > 59) return fallbackMinutes;
  return hours * 60 + minutes;
}

function localMinutesOfDay(timeZone, stamp) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: timeZone || DEFAULT_TZ, hour: "2-digit", minute: "2-digit", hour12: false
  }).formatToParts(stamp);
  const get = (type) => Number(parts.find((part) => part.type === type)?.value || "0");
  return (get("hour") % 24) * 60 + get("minute");
}

// ------------------------------------------------------------------
// Разметка текста (Telegram-стиль) в уведомлениях. Хранится в самих полях:
// **жирный**, _курсив_, __подчёркнутый__, ~~зачёркнутый~~, ||спойлер|| и
// строки «> » — цитата. Для sendMessage всё экранируется и переводится в
// HTML-теги (parse_mode: HTML в openApp); стек гарантирует закрытость тегов.
// Тот же поднабор поддерживает клиент (renderRichText в public/app.js).
// ------------------------------------------------------------------
function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

const RICH_TOKENS = [["**", "b"], ["__", "u"], ["||", "tg-spoiler"], ["~~", "s"], ["_", "i"]];

function richInline(escaped) {
  const out = [];
  const stack = [];
  let i = 0;
  while (i < escaped.length) {
    const token = RICH_TOKENS.find(([t]) => escaped.startsWith(t, i));
    if (token) {
      const [tok, tag] = token;
      // Балансировка как в HTML: закрывающий маркер закрывает и все вложенные
      // в него элементы — интерливинг «__а _б__ в_» не ломает структуру тегов.
      const openIndex = stack.map(item => item.tok).lastIndexOf(tok);
      if (openIndex !== -1) {
        for (let s = stack.length - 1; s >= openIndex; s--) out.push(`</${stack[s].tag}>`);
        stack.length = openIndex;
      } else {
        out.push(`<${tag}>`);
        stack.push({ tok, tag });
      }
      i += tok.length;
      continue;
    }
    out.push(escaped[i++]);
  }
  while (stack.length) out.push(`</${stack.pop().tag}>`);
  return out.join("");
}

function richToHtml(raw) {
  const lines = escapeHtml(raw).split("\n");
  const out = [];
  let quote = null;
  const flushQuote = () => {
    if (!quote) return;
    out.push(`<blockquote>${quote.map(richInline).join("\n")}</blockquote>`);
    quote = null;
  };
  for (const line of lines) {
    if (line.startsWith("&gt; ")) { (quote ??= []).push(line.slice(5)); continue; }
    if (line === "&gt;") { (quote ??= []).push(""); continue; }
    flushQuote();
    out.push(richInline(line));
  }
  flushQuote();
  // Пустая пара тегов («****» → «<b></b>») не несёт смысла и может сломать
  // разбор entities: вычищаем, повторяя для вложенных пустышек.
  const emptyRe = /<(b|i|u|s|tg-spoiler|blockquote)><\/\1>/g;
  let markup = out.join("\n");
  for (;;) {
    const cleaned = markup.replace(emptyRe, "");
    if (cleaned === markup) return markup;
    markup = cleaned;
  }
}

// Личные события в уведомлениях автора: заголовок скрыт под спойлером,
// чтобы план-сюрприз не читался с экрана блокировки.
const RICH_MASKED = "<tg-spoiler>Скрытый</tg-spoiler>";
const maskTitle = (item) => (Number(item.is_private) === 1 ? RICH_MASKED : richToHtml(item.title));

// Утренняя сводка: два абзаца — значимые даты и планы, внутри каждого
// сегодня/завтра. Один Telegram-месседж (parse_mode HTML в openApp), поэтому
// кап общий: не больше DIGEST_MAX_ITEMS строк И суммарная длина строк в
// пределах DIGEST_MAX_CHARS — разметка и экранирование раздувают строку,
// перебор вернул бы sendMessage 400, и сводка молча не ушла бы.
const DIGEST_MAX_ITEMS = 18;
const DIGEST_MAX_CHARS = 3400;

function digestText(today, tomorrow, dates, tasks) {
  const todayDates = dates.filter(d => dateOccursOnDay(d, today));
  const tomorrowDates = dates.filter(d => dateOccursOnDay(d, tomorrow));
  const todayTasks = tasks.filter(t => String(t.day) === today);
  const tomorrowTasks = tasks.filter(t => String(t.day) === tomorrow);
  if (!todayDates.length && !tomorrowDates.length && !todayTasks.length && !tomorrowTasks.length) return "";
  const dateLines = [
    ...todayDates.map(d => `• Сегодня — ${maskTitle(d)}${d.time ? ` (${d.time})` : ""}`),
    ...tomorrowDates.map(d => `• Завтра — ${maskTitle(d)}${d.time ? ` (${d.time})` : ""}`)
  ];
  const taskLines = [
    ...todayTasks.map(t => `• Сегодня${t.time ? `, до ${t.time}` : ""} — ${maskTitle(t)}`),
    ...tomorrowTasks.map(t => `• Завтра${t.time ? `, до ${t.time}` : ""} — ${maskTitle(t)}`)
  ];
  const lines = ["Доброе утро! Напоминаю о ближайших событиях:", ""];
  let shown = 0;
  let hidden = 0;
  let used = lines[0].length + 1;
  const pushParagraph = (title, items) => {
    if (!items.length) return;
    lines.push(title);
    used += title.length + 1;
    for (const item of items) {
      if (shown < DIGEST_MAX_ITEMS && used + item.length + 1 <= DIGEST_MAX_CHARS) {
        lines.push(item);
        used += item.length + 1;
        shown++;
      } else hidden++;
    }
    lines.push("");
    used += 1;
  };
  pushParagraph("📅 Значимые даты", dateLines);
  pushParagraph("✅ Планы", taskLines);
  if (hidden) lines.push(`…и ещё ${hidden} — полный список в приложении`);
  return lines.join("\n").trim();
}

// Сводка о датах за сутки: только завтрашние даты.
function datesDigestText(timeZone, tomorrow, dates) {
  const fmt = new Intl.DateTimeFormat("ru-RU", { timeZone: timeZone || DEFAULT_TZ, day: "numeric", month: "long" });
  const tomorrowDates = dates.filter(d => dateOccursOnDay(d, tomorrow));
  if (!tomorrowDates.length) return "";
  const [year, month, date] = tomorrow.split("-").map(Number);
  const noon = new Date(makeDateInTimeZone(year, month - 1, date, 12, 0, timeZone || DEFAULT_TZ));
  const lines = [`📅 Завтра · ${fmt.format(noon)}`];
  let shown = 0;
  let hidden = 0;
  let used = lines[0].length + 30;
  for (const item of tomorrowDates) {
    const line = `• ${maskTitle(item)}${item.time ? ` (${item.time})` : ""}`;
    if (shown < DIGEST_MAX_ITEMS && used + line.length + 1 <= DIGEST_MAX_CHARS) { lines.push(line); used += line.length + 1; shown++; }
    else hidden++;
  }
  if (hidden) lines.push(`…и ещё ${hidden}`);
  return ["Напоминаю: завтра значимые даты:", "", ...lines].join("\n").trim();
}

// ------------------------------------------------------------------
// Резервная копия дневника (POST /api/diary/export): записи пары рендерятся
// через richToHtml (экранирование внутри) и режутся на сообщения по блокам —
// Telegram принимает не больше 4096 символов на сообщение, а разметка и
// экранирование раздувают строку (запись «<"×2000» превращается в ~8000).
// ------------------------------------------------------------------
const DIARY_EXPORT_MESSAGE_LIMIT = 3800;
const DIARY_EXPORT_MAX_MESSAGES = 20;

// Обрезка по UTF-16 единицам (как считает Telegram), без разрыва суррогатных пар.
function cutUtf16(text, max) {
  let out = "";
  let used = 0;
  for (const ch of String(text ?? "")) {
    const width = ch.codePointAt(0) > 0xffff ? 2 : 1;
    if (used + width > max) break;
    out += ch;
    used += width;
  }
  return out;
}

function diaryExportMessages(rows) {
  const blocks = (rows || []).map((row) =>
    `📅 ${row.day} · ${escapeHtml(clean(row.display_name) || "Партнёр")}\n${richToHtml(row.body || "")}`
  );
  if (!blocks.length) return ["В вашем дневнике пока нет записей."];
  const messages = [];
  let current = "";
  for (const block of blocks) {
    const chunk = cutUtf16(block, DIARY_EXPORT_MESSAGE_LIMIT);
    if (current && current.length + 2 + chunk.length > DIARY_EXPORT_MESSAGE_LIMIT) {
      messages.push(current);
      current = "";
    }
    current = current ? `${current}\n\n${chunk}` : chunk;
  }
  if (current) messages.push(current);
  messages[0] = `Общий дневник — резервная копия, записей: ${rows.length}\n\n${messages[0]}`;
  // Кап сообщений: не высылаем бесконечный поток, хвост подскажет, что в
  // выгрузку попала только часть.
  if (messages.length > DIARY_EXPORT_MAX_MESSAGES) {
    messages.length = DIARY_EXPORT_MAX_MESSAGES - 1;
    messages.push("…выслана только часть дневника — остальные записи откройте в приложении.");
  }
  return messages;
}

async function deliverNotification(env, member, day, kind, text) {
  // Журнал — и дедуп, и защита от повторов при транзиентных сбоях крона.
  const marked = await env.DB.prepare("INSERT OR IGNORE INTO notification_log(tg_id,day,kind,sent_at) VALUES(?,?,?,?)")
    .bind(member, day, kind, now()).run();
  if (!marked.meta.changes) {
    console.log(`[metric] notification_skipped member=${member} kind=${kind} day=${day}`);
    return false;
  }
  try {
    // requestUrl в кроне нет: appUrl использует env.APP_ORIGIN из vars.
    await openApp(env, member, { origin: "" }, text);
    console.log(`[metric] notification_sent member=${member} kind=${kind} day=${day}`);
    return true;
  } catch (error) {
    const description = String(error?.message || error);
    // Постоянные ошибки Telegram (бот заблокирован, чата нет, неверный запрос)
    // не ретраим: отметку оставляем, чтобы не долбить API до конца дня.
    if (/forbidden|chat not found|blocked|bad request|unauthorized/i.test(description)) return false;
    // Транзиентный сбой — снимаем отметку: следующий тик повторит.
    try {
      await env.DB.prepare("DELETE FROM notification_log WHERE tg_id=? AND day=? AND kind=?")
        .bind(member, day, kind).run();
    } catch (cleanupError) {
      console.error("notification_log cleanup failed", cleanupError);
    }
    return false;
  }
}

// Окна напоминаний не пересекаются: задача, до которой меньше часа, получает
// только «Через час». Раньше обе ветки срабатывали в одном тике, и на задачу
// через 20 минут уходило два сообщения — одно с враньём про «через 3 часа».
const REMINDER_3H = 3 * 3600000;
const REMINDER_1H = 1 * 3600000;

function planTaskReminders(tasks, timeZone, nowMs) {
  const planned = [];
  for (const task of tasks) {
    if (!task.time || !/^\d{2}:\d{2}$/.test(task.time)) continue;
    const target = taskTargetMs(task, timeZone);
    if (!Number.isFinite(target) || target <= nowMs) continue;
    const left = target - nowMs;
    if (left <= REMINDER_1H) planned.push({ task, kind: `task1h:${task.id}`, lead: "Через час" });
    else if (left <= REMINDER_3H) planned.push({ task, kind: `task3h:${task.id}`, lead: "Через 3 часа" });
  }
  return planned;
}

async function processPairNotifications(env, pair, stamp, budget) {
  // validTimeZone: битый/чужой tz в базе не должен ронять Intl исключением.
  const timeZone = validTimeZone(pair.timezone) || DEFAULT_TZ;
  const nowMs = stamp.getTime();
  const today = localDay(timeZone, nowMs);
  const tomorrow = new Date(Date.parse(`${today}T00:00:00Z`) + 86400000).toISOString().slice(0, 10);
  const minutes = localMinutesOfDay(timeZone, stamp);
  const members = [pair.user_a, pair.user_b].filter(id => positiveId(id));
  if (!members.length) return;
  budget.left -= 3; // пользователи + даты + планы
  const [userRows, dateRows, taskRows] = await Promise.all([
    env.DB.prepare(`SELECT * FROM users WHERE tg_id IN (${members.map(() => "?").join(",")})`).bind(...members).all(),
    env.DB.prepare("SELECT id,title,day,time,recurs,is_private,created_by FROM dates WHERE pair_id=?").bind(pair.id).all(),
    env.DB.prepare("SELECT id,title,day,time,is_private,created_by FROM tasks WHERE pair_id=? AND status='open' AND day IS NOT NULL").bind(pair.id).all()
  ]);
  const users = userRows.results || [];
  const dates = dateRows.results || [];
  const tasks = taskRows.results || [];

  // Напоминания о планах с точным временем: за 3 часа и за 1 час. Условие
  // «первый тик, когда время пришло» + дедуп в журнале дают одну отправку.
  // Личные планы напоминают только их автору и со скрытым заголовком.
  const reminders = planTaskReminders(tasks, timeZone, nowMs);
  for (const reminder of reminders) {
    for (const member of members) {
      if (budget.left < 2) break;
      if (Number(reminder.task.is_private) === 1 && Number(reminder.task.created_by) !== Number(member)) continue;
      budget.left -= 2;
      const title = Number(reminder.task.is_private) === 1 ? RICH_MASKED : richToHtml(reminder.task.title);
      await deliverNotification(env, member, today, reminder.kind, `⏰ ${reminder.lead}: ${title} (${reminder.task.time})`);
    }
  }

  for (const member of members) {
    const user = users.find(u => Number(u.tg_id) === Number(member));
    const visibleDates = dates.filter(d => Number(d.is_private) !== 1 || Number(d.created_by) === Number(member));
    // Личные планы — только их автору; заголовок скрыт спойлером в maskTitle.
    const visibleTasks = tasks.filter(t => Number(t.is_private) !== 1 || Number(t.created_by) === Number(member));
    // Утренняя сводка в персональное время (по умолчанию 09:00).
    if (Number(user?.digest_enabled ?? 1) === 1 && minutes >= parseTimeMinutes(user?.digest_time)) {
      const text = digestText(today, tomorrow, visibleDates, visibleTasks);
      if (text) {
        if (budget.left < 2) break;
        budget.left -= 2;
        await deliverNotification(env, member, today, "digest", text);
      }
    }
    // Сводка о датах за сутки: завтрашние даты в персональное время.
    if (Number(user?.dates_digest_enabled ?? 1) === 1 && minutes >= parseTimeMinutes(user?.dates_digest_time)) {
      const text = datesDigestText(timeZone, tomorrow, visibleDates);
      if (text) {
        if (budget.left < 2) break;
        budget.left -= 2;
        await deliverNotification(env, member, today, "dates_digest", text);
      }
    }
  }
}

// Free-план Workers даёт 50 подзапросов на вызов: бюджет считаем явно
// (3 запроса на пару + 2 на каждую отправку) и останавливаемся на пороге.
const DIGEST_MAX_PAIRS = 10;
const DIGEST_BUDGET = 44;

async function sendDigests(env) {
  await ensureSchemaOnce(env);
  // Журнал растёт на несколько строк в день: хвост старше недели бесполезен.
  try {
    await env.DB.prepare("DELETE FROM notification_log WHERE day < ?")
      .bind(localDay(DEFAULT_TZ, Date.now() - 7 * 86400000)).run();
  } catch (error) {
    console.error("notification_log prune failed", error);
  }
  let pairs;
  try {
    pairs = (await env.DB.prepare("SELECT * FROM pairs").all()).results || [];
  } catch (error) {
    console.error("digest pairs query failed", error);
    return;
  }
  if (!pairs.length) return;
  console.log(`[metric] active_pairs=${pairs.length}`);
  const stamp = new Date();
  // Ротация по минутам двигает очередь между 15-минутными тиками, чтобы
  // при большом числе пар все дожидались своего тика, а не только первые.
  const rotation = (stamp.getUTCHours() * 60 + stamp.getUTCMinutes()) % pairs.length;
  const queue = pairs.slice(rotation).concat(pairs.slice(0, rotation)).slice(0, DIGEST_MAX_PAIRS);
  const budget = { left: DIGEST_BUDGET };
  for (const pair of queue) {
    if (budget.left < 4) break;
    try {
      await processPairNotifications(env, pair, stamp, budget);
    } catch (error) {
      console.error("notifications failed for pair", pair?.id, error);
    }
  }
}

async function ensureSchema(env) {
  try {
    const meta = await env.DB.prepare("SELECT value FROM app_meta WHERE key='schema_version'").first();
    if (meta?.value === DB_SCHEMA_VERSION) {
      try {
        await env.DB.batch([
          env.DB.prepare(`INSERT OR IGNORE INTO pair_members(tg_id,pair_id,role,joined_at)
            SELECT user_a,id,'a',created_at FROM pairs WHERE user_a!=0`),
          env.DB.prepare(`INSERT OR IGNORE INTO pair_members(tg_id,pair_id,role,joined_at)
            SELECT user_b,id,'b',created_at FROM pairs WHERE user_b!=0`)
        ]);
      } catch (repairError) {
        console.error("pair_members repair failed", repairError);
      }
      return;
    }
  } catch {
    // Таблицы app_meta ещё нет — продолжаем полную инициализацию
  }

  const statements = [
    `CREATE TABLE IF NOT EXISTS pairs (id INTEGER PRIMARY KEY AUTOINCREMENT,code TEXT NOT NULL UNIQUE,name1 TEXT NOT NULL,name2 TEXT NOT NULL DEFAULT '',user_a INTEGER NOT NULL,user_b INTEGER NOT NULL DEFAULT 0,started_at TEXT NOT NULL,together_pts INTEGER NOT NULL DEFAULT 0,timezone TEXT NOT NULL DEFAULT 'Europe/Moscow',created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL)`,
    `CREATE TABLE IF NOT EXISTS users (tg_id INTEGER PRIMARY KEY,username TEXT,display_name TEXT NOT NULL DEFAULT '',role TEXT NOT NULL DEFAULT 'a',pair_id INTEGER REFERENCES pairs(id) ON DELETE SET NULL,points INTEGER NOT NULL DEFAULT 0,streak INTEGER NOT NULL DEFAULT 0,last_activity TEXT,best_streak INTEGER NOT NULL DEFAULT 0,timezone TEXT NOT NULL DEFAULT 'Europe/Moscow',gender TEXT,digest_time TEXT,digest_enabled INTEGER NOT NULL DEFAULT 1,dates_digest_time TEXT,dates_digest_enabled INTEGER NOT NULL DEFAULT 1,accent_color TEXT,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL)`,
    `CREATE TABLE IF NOT EXISTS pair_members (tg_id INTEGER PRIMARY KEY,pair_id INTEGER NOT NULL REFERENCES pairs(id) ON DELETE CASCADE,role TEXT NOT NULL DEFAULT 'a',joined_at INTEGER NOT NULL)`,
    `CREATE TABLE IF NOT EXISTS tasks (id INTEGER PRIMARY KEY AUTOINCREMENT,pair_id INTEGER NOT NULL REFERENCES pairs(id) ON DELETE CASCADE,title TEXT NOT NULL,status TEXT NOT NULL DEFAULT 'open',day TEXT,time TEXT,is_private INTEGER NOT NULL DEFAULT 0,created_by INTEGER NOT NULL,created_at INTEGER NOT NULL,completed_by INTEGER,completed_at INTEGER)`,
    `CREATE TABLE IF NOT EXISTS dates (id INTEGER PRIMARY KEY AUTOINCREMENT,pair_id INTEGER NOT NULL REFERENCES pairs(id) ON DELETE CASCADE,title TEXT NOT NULL,day TEXT NOT NULL,time TEXT,recurs INTEGER NOT NULL DEFAULT 1,is_private INTEGER NOT NULL DEFAULT 0,created_by INTEGER NOT NULL DEFAULT 0,created_at INTEGER NOT NULL)`,
    `CREATE TABLE IF NOT EXISTS memories (id INTEGER PRIMARY KEY AUTOINCREMENT,pair_id INTEGER NOT NULL REFERENCES pairs(id) ON DELETE CASCADE,author_id INTEGER NOT NULL,body TEXT NOT NULL,day TEXT NOT NULL,created_at INTEGER NOT NULL)`,
    `CREATE TABLE IF NOT EXISTS wishes (id INTEGER PRIMARY KEY AUTOINCREMENT,pair_id INTEGER NOT NULL REFERENCES pairs(id) ON DELETE CASCADE,owner_id INTEGER NOT NULL,body TEXT NOT NULL,done INTEGER NOT NULL DEFAULT 0,done_at INTEGER,created_at INTEGER NOT NULL,url TEXT)`,
    `CREATE TABLE IF NOT EXISTS daily_rolls (pair_id INTEGER NOT NULL REFERENCES pairs(id) ON DELETE CASCADE,day TEXT NOT NULL,daily_value TEXT NOT NULL,PRIMARY KEY (pair_id,day))`,  /* done_by/done_at removed: relic of pre-daily_completions schema */
    `CREATE TABLE IF NOT EXISTS rate_limits (bucket_key TEXT PRIMARY KEY,count INTEGER NOT NULL,expires_at INTEGER NOT NULL DEFAULT 0)`,
    `CREATE TABLE IF NOT EXISTS telegram_updates (update_id INTEGER PRIMARY KEY,received_at INTEGER NOT NULL)`,
    `CREATE TABLE IF NOT EXISTS daily_completions (pair_id INTEGER NOT NULL REFERENCES pairs(id) ON DELETE CASCADE,tg_id INTEGER NOT NULL,day TEXT NOT NULL,completed_at INTEGER NOT NULL,PRIMARY KEY (pair_id,tg_id,day))`,
    `CREATE TABLE IF NOT EXISTS app_meta (key TEXT PRIMARY KEY,value TEXT NOT NULL)`,
    `CREATE TABLE IF NOT EXISTS notification_log (tg_id INTEGER NOT NULL,day TEXT NOT NULL,kind TEXT NOT NULL,sent_at INTEGER NOT NULL,PRIMARY KEY (tg_id,day,kind))`,
    `CREATE INDEX IF NOT EXISTS idx_tasks_pair ON tasks(pair_id,status)`,
    `CREATE INDEX IF NOT EXISTS idx_dates_pair ON dates(pair_id,day)`,
    `CREATE INDEX IF NOT EXISTS idx_memories_pair ON memories(pair_id,created_at)`,
    `CREATE INDEX IF NOT EXISTS idx_wishes_pair ON wishes(pair_id,done)`,
    `CREATE INDEX IF NOT EXISTS idx_pair_members_pair ON pair_members(pair_id)`,
    `CREATE UNIQUE INDEX IF NOT EXISTS idx_pair_members_role ON pair_members(pair_id,role)`,
    `CREATE INDEX IF NOT EXISTS idx_telegram_updates_received_at ON telegram_updates(received_at)`,
    `CREATE INDEX IF NOT EXISTS idx_daily_completions_pair_day ON daily_completions(pair_id,day)`
  ];
  await env.DB.batch(statements.map(sql => env.DB.prepare(sql)));
  for (const [table, column, definition] of [
    ["users", "timezone", "TEXT NOT NULL DEFAULT 'Europe/Moscow'"],
    ["users", "gender", "TEXT"],
    ["users", "digest_time", "TEXT"],
    ["users", "digest_enabled", "INTEGER NOT NULL DEFAULT 1"],
    ["users", "dates_digest_time", "TEXT"],
    ["users", "dates_digest_enabled", "INTEGER NOT NULL DEFAULT 1"],
    ["users", "accent_color", "TEXT"],
    ["pairs", "timezone", "TEXT NOT NULL DEFAULT 'Europe/Moscow'"],
    ["tasks", "day", "TEXT"],
    ["tasks", "time", "TEXT"],
    ["tasks", "is_private", "INTEGER NOT NULL DEFAULT 0"],
    ["dates", "time", "TEXT"],
    ["dates", "is_private", "INTEGER NOT NULL DEFAULT 0"],
    ["dates", "created_by", "INTEGER NOT NULL DEFAULT 0"],
    ["wishes", "done_at", "INTEGER"],
    ["wishes", "url", "TEXT"],
    ["rate_limits", "expires_at", "INTEGER NOT NULL DEFAULT 0"]
  ]) {
    const info = await env.DB.prepare(`PRAGMA table_info(${table})`).all();
    if (!info.results.some(row => row.name === column)) {
      try {
        await env.DB.prepare(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`).run();
      } catch (alterError) {
        // Другой isolate мог добавить колонку между проверкой и ALTER.
        // Считаем шаг выполненным только если колонка действительно есть,
        // остальные ошибки миграции не глушим.
        const fresh = await env.DB.prepare(`PRAGMA table_info(${table})`).all();
        if (!fresh.results.some(row => row.name === column)) throw alterError;
      }
    }
  }
  await env.DB.batch([
    env.DB.prepare(`INSERT OR IGNORE INTO pair_members(tg_id,pair_id,role,joined_at)
      SELECT user_a,id,'a',created_at FROM pairs WHERE user_a!=0 AND EXISTS(SELECT 1 FROM users WHERE tg_id=pairs.user_a)`),
    env.DB.prepare(`INSERT OR IGNORE INTO pair_members(tg_id,pair_id,role,joined_at)
      SELECT user_b,id,'b',created_at FROM pairs WHERE user_b!=0 AND EXISTS(SELECT 1 FROM users WHERE tg_id=pairs.user_b)`)
  ]);
  await env.DB.prepare(
    "INSERT INTO app_meta(key, value) VALUES('schema_version', ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value"
  ).bind(DB_SCHEMA_VERSION).run();
}

async function setup(request, env, url) {
  const missing = ["BOT_TOKEN", "WEBHOOK_SECRET"].filter(key => !env[key]);
  if (missing.length) {
    return json({ error: `Cloudflare Worker не видит: ${missing.join(", ")}`, missing }, 503);
  }
  const ip = request.headers.get("cf-connecting-ip") || "unknown";
  // Лимит применяем до проверки секрета, чтобы неудачные попытки тоже учитывались.
  await rateLimit(env, `setup:${ip}`, 5, 600);
  const supplied = request.headers.get("x-setup-token") ||
    (request.headers.get("authorization") || "").replace(/^Bearer\s+/i, "");
  const expected = env.SETUP_TOKEN || env.BOT_TOKEN;
  if (!safeEqual(supplied, expected)) return json({ error: "Неверный секрет настройки" }, 403, { "www-authenticate": "Bearer" });
  const origin = request.headers.get("origin");
  if (origin && origin !== (env.APP_ORIGIN || url.origin)) return json({ error: "Origin не разрешён" }, 403);
  try {
    await ensureSchema(env);
  } catch (error) {
    console.error("D1 setup failed", error);
    return json({ error: "Не удалось обновить таблицы D1" }, 500);
  }
  const base = (env.APP_ORIGIN || url.origin).replace(/\/$/, "");
  // getMe заодно проверяет токен и возвращает has_main_web_app — признак
  // Main Mini App, которая задаётся вручную в @BotFather (кнопка «ОТКРЫТЬ»
  // в списке чатов появляется только после этого).
  let hasMainApp = false;
  try {
    await telegram(env, "setWebhook", {
      url: `${base}/telegram/webhook`,
      secret_token: env.WEBHOOK_SECRET,
      allowed_updates: ["message"],
      drop_pending_updates: false
    });
    const [, , me] = await Promise.all([
      telegram(env, "setMyCommands", { commands: [
        { command: "menu", description: "Наше пространство" },
        { command: "help", description: "Как работает DuoPlan" }
      ] }),
      telegram(env, "setChatMenuButton", { menu_button: { type: "web_app", text: "DuoPlan", web_app: { url: `${base}/app` } } }),
      telegram(env, "getMe", {})
    ]);
    hasMainApp = me?.has_main_web_app === true;
    await env.DB.prepare("INSERT INTO app_meta(key,value) VALUES('setup_version',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value")
      .bind(DB_SCHEMA_VERSION).run();
  } catch (error) {
    console.error("Telegram setup failed", error);
    return json({ error: "Таблицы готовы, но Telegram не ответил. Проверьте BOT_TOKEN." }, 502);
  }
  return json({ ok: true, webhook_url: `${base}/telegram/webhook`, mini_app_url: `${base}/app`, has_main_web_app: hasMainApp, version: APP_VERSION });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    try {
      if (url.pathname === "/health") {
        let database = false;
        try {
          await env.DB.prepare("SELECT 1").first();
          database = true;
        } catch {}
        return json({
          ok: database,
          service: "duoplan",
          version: APP_VERSION,
          database,
        }, database ? 200 : 503);
      }
      if (url.pathname === "/api/setup" && request.method === "POST") return await setup(request, env, url);
      if (url.pathname.startsWith("/api/")) return await api(request, env, url);
      if (url.pathname === "/telegram/webhook" && request.method === "POST") return await webhook(request, env, url);
      return env.ASSETS.fetch(request);
    } catch (error) {
      // HttpError обрабатываем первыми, так как у них есть код и статус
      if (error instanceof HttpError) {
        const requestId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        console.error(`[DuoPlan HttpError] requestId=${requestId} code=${error.code}`, error);
        return json({ error: error.message, code: error.code, requestId }, error.status);
      }

      // Для остальных ошибок генерируем ID запроса для трассировки
      const requestId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

      // Безопасная диагностика: собираем информацию для логов, но не раскрываем секреты
      const errorInfo = {
        requestId,
        method: request.method,
        endpoint: url.pathname.startsWith("/api/") ? url.pathname : "assets",
        exception: error.constructor?.name || "Error",
        message: error.message || "Unknown error",
      };

      // Полный стек трейс пишем в консоль (internal logs), но не отправляем пользователю
      console.error(`[DuoPlan error] ${JSON.stringify(errorInfo)}`, error);

      // Пользовательское сообщение без стека/подробностей (скрываем initData, BOT_TOKEN и прочее)
      return json({ error: "Не получилось выполнить запрос. Попробуйте ещё раз.", code: "INTERNAL_ERROR", requestId }, 500);
    }
  },
  // Cron (wrangler.jsonc → triggers.crons): сводки и напоминания о планах.
  async scheduled(event, env) {
    await sendDigests(env);
  }
};
