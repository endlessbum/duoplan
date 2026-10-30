// Карточка желания в Mini App: автор не показывается.
//
// Вишлист уже разделён переключателем «Мои / Его(Её)», поэтому подпись
// «Желание: <имя>» в карточке дублировала заголовок вкладки и убрана.
// Владелец желания остаётся в данных (`owner_id`) — на нём держится фильтр
// и права на редактирование.
//
// Запуск: node --test tests/test_wish_card.test.mjs
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { equal } from "node:assert/strict";
import { test } from "node:test";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const appSource = readFileSync(join(root, "public/app.js"), "utf8");

function extractBraced(source, declaration) {
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

const loadWishItem = new Function(
  "appState",
  [
    "const RICH_TOKENS = " + appSource.match(/const RICH_TOKENS = (\[\[.*\]\]);/)?.[1] + ";",
    extractBraced(appSource, "function esc"),
    extractBraced(appSource, "function richInline"),
    extractBraced(appSource, "function renderRichText"),
    extractBraced(appSource, "function wishItem"),
    "return { wishItem };"
  ].join("\n")
);
const { wishItem } = loadWishItem({ user: { tg_id: 2 } });

const PARTNER_WISH = { id: 7, body: "**Плед** и какао", owner_id: 2, display_name: "Аня" };
const WISH_WITH_URL = { id: 8, body: "**Плед** и какао", owner_id: 2, display_name: "Аня", url: "https://example.com/gifts" };

test("карточка чужого желания не показывает автора", () => {
  const html = wishItem(PARTNER_WISH, false);
  equal(html.includes("Желание:"), false);
  equal(html.includes("Аня"), false);
});

test("карточка чужого желания остаётся без действий, но с разметкой", () => {
  const html = wishItem(PARTNER_WISH, false);
  equal(html.includes("<b>Плед</b> и какао"), true);
  equal(html.includes("data-action=\"done-item\""), false);
});

test("своё желание: действия на месте, автора тоже нет", () => {
  const html = wishItem(PARTNER_WISH, true);
  equal(html.includes("data-action=\"done-item\""), true);
  equal(html.includes("Аня"), false);
});

test("желание с ссылкой: кнопка «Ссылка», сама ссылка не показывается текстом", () => {
  const html = wishItem(WISH_WITH_URL, false);
  equal(html.includes("data-action=\"open-url\""), true, "есть кнопка перехода по ссылке");
  equal(html.includes(">Ссылка</button>"), true, "подпись кнопки — «Ссылка», а не URL");
  equal(html.includes("<a "), false, "ссылка не рендерится как сырой anchor");
});

test("желание без ссылки: кнопки «Ссылка» нет", () => {
  const html = wishItem(PARTNER_WISH, false);
  equal(html.includes("data-action=\"open-url\""), false);
});
