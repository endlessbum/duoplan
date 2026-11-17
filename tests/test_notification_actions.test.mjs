// Кнопки действий в уведомлениях (план duoplan_notification_actions_v2).
//
// Покрывает: паритет ACCENT_HEX ↔ ACCENT_PALETTES, безопасность и размер
// Widget-HTML, одноразовость nonce, ответ на widget_query на всех ветках,
// HMAC-подпись fallback callback_data, fallback sendWidget→sendMessage и
// dp_*-deep-link в Mini App.
//
// Запуск: node --test tests/test_notification_actions.test.mjs
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { deepStrictEqual, equal, match, ok } from "node:assert/strict";
import { test } from "node:test";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const source = readFileSync(join(root, "worker.js"), "utf8");
const appSource = readFileSync(join(root, "public", "app.js"), "utf8");

// Весь блок «кнопки действий» в worker.js идёт подряд: от ACCENT_HEX до
// deliverNotification. Вырезаем его целиком и поднимаем в Function с
// подставными зависимостями — так тестируем реальный код, а не копию.
const BLOCK_START = source.indexOf("const ACCENT_HEX = {");
const BLOCK_END = source.indexOf("async function deliverNotification");
if (BLOCK_START < 0 || BLOCK_END < 0 || BLOCK_END <= BLOCK_START) {
  throw new Error("блок кнопок действий не найден в worker.js");
}
const block = source.slice(BLOCK_START, BLOCK_END);

function extractConst(name) {
  const re = new RegExp(`const ${name} = [\\s\\S]*?;\\n`);
  const found = source.match(re)?.[0];
  if (!found) throw new Error(`${name} не найден`);
  return found;
}
function extractFn(name) {
  let start = source.indexOf(`async function ${name}(`);
  if (start < 0) start = source.indexOf(`function ${name}(`);
  if (start < 0) throw new Error(`${name} не найдена`);
  let depth = 0, end = -1;
  for (let i = source.indexOf("{", start); i < source.length; i++) {
    if (source[i] === "{") depth++;
    else if (source[i] === "}") {
      depth--;
      if (depth === 0) { end = i + 1; break; }
    }
  }
  return source.slice(start, end);
}

const WEBHOOK_SECRET = "test-webhook-secret";
const calls = [];
let dbRouter = () => null;

const env = {
  BOT_TOKEN: "test-token",
  WEBHOOK_SECRET,
  APP_ORIGIN: "https://app.example",
  DB: {
    prepare(sql) {
      return {
        bind(...args) {
          return {
            async first() { return dbRouter("first", sql, args); },
            async run() { return dbRouter("run", sql, args); },
            async all() { return dbRouter("all", sql, args); }
          };
        }
      };
    }
  }
};

// Подменный telegram: записывает вызовы, sendWidget по умолчанию ok.
let telegramImpl = async (e, method, payload) => {
  calls.push({ method, payload });
  if (method === "sendWidget") return { message_id: 777 };
  return { message_id: 778 };
};
let membershipImpl = async () => ({ id: 7 });
let ensureTaskVisibleImpl = async () => ({ id: 1 });

const api = new Function(`telegramImpl`, `membershipImpl`, `ensureTaskVisibleImpl`, `
  "use strict";
  const now = () => Math.floor(Date.now() / 1000);
  ${extractConst("positiveId")};
  const safeEqual = ${extractFn("safeEqual")};
  const hmac = ${extractFn("hmac")};
  const hex = ${extractFn("hex")};
  const validTimeZone = ${extractFn("validTimeZone")};
  const localDay = ${extractFn("localDay")};
  const cycleValidDate = ${extractFn("cycleValidDate")};
  ${extractConst("CYCLE_DATE_RE")};
  const appUrl = ${extractFn("appUrl")};
  const DEFAULT_TZ = ${JSON.stringify((source.match(/const DEFAULT_TZ = "([^"]+)"/) || [])[1] || "Europe/Moscow")};
  const ACCENT_KEYS = ${JSON.stringify((source.match(/const ACCENT_KEYS = (\[[\s\S]*?\]);/) || [])[1] || [])};
  const HttpError = class HttpError extends Error {
    constructor(status, message, code) { super(message); this.status = status; this.code = code; }
  };
  async function telegram(e, method, payload) { return telegramImpl(e, method, payload); }
  async function membership(...args) { return membershipImpl(...args); }
  async function ensureTaskVisible(...args) { return ensureTaskVisibleImpl(...args); }
  ${block}
  return { buildActionWidgetHtml, createActionToken, consumeActionToken, callbackPayloadFor,
    handleNotificationWidgetQuery, handleNotificationCallback, sendActionNotification,
    executeTaskDone, executeHealthMedStatus, ACCENT_HEX, syncWidgetAccents, runActionOperation };
`)( (...args) => telegramImpl(...args), (...args) => membershipImpl(...args), (...args) => ensureTaskVisibleImpl(...args) );

