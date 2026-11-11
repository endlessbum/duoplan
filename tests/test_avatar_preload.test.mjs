// Прогрев аватаров на экране загрузки (public/app.js).
//
// Репорт 2026-11-11: пилюля пары появлялась одновременно с главным экраном, а
// background-image начинает грузиться только у ВИДИМОГО элемента — сначала
// мелькала цветная подложка (буква), и только потом поверх «доезжало» фото.
// Теперь фото качаются, пока на экране ещё «Открываем ваше пространство…», а
// буквы и акцентные цвета красятся до unhide кнопки, поэтому пилюля
// показывается уже в финальном виде.
//
// Запуск: node --test tests/test_avatar_preload.test.mjs
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { deepStrictEqual, equal, ok } from "node:assert/strict";
import { test } from "node:test";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const appSource = readFileSync(join(root, "public/app.js"), "utf8");

function extractBraced(declaration) {
  const start = appSource.indexOf(declaration);
  if (start === -1) throw new Error(`${declaration} не найдено`);
  let depth = 0;
  for (let j = appSource.indexOf("{", start); j < appSource.length; j++) {
    if (appSource[j] === "{") depth++;
    else if (appSource[j] === "}") {
      depth--;
      if (depth === 0) return appSource.slice(start, j + 1);
    }
  }
  throw new Error(`незакрытый блок: ${declaration}`);
}

function extractLine(prefix) {
  const start = appSource.indexOf(prefix);
  if (start === -1) throw new Error(`${prefix} не найдено`);
  return appSource.slice(start, appSource.indexOf("\n", start));
}

// ------------------------------------------------------------------
// Песочница: функции прогрева + заглушки DOM/Image
// ------------------------------------------------------------------
function makeSlot() {
  const el = {
    classes: new Set(),
    textContent: "",
    style: {
      removeProperty(name) { delete this[name]; }
    },
    classList: {
      add: (name) => el.classes.add(name),
      remove: (name) => el.classes.delete(name)
    }
  };
  return el;
}

function loadPreload({ mode = "ok", pillHidden = true } = {}) {
  const created = [];
  // mode: "ok" — картинка грузится и декодируется; "hang" — onload не приходит;
  // "fail" — onerror.
  function FakeImage() {
    const img = {
      onload: null,
      onerror: null,
      src: "",
      decode: () => Promise.resolve()
    };
    created.push(img);
    // Асинхронность как у настоящего Image: обработчик зовём после установки src.
    const settle = () => {
      if (mode === "hang") return;
      if (mode === "fail") img.onerror?.();
      else img.onload?.();
    };
    Object.defineProperty(img, "src", {
      get: () => img._src || "",
      set: (value) => {
        img._src = value;
        setTimeout(settle, 0);
      }
    });
    return img;
  }

  const avatarA = makeSlot();
  const avatarB = makeSlot();
  const api = new Function("FakeImage", "avatarA", "avatarB", "pairButton", [
    "let appState = null;",
    'const document = { documentElement: { dataset: { theme: "light" } } };',
    'const ACCENT_PALETTES = { berry: { light: "#b85464", dark: "#d97383" }, sage: { light: "#55766a", dark: "#7ba394" } };',
    extractLine("const AVATAR_PRELOAD_TIMEOUT_MS"),
    extractLine("const avatarPreloads"),
    extractLine("const AVATAR_PRELOAD_CACHE_LIMIT"),
    extractBraced("function esc"),
    extractBraced("function firstLetter"),
    extractBraced("function hexRgb"),
    extractBraced("function paintAvatar"),
    extractBraced("function applyAvatarColors"),
    extractBraced("function paintAvatarSlot"),
    extractBraced("function avatarPhotoUrls"),
    extractBraced("function preloadAvatarPhoto"),
    extractBraced("function waitAtMost"),
    extractBraced("function paintPairAvatars"),
    extractBraced("async function preloadPairAvatars"),
    "const Image = FakeImage;",
    "return {",
    "  setState: (value) => { appState = value; },",
    "  urls: avatarPhotoUrls,",
    "  preload: preloadPairAvatars,",
    "  preloadOne: preloadAvatarPhoto,",
    "  paint: paintPairAvatars,",
    "  cache: avatarPreloads,",
    "  slots: { a: avatarA, b: avatarB }",
    "};"
  ].join("\n"));
  return { api: api(FakeImage, avatarA, avatarB, { hidden: pillHidden }), created, avatarA, avatarB };
}

