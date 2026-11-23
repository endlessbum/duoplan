// Закрытие окна тапом за его пределами (решение владельца 2026-11-23).
//
// Чистое окно закрывается по клику в затемнение сразу; с изменениями —
// сначала подтверждение «Продолжить» (остаться) / «Закрыть» (выйти без
// сохранения). Открытое меню «⋮» в окне ведёт себя как в списках: тап мимо
// закрывает только меню. Окно с изменениями не закрывает и Esc — только
// через то же подтверждение; повторный Esc при открытом подтверждении
// остаёт в окне.
//
// Функции извлекаются из public/app.js и выполняются на макете состояния:
// dialog/context/confirm — простые объекты, слушатели фиксируются.
//
// Запуск: node --test tests/test_dialog_backdrop.test.mjs
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { deepStrictEqual, equal, match, ok } from "node:assert/strict";
import { test } from "node:test";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const appJs = readFileSync(join(root, "public", "app.js"), "utf8");
const appHtml = readFileSync(join(root, "public", "app.html"), "utf8");
const appCss = readFileSync(join(root, "public", "app.css"), "utf8");

const start = appJs.indexOf("function isDialogDirty()");
const end = appJs.indexOf("function sureLabel()", start);
ok(start !== -1 && end !== -1, "блок закрытия окна не найден");
const fragment = appJs.slice(start, end);

function makeEnv({ context = {}, dirty = false, submitting = false, asciiInitial = null, menuOpen = false, confirmPresent = true, dialogOpen = true } = {}) {
  const listeners = { dialog: [], stay: [], leave: [], form: [] };
  const dialog = {
    open: dialogOpen,
    closed: false,
    close() { this.closed = true; this.open = false; },
    focusCalls: 0,
    focus() { this.focusCalls++; },
    addEventListener: (name, fn) => listeners.dialog.push([name, fn])
  };
  const confirm = confirmPresent ? { hidden: true, text: "" } : null;
  const confirmText = { set textContent(v) { if (confirm) confirm.text = v; } };
  const confirmStay = { focused: 0, focus() { this.focused++; }, addEventListener: (n, fn) => listeners.stay.push([n, fn]) };
  const confirmLeave = { addEventListener: (n, fn) => listeners.leave.push([n, fn]) };
  const api = new Function(
    "dialog", "dialogContext", "dialogConfirm", "dialogConfirmText", "dialogConfirmStay", "dialogConfirmLeave",
    "dialogDirty", "dialogAsciiInitialMode", "dialogSubmitting", "document", "dialogForm",
    `${fragment}\nreturn { isDialogDirty, requestDialogClose, onDialogBackdropClick, onDialogCancel, markDialogDirtyOnEdit };`
  )(
    dialog, context, confirm, confirmText, confirmStay, confirmLeave,
    dirty, asciiInitial, submitting,
    { querySelector: (sel) => (menuOpen && sel === ".item-actions.is-open" ? {} : null) },
    { addEventListener: (name, fn) => listeners.form.push([name, fn]) }
  );
  return { api, dialog, confirm, confirmStay, listeners };
}

test("чистое окно тапом по фону закрывается сразу, без подтверждения", () => {
  const { api, dialog, confirm } = makeEnv();
  api.requestDialogClose();
  deepStrictEqual({ closed: dialog.closed, confirmShown: confirm?.hidden === false }, { closed: true, confirmShown: false });
});

test("окно с вводом показывает подтверждение и не закрывается", () => {
  const { api, dialog, confirm, confirmStay } = makeEnv({ dirty: true });
  api.requestDialogClose();
  equal(dialog.closed, false, "окно закрылось мимо подтверждения");
  equal(confirm.hidden, false, "подтверждение не показано");
  equal(confirm.text, "В окне есть изменения. Закрыть без сохранения?");
  equal(confirmStay.focused, 1, "фокус не на «Продолжить»");
});

test("изменения: поля, ASCII-вложение и состояние вне формы", () => {
  equal(makeEnv({ dirty: true }).api.isDialogDirty(), true, "ввод в поля не считается изменением");
  const ascii = makeEnv({ context: { ascii: { mode: "delete" } }, asciiInitial: "keep" });
  equal(ascii.api.isDialogDirty(), true, "смена режима ASCII-вложения не считается изменением");
  const hook = makeEnv({ context: { isDirty: () => true } });
  equal(hook.api.isDialogDirty(), true, "isDirty диалога игнорируется");
  equal(makeEnv({ context: { ascii: { mode: "keep" } }, asciiInitial: "keep" }).api.isDialogDirty(), false,
    "неизменный режим ASCII считается правкой");
  equal(makeEnv({ context: { isDirty: () => false } }).api.isDialogDirty(), false, "isDirty=false трактуется как правка");
});

test("запрос в полёте: окно не закрывается и подтверждения нет", () => {
  const { api, dialog, confirm } = makeEnv({ dirty: true, submitting: true });
  api.requestDialogClose();
  deepStrictEqual({ closed: dialog.closed, confirmShown: confirm.hidden === false }, { closed: false, confirmShown: false });
});

test("клик по содержимому окна и открытое меню «⋮» окно не закрывают", () => {
  const inner = makeEnv();
  inner.api.onDialogBackdropClick({ target: {} });
  equal(inner.dialog.closed, false, "клик по содержимому закрыл окно");
  const menu = makeEnv({ menuOpen: true });
  menu.api.onDialogBackdropClick({ target: menu.dialog });
  equal(menu.dialog.closed, false, "тап мимо открытого меню закрыл окно — должен был закрыть только меню");
  const clean = makeEnv();
  clean.api.onDialogBackdropClick({ target: clean.dialog });
  equal(clean.dialog.closed, true, "тап по фону чистого окна не закрыл его");
});

