// Уведомления (тосты): текст при пустом рандоме, центрирование в CSS и слой
// поверх модального окна. Проверки по исходникам — обработчики живут внутри
// делегированного click-листенера и не извлекаются отдельными функциями.
//
// Запуск: node --test tests/test_toast.test.mjs
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { equal, match, ok } from "node:assert/strict";
import { test } from "node:test";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const appJs = readFileSync(join(root, "public", "app.js"), "utf8");
const appCss = readFileSync(join(root, "public", "app.css"), "utf8");
const appHtml = readFileSync(join(root, "public", "app.html"), "utf8");

test("рандом мест при пустом списке предлагает добавить, а не «всё посещено»", () => {
  ok(appJs.includes('placeList().length'), "random-place не различает пустой список");
  ok(appJs.includes("Сначала добавьте места"), "нет текста для пустого списка мест");
  ok(appJs.includes("Все места уже посещены — добавьте новое"), "нет текста для «все посещены»");
});

test("рандом кино при пустом списке предлагает добавить, а не «всё просмотрено»", () => {
  ok(appJs.includes('movieList().length'), "random-movie не различает пустой список");
  ok(appJs.includes("Сначала добавьте фильм или сериал"), "нет текста для «все просмотрено»");
});

test("мутации с неочевидным результатом подтверждаются тостом", () => {
  // done-item / reopen-item / delete-item / goal-item-* раньше завершались
  // молча — пользователь не понимал, применилась ли операция.
  ok(appJs.includes("Исполнено") && appJs.includes("Выполнено"), "нет тоста завершения записи");
  ok(appJs.includes("Возвращено: «"), "нет тоста возврата записи");
  ok(appJs.includes("Удалено: «"), "нет тоста удаления записи");
  ok(appJs.includes("Пункт цели выполнен") && appJs.includes("Пункт возвращён в работу"), "нет тостов пунктов цели");
});

test("праздничные события имеют свои тосты", () => {
  ok(appJs.includes("выполнена!") || appJs.includes("заполнена!") || appJs.includes("Партнёр в пространстве!"),
    "нет тостов на завершение цели/копилки/вход партнёра");
});

test("тост не должен получать HTML-экранирование: textContent показывает сущности буквально", () => {
  // esc() внутри showToast(...) — баг: &amp; и компания видны пользователю.
  ok(!/showToast\([^)]*esc\(/.test(appJs), "showToast получает esc()-строку");
});

test("тост центрирован и переносится по центру пилюли", () => {
  const toastRule = appCss.match(/\.toast\s*\{[^}]*\}/);
  ok(toastRule, "правило .toast не найдено");
  const rule = toastRule[0];
  ok(rule.includes("left: 50%") && rule.includes("translateX(-50%)"), "тост не отцентрирован");
  ok(rule.includes("text-align: center"), "текст тоста не по центру");
  ok(rule.includes("max-width"), "нет ограничения ширины — длинный текст уедет за экран");
});

// ---------------------------------------------------------------------------
// Слой уведомлений (репорт 2026-11-23: «Номер скопирован» за блюром окна
// контакта). Модальный <dialog> живёт в top-layer, поэтому fixed-тост в body
// перекрывается его ::backdrop независимо от z-index. app.js переносит тост
// внутрь dialog на время окна и возвращает обратно при закрытии.
// ---------------------------------------------------------------------------

const start = appJs.indexOf("  function syncToastLayer()");
const end = appJs.indexOf("  function showToast(", start);
ok(start !== -1 && end !== -1, "функция syncToastLayer не найдена");
const fragment = appJs.slice(start, end);

function makeLayer(open) {
  const body = { name: "body", children: [] };
  const dlg = { name: "dialog", open, children: [] };
  const attach = (host) => ({
    appendChild(el) {
      if (el.parentElement) {
        const i = el.parentElement.children.indexOf(el);
        if (i !== -1) el.parentElement.children.splice(i, 1);
      }
      el.parentElement = host;
      host.children.push(el);
    }
  });
  Object.assign(body, attach(body));
  Object.assign(dlg, attach(dlg));
  const toast = { parentElement: body };
  const sync = new Function("toastEl", "dialog", "toastHome", `${fragment}\nreturn syncToastLayer;`)(toast, dlg, body);
  return { body, dlg, toast, sync };
}

test("тост уезжает в top-layer окна и возвращается в body после закрытия", () => {
  const { body, dlg, toast, sync } = makeLayer(false);
  sync();
  equal(toast.parentElement, body, "без окна тост должен быть в body");

  dlg.open = true;
  sync();
  equal(toast.parentElement, dlg, "при открытом окне тост должен быть внутри dialog");
  // Повторный вызов не должен пересоздавать узел и сбрасывать таймер.
  sync();
  equal(toast.parentElement, dlg);
  equal(dlg.children.length, 1, "тост продублировался в окне");

  dlg.open = false;
  sync();
  equal(toast.parentElement, body, "после закрытия тост должен вернуться в body");
});

test("показ тоста и открытие/закрытие окна синхронизируют слой", () => {
  match(appJs, /function showToast\(message[\s\S]{0,220}?syncToastLayer\(\);/);
  match(appJs, /dialog\.showModal\(\);[\s\S]{0,220}?syncToastLayer\(\);/);
  match(appJs, /if \(dialog\.open\) return;[\s\S]{0,220}?syncToastLayer\(\);/);
});

test("все служебные вставки окна уже внутри dialog, тост стартует снаружи", () => {
  const dialogBlock = appHtml.slice(appHtml.indexOf("<dialog"), appHtml.indexOf("</dialog>"));
  for (const id of ["dialog-error", "dialog-confirm", "fmt-toolbar"]) {
    ok(dialogBlock.includes(`id="${id}"`), `#${id} остался снаружи окна`);
  }
  ok(!dialogBlock.includes('id="toast"'), "тост не должен быть в разметке окна: без окна он был бы скрыт");
  ok(appHtml.indexOf('<div id="toast"') > appHtml.indexOf("</dialog>"), "тост должен стартовать после dialog");
});

test("z-index тоста выше всех остальных слоёв приложения", () => {
  const rule = appCss.match(/\.toast\s*\{[^}]*\}/)?.[0] || "";
  match(rule, /z-index:\s*70;/);
  const levels = [...appCss.matchAll(/z-index:\s*(\d+)/g)].map((m) => Number(m[1]));
  equal(Math.max(...levels), 70, "нашёлся слой выше тоста — уведомление снова может оказаться под ним");
});

test("на остальных страницах нет модальных окон с таким же конфликтом слоёв", () => {
  for (const file of ["index.html", "setup.html", "404.html"]) {
    const html = readFileSync(join(root, "public", file), "utf8");
    ok(!/<dialog\b/i.test(html), `в ${file} есть dialog — проверь слой уведомлений`);
  }
});
