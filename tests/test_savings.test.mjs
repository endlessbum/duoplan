// Копилки: сегмент «Копилка» на вкладке «Наша пара» (public/app.js) +
// grep-охрана маршрутов worker.js.
//
// Тесты извлекают рендереры из app.js как есть (приём test_item_cards).
//
// Запуск: node tests/test_savings.test.mjs
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { deepStrictEqual, equal, ok, throws } from "node:assert/strict";
import { test } from "node:test";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const appSource = readFileSync(join(root, "public/app.js"), "utf8");
const workerSource = readFileSync(join(root, "worker.js"), "utf8");

function extractBraced(text, declaration) {
  const start = text.indexOf(declaration);
  if (start === -1) throw new Error(`${declaration} не найдено`);
  let depth = 0;
  for (let j = text.indexOf("{", start); j < text.length; j++) {
    if (text[j] === "{") depth++;
    else if (text[j] === "}") {
      depth--;
      if (depth === 0) return text.slice(start, j + 1);
    }
  }
  throw new Error(`незакрытый блок: ${declaration}`);
}

const load = new Function(
  [
    "let appState = { savings: [] };",
    // Вид копилки («Копим/Накоплено»).
    "let savingsView = 'saving';",
    // savingsList() читает mergedArchive — стаб возвращает недавние как есть.
    "const mergedArchive = (type, recent) => recent || [];",
    "const archiveMoreHtml = () => \"\";",
    "const REOPEN_ICON = '';",
    "const DONE_ICON = '';",
    "const EDIT_ICON = '';",
    "const DELETE_ICON = '';",
    "const PLUS_ICON = '';",
    extractBraced(appSource, "function esc"),
    extractBraced(appSource, "function itemActionButton"),
    extractBraced(appSource, "function itemActions"),
    extractBraced(appSource, "function partnerMissing"),
    extractBraced(appSource, "function formatTimestamp"),
    extractBraced(appSource, "function formatAmount"),
    extractBraced(appSource, "function savingsList"),
    extractBraced(appSource, "function savingIsFull"),
    extractBraced(appSource, "function savingItem"),
    extractBraced(appSource, "function renderSegment"),
    extractBraced(appSource, "function renderSavingsList"),
    extractBraced(appSource, "function renderSavingsBody"),
    "return { formatAmount, savingIsFull, savingItem, renderSavingsBody, setState: (v) => { appState = v; }, setView: (v) => { savingsView = v; } };"
  ].join("\n")
);
const { formatAmount, savingIsFull, savingItem, renderSavingsBody, setState, setView } = load();

// Intl.NumberFormat("ru-RU") разделяет тысячи неразрывным пробелом (U+00A0).
const NBSP = "\u00A0";

test("formatAmount: разрядка тысяч по ru-RU", () => {
  equal(formatAmount(30000), `30${NBSP}000`);
  equal(formatAmount(500), "500");
  equal(formatAmount("12000"), `12${NBSP}000`);
  equal(formatAmount(null), "0");
});

test("savingIsFull: накоплено >= цели", () => {
  equal(savingIsFull({ collected: 30000, target: 30000 }), true, "ровно цель — полная");
  equal(savingIsFull({ collected: 35000, target: 30000 }), true, "перебор — полная");
  equal(savingIsFull({ collected: 29999, target: 30000 }), false, "до цели — активная");
});

