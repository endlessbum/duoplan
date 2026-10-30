// Cloudflare _headers и версионирование статических ассетов Mini App.
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { createHash } from "node:crypto";
import { ok, equal } from "node:assert/strict";
import { test } from "node:test";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const text = readFileSync(join(root, "public", "_headers"), "utf8");

function blockFor(path) {
  const lines = text.split(/\r?\n/);
  let inBlock = false;
  const out = [];
  for (const line of lines) {
    if (/^\S/.test(line)) {
      inBlock = line.trim() === path;
      continue;
    }
    if (inBlock && line.trim()) out.push(line.trim());
  }
  return out;
}

test("общее правило /* не задаёт Cache-Control", () => {
  const globalBlock = blockFor("/*");
  ok(!globalBlock.some((l) => /^Cache-Control:/i.test(l)), "Cache-Control в /* склеится с правилами для файлов");
});

test("статические ассеты задают Cache-Control отдельно", () => {
  for (const asset of ["/app.js", "/app.css", "/nav.js", "/zoom-guard.js"]) {
    ok(blockFor(asset).some((l) => /^Cache-Control:\s*public, max-age=31536000, immutable$/i.test(l)), asset);
  }
});

test("HTML-страницы явно помечены no-cache", () => {
  ok(blockFor("/*.html").some((l) => /^Cache-Control:\s*no-cache$/i.test(l)));
  ok(blockFor("/").some((l) => /^Cache-Control:\s*no-cache$/i.test(l)));
});

test("все локальные JS/CSS Mini App версионированы и совпадают с APP_VERSION", () => {
  const appHtml = readFileSync(join(root, "public", "app.html"), "utf8");
  const workerSource = readFileSync(join(root, "worker.js"), "utf8");
  const version = workerSource.match(/const APP_VERSION = "([^"]+)";/)?.[1];
  ok(version, "APP_VERSION в worker.js не найден");
  for (const asset of ["app.js", "app.css", "nav.js", "zoom-guard.js"]) {
    const ext = asset.split(".").pop();
    const attr = ext === "css" ? "href" : "src";
    const re = new RegExp(`${attr}="/${asset.replace(".", "\\.")}\\?v=${version.replace(/\./g, "\\.")}"`);
    ok(re.test(appHtml), `${asset} должен иметь ?v=${version}`);
  }
});

test("изменение содержимого ассета без изменения версии обнаруживается", () => {
  const manifestPath = join(here, "asset-hashes.json");
  const assets = ["app.js", "app.css", "nav.js", "zoom-guard.js"];
  let manifest = {};
  try {
    manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  } catch {
    manifest = {};
  }
  for (const asset of assets) {
    const buf = readFileSync(join(root, "public", asset));
    const hash = createHash("sha256").update(buf).digest("hex");
    if (manifest[asset]) {
      equal(hash, manifest[asset], `${asset}: содержимое изменилось, но версия/хеш не обновлены`);
    } else {
      manifest[asset] = hash;
    }
  }
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n");
});