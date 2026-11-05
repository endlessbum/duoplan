// Проверка перетаскивания капли НАСТОЯЩИМИ касаниями (CDP Input.dispatchTouchEvent).
//
// Зачем отдельно от harness: синтетический `new TouchEvent(...)` браузер не
// считает пользовательским вводом, поэтому он не запускает нативный скролл и не
// может украсть жест. Ровно это и было багом: WebView начинал пан, уводил
// pointer в pointercancel, и капля замирала на первом движении. Здесь касания
// приходят через протокол — браузер обрабатывает их как настоящие.
//
// Запуск: node scripts/check-touch-drag.mjs [--chrome <путь>]
// Требуется Node 22+ (встроенный WebSocket) и установленный Chrome.
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = resolve(fileURLToPath(new URL(".", import.meta.url)));
const pagePath = join(here, "..", "tests", "touch-drag.html");
const chromePath =
  process.argv.includes("--chrome")
    ? process.argv[process.argv.indexOf("--chrome") + 1]
    : process.env.CHROME || "C:/Program Files/Google/Chrome/Application/chrome.exe";

const PORT = 9333 + Math.floor(Math.random() * 200);
const profile = mkdtempSync(join(tmpdir(), "duoplan-touch-"));
const url = pathToFileURL(pagePath).href;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const chrome = spawn(
  chromePath,
  [
    "--headless=new",
    "--disable-gpu",
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-extensions",
    `--user-data-dir=${profile}`,
    `--remote-debugging-port=${PORT}`,
    url
  ],
  { stdio: ["ignore", "pipe", "pipe"] }
);

const cleanup = () => {
  try {
    chrome.kill();
  } catch {}
};

const removeProfile = async () => {
  // Chrome отпускает файлы профиля не мгновенно — на Windows первый rm падает
  // с EBUSY, поэтому пробуем несколько раз.
  for (let i = 0; i < 10; i += 1) {
    try {
      rmSync(profile, { recursive: true, force: true });
      return;
    } catch {
      await sleep(200);
    }
  }
};

async function targetUrl() {
  for (let i = 0; i < 100; i += 1) {
    try {
      const response = await fetch(`http://127.0.0.1:${PORT}/json/list`);
      const list = await response.json();
      const page = list.find((t) => t.type === "page" && t.url.startsWith("file:"));
      if (page?.webSocketDebuggerUrl) return page.webSocketDebuggerUrl;
    } catch {}
    await sleep(100);
  }
  throw new Error("Chrome не поднял отладочный порт");
}

function connect(wsUrl) {
  const socket = new WebSocket(wsUrl);
  const pending = new Map();
  let seq = 0;
  const ready = new Promise((res, rej) => {
    socket.addEventListener("open", res, { once: true });
    socket.addEventListener("error", rej, { once: true });
  });
  socket.addEventListener("message", (event) => {
    const msg = JSON.parse(event.data);
    const waiter = pending.get(msg.id);
    if (!waiter) return;
    pending.delete(msg.id);
    if (msg.error) waiter.reject(new Error(JSON.stringify(msg.error)));
    else waiter.resolve(msg.result);
  });
  const send = async (method, params = {}) => {
    await ready;
    seq += 1;
    const id = seq;
    const reply = new Promise((res, rej) => pending.set(id, { resolve: res, reject: rej }));
    socket.send(JSON.stringify({ id, method, params }));
    return reply;
  };
  return { send, close: () => socket.close(), ready };
}

