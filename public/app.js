const tg = window.Telegram?.WebApp;
const app = document.querySelector("#app");
const content = document.querySelector("#content");
const onboarding = document.querySelector("#onboarding");
const outside = document.querySelector("#outside");
const dialog = document.querySelector("#dialog");
const form = document.querySelector("#dialog-form");
const formError = document.querySelector("#dialog-error");
const bottomNav = document.querySelector(".bottom-nav");
const navDrop = document.querySelector(".nav-drop");
const navItems = [...document.querySelectorAll(".nav-item[data-route]")];
const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone || "Europe/Moscow";

let state = null;
let route = "home";
let pendingAction = null;
let pendingId = null;
let dialogBusy = false;
let toastTimer;
let dropX = null;
let dropWidth = null;
let dropAnimation = null;

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

const titles = {
  home: "НАШЕ ПРОСТРАНСТВО",
  tasks: "Наши планы",
  dates: "Значимые даты",
  memories: "Дневник двоих",
  wishes: "Наши желания",
  pair: "Наша пара"
};

const reducedMotion = () => matchMedia("(prefers-reduced-motion: reduce)").matches;

// Текущий X анимации (в px) — нужен, если пользователь переключает вкладку
// повторно, пока «капля» ещё летит к предыдущей.
function dropTranslateX() {
  try {
    return new DOMMatrixReadOnly(getComputedStyle(navDrop).transform).m41;
  } catch {
    return null;
  }
}

function setDropX(x) {
  navDrop.style.setProperty("--drop-x", `${x}px`);
}

// Перетекание капли: по пути она вытягивается по горизонтали, на финише
// слегка пружинит обратно. translate3d — позиция, scale — «жидкость».
function animateDrop(from, to) {
  const distance = to - from;
  const stretch = Math.min(1.16, 1 + Math.abs(distance) / 700);
  const squash = 2 - stretch;
  const settleX = 1 - (stretch - 1) * .45;
  const settleY = 1 + (stretch - 1) * .45;
  dropAnimation = navDrop.animate([
    { transform: `translate3d(${from}px,-50%,0) scale(1,1)`, offset: 0 },
    { transform: `translate3d(${from + distance * .32}px,-50%,0) scale(${stretch},${squash})`, offset: .32 },
    { transform: `translate3d(${from + distance * .82}px,-50%,0) scale(${1 + (stretch - 1) * .35},${1 - (squash - 1) * .35})`, offset: .78 },
    { transform: `translate3d(${to}px,-50%,0) scale(${settleX},${settleY})`, offset: .9 },
    { transform: `translate3d(${to}px,-50%,0) scale(1,1)`, offset: 1 }
  ], {
    duration: Math.min(620, 360 + Math.abs(distance) * .35),
    easing: "cubic-bezier(.3,.72,.24,1)"
  });
  dropAnimation.onfinish = () => {
    dropAnimation = null;
    // Пока капля летела, бар мог изменить ширину (скроллбар, поворот) —
    // доводим позицию до актуальной геометрии без второй анимации.
    positionDrop(navItems.find(button => button.dataset.route === route), false);
  };
}

function positionDrop(activeButton, animate = true) {
  if (!navDrop) return;
  if (!activeButton) {
    navDrop.classList.add("is-hidden");
    dropX = null;
    dropWidth = null;
    if (dropAnimation) { dropAnimation.cancel(); dropAnimation = null; }
    return;
  }
  const wasHidden = navDrop.classList.contains("is-hidden");
  navDrop.classList.remove("is-hidden");
  const width = navDrop.offsetWidth;
  const x = activeButton.offsetLeft + (activeButton.offsetWidth - width) / 2;
  const running = dropAnimation;
  dropAnimation = null;
  if (running) {
    const visualX = dropTranslateX();
    running.cancel();
    if (visualX !== null && Number.isFinite(visualX)) dropX = visualX;
  }
  const resized = dropWidth !== null && Math.abs(dropWidth - width) > 1;
  const move = animate && !wasHidden && !resized && !reducedMotion() && dropX !== null && Math.abs(dropX - x) > 1;
  setDropX(x);
  if (move) animateDrop(dropX, x);
  dropX = x;
  dropWidth = width;
}