test("savingItem: пилюля типа, собрано/цель, прогресс и три кнопки", () => {
  const shared = savingItem({ id: 1, kind: "shared", title: "Море", target: 30000, collected: 12000 });
  ok(!shared.includes(">Общая</span>"), "у общей копилки пилюли типа нет");
  ok(!shared.includes(">Личная</span>"), "у общей копилки пилюли типа нет");
  ok(shared.includes(`12${NBSP}000`), "собрано");
  ok(shared.includes(`из 30${NBSP}000`), "цель");
  ok(shared.includes('width:40%'), "прогресс 12000/30000 = 40%");
  for (const action of ["deposit-saving", "edit-saving", "delete-item"]) {
    ok(shared.includes(`data-action="${action}"`), action);
  }
  ok(shared.includes('data-action="open-saving"'), "карточка кликабельна — история");
  const personal = savingItem({ id: 2, kind: "personal", title: "Ноутбук", target: 100000, collected: 100000 });
  ok(personal.includes(">Личная</span>"), "личная помечена");
  ok(personal.includes("saving-full"), "полная копилка помечена");
  ok(personal.includes("width:100%"), "прогресс не превышает 100%");
  // У полной копилки остались только кнопки удаления: пополнять и править нечего.
  ok(personal.includes('data-action="delete-item"'), "у полной есть удаление");
  ok(!personal.includes("deposit-saving") && !personal.includes("edit-saving"), "у полной не должно быть «Плюс» и «Редактировать»");
  // Нулевая цель не роняет карточку (деление на ноль).
  const bare = savingItem({ id: 3, kind: "personal", title: "x", target: 0, collected: 0 });
  ok(bare.includes("width:0%"), "нулевая цель — прогресс 0");
});

test("renderSavingsBody: бар «Копим/Накоплено», общие и личные в одном списке", () => {
  setState({ savings: [
    { id: 1, kind: "shared", title: "Море", target: 30000, collected: 12000 },
    { id: 2, kind: "shared", title: "Свадьба", target: 100, collected: 100 },
    { id: 3, kind: "personal", title: "Ноутбук", target: 1000, collected: 100 }
  ] });
  setView("saving");
  const body = renderSavingsBody();
  // Один внутренний бар с каплей — вид; охвата «Наши/Мои» нет.
  ok(body.includes('data-switch="savings"'), "бар «Копим/Накоплено»");
  ok(body.includes(">Копим</button>") && body.includes(">Накоплено</button>"), "подписи вида");
  ok(!body.includes('data-switch="savingsScope"'), "лишнего бара «Наши/Мои» нет");
  ok(!body.includes(">Наши</button>") && !body.includes(">Мои</button>"), "подписей охвата нет");
  // «Копим»: общие и личные копилки в одном списке, различаются пилюлями.
  ok(body.includes("Море") && body.includes("Ноутбук"), "общие и личные в одном списке");
  ok(body.includes(">Личная</span>"), "пилюля личной копилки");
  ok(!body.includes(">Общая</span>"), "у общих копилок пилюли нет");
  ok(!body.includes("Свадьба"), "полная копилка не в «Копим»");
  ok(!body.includes("Пока пусто"), "пустое состояние не показано при наличии копилок");
  ok(body.includes('data-action="add-saving"'), "есть кнопка создания");

  // «Накоплено»: полная копилка, копить уже нечего.
  setView("saved");
  const saved = renderSavingsBody();
  ok(saved.includes("Свадьба"), "полная копилка в «Накоплено»");
  ok(!saved.includes("Море") && !saved.includes("Ноутбук"), "неполные не в «Накоплено»");
  ok(!saved.includes('data-action="add-saving"'), "в «Накоплено» копить нечего");

  setView("saving");
  setState({ savings: [] });
  const empty = renderSavingsBody();
  ok(empty.includes("Пока пусто"), "пустой список даёт заглушку");
  ok(empty.includes("Создать копилку"), "в пустом «Копим» есть кнопка создания");
});

