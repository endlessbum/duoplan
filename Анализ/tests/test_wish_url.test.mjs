// Ссылка желания: серверная валидация (http/https) и отрисовка кнопки «Ссылка».
//
// wishUrl извлекается из worker.js как есть; HttpError подменяется, D1 не нужен.
//
// Запуск: node --test tests/test_wish_url.test.mjs
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { equal, throws } from "node:assert/strict";
import { test } from "node:test";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const source = readFileSync(join(root, "worker.js"), "utf8");

function extractBraced(declaration) {
  const start = source.indexOf(declaration);
  if (start === -1) throw new Error(`${declaration} не найдено`);
  let depth = 0;
  for (let j = source.indexOf("{", start); j < source.length; j++) {
    if (source[j] === "{") depth++;
    else if (source[j] === "}") {
      depth--;
      if (depth === 0) return source.slice(start, j + 1);
    }
  }
  throw new Error(`незакрытый блок: ${declaration}`);
}

const HttpError = new Function(`${extractBraced("class HttpError")}\nreturn HttpError;`)();
const loadWishUrl = new Function("HttpError", "clean", `${extractBraced("function wishUrl")}\nreturn wishUrl;`);
const wishUrl = loadWishUrl(HttpError, value => String(value ?? "").trim());

test("пустая ссылка у желания допустима и означает «без ссылки»", () => {
  equal(wishUrl(""), "");
  equal(wishUrl(null), "");
});

test("валидный http/https адрес проходит и сохраняется как есть", () => {
  equal(wishUrl("https://example.com/gifts"), "https://example.com/gifts");
  equal(wishUrl("http://example.com/gifts"), "http://example.com/gifts");
});

test("не-http(s) схемы отклоняются: javascript: и прочие опасные варианты", () => {
  throws(() => wishUrl("javascript:alert(1)"), (error) => error instanceof HttpError);
  throws(() => wishUrl("data:text/html,<script>"), (error) => error instanceof HttpError);
  throws(() => wishUrl("example.com/not-a-url"), (error) => error instanceof HttpError);
});

test("слишком длинная ссылка отклоняется", () => {
  throws(() => wishUrl("https://example.com/" + "a".repeat(2100)), (error) => error instanceof HttpError);
});