function makeState({ role = "a", showAvatar = true, partner = true, mine = "https://t.me/i/userpic/me.jpg" } = {}) {
  return {
    user: { gender: "female", show_avatar: showAvatar, photo_url: mine, accent_color: "berry" },
    pair: {
      role,
      user_b: partner ? 200 : null,
      name1: "Оля",
      name2: "Никита",
      partner_accent: "sage",
      photo1: "https://t.me/i/userpic/olya.jpg",
      photo2: "https://t.me/i/userpic/nikita.jpg"
    }
  };
}

// ------------------------------------------------------------------
// 1. Какие ссылки нужно прогреть
// ------------------------------------------------------------------
test("avatarPhotoUrls: обе ссылки при включённом флаге, своя — по роли", () => {
  const { api } = loadPreload();
  deepStrictEqual(
    api.urls(makeState({ role: "a" })),
    ["https://t.me/i/userpic/me.jpg", "https://t.me/i/userpic/nikita.jpg"],
    "владелец: своё фото + фото партнёра"
  );
  deepStrictEqual(
    api.urls(makeState({ role: "b" })),
    ["https://t.me/i/userpic/olya.jpg", "https://t.me/i/userpic/me.jpg"],
    "партнёр: фото владельца + своё"
  );
});

test("avatarPhotoUrls: выключенный флаг, отсутствие партнёра и не-https не греются", () => {
  const { api } = loadPreload();
  deepStrictEqual(api.urls(makeState({ showAvatar: false })), [], "флаг выключен");
  deepStrictEqual(
    api.urls(makeState({ partner: false })),
    ["https://t.me/i/userpic/me.jpg"],
    "без партнёра — только своё фото"
  );
  deepStrictEqual(
    api.urls({ user: { gender: "male", photo_url: "http://insecure/x.jpg" }, pair: { role: "a", user_b: 200, photo1: "", photo2: null } }),
    [],
    "http/пустые ссылки мимо"
  );
  deepStrictEqual(api.urls({ user: { gender: null }, pair: null }), [], "онбординг: пары ещё нет");
});

