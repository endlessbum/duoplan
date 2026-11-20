// PD-HOME-001: состояния главной, переходы из превью, честная подпись истории.
import { test } from "node:test";
import { ok } from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const app = readFileSync(join(process.cwd(), "public/app.js"), "utf8");
const css = readFileSync(join(process.cwd(), "public/app.css"), "utf8");
const home = app.slice(app.indexOf("function renderHome()"), app.indexOf("function taskItem("));

test("awaiting_return отличается от первого приглашения", () => {
  ok(home.includes('Number(pair?.awaiting_return) === 1'), "нет проверки awaiting_return");
  ok(home.includes("Ожидание возвращения"), "нет ветки возвращения");
  ok(home.includes("Пространство ждёт вашего партнёра"), "нет заголовка возвращения");
  ok(home.includes("Отправьте код партнёру"), "первый вход остался");
  // В ветке возвращения нет кода и «пригласите впервые» — один CTA «Наша пара».
  ok(!home.includes("Код пары:"), "мёртвая ветка кода пары осталась");
});

test("превью имеют «Все →» в нужные разделы", () => {
  for (const tab of ["tasks", "dates", "memories"]) {
    ok(home.includes(`allLink("${tab}")`), `нет перехода в ${tab}`);
  }
  ok((home.match(/data-action="go-tab"/g) || []).length >= 1, "нет go-tab в карточке ожидания");
  ok((home.match(/\$\{allLink\("/g) || []).length >= 4, "не все заголовки превью получили «Все →»");
  ok(css.includes(".link-button {"), "нет стиля ссылки «Все →»");
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