const {
  buildActionWidgetHtml, createActionToken, consumeActionToken, callbackPayloadFor,
  handleNotificationWidgetQuery, handleNotificationCallback, sendActionNotification,
  executeTaskDone, executeHealthMedStatus, ACCENT_HEX, syncWidgetAccents, runActionOperation
} = api;

function reset() {
  calls.length = 0;
  dbRouter = () => null;
  membershipImpl = async () => ({ id: 7 });
  ensureTaskVisibleImpl = async () => ({ id: 1 });
  telegramImpl = async (e, method, payload) => {
    calls.push({ method, payload });
    if (method === "sendWidget") return { message_id: 777 };
    return { message_id: 778 };
  };
}

// ---------- ACCENT_HEX ↔ ACCENT_PALETTES ----------

test("ACCENT_HEX зеркалит ACCENT_PALETTES из app.js", () => {
  const palettes = appSource.match(/const ACCENT_PALETTES = \{[\s\S]*?\};/)?.[0];
  ok(palettes, "ACCENT_PALETTES не найден");
  const pairs = [...palettes.matchAll(/(\w+):\s*\{\s*light:\s*"(#[0-9a-fA-F]{6})",\s*dark:\s*"(#[0-9a-fA-F]{6})"\s*\}/g)];
  ok(pairs.length >= 5, "палитры не распарсились");
  for (const [, key, light, dark] of pairs) {
    deepStrictEqual(ACCENT_HEX[key], { light, dark }, `расхождение акцента ${key}`);
  }
});

// ---------- Widget HTML ----------