function updateChrome() {
  const title = document.querySelector("#page-title");
  title.textContent = titles[route] || titles.home;
  title.classList.toggle("is-home", route === "home");
  // Кнопка «Назад» в шапке нужна только на «Нашей паре»: остальные вкладки
  // доступны из нижнего меню, а выше есть системная кнопка Telegram.
  document.querySelector("#topbar-back").hidden = route !== "pair";
  document.querySelector("#avatar-letter").textContent = Array.from(state?.user?.display_name || "Д")[0]?.toUpperCase() || "Д";
  let activeNav = null;
  navItems.forEach(button => {
    const active = button.dataset.route === route;
    button.classList.toggle("active", active);
    if (active) {
      button.setAttribute("aria-current", "page");
      activeNav = button;
    } else {
      button.removeAttribute("aria-current");
    }
  });
  positionDrop(activeNav);
  try {
    if (route === "home" || route === "pair" || !state?.pair) tg?.BackButton?.hide();
    else tg?.BackButton?.show();
  } catch {}
}

function empty(title, text, action = "") {
  return `<div class="empty"><div class="empty-art" aria-hidden="true"></div><h3>${esc(title)}</h3><p>${esc(text)}</p>${action ? `<button class="primary small" data-action="${esc(action)}">Добавить</button>` : ""}</div>`;
}

function itemActions(type, id, extra = "") {
  return `<div class="item-actions">${extra}<button class="icon-button" data-edit="${type}" data-id="${id}" aria-label="Редактировать">${editIcon}</button><button class="icon-button danger" data-delete="${type}" data-id="${id}" aria-label="Удалить">${trashIcon}</button></div>`;
}

// Назначенный момент плана: дата + время, а без времени — конец дня (23:59).
function planTarget(item) {
  if (!item.day) return null;
  const [year, month, date] = String(item.day).split("-").map(Number);
  if (![year, month, date].every(Number.isFinite)) return null;
  let hours = 23, minutes = 59;
  if (item.time) {
    const [hh, mm] = String(item.time).split(":").map(Number);
    if (Number.isFinite(hh) && Number.isFinite(mm)) { hours = hh; minutes = mm; }
  }
  const target = new Date(year, month - 1, date, hours, minutes, 0, 0);
  return Number.isFinite(target.getTime()) ? target : null;
}

function countdownFromDiff(diff) {
  if (diff <= 0) return { overdue: true, text: "Время пришло" };
  const totalMinutes = Math.floor(diff / 60000);
  const minutes = totalMinutes % 60;
  const hours = Math.floor(totalMinutes / 60) % 24;
  const days = Math.floor(totalMinutes / 1440);
  // Меньше суток — подробный отсчёт по часам и минутам.
  if (diff < 86400000) {
    return { overdue: false, text: `Через ${hours} ${plural(hours, "час", "часа", "часов")} ${minutes} ${plural(minutes, "минуту", "минуты", "минут")}` };
  }
  if (days < 60) {
    return { overdue: false, text: `Через ${days} ${plural(days, "день", "дня", "дней")}` };
  }
  const months = Math.floor(days / 30);
  const restDays = days % 30;
  return { overdue: false, text: `Через ${months} ${plural(months, "месяц", "месяца", "месяцев")}${restDays ? ` ${restDays} ${plural(restDays, "день", "дня", "дней")}` : ""}` };
}

function taskCountdown(item, completed) {
  if (completed || !item.day) return null;
  const target = planTarget(item);
  if (!target) return null;
  return { ...countdownFromDiff(target.getTime() - Date.now()), targetMs: target.getTime() };
}

function taskItem(item, completed = false) {
  const countdown = taskCountdown(item, completed);
  const meta = completed ? `Завершён ${formatTimestamp(item.completed_at)}` : `Добавлен ${formatTimestamp(item.created_at)}`;
  const chip = countdown ? `<span class="day-chip ${countdown.overdue ? "is-overdue" : "is-countdown"}" data-countdown="${countdown.targetMs}">${countdown.text}</span>` : "";
  return `<div class="item"><div class="item-main"><p class="item-title">${esc(item.title)}</p><p class="item-meta">${meta}</p></div>${chip}<div class="item-actions">${completed ? `<button class="icon-button" data-action="restore-task" data-id="${item.id}" aria-label="Вернуть в планы">${restoreIcon}</button>` : `<button class="icon-button" data-action="done-task" data-id="${item.id}" aria-label="Завершить план">${checkIcon}</button>`}<button class="icon-button" data-edit="tasks" data-id="${item.id}" aria-label="Редактировать">${editIcon}</button><button class="icon-button danger" data-delete="tasks" data-id="${item.id}" aria-label="Удалить">${trashIcon}</button></div></div>`;
}

