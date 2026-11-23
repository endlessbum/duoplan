// PD-HOME-001: состояния главной, переходы из превью, честная подпись истории.
import { test } from "node:test";
import { ok, match, equal } from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const app = readFileSync(join(process.cwd(), "public/app.js"), "utf8");
const home = app.slice(app.indexOf("function renderHome()"), app.indexOf("function taskItem("));

test("awaiting_return отличается от первого приглашения", () => {
  ok(home.includes('Number(pair?.awaiting_return) === 1'), "нет проверки awaiting_return");
  ok(home.includes("Ожидание возвращения"), "нет ветки возвращения");
  ok(home.includes("Пространство ждёт вашего партнёра"), "нет заголовка возвращения");
  ok(home.includes("Отправьте код партнёру"), "первый вход остался");
  // В ветке возвращения нет кода и «пригласите впервые» — один CTA «Наша пара».
  ok(!home.includes("Код пары:"), "мёртвая ветка кода пары осталась");
});

// DP-HOME-001 (аудит 2026-11-23): AGENTS.md требует у превью главной явную
// ссылку «Все →» в полный раздел. До исправления этот тест закреплял её
// отсутствие и противоречил продуктовому решению.
const PREVIEW_LINKS = [
  ["Ближайшие планы", "tasks", "plans"],
  ["Значимые даты", "dates", "dates"],
  ["Дни рождения", "dates", "birthdays"],
  ["Из дневника", "memories", "memories"],
];

test("у каждого превью на главной есть «Все →» в свой раздел", () => {
  equal((home.match(/\$\{allLink\(/g) || []).length, PREVIEW_LINKS.length,
    "число ссылок «Все →» не равно числу превью");
  for (const [title, tab, view] of PREVIEW_LINKS) {
    // Ссылка стоит в том же заголовке, что и название секции, а не вне его.
    const head = home.match(new RegExp(
      `<div class="section-head-inline">\\s*<h3>${title}</h3>\\s*\\$\\{allLink\\("([a-z]+)", "([a-z]+)", "[^"]+"\\)\\}`
    ));
    ok(head, `у секции «${title}» нет ссылки «Все →» в заголовке`);
    equal(head?.[1], tab, `ссылка секции «${title}» ведёт не во вкладку «${tab}»`);
    equal(head?.[2], view, `ссылка секции «${title}» ведёт не в сегмент «${view}»`);
  }
  // Ссылка — обычная кнопка под общий делегированный обработчик go-tab;
  // сегмент (data-view) обработчик применяет до переключения вкладки, иначе
  // открывался бы последний выбранный сегмент, а не свой (решение 2026-11-23).
  match(home, /<button class="head-link" type="button" data-action="go-tab" data-tab="\$\{tab\}" data-view="\$\{view\}"/);
  match(app, /action === "go-tab"\) \{[\s\S]{0,400}?if \(btn\.dataset\.view\) setSwitchValue\(btn\.dataset\.tab, btn\.dataset\.view\);\s*switchTab\(btn\.dataset\.tab \|\| "home"\)/);
  ok(app.includes('action === "go-tab"'), "обработчик go-tab потерян");
  // Превью желаний, кино и копилок на главной нет — это продуктовое решение.
  for (const banned of ["Желания", "Кино", "Копилка"]) {
    ok(!home.includes(`<h3>${banned}`), `на главной появилось превью «${banned}»`);
  }
  // Кнопка «Наша пара» в состоянии ожидания — не превью-ссылка, она остаётся.
  ok(home.includes('data-action="go-tab" data-tab="pair"'), "нет go-tab в карточке ожидания");
});

test("герой больше не содержит недостижимую ветку", () => {
  ok(!home.includes("? `\n      <section class=\"card hero-card\""), "тернар с мёртвой веткой остался");
  ok(home.includes('<section class="card hero-card" role="button" tabindex="0" data-action="open-history"'), "герой не тапабелен");
});

test("история: накоплено только в общих копилках", () => {
  ok(app.includes('rows.push(["Накоплено в общих копилках"'), "подпись не уточнена");
});

test("ритуал и daily-инварианты не тронуты", () => {
  ok(home.includes('data-action="daily-done"'), "ритуал исчез с главной");
  ok(app.includes("daily-done"), "обработчик ритуала на месте");
  ok(home.includes("FLAME_ICON"), "серия на главной осталась");
});
