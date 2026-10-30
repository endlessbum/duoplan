(() => {
  const tg = window.Telegram?.WebApp;
  const appEl = document.getElementById("app");
  const bottomNav = document.getElementById("bottom-nav");
  const navDroplet = document.getElementById("nav-droplet");
  const navButtons = Array.from(document.querySelectorAll(".nav-item[data-tab]"));
  const pairButton = document.getElementById("pair-button");
  const avatarA = document.getElementById("avatar-a");
  const avatarB = document.getElementById("avatar-b");
  const fullscreenClose = document.getElementById("fullscreen-close");
  const homeScreenButton = document.getElementById("homescreen-button");
  const dialog = document.getElementById("item-dialog");
  const dialogForm = document.getElementById("item-form");

  // Очищаем контекст диалога при любом закрывании (Escape, backdrop, programmatic)
  dialog.addEventListener("close", () => {
    dialogContext = null;
  });
  const dialogTitle = document.getElementById("dialog-title");
  const dialogFields = document.getElementById("dialog-fields");
  const dialogSubmit = document.getElementById("dialog-submit");
  const dialogCancel = document.getElementById("dialog-cancel");
  const toastEl = document.getElementById("toast");

  const TAB_ORDER = ["home", "tasks", "dates", "memories", "wishes"];
  const TAB_META = {
    home: { title: "Наше пространство", isHome: false },
    tasks: { title: "Наши планы", sub: "Общие дела, свидания и идеи" },
    dates: { title: "Значимые даты", sub: "Важные дни вашей истории" },
    memories: { title: "Общий дневник", sub: "Тёплые моменты и заметки" },
    wishes: { title: "Вишлист", sub: "Желания и подсказки для подарков" },
    pair: { title: "Наша пара", sub: "Настройки вашего пространства" }
  };

  let appState = null;
  let currentTab = "home";
  let wishView = "mine"; // "mine" | "partner" — переключатель вишлиста
  // Календарь на вкладке «Наша пара»: месяц и выбранный день живут вне
  // рендера, иначе любой refresh возвращал бы пользователя на текущий месяц.
  let calendarMonth = null;   // { year, month } — month 1..12
  let calendarSelected = null; // "YYYY-MM-DD"
  let calendarFetching = false;
  // Архивы и «хвосты» активных наборов приходят с сервера страницами и живут
  // здесь — минутный refresh их не сбрасывает. У активных наборов (tasks,
  // dates, wishes) страницы начинаются после STATE_ACTIVE_LIMIT=200 из /api/state,
  // у архивов (memories, done_*) — после STATE_RECENT_LIMIT.
  const STATE_RECENT_LIMIT = 10;
  const STATE_ACTIVE_LIMIT = 200;
  // Размер страницы /api/archive: для счётчика «Показать ещё (N из M)».
  const ARCHIVE_PAGE_SIZE = 20;
  const archiveCache = {
    tasks: emptyArchiveEntry(),
    dates: emptyArchiveEntry(),
    wishes: emptyArchiveEntry(),
    memories: emptyArchiveEntry(),
    done_tasks: emptyArchiveEntry(),
    done_wishes: emptyArchiveEntry()
  };
  let archiveCachePairId = null;
  function emptyArchiveEntry() {
    // remaining — сколько записей сервер ещё не отдал (для счётчика на кнопке);
    // null — неизвестно (ответ без remaining).
    return { items: [], page: -1, hasMore: null, remaining: null };
  }
  // Кэш архивов живёт в пределах одной пары: сменилась пара (выход, создание,
  // вход по коду) — сбрасываем, чтобы чужие записи и счётчик страниц не утекли
  // в новое пространство.
  function resetArchiveCache() {
    for (const type of Object.keys(archiveCache)) archiveCache[type] = emptyArchiveEntry();
  }
  function syncArchiveCachePair() {
    const pairId = appState?.pair?.id ?? null;
    if (archiveCachePairId === pairId) return;
    archiveCachePairId = pairId;
    resetArchiveCache();
  }
  // Активная запись и её завершённая копия живут в разных кэшах — чистим оба,
  // id в таблицах D1 независимы, поэтому по типу идём строго по своим ключам.
  const ARCHIVE_KEYS_BY_TYPE = {
    memories: ["memories"],
    dates: ["dates"],
    tasks: ["tasks", "done_tasks"],
    wishes: ["wishes", "done_wishes"]
  };
  function removeFromArchiveCache(type, id) {
    for (const key of ARCHIVE_KEYS_BY_TYPE[type] || []) {
      archiveCache[key].items = archiveCache[key].items.filter((x) => Number(x.id) !== Number(id));
    }
  }
  function patchArchiveItem(type, id, patch) {
    for (const key of ARCHIVE_KEYS_BY_TYPE[type] || []) {
      archiveCache[key].items = archiveCache[key].items.map((x) => Number(x.id) === Number(id) ? { ...x, ...patch } : x);
    }
  }
  // Загрузка страницы архива. Флаг loading на тип не даёт двойному тапу
  // запросить один и тот же page дважды (кэш задвоился бы, а следующая
  // страница пропустилась); дедуп по id страхует от повторов; ответ,
  // прилетевший после смены пары, отбрасывается.
  async function loadArchivePage(type, button) {
    const cache = archiveCache[type];
    if (!cache || cache.loading) return;
    cache.loading = true;
    if (button) button.disabled = true;
    const pairIdAtStart = archiveCachePairId;
    try {
      const next = await request(`/api/archive?type=${encodeURIComponent(type)}&page=${cache.page + 1}`);
      if (archiveCachePairId !== pairIdAtStart) return;
      const seen = new Set(cache.items.map((x) => Number(x.id)));
      cache.items.push(...(next.items || []).filter((x) => !seen.has(Number(x.id))));
      cache.page += 1;
      cache.hasMore = Boolean(next.hasMore);
      cache.remaining = Number.isFinite(next.remaining) ? Number(next.remaining) : null;
      render();
    } finally {
      cache.loading = false;
      if (button) button.disabled = false;
    }
  }

  // Партнёр мог удалить запись, завершить план или сделать дату личной, пока
  // кэш страниц архива жил в памяти. По изменившемуся состоянию фоновый
  // refreshState молча перезагружает загруженные страницы: список остаётся
  // раскрытым, но содержимое — всегда серверная истина. Сбой сети сбрасывает
  // тип: лучше схлопнувшийся список, чем устаревшие записи партнёра.
  async function revalidateArchiveCache() {
    for (const type of Object.keys(archiveCache)) {
      const cache = archiveCache[type];
      if (cache.page < 0 || cache.loading) continue;
      const lastPage = cache.page;
      cache.page = -1;
      cache.items = [];
      cache.hasMore = null;
      for (let page = 0; page <= lastPage; page++) {
        cache.loading = true;
        try {
          const next = await request(`/api/archive?type=${encodeURIComponent(type)}&page=${page}`);
          const seen = new Set(cache.items.map((x) => Number(x.id)));
          cache.items.push(...(next.items || []).filter((x) => !seen.has(Number(x.id))));
          cache.page = page;
          cache.hasMore = Boolean(next.hasMore);
          cache.remaining = Number.isFinite(next.remaining) ? Number(next.remaining) : null;
        } catch {
          archiveCache[type] = emptyArchiveEntry();
          return;
        } finally {
          cache.loading = false;
        }
      }
    }
  }

  function mergedArchive(type, recent) {
    const seen = new Set(recent.map((x) => Number(x.id)));
    // Записи, которые снова стали активными (вернули из завершённых), из кэша архива не показываем;
    // «хвост» активного набора наоборот скрывается, когда запись завершили или удалили.
    if (type === "done_tasks") for (const x of appState?.tasks || []) seen.add(Number(x.id));
    if (type === "done_wishes") for (const x of appState?.wishes || []) seen.add(Number(x.id));
    if (type === "tasks") for (const x of appState?.completedTasks || []) seen.add(Number(x.id));
    if (type === "wishes") for (const x of appState?.completedWishes || []) seen.add(Number(x.id));
    return recent.concat(archiveCache[type].items.filter((x) => !seen.has(Number(x.id))));
  }

  function archiveMoreHtml(type, recentCount) {
    const cache = archiveCache[type];
    // Кнопка «Показать ещё» у активных наборов появляется только на границе
    // 200 записей, у архивов — сразу после 10 недавних.
    const threshold = { tasks: STATE_ACTIVE_LIMIT, dates: STATE_ACTIVE_LIMIT, wishes: STATE_ACTIVE_LIMIT }[type] || STATE_RECENT_LIMIT;
    const mayExist = recentCount >= threshold || cache.page >= 0;
    if (!mayExist || cache.hasMore === false) return "";
    // Счётчик «(N из M)»: N — сколько войдёт в следующую страницу,
    // M — сколько записей ещё не показано. Остаток неизвестен — без счётчика.
    // Собирается только из чисел — экранирование не требуется.
    const remaining = Number.isFinite(cache.remaining) ? cache.remaining : null;
    const counter = remaining === null ? "" : ` (${Math.min(ARCHIVE_PAGE_SIZE, remaining)} из ${remaining})`;
    return `<button class="secondary full" type="button" data-action="load-archive" data-type="${type}" style="margin-top:10px;">Показать ещё${counter}</button>`;
  }
  let toastTimer = null;
  let sessionExpired = false;
  let dialogContext = null;
  function partnerMissing() {
    return !appState?.pair?.user_b;
  }

  // SDK бросает WebAppMethodUnsupported, если метод новее клиента Telegram, —
  // необязательные вызовы гасим, чтобы не валить инициализацию приложения.
  function safeTg(fn) {
    try {
      return fn();
    } catch {
      return undefined;
    }
  }

  // ------------------------------------------------------------------
  // Акцентный цвет интерфейса (настройки на вкладке «Наша пара»).
  // Палитры под светлую/тёмную тему; «berry» — дефолт из CSS, он снимает
  // инлайн-переопределения переменных на :root.
  // ------------------------------------------------------------------
  const ACCENT_PALETTES = {
    berry: { light: "#b85464", dark: "#d97383" },
    sage: { light: "#55766a", dark: "#7ba394" },
    ocean: { light: "#4a6f8f", dark: "#7fa3c0" },
    violet: { light: "#7a5f9e", dark: "#a48cc9" },
    amber: { light: "#b06a2c", dark: "#d3924e" }
  };

  function hexRgb(hex) {
    const value = String(hex || "").replace("#", "");
    const full = value.length === 3 ? value.split("").map(c => c + c).join("") : value;
    if (!/^[0-9a-fA-F]{6}$/.test(full)) return null;
    const num = Number.parseInt(full, 16);
    return [(num >> 16) & 255, (num >> 8) & 255, num & 255];
  }

  function shadeHex(hex, factor) {
    const rgb = hexRgb(hex);
    if (!rgb) return hex;
    return `rgb(${rgb.map(c => Math.max(0, Math.min(255, Math.round(c * factor)))).join(", ")})`;
  }

  function applyAccent() {
    const root = document.documentElement;
    const dark = root.dataset.theme === "dark";
    const key = appState?.user?.accent_color || "berry";
    // Свотчи в настройках показывают актуальный для темы вариант палитры:
    // в тёмной теме светлый образец выглядел темнее фактического акцента.
    // Синхронизация здесь — applyAccent вызывается и из applyTheme
    // (themeChanged), и из render().
    document.querySelectorAll(".swatch[data-accent]").forEach((el) => {
      const palette = ACCENT_PALETTES[el.dataset.accent];
      if (palette) el.style.background = palette[dark ? "dark" : "light"];
    });
    const names = ["--berry", "--berry-dark", "--berry-soft", "--droplet-bg", "--droplet-border", "--droplet-glow", "--droplet-hi", "--droplet-fill", "--droplet-deep", "--droplet-halo", "--berry-shadow"];
    const hex = ACCENT_PALETTES[key]?.[dark ? "dark" : "light"];
    if (key === "berry" || !hex) {
      for (const name of names) root.style.removeProperty(name);
      return;
    }
    const rgb = hexRgb(hex);
    const rgba = (alpha) => `rgba(${rgb[0]}, ${rgb[1]}, ${rgb[2]}, ${alpha})`;
    root.style.setProperty("--berry", hex);
    root.style.setProperty("--berry-dark", shadeHex(hex, 0.82));
    root.style.setProperty("--berry-soft", rgba(dark ? 0.18 : 0.14));
    root.style.setProperty("--droplet-bg", rgba(dark ? 0.22 : 0.15));
    root.style.setProperty("--droplet-border", dark ? "rgba(255, 255, 255, 0.16)" : rgba(0.24));
    root.style.setProperty("--droplet-glow", dark
      ? `inset 0 1px 1px rgba(255, 255, 255, 0.22), 0 4px 16px ${rgba(0.22)}`
      : `inset 0 1px 1.5px rgba(255, 255, 255, 0.8), 0 4px 14px ${rgba(0.16)}`);
    // Капля — SVG-градиент: светлая кромка сверху, акцент в середине, тень снизу.
    root.style.setProperty("--droplet-hi", dark ? "rgba(255, 255, 255, 0.22)" : "rgba(255, 255, 255, 0.58)");
    root.style.setProperty("--droplet-fill", rgba(dark ? 0.38 : 0.30));
    root.style.setProperty("--droplet-deep", rgba(dark ? 0.18 : 0.16));
    root.style.setProperty("--droplet-halo", rgba(dark ? 0.30 : 0.22));
    root.style.setProperty("--berry-shadow", `0 8px 20px ${rgba(0.24)}`);
  }

  // Фон WebView в Telegram — это то, что видно за краями документа при
  // отскоке прокрутки (и в полноэкранном режиме под шапкой). Ключ "bg_color"
  // отдаёт цвет темы Telegram: в тёмной теме это чёрный, в светлой — белый,
  // а у приложения свой --bg. На длинном свайпе из-за этого появлялись
  // полосы другого цвета. Берём фактический цвет приложения.
  function themeBackground() {
    const value = window.getComputedStyle(document.documentElement).getPropertyValue("--bg").trim();
    return /^#[0-9a-f]{3}(?:[0-9a-f]{3})?$/i.test(value) ? value : null;
  }

  // Тема и акцент меняют CSS-переменные, а капля читает их при refresh().
  // Крючок нужен потому, что applyTheme вызывается раньше, чем создаётся
  // liquidNav (обращение к const до инициализации — ReferenceError).
  let navRefreshHook = null;

  function applyTheme() {
    const scheme = tg?.colorScheme || (window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light");
    document.documentElement.dataset.theme = scheme === "dark" ? "dark" : "light";
    // Цвет читаем после смены темы: --bg уже пересчитан.
    const background = themeBackground();
    // В полноэкранном режиме шапка Telegram прозрачная — сообщаем цвет,
    // чтобы системный статус-бар подстраивался под тему приложения.
    if (tg) {
      safeTg(() => tg.setHeaderColor(background || "bg_color"));
      safeTg(() => tg.setBackgroundColor(background || "bg_color"));
    }
    // Обычный браузер: адресная строка и системная панель красятся тем же цветом.
    if (background) {
      const meta = document.querySelector('meta[name="theme-color"]');
      if (meta) meta.setAttribute("content", background);
    }
    applyAccent();
    navRefreshHook?.();
  }

  if (tg) {
    tg.ready();
    tg.expand();
    applyTheme();
    tg.onEvent?.("themeChanged", applyTheme);
    // Полный экран (Bot API 8.0+). На старых клиентах и Telegram Desktop
    // прилетит fullscreenFailed или бросок метода — молча остаёмся в оконном режиме.
    tg.onEvent?.("fullscreenChanged", () => {
      document.body.classList.toggle("tg-fullscreen", Boolean(tg.isFullscreen));
    });
    // Свайп вниз сворачивает мини-апп — отключаем: сворачивание только кнопкой
    // закрытия, случайный жест не должен сворачивать приложение (Bot API 7.7+).
    safeTg(() => tg.disableVerticalSwipes());
    safeTg(() => tg.requestFullscreen());
  } else {
    applyTheme();
  }

  // ------------------------------------------------------------------
  // Иконка на домашний экран (Bot API 8.0+) и закрытие в полноэкранном режиме
  // ------------------------------------------------------------------
  const HS_ADDED_KEY = "duoplan.homescreenAdded";
  let homeScreenStatus = null;
  function syncHomeScreenButton(status) {
    if (status) homeScreenStatus = status;
    if (!homeScreenButton) return;
    let storedAdded = false;
    try { storedAdded = localStorage.getItem(HS_ADDED_KEY) === "1"; } catch {}
    // unknown — клиент не смог определить статус: кнопку всё равно показываем,
    // повторный вызов addToHomeScreen безопасен. Показ — только на экране «Наша пара»,
    // на остальных вкладках прячем.
    const knownAdded = storedAdded || homeScreenStatus === "added";
    homeScreenButton.hidden = knownAdded
      || (homeScreenStatus !== "missed" && homeScreenStatus !== "unknown")
      || currentTab !== "pair";
  }
  if (tg?.addToHomeScreen) {
    tg.onEvent?.("homeScreenChecked", (data) => syncHomeScreenButton(data?.status));
    tg.onEvent?.("homeScreenAdded", () => {
      try { localStorage.setItem(HS_ADDED_KEY, "1"); } catch {}
      syncHomeScreenButton("added");
    });
    safeTg(() => tg.checkHomeScreenStatus((data) => syncHomeScreenButton(data?.status)));
    homeScreenButton.addEventListener("click", () => {
      safeTg(() => tg.addToHomeScreen());
      // Статус мог быть unknown — переспрашиваем после системного диалога.
      safeTg(() => tg.checkHomeScreenStatus((data) => syncHomeScreenButton(data?.status)));
    });
  }
  fullscreenClose?.addEventListener("click", () => tg?.close?.());

  function esc(value) {
    return String(value ?? "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  // ------------------------------------------------------------------
  // Telegram-разметка в текстах (жирный/курсив/подчёркнутый/зачёркнутый/
  // спойлер/цитата). Разметка хранится прямо в тексте поля теми же
  // маркерами, что и в Telegram: **ж**, _к_, __ч__, ~~з~~, ||спойлер||,
  // строки «> » — цитата. Сначала экранируем всё, затем наклеиваем теги из
  // фиксированного набора — произвольный HTML в поля не пройдёт никогда.
  // Спойлер раскрывается тапом, цитата красится акцентным цветом (CSS).
  // ------------------------------------------------------------------
  const RICH_TOKENS = [["**", "b", ""], ["__", "u", ""], ["||", "span", "rich-spoiler"], ["~~", "s", ""], ["_", "i", ""]];

  function richInline(escaped) {
    const out = [];
    const stack = [];
    let i = 0;
    while (i < escaped.length) {
      const token = RICH_TOKENS.find(([t]) => escaped.startsWith(t, i));
      if (token) {
        const [tok, tag, cls] = token;
        // Балансировка как в HTML: закрывающий маркер закрывает и все вложенные
        // в него элементы — интерливинг «__а _б__ в_» не ломает структуру тегов.
        const openIndex = stack.map(item => item.tok).lastIndexOf(tok);
        if (openIndex !== -1) {
          for (let s = stack.length - 1; s >= openIndex; s--) out.push(stack[s].cls ? "</span>" : `</${stack[s].tag}>`);
          stack.length = openIndex;
        } else {
          out.push(cls ? `<span class="${cls}" data-spoiler>` : `<${tag}>`);
          stack.push({ tok, tag, cls });
        }
        i += tok.length;
        continue;
      }
      out.push(escaped[i++]);
    }
    while (stack.length) {
      const top = stack.pop();
      out.push(top.cls ? "</span>" : `</${top.tag}>`);
    }
    return out.join("");
  }

  function renderRichText(raw) {
    const lines = esc(raw).split("\n");
    const out = [];
    let quote = null;
    const flushQuote = () => {
      if (!quote) return;
      out.push(`<blockquote class="rich-quote">${quote.map(richInline).join("\n")}</blockquote>`);
      quote = null;
    };
    for (const line of lines) {
      if (line.startsWith("&gt; ")) { (quote ??= []).push(line.slice(5)); continue; }
      if (line === "&gt;") { (quote ??= []).push(""); continue; }
      flushQuote();
      out.push(richInline(line));
    }
    flushQuote();
    return out.join("\n");
  }

  // Ссылка приходит из базы: сервер проверяет схему при записи, но старые
  // записи и данные из бота могли попасть туда без проверки. Открываем только
  // http(s) — javascript:/data: в window.open недопустимы.
  function openExternal(url) {
    let parsed = null;
    try {
      parsed = new URL(String(url || ""));
    } catch {
      parsed = null;
    }
    if (!parsed || (parsed.protocol !== "http:" && parsed.protocol !== "https:")) {
      showToast("Ссылка некорректна");
      return;
    }
    window.open(parsed.href, "_blank", "noopener");
  }

  function firstLetter(name, fallback = "Д") {
    const clean = String(name ?? "").trim();
    return clean ? Array.from(clean)[0].toUpperCase() : fallback;
  }

  function showToast(message, { sticky = false } = {}) {
    if (!toastEl) return;
    toastEl.textContent = message;
    toastEl.hidden = false;
    clearTimeout(toastTimer);
    if (!sticky) {
      toastTimer = setTimeout(() => {
        toastEl.hidden = true;
      }, 2600);
    }
  }

  // 401 нельзя глотать в фоне: иначе интерфейс молча показывает устаревшие
  // данные, пока следующее действие не упадёт коротким тостом. Сообщение об
  // истёкшей сессии держим на экране до перезапуска приложения.
  function handleRequestError(error) {
    if (error?.status === 401) {
      sessionExpired = true;
      showToast(error.message, { sticky: true });
      return;
    }
    showToast(error.message);
  }

  // Зависший запрос (плохая сеть, «спящий» воркер) раньше держал спиннер
  // вечно: пользователь не понимал, идёт ли сохранение.
  const REQUEST_TIMEOUT_MS = 20000;

  async function request(path, options = {}) {
    const headers = {
      "x-telegram-init-data": tg?.initData || "",
      "x-timezone": Intl.DateTimeFormat().resolvedOptions().timeZone || "Europe/Moscow",
      ...(options.body ? { "content-type": "application/json" } : {})
    };
    const controller = typeof AbortController === "function" ? new AbortController() : null;
    const timer = controller ? setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS) : null;
    let response;
    try {
      response = await fetch(path, {
        method: options.method || "GET",
        headers,
        body: options.body ? JSON.stringify(options.body) : undefined,
        signal: controller ? controller.signal : undefined
      });
    } catch (error) {
      if (error?.name === "AbortError") {
        const timeout = new Error("Сервер не ответил. Попробуйте ещё раз.");
        timeout.status = 0;
        throw timeout;
      }
      throw error;
    } finally {
      if (timer) clearTimeout(timer);
    }
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      const error = new Error(payload.error || payload.message || `Ошибка ${response.status}`);
      error.status = response.status;
      error.code = payload.code;
      throw error;
    }
    return payload;
  }

  // ------------------------------------------------------------------
  // Нижняя навигация: жидкая стеклянная капля (public/nav.js)
  // ------------------------------------------------------------------
  // Модуль владеет геометрией и жестом, но не переключает страницы: о цели он
  // сообщает через onCommit, а дальше работает существующий switchTab.
  const liquidNav = window.createLiquidNav
    ? window.createLiquidNav({
        nav: bottomNav,
        svg: navDroplet,
        path: document.getElementById("nav-droplet-path"),
        items: navButtons,
        onCommit: (tab) => switchTab(tab, true, true)
      })
    : null;

  // Единственная точка управления каплей для остального кода приложения.
  function updateDroplet(targetTab, animate = true) {
    if (!liquidNav) return;
    liquidNav.setActive(targetTab, animate);
  }

  // Смена темы/акцента перечитывает цвета вкладок внутри nav.js.
  navRefreshHook = () => liquidNav?.refresh();

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
    // Видимость кнопки «на главный экран» зависит и от вкладки (только «Наша
    // пара»), и от статуса клиента — пересинхронизируем на каждом рендере.
    syncHomeScreenButton();
    const pair = appState?.pair;
    const isSubScreen = currentTab !== "home";
    // Собственная кнопка «Назад» не используется: навигация идёт через
    // системную tg.BackButton (на главной она скрыта, чтобы показывалась
    // кнопка закрытия приложения).
    if (tg?.BackButton) {
      if (isSubScreen) tg.BackButton.show();
      else tg.BackButton.hide();
    }

    if (!pair || !appState?.user?.gender) {
      pairButton.hidden = true;
      bottomNav.hidden = true;
      return;
    }

    pairButton.hidden = false;
    // Панель могла быть скрыта в момент инициализации (нет пары) — размеры
    // появились только сейчас, поэтому пересчитываем геометрию капли.
    // Только на переходе «скрыта → показана»: иначе refresh() на каждом
    // рендере сбрасывал бы незавершённую анимацию капли.
    const wasHidden = bottomNav.hidden;
    bottomNav.hidden = false;
    if (wasHidden) liquidNav?.refresh();
    avatarA.textContent = firstLetter(pair.name1, "А");
    avatarB.textContent = pair.user_b ? firstLetter(pair.name2, "Б") : "+";
  }

  function switchTab(tab, pushScroll = true) {
    if (tab !== currentTab) {
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
    if (currentTab !== "home") {
      switchTab("home");
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
    const preOffset = timeZoneOffsetMs(tz, new Date(desiredUtc - 24 * 3600000));
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

  // Стабильный tie-break по id: годится и для числовых rowid, и для строковых id.
  function byRowId(a, b) {
    return a < b ? -1 : a > b ? 1 : 0;
  }

  // Ключ дедлайна считается один раз на запись: planTarget строит
  // Intl.DateTimeFormat и слишком дорог внутри компаратора на каждое сравнение.
  // Тай-брейк по id повторяет серверную sortByTaskDeadline, чтобы порядок
  // клиента совпадал с /api/state и архивными страницами.
  function sortByTaskDeadline(rows) {
    const decorated = rows.map((row) => ({ row, at: planTarget(row.day, row.time)?.getTime() ?? Infinity }));
    decorated.sort((a, b) => a.at - b.at || byRowId(a.row.id, b.row.id));
    return decorated.map(({ row }) => row);
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

  // Русская плюрализация: 1 день / 2 дня / 5 дней (21 день, 11 дней, 14 дней).
  function plural(n, one, few, many) {
    const value = Math.abs(Number(n) || 0);
    const mod10 = value % 10;
    const mod100 = value % 100;
    if (mod10 === 1 && mod100 !== 11) return one;
    if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return few;
    return many;
  }

  function countdownFromDiff(diff) {
    // Просрочка старше недели помечается stale: событие давно позади, и яркий
    // чип выглядит как ошибка, а не как статус (см. .day-chip.is-stale).
    if (diff <= 0) return { overdue: true, stale: -diff > 7 * 86400000, text: "Время пришло" };
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
      const stale = -diff > 7 * 86400000;
      return `<span class="day-chip is-overdue${stale ? " is-stale" : ""}" data-countdown="${esc(day)}|${esc(time || "")}">Время пришло</span>`;
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
      node.classList.toggle("is-stale", Boolean(countdown.stale));
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
  function renderGenderGate() {
    // Пол обязателен: без него в приложение не пускаем — от него зависят
    // обращения в интерфейсе (подтверждения, список желаний).
    return `
      ${renderTabHeader("home")}
      <section class="card hero-card">
        <p class="eyebrow">DuoPlan · для двоих</p>
        <h2>Укажите ваш пол</h2>
        <p>Это нужно для правильных обращений в интерфейсе — подсказок в вишлисте и подтверждений действий. Выбрать можно только один вариант.</p>
        <div style="margin-top:16px; display:grid; gap:10px;">
          <button class="primary full" type="button" data-action="set-gender" data-gender="male">Мужчина</button>
          <button class="primary full" type="button" data-action="set-gender" data-gender="female">Женщина</button>
        </div>
      </section>
    `;
  }

  function renderOnboarding() {
    return `
      ${renderTabHeader("home")}
      <section class="card hero-card">
        <p class="eyebrow">DuoPlan · для двоих</p>
        <h2>Создайте ваше общее пространство</h2>
        <p>Совместные планы, воспоминания и желания — в одном месте.</p>
        <div style="margin-top:16px; display:grid; gap:10px;">
          <button class="primary full" type="button" data-action="create-pair">Создать пространство</button>
        </div>
      </section>
      <section class="card">
        <p class="eyebrow">Вход по коду</p>
        <h3>Добавить партнёра по коду</h3>
        <label class="field"><span>Код партнёра (8 символов)</span><input id="join-code-home" maxlength="8" placeholder="Введите 8-значный код"></label>
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
          <p>Отправьте код партнёру. После его присоединения здесь появятся общие планы, значимые даты, общий дневник, вишлист и ритуал дня.</p>
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
        <p>${daily.done ? `Вы отметили ритуал · +10 XP${daily.partnerDone ? " · партнёр тоже отметил" : ""}` : (daily.partnerDone ? "Партнёр уже отметил ритуал — отметьте и вы" : "Отметьте ритуал дня и получите +10 XP.")}</p>
        ${daily.done ? "" : `<div style="margin-top:12px;"><button class="primary full" type="button" data-action="daily-done">Мы сделали это · +10 XP</button></div>`}
      </section>
    ` : "";

    const previewTasks = sortByTaskDeadline(tasks).slice(0, 3).map(taskItem).join("");
    // Порядок дат приходит отсортированным из /api/state — повторно не сортируем.
    const previewDates = dates.slice(0, 2).map(dateItem).join("");
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
            <h3 class="item-title">${renderRichText(item.title)}</h3>
            <div class="item-meta">
              ${item.is_private ? `<span class="day-chip is-private">Личная</span>` : ""}
              ${item.day ? `<span>${esc(item.day)}${item.time ? ` · ${esc(item.time)}` : ""}</span>` : ""}
              ${countdownChip(item.day, item.time)}
              ${item.day ? `<button class="link-btn" type="button" data-action="show-in-calendar" data-day="${esc(item.day)}" aria-label="Показать в календаре">В календаре</button>` : ""}
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
            <h3 class="item-title">${renderRichText(item.title)}</h3>
            <div class="item-meta">
              <span>${esc(item.day)}${item.time ? ` · ${esc(item.time)}` : ""}</span>
              ${item.recurs ? `<span>· Ежегодно</span>` : ""}
              ${item.is_private ? `<span class="day-chip is-private">Личная</span>` : ""}
              ${chip}
              <button class="link-btn" type="button" data-action="show-in-calendar" data-day="${esc(item.day)}" aria-label="Показать в календаре">В календаре</button>
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
            <p style="color:var(--ink); white-space:pre-wrap; margin-bottom:6px;">${renderRichText(item.body)}</p>
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

  function wishItem(item, editable = true) {
    const canEdit = editable && item.owner_id === appState.user.tg_id;
    const actions = canEdit ? `
      <button class="icon-btn" type="button" data-action="done-item" data-type="wishes" data-id="${item.id}" aria-label="Исполнено">✓</button>
      <button class="icon-btn" type="button" data-action="edit-item" data-type="wishes" data-id="${item.id}" aria-label="Редактировать">✎</button>
      <button class="icon-btn" type="button" data-action="delete-item" data-type="wishes" data-id="${item.id}" aria-label="Удалить">✕</button>
    ` : "";
    return `
      <article class="card">
        <div class="item-row">
          <div class="item-main">
            <h3 class="item-title">${renderRichText(item.body)}</h3>
            ${item.url ? `<button class="secondary small" data-action="open-url" data-url="${esc(item.url)}">Ссылка</button>` : ""}
          </div>
          ${actions ? `<div class="item-actions">${actions}</div>` : ""}
        </div>
      </article>
    `;
  }

  function findItem(type, id) {
    const collections = {
      tasks: [...mergedArchive("tasks", appState?.tasks || []), ...mergedArchive("done_tasks", appState?.completedTasks || [])],
      dates: mergedArchive("dates", appState?.dates || []),
      memories: mergedArchive("memories", appState?.memories || []),
      wishes: [...mergedArchive("wishes", appState?.wishes || []), ...mergedArchive("done_wishes", appState?.completedWishes || [])]
    };
    return (collections[type] || []).find((x) => Number(x.id) === Number(id));
  }

  function completedTaskItem(item) {
    return `
      <article class="card" style="opacity:0.72;">
        <div class="item-row">
          <div class="item-main">
            <h3 class="item-title" style="text-decoration:line-through;">${renderRichText(item.title)}</h3>
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

  function completedWishItem(item, editable = true) {
    const canEdit = editable && item.owner_id === appState.user.tg_id;
    const actions = canEdit ? `
      <button class="icon-btn" type="button" data-action="reopen-item" data-type="wishes" data-id="${item.id}" aria-label="Вернуть в желания">↩</button>
      <button class="icon-btn" type="button" data-action="edit-item" data-type="wishes" data-id="${item.id}" aria-label="Редактировать">✎</button>
      <button class="icon-btn" type="button" data-action="delete-item" data-type="wishes" data-id="${item.id}" aria-label="Удалить">✕</button>
    ` : "";
    return `
      <article class="card" style="opacity:0.72;">
        <div class="item-row">
          <div class="item-main">
            <h3 class="item-title" style="text-decoration:line-through;">${renderRichText(item.body)}</h3>
            ${item.url ? `<button class="secondary small" data-action="open-url" data-url="${esc(item.url)}">Ссылка</button>` : ""}
            <div class="item-meta"><span>Исполнено</span></div>
          </div>
          ${actions ? `<div class="item-actions">${actions}</div>` : ""}
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

  // ------------------------------------------------------------------
  // Календарь вкладки «Наша пара»
  // ------------------------------------------------------------------
  // Работаем с календарными ключами "YYYY-MM-DD" и арифметикой Date.UTC:
  // new Date("2026-05-15") парсится как UTC-полночь и в поясе пары может
  // уехать на предыдущий день. Часовой пояс пары нужен только для «сегодня».

  function calendarPad(value) {
    return String(value).padStart(2, "0");
  }

  function calendarDayKey(year, month, day) {
    return `${year}-${calendarPad(month)}-${calendarPad(day)}`;
  }

  // Дней в месяце: день 0 следующего месяца = последний день текущего.
  function calendarDaysInMonth(year, month) {
    return new Date(Date.UTC(year, month, 0)).getUTCDate();
  }

  // Сетка месяца, неделя с понедельника. Ячейки соседних месяцев нужны,
  // чтобы недели были ровными: они помечены inMonth: false.
  function calendarGrid(year, month) {
    const first = new Date(Date.UTC(year, month - 1, 1));
    const offset = (first.getUTCDay() + 6) % 7;
    const total = Math.ceil((offset + calendarDaysInMonth(year, month)) / 7) * 7;
    const cells = [];
    for (let i = 0; i < total; i++) {
      const cursor = new Date(Date.UTC(year, month - 1, 1 - offset + i));
      const cellYear = cursor.getUTCFullYear();
      const cellMonth = cursor.getUTCMonth() + 1;
      const cellDay = cursor.getUTCDate();
      cells.push({
        key: calendarDayKey(cellYear, cellMonth, cellDay),
        day: cellDay,
        month: cellMonth,
        year: cellYear,
        inMonth: cellMonth === month && cellYear === year
      });
    }
    return cells;
  }

  // События месяца по дням: Map<"YYYY-MM-DD", { tasks: [], dates: [] }>.
  // Планы без даты не попадают, ежегодные даты проецируются на тот же
  // месяц/день, 29 февраля в невисокосный год пропускается.
  function calendarEventIndex(tasks, dates, wishes, year, month) {
    const index = new Map();
    const push = (key, kind, item) => {
      const bucket = index.get(key) || { tasks: [], dates: [], wishes: [] };
      bucket[kind].push(item);
      index.set(key, bucket);
    };
    for (const task of tasks || []) {
      if (!task.day) continue;
      const [taskYear, taskMonth, taskDay] = String(task.day).split("-").map(Number);
      if (taskYear !== year || taskMonth !== month) continue;
      push(calendarDayKey(year, month, taskDay), "tasks", task);
    }
    for (const date of dates || []) {
      if (!date.day) continue;
      const [dateYear, dateMonth, dateDay] = String(date.day).split("-").map(Number);
      if (![dateYear, dateMonth, dateDay].every(Number.isFinite)) continue;
      const recurs = Number(date.recurs) === 1 || date.recurs === true;
      if (!recurs) {
        if (dateYear === year && dateMonth === month) {
          push(calendarDayKey(year, month, dateDay), "dates", date);
        }
        continue;
      }
      if (dateMonth !== month) continue;
      // Ежегодная дата не показывается раньше года, в котором её создали.
      if (year < dateYear) continue;
      // 29 февраля существует не в каждом году — не переносим на 28-е/1-е.
      if (dateDay > calendarDaysInMonth(year, month)) continue;
      push(calendarDayKey(year, month, dateDay), "dates", date);
    }
    // Вручённые желания: звезда стоит в день, когда желание отметили
    // исполненным. Даты вручения у старых записей нет — такие пропускаем.
    const monthPrefix = `${year}-${calendarPad(month)}`;
    for (const wish of wishes || []) {
      if (Number(wish.done) !== 1 && wish.done !== true) continue;
      const at = Number(wish.done_at);
      if (!Number.isFinite(at) || at <= 0) continue;
      const key = calendarKeyFromDate(new Date(at * 1000));
      if (!key || !key.startsWith(monthPrefix)) continue;
      push(key, "wishes", wish);
    }
    return index;
  }

  function calendarMonthTitle(year, month) {
    // timeZone: "UTC" — иначе полночь первого числа в отрицательном поясе
    // отрисуется как предыдущий месяц.
    const name = new Intl.DateTimeFormat("ru-RU", { month: "long", timeZone: "UTC" })
      .format(new Date(Date.UTC(year, month - 1, 1)));
    return `${name.charAt(0).toUpperCase()}${name.slice(1)} ${year}`;
  }

  function calendarLongDate(key) {
    const [year, month, day] = String(key).split("-").map(Number);
    return new Intl.DateTimeFormat("ru-RU", {
      day: "numeric", month: "long", year: "numeric", timeZone: "UTC"
    }).format(new Date(Date.UTC(year, month - 1, day)));
  }

  // Календарный ключ момента в поясе пары (а не по поясу устройства).
  function calendarKeyFromDate(date) {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone: pairTimeZone(), year: "numeric", month: "2-digit", day: "2-digit"
    }).formatToParts(date);
    const get = (type) => parts.find((part) => part.type === type)?.value;
    if (!get("year")) return null;
    return `${get("year")}-${get("month")}-${get("day")}`;
  }

  function calendarTodayKey() {
    return calendarKeyFromDate(new Date());
  }

  function calendarCurrentMonth() {
    if (calendarMonth) return calendarMonth;
    const [year, month] = calendarTodayKey().split("-").map(Number);
    calendarMonth = { year, month };
    return calendarMonth;
  }

  function shiftCalendarMonth(delta) {
    const { year, month } = calendarCurrentMonth();
    const next = new Date(Date.UTC(year, month - 1 + delta, 1));
    calendarMonth = { year: next.getUTCFullYear(), month: next.getUTCMonth() + 1 };
    // Выбранный день принадлежал другому месяцу — снимаем выделение.
    calendarSelected = null;
    render();
  }

  function selectCalendarDay(key) {
    if (!key) return;
    const [year, month] = key.split("-").map(Number);
    calendarSelected = key;
    // Клик по дню соседнего месяца перелистывает календарь на его месяц.
    if (!calendarMonth || calendarMonth.year !== year || calendarMonth.month !== month) {
      calendarMonth = { year, month };
    }
    render();
  }

  function calendarEventRows(bucket) {
    if (!bucket) return [];
    const rows = [
      ...bucket.tasks.map((task) => ({
        kind: "task", title: task.title, time: task.time, isPrivate: Number(task.is_private) === 1
      })),
      ...bucket.dates.map((date) => ({
        kind: "date", title: date.title, time: date.time, isPrivate: Number(date.is_private) === 1
      })),
      ...(bucket.wishes || []).map((wish) => ({
        kind: "wish", title: wish.body, time: null, isPrivate: false
      }))
    ];
    // События со временем — по возрастанию, без времени — в конце.
    return rows.sort((a, b) => (a.time || "99:99").localeCompare(b.time || "99:99"));
  }

  // Календарь показывает все загруженные записи: state + страницы архива.
  // Приватность уже обеспечена сервером — /api/archive фильтрует is_private
  // по текущему пользователю, здесь никаких обходов нет.
  function renderPairCalendar() {
    const tasks = mergedArchive("tasks", appState.tasks || []);
    const dates = mergedArchive("dates", appState.dates || []);
    // Звёздочка — только мои вручённые желания: чужие подарки в календаре
    // пользователя не показываем (owner_id — владелец желания).
    const myId = Number(appState.user?.tg_id);
    const wishes = mergedArchive("done_wishes", appState.completedWishes || [])
      .filter((wish) => Number(wish.owner_id) === myId);
    const today = calendarTodayKey();
    const { year, month } = calendarCurrentMonth();
    const index = calendarEventIndex(tasks, dates, wishes, year, month);
    const selected = calendarSelected;
    const weekdays = ["Пн", "Вт", "Ср", "Чт", "Пт", "Сб", "Вс"];

    const cellsHtml = calendarGrid(year, month).map((cell) => {
      const bucket = index.get(cell.key);
      const cellTasks = bucket?.tasks || [];
      const cellDates = bucket?.dates || [];
      const dots = [];
      // Звезда — вручённое желание, точки — планы и даты. Личные записи
      // (is_private) помечаем серым, чтобы не путать с общими.
      if (bucket?.wishes.length) dots.push('<span class="cal-star">★</span>');
      if (cellTasks.length) {
        dots.push(`<i class="cal-dot ${cellTasks.every((item) => Number(item.is_private) === 1) ? "is-private" : "is-task"}"></i>`);
      }
      if (cellDates.length) {
        dots.push(`<i class="cal-dot ${cellDates.every((item) => Number(item.is_private) === 1) ? "is-private" : "is-date"}"></i>`);
      }
      const classes = ["cal-day"];
      if (!cell.inMonth) classes.push("is-outside");
      // «Сегодня» подсвечиваем только в своём месяце: в сетке соседнего
      // месяца кольцо на приглушённой ячейке читается как выбранный день.
      if (cell.inMonth && cell.key === today) classes.push("is-today");
      if (cell.key === selected) classes.push("is-selected");
      if (dots.length) classes.push("has-events");
      const label = dots.length
        ? `${calendarLongDate(cell.key)}, есть события`
        : calendarLongDate(cell.key);
      return `
        <button class="${classes.join(" ")}" type="button" data-action="calendar-day" data-day="${cell.key}"
          aria-label="${esc(label)}"${cell.key === selected ? ' aria-pressed="true"' : ""}>
          <span class="cal-num">${cell.day}</span>
          <span class="cal-dots" aria-hidden="true">${dots.join("")}</span>
        </button>
      `;
    }).join("");

    let details = "";
    if (selected) {
      const rows = calendarEventRows(index.get(selected));
      details = `
        <div class="cal-events">
          <p class="cal-events-date">${esc(calendarLongDate(selected))}</p>
          ${rows.length ? rows.map((row) => `
            <div class="cal-event">
              ${row.kind === "wish"
                ? '<span class="cal-star" aria-hidden="true">★</span>'
                : `<i class="cal-dot ${row.isPrivate ? "is-private" : row.kind === "task" ? "is-task" : "is-date"}" aria-hidden="true"></i>`}
              <div class="cal-event-body">
                <span class="cal-event-title">${renderRichText(row.title)}</span>
                <span class="cal-event-meta">${row.kind === "task" ? "План" : row.kind === "date" ? "Значимая дата" : "Желание подарено"}${row.isPrivate ? " · личное" : ""}${row.time ? ` · ${esc(row.time)}` : ""}</span>
              </div>
            </div>
          `).join("") : `<p class="cal-empty">На этот день событий нет.</p>`}
        </div>
      `;
    }

    return `
      <section class="card calendar-card">
        <p class="eyebrow">Календарь</p>
        <div class="cal-head">
          <button class="cal-nav-btn" type="button" data-action="calendar-prev" aria-label="Предыдущий месяц">‹</button>
          <h3 class="cal-title">${esc(calendarMonthTitle(year, month))}</h3>
          <button class="cal-nav-btn" type="button" data-action="calendar-next" aria-label="Следующий месяц">›</button>
        </div>
        <div class="cal-weekdays" aria-hidden="true">${weekdays.map((day) => `<span>${day}</span>`).join("")}</div>
        <div class="cal-grid">${cellsHtml}</div>
        <div class="cal-legend">
          <span><i class="cal-dot is-task" aria-hidden="true"></i> Планы</span>
          <span><i class="cal-dot is-date" aria-hidden="true"></i> Значимые даты</span>
          <span><span class="cal-star" aria-hidden="true">★</span> Желания</span>
          <span><i class="cal-dot is-private" aria-hidden="true"></i> Личное</span>
        </div>
        ${details}
      </section>
    `;
  }

  // /api/state отдаёт не больше STATE_ACTIVE_LIMIT активных записей, остальное
  // лежит в /api/archive. Если лимит достигнут, догружаем страницы в фоне:
  // календарь сразу показывает известное и обновляется по мере поступления.
  function calendarArchivePending(type) {
    const recent = type === "tasks" ? (appState?.tasks || [])
      : type === "dates" ? (appState?.dates || [])
        : (appState?.completedWishes || []);
    // Вручённые желания живут в «архиве» уже с 10 записей, активные — с 200.
    const threshold = type === "done_wishes" ? STATE_RECENT_LIMIT : STATE_ACTIVE_LIMIT;
    if (recent.length < threshold) return false;
    return archiveCache[type].hasMore !== false;
  }

  async function ensureCalendarArchive() {
    if (calendarFetching) return;
    calendarFetching = true;
    try {
      for (const type of ["tasks", "dates", "done_wishes"]) {
        if (!calendarArchivePending(type)) continue;
        const cache = archiveCache[type];
        let guard = 0;
        while (cache.hasMore !== false && guard++ < 50) {
          const before = cache.items.length;
          await loadArchivePage(type);
          // Страница без новых записей — дальше не крутимся.
          if (cache.items.length === before) break;
        }
      }
    } catch (error) {
      // Сеть недоступна: календарь покажет то, что уже загружено.
    } finally {
      calendarFetching = false;
    }
  }

  // Персональные настройки: акцентный цвет, время утренней сводки и сводки
  // о датах за сутки. Напоминания о планах (за 3 часа и за час) включены всегда.
  function renderPairSettings() {
    const user = appState.user;
    const accent = user.accent_color || "berry";
    // Свотчи сразу рисуются вариантом текущей темы; при смене темы между
    // рендерами их перекрашивает applyAccent().
    const dark = document.documentElement.dataset.theme === "dark";
    const swatches = Object.entries(ACCENT_PALETTES).map(([key, palette]) => `
      <button class="swatch${key === accent ? " is-active" : ""}" type="button" data-action="set-accent" data-accent="${key}"
        style="background:${palette[dark ? "dark" : "light"]}" aria-label="Акцентный цвет: ${key}"></button>
    `).join("");
    return `
      <section class="card">
        <p class="eyebrow">Настройки</p>
        <h3>Оформление и уведомления</h3>
        <div class="settings-row">
          <span class="settings-label">Акцентный цвет</span>
          <div class="swatch-row">${swatches}</div>
        </div>
        <label class="settings-row">
          <span class="settings-label"><input type="checkbox" id="digest-enabled" ${user.digest_enabled ? "checked" : ""}> Утренняя сводка</span>
          <input type="time" id="digest-time" value="${esc(user.digest_time || "09:00")}">
        </label>
        <p class="settings-hint">Планы и значимые даты на сегодня и завтра — личным сообщением от бота.</p>
        <label class="settings-row">
          <span class="settings-label"><input type="checkbox" id="dates-digest-enabled" ${user.dates_digest_enabled ? "checked" : ""}> Даты за сутки</span>
          <input type="time" id="dates-digest-time" value="${esc(user.dates_digest_time || "09:00")}">
        </label>
        <p class="settings-hint">Напомнит о завтрашних датах накануне в выбранное время. Кроме сводок бот предупреждает о плане с точным временем за 3 часа и за час.</p>
        <div style="margin-top:14px; display:grid; gap:8px;">
          <button class="secondary full" type="button" data-action="save-settings">Сохранить настройки</button>
          <button class="secondary full" type="button" data-action="export-diary">Выслать дневник сообщением</button>
        </div>
        <p class="settings-hint">«Выслать дневник» — бот отправит все записи дневника пары личным сообщением: резервная копия на случай, если захочется перечитать всё сразу.</p>
      </section>
    `;
  }

  function renderPair() {
    const { pair } = appState;
    // Карточка приглашения живёт ровно пока партнёра нет: как только он
    // присоединился (user_b заполнен) — скрываем; если партнёр вышел
    // (сервер обнуляет user_b) — карточка возвращается.
    const inviteBlock = partnerMissing() ? `
      <section class="card">
        <p class="eyebrow">Приглашение партнёра</p>
        <h3>Отправьте код партнёру</h3>
        <p>После его присоединения здесь появятся общие планы, значимые даты, общий дневник, вишлист и ритуал дня. Общие очки пары: ${pair.together_pts || 0} XP</p>
        ${pair.code ? `
          <div style="margin-top:14px; display:grid; gap:8px;">
            <button class="secondary full" type="button" data-action="copy-code" data-code="${esc(pair.code)}">Скопировать код: ${esc(pair.code)}</button>
            <button class="secondary full" type="button" data-action="copy-link" data-code="${esc(pair.code)}">Скопировать ссылку для партнёра</button>
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
      ${renderPairCalendar()}
      ${renderPairSettings()}
    `;
  }

  function render() {
    // Разметка ниже перезаписывается целиком — экземпляр капли снимаем заранее,
    // иначе он остался бы висеть на window-слушателях.
    destroyWishSwitch();
    // Акцент мог измениться (настройки/тема) — пере-применяем на каждом рендере.
    applyAccent();
    syncArchiveCachePair();
    syncTopControls();
    if (!appState?.user?.gender) {
      appEl.innerHTML = renderGenderGate();
      return;
    }
    if (!appState?.pair) {
      appEl.innerHTML = renderOnboarding();
      return;
    }
    if (currentTab === "home") {
      appEl.innerHTML = renderHome();
    } else if (currentTab === "tasks") {
      const openTasks = mergedArchive("tasks", sortByTaskDeadline(appState.tasks || []));
      const doneTasks = mergedArchive("done_tasks", appState.completedTasks || []);
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
      html += archiveMoreHtml("done_tasks", (appState.completedTasks || []).length);
      html += archiveMoreHtml("tasks", (appState.tasks || []).length);
      appEl.innerHTML = html;
    } else if (currentTab === "dates") {
      // Порядок приходит отсортированным из /api/state (sortDateRows):
      // повторная сортировка с часовыми поясами на каждое сравнение не нужна.
      const sortedDates = mergedArchive("dates", appState.dates || []);
      appEl.innerHTML = renderListTab("dates", sortedDates, "add-date", "Добавить дату", "Хочу запомнить", "Добавьте годовщину, день знакомства или важный праздник.", dateItem) + archiveMoreHtml("dates", (appState.dates || []).length);
    } else if (currentTab === "memories") {
      const recentMemories = appState.memories || [];
      const memoriesHtml = renderListTab("memories", mergedArchive("memories", recentMemories), "add-memory", "Записать", "Воспоминание", "Сохраняйте тёплые воспоминания, к которым хочется возвращаться.", memoryItem);
      appEl.innerHTML = memoriesHtml + archiveMoreHtml("memories", recentMemories.length);
    } else if (currentTab === "wishes") {
      const wishDisabledClass = partnerMissing() ? " is-disabled" : "";
      const hasPartner = Boolean(appState.pair?.user_b);
      if (wishView === "partner" && !hasPartner) wishView = "mine";
      const myId = appState.user?.tg_id;
      const isMine = wishView === "mine";
      const allOpen = mergedArchive("wishes", appState.wishes || []);
      const allDone = mergedArchive("done_wishes", appState.completedWishes || []);
      const ownOpen = allOpen.filter((w) => Number(w.owner_id) === Number(myId));
      const ownDone = allDone.filter((w) => Number(w.owner_id) === Number(myId));
      const partnerOpen = allOpen.filter((w) => Number(w.owner_id) !== Number(myId));
      const partnerDone = allDone.filter((w) => Number(w.owner_id) !== Number(myId));
      const openWishes = isMine ? ownOpen : partnerOpen;
      const doneWishes = isMine ? ownDone : partnerDone;
      const partnerLabel = appState.pair?.partner_gender === "female" ? "Её" : "Его";
      let html = renderTabHeader("wishes");
      if (hasPartner) {
        html += `
          <div class="wish-switch" role="tablist" aria-label="Чьи желания показывать">
            <button class="wish-switch-btn${isMine ? " is-active" : ""}" type="button" role="tab" aria-selected="${isMine}" data-action="wish-view" data-view="mine" data-tab="mine">Мои</button>
            <button class="wish-switch-btn${!isMine ? " is-active" : ""}" type="button" role="tab" aria-selected="${!isMine}" data-action="wish-view" data-view="partner" data-tab="partner">${partnerLabel}</button>
          </div>
        `;
      }
      if (isMine) {
        if (openWishes.length) {
          html += `<button class="primary full add-button${wishDisabledClass}" type="button" data-action="add-wish">Добавить желание</button>`;
          html += openWishes.map((item) => wishItem(item, true)).join("");
        } else if (doneWishes.length) {
          html += `<button class="primary full add-button${wishDisabledClass}" type="button" data-action="add-wish">Добавить желание</button>`;
        } else {
          html += `
            <section class="card">
              <h3>Желание</h3>
              <p>Поделитесь идеями подарков и маленькими мечтами.</p>
              <div style="margin-top:12px;">
                <button class="primary full${wishDisabledClass}" type="button" data-action="add-wish">Добавить желание</button>
              </div>
            </section>
          `;
        }
      } else if (openWishes.length) {
        html += openWishes.map((item) => wishItem(item, false)).join("");
      } else {
        html += `
          <section class="card">
            <h3>Пока пусто</h3>
            <p>${partnerLabel === "Её" ? "Она" : "Он"} ещё не добавил${partnerLabel === "Её" ? "а" : ""} желаний в общий список.</p>
          </section>
        `;
      }
      if (doneWishes.length) {
        html += `<div class="section-head-inline"><h3>Исполненные · ${doneWishes.length}</h3></div>`;
        html += doneWishes.map((item) => completedWishItem(item, isMine)).join("");
      }
      html += archiveMoreHtml("done_wishes", (appState.completedWishes || []).length);
      html += archiveMoreHtml("wishes", (appState.wishes || []).length);
      appEl.innerHTML = html;
    } else if (currentTab === "pair") {
      appEl.innerHTML = renderPair();
      // Если активных записей больше лимита /api/state, календарь догружает
      // страницы архива в фоне и перерисовывается сам.
      ensureCalendarArchive();
    }
    mountWishSwitch();
  }

  // ------------------------------------------------------------------
  // Переключатель «Мои / партнёр»: та же капля, что в нижней панели
  // ------------------------------------------------------------------
  // Разметка переключателя перерисовывается вместе с вкладкой, поэтому
  // экземпляр живёт до следующего render(): старый снимаем в начале, новый
  // создаём в конце. Вид запоминаем, чтобы капля приезжала с прежнего места,
  // а не появлялась сразу на новом.
  let wishSwitch = null;
  let wishSwitchPrevView = null;

  function destroyWishSwitch() {
    if (!wishSwitch) return;
    wishSwitch.destroy();
    wishSwitch = null;
  }

  function mountWishSwitch() {
    const container = document.querySelector(".wish-switch");
    if (!container || !window.createLiquidNav) {
      wishSwitchPrevView = null;
      return;
    }
    const items = Array.from(container.querySelectorAll(".wish-switch-btn[data-tab]"));
    if (items.length < 2) return;
    const instance = window.createLiquidNav({
      nav: container,
      items,
      // В переключателе обычный цвет — это цвет подписи на стекле.
      idleVar: "--nav-label",
      onCommit: (view) => {
        if (view === wishView) return;
        wishView = view;
        render();
      }
    });
    if (!instance) return;
    if (wishSwitchPrevView && wishSwitchPrevView !== wishView) {
      instance.setActive(wishSwitchPrevView, false);
      instance.setActive(wishView, true);
    } else {
      instance.setActive(wishView, false);
    }
    wishSwitch = instance;
    wishSwitchPrevView = wishView;
  }

  // ------------------------------------------------------------------
  // Диалоги создания записей
  // ------------------------------------------------------------------
  function openDialog(config) {
    dialogContext = config;
    dialogTitle.textContent = config.title;
    dialogFields.innerHTML = config.fields ?? "";
    if (dialogSubmit) dialogSubmit.textContent = config.submitLabel ?? "Сохранить";
    if (dialogCancel) dialogCancel.textContent = config.cancelLabel ?? "Отмена";
    dialog.showModal();
    // Focus trap для старых WebView, которые не поддерживают нативный <dialog> focus.
    const focusables = () => Array.from(dialog.querySelectorAll('button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])')).filter(el => !el.disabled && el.offsetParent !== null);
    const first = () => focusables()[0];
    const last = () => focusables()[focusables().length - 1];
    setTimeout(() => first()?.focus(), 0);
    dialog._focusTrap = (e) => {
      if (e.key !== "Tab") return;
      const f = focusables();
      if (f.length === 0) { e.preventDefault(); return; }
      if (e.shiftKey && document.activeElement === f[0]) { e.preventDefault(); f[f.length - 1].focus(); }
      else if (!e.shiftKey && document.activeElement === f[f.length - 1]) { e.preventDefault(); f[0].focus(); }
    };
    dialog.addEventListener("keydown", dialog._focusTrap);
  }

  dialog.addEventListener("close", () => {
    if (dialog._focusTrap) { dialog.removeEventListener("keydown", dialog._focusTrap); dialog._focusTrap = null; }
  });

  function sureLabel() {
    const gender = appState?.user?.gender;
    if (gender === "female") return "Да, уверена";
    if (gender === "male") return "Да, уверен";
    return "Да, уверен(а)";
  }

  // Выход из пространства: два шага подтверждения; последний держатель
  // получает предупреждение о безвозвратном удалении данных пары.
  function confirmLeaveSpace() {
    const lastHolder = !appState.pair?.user_b;
    const label = sureLabel();
    openDialog({
      title: "Вы покидаете пространство",
      fields: `<p style="margin:2px 0 0;">${lastHolder ? "Вы последний держатель. Все данные будут удалены безвозвратно." : "Вы уверены?"}</p>`,
      submitLabel: label,
      cancelLabel: "Нет",
      onSubmit: async () => appState,
      chain: () => openDialog({
        title: "Вы точно уверены?",
        fields: "",
        submitLabel: label,
        cancelLabel: "Нет",
        onSubmit: async () => {
          appState = await request("/api/pair/leave", { method: "POST", body: {} });
          switchTab("home");
          return appState;
        }
      })
    });
  }

  let dialogSubmitting = false;
  // У планов дата обязательна, если указано время (ограничение API) — такие
  // поля time помечены data-requires-day. У значимых дат дата обязательна
  // всегда, поэтому общий обработчик их не трогает: иначе очистка времени
  // снимала бы required с даты, и форма уходила на сервер без неё.
  dialogFields.addEventListener("input", (e) => {
    const target = e.target;
    if (!(target instanceof HTMLInputElement) || target.name !== "time") return;
    if (!target.hasAttribute("data-requires-day")) return;
    const form = target.closest("form");
    const dayInput = form?.querySelector('input[name="day"]');
    if (dayInput) dayInput.required = Boolean(target.value);
  });
  dialogForm.addEventListener("submit", async (e) => {
    e.preventDefault();
    if (!dialogContext || dialogSubmitting) return;
    // Страховка к нативной проверке: required/type=date должны остановить
    // отправку до запроса к API. reportValidity показывает то же сообщение
    // браузера и работает, даже если атрибут novalidate когда-нибудь вернут.
    if (!dialogForm.reportValidity()) return;
    const submitBtn = dialogForm.querySelector('button[type="submit"]');
    dialogSubmitting = true;
    if (submitBtn) submitBtn.disabled = true;
    const formData = new FormData(dialogForm);
    try {
      appState = await dialogContext.onSubmit(formData);
      const chain = dialogContext.chain;
      dialog.close();
      render();
      // Цепочка шагов (например, повторное подтверждение выхода).
      chain?.();
    } catch (error) {
      handleRequestError(error);
    } finally {
      dialogSubmitting = false;
      if (submitBtn) submitBtn.disabled = false;
    }
  });

  // ------------------------------------------------------------------
  // Меню форматирования выделенного текста (как в Telegram): появляется
  // над текстовым полем диалога, пока в нём есть выделение. Кнопки
  // оборачивают выделение маркерами разметки (повторное нажатие снимает).
  // ------------------------------------------------------------------
  const fmtToolbar = document.getElementById("fmt-toolbar");
  function isFmtTarget(el) {
    if (!el || !el.closest?.("#dialog-fields")) return false;
    if (el instanceof HTMLTextAreaElement) return true;
    return el instanceof HTMLInputElement && (!el.type || el.type === "text");
  }
  function hideFmtToolbar() {
    if (fmtToolbar) fmtToolbar.hidden = true;
  }
  function updateFmtToolbar() {
    if (!fmtToolbar) return;
    const el = document.activeElement;
    // Выделения нет — меню не нужно; у полей не-текстового типа его тоже нет.
    if (!isFmtTarget(el) || el.selectionEnd === el.selectionStart) {
      hideFmtToolbar();
      return;
    }
    const rect = el.getBoundingClientRect();
    fmtToolbar.hidden = false;
    fmtToolbar.style.left = `${Math.round(rect.left + rect.width / 2)}px`;
    // Над полем не хватает места (верх экрана, шапка диалога или клавиатура) —
    // показываем под полем, чтобы не закрывать заголовок.
    const dialogTop = dialog?.getBoundingClientRect().top ?? 0;
    const above = rect.top - 52 >= Math.max(8, dialogTop + 8);
    fmtToolbar.classList.toggle("is-below", !above);
    fmtToolbar.style.top = `${Math.round(above ? rect.top - 8 : rect.bottom + 8)}px`;
  }
  document.addEventListener("selectionchange", updateFmtToolbar);
  // selectionchange для input/textarea есть не во всех webview (старые iOS) —
  // дублируем на событиях самого поля.
  for (const type of ["select", "keyup", "pointerup", "touchend"]) {
    dialogFields?.addEventListener(type, () => setTimeout(updateFmtToolbar, 0));
  }
  // Замена диапазона: setRangeText есть не везде (старый WKWebView), поэтому
  // собираем значение вручную — это ещё и оставляет фокус в поле.
  function replaceRange(field, text, from, to, selStart, selEnd) {
    field.value = field.value.slice(0, from) + text + field.value.slice(to);
    field.focus();
    field.setSelectionRange(selStart, selEnd);
  }
  function applyFmtMarker(field, marker) {
    const start = field.selectionStart;
    const end = field.selectionEnd;
    if (start === end) return;
    if (marker === ">") {
      // Цитата: каждой выделенной строке — префикс «> » (повтор снимает).
      const selected = field.value.slice(start, end);
      const quoted = selected.split("\n")
        .map(line => line.startsWith("> ") ? line.slice(2) : `> ${line}`)
        .join("\n");
      replaceRange(field, quoted, start, end, start, start + quoted.length);
      return;
    }
    const selected = field.value.slice(start, end);
    // Уже обёрнуто тем же маркером — снимаем разметку.
    if (field.value.slice(start - marker.length, start) === marker
      && field.value.slice(end, end + marker.length) === marker) {
      replaceRange(field, selected, start - marker.length, end + marker.length,
        start - marker.length, end - marker.length);
      return;
    }
    replaceRange(field, marker + selected + marker, start, end,
      start + marker.length, start + marker.length + selected.length);
  }
  fmtToolbar?.addEventListener("pointerdown", (e) => {
    // preventDefault: поле не теряет фокус и выделение между нажатиями.
    e.preventDefault();
    const btn = e.target.closest("[data-fmt]");
    const field = document.activeElement;
    if (btn && isFmtTarget(field)) applyFmtMarker(field, btn.dataset.fmt);
  });
  dialog?.addEventListener("close", hideFmtToolbar);

  // Спойлер в карточках раскрывается тапом (как в Telegram).
  document.addEventListener("click", (e) => {
    const spoiler = e.target.closest?.("[data-spoiler]");
    if (spoiler) spoiler.classList.toggle("is-revealed");
  });

  // Обработчики кликов
  // ------------------------------------------------------------------
  bottomNav?.addEventListener("click", (e) => {
    const btn = e.target.closest(".nav-item[data-tab]");
    if (!btn) return;
    switchTab(btn.dataset.tab);
  });

  pairButton?.addEventListener("click", () => {
    if (currentTab === "pair") {
      goBack();
      return;
    }
    switchTab("pair");
    // Партнёр мог присоединиться или выйти, пока вкладка была закрыта:
    // обновляем состояние, чтобы карточка приглашения появилась/исчезла
    // сразу, а не на следующем минутном тике.
    refreshState();
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
      } else if (action === "calendar-prev") {
        shiftCalendarMonth(-1);
      } else if (action === "calendar-next") {
        shiftCalendarMonth(1);
      } else if (action === "calendar-day") {
        selectCalendarDay(btn.dataset.day);
      } else if (action === "show-in-calendar") {
        // Переход к месяцу события из списка: выбираем день и открываем
        // вкладку календаря. Состояние задаём напрямую — промежуточный
        // render() текущей вкладки не нужен.
        const day = btn.dataset.day || "";
        if (/^\d{4}-\d{2}-\d{2}$/.test(day)) {
          const [year, month] = day.split("-").map(Number);
          calendarMonth = { year, month };
          calendarSelected = day;
        }
        switchTab("pair");
      } else if (action === "go-tab") {
        switchTab(btn.dataset.tab || "home");
      } else if (action === "create-pair") {
        appState = await request("/api/pair/create", { method: "POST", body: {} });
        switchTab("home");
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
            <label class="field"><span>Время (необязательно)</span><input type="time" name="time" data-requires-day></label>
            <label class="field"><span><input type="checkbox" name="is_private"> Личный — партнёр не увидит, в уведомлениях будет «Скрытый»</span></label>
          `,
          onSubmit: (fd) => request("/api/tasks", { method: "POST", body: { title: fd.get("title"), day: fd.get("day"), time: fd.get("time"), is_private: fd.get("is_private") === "on" } })
        });
      } else if (action === "add-date") {
        openDialog({
          title: "Значимая дата",
          fields: `
            <label class="field"><span>Название</span><input name="title" maxlength="120" required placeholder="День нашего знакомства"></label>
            <label class="field"><span>Дата</span><input type="date" name="day" required></label>
            <label class="field"><span>Время (необязательно)</span><input type="time" name="time"></label>
            <label class="field"><span><input type="checkbox" name="is_private"> Личная — партнёр не увидит эту дату</span></label>
          `,
          onSubmit: (fd) => request("/api/dates", { method: "POST", body: { title: fd.get("title"), day: fd.get("day"), time: fd.get("time"), recurs: true, is_private: fd.get("is_private") === "on" } })
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
          fields: `<label class="field"><span>О чём мечтаете?</span><input name="body" maxlength="300" required placeholder="Плёночный фотоаппарат"></label>
           <label class="field"><span>Ссылка (необязательно)</span><input name="url" type="url" placeholder="https://example.com"></label>`,
          onSubmit: (fd) => request("/api/wishes", { method: "POST", body: { body: fd.get("body"), url: fd.get("url") } })
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
        const typeNames = { tasks: "план", dates: "дату", memories: "запись", wishes: "желание" };
        if (!confirm(`Удалить ${typeNames[btn.dataset.type] || "запись"}? Это действие нельзя отменить.`)) return;
        appState = await request(`/api/${btn.dataset.type}/${btn.dataset.id}`, { method: "DELETE" });
        // Из appState удалённая запись уходит сразу, но в кэше архива она
        // осталась бы и продолжала отображаться (и повторное удаление дало бы 404).
        removeFromArchiveCache(btn.dataset.type, btn.dataset.id);
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
          // Чекбокс приватности — только автору плана (зеркально датам).
          const ownsPrivacy = Number(item.created_by) === Number(appState.user.tg_id);
          openDialog({
            title: "Редактировать план",
            fields: `
              <label class="field"><span>Что запланируем?</span><input name="title" maxlength="180" required value="${esc(item.title || "")}"></label>
              <label class="field"><span>Дата (необязательно)</span><input type="date" name="day" value="${esc(item.day || "")}"></label>
              <label class="field"><span>Время (необязательно)</span><input type="time" name="time" value="${esc(item.time || "")}" data-requires-day></label>
              ${ownsPrivacy ? `<label class="field"><span><input type="checkbox" name="is_private" ${item.is_private ? "checked" : ""}> Личный — партнёр не увидит, в уведомлениях будет «Скрытый»</span></label>` : ""}
            `,
            onSubmit: async (fd) => {
              const body = { title: fd.get("title"), day: fd.get("day"), time: fd.get("time"), is_private: ownsPrivacy ? fd.get("is_private") === "on" : undefined };
              const state = await request(`/api/tasks/${id}`, { method: "PATCH", body });
              patchArchiveItem("tasks", id, body);
              return state;
            }
          });
        } else if (type === "dates") {
          // Чекбокс приватности видит только автор: партнёр чужую дату
          // «личной» сделать не может, сервер его флаг всё равно игнорирует.
          const ownsPrivacy = Number(item.created_by) === Number(appState.user.tg_id);
          openDialog({
            title: "Редактировать дату",
            fields: `
              <label class="field"><span>Название</span><input name="title" maxlength="120" required value="${esc(item.title || "")}"></label>
              <label class="field"><span>Дата</span><input type="date" name="day" required value="${esc(item.day || "")}"></label>
              <label class="field"><span>Время (необязательно)</span><input type="time" name="time" value="${esc(item.time || "")}"></label>
              <label class="field"><span><input type="checkbox" name="recurs" ${item.recurs ? "checked" : ""}> Повторять ежегодно</span></label>
              ${ownsPrivacy ? `<label class="field"><span><input type="checkbox" name="is_private" ${item.is_private ? "checked" : ""}> Личная — партнёр не увидит эту дату</span></label>` : ""}
            `,
            onSubmit: (fd) => request(`/api/dates/${id}`, { method: "PATCH", body: { title: fd.get("title"), day: fd.get("day"), time: fd.get("time"), recurs: fd.get("recurs") === "on", is_private: ownsPrivacy ? fd.get("is_private") === "on" : undefined } })
          });
        } else if (type === "memories") {
          openDialog({
            title: "Редактировать запись",
            fields: `<label class="field"><span>Воспоминание</span><textarea name="body" rows="4" maxlength="2000" required>${esc(item.body || "")}</textarea></label>`,
            onSubmit: async (fd) => {
              const body = { body: fd.get("body") };
              const state = await request(`/api/memories/${id}`, { method: "PATCH", body });
              patchArchiveItem("memories", id, body);
              return state;
            }
          });
        } else if (type === "wishes") {
          openDialog({
            title: "Редактировать желание",
            fields: `<label class="field"><span>О чём мечтаете?</span><input name="body" maxlength="300" required value="${esc(item.body || "")}"></label>
           <label class="field"><span>Ссылка (необязательно)</span><input name="url" type="url" placeholder="https://example.com" value="${esc(item.url || "")}"></label>`,
            onSubmit: async (fd) => {
              const body = { body: fd.get("body") };
              if (fd.get("url") !== undefined) body.url = fd.get("url");
              const state = await request(`/api/wishes/${id}`, { method: "PATCH", body });
              patchArchiveItem("wishes", id, body);
              return state;
            }
          });
        }
      } else if (action === "open-url") {
        openExternal(btn.dataset.url);
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
      } else if (action === "copy-link") {
        const code = btn.dataset.code || "";
        const link = `https://t.me/${appState?.pair?.bot_username || "duoplanbot"}?start=${encodeURIComponent(code)}`;
        if (navigator.clipboard?.writeText) {
          try {
            await navigator.clipboard.writeText(link);
            showToast("Ссылка скопирована");
          } catch (error) {
            showToast(link);
          }
        } else {
          showToast(link);
        }
      } else if (action === "leave-pair") {
        confirmLeaveSpace();
      } else if (action === "wish-view") {
        wishView = btn.dataset.view === "partner" ? "partner" : "mine";
        render();
      } else if (action === "load-archive") {
        await loadArchivePage(btn.dataset.type, btn);
      } else if (action === "set-accent") {
        appState = await request("/api/settings", { method: "POST", body: { accent_color: btn.dataset.accent || null } });
        render();
      } else if (action === "save-settings") {
        const timeOf = (id) => {
          const value = document.getElementById(id)?.value || "";
          return /^([01]\d|2[0-3]):[0-5]\d$/.test(value) ? value : null;
        };
        appState = await request("/api/settings", {
          method: "POST",
          body: {
            digest_enabled: document.getElementById("digest-enabled")?.checked ?? true,
            digest_time: timeOf("digest-time"),
            dates_digest_enabled: document.getElementById("dates-digest-enabled")?.checked ?? true,
            dates_digest_time: timeOf("dates-digest-time")
          }
        });
        showToast("Настройки сохранены");
        render();
      } else if (action === "export-diary") {
        btn.disabled = true;
        try {
          await request("/api/diary/export", { method: "POST", body: {} });
          showToast("Дневник выслан сообщениями от бота");
        } finally {
          btn.disabled = false;
        }
      } else if (action === "set-gender") {
        appState = await request("/api/gender", { method: "POST", body: { gender: btn.dataset.gender } });
        render();
      }
    } catch (error) {
      handleRequestError(error);
    }
  });

  function deepEqual(a, b) {
    if (a === b) return true;
    if (a == null || b == null) return a === b;
    if (typeof a !== typeof b) return false;
    if (typeof a !== "object") return false;
    const aIsArr = Array.isArray(a), bIsArr = Array.isArray(b);
    if (aIsArr !== bIsArr) return false;
    if (aIsArr) {
      if (a.length !== b.length) return false;
      for (let i = 0; i < a.length; i++) if (!deepEqual(a[i], b[i])) return false;
      return true;
    }
    const aKeys = Object.keys(a).sort();
    const bKeys = Object.keys(b).sort();
    if (aKeys.length !== bKeys.length) return false;
    for (let i = 0; i < aKeys.length; i++) {
      const k = aKeys[i];
      if (k !== bKeys[i] || !deepEqual(a[k], b[k])) return false;
    }
    return true;
  }

  let refreshInProgress = false;
  async function refreshState() {
    if (sessionExpired || refreshInProgress) return;
    if (dialog?.open) return;
    // Пользователь печатает (код приглашения в онбординге) — тик пропускаем
    // целиком, данные придут снова на следующем тике после ухода фокуса.
    const isTyping = () => document.activeElement instanceof HTMLInputElement
      || document.activeElement instanceof HTMLTextAreaElement;
    if (isTyping()) return;
    // Жест по капле в разгаре: перерисовка пересоздала бы переключатель и
    // оборвала движение. Пропускаем тик — данные придут на следующем.
    if (liquidNav?.getState?.().dragging || wishSwitch?.getState?.().dragging) return;
    refreshInProgress = true;
    try {
      const next = await request("/api/state");
      // Фокус могли включить, пока запрос летел, — тогда данные не забираем,
      // чтобы не потерять изменение для следующего тика.
      if (isTyping()) return;
      // Данные не изменились — перерисовка не нужна: она сбрасывает ввод,
      // выделение текста и фокус.
      const unchanged = deepEqual(next, appState);
      appState = next;
      if (unchanged) return;
      // Изменение мог сделать и партнёр: его удаления, правки и «сделать
      // личной» не проходят через локальные кэш-патчи. Сразу показываем новое
      // состояние, параллельно перезагружаем страницы архива и доснимаем
      // вторым рендером.
      const revalidated = revalidateArchiveCache();
      render();
      await revalidated;
      render();
    } catch (error) {
      // Сетевые ошибки глотаем, как и раньше: фон не должен прерывать работу.
      // Истёкшая сессия — отдельный случай: сообщаем явно, а не молчим.
      if (error?.status === 401) handleRequestError(error);
    } finally {
      refreshInProgress = false;
    }
  }

  setInterval(() => {
    // В IAB Telegram document.visibilityState может постоянно быть "hidden":
    // гейт «visible» останавливал бы минутную синхронизацию навсегда, и
    // изменения партнёра доезжали бы только при действии пользователя.
    // В Telegram тик идёт всегда — лишние прогоны гасят refreshInProgress,
    // deepEqual и фокус-гейты внутри refreshState; в обычном браузере тик,
    // как и раньше, только на видимой вкладке.
    if (tg || document.visibilityState === "visible") refreshState();
  }, 60000);

  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") refreshState();
  });

  if (tg?.BackButton?.onClick) tg.BackButton.onClick(goBack);

  // Инициализация — вызываем один раз при старте
  // и при нажатии кнопки «Повторить» при ошибке.
  async function initApp() {
    // Защита от нескольких одновременных запусков
    if (window.__duoplanInitInProgress) return;
    window.__duoplanInitInProgress = true;

    try {
      appState = await request("/api/state");
      render();
      updateDroplet("home", false);
      // Успешная загрузка — сбрасываем состояние ошибки
      sessionExpired = false;
    } catch (error) {
      // Сетевые ошибки и истекшие сессии показываем карточку с кнопкой повторной загрузки
      if (error?.status === 401) {
        sessionExpired = true;
        appEl.innerHTML = `
          ${renderTabHeader("home")}
          <section class="card">
            <h3>Сессия истекла</h3>
            <p>Токен авторизации Telegram истек. <a href="#" id="reauth-link" class="secondary">Переоткрыть приложение</a></p>
            <button id="retry-btn" class="primary" style="display:block;margin:16px auto 0;max-width:260px;">Повторить загрузку</button>
          </section>
        `;
        document.getElementById("retry-btn").addEventListener("click", () => {
          window.__duoplanInitInProgress = false;
          initApp();
        });
        document.getElementById("reauth-link").addEventListener("click", (e) => {
          e.preventDefault();
          tg?.initData && location.reload();
        });
      } else {
        appEl.innerHTML = `
          ${renderTabHeader("home")}
          <section class="card">
            <h3>Не удалось загрузить пространство</h3>
            <p>${esc(error.message)}</p>
            <button id="retry-btn" class="primary" style="display:block;margin:16px auto 0;max-width:260px;">Повторить загрузку</button>
          </section>
        `;
        document.getElementById("retry-btn").addEventListener("click", () => {
          window.__duoplanInitInProgress = false;
          initApp();
        });
      }
    } finally {
      window.__duoplanInitInProgress = false;
    }
  }

  // Точка входа инициализации — одна попытка
  initApp();
})();