test("Esc: без изменений — нативно, с изменениями — подтверждение, повторный — остаться", () => {
  const clean = makeEnv();
  const e1 = { defaultPrevented: false, preventDefault() { this.defaultPrevented = true; } };
  clean.api.onDialogCancel(e1);
  equal(e1.defaultPrevented, false, "Esc чистого окна перехвачен без причины");
  const dirty = makeEnv({ dirty: true });
  const e2 = { defaultPrevented: false, preventDefault() { this.defaultPrevented = true; } };
  dirty.api.onDialogCancel(e2);
  deepStrictEqual({ prevented: e2.defaultPrevented, open: dirty.dialog.open, shown: dirty.confirm.hidden === false },
    { prevented: true, open: true, shown: true });
  const e3 = { defaultPrevented: false, preventDefault() { this.defaultPrevented = true; } };
  dirty.api.onDialogCancel(e3);
  deepStrictEqual({ prevented: e3.defaultPrevented, open: dirty.dialog.open, shown: dirty.confirm.hidden === false },
    { prevented: true, open: true, shown: false }, "повторный Esc не скрыл подтверждение");
});

test("кнопки подтверждения: «Продолжить» остаётся, «Закрыть» покидает окно", () => {
  const { api, dialog, confirm, listeners } = makeEnv({ dirty: true });
  api.requestDialogClose();
  equal(listeners.leave.length, 1, "кнопка «Закрыть» без слушателя");
  listeners.leave[0][1]();
  deepStrictEqual({ closed: dialog.closed, shown: confirm.hidden === false }, { closed: true, shown: false });
  const { dialog: d2, confirm: c2, listeners: l2 } = makeEnv({ dirty: true });
  l2.stay[0][1]();
  deepStrictEqual({ closed: d2.closed, shown: c2.hidden === false }, { closed: false, shown: false });
});

test("ввод отмечает окно изменённым, кроме ASCII-блока", () => {
  const { api } = makeEnv();
  equal(api.isDialogDirty(), false);
  api.markDialogDirtyOnEdit({ target: { closest: () => null } });
  equal(api.isDialogDirty(), true, "ввод в поле не отметил окно");
  const ascii = makeEnv();
  ascii.api.markDialogDirtyOnEdit({ target: { closest: (sel) => (sel === ".ascii-toolbar" ? {} : null) } });
  equal(ascii.api.isDialogDirty(), false, "палитры ASCII посчитаны правкой полей");
  const closed = makeEnv({ dialogOpen: false });
  closed.api.markDialogDirtyOnEdit({ target: { closest: () => null } });
  equal(closed.api.isDialogDirty(), false, "ввод при закрытом окне что-то отметил");
});

test("слушатели навешаны: клик и cancel на окно, ввод на форму", () => {
  const { listeners } = makeEnv();
  deepStrictEqual(listeners.dialog.map(([n]) => n), ["click", "cancel"]);
  deepStrictEqual(listeners.form.map(([n]) => n), ["input", "change"]);
  deepStrictEqual(listeners.stay.map(([n]) => n), ["click"]);
});

test("открытие окна сбрасывает правки предыдущего, закрытое окно не считается изменённым", () => {
  const open = appJs.slice(appJs.indexOf("function openDialog("), appJs.indexOf("function sureLabel()"));
  match(open, /dialogDirty = false;/);
  match(open, /dialogAsciiInitialMode = config\.ascii\?\.mode \?\? null;/);
  match(open, /hideDialogCloseConfirm\(\);\s*hideDialogError\(\);\s*dialog\.showModal\(\);/);
  // Разметка тулбара вписывается в value без событий — правку отмечает сам обработчик.
  match(appJs, /applyFmtMarker\(field, btn\.dataset\.fmt\);[\s\S]{0,220}?dialogDirty = true;/);
  // Черновик менеджера группы — состояние вне формы.
  match(appJs, /isDirty: \(\) => Boolean\(movieGroupDraft\) && movieGroupDraftChanged\(\)/);
  // Кнопка «Назад» Telegram проходит тот же путь, что и тап по фону.
  match(appJs, /if \(dialog\?\.open\) \{\s*requestDialogClose\(\);\s*return;\s*\}/);
});

test("разметка и стили подтверждения на месте", () => {
  match(appHtml, /<div id="dialog-confirm" class="dialog-confirm" hidden role="alertdialog"/);
  match(appHtml, /id="dialog-confirm-stay" class="secondary">Продолжить</);
  match(appHtml, /id="dialog-confirm-leave" class="primary">Закрыть</);
  const css = appCss.slice(appCss.indexOf(".dialog-confirm {"), appCss.indexOf(".dialog-confirm-actions .secondary"));
  match(css, /position: absolute;/);
  match(css, /z-index: 40;/);
  match(css, /background: var\(--surface\);/);
  // Оверлей поверх закреплённой шапки, но под всплывающим меню карточек (z-index 30)? нет — меню выше.
  ok(!/z-index: 4[0-9];[\s\S]{0,200}z-index: 30;/.test(appCss), "меню «⋮» должно оставаться над оверлеем при его открытии");
});
