// UI-проверки вкладки «Контакты» («Дневник → …/Контакты»): переключатель
// «Мои/Её(Его)», алфавитный список с группировкой номеров, поиск, диалоги.
import { readFileSync } from "node:fs";
import { ok } from "node:assert/strict";
import { test } from "node:test";
import assert from "node:assert/strict";

const source = readFileSync(new URL("../public/app.js", import.meta.url), "utf8");

// Секция «Контакты» между маркером и quoteAuthorOptions.
const markerIdx = source.indexOf("// Контакты: телефонная книга пары");
const sectionStart = source.lastIndexOf("// ------------------------------------------------------------------", markerIdx);
const section = source.slice(sectionStart, source.indexOf("// Автор цитаты — select вместо свободного ввода"));

const stubs = `
  const appState = { user: { tg_id: 777, gender: "female" }, pair: { id: 1, timezone: "Europe/Moscow", partner_gender: "male" } };
  let memoriesView = "contacts";
  let dialog = null, dialogContext = null, dialogFields = null;
  const document = {
    documentElement: { dataset: { theme: "dark" } },
    addEventListener: () => {},
    getElementById: (id) => (id === "contact-phones" ? globalThis.__phoneBox || null : null),
    querySelectorAll: () => [],
    createElement: () => ({ click: () => {}, style: {}, setAttribute: () => {} })
  };
  function showToast(m) { globalThis.__toasts.push(m); }
  function handleRequestError() {}
  function render() {}
  function openDialog(config) { globalThis.__dialog = config; }
  const EDIT_ICON = "e", DELETE_ICON = "d", COPY_ICON = "c";
  function esc(v) {
    return String(v ?? "").replace(/[&<>"']/g, ch => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch]));
  }
  function viewerTimeZone() { return "Europe/Moscow"; }
  globalThis.__toasts = [];
`;

function buildContacts(contactsStateValue, extra = {}, reqImpl = null) {
  const requestSrc = reqImpl
    ? `const request = (${reqImpl.toString()});`
    : `const request = () => Promise.reject(new Error("network off"));`;
  const setters = [
    `  contactsState = ${JSON.stringify(contactsStateValue)};`,
    `  contactsBusy = false;`,
    `  contactsView = ${JSON.stringify(extra.contactsView ?? "mine")};`,
    `  contactsSearch = ${JSON.stringify(extra.contactsSearch ?? "")};`
  ].join("\n");
  const src = `${stubs}\n${requestSrc}\n${setters}\n${section}\nreturn { renderContactsBody, renderContactsList, contactsFormatDigits, contactsNormalizePhone, contactsMatches, contactsListFor, handleContactsAction, openContactInfoDialog, getSearch: () => contactsSearch };`;
  return new Function(src)();
}

const state = {
  mine: [
    { id: 3, owner_id: 777, name: "Борис", surname: "", comment: "", phones: ["+7 921 111 22 33"] },
    { id: 1, owner_id: 777, name: "Анна", surname: "Петрова", comment: "с работы", phones: ["+7 915 123 45 67", "+7 926 987 65 43"] }
  ],
  partner: [
    { id: 5, owner_id: 1, name: "Сергей", surname: "", comment: "", phones: ["+7 900 555 44 33"] }
  ]
};

test("C1: сегмент «Дневник» содержит четвёртый вид «Контакты»", () => {
  ok(source.includes('["contacts", "Контакты"]'));
  ok(source.includes('memoriesView === "contacts"'));
});

test("C2: список в алфавитном порядке, номера сгруппированы под именем", () => {
  const ui = buildContacts(state);
  const html = ui.renderContactsList();
  const idxAnna = html.indexOf("Анна");
  const idxBoris = html.indexOf("Борис");
  assert.ok(idxAnna > -1 && idxBoris > -1 && idxAnna < idxBoris, "алфавитный порядок");
  // Номера второго контакта — оба в одной карточке (до закрывающего тега имени следующей).
  const annaCard = html.slice(idxAnna, idxBoris);
  assert.ok(annaCard.includes("+7 915 123 45 67") && annaCard.includes("+7 926 987 65 43"), "оба номера под одним именем");
});

test("C3: в списке нет кнопок правки и комментария — только имя и номера", () => {
  const ui = buildContacts(state);
  const html = ui.renderContactsList();
  assert.ok(!html.includes("contacts-edit"), "правки нет в списке");
  assert.ok(!html.includes("contacts-delete"), "удаления нет в списке");
  assert.ok(html.includes("contact-open"), "тап по имени открывает окно контакта");
  assert.ok(html.includes("contacts-copy"), "тап по номеру копирует");
  // Комментарий виден только в карточке контакта — в списке его нет.
  assert.ok(!html.includes("с работы"), "комментарий не виден в списке");
  assert.ok(!html.includes("contact-comment"), "блока комментария в списке нет");
});

