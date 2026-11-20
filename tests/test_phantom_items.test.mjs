// Регрессия 2026-11-20: пустые «фантомные» карточки в «Местах/Посетить»
// не открывались и не удалялись — сервер отвечал «Запись не найдена».
// Фантомы приходят из archiveCache (старая пара/прерванная миграция), а не из
// серверного state. Проверяем, что mergedArchive их отфильтровывает для всех
// типов и что delete-item не дёргает API для несуществующей локально записи.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { ok } from "node:assert/strict";
import { test } from "node:test";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const source = readFileSync(join(root, "public", "app.js"), "utf8");

function extractBraced(text, declaration) {
  const start = text.indexOf(declaration);
  if (start === -1) throw new Error(`${declaration} не найдено`);
  let depth = 0;
  for (let j = text.indexOf("{", start); j < text.length; j++) {
    if (text[j] === "{") depth++;
    else if (text[j] === "}") {
      depth--;
      if (depth === 0) return text.slice(start, j + 1);
    }
  }
  throw new Error(`не закрыто: ${declaration}`);
}

const mergedArchiveFactory = new Function(
  "archiveCache", "appState",
  `${extractBraced(source, "function isArchiveItemReal")}
   ${extractBraced(source, "function mergedArchive")}
   return mergedArchive;`
);

function cache(items) {
  return { places: { items }, trips: { items } };
}

test("mergedArchive: фантомные места/поездки без title не показываются", () => {
  const merged = mergedArchiveFactory(
    cache([]), { pair: { id: 1 } }
  )("places", [
    { id: 1, title: "" },                 // пустая строка
    { id: 2, title: "   " },              // пробелы
    { id: 3 },                            // без поля
    { id: 0, title: "Нулевой id" },       // невалидный id
    { title: "Без id" },                  // нет id
    { id: 4, title: "Кафе" },             // настоящая запись
    { id: "abc", title: "Строковый id" }, // нечисловой id
  ]);
  ok(merged.length === 1, `ожидалась одна настоящая запись, получено ${merged.length}`);
  ok(merged[0].id === 4 && merged[0].title === "Кафе", "осталась не та запись");
});

test("mergedArchive: фантомы в trips тоже отфильтровываются", () => {
  const merged = mergedArchiveFactory(
    { trips: { items: [{ id: 9, title: "   " }, { id: 10, title: "Карелия" }] } },
    { pair: { id: 1 } }
  )("trips", []);
  ok(merged.length === 1, `ожидалась одна поездка, получено ${merged.length}`);
  ok(merged[0].id === 10, "фантомная поездка осталась");
});

test("delete-item: для несуществующей локально записи нет запроса к API", () => {
  const branch = source.slice(
    source.indexOf('action === "delete-item"'),
    source.indexOf('action === "open-memory"')
  );
  const idx = branch.indexOf("if (!item)");
  ok(idx > 0, "нет guards для несуществующей записи");
  const guard = branch.slice(idx, idx + 500);
  ok(guard.includes("dropMissingItem"), "фантом не убирается из кэша и state");
  ok(guard.includes("showToast"), "нет понятного сообщения пользователю");
  const deleteCall = guard.indexOf("request(");
  const returnIdx = guard.indexOf("return;");
  ok(deleteCall === -1 || returnIdx < deleteCall, "DELETE уходит на сервер для фантома");
});

test("mergedArchive: пустые body у желаний/цитат и title у планов/целей отфильтровываются", () => {
  for (const [type, rows, expected] of [
    ["wishes", [{ id: 1, body: "" }, { id: 2, body: "  " }, { id: 3, body: "Кофемашина" }], 3],
    ["private_wishes", [{ id: 1, body: "" }, { id: 2, body: "Личное" }], 2],
    ["quotes", [{ id: 1, body: "  " }, { id: 2, body: "Цитата" }], 2],
    ["tasks", [{ id: 1, title: "" }, { id: 2, title: "План" }], 2],
    ["goals", [{ id: 1, title: "  " }, { id: 2, title: "Цель" }], 2],
    ["memories", [{ id: 1, title: "", body: "" }, { id: 2, title: "", body: "Текст" }], 2],
  ]) {
    const merged = mergedArchiveFactory({}, { pair: { id: 1 } })(type, rows);
    ok(merged.length === 1, `${type}: ожидалась одна настоящая запись, получено ${merged.length}`);
    ok(merged[0].id === expected, `${type}: осталась фантомная запись`);
  }
});

test("delete-item: на 404 cleanup кэша и state, карточка не залипает", () => {
  const branch = source.slice(
    source.indexOf('action === "delete-item"'),
    source.indexOf('action === "open-memory"')
  );
  const catchIdx = branch.indexOf("catch (error)");
  ok(catchIdx > 0, "нет catch вокруг DELETE");
  const block = branch.slice(catchIdx, catchIdx + 700);
  ok(/error\?\.status === 404/.test(block), "нет проверки 404");
  ok(block.includes("dropMissingItem"), "404 не чистит кэш/state");
  ok(block.includes("render()"), "404 не перерисовывает список");
});

test("загрузка архива не складывает фантомы в кэш", () => {
  for (const needle of [
    ".filter((x) => isArchiveItemReal(type, x))",
  ]) {
    ok(source.includes(needle), "фильтр isArchiveItemReal не применяется при загрузке архива");
  }
  const loadPage = extractBraced(source, "async function loadArchivePage");
  ok(loadPage.includes("isArchiveItemReal"), "loadArchivePage не фильтрует записи");
  const fetchAll = extractBraced(source, "async function fetchArchiveEverything");
  ok((fetchAll.match(/isArchiveItemReal/g) || []).length >= 3,
    "fetchArchiveEverything фильтрует не все страницы");
});
