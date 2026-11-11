// Регрессии к дефектам аудита 2026-11-06 (worker.js / public/app.js).
//
// Проверки уровня исходника — в стиле остальных тестов tests/*.test.mjs:
//
// * joinPair: batch коммитит все операторы даже при changes=0 у UPDATE pairs —
//   pair_members/users.pair_id писались «фантомно». Теперь они условны на
//   EXISTS(SELECT 1 FROM pairs WHERE id=? AND user_b=?) внутри того же batch.
// * Пустой PATCH несуществующей записи возвращал 200 — теперь 404.
// * PATCH savings принимал target < collected — теперь TARGET_BELOW_COLLECTED.
// * wishes.url писался как '' вместо NULL — нормализовано в обоих местах.
// * Окно ежегодного повтора дат на клиенте было +9 лет, на сервере/боте +8.
// * goal-item-done/goal-item-reopen отсутствовали в PARTNER_LOCKED_ACTIONS.
// * Вкладка «Дни рождения» не имела archiveMoreHtml — архив недостижим.
//
// Запуск: node --test tests/test_audit_2026_11_06.test.mjs
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { match, ok } from "node:assert/strict";
import { test } from "node:test";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const worker = readFileSync(join(root, "worker.js"), "utf8");
const appJs = readFileSync(join(root, "public", "app.js"), "utf8");

test("joinPair: pair_members/users условны на успешный UPDATE pairs", () => {
  const start = worker.indexOf("async function joinPair(");
  const body = worker.slice(start, worker.indexOf("async function leavePair", start));
  ok(
    /INSERT INTO pair_members[\s\S]*?WHERE EXISTS\(SELECT 1 FROM pairs WHERE id=\? AND user_b=\?\)/.test(body),
    "pair_members INSERT должен быть условным на заполненную пару"
  );
  ok(
    /UPDATE users SET pair_id=\?,role='b'[\s\S]*?AND EXISTS\(SELECT 1 FROM pairs WHERE id=\? AND user_b=\?\)/.test(body),
    "UPDATE users должен быть условным на заполненную пару"
  );
});

test("leavePair: внуки удаляются явно до родителей", () => {
  const start = worker.indexOf("async function leavePair(");
  const body = worker.slice(start, worker.indexOf("async function dailyFor", start));
  const ratingsAt = body.indexOf("DELETE FROM movie_ratings");
  const moviesAt = body.indexOf("DELETE FROM movies WHERE pair_id=?");
  const depositsAt = body.indexOf("DELETE FROM savings_deposits");
  const savingsAt = body.indexOf("DELETE FROM savings WHERE pair_id=?");
  ok(ratingsAt !== -1 && ratingsAt < moviesAt, "movie_ratings должны удаляться до movies");
  ok(depositsAt !== -1 && depositsAt < savingsAt, "savings_deposits должны удаляться до savings");
});

test("пустой PATCH несуществующей записи — 404, а не 200", () => {
  const start = worker.indexOf("async function itemRoute(");
  const body = worker.slice(start, worker.indexOf("async function api(", start));
  match(body, /if \(!fields\.length\) \{[\s\S]*?NOT_FOUND/);
});

test("PATCH savings: цель не ниже собранной суммы", () => {
  match(worker, /TARGET_BELOW_COLLECTED/);
  match(worker, /SELECT id,collected FROM savings/);
});

test("wishes.url нормализуется к NULL при POST и PATCH", () => {
  const post = worker.indexOf('INSERT INTO wishes(pair_id,owner_id,body,url,comment,created_at)');
  ok(post !== -1, "POST wishes не найден");
  match(worker, /const wishLink = wishUrl\(body\.url\) \|\| null/);
  // Уточнение к желанию пишется тем же INSERT, пустое значение — NULL.
  match(worker, /const wishComment = clean\(body\.comment\) \|\| null/);
  // В PATCH ветке wishes — тоже || null (places уже так делал).
  const patchStart = worker.indexOf("async function itemRoute(");
  const patchBody = worker.slice(patchStart, worker.indexOf("async function api(", patchStart));
  ok(
    (patchBody.match(/field\("url", wishUrl\(body\.url\) \|\| null\)/g) || []).length >= 1,
    "PATCH wishes должен писать url как NULL, а не ''"
  );
});

test("окно ежегодного повтора дат совпадает с worker/ботом (+8 лет)", () => {
  // nextOccurrence для recurs-дат: worker length:9 → currentYear..+8,
  // Python range(9) — то же. Плановый yearlyNext остаётся +9 (range(10)).
  const occurrences = appJs.match(/for \(let year = currentYear; year <= currentYear \+ \d; year\+\+\)/g) || [];
  ok(occurrences.includes("for (let year = currentYear; year <= currentYear + 8; year++)"),
    "должно быть окно +8 для дат");
  ok(occurrences.includes("for (let year = currentYear; year <= currentYear + 9; year++)"),
    "должно остаться окно +9 для планов");
});

test("goal-item действия заблокированы при отсутствующем партнёре", () => {
  const set = appJs.match(/const PARTNER_LOCKED_ACTIONS = new Set\(\[([\s\S]*?)\]\)/);
  ok(set, "PARTNER_LOCKED_ACTIONS не найден");
  ok(set[1].includes('"goal-item-done"'), "goal-item-done должен быть в списке");
  ok(set[1].includes('"goal-item-reopen"'), "goal-item-reopen должен быть в списке");
});

test("вкладка «Дни рождения» имеет пагинацию архива", () => {
  const birthdaysBranch = appJs.match(/if \(datesView === "birthdays"\) \{[\s\S]*?\n    \}/);
  ok(birthdaysBranch, "ветка birthdays не найдена");
  ok(
    birthdaysBranch[0].includes('archiveMoreHtml("dates"'),
    "archiveMoreHtml(\"dates\") должен быть и в birthdays-ветке"
  );
});