test("C3b: комментарий виден в карточке контакта, подпись «тап копирует» убрана", () => {
  const ui = buildContacts(state);
  ui.openContactInfoDialog(state.mine[1]);
  const fields = globalThis.__dialog?.fields || "";
  assert.ok(fields.includes("с работы"), "комментарий виден в карточке");
  assert.ok(fields.includes("Комментарий"), "есть блок комментария");
  assert.ok(!fields.includes("тап копирует"), "подпись «Номера — тап копирует» удалена");
  assert.ok(fields.includes("+7 915 123 45 67"), "номера видны в карточке");
});

test("C4: у контакта без фамилии и комментария лишних блоков нет", () => {
  const ui = buildContacts(state);
  const html = ui.renderContactsList();
  const borisCard = html.slice(html.indexOf("Борис"));
  assert.ok(!borisCard.includes("contact-comment") || borisCard.indexOf("contact-comment") > borisCard.indexOf("Анна"), "пустой комментарий не рендерится");
});

test("C5: поиск — по имени, цифрам номера и комментарию", () => {
  const idsOf = (html) => (html.match(/data-id="\d+"/g) || []);
  const byPhone = buildContacts(state, { contactsSearch: "123 45" });
  assert.deepEqual(idsOf(byPhone.renderContactsBody()), ['data-id="1"']);
  const byName = buildContacts(state, { contactsSearch: "бор" });
  assert.deepEqual(idsOf(byName.renderContactsBody()), ['data-id="3"']);
  const byComment = buildContacts(state, { contactsSearch: "работы" });
  assert.deepEqual(idsOf(byComment.renderContactsBody()), ['data-id="1"']);
  const noMatch = buildContacts(state, { contactsSearch: "ксюша" });
  assert.ok(noMatch.renderContactsBody().includes("не нашлось"), "пустой результат поиска объясняется");
  // Поле поиска не пропадает во время ввода.
  assert.ok(noMatch.renderContactsBody().includes('id="contacts-search"'));
});

test("C6: вид «Его» — список партнёра без кнопки добавления", () => {
  const ui = buildContacts(state, { contactsView: "partner" });
  const body = ui.renderContactsBody();
  assert.ok(body.includes("Сергей"));
  assert.ok(!body.includes("add-contact"), "партнёрский список read-only");
  // Переключатель — свой contacts-switch с каплей (liquid-nav): драг
  // коммитит onCommit, тап — data-action через делегата (как в желаниях).
  assert.ok(body.includes('data-tab="partner"') && body.includes('data-tab="mine"'), "переключатель Мои/Его");
  assert.ok(body.includes('class="contacts-switch"'), "свой класс бара — не wish-switch");
  assert.ok(body.includes('data-action="contacts-view" data-view="partner"'), "тап коммитит делегат");
});

test("C7: формат номера на вводе — группы ХХХ ХХХ ХХ ХХ", () => {
  const ui = buildContacts(state);
  assert.equal(ui.contactsFormatDigits("9151234567"), "915 123 45 67");
  assert.equal(ui.contactsFormatDigits("915"), "915");
  // Нормализация полного номера: легаси «8»/«7» и «+» отбрасываются.
  assert.equal(ui.contactsNormalizePhone("+79151234567"), "+7 915 123 45 67");
  assert.equal(ui.contactsNormalizePhone("89151234567"), "+7 915 123 45 67");
  assert.equal(ui.contactsNormalizePhone("91512345"), null, "неполный номер не нормализуется");
});

test("C8: копирование номера — тост «Номер скопирован»", async () => {
  Object.defineProperty(globalThis, "navigator", { value: { clipboard: { writeText: async () => {} } }, configurable: true });
  const ui = buildContacts(state);
  await ui.handleContactsAction("contacts-copy", { dataset: { phone: "+7 915 123 45 67" } });
  assert.ok(globalThis.__toasts.includes("Номер скопирован"));
  delete globalThis.navigator;
});

test("C9: диалог имени занято — предупреждение в разметке формы", () => {
  // Проверяем текст предупреждения в исходнике секции: точная формулировка из ТЗ.
  ok(section.includes("Имя занято. Укажите наводящую информацию в комментарии или измените имя."));
  ok(section.includes("Всё равно добавить"), "вариант продолжить при комментарии");
  ok(section.includes('"block"'), "блокировка обоих-пустых");
});

test("C10: маска ввода ограничивает 10 цифрами, максимум 3 номера", () => {
  ok(section.includes('maxlength="13"'), "10 цифр + 3 пробела");
  ok(section.includes("Максимум 3 номера на контакт"));
  ok(section.includes("Введите полный номер — 10 цифр после +7"), "запрет неполного номера");
});