test("Widget HTML: компактный, без форм и сети, с request/chatData", () => {
  const html = buildActionWidgetHtml();
  ok(Buffer.byteLength(html, "utf8") < 32768, `HTML ${Buffer.byteLength(html, "utf8")} байт > 32 КБ`);
  ok(!/<(input|select|textarea|form)\b/i.test(html), "в Widget нельзя input/select/form");
  match(html, /TelegramWidget/);
  match(html, /\.request\(/);
  match(html, /chatData/);
  match(html, /colorScheme/);
  // JSON.stringify(ACCENT_HEX) уже внутри шаблона — инъекции нет.
  ok(html.includes('"berry"'), "палитра не встроена");
});

// ---------- nonce ----------

test("createActionToken пишет строку с TTL, consume атомарен", async () => {
  reset();
  const inserts = [];
  dbRouter = (kind, sql, args) => {
    if (kind === "run" && sql.includes("INSERT INTO telegram_action_tokens")) { inserts.push(args); return { meta: { changes: 1 } }; }
    return null;
  };
  const token = await createActionToken(env, { tgId: 42, actionType: "task_done", refId: 5 });
  ok(/^[0-9a-f]{32}$/.test(token), "token — 16 байт hex");
  equal(inserts.length, 1);
  equal(inserts[0][1], 42);
  equal(inserts[0][2], "task_done");
  ok(inserts[0][8] > inserts[0][7], "expires_at > created_at");
});

test("consumeActionToken: срабатывает только на свежий непотреблённый nonce", async () => {
  reset();
  dbRouter = (kind, sql) => {
    if (kind === "run" && sql.includes("UPDATE telegram_action_tokens SET consumed_at")) return { meta: { changes: 1 } };
    return null;
  };
  ok(await consumeActionToken(env, "abc", 7));
  dbRouter = () => ({ meta: { changes: 0 } });
  ok(!(await consumeActionToken(env, "abc", 7)), "повторный/чужой nonce не потребляется");
});

// ---------- widget_query ----------

test("widget_query: валидный nonce выполняет действие и отвечает", async () => {
  reset();
  const tokenRow = { token: "tok1", tg_id: 42, action_type: "task_done", ref_id: 9, action_date: null, status: null, group_id: "g1" };
  dbRouter = (kind, sql, args) => {
    if (kind === "first" && sql.includes("FROM telegram_action_tokens")) return tokenRow;
    if (kind === "first" && sql.includes("FROM users WHERE tg_id=?")) return { tg_id: 42 };
    if (kind === "run" && sql.includes("SET consumed_at=?") && sql.includes("token=?")) return { meta: { changes: 1 } };
    if (kind === "run" && sql.includes("WHERE group_id=?")) return { meta: { changes: 2 } };
    if (kind === "run" && sql.includes("UPDATE tasks SET status='done'")) return { meta: { changes: 1 } };
    if (kind === "first" && sql.includes("SELECT status FROM tasks")) return null;
    if (kind === "first" && sql.includes("SELECT chat_data FROM telegram_notification_widgets")) {
      return { chat_data: JSON.stringify({ a: "berry", acts: [["tok1", "✅ Выполнено"]] }) };
    }
    return null;
  };
  await handleNotificationWidgetQuery(env, {
    id: "q1", data: "tok1",
    from: { id: 42 }, chat: { id: 42, type: "private" }, message_id: 500
  });
  const answer = calls.find(c => c.method === "answerWidgetQuery");
  ok(answer, "answerWidgetQuery вызван");
  equal(answer.payload.data, "План отмечен выполненным");
  const edit = calls.find(c => c.method === "editMessageWidgetData");
  ok(edit, "chat_data обновлён");
  const state = JSON.parse(edit.payload.chat_data);
  ok(state.d, "виден подтверждённый результат");
});

test("widget_query: просроченный/чужой nonce — безопасный ответ без действия", async () => {
  reset();
  dbRouter = () => ({ meta: { changes: 0 } });
  await handleNotificationWidgetQuery(env, {
    id: "q2", data: "forged", from: { id: 42 }, chat: { id: 42, type: "private" }, message_id: 501
  });
  const answer = calls.find(c => c.method === "answerWidgetQuery");
  ok(answer);
  match(answer.payload.data, /устарела|недоступн/i);
  ok(!calls.some(c => c.method === "editMessageWidgetData"), "нет правки при отказе");
});

test("widget_query: сбой операции возвращает nonce — кнопку можно повторить", async () => {
  reset();
  const tokenRow = { token: "tok2", tg_id: 42, action_type: "task_done", ref_id: 9, action_date: null, status: null, group_id: "g2" };
  const restored = [];
  dbRouter = (kind, sql, args) => {
    if (kind === "first" && sql.includes("FROM telegram_action_tokens")) return tokenRow;
    if (kind === "run" && sql.includes("consumed_at IS NULL")) return { meta: { changes: 1 } };
    if (kind === "run" && sql.includes("SET consumed_at=NULL")) { restored.push(args); return { meta: { changes: 1 } }; }
    if (kind === "first" && sql.includes("FROM users WHERE tg_id=?")) throw new Error("d1 boom");
    return null;
  };
  await handleNotificationWidgetQuery(env, {
    id: "q9", data: "tok2", from: { id: 42 }, chat: { id: 42, type: "private" }, message_id: 700
  });
  const answer = calls.find(c => c.method === "answerWidgetQuery");
  ok(answer);
  match(answer.payload.data, /Не удалось/);
  equal(restored.length, 1, "consumed_at сброшен для повтора");
  equal(restored[0][0], "tok2");
  equal(restored[0][1], 42);
});

test("widget_query: не-private чат и битый контекст отклоняются", async () => {
  reset();
  await handleNotificationWidgetQuery(env, {
    id: "q3", data: "tok", from: { id: 42 }, chat: { id: -100, type: "supergroup" }, message_id: 1
  });
  const answer = calls.find(c => c.method === "answerWidgetQuery");
  ok(answer);
  equal(calls.filter(c => c.method !== "answerWidgetQuery").length, 0, "только ответ, без действий");
});

// ---------- health_med через виджет ----------

test("executeHealthMedStatus: taken пишет лог, конфликт не перезаписывает", async () => {
  reset();
  const today = new Date().toISOString().slice(0, 10);
  const day = new Date(Date.now() - 86400000).toISOString().slice(0, 10); // вчера — всегда валидно
  dbRouter = (kind, sql, args) => {
    if (kind === "first" && sql.includes("FROM users WHERE tg_id=?")) return { tg_id: 42, timezone: "UTC" };
    if (kind === "first" && sql.includes("FROM health_meds")) return { id: 3, status: "active", start_date: null, end_date: null };
    if (kind === "first" && sql.includes("FROM health_med_logs")) return null;
    if (kind === "run" && sql.includes("INSERT INTO health_med_logs")) return { meta: { changes: 1 } };
    return null;
  };
  equal(await executeHealthMedStatus(env, 42, 3, day, "taken"), "done");
  dbRouter = (kind, sql) => {
    if (kind === "first" && sql.includes("FROM users")) return { tg_id: 42, timezone: "UTC" };
    if (kind === "first" && sql.includes("FROM health_meds")) return { id: 3, status: "active", start_date: null, end_date: null };
    if (kind === "first" && sql.includes("FROM health_med_logs")) return { status: "skipped" };
    return null;
  };
  equal(await executeHealthMedStatus(env, 42, 3, day, "taken"), "conflict", "другой итог не перезаписывается");
  equal(await executeHealthMedStatus(env, 42, 3, day, "skipped"), "already");
});

// ---------- callback fallback ----------

test("callbackPayloadFor + handleNotificationCallback: подпись проверяется", async () => {
  reset();
  dbRouter = (kind, sql, args) => {
    if (kind === "first" && sql.includes("FROM users WHERE tg_id=?")) return { tg_id: 42 };
    if (kind === "run" && sql.includes("UPDATE tasks SET status='done'")) return { meta: { changes: 1 } };
    if (kind === "first" && sql.includes("SELECT status FROM tasks")) return null;
    return null;
  };
  const data = await callbackPayloadFor(env, 42, { type: "task_done", refId: 9 });
  ok(/^dp1\|td\|9\|[0-9a-f]{24}$/.test(data), `формат callback_data: ${data}`);
  ok(data.length <= 64, "влезает в лимит 64 байта");
  await handleNotificationCallback(env, {
    id: "cb1", data, from: { id: 42 },
    message: { message_id: 600, chat: { id: 42, type: "private" }, from: { id: 1, is_bot: true } }
  });
  const answer = calls.find(c => c.method === "answerCallbackQuery");
  ok(answer);
  equal(answer.payload.text, "План отмечен выполненным");
  ok(calls.some(c => c.method === "editMessageReplyMarkup"), "клавиатура убрана");
});

test("callback_query: подделанная подпись и чужой tg_id отклоняются", async () => {
  reset();
  const data = await callbackPayloadFor(env, 42, { type: "task_done", refId: 9 });
  // Тот же payload, но клик от другого пользователя.
  await handleNotificationCallback(env, {
    id: "cb2", data, from: { id: 43 },
    message: { message_id: 601, chat: { id: 43, type: "private" }, from: { id: 1, is_bot: true } }
  });
  let answer = calls.find(c => c.method === "answerCallbackQuery");
  match(answer.payload.text, /устарела/i);
  // Подпись от другого payload.
  const forged = data.slice(0, -24) + "0".repeat(24);
  calls.length = 0;
  await handleNotificationCallback(env, {
    id: "cb3", data: forged, from: { id: 42 },
    message: { message_id: 602, chat: { id: 42, type: "private" }, from: { id: 1, is_bot: true } }
  });
  answer = calls.find(c => c.method === "answerCallbackQuery");
  match(answer.payload.text, /устарела/i);
});

// ---------- deliverNotification fallback ----------

test("sendActionNotification: отказ sendWidget → нативная клавиатура", async () => {
  reset();
  telegramImpl = async (e, method, payload) => {
    calls.push({ method, payload });
    if (method === "sendWidget") {
      const err = new Error("Bad Request: widget not supported");
      err.isTelegramApi = true;
      throw err;
    }
    return { message_id: 778 };
  };
  dbRouter = (kind, sql, args) => {
    if (kind === "first" && sql.includes("SELECT accent_color")) return { accent_color: "ocean" };
    if (kind === "run" && sql.includes("INSERT INTO telegram_action_tokens")) return { meta: { changes: 1 } };
    return null;
  };
  await sendActionNotification(env, 42, "kind", "Текст", {
    mode: "direct_action",
    buttons: [{ text: "✅ Выполнено", action: { type: "task_done", refId: 9 } }]
  }, { origin: "" });
  const msg = calls.find(c => c.method === "sendMessage");
  ok(msg, "отправлен обычный sendMessage");
  const kb = msg.payload.reply_markup.inline_keyboard.flat();
  ok(kb.every(b => b.callback_data && !b.web_app), "только callback-кнопки, без web_app");
  match(kb[0].callback_data, /^dp1\|td\|9\|/);
});

test("sendActionNotification: сетевая ошибка НЕ запускает fallback", async () => {
  reset();
  telegramImpl = async (e, method, payload) => {
    calls.push({ method, payload });
    throw new Error("network down"); // без isTelegramApi — повтор недопустим
  };
  dbRouter = (kind, sql) => {
    if (kind === "first" && sql.includes("SELECT accent_color")) return { accent_color: "berry" };
    if (kind === "run" && sql.includes("INSERT INTO telegram_action_tokens")) return { meta: { changes: 1 } };
    return null;
  };
  let threw = false;
  try {
    await sendActionNotification(env, 42, "kind", "Текст", {
      mode: "direct_action",
      buttons: [{ text: "✅", action: { type: "task_done", refId: 9 } }]
    }, { origin: "" });
  } catch { threw = true; }
  ok(threw, "ошибка проброшена — sendMessage не дублирует");
  ok(!calls.some(c => c.method === "sendMessage"), "fallback не вызывался");
});

// ---------- navigation / form_action ----------

test("navigation: одна web_app-кнопка с dp_*-ссылкой без персональных данных", async () => {
  reset();
  dbRouter = (kind, sql) => {
    if (kind === "first" && sql.includes("SELECT accent_color")) return null;
    return null;
  };
  await sendActionNotification(env, 42, "kind", "Текст", {
    mode: "navigation", buttonText: "📝 Записать день", target: { type: "cycle_diary", day: "2026-11-16" }
  }, { origin: "https://worker.example" });
  const msg = calls.find(c => c.method === "sendMessage");
  const btn = msg.payload.reply_markup.inline_keyboard[0][0];
  ok(btn.web_app, "web_app-кнопка");
  const url = new URL(btn.web_app.url);
  equal(url.searchParams.get("dp_target"), "cycle_diary");
  equal(url.searchParams.get("dp_day"), "2026-11-16");
  ok(!url.searchParams.get("dp_name") && !btn.web_app.url.includes("name"), "нет персональных данных в ссылке");
});

// ---------- accent sync ----------

test("syncWidgetAccents: chat_data обновляется только у активных", async () => {
  reset();
  const edits = [];
  telegramImpl = async (e, method, payload) => {
    calls.push({ method, payload });
    if (method === "editMessageWidgetData") { edits.push(payload); return {}; }
    return {};
  };
  dbRouter = (kind, sql, args) => {
    if (kind === "all" && sql.includes("telegram_notification_widgets")) {
      return { results: [
        { chat_id: 42, message_id: 1, chat_data: JSON.stringify({ a: "berry", acts: [["t", "x"]] }) },
        { chat_id: 42, message_id: 2, chat_data: "{\"a\":\"berry\"}" }
      ] };
    }
    return null;
  };
  await syncWidgetAccents(env, 42, "violet");
  equal(edits.length, 2);
  for (const e of edits) equal(JSON.parse(e.chat_data).a, "violet");
});

// ---------- deep link в app.js ----------

test("app.js парсит dp_*-ссылки уведомлений", () => {
  match(appSource, /applyDeepLink/);
  match(appSource, /dp_target/);
  match(appSource, /cycle_diary/);
  match(appSource, /floSelectedDate = validDay/);
});

test("webhook принимает widget_query и callback_query, allowed_updates расширен", () => {
  match(source, /update\?\.widget_query/);
  match(source, /update\?\.callback_query/);
  match(source, /allowed_updates:\s*\["message",\s*"widget_query",\s*"callback_query"\]/);
});


// ---------- health_med: widget end-to-end ----------

const HEALTH_TODAY = new Date().toISOString().slice(0, 10);
const HEALTH_YESTERDAY = new Date(Date.now() - 86400000).toISOString().slice(0, 10);

function healthDbRouter(overrides = {}) {
  return (kind, sql, args) => {
    if (kind === "first" && sql.includes("FROM users WHERE tg_id=?")) return { tg_id: 42, timezone: "UTC" };
    if (kind === "first" && sql.includes("FROM health_meds")) {
      return overrides.med ?? { id: 3, status: "active", start_date: null, end_date: null };
    }
    if (kind === "first" && sql.includes("FROM health_med_logs")) return overrides.existing ?? null;
    if (kind === "run" && sql.includes("INSERT INTO health_med_logs")) return { meta: { changes: 1 } };
    if (kind === "run" && sql.includes("WHERE group_id=?")) return { meta: { changes: 2 } };
    if (kind === "first" && sql.includes("SELECT chat_data FROM telegram_notification_widgets")) {
      return { chat_data: JSON.stringify({ a: "berry", acts: [["tok", "x"], ["tok2", "y"]] }) };
    }
    return null;
  };
}

test("widget_query health_med «Принят»: пишет лог taken за дату уведомления", async () => {
  reset();
  const inserts = [];
  const base = healthDbRouter();
  dbRouter = (kind, sql, args) => {
    if (kind === "first" && sql.includes("FROM telegram_action_tokens")) {
      return { token: "htok", tg_id: 42, action_type: "health_med", ref_id: 3, action_date: HEALTH_YESTERDAY, status: "taken", group_id: "hg1" };
    }
    if (kind === "run" && sql.includes("consumed_at IS NULL")) return { meta: { changes: 1 } };
    if (kind === "run" && sql.includes("INSERT INTO health_med_logs")) { inserts.push(args); return { meta: { changes: 1 } }; }
    return base(kind, sql, args);
  };
  await handleNotificationWidgetQuery(env, {
    id: "qh1", data: "htok", from: { id: 42 }, chat: { id: 42, type: "private" }, message_id: 800
  });
  const answer = calls.find(c => c.method === "answerWidgetQuery");
  equal(answer.payload.data, "Принято");
  equal(inserts.length, 1);
  equal(inserts[0][2], HEALTH_YESTERDAY, "лог за дату уведомления, не текущую");
  equal(inserts[0][3], "taken");
});

test("widget_query health_med «Пропущен»: статус skipped и свой текст", async () => {
  reset();
  const inserts = [];
  const base = healthDbRouter();
  dbRouter = (kind, sql, args) => {
    if (kind === "first" && sql.includes("FROM telegram_action_tokens")) {
      return { token: "stok", tg_id: 42, action_type: "health_med", ref_id: 3, action_date: HEALTH_YESTERDAY, status: "skipped", group_id: "hg2" };
    }
    if (kind === "run" && sql.includes("consumed_at IS NULL")) return { meta: { changes: 1 } };
    if (kind === "run" && sql.includes("INSERT INTO health_med_logs")) { inserts.push(args); return { meta: { changes: 1 } }; }
    return base(kind, sql, args);
  };
  await handleNotificationWidgetQuery(env, {
    id: "qh2", data: "stok", from: { id: 42 }, chat: { id: 42, type: "private" }, message_id: 801
  });
  const answer = calls.find(c => c.method === "answerWidgetQuery");
  equal(answer.payload.data, "Отмечено как пропущенное");
  equal(inserts[0][3], "skipped");
});

test("widget_query health_med: соседняя кнопка группы после выбора — «устарела»", async () => {
  reset();
  dbRouter = (kind, sql) => {
    if (kind === "first" && sql.includes("FROM telegram_action_tokens")) {
      return { token: "stok2", tg_id: 42, action_type: "health_med", ref_id: 3, action_date: HEALTH_YESTERDAY, status: "skipped", group_id: "hg1" };
    }
    if (kind === "run") return { meta: { changes: 0 } };
    return null;
  };
  await handleNotificationWidgetQuery(env, {
    id: "qh3", data: "stok2", from: { id: 42 }, chat: { id: 42, type: "private" }, message_id: 802
  });
  const answer = calls.find(c => c.method === "answerWidgetQuery");
  match(answer.payload.data, /устарела|недоступн/i);
});

// ---------- executeHealthMedStatus граничные случаи ----------

test("executeHealthMedStatus: чужой/неактивный препарат → unavailable", async () => {
  reset();
  const base = healthDbRouter();
  for (const med of [null, { id: 3, status: "paused", start_date: null, end_date: null }, { id: 3, status: "completed", start_date: null, end_date: null }]) {
    dbRouter = (kind, sql, args) => {
      if (kind === "first" && sql.includes("FROM health_meds")) return med;
      return base(kind, sql, args);
    };
    equal(await executeHealthMedStatus(env, 42, 3, HEALTH_YESTERDAY, "taken"), "unavailable");
  }
});

test("executeHealthMedStatus: будущая/битая дата и плохой статус → unavailable", async () => {
  reset();
  dbRouter = healthDbRouter();
  const future = new Date(Date.now() + 3 * 86400000).toISOString().slice(0, 10);
  equal(await executeHealthMedStatus(env, 42, 3, future, "taken"), "unavailable", "будущая дата");
  equal(await executeHealthMedStatus(env, 42, 3, "2026-13-40", "taken"), "unavailable", "несуществующая дата");
  equal(await executeHealthMedStatus(env, 42, 3, HEALTH_YESTERDAY, "bogus"), "unavailable", "неизвестный статус");
});

test("executeHealthMedStatus: дата вне курса → unavailable, внутри → done", async () => {
  reset();
  dbRouter = healthDbRouter({ med: { id: 3, status: "active", start_date: "2026-01-10", end_date: "2026-01-20" } });
  equal(await executeHealthMedStatus(env, 42, 3, "2026-01-05", "taken"), "unavailable", "до старта курса");
  equal(await executeHealthMedStatus(env, 42, 3, "2026-01-25", "taken"), "unavailable", "после конца курса");
  equal(await executeHealthMedStatus(env, 42, 3, "2026-01-15", "taken"), "done", "внутри курса");
});

// ---------- executeTaskDone граничные случаи ----------

test("executeTaskDone: нет пользователя/пары → unavailable; повтор → already", async () => {
  reset();
  dbRouter = () => null;
  equal(await executeTaskDone(env, 42, 9), "unavailable", "нет пользователя");

  reset();
  dbRouter = (kind, sql) => {
    if (kind === "first" && sql.includes("FROM users WHERE tg_id=?")) return { tg_id: 42 };
    return null;
  };
  membershipImpl = async () => null;
  equal(await executeTaskDone(env, 42, 9), "unavailable", "нет пары");

  reset();
  dbRouter = (kind, sql) => {
    if (kind === "first" && sql.includes("FROM users WHERE tg_id=?")) return { tg_id: 42 };
    if (kind === "run" && sql.includes("UPDATE tasks SET status='done'")) return { meta: { changes: 0 } };
    if (kind === "first" && sql.includes("SELECT status FROM tasks")) return { status: "done" };
    return null;
  };
  equal(await executeTaskDone(env, 42, 9), "already", "уже выполнено");
});

test("executeTaskDone: ошибка видимости (404 приватности) → unavailable", async () => {
  reset();
  dbRouter = (kind, sql) => {
    if (kind === "first" && sql.includes("FROM users WHERE tg_id=?")) return { tg_id: 42 };
    return null;
  };
  ensureTaskVisibleImpl = async () => { throw new Error("404 NOT_FOUND"); };
  equal(await executeTaskDone(env, 42, 9), "unavailable");
});

test("runActionOperation: невалидный refId и неизвестный тип → unavailable", async () => {
  reset();
  equal(await runActionOperation(env, 42, "task_done", 0, null, null), "unavailable");
  equal(await runActionOperation(env, 42, "task_done", -5, null, null), "unavailable");
  equal(await runActionOperation(env, 42, "unknown_op", 5, null, null), "unavailable");
  equal(await runActionOperation(env, 42, "health_med", "abc", HEALTH_YESTERDAY, "taken"), "unavailable");
});

// ---------- health_med: callback fallback ----------

test("callback health_med «hs»: skipped проходит полный путь с подписью", async () => {
  reset();
  const inserts = [];
  const base = healthDbRouter();
  dbRouter = (kind, sql, args) => {
    if (kind === "run" && sql.includes("INSERT INTO health_med_logs")) { inserts.push(args); return { meta: { changes: 1 } }; }
    return base(kind, sql, args);
  };
  const data = await callbackPayloadFor(env, 42, {
    type: "health_med", refId: 3, actionDate: HEALTH_YESTERDAY, status: "skipped"
  });
  match(data, /^dp1\|hs\|3\|\d{8}\|[0-9a-f]{24}$/);
  ok(data.length <= 64);
  await handleNotificationCallback(env, {
    id: "cbh1", data, from: { id: 42 },
    message: { message_id: 900, chat: { id: 42, type: "private" }, from: { id: 1, is_bot: true } }
  });
  const answer = calls.find(c => c.method === "answerCallbackQuery");
  equal(answer.payload.text, "Отмечено как пропущенное");
  equal(inserts.length, 1);
  equal(inserts[0][3], "skipped");
  ok(calls.some(c => c.method === "editMessageReplyMarkup"), "клавиатура убрана");
});

test("callback health_med: подмена даты в payload ломает подпись", async () => {
  reset();
  const data = await callbackPayloadFor(env, 42, {
    type: "health_med", refId: 3, actionDate: "2026-01-01", status: "taken"
  });
  const parts = data.split("|");
  const forged = `dp1|ht|3|20990101|${parts[4]}`;
  await handleNotificationCallback(env, {
    id: "cbh2", data: forged, from: { id: 42 },
    message: { message_id: 901, chat: { id: 42, type: "private" }, from: { id: 1, is_bot: true } }
  });
  const answer = calls.find(c => c.method === "answerCallbackQuery");
  match(answer.payload.text, /устарела/i);
});

test("callback task_done: «already» тоже убирает клавиатуру", async () => {
  reset();
  dbRouter = (kind, sql) => {
    if (kind === "first" && sql.includes("FROM users WHERE tg_id=?")) return { tg_id: 42 };
    if (kind === "run" && sql.includes("UPDATE tasks SET status='done'")) return { meta: { changes: 0 } };
    if (kind === "first" && sql.includes("SELECT status FROM tasks")) return { status: "done" };
    return null;
  };
  const data = await callbackPayloadFor(env, 42, { type: "task_done", refId: 9 });
  await handleNotificationCallback(env, {
    id: "cbt2", data, from: { id: 42 },
    message: { message_id: 902, chat: { id: 42, type: "private" }, from: { id: 1, is_bot: true } }
  });
  const answer = calls.find(c => c.method === "answerCallbackQuery");
  equal(answer.payload.text, "Уже выполнено");
  ok(calls.some(c => c.method === "editMessageReplyMarkup"));
});

// ---------- deliverNotification: маршрутизация action ----------

test("deliverNotification: action → sendActionNotification, без action → openApp", () => {
  const body = source.slice(source.indexOf("async function deliverNotification"));
  const fn = body.slice(0, body.indexOf("\n}\n") + 3);
  match(fn, /if \(action\) \{\s*await sendActionNotification/);
  match(fn, /await openApp\(env, member, urlCtx, text\)/);
});
