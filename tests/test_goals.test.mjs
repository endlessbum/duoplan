// Цели: сегмент «Цели» на вкладке «Планы» (public/app.js) + grep-охрана
// маршрутов worker.js.
//
// Тесты извлекают рендереры из app.js как есть (приём test_item_cards),
// worker проверяется по исходнику; паритет схемы цели гоняется pytest-ом
// (test_schema_parity: goals + goal_items обязаны существовать во всех трёх
// источниках схемы).
//
// Запуск: node tests/test_goals.test.mjs
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { deepStrictEqual, equal, ok } from "node:assert/strict";
import { test } from "node:test";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const appSource = readFileSync(join(root, "public/app.js"), "utf8");
const workerSource = readFileSync(join(root, "worker.js"), "utf8");
const migrationSql = readFileSync(join(root, "migrations/0026_goals.sql"), "utf8");

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
    "let appState = { goals: [] };",
    // goalList() читает mergedArchive — стаб возвращает недавние как есть.
    "const mergedArchive = (type, recent) => recent || [];",
    "const archiveMoreHtml = () => \"\";",
    "let goalsView = 'open';",
    "const REOPEN_ICON = '';",
    "const DONE_ICON = '';",
    "const DELETE_ICON = '';",
    extractBraced(appSource, "function esc"),
    extractBraced(appSource, "function itemActionButton"),
    extractBraced(appSource, "function itemActions"),
    extractBraced(appSource, "function partnerMissing"),
    extractBraced(appSource, "function goalList"),
    extractBraced(appSource, "function goalCompleted"),
    extractBraced(appSource, "function openGoals"),
    extractBraced(appSource, "function completedGoals"),
    extractBraced(appSource, "function goalItemRow("),
    extractBraced(appSource, "function goalItem("),
    extractBraced(appSource, "function renderGoalsList"),
    "return { goalItemRow, goalItem, renderGoalsList, openGoals, completedGoals, setState: (v) => { appState = v; }, setView: (v) => { goalsView = v; } };"
  ].join("\n")
);
const { goalItemRow, goalItem, renderGoalsList, openGoals, completedGoals, setState, setView } = load();

const item = (id, done = 0) => ({ id, title: `Пункт ${id}`, done, done_at: done ? 1700000000 : null });
const goal = (id, items, isPrivate = 0) => ({ id, title: `Цель ${id}`, items, is_private: isPrivate, created_by: 1, created_at: 1700000000 });

test("сегмент «Цели» в списке видов вкладки «Планы»", () => {
  ok(/\[\["plans", "Планы"\], \["goals", "Цели"\], \["movies", "Кино"\]\]/.test(appSource), "сегмент Планы/Цели/Кино не найден");
  ok(/let goalsView = "open";/.test(appSource), "нет состояния goalsView");
  ok(/if \(key === "goals"\) return goalsView;/.test(appSource), "switchValue не знает goals");
  ok(/else if \(key === "goals"\) goalsView = value;/.test(appSource), "setSwitchValue не знает goals");
  ok(/tasksView === "goals" \? renderGoalsBody\(\)/.test(appSource), "нет ветки тела в render()");
  ok(/tasksView === "movies" \? renderMoviesBody\(\) : tasksView === "goals" \? renderGoalsBody\(\)/.test(appSource), "commitSwitch не перерисовывает тело планов");
  ok(/renderSegment\("goals", goalsView, \[\["open", "Предстоящие"\], \["done", "Выполненные"\]\], "is-sub"\)/.test(appSource), "внутренний бар целей не найден");
  ok(/commitSwitch\("goals", value, goalsSwitch\)/.test(appSource), "фолбэк-клик не ведёт к экземпляру капли целей");
});

test("пустой сегмент: карточка «Пока пусто» с кнопкой «Создать цель»", () => {
  setView("open");
  const html = renderGoalsList();
  ok(html.includes("Пока пусто"), "нет пустой карточки");
  ok(html.includes('data-action="add-goal"'), "нет кнопки создания");
});

