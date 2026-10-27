const DAILY_ACTIONS = [
  "Выделите 15 минут только друг для друга — без телефонов и дел.",
  "Назовите друг другу три вещи, за которые вы благодарны этой неделе.",
  "Запланируйте маленькое совместное удовольствие на ближайшие выходные.",
  "Поделитесь воспоминанием, к которому хочется возвращаться.",
  "Сделайте друг другу неожиданный комплимент — конкретный и честный.",
  "Выберите общее дело и сделайте первый маленький шаг вместе.",
  "Устройте мини-свидание: чай, прогулка или любимый фильм."
];

const json = (data, status = 200) => new Response(JSON.stringify(data), {
  status,
  headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" }
});
const now = () => Math.floor(Date.now() / 1000);
const today = () => new Date().toISOString().slice(0, 10);
const clean = (value, max = 500) => String(value || "").trim().slice(0, max);
const displayName = user => clean(user.first_name || user.username || "Без имени", 80);

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
  if (Math.abs(now() - authDate) > 86400) return null;
  params.delete("hash");
  const check = [...params.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([key, value]) => `${key}=${value}`).join("\n");
  const secret = await hmac("WebAppData", token);
  const expected = hex(await hmac(secret, check));
  if (expected.length !== received.length) return null;
  let difference = 0;
  for (let i = 0; i < expected.length; i++) difference |= expected.charCodeAt(i) ^ received.charCodeAt(i);
  if (difference) return null;
  try { return JSON.parse(params.get("user") || "null"); } catch { return null; }
}

async function ensureUser(env, tgUser) {
  const timestamp = now();
  await env.DB.prepare(`INSERT INTO users(tg_id,username,display_name,created_at,updated_at) VALUES(?,?,?,?,?)
    ON CONFLICT(tg_id) DO UPDATE SET username=excluded.username,display_name=excluded.display_name,updated_at=excluded.updated_at`)
    .bind(tgUser.id, tgUser.username || null, displayName(tgUser), timestamp, timestamp).run();
  return env.DB.prepare("SELECT * FROM users WHERE tg_id=?").bind(tgUser.id).first();
}

async function membership(env, userId) {
  return env.DB.prepare("SELECT p.* FROM pairs p JOIN users u ON u.pair_id=p.id WHERE u.tg_id=?").bind(userId).first();
}

async function createPair(env, user) {
  const existing = await membership(env, user.tg_id);
  if (existing) return existing;
  const code = hex(crypto.getRandomValues(new Uint8Array(4))).toUpperCase();
  const timestamp = now();
  await env.DB.prepare(`INSERT INTO pairs(code,name1,user_a,started_at,created_at,updated_at) VALUES(?,?,?,?,?,?)`)
    .bind(code, user.display_name, user.tg_id, today(), timestamp, timestamp).run();
  const pair = await env.DB.prepare("SELECT * FROM pairs WHERE code=?").bind(code).first();
  await env.DB.prepare("UPDATE users SET pair_id=?,role='a',updated_at=? WHERE tg_id=?").bind(pair.id, timestamp, user.tg_id).run();
  return pair;
}

async function joinPair(env, user, rawCode) {
  const code = clean(rawCode, 16).toUpperCase();
  const pair = await env.DB.prepare("SELECT * FROM pairs WHERE code=?").bind(code).first();
  if (!pair || pair.user_b || pair.user_a === user.tg_id || await membership(env, user.tg_id)) return null;
  const result = await env.DB.prepare("UPDATE pairs SET user_b=?,name2=?,updated_at=? WHERE id=? AND user_b=0")
    .bind(user.tg_id, user.display_name, now(), pair.id).run();
  if (!result.meta.changes) return null;
  await env.DB.prepare("UPDATE users SET pair_id=?,role='b',updated_at=? WHERE tg_id=?").bind(pair.id, now(), user.tg_id).run();
  return membership(env, user.tg_id);
}

