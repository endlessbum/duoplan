// UI-проверки заметок («Дневник → Записи → Воспоминания/Заметки»):
// под-бар в виде «Записи», замок пароля заметок, карточки, настройка
// пароля в карточке «Безопасность» рядом с паролем на вход (PD-NOTES-001).
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { ok } from "node:assert/strict";
import assert from "node:assert/strict";

const source = readFileSync(new URL("../public/app.js", import.meta.url), "utf8");

// Секция «Записи/Заметки»: от renderMemoriesBody до раздела «Здоровье».
const diaryStart = source.indexOf("function renderMemoriesBody");
const diaryEnd = source.indexOf("// Здоровье: личный журнал препаратов (вкладка");
const diary = source.slice(diaryStart, diaryEnd);

// Карточка «Безопасность» — от renderPairLock до следующей карточки.
const lockStart = source.indexOf("function renderPairLock");
const lockEnd = source.indexOf("// Резервная копия — отдельная карточка");
const lock = source.slice(lockStart, lockEnd);

const stubs = `
  function esc(v) {
    return String(v ?? "").replace(/[&<>"']/g, ch => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch]));
  }
  function renderRichText(v) { return esc(v); }
  function formatTimestamp(ts) { return String(ts ?? ""); }
  const EDIT_ICON = "e", DELETE_ICON = "d";
  const LINK_TEXT_ICON = "l", LINK_ICON = "k";
  function itemActions(inner) { return '<div class="item-actions">' + inner + "</div>"; }
  function itemActionButton(attrs) {
    return '<button data-action="' + attrs.action + '" data-type="' + (attrs.type || "") + '" data-id="' + (attrs.id ?? "") + '">' + attrs.label + "</button>";
  }
  function pinField(id, extraAttrs = "") { return '<input class="pin-real" id="' + id + '">'; }
  function renderPinCells() {}
  function renderSegment(key, value, options, extraClass = "") {
    return '<div class="seg-switch" data-switch="' + key + '">' +
      options.map(([id, label]) => '<button data-action="seg-switch" data-switch="' + key + '" data-tab="' + id + '"' + (id === value ? ' class="is-active"' : "") + ">" + label + "</button>").join("") +
      "</div>";
  }
  function mergedArchive(type, recent) { return recent; }
  function archiveMoreHtml(type, count) { return ""; }
  function partnerMissing() { return globalThis.__noPartner === true; }
  const __listTabs = [];
  function renderListTab(items, addAction, addLabel, emptyTitle, emptyCopy, renderer, allowWithoutPartner = false) {
    __listTabs.push({ addAction, addLabel, allowWithoutPartner, items });
    return '<div data-add="' + addAction + '"' + (partnerMissing() && !allowWithoutPartner ? ' class="is-disabled"' : "") + ">" + items.map(renderer).join("") + "</div>";
  }
  function memoryItem(item) { return "<memory>" + esc(item.title || item.body) + "</memory>"; }
  function handleRequestError() {}
  function render() { globalThis.__renders += 1; }
  function showToast(m) { globalThis.__toasts.push(m); }
  globalThis.__toasts = [];
  globalThis.__renders = 0;
  const request = () => Promise.reject(new Error("network off"));
`;

function buildDiary({ diaryViewValue = "memories", notesPin = "", appPin = "", notesUnlockedValue = false, notesStateValue = null, memories = [] } = {}) {
  const src = `
    ${stubs}
    let diaryView = ${JSON.stringify(diaryViewValue)};
    let notesUnlocked = ${notesUnlockedValue ? "true" : "false"};
    let notesState = ${JSON.stringify(notesStateValue)};
    let notesBusy = false;
    let memoriesView = "memories";
    const appState = { memories: ${JSON.stringify(memories)} };
    const storedNotesPin = () => ${JSON.stringify(notesPin)};
    ${diary}
    return { renderMemoriesBody, renderNotesBody, renderNotesLock, renderNotesList, noteItem, getToasts: () => globalThis.__toasts, getListTabs: () => __listTabs };
  `;
  return new Function(src)();
}

function buildLock({ notesPin = "", appPin = "" } = {}) {
  const src = `
    ${stubs}
    const storedPin = () => ${JSON.stringify(appPin)};
    const storedNotesPin = () => ${JSON.stringify(notesPin)};
    ${lock}
    return { renderPairLock };
  `;
  return new Function(src)();
}

test("вид «Записи» содержит под-бар «Воспоминания / Заметки»", () => {
  const ui = buildDiary();
  const html = ui.renderMemoriesBody();
  ok(html.includes('data-switch="diary"'), "под-бар diary присутствует");
  ok(html.includes(">Воспоминания<"), "вид воспоминаний");
  ok(html.includes(">Заметки<"), "вид заметок");
  ok(html.includes('id="diary-body"'), "тело под-бара перерисовывается отдельно");
  ok(html.includes('data-add="add-memory"'), "воспоминания — прежний список записей");
});

