// PD-SAVINGS-001 + PD-FLO-001: план 14 (копилки) и 15 (Фло).
import { test } from "node:test";
import { ok } from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const root = process.cwd();
const worker = readFileSync(join(root, "worker.js"), "utf8");
const app = readFileSync(join(root, "public/app.js"), "utf8");
const bot = readFileSync(join(root, "duoplan/handlers.py"), "utf8");

test("savings: редактирование полной копилки и подсказка с валидацией", () => {
  ok(/const actions = \[\s*\.\.\.\(full \? \[\] : \[itemActionButton\(\{ action: "deposit-saving"/.test(app), "у полной осталось редактирование");
  ok(app.includes("Сейчас собрано ${esc(formatAmount(saving.collected))}. Цель не может быть меньше собранной суммы."), "нет подсказки об amount");
  ok(app.includes("Цель не может быть меньше уже собранной суммы"), "нет client-side проверки");
  ok(worker.includes('"TARGET_BELOW_COLLECTED"'), "серверная проверка снята");
});

test("savings: пагинация истории и гонка-защита", () => {
  ok(worker.includes(" OFFSET ?"), "история без OFFSET");
  ok(worker.includes("return json({ deposits: rows, hasMore, page });"), "нет флага hasMore");
  ok(app.includes('data-action="saving-history-more"'), "нет кнопки «Показать ещё»");
  ok(app.includes("if (dialogContext !== context || !dialog.open) return;"), "гонка-защита снята");
});

test("savings: смена kind только автором", () => {
  ok(worker.includes("kind: { type: \"string\", enum: [\"shared\", \"personal\"] }"), "PATCH kind не валидируется");
  ok(worker.includes("field(\"kind\", body.kind)"), "kind не пишется в UPDATE");
  ok(worker.includes("Сделать копилку личной может только её автор"), "нет guard автора");
  ok(app.includes('name="kind"'), "в форме нет выбора видимости");
});

test("flo: полное удаление чистит догруженные месяцы", () => {
  const start = app.indexOf('action === "flo-delete-confirm"');
  const block = app.slice(start, start + 1200);
  ok(block.includes("floExtra = { periods: [], logs: [], meds: [], med_logs: [], measurements: [] }"), "floExtra не сброшен");
  ok(block.includes("floFetchedMonths = new Set()"), "floFetchedMonths не сброшен");
});

test("flo: armed-состояние не живёт дольше экрана", () => {
  ok(app.includes("floDeleteArmed = false;\n    floView = value;"), "commitFloView не сбрасывает armed");
  ok(app.includes("floView = \"today\";\n      floDeleteArmed = false;"), "flo-goto-period не сбрасывает armed");
});

test("flo: нейтральный текст, дисклеймер и подтверждение шеринга", () => {
  ok(app.includes("Партнёр пока не делится календарём"), "старый текст в app.js");
  ok(bot.includes("Партнёр пока не делится календарём"), "старый текст в боте");
  ok(app.includes("Это не то же самое, что «Здоровье → Препараты» в Дневнике"), "нет дисклеймера о втором журнале");
  ok(app.includes("Подтвердите состав в окне «Настроить»"), "нет подсказки о share_confirmed");
  ok(!app.includes("Партнёрша пока не делится"), "остался старый текст");
});

test("flo: owner-endpoints не открываются по share", () => {
  ok(worker.includes("CYCLE_FORBIDDEN"), "guard доступности снят");
  ok(worker.includes('url.pathname === "/api/cycle/partner"'), "нет partner endpoint");
});