async function dailyFor(env, pairId) {
  const day = today();
  let row = await env.DB.prepare("SELECT * FROM daily_rolls WHERE pair_id=? AND day=?").bind(pairId, day).first();
  if (!row) {
    let seed = 0;
    for (const char of `${pairId}:${day}`) seed = (seed * 31 + char.charCodeAt(0)) >>> 0;
    const action = DAILY_ACTIONS[seed % DAILY_ACTIONS.length];
    await env.DB.prepare("INSERT OR IGNORE INTO daily_rolls(pair_id,day,daily_value) VALUES(?,?,?)").bind(pairId, day, action).run();
    row = await env.DB.prepare("SELECT * FROM daily_rolls WHERE pair_id=? AND day=?").bind(pairId, day).first();
  }
  return { day, action: row.daily_value, done: Boolean(row.done_by) };
}

async function state(env, user) {
  const pair = await membership(env, user.tg_id);
  if (!pair) return { user, pair: null };
  const [tasks, dates, memories, wishes, daily] = await Promise.all([
    env.DB.prepare("SELECT * FROM tasks WHERE pair_id=? AND status='open' ORDER BY created_at DESC LIMIT 50").bind(pair.id).all(),
    env.DB.prepare("SELECT * FROM dates WHERE pair_id=? ORDER BY day LIMIT 50").bind(pair.id).all(),
    env.DB.prepare(`SELECT m.*,u.display_name FROM memories m LEFT JOIN users u ON u.tg_id=m.author_id
      WHERE m.pair_id=? ORDER BY m.created_at DESC LIMIT 50`).bind(pair.id).all(),
    env.DB.prepare(`SELECT w.*,u.display_name FROM wishes w LEFT JOIN users u ON u.tg_id=w.owner_id
      WHERE w.pair_id=? AND w.done=0 ORDER BY w.created_at DESC LIMIT 50`).bind(pair.id).all(),
    dailyFor(env, pair.id)
  ]);
  return { user, pair, tasks: tasks.results, dates: dates.results, memories: memories.results, wishes: wishes.results, daily };
}

async function api(request, env, url) {
  if (!env.DB) return json({ error: "База данных ещё не подключена" }, 503);
  const tgUser = await telegramUser(request.headers.get("x-telegram-init-data"), env.BOT_TOKEN);
  if (!tgUser?.id) return json({ error: "Откройте приложение через Telegram" }, 401);
  const user = await ensureUser(env, tgUser);
  if (request.method === "GET" && url.pathname === "/api/state") return json(await state(env, user));
  if (request.method !== "POST") return json({ error: "Метод не поддерживается" }, 405);
  const body = await request.json().catch(() => ({}));

  if (url.pathname === "/api/pair/create") return json(await state(env, (await createPair(env, user), user)));
  if (url.pathname === "/api/pair/join") {
    const pair = await joinPair(env, user, body.code);
    return pair ? json(await state(env, user)) : json({ error: "Код недоступен или пространство уже занято" }, 400);
  }

  const pair = await membership(env, user.tg_id);
  if (!pair) return json({ error: "Сначала создайте или соедините пространство" }, 400);
  let match;
  if (url.pathname === "/api/tasks") {
    const title = clean(body.title, 180);
    if (!title) return json({ error: "Введите план" }, 400);
    await env.DB.prepare("INSERT INTO tasks(pair_id,title,created_by,created_at) VALUES(?,?,?,?)").bind(pair.id, title, user.tg_id, now()).run();
  } else if ((match = url.pathname.match(/^\/api\/tasks\/(\d+)\/done$/))) {
    await env.DB.prepare("UPDATE tasks SET status='done',completed_by=?,completed_at=? WHERE id=? AND pair_id=? AND status='open'")
      .bind(user.tg_id, now(), Number(match[1]), pair.id).run();
  } else if (url.pathname === "/api/dates") {
    const title = clean(body.title, 120), day = clean(body.day, 10);
    if (!title || !/^\d{4}-\d{2}-\d{2}$/.test(day) || Number.isNaN(Date.parse(`${day}T00:00:00Z`))) return json({ error: "Проверьте название и дату" }, 400);
    await env.DB.prepare("INSERT INTO dates(pair_id,title,day,recurs,created_at) VALUES(?,?,?,1,?)").bind(pair.id, title, day, now()).run();
  } else if (url.pathname === "/api/memories") {
    const text = clean(body.body, 2000);
    if (!text) return json({ error: "Запишите воспоминание" }, 400);
    await env.DB.prepare("INSERT INTO memories(pair_id,author_id,body,day,created_at) VALUES(?,?,?,?,?)").bind(pair.id, user.tg_id, text, today(), now()).run();
  } else if (url.pathname === "/api/wishes") {
    const text = clean(body.body, 300);
    if (!text) return json({ error: "Введите желание" }, 400);
    await env.DB.prepare("INSERT INTO wishes(pair_id,owner_id,body,created_at) VALUES(?,?,?,?)").bind(pair.id, user.tg_id, text, now()).run();
  } else if ((match = url.pathname.match(/^\/api\/wishes\/(\d+)\/done$/))) {
    await env.DB.prepare("UPDATE wishes SET done=1 WHERE id=? AND pair_id=? AND done=0").bind(Number(match[1]), pair.id).run();
  } else if (url.pathname === "/api/daily/done") {
    const daily = await dailyFor(env, pair.id);
    if (daily.done) return json({ error: "Сегодняшний ритуал уже отмечен" }, 400);
    const previous = user.last_activity ? Math.floor((Date.parse(today()) - Date.parse(user.last_activity)) / 86400000) : null;
    const streak = previous === 1 ? user.streak + 1 : 1;
    const completed = await env.DB.prepare("UPDATE daily_rolls SET done_by=?,done_at=? WHERE pair_id=? AND day=? AND done_by IS NULL")
      .bind(user.tg_id, now(), pair.id, daily.day).run();
    if (!completed.meta.changes) return json({ error: "Сегодняшний ритуал уже отмечен" }, 400);
    await env.DB.batch([
      env.DB.prepare("UPDATE users SET points=points+10,streak=?,best_streak=MAX(best_streak,?),last_activity=?,updated_at=? WHERE tg_id=?").bind(streak, streak, daily.day, now(), user.tg_id),
      env.DB.prepare("UPDATE pairs SET together_pts=together_pts+10,updated_at=? WHERE id=?").bind(now(), pair.id)
    ]);
  } else return json({ error: "Раздел не найден" }, 404);
  return json(await state(env, user));
}

