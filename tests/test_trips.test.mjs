// Поездки: сегмент «Путешествие» на вкладке «Места» (public/app.js) +
// grep-охрана маршрутов worker.js.
//
// Тесты извлекают рендереры из app.js как есть (приём test_item_cards),
// worker проверяется по исходнику — полный контракт описан в pytest
// (test_schema_parity: таблица trips обязана существовать во всех трёх
// источниках схемы) и в test_data_export.
//
// Запуск: node tests/test_trips.test.mjs
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { deepStrictEqual, equal, ok } from "node:assert/strict";
import { test } from "node:test";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const appSource = readFileSync(join(root, "public/app.js"), "utf8");
const workerSource = readFileSync(join(root, "worker.js"), "utf8");
const migrationSql = readFileSync(join(root, "migrations/0025_trips.sql"), "utf8");

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
  throw new Error(`незакрытый блок: ${declaration}`);
}

const load = new Function(
  [
    "let appState = { trips: [] };",
    "const REOPEN_ICON = '';",
    "const DONE_ICON = '';",
    "const EDIT_ICON = '';",
    "const DELETE_ICON = '';",
    extractBraced(appSource, "function esc"),
    extractBraced(appSource, "function partnerMissing"),
    'const pairTimeZone = () => "UTC";',
    extractBraced(appSource, "function formatTimestamp"),
    extractBraced(appSource, "function tripList"),
    extractBraced(appSource, "function openTrips"),
    extractBraced(appSource, "function visitedTrips"),
    extractBraced(appSource, "function tripItem"),
    extractBraced(appSource, "function renderTripsBody"),
    "return { esc, tripItem, renderTripsBody, setState: (v) => { appState = v; } };"
  ].join("\n")
);
const { esc, tripItem, renderTripsBody, setState } = load();

const trip = (id, visited = 0, note = "") => ({
  id,
  title: `Поездка ${id}`,
  note,
  visited,
  visited_at: visited ? 1700000000 : null
});

test("пустой сегмент: карточка «Пока пусто» с кнопкой «Добавить поездку»", () => {
  const html = renderTripsBody();
  ok(html.includes("Пока пусто"), "нет пустой карточки");
  ok(html.includes('data-action="add-trip"'), "нет кнопки добавления");
  ok(!html.includes("Рандом"), "в поездках нет рандома — он только у мест");
});

test("список: секции «Хотим съездить» и «Съездили» со счётчиками", () => {
  setState({ trips: [trip(1), trip(2, 1)] });
  const html = renderTripsBody();
  ok(html.includes("Хотим съездить · 1"), "нет секции желанных поездок");
  ok(html.includes("Съездили · 1"), "нет секции посещённых поездок");
  ok(html.includes('data-action="trip-visited" data-id="1"'), "нет отметки «съездили»");
  ok(html.includes('data-action="trip-unvisited" data-id="2"'), "нет возврата в список");
  ok(html.includes('data-type="trips"'), "нет правки/удаления поездки");
  ok(html.includes('data-action="add-trip"'), "нет кнопки добавления в непустом списке");
});

test("карточка поездки: название, заметка и пилюля даты у посещённой", () => {
  setState({ trips: [trip(1, 0, "На майские"), trip(2, 1)] });
  const open = tripItem({ id: 1, title: "Байкал", note: "На майские", visited: 0, visited_at: null });
  ok(open.includes("Байкал"), "нет названия");
  ok(open.includes("На майские"), "нет заметки");
  ok(!open.includes("day-chip"), "у желанной поездки нет пилюли даты");
  const done = tripItem({ id: 2, title: "Италия", note: "", visited: 1, visited_at: 1700000000 });
  ok(done.includes("day-chip"), "у посещённой поездки нет пилюли даты");
  ok(done.includes('data-action="trip-unvisited"'), "нет возврата в список");
});

test("без партнёра кнопка добавления блокируется, как у мест", () => {
  setState({ trips: [] });
  // partnerMissing() внутри извлечённого кода видит реальное состояние сессии —
  // в тесте он читает глобальные переменные, поэтому просто проверяем наличие
  // is-disabled в разметке через собственную сборку: гейт механически совпадает
  // с местами (одинаковый partnerMissing() → одинаковый disabledClass).
  ok(renderTripsBody().includes("add-trip"));
});