function wishItem(item, completed = false) {
  return `<div class="item"><div class="item-main"><p class="item-title">${esc(item.body)}</p><p class="item-meta">${completed ? "Исполнено" : `Желание · ${esc(item.display_name || "Один из вас")}`}</p></div><div class="item-actions">${completed ? `<button class="icon-button" data-action="restore-wish" data-id="${item.id}" aria-label="Вернуть в желания">${restoreIcon}</button>` : `<button class="icon-button" data-action="done-wish" data-id="${item.id}" aria-label="Отметить исполненным">${checkIcon}</button>`}<button class="icon-button" data-edit="wishes" data-id="${item.id}" aria-label="Редактировать">${editIcon}</button><button class="icon-button danger" data-delete="wishes" data-id="${item.id}" aria-label="Удалить">${trashIcon}</button></div></div>`;
}

function memoryItem(item) {
  return `<article class="item memory"><div class="item-main"><span class="memory-date">${formatDate(item.day)} · ${esc(item.display_name || "Один из вас")}</span><p class="item-body">${esc(item.body)}</p></div><div class="item-actions"><button class="icon-button" data-edit="memories" data-id="${item.id}" aria-label="Редактировать">${editIcon}</button><button class="icon-button danger" data-delete="memories" data-id="${item.id}" aria-label="Удалить">${trashIcon}</button></div></article>`;
}

function dayTime(day, time, fallbackHour = 12) {
  const [year, month, date] = String(day).split("-").map(Number);
  let hours = fallbackHour, minutes = 0;
  if (time) {
    const [hh, mm] = String(time).split(":").map(Number);
    if (Number.isFinite(hh) && Number.isFinite(mm)) { hours = hh; minutes = mm; }
  }
  return new Date(year, month - 1, date, hours, minutes, 0, 0);
}

function annualDate(day, year, time) {
  const [, month, date] = String(day).split("-").map(Number);
  let hours = 12, minutes = 0;
  if (time) {
    const [hh, mm] = String(time).split(":").map(Number);
    if (Number.isFinite(hh) && Number.isFinite(mm)) { hours = hh; minutes = mm; }
  }
  const result = new Date(year, month - 1, date, hours, minutes, 0, 0);
  return result.getMonth() === month - 1 ? result : null;
}

function nextOccurrence(item) {
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 0, 0, 0);
  if (!item.recurs) return dayTime(item.day, item.time);
  for (let year = now.getFullYear(); year <= now.getFullYear() + 8; year++) {
    const candidate = annualDate(item.day, year, item.time);
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
  let chipClass = "";
  let dataCountdown = "";
  if (days === null) label = "Дата";
  else if (days < 0) label = `${Math.abs(days)} ${plural(Math.abs(days), "день", "дня", "дней")} назад`;
  else if (days === 0 && item.time) {
    const countdown = countdownFromDiff(next.getTime() - Date.now());
    label = countdown.text;
    chipClass = countdown.overdue ? "is-overdue" : "is-countdown";
    if (!countdown.overdue) dataCountdown = ` data-countdown="${next.getTime()}"`;
  }
  else if (days === 0) label = "Сегодня";
  else if (days === 1) label = "Завтра";
  else label = `Через ${days} ${plural(days, "день", "дня", "дней")}`;
  return `<div class="item"><div class="item-main"><p class="item-title">${esc(item.title)}</p><p class="item-meta">${formatDate(item.day)}${item.recurs ? " · каждый год" : " · один раз"}${item.time ? " · " + esc(item.time) : ""}</p></div><span class="day-chip ${chipClass}"${dataCountdown}>${label}</span><div class="item-actions"><button class="icon-button" data-edit="dates" data-id="${item.id}" aria-label="Редактировать">${editIcon}</button><button class="icon-button danger" data-delete="dates" data-id="${item.id}" aria-label="Удалить">${trashIcon}</button></div></div>`;
}

