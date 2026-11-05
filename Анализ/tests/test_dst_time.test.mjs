// Регрессионный тест на весенний перевод часов (несуществующее локальное время).
//
// Функции timeZoneOffsetMs/makeDateInTimeZone продублированы в worker.js и
// public/app.js и не экспортируются, поэтому тест извлекает их исходник
// из файлов и исполняет — проверяется код как есть, а не копия.
//
// Запуск: node tests/test_dst_time.test.mjs  (или node --test tests/)
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { deepStrictEqual } from "node:assert/strict";
import { test } from "node:test";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");

// Извлекает объявление функции по имени с учётом вложенных фигурных скобок.
function extractFunction(source, name) {
  const start = source.indexOf(`function ${name}(`);
  if (start === -1) throw new Error(`function ${name} не найдена`);
  let depth = 0;
  let i = source.indexOf("{", start);
  for (let j = i; j < source.length; j++) {
    if (source[j] === "{") depth++;
    else if (source[j] === "}") {
      depth--;
      if (depth === 0) return source.slice(start, j + 1);
    }
  }
  throw new Error(`незакрытая функция ${name}`);
}

function loadImpl(relPath) {
  const source = readFileSync(join(root, relPath), "utf8");
  const code = extractFunction(source, "timeZoneOffsetMs") + "\n" + extractFunction(source, "makeDateInTimeZone");
  return new Function(`${code}; return makeDateInTimeZone;`)();
}

function localString(date, timeZone) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone, year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", hour12: false
  }).format(date);
}

// Несуществующие времена (весенний переход) — должны сдвигаться ВПЕРЁД
// на величину разрыва, а не возвращаться назад, как раньше.
const GAP_CASES = [
  ["Australia/Sydney", [2026, 9, 4, 2, 30], "2026-10-04, 03:30"],
  ["Pacific/Auckland", [2026, 8, 27, 2, 30], "2026-09-27, 03:30"],
  ["Australia/Lord_Howe", [2026, 9, 4, 2, 15], "2026-10-04, 02:45"],
  ["Europe/Amsterdam", [2026, 2, 29, 2, 30], "2026-03-29, 03:30"],
  ["America/New_York", [2026, 2, 8, 2, 30], "2026-03-08, 03:30"],
];

// Обычные времена — проходят без изменений.
const NORMAL_CASES = [
  ["Australia/Sydney", [2026, 9, 4, 5, 0], "2026-10-04, 05:00"],
  ["Europe/Amsterdam", [2026, 6, 15, 12, 0], "2026-07-15, 12:00"],
  ["Pacific/Auckland", [2026, 8, 27, 5, 0], "2026-09-27, 05:00"],
];

for (const [file] of [["worker.js"], [join("public", "app.js")]]) {
  const impl = loadImpl(file);

  for (const [tz, args, expected] of GAP_CASES) {
    test(`${file}: ${tz} ${args[3]}:${String(args[4]).padStart(2, "0")} в разрыве перехода -> ${expected}`, () => {
      const result = impl(args[0], args[1], args[2], args[3], args[4], tz);
      deepStrictEqual(localString(result, tz).replace(", ", " "), expected.replace(", ", " "));
    });
  }

  for (const [tz, args, expected] of NORMAL_CASES) {
    test(`${file}: ${tz} обычное время сохраняется`, () => {
      const result = impl(args[0], args[1], args[2], args[3], args[4], tz);
      deepStrictEqual(localString(result, tz).replace(", ", " "), expected.replace(", ", " "));
    });
  }
}
