(() => {
  const tg = window.Telegram?.WebApp;
  const appEl = document.getElementById("app");
  const bottomNav = document.getElementById("bottom-nav");
  const navDroplet = document.getElementById("nav-droplet");
  const navButtons = Array.from(document.querySelectorAll(".nav-item[data-tab]"));
  const backButton = document.getElementById("back-button");
  const pairButton = document.getElementById("pair-button");
  const avatarA = document.getElementById("avatar-a");
  const avatarB = document.getElementById("avatar-b");
  const pairPillLabel = document.getElementById("pair-pill-label");
  const dialog = document.getElementById("item-dialog");
  const dialogForm = document.getElementById("item-form");
  const dialogTitle = document.getElementById("dialog-title");
  const dialogFields = document.getElementById("dialog-fields");
  const toastEl = document.getElementById("toast");

  const TAB_ORDER = ["home", "tasks", "dates", "memories", "wishes"];
  const TAB_META = {
    home: { title: "НАШЕ ПРОСТРАНСТВО", isHome: true },
    tasks: { title: "Наши планы", sub: "Общие дела, свидания и идеи" },
    dates: { title: "Значимые даты", sub: "Важные дни вашей истории" },
    memories: { title: "Дневник двоих", sub: "Тёплые моменты и заметки" },
    wishes: { title: "Вишлист", sub: "Желания и подсказки для подарков" },
    pair: { title: "Наша пара", sub: "Настройки вашего пространства" }
  };

  let appState = null;
  let currentTab = "home";
  let tabHistory = [];
  let dropletTimer = null;
  let toastTimer = null;
  let dialogContext = null;
  function partnerMissing() {
    return !appState?.pair?.user_b;
  }

  function applyTheme() {
    const scheme = tg?.colorScheme || (window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light");
    document.documentElement.dataset.theme = scheme === "dark" ? "dark" : "light";
  }

  if (tg) {
    tg.ready();
    tg.expand();
    applyTheme();
    tg.onEvent?.("themeChanged", applyTheme);
  } else {
    applyTheme();
  }

  function esc(value) {
    return String(value ?? "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  function firstLetter(name, fallback = "Д") {
    const clean = String(name ?? "").trim();
    return clean ? Array.from(clean)[0].toUpperCase() : fallback;
  }

  function showToast(message) {
    if (!toastEl) return;
    toastEl.textContent = message;
    toastEl.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => {
      toastEl.hidden = true;
    }, 2600);
  }

  async function request(path, options = {}) {
    const headers = {
      "x-telegram-init-data": tg?.initData || "",
      "x-timezone": Intl.DateTimeFormat().resolvedOptions().timeZone || "Europe/Moscow",
      ...(options.body ? { "content-type": "application/json" } : {})
    };
    const response = await fetch(path, {
      method: options.method || "GET",
      headers,
      body: options.body ? JSON.stringify(options.body) : undefined
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw new Error(payload.error || payload.message || `Ошибка ${response.status}`);
    }
    return payload;
  }

  // ------------------------------------------------------------------
  // Анимация стеклянной капли нижнего бара (Telegram Liquid Pill)
  // ------------------------------------------------------------------
  function updateDroplet(targetTab, animate = true) {
    const idx = TAB_ORDER.indexOf(targetTab);
    if (idx === -1 || !bottomNav || !navDroplet) return;

    const innerWidth = bottomNav.clientWidth - 10;
    const slotWidth = innerWidth / TAB_ORDER.length;
    const x = Math.round(idx * slotWidth);

    navButtons.forEach((btn) => {
      const active = btn.dataset.tab === targetTab;
      btn.classList.toggle("is-active", active);
      if (active) btn.setAttribute("aria-current", "page");
      else btn.removeAttribute("aria-current");
    });

    if (!animate) {
      navDroplet.style.setProperty("--drop-x", `${x}px`);
      navDroplet.style.setProperty("--drop-sx", "1");
      navDroplet.style.setProperty("--drop-sy", "1");
      return;
    }

    navDroplet.classList.add("is-stretching");
    navDroplet.style.setProperty("--drop-x", `${x}px`);
    navDroplet.style.setProperty("--drop-sx", "1.16");
    navDroplet.style.setProperty("--drop-sy", "0.92");

    clearTimeout(dropletTimer);
    dropletTimer = setTimeout(() => {
      navDroplet.classList.remove("is-stretching");
      navDroplet.style.setProperty("--drop-sx", "1");
      navDroplet.style.setProperty("--drop-sy", "1");
    }, 170);
  }

  window.addEventListener("resize", () => {
    if (TAB_ORDER.includes(currentTab)) {
      updateDroplet(currentTab, false);
    }
  });

  // Поддержка свайпа пальцем по нижнему бару как в Telegram
  let navDragging = false;
  bottomNav?.addEventListener("pointerdown", (e) => {
    const btn = e.target.closest(".nav-item[data-tab]");
    if (!btn) return;
    navDragging = true;
  });
  bottomNav?.addEventListener("pointermove", (e) => {
    if (!navDragging) return;
    const el = document.elementFromPoint(e.clientX, e.clientY);
    const btn = el?.closest?.(".nav-item[data-tab]");
    if (btn && btn.dataset.tab && btn.dataset.tab !== currentTab) {
      switchTab(btn.dataset.tab);
    }
  });
  window.addEventListener("pointerup", () => {
    navDragging = false;
  });

  // ------------------------------------------------------------------
  // Встроенная шапка вкладки (прямо над элементами на странице)
  // ------------------------------------------------------------------
  function renderTabHeader(tabKey) {
    const meta = TAB_META[tabKey] || TAB_META.home;
    const pair = appState?.pair;
    let subtitle = meta.sub || "";
    if (tabKey === "home" && pair) {
      subtitle = pair.user_b
        ? `${pair.name1} и ${pair.name2} · ${pair.together_pts || 0} XP вместе`
        : `${pair.name1} · ожидание партнёра`;
    }
    return `
      <header class="tab-header">
        <h1 class="tab-header-title ${meta.isHome ? "is-home" : ""}">${esc(meta.title)}</h1>
        ${subtitle ? `<p class="tab-header-sub">${esc(subtitle)}</p>` : ""}
      </header>
    `;
  }

  function syncTopControls() {
    const pair = appState?.pair;
    const isSubScreen = currentTab !== "home";
    // Собственная кнопка «Назад» с вкладок убрана: навигация идёт через
    // системную tg.BackButton (на главной она скрыта, чтобы показывалась
    // кнопка закрытия приложения).
    if (backButton) backButton.hidden = true;
    if (tg?.BackButton) {
      if (isSubScreen) tg.BackButton.show();
      else tg.BackButton.hide();
    }

    if (!pair) {
      pairButton.hidden = true;
      bottomNav.hidden = true;
      return;
    }

    pairButton.hidden = false;
    bottomNav.hidden = false;
    avatarA.textContent = firstLetter(pair.name1, "А");
    avatarB.textContent = pair.user_b ? firstLetter(pair.name2, "Б") : "+";
    // В кнопке перехода на «Нашу пару» текст не показываем — только круглые аватарки.
    pairPillLabel.hidden = true;
    pairPillLabel.textContent = "";
  }

  function switchTab(tab, pushScroll = true, pushHistory = true) {
    if (tab !== currentTab) {
      if (pushHistory && currentTab) {
        tabHistory.push(currentTab);
      }
      currentTab = tab;
      if (TAB_ORDER.includes(tab)) {
        updateDroplet(tab, true);
      }
    }
    render();
    if (pushScroll) {
      window.scrollTo({ top: 0, behavior: "instant" });
    }
  }

  function goBack() {
    while (tabHistory.length && tabHistory[tabHistory.length - 1] === currentTab) {
      tabHistory.pop();
    }
    const prev = tabHistory.pop();
    if (prev && prev !== currentTab) {
      switchTab(prev, true, false);
      return;
    }
    if (currentTab !== "home") {
      switchTab("home", true, false);
      return;
    }
    if (tg?.close) tg.close();
  }

  // ------------------------------------------------------------------
  // Живой отсчёт времени для планов и дат
  // ------------------------------------------------------------------
  function pairTimeZone() {
    return appState?.pair?.timezone || Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  }

  function timeZoneOffsetMs(timeZone, date) {
    const formatter = new Intl.DateTimeFormat("en-US", {
      timeZone,
      year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false
    });
    const parts = formatter.formatToParts(date);
    const get = (type) => parts.find((part) => part.type === type)?.value || "0";
    const asUtc = Date.UTC(
      Number(get("year")), Number(get("month")) - 1, Number(get("day")),
      Number(get("hour")), Number(get("minute")), Number(get("second"))
    );
    return asUtc - date.getTime();
  }

  function makeDateInTimeZone(year, monthIndex, day, hour, minute, timeZone) {
    const tz = timeZone || "UTC";
    const desiredUtc = Date.UTC(year, monthIndex, day, hour, minute, 0, 0);
    function localMatches(utcMs) {
      const parts = new Intl.DateTimeFormat("en-US", {
        timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit",
        hour: "2-digit", minute: "2-digit", hour12: false
      }).formatToParts(new Date(utcMs));
      const get = (type) => parts.find((p) => p.type === type)?.value || "0";
      return Number(get("year")) === year &&
        Number(get("month")) === monthIndex + 1 &&
        Number(get("day")) === day &&
        Number(get("hour")) === hour &&
        Number(get("minute")) === minute;
    }
    let utc = desiredUtc;
    for (let i = 0; i < 3; i++) {
      const offset = timeZoneOffsetMs(tz, new Date(utc));
      const next = desiredUtc - offset;
      if (next === utc) break;
      utc = next;
    }
    if (localMatches(utc)) return new Date(utc);
    const preOffset = timeZoneOffsetMs(tz, new Date(desiredUtc - 2 * 3600000));
    const shifted = desiredUtc - preOffset;
    return new Date(shifted);
  }

  function zonedToday(timeZone) {
    const now = new Date();
    const parts = new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
    const [year, month, day] = parts.split("-").map(Number);
    return new Date(makeDateInTimeZone(year, month - 1, day, 0, 0, timeZone));
  }

  function planTarget(day, time) {
    if (!day) return null;
    const [year, month, date] = String(day).split("-").map(Number);
    if (![year, month, date].every(Number.isFinite)) return null;
    const hhmm = time && /^\d{2}:\d{2}$/.test(time) ? time : "23:59";
    const [hours, minutes] = hhmm.split(":").map(Number);
    const tz = pairTimeZone();
    const result = makeDateInTimeZone(year, month - 1, date, hours, minutes, tz);
    return Number.isNaN(result.getTime()) ? null : result;
  }

  function dayTime(day, time, fallbackHour = 12) {
    if (!day) return null;
    const [year, month, date] = String(day).split("-").map(Number);
    if (![year, month, date].every(Number.isFinite)) return null;
    let hours = fallbackHour, minutes = 0;
    if (time && /^\d{2}:\d{2}$/.test(time)) {
      const [hh, mm] = String(time).split(":").map(Number);
      if (Number.isFinite(hh) && Number.isFinite(mm)) { hours = hh; minutes = mm; }
    }
    const tz = pairTimeZone();
    const result = makeDateInTimeZone(year, month - 1, date, hours, minutes, tz);
    return Number.isNaN(result.getTime()) ? null : result;
  }

  function annualDate(day, year, time) {
    const [, month, date] = String(day).split("-").map(Number);
    if (![month, date].every(Number.isFinite)) return null;
    let hours = 12, minutes = 0;
    if (time && /^\d{2}:\d{2}$/.test(time)) {
      const [hh, mm] = String(time).split(":").map(Number);
      if (Number.isFinite(hh) && Number.isFinite(mm)) { hours = hh; minutes = mm; }
    }
    const tz = pairTimeZone();
    const result = makeDateInTimeZone(year, month - 1, date, hours, minutes, tz);
    const fmt = new Intl.DateTimeFormat("en-US", { timeZone: tz, month: "2-digit", day: "2-digit" });
    const parts = fmt.formatToParts(result);
    const m = Number(parts.find((part) => part.type === "month")?.value);
    const d = Number(parts.find((part) => part.type === "day")?.value);
    return (m === month && d === date) ? result : null;
  }

  function nextOccurrence(item) {
    if (!item || !item.day) return null;
    const tz = pairTimeZone();
    const today = zonedToday(tz);
    if (!item.recurs) return dayTime(item.day, item.time, 12);
    const now = new Date();
    const currentYear = Number(new Intl.DateTimeFormat("en-US", { timeZone: tz, year: "numeric" }).format(now));
    for (let year = currentYear; year <= currentYear + 8; year++) {
      const candidate = annualDate(item.day, year, item.time);
      if (candidate && candidate >= today) return candidate;
    }
    return dayTime(item.day, item.time, 12);
  }

  function compareDates(a, b) {
    const ta = nextOccurrence(a)?.getTime() ?? Infinity;
    const tb = nextOccurrence(b)?.getTime() ?? Infinity;
    const now = Date.now();
    const aPast = !a?.recurs && ta < now;
    const bPast = !b?.recurs && tb < now;
    if (aPast !== bPast) return aPast ? 1 : -1;
    if (aPast && bPast) return tb - ta;
    return ta - tb;
  }

  function countdownFromDiff(diff) {
    if (diff <= 0) return { overdue: true, text: "Время пришло" };
    const totalMinutes = Math.floor(diff / 60000);
    const minutes = totalMinutes % 60;
    const hours = Math.floor(totalMinutes / 60) % 24;
    const days = Math.floor(totalMinutes / 1440);
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

  function countdownChip(day, time) {
    const target = planTarget(day, time);
    if (!target) return "";
    const diff = target.getTime() - Date.now();
    if (diff <= 0) {
      return `<span class="day-chip is-overdue" data-countdown="${esc(day)}|${esc(time || "")}">Время пришло</span>`;
    }
    const hours = Math.floor(diff / 3600000);
    const mins = Math.max(1, Math.floor((diff % 3600000) / 60000));
    if (hours < 24) {
      const label = hours > 0 ? `Через ${hours} ч ${mins} мин` : `Через ${mins} мин`;
      return `<span class="day-chip is-countdown" data-countdown="${esc(day)}|${esc(time || "")}">${esc(label)}</span>`;
    }
    const days = Math.ceil(diff / 86400000);
    return `<span class="day-chip" data-countdown="${esc(day)}|${esc(time || "")}">Через ${days} дн.</span>`;
  }

  function refreshCountdowns() {
    if (dialog?.open) return;
    document.querySelectorAll("[data-countdown]").forEach((node) => {
      const raw = node.getAttribute("data-countdown") || "";
      if (raw.includes("|")) {
        const [day, time] = raw.split("|");
        const wrapper = document.createElement("span");
        wrapper.innerHTML = countdownChip(day, time);
        const next = wrapper.firstElementChild;
        if (next) node.replaceWith(next);
        return;
      }
      const target = Number(raw);
      if (!Number.isFinite(target)) return;
      const countdown = countdownFromDiff(target - Date.now());
      node.textContent = countdown.text;
      node.classList.toggle("is-overdue", countdown.overdue);
      node.classList.toggle("is-countdown", !countdown.overdue);
      if (countdown.overdue) delete node.dataset.countdown;
    });
  }

  setInterval(refreshCountdowns, 30000);
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") refreshCountdowns();
  });

  // ------------------------------------------------------------------
  // Рендер экранов
  // ------------------------------------------------------------------
  function renderOnboarding() {
    return `
      ${renderTabHeader("home")}
      <section class="card hero-card">
        <p class="eyebrow">DuoPlan · для двоих</p>
        <h2>Создайте ваше общее пространство</h2>
        <p>Планы, значимые даты, дневник воспоминаний и вишлист — в одном уютном месте.</p>
        <div style="margin-top:16px; display:grid; gap:10px;">
          <button class="primary full" type="button" data-action="create-pair">Создать пространство</button>
        </div>
      </section>
      <section class="card">
        <p class="eyebrow">Вход по коду</p>
        <h3>Добавить партнёра по коду</h3>
        <label class="field"><span>Код партнёра (8 символов)</span><input id="join-code-home" maxlength="8" placeholder="Например, 740C04B5"></label>
        <button class="secondary full" type="button" data-action="join-code" data-input="join-code-home">Войти по коду партнёра</button>
      </section>
    `;
  }

  function renderHome() {
    const { pair, user, daily, tasks = [], dates = [], memories = [] } = appState;
    if (!pair?.user_b) {
      return `
        ${renderTabHeader("home")}
        <section class="card">
          <p class="eyebrow">Ожидание партнёра</p>
          <h2>Пригласите партнёра в пространство</h2>
          <p>Отправьте код партнёру. После его присоединения здесь появятся общие планы, значимые даты, дневник двоих, вишлист и ритуал дня.</p>
          <div style="margin-top:12px;">
            <button class="primary full" type="button" data-action="go-tab" data-tab="pair">Наша пара</button>
          </div>
        </section>
      `;
    }
    const ritualBlock = pair.user_b && daily ? `
      <section class="card">
        <p class="eyebrow">Ритуал дня</p>
        <h3>${esc(daily.action)}</h3>
        <p>${daily.done ? "Выполнено сегодня · +10 XP в копилку пары" : "Маленький шаг навстречу друг другу сегодня."}</p>
        ${daily.done ? "" : `<div style="margin-top:12px;"><button class="primary full" type="button" data-action="daily-done">Мы сделали это · +10 XP</button></div>`}
      </section>
    ` : "";

    const previewTasks = [...tasks]
      .sort((a, b) => (planTarget(a.day, a.time)?.getTime() ?? Infinity) - (planTarget(b.day, b.time)?.getTime() ?? Infinity))
      .slice(0, 3)
      .map(taskItem)
      .join("");
    const sortedDates = [...dates].sort(compareDates);
    const previewDates = sortedDates.slice(0, 2).map(dateItem).join("");
    const latestMemory = memories[0];

    return `
      ${renderTabHeader("home")}
      <section class="card hero-card">
        <p class="eyebrow">${pair.user_b ? "Ваша история" : "Ожидание партнёра"}</p>
        <h2>${pair.user_b ? `${esc(pair.name1)} и ${esc(pair.name2)}` : `Код пары: ${esc(pair.code)}`}</h2>
        <p>${pair.user_b ? `Начало истории: ${esc(pair.started_at)}` : "Отправьте код партнёру, чтобы открыть ритуалы дня и общее пространство."}</p>
        <div class="stats-row">
          <span class="stat-pill">✦ ${user.points || 0} XP</span>
          <span class="stat-pill">🔥 Серия ${user.streak || 0} дн.</span>
          <span class="stat-pill">♥ Вместе ${pair.together_pts || 0} XP</span>
        </div>
      </section>

      ${ritualBlock}

      ${previewTasks ? `
      <div class="section-head-inline">
        <h3>Ближайшие планы</h3>
        <button class="link-btn" type="button" data-action="go-tab" data-tab="tasks">Все →</button>
      </div>
      ${previewTasks}
      ` : ""}

      ${previewDates ? `
      <div class="section-head-inline">
        <h3>Значимые даты</h3>
        <button class="link-btn" type="button" data-action="go-tab" data-tab="dates">Все →</button>
      </div>
      ${previewDates}
      ` : ""}

      ${latestMemory ? `
        <div class="section-head-inline">
          <h3>Из дневника</h3>
          <button class="link-btn" type="button" data-action="go-tab" data-tab="memories">Дневник →</button>
        </div>
        ${memoryItem(latestMemory)}
      ` : ""}
    `;
  }

  function taskItem(item) {
    return `
      <article class="card">
        <div class="item-row">
          <div class="item-main">
            <h3 class="item-title">${esc(item.title)}</h3>
            <div class="item-meta">
              ${item.day ? `<span>${esc(item.day)}${item.time ? ` · ${esc(item.time)}` : ""}</span>` : ""}
              ${countdownChip(item.day, item.time)}
            </div>
          </div>
          <div class="item-actions">
            <button class="icon-btn" type="button" data-action="done-item" data-type="tasks" data-id="${item.id}" aria-label="Выполнено">✓</button>
            <button class="icon-btn" type="button" data-action="edit-item" data-type="tasks" data-id="${item.id}" aria-label="Редактировать">✎</button>
            <button class="icon-btn" type="button" data-action="delete-item" data-type="tasks" data-id="${item.id}" aria-label="Удалить">✕</button>
          </div>
        </div>
      </article>
    `;
  }

  function dateItem(item) {
    const next = nextOccurrence(item);
    const tz = pairTimeZone();
    const now = new Date();
    const parts = new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
    const [year, month, day] = parts.split("-").map(Number);
    const midnight = makeDateInTimeZone(year, month - 1, day, 12, 0, tz);
    const days = next ? Math.round((next.getTime() - midnight.getTime()) / 86400000) : null;
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
    } else if (days === 0) label = "Сегодня";
    else if (days === 1) label = "Завтра";
    else label = `Через ${days} ${plural(days, "день", "дня", "дней")}`;
    const chip = label ? `<span class="day-chip ${chipClass}"${dataCountdown}>${esc(label)}</span>` : "";
    return `
      <article class="card">
        <div class="item-row">
          <div class="item-main">
            <h3 class="item-title">${esc(item.title)}</h3>
            <div class="item-meta">
              <span>${esc(item.day)}${item.time ? ` · ${esc(item.time)}` : ""}</span>
              ${item.recurs ? `<span>· Ежегодно</span>` : ""}
              ${chip}
            </div>
          </div>
          <div class="item-actions">
            <button class="icon-btn" type="button" data-action="edit-item" data-type="dates" data-id="${item.id}" aria-label="Редактировать">✎</button>
            <button class="icon-btn" type="button" data-action="delete-item" data-type="dates" data-id="${item.id}" aria-label="Удалить">✕</button>
          </div>
        </div>
      </article>
    `;
  }

  function memoryItem(item) {
    return `
      <article class="card">
        <div class="item-row">
          <div class="item-main">
            <p style="color:var(--ink); white-space:pre-wrap; margin-bottom:6px;">${esc(item.body)}</p>
            <div class="item-meta">
              <span>${esc(item.display_name || "Партнёр")}</span>
              <span>· ${esc(item.day)}</span>
            </div>
          </div>
          <div class="item-actions">
            <button class="icon-btn" type="button" data-action="edit-item" data-type="memories" data-id="${item.id}" aria-label="Редактировать">✎</button>
            <button class="icon-btn" type="button" data-action="delete-item" data-type="memories" data-id="${item.id}" aria-label="Удалить">✕</button>
          </div>
        </div>
      </article>
    `;
  }

  function wishItem(item) {
    return `
      <article class="card">
        <div class="item-row">
          <div class="item-main">
            <h3 class="item-title">${esc(item.body)}</h3>
            <div class="item-meta">
              <span>Желание: ${esc(item.display_name || "Партнёр")}</span>
            </div>
          </div>
          <div class="item-actions">
            <button class="icon-btn" type="button" data-action="done-item" data-type="wishes" data-id="${item.id}" aria-label="Исполнено">✓</button>
            <button class="icon-btn" type="button" data-action="edit-item" data-type="wishes" data-id="${item.id}" aria-label="Редактировать">✎</button>
            <button class="icon-btn" type="button" data-action="delete-item" data-type="wishes" data-id="${item.id}" aria-label="Удалить">✕</button>
          </div>
        </div>
      </article>
    `;
  }

  function findItem(type, id) {
    const collections = {
      tasks: [...(appState?.tasks || []), ...(appState?.completedTasks || [])],
      dates: appState?.dates || [],
      memories: appState?.memories || [],
      wishes: [...(appState?.wishes || []), ...(appState?.completedWishes || [])]
    };
    return (collections[type] || []).find((x) => Number(x.id) === Number(id));
  }

  function completedTaskItem(item) {
    return `
      <article class="card" style="opacity:0.72;">
        <div class="item-row">
          <div class="item-main">
            <h3 class="item-title" style="text-decoration:line-through;">${esc(item.title)}</h3>
            <div class="item-meta"><span>Завершён</span></div>
          </div>
          <div class="item-actions">
            <button class="icon-btn" type="button" data-action="reopen-item" data-type="tasks" data-id="${item.id}" aria-label="Вернуть в планы">↩</button>
            <button class="icon-btn" type="button" data-action="edit-item" data-type="tasks" data-id="${item.id}" aria-label="Редактировать">✎</button>
            <button class="icon-btn" type="button" data-action="delete-item" data-type="tasks" data-id="${item.id}" aria-label="Удалить">✕</button>
          </div>
        </div>
      </article>
    `;
  }

  function completedWishItem(item) {
    return `
      <article class="card" style="opacity:0.72;">
        <div class="item-row">
          <div class="item-main">
            <h3 class="item-title" style="text-decoration:line-through;">${esc(item.body)}</h3>
            <div class="item-meta"><span>Исполнено</span></div>
          </div>
          <div class="item-actions">
            <button class="icon-btn" type="button" data-action="reopen-item" data-type="wishes" data-id="${item.id}" aria-label="Вернуть в желания">↩</button>
            <button class="icon-btn" type="button" data-action="edit-item" data-type="wishes" data-id="${item.id}" aria-label="Редактировать">✎</button>
            <button class="icon-btn" type="button" data-action="delete-item" data-type="wishes" data-id="${item.id}" aria-label="Удалить">✕</button>
          </div>
        </div>
      </article>
    `;
  }

  function renderListTab(tabKey, items, addAction, addLabel, emptyTitle, emptyCopy, renderer) {
    const disabledClass = partnerMissing() ? " is-disabled" : "";
    return `
      ${renderTabHeader(tabKey)}
      ${items.length ? `<button class="primary full add-button${disabledClass}" type="button" data-action="${addAction}">${esc(addLabel)}</button>` : ""}
      ${items.length ? items.map(renderer).join("") : `
        <section class="card">
          <h3>${esc(emptyTitle)}</h3>
          <p>${esc(emptyCopy)}</p>
          <div style="margin-top:12px;">
            <button class="primary full${disabledClass}" type="button" data-action="${addAction}">${esc(addLabel)}</button>
          </div>
        </section>
      `}
    `;
  }

  function renderPair() {
    const { pair } = appState;
    const inviteBlock = !pair.user_b ? `
      <section class="card">
        <p class="eyebrow">Приглашение партнёра</p>
        <h3>Отправьте код партнёру</h3>
        <p>После его присоединения здесь появятся общие планы, значимые даты, дневник двоих, вишлист и ритуал дня. Общие очки пары: ${pair.together_pts || 0} XP</p>
        ${pair.code ? `
          <div style="margin-top:14px;">
            <button class="secondary full" type="button" data-action="copy-code" data-code="${esc(pair.code)}">Скопировать код: ${esc(pair.code)}</button>
          </div>
        ` : ""}
      </section>
    ` : "";
    return `
      ${renderTabHeader("pair")}
      ${inviteBlock}
      <section class="card">
        <p class="eyebrow">Участники пространства</p>
        <h3>${esc(pair.name1)} ${pair.user_b ? `и ${esc(pair.name2)}` : "(ожидание партнёра)"}</h3>
        <p>Общие очки пары: ${pair.together_pts || 0} XP</p>
        ${pair.user_b && pair.code ? `
          <div style="margin-top:14px;">
            <button class="secondary full" type="button" data-action="copy-code" data-code="${esc(pair.code)}">Скопировать код: ${esc(pair.code)}</button>
          </div>
        ` : ""}
        <button class="secondary full pair-leave" type="button" data-action="leave-pair">Выйти из пространства</button>
      </section>
            ${!pair.user_b ? `      ${!pair.user_b ? `<section class="card">
        <p class="eyebrow">Вход по коду</p>
        <h3>Добавить партнёра по коду</h3>
        <label class="field"><span>Код партнёра (8 символов)</span><input id="join-code-pair" maxlength="8" placeholder="Например, 740C04B5"></label>
        <button class="secondary full" type="button" data-action="join-code" data-input="join-code-pair">Войти по коду партнёра</button>
      </section>` : ""}` : ""}
    `;
  }

  function render() {
    syncTopControls();
    if (!appState?.pair) {
      appEl.innerHTML = renderOnboarding();
      return;
    }
    if (currentTab === "home") {
      appEl.innerHTML = renderHome();
    } else if (currentTab === "tasks") {
      const openTasks = [...(appState.tasks || [])].sort((a, b) => (planTarget(a.day, a.time)?.getTime() ?? Infinity) - (planTarget(b.day, b.time)?.getTime() ?? Infinity));
      const doneTasks = appState.completedTasks || [];
      const taskDisabledClass = partnerMissing() ? " is-disabled" : "";
      let html = renderTabHeader("tasks");
      if (openTasks.length) {
        html += `<button class="primary full add-button${taskDisabledClass}" type="button" data-action="add-task">Добавить план</button>`;
        html += openTasks.map(taskItem).join("");
      } else if (!doneTasks.length) {
        html += `
          <section class="card">
            <h3>Всё впереди</h3>
            <p>Запишите идею свидания, поездки или общего дела.</p>
            <div style="margin-top:12px;">
              <button class="primary full${taskDisabledClass}" type="button" data-action="add-task">Добавить план</button>
            </div>
          </section>
        `;
      } else {
        html += `<button class="primary full add-button${taskDisabledClass}" type="button" data-action="add-task">Добавить план</button>`;
      }
      if (doneTasks.length) {
        html += `<div class="section-head-inline"><h3>Завершённые · ${doneTasks.length}</h3></div>`;
        html += doneTasks.map(completedTaskItem).join("");
      }
      appEl.innerHTML = html;
    } else if (currentTab === "dates") {
      const sortedDates = [...(appState.dates || [])].sort(compareDates);
      appEl.innerHTML = renderListTab("dates", sortedDates, "add-date", "Добавить дату", "Значимые даты", "Добавьте годовщину, день знакомства или важный праздник.", dateItem);
    } else if (currentTab === "memories") {
      appEl.innerHTML = renderListTab("memories", appState.memories || [], "add-memory", "Записать момент", "Дневник двоих", "Сохраняйте тёплые воспоминания, к которым хочется возвращаться.", memoryItem);
    } else if (currentTab === "wishes") {
      const openWishes = appState.wishes || [];
      const doneWishes = appState.completedWishes || [];
      const wishDisabledClass = partnerMissing() ? " is-disabled" : "";
      let html = renderTabHeader("wishes");
      if (openWishes.length) {
        html += `<button class="primary full add-button${wishDisabledClass}" type="button" data-action="add-wish">Добавить желание</button>`;
        html += openWishes.map(wishItem).join("");
      } else if (doneWishes.length) {
        html += `<button class="primary full add-button${wishDisabledClass}" type="button" data-action="add-wish">Добавить желание</button>`;
      } else {
        html += `
          <section class="card">
            <h3>Вишлист пуст</h3>
            <p>Поделитесь идеями подарков и маленькими мечтами.</p>
            <div style="margin-top:12px;">
              <button class="primary full${wishDisabledClass}" type="button" data-action="add-wish">Добавить желание</button>
            </div>
          </section>
        `;
      }
      if (doneWishes.length) {
        html += `<div class="section-head-inline"><h3>Исполненные · ${doneWishes.length}</h3></div>`;
        html += doneWishes.map(completedWishItem).join("");
      }
      appEl.innerHTML = html;
    } else if (currentTab === "pair") {
      appEl.innerHTML = renderPair();
    }
  }

  // ------------------------------------------------------------------
  // Диалоги создания записей
  // ------------------------------------------------------------------
  function openDialog(config) {
    dialogContext = config;
    dialogTitle.textContent = config.title;
    dialogFields.innerHTML = config.fields;
    dialog.showModal();
  }

  let dialogSubmitting = false;
  // Дата обязательна, если указано время (ограничение API).
  dialogFields.addEventListener("input", (e) => {
    const target = e.target;
    if (!(target instanceof HTMLInputElement) || target.name !== "time") return;
    const form = target.closest("form");
    const dayInput = form?.querySelector('input[name="day"]');
    if (dayInput) dayInput.required = Boolean(target.value);
  });
  dialogForm.addEventListener("submit", async (e) => {
    e.preventDefault();
    if (!dialogContext || dialogSubmitting) return;
    const submitBtn = dialogForm.querySelector('button[type="submit"]');
    dialogSubmitting = true;
    if (submitBtn) submitBtn.disabled = true;
    const formData = new FormData(dialogForm);
    try {
      appState = await dialogContext.onSubmit(formData);
      dialog.close();
      render();
    } catch (error) {
      showToast(error.message);
    } finally {
      dialogSubmitting = false;
      if (submitBtn) submitBtn.disabled = false;
    }
  });

  // ------------------------------------------------------------------
  // Обработчики кликов
  // ------------------------------------------------------------------
  bottomNav?.addEventListener("click", (e) => {
    const btn = e.target.closest(".nav-item[data-tab]");
    if (!btn) return;
    switchTab(btn.dataset.tab);
  });

  backButton?.addEventListener("click", goBack);

  pairButton?.addEventListener("click", () => {
    if (currentTab === "pair") goBack();
    else switchTab("pair");
  });

  document.addEventListener("click", async (e) => {
    const btn = e.target.closest("[data-action]");
    if (!btn) return;
    const action = btn.dataset.action;

    try {
      if (["add-task", "add-date", "add-memory", "add-wish"].includes(action) && partnerMissing()) {
        showToast("Сначала добавьте партнёра");
        return;
      }
      if (action === "close-dialog") {
        dialog.close();
      } else if (action === "go-tab") {
        switchTab(btn.dataset.tab || "home");
      } else if (action === "create-pair") {
        appState = await request("/api/pair/create", { method: "POST", body: {} });
        switchTab("home");
      } else if (action === "open-join") {
        openDialog({
          title: "Войти по коду",
          fields: `<label class="field"><span>Код партнёра (8 символов)</span><input name="code" maxlength="8" required placeholder="Например, 740C04B5"></label>`,
          onSubmit: (fd) => request("/api/pair/join", { method: "POST", body: { code: fd.get("code") } })
        });
      } else if (action === "join-code") {
        const inputId = btn.dataset.input;
        const input = inputId ? document.getElementById(inputId) : null;
        const code = input?.value?.trim() || "";
        appState = await request("/api/pair/join", { method: "POST", body: { code } });
        if (input) input.value = "";
        switchTab("home");
      } else if (action === "add-task") {
        openDialog({
          title: "Новый план",
          fields: `
            <label class="field"><span>Что запланируем?</span><input name="title" maxlength="180" required placeholder="Поехать за город на выходных"></label>
            <label class="field"><span>Дата (необязательно)</span><input type="date" name="day"></label>
            <label class="field"><span>Время (необязательно)</span><input type="time" name="time"></label>
          `,
          onSubmit: (fd) => request("/api/tasks", { method: "POST", body: { title: fd.get("title"), day: fd.get("day"), time: fd.get("time") } })
        });
      } else if (action === "add-date") {
        openDialog({
          title: "Значимая дата",
          fields: `
            <label class="field"><span>Название</span><input name="title" maxlength="120" required placeholder="День нашего знакомства"></label>
            <label class="field"><span>Дата</span><input type="date" name="day" required></label>
            <label class="field"><span>Время (необязательно)</span><input type="time" name="time"></label>
          `,
          onSubmit: (fd) => request("/api/dates", { method: "POST", body: { title: fd.get("title"), day: fd.get("day"), time: fd.get("time"), recurs: true } })
        });
      } else if (action === "add-memory") {
        openDialog({
          title: "Запись в дневник",
          fields: `<label class="field"><span>Воспоминание</span><textarea name="body" rows="4" maxlength="2000" required placeholder="Сегодня был тёплый вечер…"></textarea></label>`,
          onSubmit: (fd) => request("/api/memories", { method: "POST", body: { body: fd.get("body") } })
        });
      } else if (action === "add-wish") {
        openDialog({
          title: "Новое желание",
          fields: `<label class="field"><span>О чём мечтаете?</span><input name="body" maxlength="300" required placeholder="Плёночный фотоаппарат"></label>`,
          onSubmit: (fd) => request("/api/wishes", { method: "POST", body: { body: fd.get("body") } })
        });
      } else if (action === "daily-done") {
        btn.disabled = true;
        try {
          appState = await request("/api/daily/done", { method: "POST", body: {} });
          showToast(appState?.awarded === false ? "Ритуал уже отмечен сегодня" : "Ритуал выполнен · +10 XP!");
          render();
        } catch (error) {
          btn.disabled = false;
          throw error;
        }
      } else if (action === "done-item") {
        appState = await request(`/api/${btn.dataset.type}/${btn.dataset.id}/done`, { method: "POST", body: {} });
        render();
      } else if (action === "delete-item") {
        appState = await request(`/api/${btn.dataset.type}/${btn.dataset.id}`, { method: "DELETE" });
        render();
      } else if (action === "reopen-item") {
        const type = btn.dataset.type;
        const id = btn.dataset.id;
        appState = await request(`/api/${type}/${id}/reopen`, { method: "POST", body: {} });
        render();
      } else if (action === "edit-item") {
        const type = btn.dataset.type;
        const id = btn.dataset.id;
        const item = findItem(type, id);
        if (!item) {
          showToast("Запись не найдена");
          return;
        }
        if (type === "tasks") {
          openDialog({
            title: "Редактировать план",
            fields: `
              <label class="field"><span>Что запланируем?</span><input name="title" maxlength="180" required value="${esc(item.title || "")}"></label>
              <label class="field"><span>Дата (необязательно)</span><input type="date" name="day" value="${esc(item.day || "")}"></label>
              <label class="field"><span>Время (необязательно)</span><input type="time" name="time" value="${esc(item.time || "")}"></label>
            `,
            onSubmit: (fd) => request(`/api/tasks/${id}`, { method: "PATCH", body: { title: fd.get("title"), day: fd.get("day"), time: fd.get("time") } })
          });
        } else if (type === "dates") {
          openDialog({
            title: "Редактировать дату",
            fields: `
              <label class="field"><span>Название</span><input name="title" maxlength="120" required value="${esc(item.title || "")}"></label>
              <label class="field"><span>Дата</span><input type="date" name="day" required value="${esc(item.day || "")}"></label>
              <label class="field"><span>Время (необязательно)</span><input type="time" name="time" value="${esc(item.time || "")}"></label>
              <label class="field"><span><input type="checkbox" name="recurs" ${item.recurs ? "checked" : ""}> Повторять ежегодно</span></label>
            `,
            onSubmit: (fd) => request(`/api/dates/${id}`, { method: "PATCH", body: { title: fd.get("title"), day: fd.get("day"), time: fd.get("time"), recurs: fd.get("recurs") === "on" } })
          });
        } else if (type === "memories") {
          openDialog({
            title: "Редактировать запись",
            fields: `<label class="field"><span>Воспоминание</span><textarea name="body" rows="4" maxlength="2000" required>${esc(item.body || "")}</textarea></label>`,
            onSubmit: (fd) => request(`/api/memories/${id}`, { method: "PATCH", body: { body: fd.get("body") } })
          });
        } else if (type === "wishes") {
          openDialog({
            title: "Редактировать желание",
            fields: `<label class="field"><span>О чём мечтаете?</span><input name="body" maxlength="300" required value="${esc(item.body || "")}"></label>`,
            onSubmit: (fd) => request(`/api/wishes/${id}`, { method: "PATCH", body: { body: fd.get("body") } })
          });
        }
      } else if (action === "copy-code") {
        const code = btn.dataset.code || "";
        if (navigator.clipboard?.writeText) {
          try {
            await navigator.clipboard.writeText(code);
            showToast("Код скопирован");
          } catch (error) {
            showToast(`Код: ${code}`);
          }
        } else {
          showToast(`Код: ${code}`);
        }
      } else if (action === "leave-pair") {
        if (!confirm("Выйти из общего пространства?")) return;
        appState = await request("/api/pair/leave", { method: "POST", body: {} });
        switchTab("home");
      }
    } catch (error) {
      showToast(error.message);
    }
  });

  async function refreshState() {
    if (dialog?.open) return;
    try {
      appState = await request("/api/state");
      render();
    } catch (error) {
      // Фоновое обновление не должно прерывать работу интерфейса.
    }
  }

  setInterval(() => {
    if (document.visibilityState === "visible") refreshState();
  }, 60000);

  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") refreshState();
  });

  if (tg?.BackButton?.onClick) tg.BackButton.onClick(goBack);

  // Инициализация
  (async () => {
    try {
      appState = await request("/api/state");
      render();
      updateDroplet("home", false);
    } catch (error) {
      appEl.innerHTML = `
        ${renderTabHeader("home")}
        <section class="card">
          <h3>Не удалось загрузить пространство</h3>
          <p>${esc(error.message)}</p>
        </section>
      `;
    }
  })();
})();