function renderHome() {
  const { pair, tasks, memories } = state;
  // Ритуал дня — общее действие: пока партнёр не пришёл, карточку не показываем.
  const daily = pair.user_b ? state.daily : null;
  const upcoming = [...state.dates].sort((a, b) => {
    const da = nextOccurrence(a), db = nextOccurrence(b);
    return (da?.getTime() ?? Infinity) - (db?.getTime() ?? Infinity);
  }).slice(0, 2);
  return `<section class="view">
    <div class="hero-card"><span class="overline">ВАШ ОБЩИЙ РИТМ</span><h2 tabindex="-1">${pair.user_b ? "Маленькие шаги к большому «мы»." : "Пригласите партнёра в ваше пространство."}</h2><div class="hero-meta"><span>${pair.together_pts} XP вместе</span><span>Серия ${state.user.streak} ${plural(state.user.streak, "день", "дня", "дней")}</span></div></div>
    ${daily ? `<div class="ritual ${daily.done ? "done" : ""}"><div class="ritual-head"><span class="overline">РИТУАЛ ДНЯ</span><span class="day-chip">${daily.done ? "Выполнено" : "Сегодня"}</span></div><p>${esc(daily.action)}</p>${daily.done ? "" : '<button class="primary small" data-action="done-daily">Мы это сделали · +10 XP</button>'}</div>` : ""}
    <div class="section-title"><h3>Ближайшие планы</h3><button class="text-button" data-route="tasks">Все</button></div>
    <div class="preview-list">${tasks.length ? tasks.slice(0,3).map(item => taskItem(item)).join("") : empty("Всё впереди", "Добавьте первый совместный план.", "add-tasks")}</div>
    ${upcoming.length ? `<div class="section-title"><h3>Ближайшие даты</h3><button class="text-button" data-route="dates">Все</button></div><div class="preview-list">${upcoming.map(dateItem).join("")}</div>` : ""}
    ${memories.length ? `<div class="section-title"><h3>Из вашего дневника</h3><button class="text-button" data-route="memories">Открыть</button></div><div class="preview-list">${memoryItem(memories[0])}</div>` : ""}
  </section>`;
}

function renderTasks() {
  // Верхняя кнопка нужна только когда список непустой: иначе она дублирует
  // кнопку «Добавить» внутри пустого состояния.
  return `<section class="view">${state.tasks.length ? '<button class="primary full add-button" data-action="add-tasks">Добавить план</button>' : ""}<div class="preview-list">${state.tasks.length ? state.tasks.map(item => taskItem(item)).join("") : empty("Пока свободно", "Добавьте первый общий шаг.", "add-tasks")}</div>${state.completedTasks.length ? `<details class="archive"><summary>Завершённые · ${state.completedTasks.length}</summary><div class="preview-list">${state.completedTasks.map(item => taskItem(item, true)).join("")}</div></details>` : ""}</section>`;
}

function renderDates() {
  const items = [...state.dates].sort((a, b) => {
    const da = nextOccurrence(a), db = nextOccurrence(b);
    return (da?.getTime() ?? Infinity) - (db?.getTime() ?? Infinity);
  });
  return `<section class="view">${items.length ? '<button class="primary full add-button" data-action="add-dates">Добавить дату</button>' : ""}<div class="preview-list">${items.length ? items.map(dateItem).join("") : empty("Важные моменты", "Сохраните дату, которую хочется беречь.", "add-dates")}</div></section>`;
}

function renderMemories() {
  return `<section class="view">${state.memories.length ? '<button class="primary full add-button" data-action="add-memories">Записать момент</button>' : ""}<div class="preview-list">${state.memories.length ? state.memories.map(memoryItem).join("") : empty("История начинается", "Запишите момент, к которому захочется вернуться.", "add-memories")}</div></section>`;
}

