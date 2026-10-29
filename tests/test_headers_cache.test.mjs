// Cloudflare _headers: одноимённые заголовки из нескольких правил склеиваются
// через запятую. Поэтому Cache-Control нельзя задавать в общем правиле /*.
//
// Запуск: node tests/test_headers_cache.test.mjs  (или node --test "tests/*.test.mjs")
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { ok } from "node:assert/strict";
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
  ok(blockFor("/app.js").some((l) => /^Cache-Control:\s*public, max-age=300$/i.test(l)));
  ok(blockFor("/app.css").some((l) => /^Cache-Control:\s*public, max-age=300$/i.test(l)));
});

test("HTML-страницы явно помечены no-cache", () => {
  ok(blockFor("/*.html").some((l) => /^Cache-Control:\s*no-cache$/i.test(l)));
  ok(blockFor("/").some((l) => /^Cache-Control:\s*no-cache$/i.test(l)));
});