test("предстоящие: карточка цели с пунктами и кнопкой создания над списком", () => {
  setView("open");
  setState({ goals: [goal(1, [item(1), item(2, 1)])] });
  const html = renderGoalsList();
  ok(html.includes('data-action="add-goal"'), "нет кнопки создания в непустом списке");
  ok(html.includes("Цель 1"), "нет названия цели");
  ok(html.includes('data-action="goal-item-done" data-id="1"'), "нет отметки пункта");
  ok(html.includes('data-action="goal-item-reopen" data-id="2"'), "нет возврата выполненного пункта");
  // Пилюлю прогресса «N из M» убрали по запросу — в карточке только пункты.
  ok(!html.includes("из 2"), "счётчик прогресса вернулся в карточку");
  ok(html.includes('data-action="delete-item" data-type="goals"'), "нет удаления цели");
});

test("выполненный пункт тусклее: класс is-done", () => {
  const row = goalItemRow(item(1, 1));
  ok(row.includes("is-done"), "выполненный пункт без is-done");
  ok(!goalItemRow(item(1, 0)).includes("is-done"), "невыполненный пункт помечен is-done");
});

test("цель со всеми выполненными пунктами уезжает в «Выполненные»", () => {
  setState({ goals: [goal(1, [item(1, 1), item(2, 1)]), goal(2, [item(3), item(4, 1)])] });
  deepStrictEqual(completedGoals().map((g) => g.id), [1], "неверная выборка выполненных");
  deepStrictEqual(openGoals().map((g) => g.id), [2], "неверная выборка предстоящих");
  setView("done");
  const html = renderGoalsList();
  ok(html.includes("Цель 1"), "выполненной цели нет в «Выполненных»");
  ok(!html.includes("Цель 2"), "незавершённая цель попала в «Выполненные»");
  setView("open");
  ok(renderGoalsList().includes("Цель 2"), "незавершённой цели нет в «Предстоящих»");
});

test("пустые «Выполненные» — поясняющая карточка без кнопки создания", () => {
  setState({ goals: [] });
  setView("done");
  const html = renderGoalsList();
  ok(html.includes("не достигнуто"), "нет пояснения");
  ok(!html.includes('data-action="add-goal"'), "кнопка создания не должна жить в «Выполненных»");
});

test("личная цель помечена пилюлей", () => {
  const card = goalItem(goal(1, [item(1)], 1));
  ok(card.includes("Личная"), "нет пилюли личной цели");
  ok(!goalItem(goal(2, [item(2)], 0)).includes("Личная"), "общая цель помечена личной");
});

test("worker: маршруты целей на месте", () => {
  ok(workerSource.includes("places|trips|goals|goal_items|movies|savings)"), "goals нет в regex itemRoute");
  ok(workerSource.includes('goals: "goals"') && workerSource.includes('goal_items: "goal_items"'), "goals нет в карте таблиц itemRoute");
  ok(workerSource.includes('if (request.method === "POST" && url.pathname === "/api/goals")'), "нет POST /api/goals");
  ok(/async goal_items\(\)/.test(workerSource), "нет ветки done/reopen у пунктов цели");
  ok(workerSource.includes("async function ensureGoalVisible"), "нет проверки видимости личных целей");
  ok(workerSource.includes("DELETE FROM goal_items WHERE pair_id=?") && workerSource.includes("DELETE FROM goals WHERE pair_id=?"), "goals нет в каскаде leavePair");
  ok(/INVALID_ITEMS/.test(workerSource), "нет валидации пунктов");
});

