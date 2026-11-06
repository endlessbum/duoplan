#!/usr/bin/env node
// Локальный стенд DuoPlan: wrangler dev (worker + локальная D1) + прокси,
// который подменяет window.Telegram.WebApp стабом с подписанным initData.
// Использование:
//   node scripts/dev-stand.mjs                 — поднять стенд
//   node scripts/dev-stand.mjs --no-migrate    — без применения миграций
//   node scripts/dev-stand.mjs initdata 2      — напечатать initData юзера 2 (для curl)
// Открывать: http://127.0.0.1:8790/app?u=1  (и ?u=2 — в другом браузере/профиле)
import http from "node:http";
import { spawn, spawnSync } from "node:child_process";
import { createHmac } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const UP_HOST = "127.0.0.1";
const UP_PORT = Number(process.env.STAND_UPSTREAM_PORT || 8788);
const PORT = Number(process.env.STAND_PORT || 8790);
const SHELL = process.platform === "win32";

// ---------- секреты ----------
const devVarsPath = join(root, ".dev.vars");
function loadDevVars() {
  const out = {};
  if (!existsSync(devVarsPath)) return out;
  for (const line of readFileSync(devVarsPath, "utf8").split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m) out[m[1]] = m[2];
  }
  return out;
}
let vars = loadDevVars();
if (!vars.BOT_TOKEN) {
  writeFileSync(devVarsPath, [
    "BOT_TOKEN=123456:duoplan-dev-stand",
    "WEBHOOK_SECRET=dev-webhook-secret",
    "SETUP_TOKEN=dev-setup-token",
    ""
  ].join("\n"));
  vars = loadDevVars();
}
const TOKEN = vars.BOT_TOKEN;

