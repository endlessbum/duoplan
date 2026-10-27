const tg = window.Telegram?.WebApp;
const app = document.querySelector("#app");
const content = document.querySelector("#content");
const onboarding = document.querySelector("#onboarding");
const outside = document.querySelector("#outside");
const dialog = document.querySelector("#dialog");
const form = document.querySelector("#dialog-form");
let state = null;
let route = "home";
let pendingAction = null;
let toastTimer;

const esc = value => String(value ?? "").replace(/[&<>"']/g, char => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[char]));
const formatDate = day => new Intl.DateTimeFormat("ru-RU", { day: "numeric", month: "long", year: "numeric" }).format(new Date(`${day}T12:00:00`));
const shortDate = day => new Intl.DateTimeFormat("ru-RU", { day: "numeric", month: "short" }).format(new Date(`${day}T12:00:00`));
const checkIcon = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="m5 12 4 4L19 6"/></svg>';
const icons = {
  tasks: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7"><path d="m5 12 4 4L19 6"/></svg>',
  dates: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7"><rect x="3" y="5" width="18" height="16" rx="3"/><path d="M8 3v4m8-4v4M3 10h18"/></svg>',
  memories: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7"><path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20V3H6.5A2.5 2.5 0 0 0 4 5.5v14Z"/></svg>',
  wishes: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7"><path d="m12 3 2.7 5.5 6.1.9-4.4 4.3 1 6.1-5.4-2.9-5.4 2.9 1-6.1-4.4-4.3 6.1-.9Z"/></svg>'
};

function toast(message) {
  const element = document.querySelector("#toast");
  element.textContent = message;
  element.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => element.classList.remove("show"), 2600);
}

async function api(path, options = {}) {
  const response = await fetch(path, {
    ...options,
    headers: { "content-type": "application/json", "x-telegram-init-data": tg?.initData || "", ...options.headers }
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || "Ошибка соединения");
  return data;
}

function updateChrome() {
  const pair = state?.pair;
  document.querySelector("#pair-name").textContent = pair ? (pair.user_b ? `${pair.name1} и ${pair.name2}` : "Ваше пространство") : "DuoPlan";
  document.querySelector("#avatar-letter").textContent = (state?.user?.display_name || "Д")[0].toUpperCase();
  document.querySelectorAll(".nav-item[data-route]").forEach(button => button.classList.toggle("active", button.dataset.route === route || (route === "wishes" && button.dataset.route === "home")));
}

function empty(title, text) {
  return `<div class="empty"><div class="empty-art"></div><h3>${title}</h3><p>${text}</p></div>`;
}

function pageHead(title) {
  return `<div class="page-head"><button class="back-button" data-route="home" aria-label="Назад">←</button><h2>${title}</h2></div>`;
}

function taskItem(item) {
  return `<div class="item"><div class="item-main"><p class="item-title">${esc(item.title)}</p><p class="item-meta">Добавлен ${shortDate(new Date(item.created_at * 1000).toISOString().slice(0,10))}</p></div><button class="icon-button" data-action="done-task" data-id="${item.id}" aria-label="Завершить план">${checkIcon}</button></div>`;
}

function memoryItem(item) {
  return `<article class="item memory"><span class="memory-date">${formatDate(item.day)} · ${esc(item.display_name || "Один из вас")}</span><p class="item-body">${esc(item.body)}</p></article>`;
}

function wishItem(item) {
  return `<div class="item"><div class="item-main"><p class="item-title">${esc(item.body)}</p><p class="item-meta">Желание · ${esc(item.display_name || "Один из вас")}</p></div><button class="icon-button" data-action="done-wish" data-id="${item.id}" aria-label="Отметить исполненным">${checkIcon}</button></div>`;
}

function dateItem(item) {
  const date = new Date(`${item.day}T12:00:00`);
  const next = new Date(date);
  const now = new Date();
  if (item.recurs) {
    next.setFullYear(now.getFullYear());
    if (next < new Date(now.getFullYear(), now.getMonth(), now.getDate())) next.setFullYear(now.getFullYear() + 1);
  }
  const days = Math.max(0, Math.ceil((next - now) / 86400000));
  return `<div class="item"><div class="item-main"><p class="item-title">${esc(item.title)}</p><p class="item-meta">${formatDate(item.day)}${item.recurs ? " · каждый год" : ""}</p></div><span class="day-chip">${days === 0 ? "Сегодня" : `${days} дн.`}</span></div>`;
}

function renderHome() {
  const { pair, daily, tasks, memories } = state;
  return `<section class="view">
    <div class="hero-card"><span class="overline">ВАШ ОБЩИЙ РИТМ</span><h2>${pair.user_b ? "Маленькие шаги к большому «мы»." : "Пригласите партнёра в ваше пространство."}</h2><div class="hero-meta"><span>${pair.together_pts} XP вместе</span><span>Серия ${state.user.streak} дн.</span></div></div>
    <div class="ritual ${daily.done ? "done" : ""}"><div class="ritual-head"><span class="overline">РИТУАЛ ДНЯ</span><span class="day-chip">${daily.done ? "Выполнено" : "Сегодня"}</span></div><p>${esc(daily.action)}</p>${daily.done ? "" : '<button class="primary small" data-action="done-daily">Мы это сделали · +10 XP</button>'}</div>
    <div class="section-title"><h3>Добавить в вашу историю</h3></div>
    <div class="quick-grid">${["tasks","dates","memories","wishes"].map(type => `<button class="quick-tile" data-action="add-${type}">${icons[type]}${{tasks:"План",dates:"Дата",memories:"Момент",wishes:"Желание"}[type]}</button>`).join("")}</div>
    <div class="section-title"><h3>Ближайшие планы</h3><button class="text-button" data-route="tasks">Все</button></div>
    <div class="preview-list">${tasks.length ? tasks.slice(0,3).map(taskItem).join("") : empty("Всё впереди", "Добавьте первый совместный план.")}</div>
    ${memories.length ? `<div class="section-title"><h3>Из вашего дневника</h3><button class="text-button" data-route="memories">Открыть</button></div><div class="preview-list">${memoryItem(memories[0])}</div>` : ""}
  </section>`;
}

function renderList(type, title, items, renderer, emptyTitle, emptyText) {
  return `<section class="view">${pageHead(title)}<button class="primary full" data-action="add-${type}">Добавить</button><div class="section-title"><h3>${items.length ? `Сохранено · ${items.length}` : "Ваше пространство"}</h3></div><div class="preview-list">${items.length ? items.map(renderer).join("") : empty(emptyTitle, emptyText)}</div></section>`;
}

function renderPair() {
  const { pair, user } = state;
  return `<section class="view">${pageHead("Наша пара")}<div class="pair-card"><p class="pair-names">${esc(pair.name1)}${pair.name2 ? ` и ${esc(pair.name2)}` : ""}</p><span class="overline">В DUOPLAN С ${formatDate(pair.started_at).toUpperCase()}</span>${pair.user_b ? "" : `<div><span class="pair-code">${esc(pair.code)}</span><p class="item-meta">Код для партнёра</p></div>`}</div><div class="stats"><div class="stat"><strong>${pair.together_pts}</strong><span>ОБЩИЕ XP</span></div><div class="stat"><strong>${user.points}</strong><span>ВАШИ XP</span></div><div class="stat"><strong>${user.streak}</strong><span>ДНЕЙ ПОДРЯД</span></div></div>${pair.user_b ? "" : '<button class="primary full" data-action="invite">Пригласить партнёра</button>'}<button class="secondary full" data-action="copy-code">Скопировать код приглашения</button></section>`;
}

function render() {
  updateChrome();
  const views = {
    home: renderHome,
    tasks: () => renderList("tasks", "Наши планы", state.tasks, taskItem, "Пока свободно", "Добавьте первый общий шаг."),
    dates: () => renderList("dates", "Значимые даты", state.dates, dateItem, "Важные моменты", "Сохраните дату, которую хочется беречь."),
    memories: () => renderList("memories", "Дневник двоих", state.memories, memoryItem, "История начинается", "Запишите момент, к которому захочется вернуться."),
    wishes: () => renderList("wishes", "Наши желания", state.wishes, wishItem, "О чём мечтается?", "Добавьте желание — большое или совсем маленькое."),
    pair: renderPair
  };
  content.innerHTML = (views[route] || renderHome)();
  window.scrollTo({ top: 0, behavior: "instant" });
}

function showForm(action, title, description, fields, submitLabel = "Сохранить") {
  pendingAction = action;
  document.querySelector("#dialog-title").textContent = title;
  document.querySelector("#dialog-description").textContent = description;
  document.querySelector("#dialog-fields").innerHTML = fields;
  form.querySelector('[type="submit"]').textContent = submitLabel;
  dialog.showModal();
  setTimeout(() => dialog.querySelector("input,textarea")?.focus(), 80);
}

const field = (name, label, type = "text", placeholder = "") => `<label class="field"><span>${label}</span><input name="${name}" type="${type}" placeholder="${placeholder}" required></label>`;

function openAdd(type) {
  const forms = {
    "add-tasks": () => showForm("add-tasks", "Новый план", "Одно понятное действие, которое вы сделаете вместе.", field("title", "Что хотите сделать?", "text", "Например, выбрать место для поездки")),
    "add-dates": () => showForm("add-dates", "Значимая дата", "Сохраним событие вашей истории.", field("title", "Название", "text", "Например, наше первое путешествие") + field("day", "Дата", "date")),
    "add-memories": () => showForm("add-memories", "Сохранить момент", "Пара строк, к которым будет приятно вернуться.", '<label class="field"><span>Ваше воспоминание</span><textarea name="body" placeholder="Сегодня был особенный день…" required></textarea></label>'),
    "add-wishes": () => showForm("add-wishes", "Новое желание", "Большое или совсем маленькое — партнёр его увидит.", '<label class="field"><span>Чего вы хотите?</span><textarea name="body" placeholder="Например, провести выходной у моря" required></textarea></label>'),
    "join-pair": () => showForm("join-pair", "Войти по коду", "Введите восьмизначный код из приглашения партнёра.", field("code", "Код приглашения", "text", "A1B2C3D4"), "Соединить")
  };
  forms[type]?.();
}

async function refresh(path, options) {
  try {
    state = await api(path, options);
    if (state.pair) {
      onboarding.hidden = true;
      app.hidden = false;
      render();
    } else {
      app.hidden = true;
      onboarding.hidden = false;
    }
  } catch (error) { toast(error.message); }
}

form.addEventListener("submit", async event => {
  event.preventDefault();
  const values = Object.fromEntries(new FormData(form));
  const submit = form.querySelector('[type="submit"]');
  submit.disabled = true;
  const requests = {
    "add-tasks": ["/api/tasks", values],
    "add-dates": ["/api/dates", values],
    "add-memories": ["/api/memories", values],
    "add-wishes": ["/api/wishes", values],
    "join-pair": ["/api/pair/join", values]
  };
  const request = requests[pendingAction];
  if (request) {
    await refresh(request[0], { method: "POST", body: JSON.stringify(request[1]) });
    dialog.close();
    form.reset();
  }
  submit.disabled = false;
});

document.addEventListener("click", async event => {
  const button = event.target.closest("button");
  if (!button) return;
  if (button.dataset.route) { route = button.dataset.route; render(); return; }
  const action = button.dataset.action;
  if (!action) return;
  if (action.startsWith("add-") || action === "join-pair") { openAdd(action); return; }
  if (action === "show-join") { openAdd("join-pair"); return; }
  if (action === "close-dialog") { dialog.close(); return; }
  if (action === "quick-add") {
    const next = { home: "tasks", tasks: "dates", dates: "memories", memories: "wishes", wishes: "tasks", pair: "memories" }[route];
    route = next; render(); openAdd(`add-${next}`); return;
  }
  if (action === "create-pair") { await refresh("/api/pair/create", { method: "POST", body: "{}" }); return; }
  if (action === "invite") {
    const url = `https://t.me/duoplanbot?start=${state.pair.code}`;
    const share = `https://t.me/share/url?url=${encodeURIComponent(url)}&text=${encodeURIComponent("Присоединяйся к нашему пространству в DuoPlan")}`;
    tg?.openTelegramLink ? tg.openTelegramLink(share) : window.open(share, "_blank"); return;
  }
  if (action === "copy-code") {
    try { await navigator.clipboard.writeText(state.pair.code); toast("Код скопирован"); } catch { toast(`Код: ${state.pair.code}`); } return;
  }
  const requests = {
    "done-task": [`/api/tasks/${button.dataset.id}/done`, "План завершён"],
    "done-wish": [`/api/wishes/${button.dataset.id}/done`, "Желание исполнено"],
    "done-daily": ["/api/daily/done", "+10 XP · ритуал отмечен"]
  };
  if (requests[action]) {
    button.disabled = true;
    await refresh(requests[action][0], { method: "POST", body: "{}" });
    toast(requests[action][1]);
  }
});

async function init() {
  tg?.ready();
  tg?.expand();
  tg?.setHeaderColor?.("#f7f3ed");
  tg?.setBackgroundColor?.("#f7f3ed");
  if (!tg?.initData) {
    outside.innerHTML = '<div class="onboarding-art"><span></span><span></span></div><h1>Откройте в Telegram</h1><p>Управление пространством доступно в защищённом Mini App. Перейдите к @duoplanbot и нажмите «Открыть наше пространство».</p><a class="primary full" style="display:grid;place-items:center;text-decoration:none" href="https://t.me/duoplanbot">Открыть @duoplanbot</a>';
    return;
  }
  try {
    state = await api("/api/state");
    outside.hidden = true;
    if (state.pair) { app.hidden = false; render(); }
    else onboarding.hidden = false;
  } catch (error) {
    outside.innerHTML = `<h1>Не удалось открыть</h1><p>${esc(error.message)}</p><button class="primary" onclick="location.reload()">Попробовать ещё раз</button>`;
  }
}

init();
