// PD-WISHES-001: личные желания, шеринг и технические правки из плана 13.
import { test } from "node:test";
import { equal, ok } from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const root = process.cwd();
const worker = readFileSync(join(root, "worker.js"), "utf8");
const app = readFileSync(join(root, "public/app.js"), "utf8");

function braced(source, signature) {
  const start = source.indexOf(signature);
  ok(start !== -1, `нет ${signature}`);
  const from = source.indexOf("{", start);
  let depth = 0;
  for (let i = from; i < source.length; i++) {
    if (source[i] === "{") depth++;
    if (source[i] === "}" && --depth === 0) return source.slice(start, i + 1);
  }
  throw new Error(`не закрыт ${signature}`);
}

test("worker: личные желания отфильтрованы в state и архиве", () => {
  ok(worker.includes("w.is_private=0"), "общие желания не отфильтрованы");
  ok(worker.includes("w.is_private=1 AND w.owner_id=?"), "личные желания не фильтруются по автору");
  ok(worker.includes("privateWishes: privateWishes.results"), "state не отдаёт privateWishes");
  ok(worker.includes('private_wishes: "SELECT COUNT(*)'), "нет счётчика личного архива");
});

test("worker: шеринг — явное действие владельца", () => {
  ok(worker.includes("deposit|share))?$"), "share не разрешён в itemRoute");
  ok(worker.includes("UPDATE wishes SET is_private=0,shared_at=? WHERE id=? AND pair_id=? AND owner_id=? AND is_private=1"), "нет UPDATE на шеринг");
  ok(worker.includes('type === "wishes" && mutating ? await ensureWishOwner(env, pair, user, id) : null'), "ensureWishOwner снят");
  ok(worker.includes('field("is_private", body.is_private === true ? 1 : 0)'), "PATCH не меняет приватность");
});

test("worker: схема и миграция 0051", () => {
  ok(worker.includes("shared_at INTEGER"), "нет колонки shared_at в CREATE TABLE");
  ok(worker.includes('["wishes", "is_private", "INTEGER NOT NULL DEFAULT 0"]'), "нет ALTER wishes.is_private");
  ok(readFileSync(join(root, "migrations/0051_private_wishes.sql"), "utf8").includes("shared_at"));
});

test("app: личные желания внутри «Мои», карточка с шерингом (уточнение 2026-11-24)", () => {
  ok(!app.includes('data-action="wish-view" data-view="private"'), "вкладка «Личные» не удалена из бара");
  ok(!app.includes('data-view="private"'), "осталась разметка вкладки «Личные»");
  ok(app.includes('action: "share-private-wish"'), "нет действия шеринга");
  ok(app.includes('mergedArchive("private_wishes"'), "личный архив не мержится");
  ok(app.includes("/share`, { method: \"POST\", body: {} }"), "нет запроса /share");
  ok(app.includes('is_private: fd.get("is_private") === "on"'), "форма не передаёт приватность");
  // Пилюля «Личное» на карточках обоих видов.
  ok(app.includes('<span class="day-chip is-private">Личное</span>'), "нет серой пилюли «Личное»");
});

test("app: технические правки 1–5,7,8", () => {
  equal((app.match(/Number\(item\.owner_id\) === Number\(appState\.user\.tg_id\)/g) || []).length >= 2, true,
    "сравнение владельца без Number()");
  ok(app.includes("const doneLabel = doneItem?.title || doneItem?.body"), "тост исполненного без body");
  ok(app.includes("const backLabel = item?.title || item?.body"), "тост возврата без body");
  const cStart = app.indexOf("function completedWishItem");
  const completedBlock = app.slice(cStart, app.indexOf("\n  function ", cStart + 10));
  ok(completedBlock.includes('action: "share-wish"'), "копирование исполненного недоступно");
  ok(app.includes("wishUrlFromInput"), "нет нормализации URL");
  ok(!/const PARTNER_LOCKED_ACTIONS = new Set\(\[[^\]]*"share-wish"/.test(app), "share-wish ошибочно заблокирован без партнёра");
  ok(app.includes("haptic();\n        showToast(backLabel"), "reopen без haptic");
});

test("wishUrlFromInput: голый домен получает https://", () => {
  const fn = new Function(`${braced(app, "function wishUrlFromInput")}\nreturn wishUrlFromInput;`)();
  equal(fn("ozon.ru/123"), "https://ozon.ru/123");
  equal(fn(" https://example.com "), "https://example.com");
  equal(fn("http://example.com"), "http://example.com");
  equal(fn(""), "");
});
