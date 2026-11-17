// BUG-02 (аудит 2026-11-17): лимит тела JSON считался в UTF-16 code units
// (text.length), а не в байтах UTF-8 — многоязычный JSON обходил лимит
// почти вдвое. Теперь readJson читает request.body потоком и суммирует
// value.byteLength, отменяя чтение при переполнении.
//
// Запуск: node --test tests/test_body_limit.test.mjs
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { deepStrictEqual as deepEqual, equal, rejects } from "node:assert/strict";
import { test } from "node:test";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const source = readFileSync(join(root, "worker.js"), "utf8");

function extractConst(name) {
  const found = source.match(new RegExp(`const ${name} = [\\s\\S]*?;\\n`))?.[0];
  if (!found) throw new Error(`${name} не найдена`);
  return found;
}
function extractFn(name) {
  let start = source.indexOf(`async function ${name}(`);
  if (start < 0) start = source.indexOf(`function ${name}(`);
  if (start < 0) throw new Error(`${name} не найдена`);
  let depth = 0;
  for (let i = source.indexOf("{", start); i < source.length; i++) {
    if (source[i] === "{") depth++;
    else if (source[i] === "}") {
      depth--;
      if (depth === 0) return source.slice(start, i + 1);
    }
  }
  throw new Error(`незакрытая функция ${name}`);
}

const { readJson } = new Function(`
  ${extractConst("MAX_BODY_BYTES")}
  class HttpError extends Error {
    constructor(status, message, code) { super(message); this.status = status; this.code = code; }
  }
  ${extractFn("readJson")}
  return { readJson };
`)();

function req(body, headers = {}) {
  const h = new Map(Object.entries(headers));
  return {
    method: "POST",
    headers: { get: (k) => h.get(k.toLowerCase()) ?? null },
    body: typeof body === "string" ? new Blob([body]).stream() : body,
    text: async () => (typeof body === "string" ? body : await new Response(body).text())
  };
}

test("кирилиллический JSON больше лимита в байтах → 413 даже без Content-Length", async () => {
  // 600К символов «я» = ~1.2МБ UTF-8: text.length (~600К) меньше лимита,
  // реальный размер больше — именно обход BUG-02.
  const big = JSON.stringify({ note: "я".repeat(600_000) });
  const request = req(big); // Content-Length не передаём
  await rejects(readJson(request), error => error.status === 413 && error.code === "PAYLOAD_TOO_LARGE");
});

test("тело чуть меньше лимита в байтах принимается", async () => {
  const note = "x".repeat(999_000);
  const request = req(JSON.stringify({ note }));
  const body = await readJson(request);
  equal(body.note.length, 999_000);
});

test("кирилиллица у границы: UTF-8-байты считаются, не code units", async () => {
  // «я» = 2 байта UTF-8. Подбираем строку так, чтобы code units < лимита,
  // а байты > лимита — старый код пропускал, новый обязан отклонить.
  const note = "я".repeat(510_000); // ~1.02МБ
  const request = req(JSON.stringify({ note }));
  await rejects(readJson(request), error => error.status === 413);
});

test("Content-Length больше лимита отклоняется до чтения тела", async () => {
  const request = req("{}", { "content-length": "2000000" });
  await rejects(readJson(request), error => error.status === 413);
});

test("битый JSON → 400 INVALID_JSON, а не 413", async () => {
  const request = req("{not json");
  await rejects(readJson(request), error => error.status === 400 && error.code === "INVALID_JSON");
});

test("валидный объект возвращается", async () => {
  const body = await readJson(req(JSON.stringify({ a: 1, b: "текст" })));
  deepEqual(body, { a: 1, b: "текст" });
});

