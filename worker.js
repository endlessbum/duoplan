const DAILY_ACTIONS = [
  "Выделите 15 минут только друг для друга — без телефонов и дел.",
  "Назовите друг другу три вещи, за которые вы благодарны этой неделе.",
  "Запланируйте маленькое совместное удовольствие на ближайшие выходные.",
  "Поделитесь воспоминанием, к которому хочется возвращаться.",
  "Сделайте друг другу неожиданный комплимент — конкретный и честный.",
  "Выберите общее дело и сделайте первый маленький шаг вместе.",
  "Устройте мини-свидание: чай, прогулка или любимый фильм."
];

const APP_VERSION = "2026.10.28";
const DB_SCHEMA_VERSION = "2026.10.29";
const DEFAULT_TZ = "Europe/Moscow";

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

function validTimeZone(value) {
  if (!value || typeof value !== "string" || value.length > 64) return null;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: value }).format();
    return value;
  } catch {
    return null;
  }
}

function localDay(timeZone = DEFAULT_TZ) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: validTimeZone(timeZone) || DEFAULT_TZ,
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).formatToParts(new Date());
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
  if (authDate > now() + 300 || now() - authDate > 86400) return null;
  params.delete("hash");
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
  const insert = () => env.DB.prepare(`INSERT INTO rate_limits(bucket_key,count,expires_at) VALUES(?,1,?)
    ON CONFLICT(bucket_key) DO UPDATE SET count=count+1, expires_at=excluded.expires_at`).bind(bucketKey, expiresAt).run();
  try {
    await insert();
  } catch (error) {
    // На чистой D1 таблица rate_limits может ещё не существовать (ensureSchema
    // вызывается позже). Создаём минимальную схему и повторяем попытку,
    // чтобы защита от перебора секретов работала с первого запуска.
    const message = String(error?.message || error).toLowerCase();
    if (message.includes("no such table")) {
      await env.DB.prepare("CREATE TABLE IF NOT EXISTS rate_limits (bucket_key TEXT PRIMARY KEY, count INTEGER NOT NULL, expires_at INTEGER NOT NULL DEFAULT 0)").run();
      await insert();
    } else if (message.includes("no column named expires_at")) {
      await env.DB.prepare("ALTER TABLE rate_limits ADD COLUMN expires_at INTEGER NOT NULL DEFAULT 0").run();
      await insert();
    } else {
      throw error;
    }
  }
  const row = await env.DB.prepare("SELECT count FROM rate_limits WHERE bucket_key=?").bind(bucketKey).first();
  if (bucket % 10 === 0) {
    // Удаляем только устаревшие окна того же ключа, сравнивая номер окна численно,
    // а не лексикографически по всей строке bucket_key (иначе затрагиваются другие ключи).
    await env.DB.prepare("DELETE FROM rate_limits WHERE expires_at < ?").bind(nowSeconds).run();
  }
  if ((row?.count || 0) > limit) throw new HttpError(429, "Слишком много запросов. Подождите минуту.", "RATE_LIMITED");
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
  const pair = await env.DB.prepare("SELECT * FROM pairs WHERE code=?").bind(code).first();
  if (!pair) throw new HttpError(404, "Код не найден", "CODE_NOT_FOUND");
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

