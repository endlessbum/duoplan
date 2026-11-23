// Обратная связь по кодам API-ошибок и логирование сбоев уведомлений
// (рекомендации аудита 2026-11-23, п. 5.1 и 5.2).
//
// Сервер уже присылает русский текст для всех HttpError, но не у всех кодов
// явно сказано, что делать дальше. Клиент добавляет короткую подсказку только
// для известных кодов, не дублируя готовый текст. Сбои вторичных уведомлений
// при входе/выходе не отменяют саму операцию, но логируются с контекстом.
//
// Запуск: node --test tests/test_error_feedback.test.mjs
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { equal, match, ok } from "node:assert/strict";
import { test } from "node:test";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const appJs = readFileSync(join(root, "public", "app.js"), "utf8");
const workerJs = readFileSync(join(root, "worker.js"), "utf8");

const start = appJs.indexOf("  const API_ERROR_HINTS = {");
const end = appJs.indexOf("  function handleRequestError(error)", start);
ok(start !== -1 && end !== -1, "блок подсказок API-ошибок не найден");
const api = new Function(`${appJs.slice(start, end)}\nreturn { API_ERROR_HINTS, apiErrorMessage };`)();

const CODES = {
  LAST_GOAL_ITEM: "Нельзя удалить последний пункт цели",
  GOAL_ITEMS_LIMIT: "Не больше 30 пунктов на цель",
  INVALID_SAVING_CHOICE: "Выберите существующую копилку или создание новой",
  SAVING_FULL: "Копилка уже заполнена",
  TARGET_BELOW_COLLECTED: "Цель не может быть меньше уже собранной суммы",
  JOIN_RATE_LIMITED: "Слишком много неудачных попыток входа по коду",
  PAIR_RESERVED: "Это пространство ждёт возвращения прежнего партнёра",
  GENDER_IMMUTABLE: "Пол уже задан и не меняется"
};

test("все коды аудита имеют явную подсказку и добавляют её к тексту сервера", () => {
  for (const [code, base] of Object.entries(CODES)) {
    const message = api.apiErrorMessage({ status: 400, code, message: base });
    ok(message.startsWith(base), `для ${code} потерян текст сервера`);
    ok(message.includes(api.API_ERROR_HINTS[code]), `для ${code} нет подсказки`);
    ok(message.length > base.length, `для ${code} подсказка не добавлена`);
  }
});

test("неизвестный код и сетевая ошибка не получают выдуманной подсказки", () => {
  equal(api.apiErrorMessage({ status: 409, code: "SOMETHING_NEW", message: "Текст сервера" }), "Текст сервера");
  equal(api.apiErrorMessage(new Error("TypeError")), "Что-то пошло не так, попробуйте ещё раз");
  equal(api.apiErrorMessage({ code: "LAST_GOAL_ITEM" }), api.API_ERROR_HINTS.LAST_GOAL_ITEM);
});

test("подсказка не дублируется, если сервер уже её привёл", () => {
  const hint = api.API_ERROR_HINTS.LAST_GOAL_ITEM;
  equal(api.apiErrorMessage({ code: "LAST_GOAL_ITEM", message: `Ошибка. ${hint}` }), `Ошибка. ${hint}`);
});

test("тост и ошибка диалога идут через одну функцию форматирования", () => {
  match(appJs, /showToast\(apiErrorMessage\(error\)\);/);
  match(appJs, /dialogError\.textContent = apiErrorMessage\(error\);/);
  ok(!/showToast\(error\?\.status !== undefined \|\| error\?\.code/.test(appJs),
    "старый фильтр текста остался в тосте");
});

test("уведомления входа и выхода логируют сбой, но не бросают его наружу", () => {
  match(workerJs, /join notification failed", error\)\);/);
  match(workerJs, /leave notification failed", error\)\);/);
  ok(!/\.catch\(\(\)\s*=>\s*\{\s*\}\)/.test(workerJs), "в worker.js остался молчаливый catch");
  // Порядок важен: ошибка уведомления не должна отменять уже применённую запись.
  match(workerJs, /\.catch\(\(error\) => console\.error\("join notification failed", error\)\);\s*if \(ctx\?\.waitUntil\)/);
});
