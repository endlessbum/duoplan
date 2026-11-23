// Релизный манифест ассетов (BUG-4-01, аудит 2026-11-23).
//
// `tests/asset-hashes.json` перезаписывается test_headers_cache автоматически
// и не связывает содержимое ассета с версией URL: правка app.js без подъёма
// APP_VERSION оставляла пользователей на годовом immutable-кэше прежнего URL,
// при этом все тесты были зелёными. Этот тест — только проверки (ничего не
// перезаписывает): содержимое ассетов обязано совпадать с последней записью
// релиза, последняя запись — текущий APP_VERSION, и все ?v= в app.html
// указывают на неё. При изменении ассета добавьте в releases новую запись
// (версия + хеши); записи только добавляются, не переписываются.
//
// Запуск: node --test tests/test_asset_release.test.mjs
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { equal, ok } from "node:assert/strict";
import { test } from "node:test";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");

const ASSETS = ["app.js", "app.css", "nav.js", "zoom-guard.js", "ascii-converter.js"];

function actualHashes() {
  const hashes = {};
  for (const asset of ASSETS) {
    const buf = readFileSync(join(root, "public", asset));
    hashes[asset] = createHash("sha256").update(buf).digest("hex");
  }
  return hashes;
}

function versionKey(v) {
  const parts = String(v).split(".").map(Number);
  ok(parts.length === 4 && parts.every(Number.isFinite), `некорректная версия релиза: ${v}`);
  return (parts[0] * 1000 + parts[1]) * 1000 * 1000 + parts[2] * 1000 + parts[3];
}

test("asset-release: последняя запись релиза — текущий APP_VERSION с актуальными хешами", () => {
  const workerSource = readFileSync(join(root, "worker.js"), "utf8");
  const version = workerSource.match(/const APP_VERSION = "([^"]+)";/)?.[1];
  ok(version, "APP_VERSION в worker.js не найден");

  const release = JSON.parse(readFileSync(join(here, "asset-release.json"), "utf8"));
  const entries = release.releases;
  ok(Array.isArray(entries) && entries.length >= 1, "в asset-release.json нет записей релизов");
  const keys = entries.map((entry) => versionKey(entry.version));
  ok(new Set(keys).size === keys.length, "дубли версий в asset-release.json");
  for (let i = 1; i < keys.length; i++) {
    ok(keys[i] > keys[i - 1], "записи релизов должны идти по возрастанию версии");
  }

  const last = entries[entries.length - 1];
  equal(last.version, version,
    "последняя запись asset-release.json — не текущий APP_VERSION: изменение ассетов обязано сопровождаться новой версией");

  const hashes = actualHashes();
  for (const asset of ASSETS) {
    equal(hashes[asset], last.assets[asset],
      `${asset}: содержимое отличается от релиза ${last.version} — добавьте новую запись в asset-release.json`);
  }
  // Кросс-проверка с автоперезаписываемым манифестом: два источника не должны расходиться.
  // asset-hashes.json ведёт только свои четыре ассета — для остальных ключа там нет.
  const manifest = JSON.parse(readFileSync(join(here, "asset-hashes.json"), "utf8"));
  for (const asset of ASSETS) {
    if (manifest[asset]) equal(hashes[asset], manifest[asset], `${asset}: asset-hashes.json разошёлся с файлом`);
  }
});

test("asset-release: все ?v= в app.html и index.html — текущая версия, манифестные ассеты подключены", () => {
  const workerSource = readFileSync(join(root, "worker.js"), "utf8");
  const version = workerSource.match(/const APP_VERSION = "([^"]+)";/)?.[1];
  ok(version, "APP_VERSION в worker.js не найден");
  // BUG-5-01 (аудит 2026-11-23): обе HTML-точки входа проверяются одинаково —
  // иначе можно обновить версию только в app.html и оставить устаревший ?v= в index.html.
  const pages = {
    "app.html": readFileSync(join(root, "public", "app.html"), "utf8"),
    "index.html": readFileSync(join(root, "public", "index.html"), "utf8"),
  };
  for (const [page, html] of Object.entries(pages)) {
    const refs = [...html.matchAll(/(?:src|href)="\/?([\w.-]+\.(?:js|css))\?v=([^"]+)"/g)];
    ok(refs.length >= 1, `в ${page} нет версионированных ссылок`);
    for (const [, asset, refVersion] of refs) {
      equal(refVersion, version, `${page}: ${asset}?v=${refVersion} устарел, актуально ${version}`);
    }
  }
  const appRefs = [...pages["app.html"].matchAll(/(?:src|href)="\/([\w.-]+\.(?:js|css))\?v=/g)].map((m) => m[1]);
  for (const asset of ASSETS) {
    ok(appRefs.some((name) => name === asset), `${asset} не подключён в app.html`);
  }
  ok(/src="nav\.js\?v=/.test(pages["index.html"]), "nav.js не подключён в index.html");
});