test("worker: состояние и схема", () => {
  ok(workerSource.includes("FROM goals WHERE pair_id=? AND (is_private=0 OR created_by=?)"), "goals не фильтруются по приватности в /api/state");
  ok(workerSource.includes("FROM goal_items gi"), "пункты целей не отдаются в /api/state");
  ok(/goals: \(goals\.results \|\| \[\]\)\.map/.test(workerSource), "пункты не приклеиваются к цели");
  ok(/CREATE TABLE IF NOT EXISTS goals \(/.test(workerSource), "goals нет в ensureSchema");
  ok(/CREATE TABLE IF NOT EXISTS goal_items \(/.test(workerSource), "goal_items нет в ensureSchema");
});

test("app: диалог цели и действия", () => {
  ok(appSource.includes('data-action="add-goal-step"'), "нет кнопки «+» для пункта");
  ok(appSource.includes('data-action="remove-goal-step"'), "нет удаления пункта в диалоге");
  ok(appSource.includes("goal-steps"), "нет контейнера пунктов");
  ok(appSource.includes('name="items"'), "пункты не собираются из формы");
  ok(appSource.includes("fd.getAll(\"items\")"), "пункты не собираются getAll-ом");
  ok(appSource.includes('is_private: fd.get("is_private") === "on"'), "личная цель не передаётся");
  ok(/action === "goal-item-done" \|\| action === "goal-item-reopen"/.test(appSource), "нет обработчика отметки пункта");
  ok(appSource.includes("/api/goal_items/"), "нет запроса отметки пункта");
  ok(appSource.includes('goals: mergedArchive("goals", appState?.goals || [])'), "goals нет в findItem");
  // Регрессия 2026-11-11: в Promise.all state() порядок запросов разъехался
  // с деструктуризацией — goals получал строки копилок, savings — пункты
  // целей (заметено на сиде архива). Порядок: savings → goals → goalItems.
  ok(/movieRatings, savings, goals, goalItems, daily, partnerUser\]/.test(workerSource), "деструктуризация state() разъехалась с запросами");
  const stateStart = workerSource.indexOf("movieRatings, savings, goals, goalItems");
  const savingsQ = workerSource.indexOf("FROM savings WHERE pair_id=? AND (kind='shared'", stateStart);
  const goalsQ = workerSource.indexOf("FROM goals WHERE pair_id=? AND (is_private=0", stateStart);
  ok(savingsQ > -1 && goalsQ > savingsQ, "в Promise.all state() savings/goals поменялись местами");
  ok(appSource.includes('goals: "цель"'), "goals нет в typeNames удаления");
  ok(appSource.includes('"add-goal"'), "нет действия создания цели");
});

test("миграция 0026: обе таблицы и индексы, состав колонок совпадает с worker", () => {
  for (const table of ["goals", "goal_items"]) {
    ok(new RegExp(`CREATE TABLE IF NOT EXISTS ${table} \\(`).test(migrationSql), `в миграции нет CREATE TABLE ${table}`);
  }
  ok(/CREATE INDEX IF NOT EXISTS idx_goals_pair ON goals\(pair_id,is_private\)/.test(migrationSql), "нет индекса целей");
  ok(/CREATE INDEX IF NOT EXISTS idx_goal_items_goal ON goal_items\(goal_id,done\)/.test(migrationSql), "нет индекса пунктов");
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
          // В колонках goals/goal_items запятых внутри скобок нет.
          return sql.slice(bodyStart, j)
            .split(",")
            .map((c) => c.trim().split(/\s+/)[0])
            .filter(Boolean);
        }
      }
    }
    return null;
  };
  deepStrictEqual(columns(migrationSql, "goals"), columns(workerSource, "goals"), "колонки goals расходятся");
  deepStrictEqual(columns(migrationSql, "goal_items"), columns(workerSource, "goal_items"), "колонки goal_items расходятся");
});

// Атомарность создания цели: пункты — один batch, при его сбое цель
// удаляется компенсирующе (репорт аудита 2026-11-06: сбой второго запроса
// оставлял «осиротевшую» цель без пунктов).
test("создание цели атомарно: компенсирующее удаление при сбое batch", () => {
  ok(workerSource.includes('DELETE FROM goals WHERE id=? AND pair_id=?'),
    "нет компенсирующего удаления цели при сбое batch пунктов");
  ok(workerSource.includes("goal cleanup failed"), "сбой компенсации не логируется");
  ok(/catch \(error\) \{[\s\S]*?DELETE FROM goals[\s\S]*?throw error;\s*\}/.test(
    workerSource.slice(workerSource.indexOf("async function createGoal"), workerSource.indexOf('"/api/movies"'))
  ), "компенсация не перехватывает исходную ошибку");
});
