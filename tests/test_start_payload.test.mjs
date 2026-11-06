// /start с кодом приглашения (worker.js: startPayload).
//
// Репорт аудита 2026-11-06: "/start@duoplanbot ABC12345" не матчился
// префиксом "/start " — код после упоминания бота терялся, и на webhook
// незнакомец получал generic-ответ вместо входа по приглашению.
//
// Запуск: node --test tests/test_start_payload.test.mjs
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { equal } from "node:assert/strict";
import { test } from "node:test";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const source = readFileSync(join(root, "worker.js"), "utf8");

function extractLine(prefix) {
  const start = source.indexOf(prefix);
  if (start === -1) throw new Error(`${prefix} не найдено`);
  return source.slice(start, source.indexOf("\n", start));
}

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

const bundle = [
  extractLine("const START_PAYLOAD_RE"),
  extractBraced("function startPayload(")
].join("\n");
const startPayload = new Function(`${bundle}\nreturn startPayload;`)();

test("/start с кодом и с упоминанием бота дают одинаковый payload", () => {
  equal(startPayload("/start ABC12345"), "ABC12345");
  equal(startPayload("/start@duoplanbot ABC12345"), "ABC12345");
  equal(startPayload("/start@duoplan_bot abc12345"), "abc12345");
});

test("без кода и не-/start — пустой payload", () => {
  equal(startPayload("/start"), "");
  equal(startPayload("/start@duoplanbot"), "");
  equal(startPayload("/startABC12345"), "", "прилипший код не код");
  equal(startPayload("/menu"), "");
  equal(startPayload(""), "");
  equal(startPayload(null), "");
  equal(startPayload("  /start ABC12345  "), "ABC12345", "пробелы по краям срезаются");
});