test("вид «Заметки» без пароля: замок не показывается, ведёт в настройки", () => {
  const ui = buildDiary({ diaryViewValue: "notes" });
  const html = ui.renderNotesBody();
  ok(html.includes("Нужен пароль заметок"), "объяснение, зачем пароль");
  ok(!html.includes("pin-real"), "без пароля поле ввода не показывается");
  ok(!html.includes("data-add=\"add-note\""), "создание недоступно до пароля");
  ok(html.includes('data-action="go-tab" data-tab="pair"'), "переход в «Наша пара»");
  ok(html.includes('data-view="profile"'), "открывает именно «Профиль»");
});

test("вид «Заметки» с паролем и без разблокировки: тот же экран ввода, что у входа", () => {
  const ui = buildDiary({ diaryViewValue: "notes", notesPin: "1234" });
  const html = ui.renderNotesBody();
  ok(html.includes("Введите пароль заметок"), "заголовок замка");
  ok(html.includes('id="notes-lock-pin"'), "PIN-поле заметок");
  ok(html.includes('id="notes-lock-form"'), "форма ввода");
  ok(html.includes("Неверный пароль. Попробуйте ещё раз."), "сообщение об ошибке");
  ok(!html.includes('data-action="add-note"'), "список скрыт до ввода");
});

test("после ввода пароля: список заметок, создание доступно без партнёра", () => {
  const ui = buildDiary({
    diaryViewValue: "notes",
    notesPin: "1234",
    notesUnlockedValue: true,
    notesStateValue: { notes: [{ id: 1, title: "Личное", body: "текст", comment: "", updated_at: 100 }] }
  });
  const html = ui.renderNotesBody();
  ok(html.includes('data-add="add-note"'), "кнопка создания");
  ok(html.includes("Личное"), "карточка заметки");
  ok(html.includes('data-action="open-note"'), "карточка открывает чтение");
  ok(html.includes('data-type="notes"'), "правка/удаление идут по типу notes");
  const tab = ui.getListTabs().at(-1);
  ok(tab.allowWithoutPartner === true, "заметки личные — без партнёра доступны");
});

test("сбой загрузки заметок предлагает повтор", () => {
  const ui = buildDiary({
    diaryViewValue: "notes",
    notesPin: "1234",
    notesUnlockedValue: true,
    notesStateValue: { failed: true }
  });
  const html = ui.renderNotesBody();
  ok(html.includes('data-action="notes-retry"'), "кнопка повторной попытки");
});

test("карточка «Безопасность»: пароль заметок рядом с паролем на входа, независимы", () => {
  // Оба не заданы: две кнопки «Задать», два поля.
  const empty = buildLock().renderPairLock();
  ok(empty.includes("Пароль на вход"), "первая настройка");
  ok(empty.includes("Пароль заметок"), "вторая настройка");
  ok(empty.includes('id="pin-input"') && empty.includes('id="notes-pin-input"'), "два PIN-поля");
  const задать = empty.match(/data-action="save-pin"|data-action="save-notes-pin"/g) || [];
  ok(задать.length === 2, "каждая настройка задаётся своей кнопкой");
  ok(empty.includes('data-action="save-pin"') && empty.includes('data-action="save-notes-pin"'));

  // Задан только пароль заметок: у входа остаётся «Задать», у заметок «Удалить».
  const onlyNotes = buildLock({ notesPin: "4321" }).renderPairLock();
  ok(onlyNotes.includes('data-action="save-pin"'), "пароль на вход не обязателен при сохранении пароля заметок");
  ok(onlyNotes.includes('data-action="clear-notes-pin"'), "заданный пароль заметок можно убрать");

  // Задан только пароль на вход: зеркально.
  const onlyApp = buildLock({ appPin: "1111" }).renderPairLock();
  ok(onlyApp.includes('data-action="clear-pin"'), "пароль на входа можно убрать");
  ok(onlyApp.includes('data-action="save-notes-pin"'), "пароль заметок задаётся отдельно");
});

test("диалог новой заметки: Название, Описание, Комментарий", () => {
  // Поля диалога заданы литерально в обработчике add-note — проверяем разметку.
  const addNoteIdx = source.indexOf('action === "add-note"');
  const addNote = source.slice(addNoteIdx, source.indexOf('} else if (action === "add-wish")', addNoteIdx));
  ok(addNote.includes("<span>Название</span>"), "поле «Название»");
  ok(addNote.includes("<span>Описание (необязательно)</span>"), "поле «Описание»");
  ok(addNote.includes("<span>Комментарий (необязательно)</span>"), "поле «Комментарий»");
  ok(addNote.includes('name="title"') && addNote.includes('name="body"') && addNote.includes('name="comment"'), "три поля уходят на сервер");
});

