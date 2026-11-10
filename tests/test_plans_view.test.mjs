// Планы: внутренний бар «Предстоящие / Выполненные» (public/app.js).
//
// Приём тот же, что в test_goals.test.mjs: рендереры извлекаются из app.js
// как есть (new Function + стабы зависимостей), переключение видов
// проверяется grep-охраной исходника — commitSwitch тянет половину модуля.
//
// Запуск: node --test tests/test_plans_view.test.mjs
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { deepStrictEqual, equal, ok } from "node:assert/strict";
import { test } from "node:test";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const appSource = readFileSync(join(root, "public/app.js"), "utf8");

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
    "let appState = { tasks: [], completedTasks: [] };",
    "let plansView = 'open';",
    // mergedArchive/archiveMoreHtml живут на archiveCache — подменяем маркерами.
    "const mergedArchive = (type, recent) => recent || [];",
    "const archiveMoreHtml = (type) => `<button data-action=\"load-archive\" data-type=\"${type}\">Показать ещё</button>`;",
    "const sortByTaskDeadline = (rows) => rows;",
    "const taskItem = (item) => `<article class=\"card task\">План ${item.id}</article>`;",
    "const completedTaskItem = (item) => `<article class=\"card done\">Завершён ${item.id}</article>`;",
    extractBraced(appSource, "function esc"),
    extractBraced(appSource, "function partnerMissing"),
    extractBraced(appSource, "function renderSegment"),
    extractBraced(appSource, "function renderTasksBody"),
    extractBraced(appSource, "function renderPlansList"),
    "return { renderTasksBody, renderPlansList, renderSegment, setState: (v) => { appState = v; }, setView: (v) => { plansView = v; } };"
  ].join("\n")
);
const { renderTasksBody, renderPlansList, renderSegment, setState, setView } = load();

const openTask = (id) => ({ id, title: `План ${id}`, status: "open", is_private: 0 });
const doneTask = (id) => ({ id, title: `План ${id}`, status: "done", is_private: 0, created_at: 1700000000, completed_at: 1700000001 });

test("бар «Предстоящие / Выполненные» подключён по образцу целей", () => {
  ok(/let plansView = "open";/.test(appSource), "нет состояния plansView");
  ok(/if \(key === "plans"\) return plansView;/.test(appSource), "switchValue не знает plans");
  ok(/else if \(key === "plans"\) plansView = value;/.test(appSource), "setSwitchValue не знает plans");
  ok(/renderSegment\("plans", plansView, \[\["open", "Предстоящие"\], \["done", "Выполненные"\]\], "is-sub"\)/.test(appSource), "внутренний бар планов не найден");
  ok(/getElementById\("plans-body"\)/.test(appSource), "commitSwitch не меняет список планов");
  ok(/commitSwitch\("plans", value, plansSwitch\)/.test(appSource), "фолбэк-клик не ведёт к экземпляру капли планов");
  ok(/mountPlansSwitch\(\);/.test(appSource), "mountPlansSwitch не вызывается из render()");
  ok(/if \(plansSwitch\) \{ plansSwitch\.destroy\(\); plansSwitch = null; \}/.test(appSource), "plansSwitch не снимается в destroySwitches");
  ok(/if \(key === "tasks" && plansSwitch\) \{/.test(appSource), " plansSwitch не снимается при смене вида вкладки");
  ok(/if \(key === "tasks" && tasksView === "plans"\) mountPlansSwitch\(\);/.test(appSource), "капля планов не перемонтируется после смены вида вкладки");
});

test("бар планов — сегмент с двумя видами", () => {
  const bar = renderSegment("plans", "open", [["open", "Предстоящие"], ["done", "Выполненные"]], "is-sub");
  ok(bar.includes('data-switch="plans"'), "нет ключа plans");
  ok(bar.includes("is-sub"), "бар планов должен быть уменьшенным (is-sub)");
  ok(bar.includes("Предстоящие") && bar.includes("Выполненные"), "нет подписей видов");
  ok(bar.includes('data-action="seg-switch"'), "кнопки бара не подключены к делегату");
  ok(bar.includes("seg-switch-btn is-active"), "активный вид не помечен");
});

test("предстоящие: кнопка добавления и карточки планов", () => {
  setView("open");
  setState({ tasks: [openTask(1), openTask(2)], completedTasks: [] });
  const html = renderPlansList();
  ok(html.includes('data-action="add-task"'), "нет кнопки добавления");
  ok(html.includes("План 1") && html.includes("План 2"), "нет карточек планов");
  ok(!html.includes("Завершённые"), "секция завершённых не должна жить в «Предстоящих»");
  ok(html.includes('data-type="tasks"'), "нет догрузки архива предстоящих");
  ok(!html.includes('data-type="done_tasks"'), "догрузка done_tasks не должна жить в «Предстоящих»");
});

test("тело вкладки: бар сверху, список в контейнере plans-body", () => {
  setView("open");
  const html = renderTasksBody();
  ok(html.indexOf("seg-switch") < html.indexOf('id="plans-body"'), "бар должен быть над списком");
  ok(html.includes('id="plans-body"'), "нет контейнера списка");
});

test("выполненные: карточки завершённых и догрузка архива", () => {
  setView("done");
  setState({ tasks: [openTask(9)], completedTasks: [doneTask(1), doneTask(2)] });
  const html = renderPlansList();
  ok(html.includes("Завершённые · 2"), "нет заголовка с количеством");
  ok(html.includes("Завершён 1") && html.includes("Завершён 2"), "нет карточек завершённых");
  ok(!html.includes("План 9"), "предстоящий план попал в «Выполненные»");
  ok(!html.includes('data-action="add-task"'), "кнопка добавления не должна жить в «Выполненных»");
  ok(html.includes('data-type="done_tasks"'), "нет догрузки архива завершённых");
});

test("пустые «Выполненные» — поясняющая карточка без кнопки добавления", () => {
  setView("done");
  setState({ tasks: [openTask(1)], completedTasks: [] });
  const html = renderPlansList();
  ok(html.includes("не завершено"), "нет пояснения");
  ok(!html.includes('data-action="add-task"'), "кнопка добавления не должна жить в «Выполненных»");
});

test("вид «Предстоящие» без планов: добавление или «Всё впереди»", () => {
  setView("open");
  // Есть завершённые — только кнопка добавления, без «Всё впереди».
  setState({ tasks: [], completedTasks: [doneTask(1)] });
  let html = renderPlansList();
  ok(html.includes('data-action="add-task"'), "нет кнопки добавления");
  ok(!html.includes("Всё впереди"), "«Всё впереди» не должно показываться при наличии завершённых");
  // Пусто и там и там — карточка «Всё впереди» с кнопкой.
  setState({ tasks: [], completedTasks: [] });
  html = renderPlansList();
  ok(html.includes("Всё впереди"), "нет пустой карточки");
  ok(html.includes('data-action="add-task"'), "нет кнопки добавления в пустой карточке");
});

test("выбранный вид переживает перерисовку списка", () => {
  setView("done");
  setState({ tasks: [openTask(1)], completedTasks: [doneTask(2)] });
  deepStrictEqual(renderPlansList().includes("Завершён 2"), true);
  setView("open");
  deepStrictEqual(renderPlansList().includes("План 1"), true);
});