// ------------------------------------------------------------------
// 2. Прогрев: ждём decode, кэшируем по ссылке, не держим загрузку вечно
// ------------------------------------------------------------------
test("preloadPairAvatars ждёт decode и красит слоты фото до показа", async () => {
  const { api, created, avatarA, avatarB } = loadPreload();
  api.setState(makeState());
  await api.preload();
  equal(created.length, 2, "обе ссылки прогреты");
  ok(created.every((img) => /^https:\/\//.test(img.src)), "качаются только https-фото");
  ok(avatarA.classes.has("has-photo"), "слот A с фото");
  ok(avatarB.classes.has("has-photo"), "слот B с фото");
  equal(avatarA.textContent, "", "буква убрана под фото");
  ok(avatarA.style.backgroundImage.includes("me.jpg"), "background-image выставлен после прогрева");
});

test("без фото слоты получают букву и акцент — тоже до показа пилюли", async () => {
  const { api, avatarA, avatarB } = loadPreload();
  api.setState(makeState({ showAvatar: false }));
  await api.preload();
  equal(avatarA.textContent, "О", "буква владельца");
  equal(avatarB.textContent, "Н", "буква партнёра");
  ok(!avatarA.classes.has("has-photo"), "класс фото не выставлен");
  ok(avatarA.style.color, "акцентный цвет буквы применён");
});

test("скрытая пилюля красится сразу, не дожидаясь фото", async () => {
  // Старт приложения: к моменту unhide слоты уже в финальном виде, поэтому
  // даже зависший CDN не оставляет в кнопке дефолтные «Д»/«П».
  const { api, avatarA } = loadPreload({ mode: "hang" });
  api.setState(makeState());
  const flight = api.preload(30);
  ok(avatarA.classes.has("has-photo"), "слоты покрашены до ожидания картинок");
  ok(avatarA.style.backgroundImage.includes("me.jpg"), "background-image выставлен сразу");
  await flight;
});

test("видимая пилюля не перекрашивается в промежуточное состояние", async () => {
  // Минутный refresh принёс новое фото: пока оно не готово, на экране должен
  // оставаться прежний аватар, а не пустой круг с новой буквой.
  const { api, avatarA } = loadPreload({ mode: "hang", pillHidden: false });
  api.setState(makeState());
  avatarA.style.backgroundImage = 'url("https://t.me/i/userpic/old.jpg")';
  const flight = api.preload(30);
  equal(avatarA.style.backgroundImage, 'url("https://t.me/i/userpic/old.jpg")', "старый вид до готовности фото");
  await flight;
  ok(avatarA.style.backgroundImage.includes("me.jpg"), "после прогрева — новое фото");
});

test("зависшая картинка не держит экран загрузки дольше таймаута", async () => {
  const { api } = loadPreload({ mode: "hang" });
  api.setState(makeState());
  const started = Date.now();
  await api.preload(40);
  const elapsed = Date.now() - started;
  ok(elapsed >= 30, `прогрев должен ждать до таймаута, прошло ${elapsed} мс`);
  ok(elapsed < 1000, `таймаут обязан сработать, прошло ${elapsed} мс`);
});

test("повторный прогрев не перекачивает те же ссылки", async () => {
  const { api, created } = loadPreload();
  api.setState(makeState());
  await api.preload();
  const afterFirst = created.length;
  await api.preload();
  equal(created.length, afterFirst, "кэш по ссылке: второй вызов без сети");
});

test("неудачная загрузка не кэшируется — следующий прогрев пробует снова", async () => {
  const { api, created } = loadPreload({ mode: "fail" });
  api.setState(makeState());
  await api.preload();
  equal(api.cache.size, 0, "ошибка не осела в кэше");
  const afterFirst = created.length;
  await api.preload();
  equal(created.length, afterFirst + 2, "повторная попытка снова качает фото");
});

test("прогрев не бросает исключение: сбой картинок не ломает запуск", async () => {
  const { api } = loadPreload({ mode: "fail" });
  api.setState(makeState());
  await api.preload();
});

// ------------------------------------------------------------------
// 3. Порядок вызовов в коде приложения
// ------------------------------------------------------------------
function extractFunction(declaration) {
  const start = appSource.indexOf(declaration);
  if (start === -1) throw new Error(`${declaration} не найдено`);
  let depth = 0;
  for (let j = appSource.indexOf("{", start); j < appSource.length; j++) {
    if (appSource[j] === "{") depth++;
    else if (appSource[j] === "}") {
      depth--;
      if (depth === 0) return appSource.slice(start, j + 1);
    }
  }
  throw new Error(`незакрытый блок: ${declaration}`);
}

test("initApp прогревает аватары до первого render()", () => {
  const initApp = extractFunction("async function initApp");
  const preload = initApp.indexOf("await preloadPairAvatars()");
  const render = initApp.indexOf("render();");
  ok(preload !== -1, "в initApp нет прогрева аватаров");
  ok(render !== -1, "в initApp нет render()");
  ok(preload < render, "прогрев обязан идти до показа интерфейса");
});

test("refreshState и сохранение настроек прогревают новое фото до перерисовки", () => {
  const refresh = extractFunction("async function refreshState");
  const preload = refresh.indexOf("await preloadPairAvatars()");
  ok(preload !== -1, "refreshState не прогревает новое фото");
  ok(preload < refresh.indexOf("render();"), "прогрев до перерисовки");

  const start = appSource.indexOf('action === "save-settings"');
  const end = appSource.indexOf('action === "set-theme"');
  const handler = appSource.slice(start, end);
  ok(handler.includes("await preloadPairAvatars()"), "включение аватара не прогревает фото");
  ok(
    handler.indexOf("await preloadPairAvatars()") < handler.indexOf("render();"),
    "прогрев до перерисовки настроек"
  );
});

test("syncTopControls красит слоты до показа кнопки пары", () => {
  const sync = extractFunction("function syncTopControls");
  const paint = sync.indexOf("paintPairAvatars()");
  const unhide = sync.indexOf("pairButton.hidden = false");
  ok(paint !== -1, "syncTopControls не красит слоты");
  ok(unhide !== -1, "syncTopControls не показывает кнопку");
  ok(paint < unhide, "слоты обязаны быть готовы до unhide — иначе вспышка «Д»/«П»");
});
