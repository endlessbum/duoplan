// Копилки: сегмент «Копилка» на вкладке «Наша пара» (public/app.js) +
// grep-охрана маршрутов worker.js.
//
// Тесты извлекают рендереры из app.js как есть (приём test_item_cards).
//
// Запуск: node tests/test_savings.test.mjs
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { deepStrictEqual, equal, ok } from "node:assert/strict";
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
    "const REOPEN_ICON = '';",
    "const DONE_ICON = '';",
    "const EDIT_ICON = '';",
    "const DELETE_ICON = '';",
    "const PLUS_ICON = '';",
    extractBraced(appSource, "function esc"),
    extractBraced(appSource, "function partnerMissing"),
    extractBraced(appSource, "function formatTimestamp"),
    extractBraced(appSource, "function formatAmount"),
    extractBraced(appSource, "function savingsList"),
    extractBraced(appSource, "function savingIsFull"),
    extractBraced(appSource, "function savingItem"),
    extractBraced(appSource, "function renderSavingsBody"),
    "return { formatAmount, savingIsFull, savingItem, renderSavingsBody, setState: (v) => { appState = v; } };"
  ].join("\n")
);
const { formatAmount, savingIsFull, savingItem, renderSavingsBody, setState } = load();

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
  ok(shared.includes(">Общая</span>"), "общая копилка без чипа is-muted");
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

test("renderSavingsBody: активные и «Накопленные» разделяются", () => {
  setState({ savings: [
    { id: 1, kind: "shared", title: "Море", target: 30000, collected: 12000 },
    { id: 2, kind: "personal", title: "Готово", target: 100, collected: 100 }
  ] });
  const body = renderSavingsBody();
  ok(body.includes("Накопленные · 1"), "секция полных копилок");
  ok(body.indexOf("Море") < body.indexOf("Накопленные"), "активные выше накопленных");
  ok(!body.includes("Пока пусто"), "пустое состояние не показано при наличии копилок");
  ok(body.includes('data-action="add-saving"'), "есть кнопка создания");
  setState({ savings: [] });
  ok(renderSavingsBody().includes("Пока пусто"), "пустой список даёт заглушку");
});

test("маршруты копилок зарегистрированы в воркере", () => {
  ok(workerSource.includes("places|movies|savings)"), "savings нет в itemRoute regex");
  ok(workerSource.includes('"/api/savings"'), "нет POST /api/savings");
  ok(workerSource.includes("/history$"), "нет GET истории пополнений");
  ok(workerSource.includes('kind=\'shared\' OR created_by=?'), "личные копилки не фильтруются по автору");
  ok(workerSource.includes("UPDATE savings SET collected=collected+?"), "collected не растёт транзакционно");
  ok(workerSource.includes("INSERT INTO savings_deposits"), "нет записи в историю пополнений");
  ok(workerSource.includes("savings: { title"), "нет PATCH-схемы копилки");
});