async function main() {
  const cdp = connect(await targetUrl());
  await cdp.ready;
  await cdp.send("Runtime.enable");
  await cdp.send("Page.enable");
  // Мобильный вьюпорт как у Mini App: узкий экран, тач, без масштаба.
  await cdp.send("Emulation.setDeviceMetricsOverride", {
    width: 390,
    height: 844,
    deviceScaleFactor: 3,
    mobile: true
  });
  await cdp.send("Emulation.setTouchEmulationEnabled", { enabled: true, maxTouchPoints: 5 });
  await cdp.send("Page.navigate", { url });
  await sleep(700);

  const evaluate = async (expression) => {
    const { result, exceptionDetails } = await cdp.send("Runtime.evaluate", {
      expression,
      returnByValue: true,
      awaitPromise: true
    });
    if (exceptionDetails) throw new Error(exceptionDetails.text || "ошибка в странице");
    return result.value;
  };

  for (let i = 0; i < 50; i += 1) {
    if (await evaluate("Boolean(window.__ready)")) break;
    await sleep(100);
  }
  if (!(await evaluate("Boolean(window.__ready)"))) throw new Error("страница не инициализировалась");

  const touch = (type, points) =>
    cdp.send("Input.dispatchTouchEvent", {
      type,
      touchPoints: points.map((p, index) => ({
        x: p.x,
        y: p.y,
        id: p.id ?? index + 1,
        radiusX: 8,
        radiusY: 8,
        force: 1
      }))
    });

  const results = [];
  const check = (name, ok, detail) => results.push({ name, ok: Boolean(ok), detail: String(detail ?? "") });

  // --- сценарий 1: горизонтальный drag home → dates
  await evaluate("window.__reset()");
  const start = await evaluate("window.__probe()");
  const y = start.home.y;
  await touch("touchStart", [{ x: start.home.x, y }]);
  const track = [];
  for (const dx of [8, 18, 34, 58, 90, 124, 150]) {
    await sleep(35);
    await touch("touchMove", [{ x: start.home.x + dx, y }]);
    track.push(await evaluate("window.__probe()"));
  }
  await sleep(60);
  const mid = await evaluate("window.__probe()");
  await touch("touchEnd", []);
  await sleep(300);
  const end = await evaluate("window.__probe()");

  const moved = mid.pos - start.pos;
  check("жест вообще начался", mid.dragging === true, `dragging=${mid.dragging}`);
  check("капля едет за пальцем", moved > 30, `${start.pos.toFixed(1)} → ${mid.pos.toFixed(1)} (+${moved.toFixed(1)})`);
  check(
    "движение монотонное, без замираний",
    track.every((p, i) => i === 0 || p.pos >= track[i - 1].pos - 0.5),
    track.map((p) => p.pos.toFixed(1)).join(" → ")
  );
  check("страница не прокрутилась", mid.scrollY === 0 && end.scrollY === 0, `scrollY=${mid.scrollY}`);
  check(
    "браузер не отобрал жест (нет pointercancel)",
    !mid.events.some((e) => e.includes("pointercancel")),
    mid.events.join(",")
  );
  check("отпускание переключило вкладку", end.active === "dates", `active=${end.active}, commits=${end.commits.join(",")}`);

  // --- сценарий 2: обратно dates → home (движение в обе стороны)
  await evaluate("window.__reset()");
  const onHome = await evaluate("window.__probe()");
  // Переключаемся на «Даты» обычным тапом, чтобы капля стояла справа.
  await touch("touchStart", [{ x: onHome.dates.x, y: onHome.dates.y }]);
  await touch("touchEnd", []);
  await sleep(250);
  const onDates = await evaluate("window.__probe()");
  const from = onDates.dates;
  await touch("touchStart", [{ x: from.x, y: from.y }]);
  const backTrack = [];
  for (const dx of [-8, -20, -40, -70, -100, -140, -180]) {
    await sleep(35);
    await touch("touchMove", [{ x: from.x + dx, y: from.y }]);
    backTrack.push(await evaluate("window.__probe()"));
  }
  await sleep(60);
  await touch("touchEnd", []);
  await sleep(300);
  const backEnd = await evaluate("window.__probe()");
  check(
    "капля едет в обратную сторону",
    backTrack[backTrack.length - 1].pos < backTrack[0].pos - 20,
    backTrack.map((p) => p.pos.toFixed(1)).join(" → ")
  );
  check("вернулись на главную", backEnd.active === "home", `active=${backEnd.active}`);

  // --- сценарий 3: вертикальный свайп с панели не должен дёргать каплю
  await evaluate("window.__reset()");
  const v0 = await evaluate("window.__probe()");
  await touch("touchStart", [{ x: v0.home.x, y: v0.home.y }]);
  for (const dy of [-10, -25, -45, -70]) {
    await sleep(35);
    await touch("touchMove", [{ x: v0.home.x, y: v0.home.y + dy }]);
  }
  await sleep(60);
  const vMid = await evaluate("window.__probe()");
  await touch("touchEnd", []);
  await sleep(200);
  check("вертикальный свайп не двигает каплю", Math.abs(vMid.pos - v0.pos) < 1, `${v0.pos} → ${vMid.pos}`);

  cdp.close();

  let failed = 0;
  for (const r of results) {
    if (!r.ok) failed += 1;
    console.log(`${r.ok ? "ok  " : "FAIL"} ${r.name}${r.detail ? ` — ${r.detail}` : ""}`);
  }
  console.log(`\n${results.length - failed}/${results.length} проверок пройдено`);
  return failed === 0 ? 0 : 1;
}

main()
  .then(async (code) => {
    cleanup();
    await removeProfile();
    process.exit(code);
  })
  .catch(async (error) => {
    cleanup();
    await removeProfile();
    console.error("Ошибка:", error.message);
    process.exit(1);
  });