function renderWishes() {
  const wishView = localStorage.getItem("wishView") || "my";
  const partnerLabel = state.user?.gender === "female" ? "Его" : state.user?.gender === "male" ? "Её" : "Его/Её";
  const wishes = state.wishes.filter(w => wishView === "my" ? w.owner_id === state.user?.tg_id : w.owner_id !== state.user?.tg_id);
  const toggle = `<div class="section-title"><h2>${wishView === "my" ? "Мои желания" : `Желания ${partnerLabel.toLowerCase()}`}</h2><button class="text-button" data-action="toggle-wish-view">${wishView === "my" ? partnerLabel : "Мои"}</button></div>`;
  return `<section class="view">${toggle}${wishes.length ? '<button class="primary full add-button" data-action="add-wishes">Добавить желание</button>' : ""}<div class="preview-list">${wishes.length ? wishes.map(item => wishItem(item)).join("") : empty("О чём мечтается?", "Добавьте желание — большое или совсем маленькое.", "add-wishes")}</div>${state.completedWishes.length ? `<details class="archive"><summary>Исполненные · ${state.completedWishes.length}</summary><div class="preview-list">${state.completedWishes.map(item => wishItem(item, true)).join("")}</div></details>` : ""}</section>`;
}

function renderPair() {
  const { pair, user } = state;
  return `<section class="view"><div class="pair-card"><p class="pair-names">${esc(pair.name1)}${pair.name2 ? ` и ${esc(pair.name2)}` : ""}</p><span class="overline">В DUOPLAN С ${formatDate(pair.started_at).toUpperCase()}</span>${pair.user_b ? "" : `<div><span class="pair-code">${esc(pair.code)}</span><p class="item-meta">Код для партнёра</p></div>`}</div><div class="stats"><div class="stat"><strong>${pair.together_pts}</strong><span>ОБЩИЕ XP</span></div><div class="stat"><strong>${user.points}</strong><span>ВАШИ XP</span></div><div class="stat"><strong>${user.streak}</strong><span>ДНЕЙ ПОДРЯД</span></div></div>${pair.user_b ? "" : '<button class="primary full" data-action="invite">Пригласить партнёра</button><button class="secondary full" data-action="copy-code">Скопировать код</button>'}<button class="secondary full pair-leave" data-action="leave-pair">Выйти из пространства</button></section>`;
}

const views = { home: renderHome, tasks: renderTasks, dates: renderDates, memories: renderMemories, wishes: renderWishes, pair: renderPair };

