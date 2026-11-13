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
import { equal, match, ok } from "node:assert/strict";
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
    "const DONE_ICON = " + appSource.match(/const DONE_ICON = ('.*');/)?.[1] + ";",
    "const EDIT_ICON = " + appSource.match(/const EDIT_ICON = ('.*');/)?.[1] + ";",
    "const DELETE_ICON = " + appSource.match(/const DELETE_ICON = ('.*');/)?.[1] + ";",
    "const COPY_ICON = " + appSource.match(/const COPY_ICON = ('.*');/)?.[1] + ";",
    extractBraced(appSource, "function esc"),
    extractBraced(appSource, "function itemActionButton"),
    extractBraced(appSource, "function itemActions"),
    extractBraced(appSource, "function richInline"),
    extractBraced(appSource, "function renderRichText"),
    extractBraced(appSource, "function wishItem"),
    extractBraced(appSource, "function wishShareText"),
    "return { wishItem, wishShareText };"
  ].join("\n")
);
const { wishItem, wishShareText } = loadWishItem({ user: { tg_id: 2 } });

const PARTNER_WISH = { id: 7, body: "**Плед** и какао", owner_id: 2, display_name: "Аня" };
const WISH_WITH_URL = { id: 8, body: "**Плед** и какао", owner_id: 2, display_name: "Аня", url: "https://example.com/gifts" };

test("карточка чужого желания не показывает автора", () => {
  const html = wishItem(PARTNER_WISH, false);
  equal(html.includes("Желание:"), false);
  equal(html.includes("Аня"), false);
});

test("карточка чужого желания: «Поделиться» доступна, мутаций нет", () => {
  const html = wishItem(PARTNER_WISH, false);
  equal(html.includes("<b>Плед</b> и какао"), true);
  equal(html.includes("data-action=\"share-wish\""), true, "у чужого желания нет «Поделиться»");
  equal(html.includes("data-action=\"done-item\""), false);
  equal(html.includes("data-action=\"edit-item\""), false);
  equal(html.includes("data-action=\"delete-item\""), false);
});

test("wishShareText: название и строкой ниже ссылка, если есть", () => {
  equal(wishShareText(WISH_WITH_URL), "**Плед** и какао\nhttps://example.com/gifts");
  equal(wishShareText(PARTNER_WISH), "**Плед** и какао");
  equal(wishShareText({ body: "Только название", url: "  " }), "Только название");
  equal(wishShareText({}), "");
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

// --------------------------------------------- уточнение к желанию (2026-11-11)

const WISH_WITH_COMMENT = {
  id: 9, body: "Плед", owner_id: 2, comment: "Тёплый, **серый**, 150×200"
};

test("уточнение показывается под названием и поддерживает разметку", () => {
  const html = wishItem(WISH_WITH_COMMENT, false);
  equal(html.includes('<div class="wish-comment">'), true, "блок уточнения не отрисован");
  equal(html.includes("<b>серый</b>"), true, "разметка уточнения не применена");
  ok(html.indexOf("item-title") < html.indexOf("wish-comment"), "уточнение должно быть под названием");
});

test("уточнение экранируется: сырой HTML из базы не попадает в карточку", () => {
  const html = wishItem({ ...WISH_WITH_COMMENT, comment: "<script>alert(1)</script>" }, false);
  equal(html.includes("<script>"), false);
  equal(html.includes("&lt;script&gt;"), true);
});

test("желание без уточнения не получает пустой блок", () => {
  equal(wishItem(PARTNER_WISH, false).includes("wish-comment"), false);
  equal(wishItem({ ...WISH_WITH_COMMENT, comment: "  " }, false).includes("wish-comment"), true,
    "пробельное значение всё ещё строка — решает сервер, пишущий NULL");
});

test("wishShareText: название, уточнение и ссылка идут по строкам", () => {
  equal(
    wishShareText({ body: "Плед", comment: "Серый, 150×200", url: "https://example.com" }),
    "Плед\nСерый, 150×200\nhttps://example.com"
  );
  equal(wishShareText({ body: "Плед", comment: "  ", url: "" }), "Плед");
  equal(wishShareText({ body: "Плед", comment: "Серый" }), "Плед\nСерый");
});

test("формы создания и редактирования желания работают с полем comment", () => {
  match(appSource, /<textarea name="comment" data-fmt="\*\* _ __ ~~" rows="3" maxlength="500"/);
  match(appSource, /request\("\/api\/wishes", \{ method: "POST", body: \{ body: fd\.get\("body"\), comment: fd\.get\("comment"\)/);
  match(appSource, /if \(fd\.get\("comment"\) !== undefined\) body\.comment = fd\.get\("comment"\)/);
});
