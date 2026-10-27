const tg = window.Telegram?.WebApp;
const app = document.querySelector("#app");
const content = document.querySelector("#content");
const onboarding = document.querySelector("#onboarding");
const outside = document.querySelector("#outside");
const dialog = document.querySelector("#dialog");
const typeDialog = document.querySelector("#type-dialog");
const form = document.querySelector("#dialog-form");
const formError = document.querySelector("#dialog-error");
const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone || "Europe/Moscow";

let state = null;
let route = "home";
let pendingAction = null;
let pendingId = null;
let dialogBusy = false;
let toastTimer;

const esc = value => String(value ?? "").replace(/[&<>"']/g, char => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[char]));
const plural = (number, one, few, many) => {
  const value = Math.abs(number) % 100;
  const last = value % 10;
  if (value > 10 && value < 20) return many;
  if (last === 1) return one;
  if (last >= 2 && last <= 4) return few;
  return many;
};
const formatDate = day => {
  const [year, month, date] = String(day).split("-").map(Number);
  return new Intl.DateTimeFormat("ru-RU", { day: "numeric", month: "long", year: "numeric" })
    .format(new Date(year, month - 1, date, 12));
};
const shortDate = value => new Intl.DateTimeFormat("ru-RU", { day: "numeric", month: "short" }).format(value);
const formatTimestamp = seconds => {
  const date = new Date(Number(seconds) * 1000);
  return Number.isFinite(date.getTime()) ? shortDate(date) : "недавно";
};

const icons = {
  tasks: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" aria-hidden="true"><path d="m5 12 4 4L19 6"/></svg>',
  dates: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" aria-hidden="true"><rect x="3" y="5" width="18" height="16" rx="3"/><path d="M8 3v4m8-4v4M3 10h18"/></svg>',
  memories: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" aria-hidden="true"><path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20V3H6.5A2.5 2.5 0 0 0 4 5.5v14Z"/></svg>',
  wishes: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" aria-hidden="true"><path d="m12 3 2.7 5.5 6.1.9-4.4 4.3 1 6.1-5.4-2.9-5.4 2.9 1-6.1-4.4-4.3 6.1-.9Z"/></svg>'
};
const editIcon = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L8 18l-4 1 1-4Z"/></svg>';
const trashIcon = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><path d="M4 7h16M9 7V4h6v3m3 0-1 14H7L6 7m4 4v6m4-6v6"/></svg>';
const restoreIcon = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><path d="M3 12a9 9 0 1 0 3-6.7L3 8"/><path d="M3 3v5h5"/></svg>';
const checkIcon = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="m5 12 4 4L19 6"/></svg>';

function toast(message) {
  const element = document.querySelector("#toast");
  element.textContent = message;
  element.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => element.classList.remove("show"), 2800);
}

function haptic(type = "light") {
  try { tg?.HapticFeedback?.impactOccurred(type); } catch {}
}

async function api(path, options = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 20000);
  try {
    const response = await fetch(path, {
      ...options,
      signal: controller.signal,
      headers: {
        "content-type": "application/json",
        "x-telegram-init-data": tg?.initData || "",
        "x-timezone": timezone,
        ...options.headers
      }
    });
    const raw = await response.text();
    let data = {};
    if (raw) {
      try { data = JSON.parse(raw); }
      catch { throw new Error("Сервер вернул некорректный ответ"); }
    }
    if (!response.ok) {
      const error = new Error(data.error || `Ошибка ${response.status}`);
      error.code = data.code;
      error.status = response.status;
      throw error;
    }
    return data;
  } catch (error) {
    if (error.name === "AbortError") throw new Error("Сервер долго не отвечает. Попробуйте ещё раз.");
    if (error instanceof TypeError) throw new Error("Нет соединения с сервером. Проверьте интернет.");
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

function applyTheme() {
  const dark = tg?.colorScheme === "dark" || (!tg && matchMedia("(prefers-color-scheme: dark)").matches);
  document.documentElement.dataset.theme = dark ? "dark" : "light";
  try {
    tg?.setHeaderColor?.(dark ? "#1f1c1a" : "#f7f3ed");
    tg?.setBackgroundColor?.(dark ? "#1f1c1a" : "#f7f3ed");
  } catch {}
}

function showAuthExpired(message = "Сессия Telegram истекла. Откройте приложение заново.") {
  app.hidden = true;
  onboarding.hidden = true;
  outside.hidden = false;
  outside.innerHTML = `<h1>Нужно открыть заново</h1><p>${esc(message)}</p><button class="primary" data-action="reload">Открыть из Telegram</button>`;
}

function showFatal(message) {
  app.hidden = true;
  onboarding.hidden = true;
  outside.hidden = false;
  outside.innerHTML = `<h1>Не удалось открыть</h1><p>${esc(message)}</p><button class="primary" data-action="reload">Попробовать ещё раз</button>`;
}

function normalizeState(data) {
  return {
    ...data,
    tasks: data.tasks || [],
    completedTasks: data.completedTasks || [],
    dates: data.dates || [],
    memories: data.memories || [],
    wishes: data.wishes || [],
    completedWishes: data.completedWishes || []
  };
}

function showApp() {
  outside.hidden = true;
  if (state?.pair) {
    onboarding.hidden = true;
    app.hidden = false;
    render();
  } else {
    app.hidden = true;
    onboarding.hidden = false;
  }
}

function updateChrome() {
  const pair = state?.pair;
  document.querySelector("#pair-name").textContent = pair ? (pair.user_b ? `${pair.name1} и ${pair.name2}` : "Ваше пространство") : "DuoPlan";
  document.querySelector("#avatar-letter").textContent = Array.from(state?.user?.display_name || "Д")[0]?.toUpperCase() || "Д";
  document.querySelectorAll(".nav-item[data-route]").forEach(button => {
    const active = button.dataset.route === route;
    button.classList.toggle("active", active);
    if (active) button.setAttribute("aria-current", "page");
    else button.removeAttribute("aria-current");
  });
  try {
    if (route === "home" || !state?.pair) tg?.BackButton?.hide();
    else tg?.BackButton?.show();
  } catch {}
}

function empty(title, text, action = "") {
  return `<div class="empty"><div class="empty-art" aria-hidden="true"></div><h3>${esc(title)}</h3><p>${esc(text)}</p>${action ? `<button class="primary small" data-action="${esc(action)}">Добавить</button>` : ""}</div>`;
}

function pageHead(title) {
  return `<div class="page-head"><button class="back-button" data-route="home" aria-label="На главную">←</button><h2 tabindex="-1">${esc(title)}</h2></div>`;
}

function itemActions(type, id, extra = "") {
  return `<div class="item-actions">${extra}<button class="icon-button" data-edit="${type}" data-id="${id}" aria-label="Редактировать">${editIcon}</button><button class="icon-button danger" data-delete="${type}" data-id="${id}" aria-label="Удалить">${trashIcon}</button></div>`;
}

function taskItem(item, completed = false) {
  return `<div class="item"><div class="item-main"><p class="item-title">${esc(item.title)}</p><p class="item-meta">${completed ? `Завершён ${formatTimestamp(item.completed_at)}` : `Добавлен ${formatTimestamp(item.created_at)}`}</p></div><div class="item-actions">${completed ? `<button class="icon-button" data-action="restore-task" data-id="${item.id}" aria-label="Вернуть в планы">${restoreIcon}</button>` : `<button class="icon-button" data-action="done-task" data-id="${item.id}" aria-label="Завершить план">${checkIcon}</button>`}<button class="icon-button" data-edit="tasks" data-id="${item.id}" aria-label="Редактировать">${editIcon}</button><button class="icon-button danger" data-delete="tasks" data-id="${item.id}" aria-label="Удалить">${trashIcon}</button></div></div>`;
}

function wishItem(item, completed = false) {
  return `<div class="item"><div class="item-main"><p class="item-title">${esc(item.body)}</p><p class="item-meta">${completed ? "Исполнено" : `Желание · ${esc(item.display_name || "Один из вас")}`}</p></div><div class="item-actions">${completed ? `<button class="icon-button" data-action="restore-wish" data-id="${item.id}" aria-label="Вернуть в желания">${restoreIcon}</button>` : `<button class="icon-button" data-action="done-wish" data-id="${item.id}" aria-label="Отметить исполненным">${checkIcon}</button>`}<button class="icon-button" data-edit="wishes" data-id="${item.id}" aria-label="Редактировать">${editIcon}</button><button class="icon-button danger" data-delete="wishes" data-id="${item.id}" aria-label="Удалить">${trashIcon}</button></div></div>`;
}

function memoryItem(item) {
  return `<article class="item memory"><div class="item-main"><span class="memory-date">${formatDate(item.day)} · ${esc(item.display_name || "Один из вас")}</span><p class="item-body">${esc(item.body)}</p></div><div class="item-actions"><button class="icon-button" data-edit="memories" data-id="${item.id}" aria-label="Редактировать">${editIcon}</button><button class="icon-button danger" data-delete="memories" data-id="${item.id}" aria-label="Удалить">${trashIcon}</button></div></article>`;
}

function annualDate(day, year) {
  const [, month, date] = String(day).split("-").map(Number);
  const result = new Date(year, month - 1, date, 12);
  return result.getMonth() === month - 1 ? result : null;
}

function nextOccurrence(item) {
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 12);
  if (!item.recurs) {
    const [year, month, date] = String(item.day).split("-").map(Number);
    return new Date(year, month - 1, date, 12);
  }
  for (let year = now.getFullYear(); year <= now.getFullYear() + 8; year++) {
    const candidate = annualDate(item.day, year);
    if (candidate && candidate >= today) return candidate;
  }
  return null;
}

function dateItem(item) {
  const next = nextOccurrence(item);
  const today = new Date();
  const midnight = new Date(today.getFullYear(), today.getMonth(), today.getDate(), 12);
  const days = next ? Math.round((next - midnight) / 86400000) : null;
  let label = "";
  if (days === null) label = "Дата";
  else if (days < 0) label = `${Math.abs(days)} ${plural(Math.abs(days), "день", "дня", "дней")} назад`;
  else if (days === 0) label = "Сегодня";
  else if (days === 1) label = "Завтра";
  else label = `Через ${days} ${plural(days, "день", "дня", "дней")}`;
  return `<div class="item"><div class="item-main"><p class="item-title">${esc(item.title)}</p><p class="item-meta">${formatDate(item.day)}${item.recurs ? " · каждый год" : " · один раз"}</p></div><span class="day-chip">${label}</span><div class="item-actions"><button class="icon-button" data-edit="dates" data-id="${item.id}" aria-label="Редактировать">${editIcon}</button><button class="icon-button danger" data-delete="dates" data-id="${item.id}" aria-label="Удалить">${trashIcon}</button></div></div>`;
}

function renderHome() {
  const { pair, daily, tasks, memories } = state;
  const upcoming = [...state.dates].sort((a, b) => {
    const da = nextOccurrence(a), db = nextOccurrence(b);
    return (da?.getTime() ?? Infinity) - (db?.getTime() ?? Infinity);
  }).slice(0, 2);
  return `<section class="view">
    <div class="hero-card"><span class="overline">ВАШ ОБЩИЙ РИТМ</span><h2 tabindex="-1">${pair.user_b ? "Маленькие шаги к большому «мы»." : "Пригласите партнёра в ваше пространство."}</h2><div class="hero-meta"><span>${pair.together_pts} XP вместе</span><span>Серия ${state.user.streak} ${plural(state.user.streak, "день", "дня", "дней")}</span></div></div>
    ${daily ? `<div class="ritual ${daily.done ? "done" : ""}"><div class="ritual-head"><span class="overline">РИТУАЛ ДНЯ</span><span class="day-chip">${daily.done ? "Выполнено" : "Сегодня"}</span></div><p>${esc(daily.action)}</p>${daily.done ? "" : '<button class="primary small" data-action="done-daily">Мы это сделали · +10 XP</button>'}</div>` : ""}
    <div class="section-title"><h3>Добавить в вашу историю</h3></div>
    <div class="quick-grid">${["tasks","dates","memories","wishes"].map(type => `<button class="quick-tile" data-action="add-${type}">${icons[type]}${{tasks:"План",dates:"Дата",memories:"Момент",wishes:"Желание"}[type]}</button>`).join("")}</div>
    <div class="section-title"><h3>Ближайшие планы</h3><button class="text-button" data-route="tasks">Все</button></div>
    <div class="preview-list">${tasks.length ? tasks.slice(0,3).map(item => taskItem(item)).join("") : empty("Всё впереди", "Добавьте первый совместный план.", "add-tasks")}</div>
    ${upcoming.length ? `<div class="section-title"><h3>Ближайшие даты</h3><button class="text-button" data-route="dates">Все</button></div><div class="preview-list">${upcoming.map(dateItem).join("")}</div>` : ""}
    ${memories.length ? `<div class="section-title"><h3>Из вашего дневника</h3><button class="text-button" data-route="memories">Открыть</button></div><div class="preview-list">${memoryItem(memories[0])}</div>` : ""}
  </section>`;
}

function renderTasks() {
  return `<section class="view">${pageHead("Наши планы")}<button class="primary full" data-action="add-tasks">Добавить план</button><div class="preview-list">${state.tasks.length ? state.tasks.map(item => taskItem(item)).join("") : empty("Пока свободно", "Добавьте первый общий шаг.", "add-tasks")}</div>${state.completedTasks.length ? `<details class="archive"><summary>Завершённые · ${state.completedTasks.length}</summary><div class="preview-list">${state.completedTasks.map(item => taskItem(item, true)).join("")}</div></details>` : ""}</section>`;
}

function renderDates() {
  const items = [...state.dates].sort((a, b) => {
    const da = nextOccurrence(a), db = nextOccurrence(b);
    return (da?.getTime() ?? Infinity) - (db?.getTime() ?? Infinity);
  });
  return `<section class="view">${pageHead("Значимые даты")}<button class="primary full" data-action="add-dates">Добавить дату</button><div class="preview-list">${items.length ? items.map(dateItem).join("") : empty("Важные моменты", "Сохраните дату, которую хочется беречь.", "add-dates")}</div></section>`;
}

function renderMemories() {
  return `<section class="view">${pageHead("Дневник двоих")}<button class="primary full" data-action="add-memories">Записать момент</button><div class="preview-list">${state.memories.length ? state.memories.map(memoryItem).join("") : empty("История начинается", "Запишите момент, к которому захочется вернуться.", "add-memories")}</div></section>`;
}

function renderWishes() {
  return `<section class="view">${pageHead("Наши желания")}<button class="primary full" data-action="add-wishes">Добавить желание</button><div class="preview-list">${state.wishes.length ? state.wishes.map(item => wishItem(item)).join("") : empty("О чём мечтается?", "Добавьте желание — большое или совсем маленькое.", "add-wishes")}</div>${state.completedWishes.length ? `<details class="archive"><summary>Исполненные · ${state.completedWishes.length}</summary><div class="preview-list">${state.completedWishes.map(item => wishItem(item, true)).join("")}</div></details>` : ""}</section>`;
}

function renderPair() {
  const { pair, user } = state;
  return `<section class="view">${pageHead("Наша пара")}<div class="pair-card"><p class="pair-names">${esc(pair.name1)}${pair.name2 ? ` и ${esc(pair.name2)}` : ""}</p><span class="overline">В DUOPLAN С ${formatDate(pair.started_at).toUpperCase()}</span>${pair.user_b ? "" : `<div><span class="pair-code">${esc(pair.code)}</span><p class="item-meta">Код для партнёра</p></div>`}</div><div class="stats"><div class="stat"><strong>${pair.together_pts}</strong><span>ОБЩИЕ XP</span></div><div class="stat"><strong>${user.points}</strong><span>ВАШИ XP</span></div><div class="stat"><strong>${user.streak}</strong><span>ДНЕЙ ПОДРЯД</span></div></div>${pair.user_b ? "" : '<button class="primary full" data-action="invite">Пригласить партнёра</button><button class="secondary full" data-action="copy-code">Скопировать код</button>'}<button class="danger-button full" data-action="leave-pair">Выйти из пространства</button></section>`;
}

const views = { home: renderHome, tasks: renderTasks, dates: renderDates, memories: renderMemories, wishes: renderWishes, pair: renderPair };

function render(focus = false) {
  updateChrome();
  content.innerHTML = (views[route] || renderHome)();
  if (focus) content.querySelector("h2")?.focus();
}

function navigate(next, push = true) {
  if (!views[next]) next = "home";
  const changed = route !== next;
  route = next;
  if (push) history.pushState({ route }, "", `#${route}`);
  if (changed) window.scrollTo({ top: 0, behavior: "auto" });
  render(true);
}

async function mutate(path, options, successMessage = "") {
  try {
    state = normalizeState(await api(path, options));
    if (!state.pair) {
      app.hidden = true;
      onboarding.hidden = false;
      outside.hidden = true;
    } else {
      showApp();
    }
    if (successMessage) toast(successMessage);
    haptic("light");
    return state;
  } catch (error) {
    if (error.status === 401) showAuthExpired(error.message);
    else toast(error.message);
    return null;
  }
}

function showTypeDialog() {
  typeDialog.showModal();
}

function field(name, label, type = "text", placeholder = "", value = "", attributes = "") {
  return `<label class="field"><span>${esc(label)}</span><input name="${esc(name)}" type="${esc(type)}" placeholder="${esc(placeholder)}" value="${esc(value)}" ${attributes} required></label>`;
}

function textarea(name, label, placeholder, value = "", max = 2000) {
  return `<label class="field"><span>${esc(label)}</span><textarea name="${esc(name)}" maxlength="${max}" placeholder="${esc(placeholder)}" required>${esc(value)}</textarea><small class="field-count">До ${max} символов</small></label>`;
}

function showForm(action, title, description, fields, submitLabel = "Сохранить", id = null) {
  pendingAction = action;
  pendingId = id;
  dialogBusy = false;
  formError.hidden = true;
  formError.textContent = "";
  document.querySelector("#dialog-title").textContent = title;
  document.querySelector("#dialog-description").textContent = description;
  document.querySelector("#dialog-fields").innerHTML = fields;
  form.querySelector('[type="submit"]').textContent = submitLabel;
  dialog.showModal();
  setTimeout(() => dialog.querySelector("input,textarea")?.focus(), 80);
}

function itemById(type, id) {
  const collections = { tasks: "tasks", dates: "dates", memories: "memories", wishes: "wishes" };
  return [...(state[collections[type]] || []), ...(type === "tasks" ? state.completedTasks : type === "wishes" ? state.completedWishes : [])]
    .find(item => Number(item.id) === Number(id));
}

function openAdd(type) {
  typeDialog.close();
  if (type === "tasks") showForm("add-tasks", "Новый план", "Одно понятное действие, которое вы сделаете вместе.", field("title", "Что хотите сделать?", "text", "Например, выбрать место для поездки", "", 'maxlength="180"'));
  if (type === "dates") showForm("add-dates", "Значимая дата", "Сохраним событие вашей истории.", field("title", "Название", "text", "Например, наше первое путешествие", "", 'maxlength="120"') + field("day", "Дата", "date") + '<label class="check-field"><input name="recurs" type="checkbox" checked><span>Повторять каждый год</span></label>');
  if (type === "memories") showForm("add-memories", "Сохранить момент", "Пара строк, к которым будет приятно вернуться.", textarea("body", "Ваше воспоминание", "Сегодня был особенный день…", "", 2000));
  if (type === "wishes") showForm("add-wishes", "Новое желание", "Большое или совсем маленькое — партнёр его увидит.", textarea("body", "Чего вы хотите?", "Например, провести выходной у моря", "", 300));
  if (type === "join") showForm("join-pair", "Войти по коду", "Введите восьмизначный код из приглашения партнёра.", field("code", "Код приглашения", "text", "A1B2C3D4", "", 'maxlength="8" autocapitalize="characters" autocomplete="off" spellcheck="false" pattern="[A-Fa-f0-9]{8}"'), "Соединить");
}

function openEdit(type, id) {
  const item = itemById(type, id);
  if (!item) return toast("Запись не найдена");
  if (type === "tasks") showForm("edit-tasks", "Изменить план", "Обновите формулировку общего плана.", field("title", "План", "text", "", item.title, 'maxlength="180"'), "Сохранить", id);
  if (type === "dates") showForm("edit-dates", "Изменить дату", "Обновите название или дату события.", field("title", "Название", "text", "", item.title, 'maxlength="120"') + field("day", "Дата", "date", "", item.day) + `<label class="check-field"><input name="recurs" type="checkbox" ${item.recurs ? "checked" : ""}><span>Повторять каждый год</span></label>`, "Сохранить", id);
  if (type === "memories") showForm("edit-memories", "Изменить момент", "Исправьте запись в вашем дневнике.", textarea("body", "Воспоминание", "", item.body, 2000), "Сохранить", id);
  if (type === "wishes") showForm("edit-wishes", "Изменить желание", "Обновите описание желания.", textarea("body", "Желание", "", item.body, 300), "Сохранить", id);
}

form.addEventListener("submit", async event => {
  event.preventDefault();
  if (dialogBusy) return;
  const submit = form.querySelector('[type="submit"]');
  const cancel = form.querySelector('[data-action="close-dialog"]');
  const values = Object.fromEntries(new FormData(form));
  const requests = {
    "add-tasks": ["/api/tasks", "POST"], "add-dates": ["/api/dates", "POST"], "add-memories": ["/api/memories", "POST"], "add-wishes": ["/api/wishes", "POST"],
    "join-pair": ["/api/pair/join", "POST"],
    "edit-tasks": [`/api/tasks/${pendingId}`, "PATCH"], "edit-dates": [`/api/dates/${pendingId}`, "PATCH"],
    "edit-memories": [`/api/memories/${pendingId}`, "PATCH"], "edit-wishes": [`/api/wishes/${pendingId}`, "PATCH"]
  };
  const request = requests[pendingAction];
  if (!request) return;
  if (values.code) values.code = values.code.trim().toUpperCase();
  if ("recurs" in values) values.recurs = form.elements.recurs?.checked ?? false;
  dialogBusy = true;
  submit.disabled = true;
  cancel.disabled = true;
  submit.textContent = "Сохраняем…";
  formError.hidden = true;
  try {
    state = normalizeState(await api(request[0], { method: request[1], body: JSON.stringify(values) }));
    dialog.close();
    form.reset();
    showApp();
    toast(pendingAction.startsWith("edit-") ? "Изменения сохранены" : pendingAction === "join-pair" ? "Вы теперь вместе" : "Добавлено");
    haptic("medium");
  } catch (error) {
    if (error.status === 401) { dialog.close(); showAuthExpired(error.message); return; }
    formError.textContent = error.message;
    formError.hidden = false;
    formError.focus?.();
  } finally {
    dialogBusy = false;
    submit.disabled = false;
    cancel.disabled = false;
    submit.textContent = pendingAction?.startsWith("edit-") || pendingAction === "join-pair" ? "Сохранить" : "Сохранить";
  }
});

document.addEventListener("submit", event => {
  if (event.target === form) return;
  event.preventDefault();
});

document.addEventListener("click", async event => {
  const button = event.target.closest("button");
  if (!button) return;
  if (button.dataset.route) { navigate(button.dataset.route); return; }
  const action = button.dataset.action;
  if (button.dataset.edit) { openEdit(button.dataset.edit, button.dataset.id); return; }
  if (button.dataset.delete) {
    const type = button.dataset.delete;
    if (!confirm("Удалить запись? Это действие нельзя отменить.")) return;
    button.disabled = true;
    const ok = await mutate(`/api/${type}/${button.dataset.id}`, { method: "DELETE" }, "Удалено");
    if (!ok) button.disabled = false;
    return;
  }
  if (!action) return;
  if (action.startsWith("add-")) { openAdd(action.slice(4)); return; }
  if (action === "show-join") { openAdd("join"); return; }
  if (action === "quick-add") { showTypeDialog(); return; }
  if (action === "close-type") { typeDialog.close(); return; }
  if (action === "close-dialog") { if (!dialogBusy) dialog.close(); return; }
  if (action === "reload") { if (tg?.reload) tg.reload(); else location.reload(); return; }
  if (action === "create-pair") {
    button.disabled = true;
    const result = await mutate("/api/pair/create", { method: "POST", body: "{}" }, "Пространство создано");
    if (!result) button.disabled = false;
    return;
  }
  if (action === "invite") {
    const url = `https://t.me/duoplanbot?start=${state.pair.code}`;
    const share = `https://t.me/share/url?url=${encodeURIComponent(url)}&text=${encodeURIComponent("Присоединяйся к нашему пространству в DuoPlan")}`;
    tg?.openTelegramLink ? tg.openTelegramLink(share) : window.open(share, "_blank"); return;
  }
  if (action === "copy-code") {
    if (!state.pair.code) return toast("Партнёр уже с вами");
    try { await navigator.clipboard.writeText(state.pair.code); toast("Код скопирован"); }
    catch { toast(`Код: ${state.pair.code}`); }
    return;
  }
  if (action === "leave-pair") {
    const warning = state.pair.user_b
      ? "Выйти из пространства? Общие записи останутся у партнёра."
      : "Выйти и удалить пустое пространство? Это действие нельзя отменить.";
    if (!confirm(warning)) return;
    button.disabled = true;
    const result = await mutate("/api/pair/leave", { method: "POST", body: "{}" }, "Вы вышли из пространства");
    if (!result) button.disabled = false;
    return;
  }
  const requests = {
    "done-task": [`/api/tasks/${button.dataset.id}/done`, "План завершён"],
    "restore-task": [`/api/tasks/${button.dataset.id}/reopen`, "План возвращён"],
    "done-wish": [`/api/wishes/${button.dataset.id}/done`, "Желание исполнено"],
    "restore-wish": [`/api/wishes/${button.dataset.id}/reopen`, "Желание возвращено"],
    "done-daily": ["/api/daily/done", ""]
  };
  if (requests[action]) {
    button.disabled = true;
    const result = await mutate(requests[action][0], { method: "POST", body: "{}" });
    if (result && action === "done-daily") {
      toast(result.awarded ? "+10 XP · ритуал отмечен" : "Сегодняшний ритуал уже отмечен");
      haptic("heavy");
    } else if (result) toast(requests[action][1]);
    else button.disabled = false;
  }
});

dialog.addEventListener("cancel", event => {
  if (dialogBusy) event.preventDefault();
});

async function init() {
  applyTheme();
  try {
    tg?.ready();
    tg?.expand();
    tg?.disableVerticalSwipes?.();
    tg?.onEvent?.("themeChanged", applyTheme);
    tg?.BackButton?.onClick(() => {
      if (route === "home") tg?.close?.();
      else navigate("home");
    });
  } catch {}
  if (!tg?.initData) {
    showFatal("Управление доступно внутри Telegram. Откройте @duoplanbot и нажмите «Открыть наше пространство».");
    return;
  }
  try {
    state = normalizeState(await api("/api/state"));
    const initial = location.hash.replace(/^#/, "");
    route = views[initial] ? initial : "home";
    history.replaceState({ route }, "", `#${route}`);
    showApp();
    window.addEventListener("popstate", event => {
      route = views[event.state?.route] ? event.state.route : "home";
      render(true);
    });
  } catch (error) {
    if (error.status === 401) showAuthExpired(error.message);
    else showFatal(error.message);
  }
}

init();