function render(focus = false) {
  updateChrome();
  content.innerHTML = (views[route] || renderHome)();
  if (focus) document.querySelector("#page-title")?.focus();
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

function field(name, label, type = "text", placeholder = "", value = "", attributes = "") {
  return `<label class="field"><span>${esc(label)}</span><input name="${esc(name)}" type="${esc(type)}" placeholder="${esc(placeholder)}" value="${esc(value)}" ${attributes} required></label>`;
}

// Необязательное поле: пустое значение просто не сохраняется.
function optionalField(name, label, type = "text", placeholder = "", value = "", attributes = "") {
  return `<label class="field"><span>${esc(label)}</span><input name="${esc(name)}" type="${esc(type)}" placeholder="${esc(placeholder)}" value="${esc(value)}" ${attributes}></label>`;
}

function textarea(name, label, placeholder, value = "", max = 2000) {
  return `<label class="field"><span>${esc(label)}</span><textarea name="${esc(name)}" maxlength="${max}" placeholder="${esc(placeholder)}" required>${esc(value)}</textarea><small class="field-count">До ${max} символов</small></label>`;
}

function closeDialog() {
  if (dialogBusy) return;
  const dirty = [...form.elements].some(element => element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement
    ? element.value.trim() && element.type !== "checkbox"
    : false);
  if (dirty && !confirm("Закрыть без сохранения? Введённый текст будет потерян.")) return;
  dialog.close();
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
  if (type === "tasks") showForm("add-tasks", "Новый план", "Одно понятное действие, которое вы сделаете вместе.", field("title", "Что хотите сделать?", "text", "Например, выбрать место для поездки", "", 'maxlength="180"') + optionalField("day", "Дата (необязательно)", "date") + optionalField("time", "Время (необязательно)", "time"));
  if (type === "dates") showForm("add-dates", "Значимая дата", "Сохраним событие вашей истории.", field("title", "Название", "text", "Например, наше первое путешествие", "", 'maxlength="120"') + field("day", "Дата", "date") + optionalField("time", "Время (необязательно)", "time") + '<label class="check-field"><input name="recurs" type="checkbox" checked><span>Повторять каждый год</span></label>');
  if (type === "memories") showForm("add-memories", "Сохранить момент", "Пара строк, к которым будет приятно вернуться.", textarea("body", "Ваше воспоминание", "Сегодня был особенный день…", "", 2000));
  if (type === "wishes") showForm("add-wishes", "Новое желание", "Большое или совсем маленькое — партнёр его увидит.", textarea("body", "Чего вы хотите?", "Например, провести выходной у моря", "", 300));
  if (type === "join") showForm("join-pair", "Войти по коду", "Введите восьмизначный код из приглашения партнёра.", field("code", "Код приглашения", "text", "A1B2C3D4", "", 'maxlength="8" autocapitalize="characters" autocomplete="off" spellcheck="false" pattern="[A-Fa-f0-9]{8}"'), "Соединить");
}

function openEdit(type, id) {
  const item = itemById(type, id);
  if (!item) return toast("Запись не найдена");
  if (type === "tasks") showForm("edit-tasks", "Изменить план", "Обновите формулировку общего плана.", field("title", "План", "text", "", item.title, 'maxlength="180"') + optionalField("day", "Дата (необязательно)", "date", "", item.day || "") + optionalField("time", "Время (необязательно)", "time", "", item.time || ""), "Сохранить", id);
  if (type === "dates") showForm("edit-dates", "Изменить дату", "Обновите название или дату события.", field("title", "Название", "text", "", item.title, 'maxlength="120"') + field("day", "Дата", "date", "", item.day) + optionalField("time", "Время (необязательно)", "time", "", item.time || "") + `<label class="check-field"><input name="recurs" type="checkbox" ${item.recurs ? "checked" : ""}><span>Повторять каждый год</span></label>`, "Сохранить", id);
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
  if (action === "toggle-wish-view") {
    const current = localStorage.getItem("wishView") || "my";
    localStorage.setItem("wishView", current === "my" ? "partner" : "my");
    render(true);
    return;
  }
  if (action.startsWith("add-")) { openAdd(action.slice(4)); return; }
  if (action === "show-join") { openAdd("join"); return; }
  if (action === "close-dialog") { closeDialog(); return; }
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
  if (action === "set-gender") {
      const selectedGender = button.dataset.gender;
      if (selectedGender) {
        await api("/api/gender", { method: "POST", body: JSON.stringify({ gender: selectedGender }) });
        const genderDialog = document.getElementById("gender-dialog");
        if (genderDialog) genderDialog.close();
        // Показать приложение после выбора
        app.hidden = false;
        // Перезагрузить состояние, чтобы отразить изменения
        state = normalizeState(await api("/api/state"));
        render(true);
      }
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
  event.preventDefault();
  closeDialog();
});

// Отсчёт живёт: раз в полминуты обновляем уже отрисованные чипы.
function tickCountdowns() {
  if (dialog.open) return;
  document.querySelectorAll(".day-chip[data-countdown]").forEach(element => {
    const target = Number(element.dataset.countdown);
    if (!Number.isFinite(target)) return;
    const countdown = countdownFromDiff(target - Date.now());
    element.textContent = countdown.text;
    element.classList.toggle("is-overdue", countdown.overdue);
    element.classList.toggle("is-countdown", !countdown.overdue);
    if (countdown.overdue) delete element.dataset.countdown;
  });
}
setInterval(tickCountdowns, 30000);

// При повороте экрана, появлении скроллбара или изменении ширины бар
// пересобирается — каплю переставляем мгновенно, без перелёта.
function repositionDrop() {
  // Ширина капли задана в CSS и меняется вместе с баром, а её X стабилен.
  // Летящую каплю не сбиваем: по завершении она сама встанет по геометрии.
  if (app.hidden || dropAnimation) return;
  positionDrop(navItems.find(button => button.dataset.route === route), false);
}
addEventListener("resize", repositionDrop);
if ("ResizeObserver" in window && bottomNav) new ResizeObserver(repositionDrop).observe(bottomNav);

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
    showFatal("Управление доступно внутри Telegram. Откройте @duoplanbot и нажмите «Открыть пространство» или кнопку «DuoPlan».");
    return;
  }
  try {
    state = normalizeState(await api("/api/state"));
    // Если пол не задан, требуем выбор перед входом
    if (!state.user?.gender) {
      const genderDialog = document.getElementById("gender-dialog");
      if (genderDialog) {
        genderDialog.showModal();
        // Скрываем основной интерфейс пока не выбран пол
        app.hidden = true;
      }
      // Останавливаем дальнейшее выполнение init, чтобы не показывать контент
      return;
    }
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