test("бар «Копим / Накоплено» подключён по образцу планов", () => {
  ok(/let savingsView = "saving";/.test(appSource), "нет состояния savingsView");
  ok(/if \(key === "savings"\) return savingsView;/.test(appSource), "switchValue не знает savings");
  ok(/else if \(key === "savings"\) savingsView = value;/.test(appSource), "setSwitchValue не знает savings");
  ok(/renderSegment\("savings", savingsView, \[\["saving", "Копим"\], \["saved", "Накоплено"\]\], "is-sub"\)/.test(appSource), "внутренний бар копилки не найден");
  ok(/getElementById\("savings-body"\)/.test(appSource), "commitSwitch не меняет список копилок");
  ok(/commitSwitch\("savings", value, savingsSwitch\)/.test(appSource), "фолбэк-клик не ведёт к экземпляру капли копилок");
  ok(/mountSavingsSwitch\(\);/.test(appSource), "mountSavingsSwitch не вызывается из render()");
  ok(/if \(savingsSwitch\) \{ savingsSwitch\.destroy\(\); savingsSwitch = null; \}/.test(appSource), "savingsSwitch не снимается в destroySwitches");
  ok(/if \(key === "pair" && savingsSwitch\) \{/.test(appSource), "savingsSwitch не снимается при смене вида вкладки");
  ok(/if \(pairView === "savings"\) mountSavingsSwitch\(\);/.test(appSource), "капля копилки не перемонтируется после смены вида вкладки");
});

test("у общих копилок нет пилюли типа, у личных — есть", () => {
  const shared = savingItem({ id: 1, kind: "shared", title: "Море", target: 30000, collected: 12000 });
  ok(!shared.includes("day-chip"), "у общей копилки осталась пилюля типа");
  const personal = savingItem({ id: 2, kind: "personal", title: "Ноутбук", target: 1000, collected: 100 });
  ok(personal.includes(">Личная</span>"), "у личной копилки нет пилюли «Личная»");
});

test("маршруты копилок зарегистрированы в воркере", () => {
  ok(workerSource.includes("places|trips|goals|goal_items|movies|savings)"), "savings нет в itemRoute regex");
  ok(workerSource.includes('"/api/savings"'), "нет POST /api/savings");
  ok(workerSource.includes("/history$"), "нет GET истории пополнений");
  ok(workerSource.includes('kind=\'shared\' OR created_by=?'), "личные копилки не фильтруются по автору");
  ok(workerSource.includes("UPDATE savings SET collected=collected+?"), "collected не растёт транзакционно");
  ok(workerSource.includes("INSERT INTO savings_deposits"), "нет записи в историю пополнений");
  ok(workerSource.includes("savings: { title"), "нет PATCH-схемы копилки");
});

// moneyAmount: дробные суммы отклоняются явно, а не тихо floor-ятся
// (репорт аудита 2026-11-06: 125.90 превращался в 125 незаметно).
const loadMoneyAmount = new Function(
  [
    extractBraced(workerSource, "class HttpError"),
    extractBraced(workerSource, "function moneyAmount"),
    "return moneyAmount;"
  ].join("\n")
);
const moneyAmount = loadMoneyAmount();

test("moneyAmount: дробная сумма — 400, данные не искажаются", () => {
  throws(() => moneyAmount(125.9, "Цель"),
    (error) => error.status === 400 && error.code === "INVALID_AMOUNT");
  throws(() => moneyAmount("125,90", "Цель"),
    (error) => error.status === 400, "строка с запятой не число — тоже отказ");
  throws(() => moneyAmount(0, "Цель"), (error) => error.status === 400);
  throws(() => moneyAmount(-5, "Цель"), (error) => error.status === 400);
  equal(moneyAmount(125, "Цель"), 125);
  equal(moneyAmount("30000", "Цель"), 30000);
});

// Пополнение при гонке «копилку удалили»: UPDATE первым, INSERT под EXISTS —
// FK-отказ давал 500 вместо честного 404 (репорт аудита 2026-11-06).
test("deposit: INSERT под EXISTS, UPDATE решает 404", () => {
  ok(workerSource.includes("WHERE EXISTS(SELECT 1 FROM savings WHERE id=? AND pair_id=?)"),
    "INSERT пополнения не защищён EXISTS");
  ok(workerSource.includes('if (!batchResults[0].meta.changes) throw new HttpError(404, "Копилка не найдена"'),
    "404 должен решаться по UPDATE, а не по второму элементу batch");
});