async function telegram(env, method, payload) {
  const response = await fetch(`https://api.telegram.org/bot${env.BOT_TOKEN}/${method}`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload)
  });
  const result = await response.json();
  if (!result.ok) throw new Error(result.description || "Telegram API error");
  return result.result;
}

async function openApp(env, chatId, origin, text) {
  return telegram(env, "sendMessage", {
    chat_id: chatId, text,
    reply_markup: { inline_keyboard: [[{ text: "Открыть наше пространство", web_app: { url: `${origin}/app.html` } }]] }
  });
}

async function webhook(request, env, url) {
  if (request.headers.get("x-telegram-bot-api-secret-token") !== env.WEBHOOK_SECRET) return new Response("Forbidden", { status: 403 });
  const update = await request.json();
  const message = update.message;
  if (!message?.text || message.chat?.type !== "private") return json({ ok: true });
  const user = await ensureUser(env, message.from);
  const code = message.text.startsWith("/start ") ? message.text.slice(7).trim() : "";
  if (code) {
    const joined = await joinPair(env, user, code);
    await openApp(env, message.chat.id, url.origin, joined ? "Готово — теперь у вас одно пространство на двоих." : "Это приглашение недоступно. Проверьте код у партнёра.");
  } else {
    await openApp(env, message.chat.id, url.origin, "Ваши планы, воспоминания и маленькие радости — в одном уютном месте.");
  }
  return json({ ok: true });
}

