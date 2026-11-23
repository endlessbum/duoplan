// Закрытие окон (решение владельца 2026-11-23).
//
// Окно с плавающей «×» не дублирует закрытие текстовой кнопкой «Закрыть»
// в подвале: закрыть можно только «×». Кнопки «Отмена», «Нет», «Оставить»
// и т.п. остаются — это отказ от действия, а не второй способ закрыть окно.
// «×» лежит вне прокручиваемой формы и остаётся в правом верхнем углу окна
// при скролле и свайпе; остальные элементы едут вместе с содержимым
// (уточнение владельца 2026-11-23, заменило закреплённую полосу-шапку).
// Нажатие «×» защищено подтверждением так же, как тап по фону и «Назад»;
// «Отмена» остаётся прямым закрытием.
//
// Фрагмент openDialog() выполняется по-настоящему на разметке диалога
// из public/app.html.
//
// Запуск: node --test tests/test_dialog_close.test.mjs
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { equal, match, ok } from "node:assert/strict";
import { test } from "node:test";
import { parseHTML } from "linkedom";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const appJs = readFileSync(join(root, "public", "app.js"), "utf8");
const appHtml = readFileSync(join(root, "public", "app.html"), "utf8");
const appCss = readFileSync(join(root, "public", "app.css"), "utf8");

// Разметка диалога берётся из app.html целиком: структура важна, а не макет.
const dialogHtml = appHtml.slice(appHtml.indexOf('<dialog id="item-dialog"'), appHtml.indexOf("</dialog>") + 10);
ok(dialogHtml.includes('id="dialog-cancel"'), "в app.html нет кнопки отмены — тест устарел");

// Фрагмент openDialog(): установка кнопок от submit до hideDialogError().
const start = appJs.indexOf("if (dialogSubmit) {");
const end = appJs.indexOf("hideDialogError();", start);
ok(start !== -1 && end !== -1, "фрагмент openDialog не найден");
const fragment = appJs.slice(start, end + "hideDialogError();".length);

function openWith(config) {
  const { document } = parseHTML(dialogHtml);
  const dialogForm = document.getElementById("item-form");
  // Заглушки состояния закрытия-по-тапу (PD-DIALOG-002): фрагмент openDialog
  // сбрасывает их при каждом открытии, в тесте достаточно нейтральных значений.
  const run = new Function(
    "config", "dialogSubmit", "dialogCancel", "dialogForm", "hideDialogError",
    "hideDialogCloseConfirm",
    `let dialogDirty = false; let dialogAsciiInitialMode = null;\n${fragment}`
  );
  run(
    config,
    document.getElementById("dialog-submit"),
    document.getElementById("dialog-cancel"),
    dialogForm,
    () => {},
    () => {}
  );
  return {
    cancel: document.getElementById("dialog-cancel"),
    submit: document.getElementById("dialog-submit"),
    actions: dialogForm.querySelector(".sheet-actions")
  };
}

test("окно чтения: текстового «Закрыть» нет, подвал пуст и не занимает место", () => {
  const { cancel, submit, actions } = openWith({ title: "Ваша история", submitLabel: null, cancelLabel: "Закрыть", readOnly: true });
  equal(cancel.textContent, "Закрыть", "кнопка отмены должна получить текст до скрытия");
  equal(cancel.hidden, true, "текстовая «Закрыть» показывается в подвале");
  equal(submit.hidden, true, "режим чтения с кнопкой сохранения");
  equal(actions.hidden, true, "пустой подвал оставляет отступ");
});

test("окно с «Сохранить»: «Закрыть» убрана, остальные кнопки на месте", () => {
  const { cancel, submit, actions } = openWith({ title: "Группа", submitLabel: "Сохранить", cancelLabel: "Закрыть" });
  equal(cancel.hidden, true, "текстовая «Закрыть» показывается в подвале");
  equal(submit.hidden, false, "кнопка сохранения пропала");
  equal(actions.hidden, false, "подвал с кнопкой сохранения скрыт");
});

test("«Отмена» и значение по умолчанию остаются: это отказ от действия, не закрытие", () => {
  for (const config of [{ cancelLabel: "Отмена" }, {}]) {
    const { cancel, actions } = openWith({ title: "Правка", submitLabel: "Сохранить", ...config });
    equal(cancel.hidden, false, "«Отмена» скрыта");
    equal(actions.hidden, false, "подвал скрыт без причины");
  }
  equal(openWith({ title: "Правка" }).cancel.textContent, "Отмена", "значение по умолчанию изменилось");
});

function cssBlock(selector) {
  const start = appCss.indexOf(selector);
  ok(start !== -1, `в CSS нет правила ${selector}`);
  return appCss.slice(start, appCss.indexOf("}", start) + 1);
}

test("«×» запрашивает закрытие с подтверждением, «Отмена» закрывает напрямую", () => {
  const { document } = parseHTML(dialogHtml);
  const close = document.getElementById("item-dialog").querySelector(".icon-close");
  ok(close, "в разметке диалога нет «×»");
  equal(close.dataset.action, "request-dialog-close", "«×» не идёт через подтверждение");
  equal(close.getAttribute("aria-label"), "Закрыть", "у «×» нет подписи");
  equal(document.getElementById("dialog-cancel").dataset.action, "close-dialog", "«Отмена» перестала быть прямым закрытием");
  match(appJs, /action === "request-dialog-close"\) \{\s*requestDialogClose\(\);/);
  match(appJs, /action === "close-dialog"\) \{\s*dialog\.close\(\);/);
  // Тот же путь, что у тапа по фону и «Назад»: с правками — подтверждение.
  match(appJs, /if \(isDialogDirty\(\) && showDialogCloseConfirm\(\)\) return;/);
});

test("«×» плавает в углу окна, заголовок и содержимое прокручиваются обычно", () => {
  const { document } = parseHTML(dialogHtml);
  const dialog = document.getElementById("item-dialog");
  const close = dialog.querySelector(".icon-close");
  // Кнопка — прямой ребёнок dialog, а не потомок формы: скролл формы её не двигает.
  ok(Array.from(dialog.children).includes(close), "«×» лежит внутри прокручиваемой формы");
  equal(document.getElementById("item-form").querySelector(".icon-close"), null, "«×» осталась в форме");
  // Заголовок — в обычном потоке: никакой закреплённой полосы во всю ширину.
  const head = cssBlock(".sheet-head {");
  ok(!/position:\s*sticky/.test(head), "шапка снова закреплена полосой");
  ok(!/background:/.test(head), "шапка снова рисует полосу фоном");
  match(head, /padding-right: 40px;/, "заголовку не оставлено место под «×»");
  // «×» привязана к окну, а не к вьюпорту, и лежит выше содержимого формы.
  const closeCss = cssBlock(".icon-close {");
  match(closeCss, /position: absolute;/);
  match(closeCss, /top: 14px;/);
  match(closeCss, /right: 14px;/);
  const z = Number(closeCss.match(/z-index:\s*(\d+);/)?.[1]);
  ok(z > 0 && z < 40, `слой «×» (${z}) должен быть выше содержимого и ниже подтверждения`);
  // В печати плавающая кнопка не нужна.
  match(appCss, /#item-dialog > \.icon-close[^}]*display: none !important;/);
  // Скролл-контейнер — форма: все остальные элементы едут вместе с ней.
  ok(/\.sheet-form \{[^}]*overflow-y: auto;/.test(appCss), "форма окна не прокручивается");
});