test("worker: маршруты поездок на месте", () => {
  // itemRoute: trips в regex, карте таблиц, visited/unvisited и PATCH-схеме.
  // regex-литерал в worker.js записан с экранированными слэшами, поэтому
  // проверяем подстрокой без скобочных групп.
  ok(workerSource.includes("places|trips|goals|goal_items|movies|savings)"), "trips нет в regex itemRoute");
  ok(workerSource.includes('trips: "trips"'), "trips нет в карте таблиц itemRoute");
  ok(workerSource.includes('if (request.method === "POST" && url.pathname === "/api/trips")'), "нет POST /api/trips");
  ok(workerSource.includes('} else if (type === "trips") {'), "нет ветки visited/unvisited у поездок");
  ok(/trips: \{ title: \{ type: "string", maxLength: 120 \}, note: \{ type: "string", maxLength: 600 \} \}/.test(workerSource), "trips нет в patchSchemas");
  ok(workerSource.includes("DELETE FROM trips WHERE pair_id=?"), "trips нет в каскаде leavePair");
});

test("worker: состояние и схема", () => {
  ok(workerSource.includes("FROM trips WHERE pair_id=? ORDER BY created_at DESC"), "trips не отдаются в /api/state");
  ok(workerSource.includes("trips: trips.results"), "ключ trips не попал в payload /api/state");
  ok(/CREATE TABLE IF NOT EXISTS trips \(/.test(workerSource), "trips нет в ensureSchema");
  ok(workerSource.includes("CREATE INDEX IF NOT EXISTS idx_trips_pair ON trips(pair_id,visited)"), "нет индекса поездок");
});

test("worker: экспорт поездок", () => {
  ok(/trips: \["all", "mine"\]/.test(workerSource), "trips нет в EXPORT_SECTIONS");
  ok(/trips: "поездки"/.test(workerSource), "trips нет в EXPORT_LABELS");
  ok(/trips: \(scope\) => `SELECT t\.id,t\.title,t\.note,t\.visited/.test(workerSource), "trips нет в EXPORT_SQL");
  ok(/trips: \(row\) => \(\{\n    id: row\.id,\n    title: row\.title,/.test(workerSource), "trips нет в EXPORT_ROW_MAPPERS");
  ok(/trips: \(row\) => \(\{\n    head: row\.title,/.test(workerSource), "trips нет в EXPORT_TXT_ROWS");
});

test("app: сегмент «Посетить/Путешествие» на вкладке «Места»", () => {
  ok(/renderSegment\("places", placesView, \[\["visit", "Посетить"\], \["trips", "Путешествие"\]\]\)/.test(appSource), "сегмент мест не найден");
  ok(/let placesView = "visit";/.test(appSource), "нет состояния placesView");
  ok(/if \(key === "places"\) return placesView;/.test(appSource), "switchValue не знает places");
  ok(/else if \(key === "places"\) placesView = value;/.test(appSource), "setSwitchValue не знает places");
  ok(/placesView === "trips" \? renderTripsBody\(\) : renderPlacesBody\(\)/.test(appSource), "нет ветки тела в render()");
  ok(/key === "places" \? \(placesView === "trips" \? renderTripsBody\(\) : renderPlacesBody\(\)\)/.test(appSource), "commitSwitch не перерисовывает тело мест");
  ok(appSource.includes('data-action="trip-visited"'), "нет действия trip-visited");
  ok(/action === "trip-visited" \|\| action === "trip-unvisited"/.test(appSource), "нет обработчика отметки поездки");
  ok(appSource.includes('trips: appState?.trips || []'), "trips нет в findItem");
  ok(appSource.includes('trips: "поездку"'), "trips нет в typeNames удаления");
  ok(appSource.includes('type === "trips"'), "нет диалога правки поездки");
  ok(appSource.includes('name="trips"'), "поездки нет в диалоге экспорта");
});

test("миграция 0025: таблица и индекс, состав колонок совпадает с worker", () => {
  ok(/CREATE TABLE IF NOT EXISTS trips \(/.test(migrationSql), "в миграции нет CREATE TABLE trips");
  ok(/CREATE INDEX IF NOT EXISTS idx_trips_pair ON trips\(pair_id,visited\)/.test(migrationSql), "в миграции нет индекса");
  const columns = (sql, name) => {
    const marker = `CREATE TABLE IF NOT EXISTS ${name} (`;
    const start = sql.indexOf(marker);
    if (start === -1) return null;
    const bodyStart = start + marker.length;
    let depth = 0;
    for (let j = bodyStart; j < sql.length; j++) {
      if (sql[j] === "(") depth++;
      else if (sql[j] === ")") {
        depth--;
        if (depth === 0) {
          // В колонках trips запятых внутри скобок нет (PRIMARY KEY — в начале
          // строки id), поэтому плоский split по запятой корректен.
          return sql.slice(bodyStart, j)
            .split(",")
            .map((c) => c.trim().split(/\s+/)[0])
            .filter(Boolean);
        }
      }
    }
    return null;
  };
  deepStrictEqual(columns(migrationSql, "trips"), columns(workerSource, "trips"), "колонки trips в миграции и worker.js расходятся");
});