async function ensureSchema(env) {
  const statements = [
    `CREATE TABLE IF NOT EXISTS pairs (id INTEGER PRIMARY KEY AUTOINCREMENT,code TEXT NOT NULL UNIQUE,name1 TEXT NOT NULL,name2 TEXT NOT NULL DEFAULT '',user_a INTEGER NOT NULL,user_b INTEGER NOT NULL DEFAULT 0,started_at TEXT NOT NULL,together_pts INTEGER NOT NULL DEFAULT 0,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL)`,
    `CREATE TABLE IF NOT EXISTS users (tg_id INTEGER PRIMARY KEY,username TEXT,display_name TEXT NOT NULL DEFAULT '',role TEXT NOT NULL DEFAULT 'a',pair_id INTEGER REFERENCES pairs(id) ON DELETE SET NULL,points INTEGER NOT NULL DEFAULT 0,streak INTEGER NOT NULL DEFAULT 0,last_activity TEXT,best_streak INTEGER NOT NULL DEFAULT 0,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL)`,
    `CREATE TABLE IF NOT EXISTS tasks (id INTEGER PRIMARY KEY AUTOINCREMENT,pair_id INTEGER NOT NULL REFERENCES pairs(id) ON DELETE CASCADE,title TEXT NOT NULL,status TEXT NOT NULL DEFAULT 'open',created_by INTEGER NOT NULL,created_at INTEGER NOT NULL,completed_by INTEGER,completed_at INTEGER)`,
    `CREATE TABLE IF NOT EXISTS dates (id INTEGER PRIMARY KEY AUTOINCREMENT,pair_id INTEGER NOT NULL REFERENCES pairs(id) ON DELETE CASCADE,title TEXT NOT NULL,day TEXT NOT NULL,recurs INTEGER NOT NULL DEFAULT 1,created_at INTEGER NOT NULL)`,
    `CREATE TABLE IF NOT EXISTS memories (id INTEGER PRIMARY KEY AUTOINCREMENT,pair_id INTEGER NOT NULL REFERENCES pairs(id) ON DELETE CASCADE,author_id INTEGER NOT NULL,body TEXT NOT NULL,day TEXT NOT NULL,created_at INTEGER NOT NULL)`,
    `CREATE TABLE IF NOT EXISTS wishes (id INTEGER PRIMARY KEY AUTOINCREMENT,pair_id INTEGER NOT NULL REFERENCES pairs(id) ON DELETE CASCADE,owner_id INTEGER NOT NULL,body TEXT NOT NULL,done INTEGER NOT NULL DEFAULT 0,created_at INTEGER NOT NULL)`,
    `CREATE TABLE IF NOT EXISTS daily_rolls (pair_id INTEGER NOT NULL REFERENCES pairs(id) ON DELETE CASCADE,day TEXT NOT NULL,daily_value TEXT NOT NULL,done_by INTEGER,done_at INTEGER,PRIMARY KEY (pair_id,day))`,
    `CREATE INDEX IF NOT EXISTS idx_tasks_pair ON tasks(pair_id,status)`,
    `CREATE INDEX IF NOT EXISTS idx_dates_pair ON dates(pair_id,day)`,
    `CREATE INDEX IF NOT EXISTS idx_memories_pair ON memories(pair_id,created_at)`,
    `CREATE INDEX IF NOT EXISTS idx_wishes_pair ON wishes(pair_id,done)`
  ];
  await env.DB.batch(statements.map(sql => env.DB.prepare(sql)));
}

async function setup(request, env, url) {
  if (!env.WEBHOOK_SECRET || request.headers.get("authorization") !== `Bearer ${env.WEBHOOK_SECRET}`) return json({ error: "Forbidden" }, 403);
  await ensureSchema(env);
  const webhookUrl = `${url.origin}/telegram/webhook`;
  await telegram(env, "setWebhook", { url: webhookUrl, secret_token: env.WEBHOOK_SECRET, allowed_updates: ["message"], drop_pending_updates: false });
  await telegram(env, "setMyCommands", { commands: [{ command: "menu", description: "Наше пространство" }, { command: "help", description: "Как работает DuoPlan" }] });
  await telegram(env, "setChatMenuButton", { menu_button: { type: "web_app", text: "DuoPlan", web_app: { url: `${url.origin}/app.html` } } });
  return json({ ok: true, webhook_url: webhookUrl, mini_app_url: `${url.origin}/app.html` });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    try {
      if (url.pathname === "/health") return json({ ok: true, service: "duoplan", database: Boolean(env.DB) });
      if (url.pathname.startsWith("/api/")) return await api(request, env, url);
      if (url.pathname === "/telegram/webhook" && request.method === "POST") return await webhook(request, env, url);
      if (url.pathname === "/setup" && request.method === "POST") return await setup(request, env, url);
      return env.ASSETS.fetch(request);
    } catch (error) {
      console.error(error);
      return json({ error: "Не получилось выполнить запрос. Попробуйте ещё раз." }, 500);
    }
  }
};