// Уточнение владельца 2026-11-24: удаление пароля подтверждается тем же кодом;
// новый пароль задаётся после удаления штатной кнопкой «Задать».
test("удаление пароля требует текущий код — и для входа, и для заметок", () => {
  const clearPinIdx = source.indexOf('action === "clear-pin"');
  const clearPin = source.slice(clearPinIdx, source.indexOf("} else if", clearPinIdx));
  ok(clearPin.includes("openDialog"), "удаление пароля на вход без окна подтверждения");
  ok(clearPin.includes('pinField("clear-pin-confirm")'), "нет PIN-поля подтверждения");
  ok(clearPin.includes("value !== storedPin()"), "нет сверки с текущим паролем");
  ok(clearPin.includes('localStorage.removeItem(PIN_KEY)'), "пароль не удаляется");
  ok(clearPin.includes("можно задать новый пароль кнопкой «Задать»"), "нет подсказки про установку нового");

  const clearNotesIdx = source.indexOf('action === "clear-notes-pin"');
  const clearNotes = source.slice(clearNotesIdx, source.indexOf("} else if", clearNotesIdx));
  ok(clearNotes.includes("openDialog"), "удаление пароля заметок без окна подтверждения");
  ok(clearNotes.includes('pinField("clear-notes-pin-confirm")'), "нет PIN-поля подтверждения заметок");
  ok(clearNotes.includes("value !== storedNotesPin()"), "нет сверки с текущим паролем заметок");
  ok(clearNotes.includes('localStorage.removeItem(NOTES_PIN_KEY)'), "пароль заметок не удаляется");
  ok(clearNotes.includes("notesUnlocked = false"), "замок заметок не снимается после удаления");
});

test("замок заметок центрируется в видимой области вкладки", () => {
  // mountNotesLock измеряет фактический отступ сверху и переопределяет
  // min-height: базовые 100dvh от корня уводили карточку за нижний край.
  const mountIdx = source.indexOf("function mountNotesLock");
  const mount = source.slice(mountIdx, source.indexOf("async function loadNotes", mountIdx));
  ok(mount.includes('form.closest(".lock-wrap")'), "нет обращения к обёртке замка");
  ok(mount.includes("getBoundingClientRect().top"), "отступ сверху не измеряется");
  ok(mount.includes("wrap.style.minHeight"), "min-height не переопределяется");
  ok(mount.includes("104px"), "зона нижней навигации не учтена");
});

// Уточнение владельца 2026-11-24: у заметки есть ссылка — карточка с кнопкой
// «Ссылка» и копированием в меню, как у желаний.
test("карточка заметки со ссылкой: кнопка на карточке и копирование в меню", () => {
  const ui = buildDiary({
    diaryViewValue: "notes",
    notesPin: "1234",
    notesUnlockedValue: true,
    notesStateValue: { notes: [{ id: 1, title: "С ссылкой", body: "", comment: "", url: "https://example.com/x", updated_at: 100 }, { id: 2, title: "Без ссылки", body: "", comment: "", url: "", updated_at: 90 }] }
  });
  const html = ui.renderNotesBody();
  ok(html.includes('data-action="open-url" data-url="https://example.com/x"'), "нет кнопки «Ссылка» на карточке");
  ok((html.match(/>Ссылка<\/button>/g) || []).length === 1, "кнопка «Ссылка» только у заметки со ссылкой");
  ok(html.includes('data-action="copy-note-link"'), "нет копирования ссылки в меню ⋮");
  ok(html.includes('data-action="open-note"'), "карточка остаётся кликабельной для чтения");
});

test("диалоги заметки принимают ссылку: поле url и нормализация https://", () => {
  const addNoteIdx = source.indexOf('action === "add-note"');
  const addNote = source.slice(addNoteIdx, source.indexOf("} else if", addNoteIdx));
  ok(addNote.includes("<span>Ссылка (необязательно)</span>"), "в форме создания нет поля ссылки");
  ok(addNote.includes('name="url"'), "поле url не уходит на сервер");
  ok(addNote.includes('wishUrlFromInput(fd.get("url"))'), "ссылка без схемы не дополняется https://");

  const editItemIdx = source.indexOf('action === "edit-item"');
  const editIdx = source.indexOf('type === "notes"', editItemIdx);
  const editNote = source.slice(editIdx, source.indexOf("} else if", editIdx));
  ok(editNote.includes("<span>Ссылка (необязательно)</span>"), "в форме правки нет поля ссылки");
  ok(editNote.includes('value="${esc(item.url || "")}"'), "текущая ссылка не подставляется в форму");
  ok(editNote.includes('wishUrlFromInput(fd.get("url"))'), "правка не нормализует ссылку");
});

// Свайп по экрану при открытом меню «⋮» закрывает его; свайп внутри
// прокручиваемого меню — нет (PD-MENU-001).
test("меню «⋮» закрывается свайпом вне меню", () => {
  const swipeIdx = source.indexOf('document.addEventListener("touchstart"');
  const swipe = source.slice(swipeIdx, source.indexOf('document.addEventListener("touchcancel"', swipeIdx));
  ok(swipe.includes("closeItemMenus()"), "свайп не закрывает меню");
  ok(swipe.includes('closest?.(".item-menu")'), "свайп внутри меню закрывает его — прокрутка ломана");
  ok(swipe.includes(".item-actions.is-open"), "обработчик не проверяет открытое меню");
});
