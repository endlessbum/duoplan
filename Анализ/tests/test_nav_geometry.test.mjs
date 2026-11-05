// Геометрия выбора вкладки: площадь полигона, пересечение с прямоугольником,
// доля полной площади капли и правило «строго больше 50%».
//
// Модуль public/nav.js — классический скрипт (window.createLiquidNav), поэтому
// в тестах он исполняется через new Function с заглушкой window: сам модуль
// при загрузке DOM не трогает, только объявляет фабрику.
//
// Запуск: node --test tests/test_nav_geometry.test.mjs
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { equal } from "node:assert/strict";
import { test } from "node:test";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const source = readFileSync(join(root, "public/nav.js"), "utf8");

const factory = new Function("window", `${source}\nreturn window.createLiquidNav;`)({});
const { polygonArea, overlapArea, coverageRatios, isMajority, pickTarget } = factory.geometry;

const square = (x, y, size) => [
  [x, y],
  [x + size, y],
  [x + size, y + size],
  [x, y + size]
];
const rect = (left, top, right, bottom) => ({ left, top, right, bottom });

test("площадь полигона считается независимо от направления обхода", () => {
  equal(polygonArea(square(0, 0, 10)), 100);
  equal(polygonArea([...square(0, 0, 10)].reverse()), 100);
  equal(polygonArea([]), 0);
  equal(polygonArea([[0, 0], [1, 1]]), 0);
});

test("пересечение с прямоугольником отрезает лишнее", () => {
  equal(overlapArea(square(0, 0, 10), rect(0, 0, 5, 10)), 50);
  // Полностью внутри — площадь не меняется.
  equal(overlapArea(square(1, 1, 4), rect(0, 0, 5, 10)), 16);
  // Полностью снаружи — ноль.
  equal(overlapArea(square(20, 20, 5), rect(0, 0, 5, 10)), 0);
});

// ---------------------------------------------------------- доля площади

test("доля считается от полной площади капли, а не от суммы пересечений", () => {
  const droplet = square(0, 0, 10);
  // Вкладка накрывает 40% капли, остальные 60% — вне кнопок.
  const { total, ratios } = coverageRatios(droplet, [{ tab: "tasks", rect: rect(0, 0, 4, 10) }]);
  equal(total, 100);
  equal(ratios.tasks, 0.4);
});

test("Тест 1: 40% над вкладкой и 60% вне её — вкладка не выбирается", () => {
  const droplet = square(0, 0, 10);
  const { ratios } = coverageRatios(droplet, [{ tab: "tasks", rect: rect(0, 0, 4, 10) }]);
  equal(ratios.tasks, 0.4);
  equal(pickTarget(ratios, "home"), "home");
});

test("Тест 2: 60% полной площади — вкладка становится целью", () => {
  const droplet = square(0, 0, 10);
  const { ratios } = coverageRatios(droplet, [
    { tab: "dates", rect: rect(0, 0, 6, 10) },
    { tab: "tasks", rect: rect(6, 0, 8, 10) }
  ]);
  equal(ratios.dates, 0.6);
  equal(ratios.tasks, 0.2);
  equal(pickTarget(ratios, "home"), "dates");
});

test("Тест 3: ровно 50/50 сохраняет последнюю однозначную цель", () => {
  const droplet = square(0, 0, 10);
  const { ratios } = coverageRatios(droplet, [
    { tab: "tasks", rect: rect(0, 0, 5, 10) },
    { tab: "dates", rect: rect(5, 0, 10, 10) }
  ]);
  equal(ratios.tasks, 0.5);
  equal(ratios.dates, 0.5);
  equal(pickTarget(ratios, "home"), "home");
  equal(pickTarget(ratios, "memories"), "memories");
});

test("Тест 4: ни у кого нет большинства — цель не меняется", () => {
  const droplet = square(0, 0, 10);
  const { ratios } = coverageRatios(droplet, [
    { tab: "home", rect: rect(0, 0, 4.5, 10) },
    { tab: "tasks", rect: rect(4.5, 0, 8, 10) },
    { tab: "dates", rect: rect(8, 0, 10, 10) }
  ]);
  equal(ratios.home, 0.45);
  equal(ratios.tasks, 0.35);
  equal(ratios.dates, 0.2);
  equal(pickTarget(ratios, "wishes"), "wishes");
});

test("Тест 5: деформированная капля считается по контуру, а не по bbox", () => {
  // Треугольник с bbox 10×10 (100), но реальной площадью 50.
  const triangle = [[0, 10], [5, 0], [10, 10]];
  equal(polygonArea(triangle), 50);
  // Прямоугольник вокруг всей фигуры накрывает её лишь наполовину.
  equal(overlapArea(triangle, rect(0, 0, 10, 10)), 50);

  const { total, ratios } = coverageRatios(triangle, [{ tab: "tasks", rect: rect(0, 0, 10, 10) }]);
  equal(total, 50);
  equal(ratios.tasks, 1);
  // Если бы считали по bbox, знаменатель был бы 100 и доля — 0.5.
  const half = coverageRatios(triangle, [{ tab: "tasks", rect: rect(0, 0, 5, 10) }]);
  equal(half.total, 50);
  equal(half.ratios.tasks, 0.5);
  equal(pickTarget(half.ratios, "home"), "home");
});

test("вытянутая капля: доля зависит от реальной формы", () => {
  // Асимметричная «капля»: широкая слева, узкая справа.
  const stretched = [[0, 2], [8, 0], [10, 5], [8, 10], [0, 8]];
  const area = polygonArea(stretched);
  const left = overlapArea(stretched, rect(0, 0, 5, 10));
  const right = overlapArea(stretched, rect(5, 0, 10, 10));
  // Части не равны, но в сумме дают всю площадь фигуры.
  equal(Math.round((left + right) * 1000) / 1000, Math.round(area * 1000) / 1000);
  const { ratios } = coverageRatios(stretched, [
    { tab: "tasks", rect: rect(0, 0, 5, 10) },
    { tab: "dates", rect: rect(5, 0, 10, 10) }
  ]);
  equal(ratios.tasks, left / area);
  equal(ratios.dates, right / area);
});

// --------------------------------------------------------- правило 50%

test("выбор цели: строго больше половины полной площади", () => {
  equal(pickTarget({ tasks: 0.7, dates: 0.3 }, "home"), "tasks");
  equal(pickTarget({ tasks: 0.4, dates: 0.6 }, "home"), "dates");
  equal(pickTarget({ tasks: 1, dates: 0 }, "home"), "tasks");
});

test("погрешность не превращает 50/50 в большинство", () => {
  equal(isMajority(0.5), false);
  // 0.5005 — это 50.05%: всё ещё ничья, допуск 0.2%.
  equal(isMajority(0.5005), false);
  equal(pickTarget({ tasks: 0.5005, dates: 0.4995 }, "home"), "home");
  equal(isMajority(0.51), true);
  equal(pickTarget({ tasks: 0.51, dates: 0.49 }, "home"), "tasks");
});

test("пустая площадь не переключает вкладку", () => {
  equal(pickTarget({ tasks: 0, dates: 0 }, "memories"), "memories");
  equal(pickTarget({}, "wishes"), "wishes");
});