async function leavePair(env, member) {
  const partnerId = member.role === "a" ? member.user_b : member.user_a;
  const timestamp = now();
  const operations = [];
  if (!partnerId) {
    operations.push(
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
}

async function dailyFor(env, pairId, timeZone) {
  const day = localDay(timeZone);
  let row = await env.DB.prepare("SELECT * FROM daily_rolls WHERE pair_id=? AND day=?").bind(pairId, day).first();
  if (!row) {
    let seed = 0;
    for (const char of `${pairId}:${day}`) seed = (seed * 31 + char.charCodeAt(0)) >>> 0;
    const action = DAILY_ACTIONS[seed % DAILY_ACTIONS.length];
    await env.DB.prepare("INSERT OR IGNORE INTO daily_rolls(pair_id,day,daily_value) VALUES(?,?,?)").bind(pairId, day, action).run();
    row = await env.DB.prepare("SELECT * FROM daily_rolls WHERE pair_id=? AND day=?").bind(pairId, day).first();
  }
  return { day, action: row.daily_value, done: Boolean(row.done_by), doneBy: row.done_by || null };
}

function publicUser(user) {
  return {
    tg_id: user.tg_id,
    display_name: user.display_name,
    points: user.points,
    streak: user.streak,
    best_streak: user.best_streak,
    timezone: user.timezone,
    gender: user.gender || null
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
  const preOffset = timeZoneOffsetMs(tz, new Date(desiredUtc - 2 * 3600000));
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

async function state(env, userId) {
  const user = await env.DB.prepare("SELECT * FROM users WHERE tg_id=?").bind(userId).first();
  const pair = await membership(env, userId);
  if (!pair) return { user: publicUser(user), pair: null };
  const [tasks, completedTasks, dates, memories, wishes, completedWishes, daily] = await Promise.all([
    env.DB.prepare("SELECT id,title,status,day,time,created_at FROM tasks WHERE pair_id=? AND status='open' ORDER BY created_at DESC").bind(pair.id).all(),
    env.DB.prepare("SELECT id,title,status,day,time,completed_at FROM tasks WHERE pair_id=? AND status='done' ORDER BY completed_at DESC").bind(pair.id).all(),
    env.DB.prepare("SELECT id,title,day,time,recurs,created_at FROM dates WHERE pair_id=? ORDER BY day").bind(pair.id).all(),
    env.DB.prepare(`SELECT m.id,m.body,m.day,m.created_at,u.display_name FROM memories m
      LEFT JOIN users u ON u.tg_id=m.author_id WHERE m.pair_id=? ORDER BY m.created_at DESC`).bind(pair.id).all(),
    env.DB.prepare(`SELECT w.id,w.body,w.owner_id,w.created_at,u.display_name FROM wishes w
      LEFT JOIN users u ON u.tg_id=w.owner_id WHERE w.pair_id=? AND w.done=0 ORDER BY w.created_at DESC`).bind(pair.id).all(),
    env.DB.prepare(`SELECT w.id,w.body,w.owner_id,w.created_at,u.display_name FROM wishes w
      LEFT JOIN users u ON u.tg_id=w.owner_id WHERE w.pair_id=? AND w.done=1 ORDER BY w.created_at DESC`).bind(pair.id).all(),
    // Ритуал — совместное действие: пока партнёр не присоединился, карточки нет.
    pair.user_b ? dailyFor(env, pair.id, pair.timezone) : null
  ]);
  const nowMs = Date.now();
  const sortedDates = [...(dates.results || [])].sort((a, b) => {
    const ta = nextDateOccurrence(a, pair.timezone);
    const tb = nextDateOccurrence(b, pair.timezone);
    const aPast = !a.recurs && ta < nowMs;
    const bPast = !b.recurs && tb < nowMs;
    if (aPast !== bPast) return aPast ? 1 : -1;
    if (aPast && bPast) return tb - ta;
    return ta - tb;
  });
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
      timezone: pair.timezone
    },
    tasks: [...(tasks.results || [])].sort((a, b) => taskTargetMs(a, pair.timezone) - taskTargetMs(b, pair.timezone)),
    completedTasks: completedTasks.results,
    dates: sortedDates,
    memories: memories.results,
    wishes: wishes.results,
    completedWishes: completedWishes.results,
    daily
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

async function itemRoute(env, pair, user, method, pathname, body) {
  const match = pathname.match(/^\/api\/(tasks|dates|memories|wishes)\/(\d+)(?:\/(done|reopen))?$/);
  if (!match) return false;
  const [, type, rawId, action] = match;
  const id = Number(rawId);
  if (!positiveId(id)) throw new HttpError(400, "Некорректный идентификатор", "INVALID_ID");
  const table = { tasks: "tasks", dates: "dates", memories: "memories", wishes: "wishes" }[type];
  if (method === "DELETE") {
    const result = await env.DB.prepare(`DELETE FROM ${table} WHERE id=? AND pair_id=?`).bind(id, pair.id).run();
    if (!result.meta.changes) throw new HttpError(404, "Запись не найдена", "NOT_FOUND");
    return true;
  }
  if (method === "PATCH") {
    const fields = [];
    const values = [];
    if (type === "tasks") {
      const { day, time } = planSchedule(body);
      fields.push("title=?", "day=?", "time=?");
      values.push(textField(body, "title", 180, "План"), day, time);
    } else if (type === "dates") {
      fields.push("title=?");
      values.push(textField(body, "title", 120, "Название"));
      if (!validDate(body.day)) throw new HttpError(400, "Проверьте дату", "INVALID_DATE");
      fields.push("day=?", "recurs=?", "time=?");
      values.push(clean(body.day), body.recurs === false || body.recurs === 0 ? 0 : 1, optionalTime(body.time));
    } else if (type === "memories") {
      fields.push("body=?");
      values.push(textField(body, "body", 2000, "Воспоминание"));
    } else {
      fields.push("body=?");
      values.push(textField(body, "body", 300, "Желание"));
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
        ? await env.DB.prepare("UPDATE wishes SET done=1 WHERE id=? AND pair_id=? AND done=0").bind(id, pair.id).run()
        : await env.DB.prepare("UPDATE wishes SET done=0 WHERE id=? AND pair_id=? AND done=1").bind(id, pair.id).run();
    }
    if (!result.meta.changes) throw new HttpError(409, "Запись уже в этом состоянии", "NO_CHANGE");
    return true;
  }
  throw new HttpError(405, "Метод не поддерживается", "METHOD_NOT_ALLOWED");
}

async function api(request, env, url) {
  if (!env.DB) throw new HttpError(503, "База данных ещё не подключена", "DB_UNAVAILABLE");
  await ensureSchemaOnce(env);
  const initData = request.headers.get("x-telegram-init-data");
  const tgUser = await telegramUser(initData, env.BOT_TOKEN);
  if (!tgUser) throw new HttpError(401, "Сессия Telegram истекла. Откройте приложение заново.", "AUTH_EXPIRED");
  const timezone = validTimeZone(request.headers.get("x-timezone"));
  const user = await ensureUser(env, tgUser, timezone);
  await rateLimit(env, `u:${tgUser.id}`, 240, 60);

  if (request.method === "GET" && url.pathname === "/api/state") return json(await state(env, user.tg_id));

  const body = ["POST", "PATCH"].includes(request.method) ? await readJson(request) : {};
  if (request.method === "POST" && url.pathname === "/api/pair/create") {
    await createPair(env, user);
    return json(await state(env, user.tg_id));
  }
  if (request.method === "POST" && url.pathname === "/api/pair/join") {
    await joinPair(env, user, body.code);
    return json(await state(env, user.tg_id));
  }

  const pair = await membership(env, user.tg_id);
  if (!pair) throw new HttpError(409, "Сначала создайте или соедините пространство", "NO_PAIR");
  if (request.method === "POST" && url.pathname === "/api/pair/leave") {
    await leavePair(env, pair);
    return json(await state(env, user.tg_id));
  }
  if (request.method === "POST" && url.pathname === "/api/tasks") {
    const title = textField(body, "title", 180, "План");
    const { day, time } = planSchedule(body);
    await env.DB.prepare("INSERT INTO tasks(pair_id,title,day,time,created_by,created_at) VALUES(?,?,?,?,?,?)")
      .bind(pair.id, title, day, time, user.tg_id, now()).run();
    return json(await state(env, user.tg_id));
  }
  if (request.method === "POST" && url.pathname === "/api/dates") {
    const title = textField(body, "title", 120, "Название");
    if (!validDate(body.day)) throw new HttpError(400, "Проверьте дату", "INVALID_DATE");
    const time = optionalTime(body.time);
    await env.DB.prepare("INSERT INTO dates(pair_id,title,day,time,recurs,created_at) VALUES(?,?,?,?,?,?)")
      .bind(pair.id, title, clean(body.day), time, body.recurs === false || body.recurs === 0 ? 0 : 1, now()).run();
    return json(await state(env, user.tg_id));
  }
  if (request.method === "POST" && url.pathname === "/api/memories") {
    const text = textField(body, "body", 2000, "Воспоминание");
    await env.DB.prepare("INSERT INTO memories(pair_id,author_id,body,day,created_at) VALUES(?,?,?,?,?)")
      .bind(pair.id, user.tg_id, text, localDay(pair.timezone), now()).run();
    return json(await state(env, user.tg_id));
  }
  if (request.method === "POST" && url.pathname === "/api/wishes") {
    const text = textField(body, "body", 300, "Желание");
    await env.DB.prepare("INSERT INTO wishes(pair_id,owner_id,body,created_at) VALUES(?,?,?,?)")
      .bind(pair.id, user.tg_id, text, now()).run();
    return json(await state(env, user.tg_id));
  }
  if (request.method === "POST" && url.pathname === "/api/gender") {
    const gender = clean(body?.gender);
    if (gender !== "male" && gender !== "female") throw new HttpError(400, "Недопустимый пол", "INVALID_GENDER");
    await env.DB.prepare("UPDATE users SET gender = ?, updated_at = ? WHERE tg_id = ?").bind(gender, now(), user.tg_id).run();
    return json(await state(env, user.tg_id));
  }
  if (request.method === "POST" && url.pathname === "/api/daily/done") {
    if (!pair.user_b) throw new HttpError(409, "Ритуал дня откроется, когда партнёр присоединится", "PAIR_INCOMPLETE");
    const daily = await dailyFor(env, pair.id, pair.timezone);
    if (daily.done) return json({ ...(await state(env, user.tg_id)), awarded: false });

    const stamp = now();
    // Захват ритуала и начисление XP выполняются в одной транзакции (D1 batch).
    // Если этап начисления завершится ошибкой, захват откатится вместе с ним,
    // и повторный запрос сможет корректно повторить начисление.
    // changes() отражает результат предыдущего UPDATE в той же транзакции:
    // XP начисляется только если захват ритуала сработал (changes > 0),
    // что исключает дубли и повторное начисление при гонках.
    const batchResults = await env.DB.batch([
      env.DB.prepare("UPDATE daily_rolls SET done_by=?,done_at=? WHERE pair_id=? AND day=? AND done_by IS NULL")
        .bind(user.tg_id, stamp, pair.id, daily.day),
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

async function telegram(env, method, payload, attempt = 0) {
  let response;
  try {
    response = await fetch(`https://api.telegram.org/bot${env.BOT_TOKEN}/${method}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(12000)
    });
  } catch (error) {
    if (attempt < 2) {
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
  return telegram(env, "sendMessage", {
    chat_id: chatId,
    text,
    reply_markup: { inline_keyboard: [[{ text: "Открыть наше пространство", web_app: { url: appUrl(env, requestUrl) } }]] }
  });
}

async function webhook(request, env, url) {
  if (!env.WEBHOOK_SECRET || !safeEqual(request.headers.get("x-telegram-bot-api-secret-token"), env.WEBHOOK_SECRET)) {
    return new Response("Forbidden", { status: 403 });
  }
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
  const message = update.message;
  if (!message?.text || message.chat?.type !== "private" || !positiveId(message.from?.id)) {
    return json({ ok: true });
  }
  try {
    const user = await ensureUser(env, message.from, null);
    const text = clean(message.text);
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
      await openApp(env, message.chat.id, url, "Ваши планы, воспоминания и маленькие радости — в одном уютном месте.");
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
    `CREATE TABLE IF NOT EXISTS users (tg_id INTEGER PRIMARY KEY,username TEXT,display_name TEXT NOT NULL DEFAULT '',role TEXT NOT NULL DEFAULT 'a',pair_id INTEGER REFERENCES pairs(id) ON DELETE SET NULL,points INTEGER NOT NULL DEFAULT 0,streak INTEGER NOT NULL DEFAULT 0,last_activity TEXT,best_streak INTEGER NOT NULL DEFAULT 0,timezone TEXT NOT NULL DEFAULT 'Europe/Moscow',gender TEXT,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL)`,
    `CREATE TABLE IF NOT EXISTS pair_members (tg_id INTEGER PRIMARY KEY,pair_id INTEGER NOT NULL REFERENCES pairs(id) ON DELETE CASCADE,role TEXT NOT NULL DEFAULT 'a',joined_at INTEGER NOT NULL)`,
    `CREATE TABLE IF NOT EXISTS tasks (id INTEGER PRIMARY KEY AUTOINCREMENT,pair_id INTEGER NOT NULL REFERENCES pairs(id) ON DELETE CASCADE,title TEXT NOT NULL,status TEXT NOT NULL DEFAULT 'open',day TEXT,time TEXT,created_by INTEGER NOT NULL,created_at INTEGER NOT NULL,completed_by INTEGER,completed_at INTEGER)`,
    `CREATE TABLE IF NOT EXISTS dates (id INTEGER PRIMARY KEY AUTOINCREMENT,pair_id INTEGER NOT NULL REFERENCES pairs(id) ON DELETE CASCADE,title TEXT NOT NULL,day TEXT NOT NULL,time TEXT,recurs INTEGER NOT NULL DEFAULT 1,created_at INTEGER NOT NULL)`,
    `CREATE TABLE IF NOT EXISTS memories (id INTEGER PRIMARY KEY AUTOINCREMENT,pair_id INTEGER NOT NULL REFERENCES pairs(id) ON DELETE CASCADE,author_id INTEGER NOT NULL,body TEXT NOT NULL,day TEXT NOT NULL,created_at INTEGER NOT NULL)`,
    `CREATE TABLE IF NOT EXISTS wishes (id INTEGER PRIMARY KEY AUTOINCREMENT,pair_id INTEGER NOT NULL REFERENCES pairs(id) ON DELETE CASCADE,owner_id INTEGER NOT NULL,body TEXT NOT NULL,done INTEGER NOT NULL DEFAULT 0,created_at INTEGER NOT NULL)`,
    `CREATE TABLE IF NOT EXISTS daily_rolls (pair_id INTEGER NOT NULL REFERENCES pairs(id) ON DELETE CASCADE,day TEXT NOT NULL,daily_value TEXT NOT NULL,done_by INTEGER,done_at INTEGER,PRIMARY KEY (pair_id,day))`,
    `CREATE TABLE IF NOT EXISTS rate_limits (bucket_key TEXT PRIMARY KEY,count INTEGER NOT NULL,expires_at INTEGER NOT NULL DEFAULT 0)`,
    `CREATE TABLE IF NOT EXISTS telegram_updates (update_id INTEGER PRIMARY KEY,received_at INTEGER NOT NULL)`,
    `CREATE TABLE IF NOT EXISTS app_meta (key TEXT PRIMARY KEY,value TEXT NOT NULL)`,
    `CREATE INDEX IF NOT EXISTS idx_tasks_pair ON tasks(pair_id,status)`,
    `CREATE INDEX IF NOT EXISTS idx_dates_pair ON dates(pair_id,day)`,
    `CREATE INDEX IF NOT EXISTS idx_memories_pair ON memories(pair_id,created_at)`,
    `CREATE INDEX IF NOT EXISTS idx_wishes_pair ON wishes(pair_id,done)`,
    `CREATE INDEX IF NOT EXISTS idx_pair_members_pair ON pair_members(pair_id)`,
    `CREATE UNIQUE INDEX IF NOT EXISTS idx_pair_members_role ON pair_members(pair_id,role)`
  ];
  await env.DB.batch(statements.map(sql => env.DB.prepare(sql)));
  for (const [table, column, definition] of [
    ["users", "timezone", "TEXT NOT NULL DEFAULT 'Europe/Moscow'"],
    ["users", "gender", "TEXT"],
    ["pairs", "timezone", "TEXT NOT NULL DEFAULT 'Europe/Moscow'"],
    ["tasks", "day", "TEXT"],
    ["tasks", "time", "TEXT"],
    ["dates", "time", "TEXT"],
    ["rate_limits", "expires_at", "INTEGER NOT NULL DEFAULT 0"]
  ]) {
    const info = await env.DB.prepare(`PRAGMA table_info(${table})`).all();
    if (!info.results.some(row => row.name === column)) {
      await env.DB.prepare(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`).run();
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
  try {
    await telegram(env, "setWebhook", {
      url: `${base}/telegram/webhook`,
      secret_token: env.WEBHOOK_SECRET,
      allowed_updates: ["message"],
      drop_pending_updates: false
    });
    await Promise.all([
      telegram(env, "setMyCommands", { commands: [
        { command: "menu", description: "Наше пространство" },
        { command: "help", description: "Как работает DuoPlan" }
      ] }),
      telegram(env, "setChatMenuButton", { menu_button: { type: "web_app", text: "DuoPlan", web_app: { url: `${base}/app` } } })
    ]);
    await env.DB.prepare("INSERT INTO app_meta(key,value) VALUES('setup_version',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value")
      .bind(DB_SCHEMA_VERSION).run();
  } catch (error) {
    console.error("Telegram setup failed", error);
    return json({ error: "Таблицы готовы, но Telegram не ответил. Проверьте BOT_TOKEN." }, 502);
  }
  return json({ ok: true, webhook_url: `${base}/telegram/webhook`, mini_app_url: `${base}/app`, version: APP_VERSION });
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
          bot_token: Boolean(env.BOT_TOKEN),
          webhook_secret: Boolean(env.WEBHOOK_SECRET)
        }, database ? 200 : 503);
      }
      if (url.pathname === "/api/setup" && request.method === "POST") return await setup(request, env, url);
      if (url.pathname.startsWith("/api/")) return await api(request, env, url);
      if (url.pathname === "/telegram/webhook" && request.method === "POST") return await webhook(request, env, url);
      return env.ASSETS.fetch(request);
    } catch (error) {
      if (error instanceof HttpError) return json({ error: error.message, code: error.code }, error.status);
      console.error(error);
      return json({ error: "Не получилось выполнить запрос. Попробуйте ещё раз.", code: "INTERNAL_ERROR" }, 500);
    }
  }
};