// ---------- initData (официальная схема HMAC, как в tests/test_auth_init_data.test.mjs) ----------
function signInitData(tgId, firstName, token = TOKEN) {
  const fields = {
    auth_date: String(Math.floor(Date.now() / 1000)),
    user: JSON.stringify({ id: tgId, first_name: firstName, last_name: "Dev", username: `dev_u${tgId}`, language_code: "ru" })
  };
  const secret = createHmac("sha256", "WebAppData").update(token).digest();
  const pairs = Object.entries(fields).map(([k, v]) => [k, String(v)]);
  const check = pairs
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${k}=${v}`)
    .join("\n");
  const hash = createHmac("sha256", secret).update(check).digest("hex");
  return new URLSearchParams([...pairs, ["hash", hash]]).toString();
}

function userFor(param) {
  const n = Math.floor(Number(param));
  const id = Number.isFinite(n) && n > 0 ? 100000 + n : 100001;
  return { id, name: `Dev${id}` };
}

// ---------- стаб Telegram.WebApp ----------
function telegramStub(initData) {
  return `<script>(function(){
if (window.__duoplanStub) return; window.__duoplanStub = 1;
var initData = ${JSON.stringify(initData)};
var handlers = {};
window.Telegram = { WebApp: {
  initData: initData, initDataUnsafe: {}, version: "8.0",
  platform: "tdesktop", colorScheme: "dark",
  themeParams: {bg_color:"#17212b",text_color:"#ffffff",hint_color:"#708499",link_color:"#6ab2f2",button_color:"#5288c1",button_text_color:"#ffffff",secondary_bg_color:"#232e3c"},
  isExpanded: true, isFullscreen: false, isReady: false,
  viewportStableHeight: 0, viewportHeight: 0,
  safeAreaInset: {top:0,bottom:0,left:0,right:0},
  contentSafeAreaInset: {top:0,bottom:0,left:0,right:0},
  ready:function(){this.isReady=true;}, expand:function(){},
  close:function(){}, disableVerticalSwipes:function(){}, enableVerticalSwipes:function(){},
  requestFullscreen:function(){}, exitFullscreen:function(){},
  setHeaderColor:function(){}, setBackgroundColor:function(){}, setBottomBarColor:function(){},
  onEvent:function(n,f){(handlers[n]=handlers[n]||[]).push(f);},
  offEvent:function(n,f){var a=handlers[n];if(a){var i=a.indexOf(f);if(i>=0)a.splice(i,1);}},
  sendData:function(){}, openLink:function(){}, openTelegramLink:function(){},
  switchInlineQuery:function(){}, requestWriteAccess:function(cb){cb&&cb(true);},
  requestContact:function(cb){cb&&cb(false);},
  addToHomeScreen:function(){}, checkHomeScreenStatus:function(cb){cb&&cb({status:"unknown"});},
  BackButton:{isVisible:false,show:function(){this.isVisible=true;},hide:function(){this.isVisible=false;},onClick:function(){},offClick:function(){}},
  SettingsButton:{isVisible:false,show:function(){},hide:function(){},onClick:function(){},offClick:function(){}},
  HapticFeedback:{impactOccurred:function(){},notificationOccurred:function(){},selectionChanged:function(){}},
  isVersionAtLeast:function(){return true;}
}};})();</script>`;
}

// ---------- проксирование ----------
function fetchUpstream(req, body) {
  return new Promise((resolve, reject) => {
    const up = http.request({
      host: UP_HOST, port: UP_PORT, path: req.url, method: req.method,
      headers: { ...req.headers, host: `${UP_HOST}:${UP_PORT}` }
    }, resolve);
    up.on("error", reject);
    if (body && body.length) up.write(body);
    up.end();
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
  const { id, name } = userFor(url.searchParams.get("u"));
  const initData = signInitData(id, name);

  const chunks = [];
  for await (const c of req) chunks.push(c);
  const body = Buffer.concat(chunks);

  try {
    if (req.method === "GET" && ["/app", "/app.html", "/app/"].includes(url.pathname)) {
      const up = await fetchUpstream(req, null);
      let html = "";
      up.on("data", (d) => (html += d));
      up.on("end", () => {
        html = html.replace(
          /<script[^>]*telegram-web-app\.js[^>]*><\/script>/,
          telegramStub(initData)
        );
        res.writeHead(up.statusCode || 200, { "content-type": "text/html; charset=utf-8" });
        res.end(html);
      });
      up.on("error", () => { res.writeHead(502); res.end("upstream error"); });
      return;
    }

    const headers = { ...req.headers };
    if (url.pathname.startsWith("/api/") && !headers["x-telegram-init-data"]) {
      headers["x-telegram-init-data"] = initData;
    }
    delete headers["content-length"];
    const up = http.request({
      host: UP_HOST, port: UP_PORT, path: req.url, method: req.method, headers
    }, (upRes) => {
      res.writeHead(upRes.statusCode || 502, upRes.headers);
      upRes.pipe(res);
    });
    up.on("error", () => { res.writeHead(502); res.end("wrangler dev ещё не поднялся — подождите несколько секунд"); });
    if (body.length) up.write(body);
    up.end();
  } catch (e) {
    res.writeHead(500); res.end(String(e));
  }
});

// ---------- запуск ----------
const args = process.argv.slice(2);
if (args[0] === "initdata") {
  const { id, name } = userFor(args[1]);
  console.log(signInitData(id, name));
  process.exit(0);
}

console.log(`[stand] BOT_TOKEN из .dev.vars: ${TOKEN.slice(0, 12)}…`);

if (!args.includes("--no-migrate")) {
  console.log("[stand] применяю миграции к локальной D1…");
  const r = spawnSync("npx --yes wrangler@4 d1 migrations apply duoplan --local", { cwd: root, shell: SHELL, stdio: "inherit" });
  if (r.status !== 0) { console.error("[stand] миграции не применились"); process.exit(1); }
}

console.log(`[stand] запускаю wrangler dev на :${UP_PORT}…`);
const wrangler = spawn(`npx --yes wrangler@4 dev --local --port ${UP_PORT} --ip ${UP_HOST}`, {
  cwd: root, shell: SHELL, stdio: "inherit"
});
wrangler.on("exit", (code) => { console.error(`[stand] wrangler завершился (${code})`); process.exit(code ?? 1); });

server.listen(PORT, UP_HOST, () => {
  console.log(`[stand] стенд готов:`);
  console.log(`  user 1: http://${UP_HOST}:${PORT}/app?u=1`);
  console.log(`  user 2: http://${UP_HOST}:${PORT}/app?u=2   (откройте в другом браузере/гостевом окне — это второй «собеседник»)`);
  console.log(`  api    : curl http://${UP_HOST}:${PORT}/api/state?u=1`);
  console.log(`  stop   : Ctrl+C`);
});