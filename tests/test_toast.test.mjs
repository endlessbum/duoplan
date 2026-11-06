// Уведомления (тосты): текст при пустом рандоме и центрирование в CSS.
// Проверки по исходникам — обработчики живут внутри делегированного
// click-листенера и не извлекаются отдельными функциями.
//
// Запуск: node --test tests/test_toast.test.mjs
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { ok } from "node:assert/strict";
import { test } from "node:test";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const appJs = readFileSync(join(root, "public/app.js"), "utf8");
const appCss = readFileSync(join(root, "public/app.css"), "utf8");

test("рандом мест при пустом списке предлагает добавить, а не «всё посещено»", () => {
  ok(appJs.includes('placeList().length'), "random-place не различает пустой список");
  ok(appJs.includes("Сначала добавьте места"), "нет текста для пустого списка мест");
  ok(appJs.includes("Все места уже посещены — добавьте новое"), "нет текста для «все посещены»");
});

test("рандом кино при пустом списке предлагает добавить, а не «всё просмотрено»", () => {
  ok(appJs.includes('movieList().length'), "random-movie не различает пустой список");
  ok(appJs.includes("Сначала добавьте фильм или сериал"), "нет текста для пустого списка кино");
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
