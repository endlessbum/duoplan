// Закрытие окон (решение владельца 2026-11-23).
//
// Окно с «×» в шапке не дублирует закрытие текстовой кнопкой «Закрыть»
// в подвале: закрыть можно только «×». Кнопки «Отмена», «Нет», «Оставить»
// и т.п. остаются — это отказ от действия, а не второй способ закрыть окно.
// Сам «×» закреплён в шапке при прокрутке длинного содержимого.
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

test("«×» есть в шапке и закрывает окно тем же обработчиком, что и отмена", () => {
  match(dialogHtml, /class="icon-close" data-action="close-dialog" aria-label="Закрыть"/);
  match(appJs, /action === "close-dialog"\) \{\s*dialog\.close\(\);/);
});

test("шапка с «×» закреплена при прокрутке и непрозрачна", () => {
  const head = appCss.slice(appCss.indexOf(".sheet-head {"), appCss.indexOf("}", appCss.indexOf(".sheet-head {")) + 1);
  match(head, /position: sticky;/);
  match(head, /top: 0;/);
  // Отрицательные поля компенсируют padding формы: шапка визуально там же,
  // где была до закрепления, и закрывает прокручиваемое содержимое фоном.
  match(head, /margin: -20px -20px 0;/);
  match(head, /background: var\(--surface\);/);
  // «×» не уезжает только если скролл-контейнер — форма с прокруткой.
  ok(/\.sheet-form \{[^}]*overflow-y: auto;/.test(appCss), "форма окна не прокручивается");
});
