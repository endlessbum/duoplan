(() => {
  const tg = window.Telegram?.WebApp;
  const appEl = document.getElementById("app");
  const bottomNav = document.getElementById("bottom-nav");
  const navDroplet = document.getElementById("nav-droplet");
  const navButtons = Array.from(document.querySelectorAll(".nav-item[data-tab]"));
  const pairButton = document.getElementById("pair-button");
  const avatarA = document.getElementById("avatar-a");
  const avatarB = document.getElementById("avatar-b");
  const homeScreenButton = document.getElementById("homescreen-button");
  const dialog = document.getElementById("item-dialog");
  const dialogForm = document.getElementById("item-form");

  // Очищаем контекст диалога при любом закрывании (Escape, backdrop, programmatic).
  // Гард dialog.open обязателен: close-событие от предыдущего close() прилетает
  // из отдельной задачи и обнулял контекст УЖЕ ОТКРЫТОГО следующего диалога
  // цепочки — сабмит второго шага («Вы точно уверены?») молча умирал на гейте
  // !dialogContext, и выйти из пространства было невозможно (репорт 2026-11-01).
  dialog.addEventListener("close", () => {
    if (dialog.open) return;
    dialogContext = null;
    // Страница за диалогом снова скроллится.
    document.documentElement.classList.remove("dialog-locked");
  });
  const dialogTitle = document.getElementById("dialog-title");
  const dialogFields = document.getElementById("dialog-fields");
  const dialogSubmit = document.getElementById("dialog-submit");
  const dialogCancel = document.getElementById("dialog-cancel");
  const toastEl = document.getElementById("toast");

  // Пять слотов дока: «Желания» переехали в «Нашу пару» (переключатель
  // «Профиль / Желания»), «Цитаты» — в «Дневник», «Дни рождения» — в «Даты».
  // Так бар остаётся прежней геометрии: капля и линза рассчитаны на 5 слотов.
  const TAB_ORDER = ["home", "tasks", "dates", "places", "memories"];
  const TAB_META = {
    home: { title: "Наше пространство" },
    tasks: { title: "Наши планы", sub: "Общие дела, свидания и идеи" },
    dates: { title: "Даты", sub: "Значимые дни и дни рождения" },
    places: { title: "Места", sub: "Куда сходить вместе" },
    memories: { title: "Дневник", sub: "Записи и цитаты" },
    pair: { title: "Наша пара", sub: "Профиль, желания и настройки" }
  };

  let appState = null;
  let currentTab = "home";
  let wishView = "mine"; // "mine" | "partner" — переключатель вишлиста
  // Виды внутри вкладок: «Наша пара» (профиль/желания), «Даты»
  // (наше/дни рождения), «Дневник» (записи/цитаты). Живут вне рендера, чтобы
  // минутный refresh и возврат на вкладку не сбрасывали выбранный вид.
  let pairView = "profile";
  let datesView = "dates";
  let memoriesView = "memories";
  // «Планы / Кино» — виды вкладки «Планы».
  let tasksView = "plans";
  // «В планах / Просмотрено» — виды сегмента «Кино» и их сортировки.
  let moviesView = "open";
  // «Рандом» мест: колода id и текущий выпавший. Живут вне рендера, чтобы
  // карточка результата переживала минутный refresh, а колода не начиналась
  // заново после каждой отметки посещения.
  let placeDeck = [];
  let placePickId = null;
  // Тот же рандом для «Кино» — своя колода, чтобы посещение места не
  // сбрасывало выбор фильмов и наоборот.
  let movieDeck = [];
  let moviePickId = null;
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
  // Последний выбранный акцент — локально, без ожидания /api/state: кружок
  // загрузки при следующем запуске красится в акцент сразу, а не в berry.
  const ACCENT_KEY = "duoplan.accent";
  function storedAccent() {
    try {
      const value = localStorage.getItem(ACCENT_KEY);
      return ACCENT_PALETTES[value] ? value : "";
    } catch { return ""; }
  }
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
    // При старте state ещё не загружен: берём последний выбор из localStorage,
    // чтобы анимация загрузки (кружок над «Открываем ваше пространство…») была
    // в акценте пользователя, а не стандартном berry.
    const key = appState?.user?.accent_color || storedAccent() || "berry";
    if (appState?.user) {
      // Запоминаем актуальный выбор: спиннер следующего запуска стартует в нём.
      try { localStorage.setItem(ACCENT_KEY, key); } catch {}
    }
    // Свотчи в настройках показывают актуальный для темы вариант палитры:
    // в тёмной теме светлый образец выглядел темнее фактического акцента.
    // Синхронизация здесь — applyAccent вызывается и из applyTheme
    // (themeChanged), и из render().
    document.querySelectorAll(".swatch[data-accent]").forEach((el) => {
      const palette = ACCENT_PALETTES[el.dataset.accent];
      if (palette) el.style.background = palette[dark ? "dark" : "light"];
    });
    const names = ["--berry", "--berry-dark", "--berry-soft", "--droplet-border", "--droplet-halo"];
    const hex = ACCENT_PALETTES[key]?.[dark ? "dark" : "light"];
    // Палитра капли (цвет подписей) читается из CSS-переменных только в
    // refresh(): хук обязан сработать ПОСЛЕ установки переменных, иначе бары
    // видят старый акцент до перезапуска. Обе ветки выхода завершаются хуком.
    const finish = () => { applyAvatarColors(); navRefreshHook?.(); };
    if (key === "berry" || !hex) {
      for (const name of names) root.style.removeProperty(name);
      finish();
      return;
    }
    const rgb = hexRgb(hex);
    const rgba = (alpha) => `rgba(${rgb[0]}, ${rgb[1]}, ${rgb[2]}, ${alpha})`;
    root.style.setProperty("--berry", hex);
    root.style.setProperty("--berry-dark", shadeHex(hex, 0.82));
    root.style.setProperty("--berry-soft", rgba(dark ? 0.18 : 0.14));
    root.style.setProperty("--droplet-border", dark ? "rgba(255, 255, 255, 0.16)" : rgba(0.24));
    root.style.setProperty("--droplet-halo", rgba(dark ? 0.30 : 0.22));
    finish();
  }

  // Аватары в кнопке пары: у каждого — свой выбранный акцент. Мой цвет — из
  // appState.user, цвет партнёра — из appState.pair.partner_accent (workers
  // state(): users.accent_color). Когда один партнёр меняет акцент, у второго
  // его аватар перекрашивается при следующем обновлении данных — синхронно.
  // themeChanged тоже проходит здесь: applyAccent → applyAvatarColors.
  function paintAvatar(el, key) {
    if (!el) return;
    const dark = document.documentElement.dataset.theme === "dark";
    const hex = key && ACCENT_PALETTES[key]?.[dark ? "dark" : "light"];
    if (!hex) {
      // Нет палитры — возвращаем дефолт из CSS (убираем инлайн-стили).
      // Только background-color: shorthand background стёр бы background-image
      // с фото профиля (paintAvatarSlot), а themeChanged приходит без render().
      el.style.removeProperty("background-color");
      el.style.removeProperty("color");
      return;
    }
    const rgb = hexRgb(hex);
    el.style.backgroundColor = `rgba(${rgb.join(", ")}, ${dark ? 0.18 : 0.14})`;
    el.style.color = hex;
  }

  function applyAvatarColors() {
    const myAccent = appState?.user?.accent_color || "berry";
    const partnerKey = appState?.pair?.partner_accent || "";
    // Слева аватар владельца (name1, role a), справа — партнёра (name2).
    // Если я role b — аватар слева это партнёр, справа я сам.
    const iAmOwner = appState?.pair?.role !== "b";
    paintAvatar(avatarA, iAmOwner ? myAccent : partnerKey);
    paintAvatar(avatarB, iAmOwner ? partnerKey : myAccent);
  }

  // Фото профиля Telegram вместо буквы: ссылка приходит из state (pair.photo1/
  // photo2 и user.photo_url) и всегда свежая — ensureUser обновляет её из
  // initData при каждом открытии приложения. Переключатель «Отображение
  // аватара» выключает фото для всех аватаров, которые видит владелец
  // настройки; буква-фолбэк остаётся тем, у кого фото в Telegram нет.
  function paintAvatarSlot(el, name, fallback, photoUrl) {
    if (!el) return;
    const showPhoto = appState?.user?.show_avatar !== false
      && typeof photoUrl === "string"
      && /^https:\/\//.test(photoUrl);
    if (showPhoto) {
      el.classList.add("has-photo");
      el.style.backgroundImage = `url("${esc(photoUrl)}")`;
      el.textContent = "";
    } else {
      el.classList.remove("has-photo");
      el.style.backgroundImage = "";
      el.textContent = firstLetter(name, fallback);
    }
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
    // Выбранная тема перекрывает системную: "dark"/"light" форсируются.
    const pref = themePref();
    const scheme = pref === "system"
      ? (tg?.colorScheme || (window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light"))
      : pref;
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
  // Пароль на вход: 4 цифры, хранится только на этом устройстве.
  const PIN_KEY = "duoplan.pin";
  let appUnlocked = false;
  function storedPin() {
    try {
      const value = String(localStorage.getItem(PIN_KEY) || "");
      return /^\d{4}$/.test(value) ? value : "";
    } catch { return ""; }
  }
  // Предпочтение темы: "system" | "dark" | "light" (по умолчанию — как в системе).
  const THEME_KEY = "duoplan.theme";
  function themePref() {
    try {
      const value = localStorage.getItem(THEME_KEY);
      return value === "dark" || value === "light" ? value : "system";
    } catch { return "system"; }
  }
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

  // Даты всегда в виде дд.мм.гггг, независимо от ISO-хранения в базе.
  function formatDay(value) {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(value ?? ""));
    return m ? `${m[3]}.${m[2]}.${m[1]}` : String(value ?? "");
  }

  // Unix timestamp (seconds) → дд.мм.гггг
  function formatTimestamp(ts) {
    const n = Number(ts);
    if (!Number.isFinite(n) || n <= 0) return "";
    const d = new Date(n * 1000);
    const day = String(d.getDate()).padStart(2, "0");
    const month = String(d.getMonth() + 1).padStart(2, "0");
    const year = d.getFullYear();
    return `${day}.${month}.${year}`;
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

  // Смена темы/акцента перечитывает цвета вкладок внутри nav.js —
  // и в главном баре, и в переключателе вишлиста.
  navRefreshHook = () => {
    liquidNav?.refresh();
    segSwitch?.refresh();
    wishSwitch?.refresh();
  };

  // ------------------------------------------------------------------
  // Встроенная шапка вкладки (прямо над элементами на странице)
  // ------------------------------------------------------------------
  function renderTabHeader(tabKey) {
    const meta = TAB_META[tabKey] || TAB_META.home;
    const pair = appState?.pair;
    let subtitle = meta.sub || "";
    if (tabKey === "home" && pair) {
      // Только имена: очки пары уже показывает карточка ниже — дублировать
      // их в подзаголовке незачем.
      subtitle = pair.user_b ? `${pair.name1} и ${pair.name2}` : `${pair.name1} · ожидание партнёра`;
    }
    return `
      <header class="tab-header">
        <h1 class="tab-header-title">${esc(meta.title)}</h1>
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
    const role = pair.role === "b" ? "b" : "a";
    // Моё фото — user.photo_url (если я владелец — слот A, иначе слот B),
    // фото партнёра — соответствующий photo1/photo2 из state.
    paintAvatarSlot(avatarA, pair.name1, "А", role === "a" ? appState.user.photo_url : pair.photo1);
    paintAvatarSlot(avatarB, pair.name2, "Б", pair.user_b ? (role === "b" ? appState.user.photo_url : pair.photo2) : null);
    if (!pair.user_b) avatarB.textContent = "+";
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

  // Ближайшее ежемесячное наступление: первый месяц, где день существует
  // и локальная дата не раньше сегодняшней (зеркало worker.nextMonthlyOccurrenceMs).
  function monthlyNext(day, time) {
    const parts = String(day || "").split("-");
    if (parts.length !== 3) return null;
    const dayOfMonth = Number(parts[2]);
    if (!Number.isFinite(dayOfMonth) || dayOfMonth < 1 || dayOfMonth > 31) return null;
    const tz = pairTimeZone();
    let hours = 12, minutes = 0;
    if (time && /^\d{2}:\d{2}$/.test(time)) {
      const [hh, mm] = String(time).split(":").map(Number);
      if (Number.isFinite(hh) && Number.isFinite(mm)) { hours = hh; minutes = mm; }
    }
    const now = new Date();
    const startY = Number(new Intl.DateTimeFormat("en-US", { timeZone: tz, year: "numeric" }).format(now));
    const startM = Number(new Intl.DateTimeFormat("en-US", { timeZone: tz, month: "2-digit" }).format(now));
    const keyFmt = new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" });
    const dayFmt = new Intl.DateTimeFormat("en-US", { timeZone: tz, month: "2-digit", day: "2-digit" });
    const todayKey = keyFmt.format(now);
    for (let offset = 0; offset < 25; offset++) {
      const absolute = startM - 1 + offset;
      const year = startY + Math.floor(absolute / 12);
      const month = absolute % 12;
      const candidate = makeDateInTimeZone(year, month, dayOfMonth, hours, minutes, tz);
      const cp = dayFmt.formatToParts(candidate);
      const cm = Number(cp.find((q) => q.type === "month")?.value);
      const cd = Number(cp.find((q) => q.type === "day")?.value);
      if (cm !== month + 1 || cd !== dayOfMonth) continue;
      if (keyFmt.format(candidate) >= todayKey) return candidate;
    }
    return null;
  }

  // Какой повтор у записи: "month" | "year" | null.
  function taskRepeat(item) {
    if (Number(item?.monthly) === 1) return "month";
    if (Number(item?.yearly) === 1) return "year";
    return null;
  }

  // Ближайшее ежегодное наступление плана (29 февраля пропускается).
  function yearlyNext(day, time) {
    const tz = pairTimeZone();
    const today = zonedToday(tz);
    const currentYear = Number(new Intl.DateTimeFormat("en-US", { timeZone: tz, year: "numeric" }).format(new Date()));
    for (let year = currentYear; year <= currentYear + 8; year++) {
      const candidate = annualDate(day, year, time);
      if (candidate && candidate >= today) return candidate;
    }
    return annualDate(day, currentYear, time);
  }

  function planTarget(day, time, repeat = null) {
    if (!day) return null;
    if (repeat === "month") return monthlyNext(day, time);
    if (repeat === "year") return yearlyNext(day, time);
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
    const decorated = rows.map((row) => ({ row, at: planTarget(row.day, row.time, taskRepeat(row))?.getTime() ?? Infinity }));
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
    if (Number(item.monthly) === 1) return monthlyNext(item.day, item.time);
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

  function countdownChip(day, time, repeat = null) {
    const target = planTarget(day, time, repeat);
    if (!target) return "";
    const diff = target.getTime() - Date.now();
    // Repeat кодируется в атрибуте: 30-секундный тик пересобирает чип из него
    // и не теряет ежемесячный/ежегодный контекст (иначе чип «мигал» просрочкой).
    const ctx = `${esc(day)}|${esc(time || "")}|${repeat || ""}`;
    if (diff <= 0) {
      const stale = -diff > 7 * 86400000;
      return `<span class="day-chip is-overdue${stale ? " is-stale" : ""}" data-countdown="${ctx}">Время пришло</span>`;
    }
    const hours = Math.floor(diff / 3600000);
    const mins = Math.max(1, Math.floor((diff % 3600000) / 60000));
    if (hours < 24) {
      const label = hours > 0 ? `Через ${hours} ч ${mins} мин` : `Через ${mins} мин`;
      return `<span class="day-chip is-countdown" data-countdown="${ctx}">${esc(label)}</span>`;
    }
    const days = Math.ceil(diff / 86400000);
    return `<span class="day-chip" data-countdown="${ctx}">Через ${days} дн.</span>`;
  }

  function refreshCountdowns() {
    if (dialog?.open) return;
    document.querySelectorAll("[data-countdown]").forEach((node) => {
      const raw = node.getAttribute("data-countdown") || "";
      if (raw.includes("|")) {
        const [day, time, repeat] = raw.split("|");
        const wrapper = document.createElement("span");
        wrapper.innerHTML = countdownChip(day, time, repeat || null);
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
  // Экран блокировки: спрашивает 4-значный пароль, если он задан в настройках.
  // Обёртка .lock-wrap центрирует карточку по середине окна (item 58).
  function renderLock() {
    return `
      <div class="lock-wrap">
        <section class="card lock-card">
          <p class="eyebrow">DuoPlan заблокирован</p>
          <h2>Введите пароль</h2>
          <form id="lock-form" style="margin-top:14px; display:grid; gap:10px;">
            ${pinField("lock-pin")}
            <button class="primary full" type="submit">Войти</button>
          </form>
          <p class="settings-hint" id="lock-error" style="color:var(--berry);" hidden>Неверный пароль. Попробуйте ещё раз.</p>
        </section>
      </div>
    `;
  }

  function mountLock() {
    document.getElementById("lock-form")?.addEventListener("submit", (e) => {
      e.preventDefault();
      const value = document.getElementById("lock-pin")?.value?.trim() || "";
      if (value !== storedPin()) {
        // Без тайм-аутов: просто повторная попытка.
        const error = document.getElementById("lock-error");
        if (error) error.hidden = false;
        const input = document.getElementById("lock-pin");
        if (input) { input.value = ""; renderPinCells(input); input.focus(); }
        return;
      }
      appUnlocked = true;
      // Состояние ещё не загружено: initApp вышел ранним выходом за замком.
      // Полная инициализация грузит /api/state и рендерит пространство.
      initApp();
    });
    setTimeout(() => {
      mountPinFields();
      document.getElementById("lock-pin")?.focus();
    }, 50);
  }

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
        <div style="margin-top:18px; display:grid; gap:10px;">
          <button class="primary full" type="button" data-action="create-pair">Создать пространство</button>
        </div>
      </section>
      <section class="card">
        <p class="eyebrow">Вход по коду</p>
        <h3>Добавить партнёра по коду</h3>
        <label class="field"><span>Код партнёра (8 символов)</span><input id="join-code-home" maxlength="8" placeholder="Введите 8-значный код"></label>
        <button class="secondary full card-action" type="button" data-action="join-code" data-input="join-code-home">Войти по коду партнёра</button>
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
          <div style="margin-top:18px;">
            <button class="primary full" type="button" data-action="go-tab" data-tab="pair">Наша пара</button>
          </div>
        </section>
      `;
    }
    const ritualBlock = pair.user_b && daily ? `
      <section class="card">
        <p class="eyebrow">Ритуал дня</p>
        <h3>${esc(daily.action)}</h3>
        <p>${daily.done ? `Вы отметили ритуал +10 XP${daily.partnerDone ? " · партнёр тоже отметил" : ""}` : (daily.partnerDone ? "Партнёр уже отметил ритуал — отметьте и вы" : "Отметьте ритуал дня и получите +10 XP.")}</p>
        ${daily.done ? "" : `<div style="margin-top:18px;"><button class="primary full" type="button" data-action="daily-done">Мы сделали это +10 XP</button></div>`}
      </section>
    ` : "";

    const previewTasks = sortByTaskDeadline(tasks).slice(0, 3).map(taskItem).join("");
    // Порядок дат приходит отсортированным из /api/state — повторно не сортируем.
    // На главной каждая группа — не больше трёх карточек, остальное за «Все →».
    // День рождения показываем своей карточкой: без года и с «через N дней».
    const previewDates = dates.slice(0, 3)
      .map((item) => (item.kind === "birthday" ? birthdayItem(item) : dateItem(item)))
      .join("");
    const latestMemory = memories[0];

    return `
      ${renderTabHeader("home")}
      <section class="card hero-card">
        <p class="eyebrow">${pair.user_b ? "Ваша история" : "Ожидание партнёра"}</p>
        <h2>${pair.user_b ? `${esc(pair.name1)} и ${esc(pair.name2)}` : `Код пары: ${esc(pair.code)}`}</h2>
        <p>${pair.user_b ? `Начало истории: ${esc(formatDay(pair.started_at))}` : "Отправьте код партнёру, чтобы открыть ритуалы дня и общее пространство."}</p>
        <div class="stats-row">
          <span class="stat-pill">${FLAME_ICON} Серия ${user.streak || 0} дн.</span>
          <span class="stat-pill">${user.points || 0} XP</span>
          <span class="stat-pill">Вместе ${pair.together_pts || 0} XP</span>
        </div>
      </section>

      ${ritualBlock}

      ${previewTasks ? `
      <div class="section-head-inline">
        <h3>Ближайшие планы</h3>
      </div>
      ${previewTasks}
      ` : ""}

      ${previewDates ? `
      <div class="section-head-inline">
        <h3>Значимые даты</h3>
      </div>
      ${previewDates}
      ` : ""}

      ${latestMemory ? `
        <div class="section-head-inline">
          <h3>Из дневника</h3>
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
              <div class="item-when">
                ${item.is_private
                  ? `<div class="item-when-line"><span class="day-chip is-private">Личное</span>${item.day ? `<span>${esc(formatDay(item.day))}${item.time ? ` · ${esc(item.time)}` : ""}</span>` : ""}</div>`
                  : item.day ? `<span>${esc(formatDay(item.day))}${item.time ? ` · ${esc(item.time)}` : ""}</span>` : ""}
                <div class="item-when-row">
                  ${countdownChip(item.day, item.time, taskRepeat(item))}
                  ${item.day ? `<button class="link-btn" type="button" data-action="show-in-calendar" data-day="${esc(item.day)}" aria-label="Показать в календаре">В календаре</button>` : ""}
                </div>
              </div>
            </div>
          </div>
          <div class="item-actions">
            <button class="icon-btn" type="button" data-action="done-item" data-type="tasks" data-id="${item.id}" aria-label="Выполнено">${DONE_ICON}</button>
            <button class="icon-btn" type="button" data-action="edit-item" data-type="tasks" data-id="${item.id}" aria-label="Редактировать">${EDIT_ICON}</button>
            <button class="icon-btn" type="button" data-action="delete-item" data-type="tasks" data-id="${item.id}" aria-label="Удалить">${DELETE_ICON}</button>
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
    const whenText = `<span>${esc(formatDay(item.day))}${item.time ? ` · ${esc(item.time)}` : ""}${Number(item.monthly) === 1 ? " · Ежемесячно" : item.recurs ? " · Ежегодно" : ""}</span>`;
    return `
      <article class="card">
        <div class="item-row">
          <div class="item-main">
            <h3 class="item-title">${renderRichText(item.title)}</h3>
            <div class="item-meta">
              <div class="item-when">
                ${item.is_private ? `<div class="item-when-line"><span class="day-chip is-private">Личное</span>${whenText}</div>` : whenText}
                <div class="item-when-row">
                  ${chip}
                  <button class="link-btn" type="button" data-action="show-in-calendar" data-day="${esc(item.day)}" aria-label="Показать в календаре">В календаре</button>
                </div>
              </div>
            </div>
          </div>
          <div class="item-actions">
            <button class="icon-btn" type="button" data-action="edit-item" data-type="dates" data-id="${item.id}" aria-label="Редактировать">${EDIT_ICON}</button>
            <button class="icon-btn" type="button" data-action="delete-item" data-type="dates" data-id="${item.id}" aria-label="Удалить">${DELETE_ICON}</button>
          </div>
        </div>
      </article>
    `;
  }

  function memoryItem(item) {
    // Карточка кликабельна целиком (open-memory): в списке видно несколько
    // строк (line-clamp в CSS), полный текст — в диалоге чтения.
    return `
      <article class="card memory-card" data-action="open-memory" data-id="${item.id}" role="button" tabindex="0" aria-label="Открыть запись дневника">
        <div class="item-row">
          <div class="item-main">
            ${item.title ? `<h3 class="item-title">${renderRichText(item.title)}</h3>` : ""}
            <p class="memory-body">${renderRichText(item.body)}</p>
            <div class="item-meta">
              <span class="memory-author">${esc(item.display_name || "Партнёр")}</span>
              <span>· ${esc(formatDay(item.day))}</span>
            </div>
          </div>
          <div class="item-actions">
            <button class="icon-btn" type="button" data-action="edit-item" data-type="memories" data-id="${item.id}" aria-label="Редактировать">${EDIT_ICON}</button>
            <button class="icon-btn" type="button" data-action="delete-item" data-type="memories" data-id="${item.id}" aria-label="Удалить">${DELETE_ICON}</button>
          </div>
        </div>
      </article>
    `;
  }

  function wishItem(item, editable = true) {
    const canEdit = editable && item.owner_id === appState.user.tg_id;
    const actions = canEdit ? `
      <button class="icon-btn" type="button" data-action="done-item" data-type="wishes" data-id="${item.id}" aria-label="Исполнено">${DONE_ICON}</button>
      <button class="icon-btn" type="button" data-action="edit-item" data-type="wishes" data-id="${item.id}" aria-label="Редактировать">${EDIT_ICON}</button>
      <button class="icon-btn" type="button" data-action="delete-item" data-type="wishes" data-id="${item.id}" aria-label="Удалить">${DELETE_ICON}</button>
    ` : "";
    // Кнопка «Ссылка» — действие карточки: по центру, с симметричным отступом
    // (как «Сохранить пояс» и прочие card-action), а не прижата к заголовку.
    return `
      <article class="card">
        <div class="item-row">
          <div class="item-main">
            <h3 class="item-title">${renderRichText(item.body)}</h3>
          </div>
          ${actions ? `<div class="item-actions">${actions}</div>` : ""}
        </div>
        ${item.url ? `<button class="secondary full card-action" data-action="open-url" data-url="${esc(item.url)}">Ссылка</button>` : ""}
      </article>
    `;
  }

  function findItem(type, id) {
    const collections = {
      tasks: [...mergedArchive("tasks", appState?.tasks || []), ...mergedArchive("done_tasks", appState?.completedTasks || [])],
      dates: mergedArchive("dates", appState?.dates || []),
      memories: mergedArchive("memories", appState?.memories || []),
      wishes: [...mergedArchive("wishes", appState?.wishes || []), ...mergedArchive("done_wishes", appState?.completedWishes || [])],
      quotes: appState?.quotes || [],
      places: appState?.places || [],
      movies: appState?.movies || [],
      savings: appState?.savings || []
    };
    return (collections[type] || []).find((x) => Number(x.id) === Number(id));
  }

  // Иконки действий карточек: инлайн-SVG в стиле иконок приложения
  // (stroke 1.9, как в app.html), а не текстовые глифы ↩ ✓ ✎ ✕ —
  // на мобильных глифы рендерятся шрифтом платформы (↩ даже эмодзи)
  // и выпадают из стиля кнопок.
  const REOPEN_ICON = '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9 14 4 9l5-5"/><path d="M4 9h10.5a5.5 5.5 0 0 1 5.5 5.5 5.5 5.5 0 0 1-5.5 5.5H11"/></svg>';
  const DONE_ICON = '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m5 12.5 4.5 4.5L19 7.5"/></svg>';
  const EDIT_ICON = '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 20h4.5L19.5 9a2.1 2.1 0 0 0-3-3L5.5 17 4 20Z"/><path d="M13.5 7.5 16.5 10.5"/></svg>';
  const DELETE_ICON = '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" aria-hidden="true"><path d="m6.5 6.5 11 11M17.5 6.5l-11 11"/></svg>';

  // Монохромный огонёк серии: тонкий штрих в стиле иконок приложения вместо
  // эмодзи 🔥, выбивавшегося из монохромных пилюль статистики.
  const FLAME_ICON = '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 3c1.2 3-2.6 4.6-2.6 7.6a3.6 3.6 0 0 0 3.7 3.5c1.8-.1 2.9-1.7 2.6-3.8 1.9 1.5 3.1 3.6 3.1 5.8A6.8 6.8 0 0 1 5.2 15C5.2 9.4 10.4 8 12 3Z"/></svg>';

  // Звезда — вручённое желание в календаре: заливной SVG вместо текстового
  // глифа ★ (U+2605), который рендерится шрифтом платформы.
  const STAR_ICON = '<svg viewBox="0 0 24 24" width="10" height="10" fill="currentColor" stroke="none" aria-hidden="true"><path d="m12 3 2.55 5.18 5.72.83-4.14 4.03.98 5.7L12 16.45l-5.11 2.69.98-5.7-4.14-4.03 5.72-.83L12 3Z"/></svg>';

  // Шевроны стрелок календаря и ссылка в карточке фильма: SVG в толщине
  // иконок приложения вместо текстовых глифов ‹ › (базлайн глифа «плавает»
  // относительно центра кнопки — визуально стрелка стоит ниже центра).
  const CHEVRON_LEFT = '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m14.5 6.5-5.5 5.5 5.5 5.5"/></svg>';
  const CHEVRON_RIGHT = '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m9.5 6.5 5.5 5.5-5.5 5.5"/></svg>';
  const LINK_ICON = '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9.5 14.5a4.24 4.24 0 0 0 6 0l3.2-3.2a4.24 4.24 0 1 0-6-6L11.5 6.5"/><path d="M14.5 9.5a4.24 4.24 0 0 0-6 0l-3.2 3.2a4.24 4.24 0 1 0 6 6l1.2-1.2"/></svg>';

  // Плюс — пополнить копилку.
  const PLUS_ICON = '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" aria-hidden="true"><path d="M12 5.5v13M5.5 12h13"/></svg>';

  // Единый вид дат завершённой карточки (как у посещённых мест): дата создания
  // — серая пилюля, дата завершения справа — приглушённо-зелёная (.day-chip).
  function completionMeta(created, completed) {
    const pills = [
      created ? `<span class="day-chip is-muted">${esc(created)}</span>` : "",
      completed ? `<span class="day-chip">${esc(completed)}</span>` : ""
    ].filter(Boolean).join("");
    return pills ? `<div class="item-meta">${pills}</div>` : "";
  }

  function completedTaskItem(item) {
    const created = formatTimestamp(item.created_at);
    const completed = formatTimestamp(item.completed_at);
    return `
      <article class="card" style="opacity:0.72;">
        <div class="item-row">
          <div class="item-main">
            <h3 class="item-title" style="text-decoration:line-through;">${renderRichText(item.title)}</h3>
            ${completionMeta(created, completed)}
          </div>
          <div class="item-actions">
            <button class="icon-btn" type="button" data-action="reopen-item" data-type="tasks" data-id="${item.id}" aria-label="Вернуть в планы">${REOPEN_ICON}</button>
            <button class="icon-btn" type="button" data-action="edit-item" data-type="tasks" data-id="${item.id}" aria-label="Редактировать">${EDIT_ICON}</button>
            <button class="icon-btn" type="button" data-action="delete-item" data-type="tasks" data-id="${item.id}" aria-label="Удалить">${DELETE_ICON}</button>
          </div>
        </div>
      </article>
    `;
  }

  function completedWishItem(item, editable = true) {
    const canEdit = editable && item.owner_id === appState.user.tg_id;
    const actions = canEdit ? `
      <button class="icon-btn" type="button" data-action="reopen-item" data-type="wishes" data-id="${item.id}" aria-label="Вернуть в желания">${REOPEN_ICON}</button>
      <button class="icon-btn" type="button" data-action="edit-item" data-type="wishes" data-id="${item.id}" aria-label="Редактировать">${EDIT_ICON}</button>
      <button class="icon-btn" type="button" data-action="delete-item" data-type="wishes" data-id="${item.id}" aria-label="Удалить">${DELETE_ICON}</button>
    ` : "";
    const created = formatTimestamp(item.created_at);
    const completed = formatTimestamp(item.done_at);
    return `
      <article class="card" style="opacity:0.72;">
        <div class="item-row">
          <div class="item-main">
            <h3 class="item-title" style="text-decoration:line-through;">${renderRichText(item.body)}</h3>
            ${completionMeta(created, completed)}
          </div>
          ${actions ? `<div class="item-actions">${actions}</div>` : ""}
        </div>
        ${item.url ? `<button class="secondary full card-action" data-action="open-url" data-url="${esc(item.url)}">Ссылка</button>` : ""}
      </article>
    `;
  }

  // Тело списочной вкладки без шапки: шапка и сегмент-переключатель живут в
  // render() и не перерисовываются при смене вида.
  function renderListTab(items, addAction, addLabel, emptyTitle, emptyCopy, renderer) {
    const disabledClass = partnerMissing() ? " is-disabled" : "";
    return `
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

  // События месяца по дням: Map<"YYYY-MM-DD", { tasks, dates, birthdays, wishes }>.
  // Планы без даты не попадают, ежегодные даты проецируются на тот же
  // месяц/день, 29 февраля в невисокосный год пропускается.
  function calendarEventIndex(tasks, dates, wishes, year, month) {
    const index = new Map();
    const push = (key, kind, item) => {
      const bucket = index.get(key) || { tasks: [], dates: [], birthdays: [], wishes: [] };
      bucket[kind].push(item);
      index.set(key, bucket);
    };
    for (const task of tasks || []) {
      if (!task.day) continue;
      const [taskYear, taskMonth, taskDay] = String(task.day).split("-").map(Number);
      if (Number(task.monthly) === 1) {
        // Ежемесячный план — в каждом месяце, где такой день существует,
        // и не раньше года создания.
        if (year < taskYear) continue;
        if (taskDay > calendarDaysInMonth(year, month)) continue;
        push(calendarDayKey(year, month, taskDay), "tasks", task);
        continue;
      }
      if (Number(task.yearly) === 1) {
        // Ежегодный план — тот же месяц-день, не раньше года создания;
        // 29 февраля в невисокосный год пропускается.
        if (year < taskYear || taskMonth !== month) continue;
        if (taskDay > calendarDaysInMonth(year, month)) continue;
        push(calendarDayKey(year, month, taskDay), "tasks", task);
        continue;
      }
      if (taskYear !== year || taskMonth !== month) continue;
      push(calendarDayKey(year, month, taskDay), "tasks", task);
    }
    for (const date of dates || []) {
      if (!date.day) continue;
      const [dateYear, dateMonth, dateDay] = String(date.day).split("-").map(Number);
      if (![dateYear, dateMonth, dateDay].every(Number.isFinite)) continue;
      // День рождения — отдельная дорожка календаря: своя точка в сетке и
      // своя подпись в списке событий дня.
      const bucketKind = date.kind === "birthday" ? "birthdays" : "dates";
      const recurs = Number(date.recurs) === 1 || date.recurs === true;
      const monthly = Number(date.monthly) === 1;
      if (monthly) {
        // Ежемесячная дата — как ежегодная, но каждый месяц того же дня.
        if (year < dateYear) continue;
        if (dateDay > calendarDaysInMonth(year, month)) continue;
        push(calendarDayKey(year, month, dateDay), bucketKind, date);
        continue;
      }
      if (!recurs) {
        if (dateYear === year && dateMonth === month) {
          push(calendarDayKey(year, month, dateDay), bucketKind, date);
        }
        continue;
      }
      if (dateMonth !== month) continue;
      // Ежегодная дата не показывается раньше года, в котором её создали.
      if (year < dateYear) continue;
      // 29 февраля существует не в каждом году — не переносим на 28-е/1-е.
      if (dateDay > calendarDaysInMonth(year, month)) continue;
      push(calendarDayKey(year, month, dateDay), bucketKind, date);
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

  // Единый формат дд/мм/гггг и в календарных подписях (правило п.7 из батча
  // 2026.10.31: «дата в приложении всегда дд/мм/гггг» — длинный «8 марта»
  // нарушал его в заголовке событий выбранного дня).
  function calendarLongDate(key) {
    return formatDay(String(key ?? ""));
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
      ...(bucket.birthdays || []).map((date) => ({
        kind: "birthday", title: date.title, time: date.time, isPrivate: Number(date.is_private) === 1
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
      const cellBirthdays = bucket?.birthdays || [];
      const dots = [];
      // Звезда — вручённое желание, точки — планы, даты и дни рождения.
      // Личные записи (is_private) помечаем серым, чтобы не путать с общими.
      if (bucket?.wishes.length) dots.push(`<span class="cal-star">${STAR_ICON}</span>`);
      if (cellTasks.length) {
        dots.push(`<i class="cal-dot ${cellTasks.every((item) => Number(item.is_private) === 1) ? "is-private" : "is-task"}"></i>`);
      }
      if (cellDates.length) {
        dots.push(`<i class="cal-dot ${cellDates.every((item) => Number(item.is_private) === 1) ? "is-private" : "is-date"}"></i>`);
      }
      if (cellBirthdays.length) {
        dots.push(`<i class="cal-dot ${cellBirthdays.every((item) => Number(item.is_private) === 1) ? "is-private" : "is-birthday"}"></i>`);
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
                ? `<span class="cal-star" aria-hidden="true">${STAR_ICON}</span>`
                : `<i class="cal-dot ${row.isPrivate ? "is-private" : row.kind === "task" ? "is-task" : row.kind === "birthday" ? "is-birthday" : "is-date"}" aria-hidden="true"></i>`}
              <div class="cal-event-body">
                <span class="cal-event-title">${renderRichText(row.title)}</span>
                <span class="cal-event-meta">${row.kind === "task" ? "План" : row.kind === "date" ? "Значимая дата" : row.kind === "birthday" ? "День рождения" : "Желание подарено"}${row.isPrivate ? " · личное" : ""}${row.time ? ` · ${esc(row.time)}` : ""}</span>
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
          <button class="cal-nav-btn" type="button" data-action="calendar-prev" aria-label="Предыдущий месяц">${CHEVRON_LEFT}</button>
          <h3 class="cal-title">${esc(calendarMonthTitle(year, month))}</h3>
          <button class="cal-nav-btn" type="button" data-action="calendar-next" aria-label="Следующий месяц">${CHEVRON_RIGHT}</button>
        </div>
        <div class="cal-weekdays" aria-hidden="true">${weekdays.map((day) => `<span>${day}</span>`).join("")}</div>
        <div class="cal-grid">${cellsHtml}</div>
        <div class="cal-legend">
          <span><i class="cal-dot is-task" aria-hidden="true"></i> Планы</span>
          <span><i class="cal-dot is-date" aria-hidden="true"></i> Значимые даты</span>
          <span><i class="cal-dot is-birthday" aria-hidden="true"></i> Дни рождения</span>
          <span><span class="cal-star" aria-hidden="true">${STAR_ICON}</span> Желания</span>
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
    // Текущее имя партнёра (уже с личной подменой, если она задана) —
    // подсказка в поле переименования.
    const partnerName = appState.pair?.role === "b" ? (appState.pair.name1 || "") : (appState.pair?.name2 || "");
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
          <span class="settings-label"><input type="checkbox" id="show-avatar" ${user.show_avatar !== false ? "checked" : ""}> Отображение аватара</span>
        </label>
        <p class="settings-hint">Фото профиля Telegram вместо букв в кнопке пары. Если у пользователя фото нет, остаётся буква, пока аватар не появится. Без галочки всегда показываются буквы.</p>
        <div class="settings-row">
          <span class="settings-label">Имя партнёра</span>
          <input id="partner-name-input" type="text" maxlength="80" autocomplete="off" placeholder="${esc(partnerName)}" value="${esc(user.partner_custom_name || "")}">
        </div>
        <p class="settings-hint">Каким вы видите имя партнёра в приложении — например, если в Telegram у него ник. Видно только вам; партнёр у себя ничего не заметит. Пусто — имя из Telegram.</p>
        <label class="settings-row">
          <span class="settings-label"><input type="checkbox" id="digest-enabled" ${user.digest_enabled ? "checked" : ""}> Утренняя сводка</span>
          <input type="time" id="digest-time" lang="ru" value="${esc(user.digest_time || "09:00")}">
        </label>
        <p class="settings-hint">Планы и значимые даты на сегодня и завтра — личным сообщением от бота.</p>
        <label class="settings-row">
          <span class="settings-label"><input type="checkbox" id="dates-digest-enabled" ${user.dates_digest_enabled ? "checked" : ""}> Даты за сутки</span>
          <input type="time" id="dates-digest-time" lang="ru" value="${esc(user.dates_digest_time || "09:00")}">
        </label>
        <p class="settings-hint">Напомнит о завтрашних датах накануне в выбранное время. Кроме сводок бот предупреждает о плане с точным временем за 3 часа и за час.</p>
        <div class="settings-row">
          <span class="settings-label">Тема</span>
          <div class="theme-switch">
            ${[["system", "Как в системе"], ["dark", "Тёмная"], ["light", "Светлая"]].map(([value, label]) => `
              <button class="theme-option${themePref() === value ? " is-active" : ""}" type="button" data-action="set-theme" data-theme="${value}">${label}</button>
            `).join("")}
          </div>
        </div>
        <div style="margin-top:18px; display:grid; gap:8px;">
          <button class="secondary full" type="button" data-action="save-settings">Сохранить настройки</button>
        </div>
      </section>
    `;
  }

  // Пароль на вход — отдельная карточка (item 56): это локальная блокировка
  // экрана устройства, а не настройка оформления/уведомлений, и её состояние
  // живёт в localStorage, а не в POST /api/settings.
  function renderPairLock() {
    return `
      <section class="card">
        <p class="eyebrow">Безопасность</p>
        <h3>Пароль на вход</h3>
        ${pinField("pin-input")}
        <p class="settings-hint">Четырёхзначный пароль спросится при открытии приложения. Это локальная блокировка экрана: она не шифрует данные и не защищает их при входе в ваш Telegram-аккаунт с другого устройства. Без тайм-аутов при ошибке.</p>
        ${storedPin()
          ? `<button class="secondary full card-action" type="button" data-action="clear-pin">Удалить</button>`
          : `<button class="secondary full card-action" type="button" data-action="save-pin">Задать</button>`}
      </section>
    `;
  }

  // Резервная копия — отдельная карточка под настройками: кнопка с пояснением
  // слишком значима, чтобы прятать её внутри персональных настроек.
  function renderPairExport() {
    return `
      <section class="card">
        <p class="eyebrow">Резервная копия</p>
        <h3>Экспорт данных</h3>
        <p class="settings-hint">Выберите разделы — бот пришлёт один JSON-файл с выбранным. Удобно хранить вне приложения.</p>
        <button class="secondary full card-action" type="button" data-action="export-data">Экспортировать</button>
      </section>
    `;
  }

  // Часовой пояс — общая настройка пары: от него считается календарь,
  // локальный день ритуала и расписание напоминаний у обоих партнёров.
  const COMMON_TIMEZONES = [
    "Europe/Moscow", "Europe/Kaliningrad", "Europe/Samara", "Asia/Yekaterinburg",
    "Asia/Novosibirsk", "Asia/Krasnoyarsk", "Asia/Irkutsk", "Asia/Vladivostok",
    "Europe/Kyiv", "Europe/Minsk", "Europe/Riga", "Europe/Vilnius", "Europe/Tallinn",
    "Europe/Warsaw", "Europe/Berlin", "Europe/Prague", "Europe/Istanbul",
    "Asia/Almaty", "Asia/Tashkent", "Asia/Tbilisi", "Asia/Yerevan", "Asia/Baku",
    "Europe/London", "America/New_York", "America/Chicago", "America/Los_Angeles", "UTC"
  ];

  function renderPairTimezone() {
    const device = Intl.DateTimeFormat().resolvedOptions().timeZone || "";
    const current = appState.pair?.timezone || device || "UTC";
    const zones = [...new Set([current, device, ...COMMON_TIMEZONES])].filter(Boolean);
    const options = zones.map((zone) => `
      <option value="${esc(zone)}"${zone === current ? " selected" : ""}>${esc(zone.replace(/_/g, " "))}</option>`).join("");
    return `
      <section class="card">
        <p class="eyebrow">Общее</p>
        <h3>Часовой пояс</h3>
        <select id="pair-timezone" class="settings-select">${options}</select>
        <p class="settings-hint">Общий для календаря, ритуала дня и напоминаний у обоих партнёров. При смене пояса пересчитываются «сегодня/завтра» — граница суток сдвинется.</p>
        <button class="secondary full card-action" type="button" data-action="save-pair-timezone">Сохранить пояс</button>
      </section>
    `;
  }

  // Тело «Нашей пары»: профиль (календарь, настройки, выход) или желания.
  // Шапка и сегмент-переключатель живут в render() и при смене вида не
  // перерисовываются — капля остаётся на живом экземпляре.
  function renderPairView() {
    if (pairView === "wishes") return renderWishBlock();
    if (pairView === "savings") return renderSavingsBody();
    return renderPairBody();
  }

  function renderPairBody() {
    const { pair } = appState;
    // Карточка приглашения живёт ровно пока партнёра нет: как только он
    // присоединился (user_b заполнен) — скрываем; если партнёр вышел
    // (сервер обнуляет user_b) — карточка возвращается.
    const inviteBlock = partnerMissing() ? `
      <section class="card">
        <p class="eyebrow">Приглашение партнёра</p>
        <h3>Отправьте код партнёру</h3>
        <p>После его присоединения здесь появятся общие планы, значимые даты, общий дневник, вишлист и ритуал дня.</p>
        ${pair.code ? `
          <div style="margin-top:18px; display:grid; gap:8px;">
            <button class="secondary full" type="button" data-action="copy-code" data-code="${esc(pair.code)}">Скопировать код: ${esc(pair.code)}</button>
            <button class="secondary full" type="button" data-action="copy-link" data-code="${esc(pair.code)}">Скопировать ссылку для партнёра</button>
          </div>
        ` : ""}
      </section>
    ` : "";
    return `
      ${inviteBlock}
      ${renderPairCalendar()}
      ${renderPairSettings()}
      ${renderPairLock()}
      ${renderPairTimezone()}
      ${renderPairExport()}
      <div class="pair-exit">
        <button class="secondary pair-leave" type="button" data-action="leave-pair">Выйти из пространства</button>
      </div>
    `;
  }

  // Желания внутри «Нашей пары»: свой переключатель «Мои / Её» и списки.
  function renderWishBlock() {
    const hasPartner = Boolean(appState.pair?.user_b);
    if (wishView === "partner" && !hasPartner) wishView = "mine";
    const isMine = wishView === "mine";
    const partnerLabel = appState.pair?.partner_gender === "female" ? "Её" : "Его";
    let html = "";
    if (hasPartner) {
      html += `
        <div class="wish-switch" role="tablist" aria-label="Чьи желания показывать">
          <button class="wish-switch-btn${isMine ? " is-active" : ""}" type="button" role="tab" aria-selected="${isMine}" data-action="wish-view" data-view="mine" data-tab="mine">Мои</button>
          <button class="wish-switch-btn${!isMine ? " is-active" : ""}" type="button" role="tab" aria-selected="${!isMine}" data-action="wish-view" data-view="partner" data-tab="partner">${partnerLabel}</button>
        </div>
      `;
    }
    html += `<div id="wish-lists">${renderWishLists()}</div>`;
    return html;
  }

  // ------------------------------------------------------------------
  // Копилки: сегмент «Копилка» на вкладке «Наша пара»
  // ------------------------------------------------------------------
  // Личная копилка видна только автору (фильтр на сервере), общая — паре.
  // collected поддерживается сервером при пополнении той же транзакцией,
  // что пишет запись в историю — карточка всегда согласована с историей.
  function savingsList() {
    return appState.savings || [];
  }

  // Деньги копилки — целые, форматируем с разрядкой «30 000».
  function formatAmount(value) {
    const n = Number(value);
    if (!Number.isFinite(n)) return "0";
    return new Intl.NumberFormat("ru-RU").format(n);
  }

  function savingIsFull(saving) {
    return Number(saving.collected) >= Number(saving.target);
  }

  function savingItem(saving) {
    const full = savingIsFull(saving);
    const percent = Number(saving.target) > 0
      ? Math.min(100, Math.round((Number(saving.collected) / Number(saving.target)) * 100))
      : 0;
    // У полной копилки цель достигнута: «Пополнить» и «Редактировать» не нужны —
    // остаётся только удаление; история по-прежнему открывается тапом.
    const actions = full
      ? `<button class="icon-btn" type="button" data-action="delete-item" data-type="savings" data-id="${saving.id}" aria-label="Удалить">${DELETE_ICON}</button>`
      : `
        <button class="icon-btn" type="button" data-action="deposit-saving" data-id="${saving.id}" aria-label="Пополнить">${PLUS_ICON}</button>
        <button class="icon-btn" type="button" data-action="edit-saving" data-id="${saving.id}" aria-label="Редактировать">${EDIT_ICON}</button>
        <button class="icon-btn" type="button" data-action="delete-item" data-type="savings" data-id="${saving.id}" aria-label="Удалить">${DELETE_ICON}</button>
      `;
    return `
      <article class="card${full ? " saving-full" : ""}" data-action="open-saving" data-id="${saving.id}"
        role="button" tabindex="0" aria-label="История пополнений копилки «${esc(saving.title)}»">
        <div class="item-row">
          <div class="item-main">
            <h3 class="item-title">${esc(saving.title)}</h3>
            <div class="item-meta">
              <span class="day-chip ${saving.kind === "shared" ? "" : "is-muted"}">${saving.kind === "shared" ? "Общая" : "Личная"}</span>
              <span>${esc(formatAmount(saving.collected))} из ${esc(formatAmount(saving.target))}</span>
            </div>
            <div class="saving-progress" aria-hidden="true"><i style="width:${percent}%"></i></div>
          </div>
          <div class="item-actions">${actions}</div>
        </div>
      </article>
    `;
  }

  function renderSavingsBody() {
    const list = savingsList();
    const open = list.filter((saving) => !savingIsFull(saving));
    const full = list.filter(savingIsFull);
    // Наполнение пространства — только после воссоединения партнёров:
    // гейт как у всех add-кнопок приложения. Пустой список: кнопка
    // «Создать копилку» живёт в карточке «Пока пусто» (как в кино).
    const disabledClass = partnerMissing() ? " is-disabled" : "";
    let html = "";
    if (!open.length && !full.length) {
      html += `
        <section class="card">
          <h3>Пока пусто</h3>
          <p>Создайте копилку на общую мечту или личную цель — пополняйте и следите за прогрессом.</p>
          <button class="primary full card-action${disabledClass}" type="button" data-action="add-saving">Создать копилку</button>
        </section>
      `;
    } else {
      html += `<button class="primary full add-button${disabledClass}" type="button" data-action="add-saving">Создать копилку</button>`;
      html += open.map(savingItem).join("");
    }
    if (full.length) {
      html += `<div class="section-head-inline"><h3>Накопленные · ${full.length}</h3></div>`;
      html += full.map(savingItem).join("");
    }
    return html;
  }

  // Сегмент-переключатель вида: те же кнопки, что в доке, но внутри вкладки.
  // data-action="seg-switch" обрабатывается общим делегированным кликом.
  function renderSegment(key, value, options, extraClass = "") {
    return `
      <div class="seg-switch${extraClass ? ` ${extraClass}` : ""}" data-switch="${key}" role="tablist">
        ${options.map(([id, label]) => `
          <button class="seg-switch-btn${id === value ? " is-active" : ""}" type="button" role="tab"
            aria-selected="${id === value}" data-action="seg-switch" data-switch="${key}" data-tab="${id}">${esc(label)}</button>
        `).join("")}
      </div>
    `;
  }

  // ------------------------------------------------------------------
  // Планы: вид «Планы» сегмента вкладки «Планы»
  // ------------------------------------------------------------------
  function renderTasksBody() {
    const openTasks = mergedArchive("tasks", sortByTaskDeadline(appState.tasks || []));
    const doneTasks = mergedArchive("done_tasks", appState.completedTasks || []);
    const taskDisabledClass = partnerMissing() ? " is-disabled" : "";
    let html = "";
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
    return html;
  }

  // ------------------------------------------------------------------
  // Даты: «Наше» и «Дни рождения» — один конвейер, два списка
  // ------------------------------------------------------------------
  // День рождения — та же запись dates с kind='birthday' и recurs=1, поэтому
  // приватность, отсчёт, календарь, сводки и экспорт работают без отдельной
  // таблицы. Здесь только делим список по виду.
  function datesOfKind(kind) {
    return mergedArchive("dates", appState.dates || []).filter((item) =>
      (item.kind === "birthday" ? "birthday" : "date") === kind
    );
  }

  function renderDatesBody() {
    if (datesView === "birthdays") {
      const rows = datesOfKind("birthday");
      const disabledClass = partnerMissing() ? " is-disabled" : "";
      if (!rows.length) {
        return `
          <section class="card">
            <h3>Чтобы не забыть</h3>
            <p>Добавьте день рождения близкого человека — напомним за 3 дня и в сам день.</p>
            <div style="margin-top:12px;">
              <button class="primary full${disabledClass}" type="button" data-action="add-birthday">Добавить день рождения</button>
            </div>
          </section>
        `;
      }
      return `
        <button class="primary full add-button${disabledClass}" type="button" data-action="add-birthday">Добавить день рождения</button>
        ${rows.map(birthdayItem).join("")}
      `;
    }
    // Порядок приходит отсортированным из /api/state (sortDateRows):
    // повторная сортировка с часовыми поясами на каждое сравнение не нужна.
    return renderListTab(datesOfKind("date"), "add-date", "Добавить дату", "Хочу запомнить", "Добавьте годовщину, день знакомства или важный праздник.", dateItem)
      + archiveMoreHtml("dates", (appState.dates || []).length);
  }

  // ------------------------------------------------------------------
  // Дневник: записи и цитаты
  // ------------------------------------------------------------------
  function renderMemoriesBody() {
    if (memoriesView === "quotes") {
      const quotes = appState.quotes || [];
      return renderListTab(quotes, "add-quote", "Добавить цитату", "Ни одной цитаты", "Сохраните фразу, которая зацепила — из книги, фильма или разговора.", quoteItem);
    }
    const recentMemories = appState.memories || [];
    return renderListTab(mergedArchive("memories", recentMemories), "add-memory", "Записать", "Воспоминание", "Сохраняйте тёплые воспоминания, к которым хочется возвращаться.", memoryItem)
      + archiveMoreHtml("memories", recentMemories.length);
  }

  // Автор цитаты — select вместо свободного ввода: по запросу выбор
  // ограничен двумя пользователями пространства (имена из pair уже учитывают
  // личное имя партнёра). Пустой вариант оставляет поле необязательным.
  // Старые цитаты с источником-текстом (книга, фильм) при редактировании
  // получают свой источник лишним вариантом — иначе select молча затёр бы его.
  function quoteAuthorOptions(selected) {
    const pair = appState.pair || {};
    const names = [pair.name1, pair.name2].filter((name) => name);
    if (selected && !names.includes(selected)) names.push(selected);
    return [
      `<option value="">Не указан</option>`,
      ...names.map((name) => `<option value="${esc(name)}"${name === selected ? " selected" : ""}>${esc(name)}</option>`)
    ].join("");
  }

  function quoteItem(item) {
    // Кнопки — в одном ряду с автором и датой (item-row): иначе под
    // коротким блоком меты оставалось много пустого места.
    return `
      <article class="card quote-card">
        <span class="quote-mark" aria-hidden="true">&ldquo;</span>
        <p class="quote-text">${renderRichText(item.body || "")}</p>
        ${item.source ? `<p class="quote-source">— ${esc(item.source)}</p>` : ""}
        <div class="item-row">
          <div class="item-main">
            <div class="item-meta">
              <span>${esc(formatTimestamp(item.created_at))}</span>
            </div>
          </div>
          <div class="item-actions">
            <button class="icon-btn" type="button" data-action="edit-item" data-type="quotes" data-id="${item.id}" aria-label="Редактировать">${EDIT_ICON}</button>
            <button class="icon-btn" type="button" data-action="delete-item" data-type="quotes" data-id="${item.id}" aria-label="Удалить">${DELETE_ICON}</button>
          </div>
        </div>
      </article>
    `;
  }

  // Год в дне рождения технический (нужен только валидной дате): показываем
  // месяц и число, без возраста.
  function formatBirthday(day) {
    const [, month, date] = String(day || "").split("-").map(Number);
    if (!month || !date) return "";
    const value = new Date(Date.UTC(2000, month - 1, date, 12));
    return new Intl.DateTimeFormat("ru-RU", { day: "numeric", month: "long" }).format(value);
  }

  function nextDaysLabel(item) {
    const next = nextOccurrence(item);
    if (!next) return "";
    const tz = pairTimeZone();
    const parts = new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
    const [year, month, day] = parts.split("-").map(Number);
    const midnight = makeDateInTimeZone(year, month - 1, day, 12, 0, tz);
    const days = Math.round((next.getTime() - midnight.getTime()) / 86400000);
    if (days === 0) return "Сегодня";
    if (days === 1) return "Завтра";
    return `Через ${days} ${plural(days, "день", "дня", "дней")}`;
  }

  function birthdayItem(item) {
    const label = nextDaysLabel(item);
    return `
      <article class="card birthday-card">
        <div class="item-row">
          <div class="item-main">
            <h3 class="item-title">${renderRichText(item.title)}</h3>
            <div class="item-meta">
              ${item.is_private ? `<span class="day-chip is-private">Личное</span>` : ""}
              <span>${esc(formatBirthday(item.day))}</span>
              ${label ? `<span class="day-chip">${esc(label)}</span>` : ""}
            </div>
          </div>
          <div class="item-actions">
            <button class="icon-btn" type="button" data-action="edit-item" data-type="dates" data-id="${item.id}" aria-label="Редактировать">${EDIT_ICON}</button>
            <button class="icon-btn" type="button" data-action="delete-item" data-type="dates" data-id="${item.id}" aria-label="Удалить">${DELETE_ICON}</button>
          </div>
        </div>
      </article>
    `;
  }

  // ------------------------------------------------------------------
  // Места: список «куда сходить» и «Рандом»
  // ------------------------------------------------------------------
  function placeList() {
    return appState.places || [];
  }

  function unvisitedPlaces() {
    return placeList().filter((place) => Number(place.visited) !== 1);
  }

  function visitedPlaces() {
    return placeList().filter((place) => Number(place.visited) === 1);
  }

  // Hero-карточка рандома — информер: показывается до первого запуска
  // рандома на этом устройстве и после этого не нужна (флаг в localStorage,
  // как PIN и тема — серверу он не нужен).
  const PLACE_RANDOM_KEY = "duoplan.placeRandomUsed";
  function placeRandomUsed() {
    try { return localStorage.getItem(PLACE_RANDOM_KEY) === "1"; } catch { return false; }
  }
  function markPlaceRandomUsed() {
    try { localStorage.setItem(PLACE_RANDOM_KEY, "1"); } catch {}
  }

  // Текущий выпавший выбор. Если место успели удалить или отметить с другого
  // устройства, карточка тихо снимается — показывать нечего.
  function currentPlacePick() {
    if (!placePickId) return null;
    const place = placeList().find((item) => Number(item.id) === Number(placePickId));
    if (!place || Number(place.visited) === 1) {
      placePickId = null;
      return null;
    }
    return place;
  }

  // Колода, а не Math.random() на каждый тап: перемешанный список id, тянем
  // по одному, пока не кончится. Иначе на коротком списке из трёх мест
  // «случайность» возвращала бы одно и то же через раз.
  function shuffleIds(list) {
    for (let i = list.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [list[i], list[j]] = [list[j], list[i]];
    }
    return list;
  }

  // Синхронизация с текущим списком: посещённые и удалённые места выпадают из
  // колоды. Новые места попадут в неё в начале следующего цикла — дописывать
  // их на ходу нельзя: уже выпавшее место снова считалось бы «новым» и
  // повторялось через раз (репорт 2026-11-04).
  function syncPlaceDeck(pool) {
    const ids = new Set(pool.map((place) => Number(place.id)));
    placeDeck = placeDeck.filter((id) => ids.has(id));
    return pool;
  }

  function drawPlace() {
    const pool = syncPlaceDeck(unvisitedPlaces());
    if (!pool.length) {
      placePickId = null;
      return null;
    }
    if (!placeDeck.length) {
      placeDeck = shuffleIds(pool.map((place) => Number(place.id)));
      // Не показывать то же место дважды подряд, если есть из чего выбрать.
      if (placeDeck.length > 1 && placeDeck[placeDeck.length - 1] === Number(placePickId)) {
        [placeDeck[placeDeck.length - 1], placeDeck[0]] = [placeDeck[0], placeDeck[placeDeck.length - 1]];
      }
    }
    placePickId = placeDeck.pop();
    return placePickId;
  }

  function renderPlacePick(place) {
    return `
      <article class="card place-pick" aria-live="polite">
        <p class="eyebrow">Вам выпало</p>
        <h2 class="place-pick-title">${esc(place.title)}</h2>
        ${place.note ? `<p class="place-pick-note">${esc(place.note)}</p>` : ""}
        <div class="place-actions">
          <button class="primary full" type="button" data-action="place-visited" data-id="${place.id}">Посетили</button>
          <button class="secondary full" type="button" data-action="random-place">Следующее</button>
          ${place.url ? `<button class="secondary full" type="button" data-action="open-url" data-url="${esc(place.url)}">Открыть ссылку</button>` : ""}
        </div>
      </article>
    `;
  }

  function placeItem(place) {
    const visited = Number(place.visited) === 1;
    return `
      <article class="card${visited ? " place-visited" : ""}">
        <div class="item-row">
          <div class="item-main">
            <h3 class="item-title">${esc(place.title)}</h3>
            ${place.note ? `<p class="place-note">${esc(place.note)}</p>` : ""}
            ${visited ? `<div class="item-meta"><span class="day-chip">${esc(formatTimestamp(place.visited_at) || "Посещено")}</span></div>` : ""}
          </div>
          <div class="item-actions">
            ${visited
              ? `<button class="icon-btn" type="button" data-action="place-unvisited" data-id="${place.id}" aria-label="Вернуть в список">${REOPEN_ICON}</button>`
              : `<button class="icon-btn" type="button" data-action="place-visited" data-id="${place.id}" aria-label="Отметить посещённым">${DONE_ICON}</button>`}
            ${place.url ? `<button class="icon-btn" type="button" data-action="open-url" data-url="${esc(place.url)}" aria-label="Ссылка">${LINK_ICON}</button>` : ""}
            <button class="icon-btn" type="button" data-action="edit-item" data-type="places" data-id="${place.id}" aria-label="Редактировать">${EDIT_ICON}</button>
            <button class="icon-btn" type="button" data-action="delete-item" data-type="places" data-id="${place.id}" aria-label="Удалить">${DELETE_ICON}</button>
          </div>
        </div>
      </article>
    `;
  }

  function renderPlaces() {
    const open = unvisitedPlaces();
    const visited = visitedPlaces();
    const total = open.length + visited.length;
    const disabledClass = partnerMissing() ? " is-disabled" : "";
    const pick = currentPlacePick();
    const empty = !total;
    const heroUsed = placeRandomUsed();
    let html = renderTabHeader("places");
    // Пустой список — как в «Кино»: «Добавить место» живёт в карточке
    // «Пока пусто», а не отдельной кнопкой над списком.
    if (empty) {
      html += `
        <section class="card">
          <h3>Пока пусто</h3>
          <p>Добавьте кафе, парк или город, куда давно хотели выбраться.</p>
          <button class="primary full card-action${disabledClass}" type="button" data-action="add-place">Добавить место</button>
        </section>
      `;
    }
    // «Рандом» — кнопка внутри карточки-информера до первого запуска на этом
    // устройстве; после первого выбора карточка исчезает, а кнопка
    // возвращается отдельной — под «Добавить место».
    if (!heroUsed) {
      const hint = empty
        ? "Пока нечего выбирать — добавьте первое место."
        : open.length ? "" : "Все места уже посещены — добавьте новое или верните старое.";
      html += `
        <section class="card place-hero">
          <p class="eyebrow">Рандом</p>
          <h3>Не знаете, куда пойти?</h3>
          <p>Приложение выберет случайное место из списка. Отметить посещение можно отдельно — уже после того, как сходите.</p>
          ${hint ? `<p class="place-count">${hint}</p>` : ""}
          <button class="secondary full card-action${disabledClass}" type="button" data-action="random-place">Рандом</button>
        </section>
      `;
    }
    if (pick) html += renderPlacePick(pick);
    if (!empty) {
      html += `<button class="primary full add-button${disabledClass}" type="button" data-action="add-place">Добавить место</button>`;
      // «Рандом» живёт под «Добавить место» и окрашен нейтрально, как кнопки
      // карточек «Нашей пары» (.secondary — следует теме, а не акценту).
      if (heroUsed) html += `<button class="secondary full place-random" type="button" data-action="random-place">Рандом</button>`;
      if (open.length) {
        html += `<div class="section-head-inline"><h3>Хотим посетить · ${open.length}</h3></div>`;
        html += open.map((place) => placeItem(place)).join("");
      }
      if (visited.length) {
        html += `<div class="section-head-inline"><h3>Посещённые · ${visited.length}</h3></div>`;
        html += visited.map((place) => placeItem(place)).join("");
      }
    }
    return html;
  }

  // ------------------------------------------------------------------
  // Кино: избранное к просмотру с данными IMDb (сегмент вкладки «Планы»)
  // ------------------------------------------------------------------
  function movieList() {
    return appState.movies || [];
  }

  function openMovies() {
    return movieList().filter((movie) => Number(movie.watched) !== 1);
  }

  function watchedMovies() {
    return movieList().filter((movie) => Number(movie.watched) === 1);
  }

  // Пилюля оценки: серая (0–3.9 и «нет оценки»), красная (4–5.9),
  // жёлтая (6–7.9), зелёная (8–10). Порог общий для IMDb, TMDB и RAofP.
  function scorePill(label, rating) {
    const r = Number(rating);
    if (!Number.isFinite(r) || r <= 0) return `<span class="day-chip is-rating-gray">${label} —</span>`;
    const cls = r < 4 ? "is-rating-gray" : r < 6 ? "is-rating-red" : r < 8 ? "is-rating-yellow" : "is-rating-green";
    return `<span class="day-chip ${cls}">${label} ${r.toFixed(1)}</span>`;
  }

  function ratingPill(rating, source = "imdb") {
    return scorePill(source === "tmdb" ? "TMDB" : "IMDb", rating);
  }

  // RAofP — rating assessment of the pair: среднее оценок обоих партнёров.
  function raofpPill(movie) {
    return scorePill("RAofP", movie?.pair_rating);
  }

  // Сетка оценок 1..10: только целые числа, выбор обязателен (required на
  // радио-группе не даёт отправить форму без оценки).
  function ratingField() {
    const options = Array.from({ length: 10 }, (_, index) => index + 1)
      .map((value) => `<label class="rating-option"><input type="radio" name="rating" value="${value}" required><span>${value}</span></label>`)
      .join("");
    return `<div class="rating-grid">${options}</div>`;
  }

  // Общий диалог оценки: «Просмотрено» (оценка обязательна для перехода
  // в «Просмотренные») и «Оценить» для второго партнёра.
  function openRatingDialog(movie, { path, hint, toast, clearPick = false }) {
    openDialog({
      title: movie?.kind === "series" ? "Оцените сериал" : "Оцените фильм",
      fields: `<p class="settings-hint">${hint}</p>${ratingField()}`,
      submitLabel: "Оценить",
      onSubmit: async (formData) => {
        const state = await request(path, { method: "POST", body: { rating: Number(formData.get("rating")) } });
        if (clearPick) moviePickId = null;
        showToast(toast);
        return state;
      }
    });
  }

  // Статусы TMDB — по-русски; неизвестные не показываем.
  const MOVIE_STATUS_RU = {
    Released: "Вышел",
    Ended: "Завершён",
    "Returning Series": "Продолжается",
    "In Production": "В производстве",
    "Post Production": "Постпродакшн",
    Canceled: "Отменён",
    Planned: "Запланирован",
    Rumored: "Слухи"
  };

  // Окно карточки: описание, все жанры, актёры, режиссёр/создатели, премьера,
  // длительность, статус и рейтинги RT/Metacritic. Данные приходят из
  // /api/movies/:id/details (TMDB ru + OMDb) и кешируются на сервере.
  function renderMovieDetails(movie, details) {
    if (!details) {
      return `<p class="movie-details-empty">Описание пока недоступно — попробуйте открыть карточку позже.</p>`;
    }
    const genres = (details.genres || []).filter(Boolean);
    const actors = (details.actors || []).filter(Boolean);
    const director = (details.director || []).filter(Boolean);
    const pills = [
      ratingPill(movie.rating, movie.rating_source),
      movie.pair_rating ? raofpPill(movie) : "",
      details.rt ? `<span class="day-chip is-muted">RT ${esc(details.rt)}</span>` : "",
      details.metascore ? `<span class="day-chip is-muted">Metacritic ${esc(details.metascore)}</span>` : ""
    ].filter(Boolean).join("");
    const length = formatMovieLength(movie);
    const facts = [];
    if (director.length) facts.push([movie.kind === "series" ? "Создатели" : "Режиссёр", director.join(", ")]);
    if (actors.length) facts.push(["В главных ролях", actors.join(", ")]);
    if (details.released) facts.push(["Премьера", formatDay(details.released)]);
    if (length) facts.push(["Длительность", length]);
    const status = MOVIE_STATUS_RU[details.status];
    if (status) facts.push(["Статус", status]);
    return `
      ${details.tagline ? `<p class="movie-details-tagline">${esc(details.tagline)}</p>` : ""}
      <div class="movie-details-pills">${pills}</div>
      ${genres.length ? `<div class="movie-details-genres">${genres.map((genre) => `<span class="day-chip is-muted">${esc(genre)}</span>`).join("")}</div>` : ""}
      ${details.plot ? `<p class="movie-details-plot">${esc(details.plot)}</p>` : ""}
      ${facts.length ? `<dl class="movie-details-facts">${facts.map(([term, value]) => `<div class="movie-details-fact"><dt>${esc(term)}</dt><dd>${esc(value)}</dd></div>`).join("")}</dl>` : ""}
      ${details.plot_lang === "en" ? `<p class="movie-details-note">Описание на английском: русского перевода пока нет.</p>` : ""}
    `;
  }

  // Тап по карточке: окно открывается сразу с заглушкой, детали подставляются
  // после ответа сервера. Если диалог успели закрыть/сменить — ответ игнорим.
  function openMovieDetails(movie) {
    openDialog({
      title: movie.title,
      fields: `<p class="movie-details-empty">Загружаем описание…</p>`,
      submitLabel: null,
      readOnly: true,
      cancelLabel: "Закрыть"
    });
    const context = dialogContext;
    request(`/api/movies/${movie.id}/details`)
      .then((data) => {
        if (dialogContext !== context || !dialog.open) return;
        dialogFields.innerHTML = renderMovieDetails(movie, data.details);
      })
      .catch(() => {
        if (dialogContext !== context || !dialog.open) return;
        dialogFields.innerHTML = `<p class="movie-details-empty">Не удалось загрузить описание. Попробуйте позже.</p>`;
      });
  }

  // Длительность без пилюли: у фильма — хронометраж, у сериала — сезоны
  // и общие серии. Чего IMDb не отдал — того не показываем.
  function formatMovieLength(movie) {
    if (movie.kind === "series") {
      const parts = [];
      const seasons = Number(movie.seasons);
      if (seasons) parts.push(`${seasons} ${plural(seasons, "сезон", "сезона", "сезонов")}`);
      const episodes = Number(movie.episodes);
      if (episodes) parts.push(`${episodes} ${plural(episodes, "серия", "серии", "серий")}`);
      return parts.join(" · ");
    }
    const minutes = Number(movie.runtime);
    if (!minutes) return "";
    const hours = Math.floor(minutes / 60);
    const rest = minutes % 60;
    if (hours && rest) return `${hours} ч ${rest} мин`;
    if (hours) return `${hours} ч`;
    return `${rest} мин`;
  }

  function movieItem(movie) {
    const watched = Number(movie.watched) === 1;
    // В IMDb жанры приходят списком — для пилюли берём первый.
    const genre = movie.genres ? String(movie.genres).split(",")[0].trim() : "";
    const yearPill = movie.year ? `<span class="day-chip is-muted">${esc(movie.year)}</span>` : "";
    const length = formatMovieLength(movie);
    return `
      <article class="card movie-card${watched ? " movie-watched" : ""}" data-action="open-movie" data-id="${movie.id}" role="button" tabindex="0" aria-label="Открыть описание: ${esc(movie.title)}">
        <div class="item-row">
          <div class="item-main">
            <h3 class="item-title">${esc(movie.title)}</h3>
            ${genre || movie.year ? `<div class="item-meta">${genre ? `<span class="day-chip is-muted">${esc(genre)}</span>` : ""}${yearPill}</div>` : ""}
            <div class="item-meta">
              ${ratingPill(movie.rating, movie.rating_source)}
              ${length ? `<span>${esc(length)}</span>` : ""}
            </div>
            ${watched ? `<div class="item-meta">${raofpPill(movie)}</div>` : ""}
            ${watched ? `<div class="item-meta"><span class="day-chip">${esc(formatTimestamp(movie.watched_at) || "Просмотрено")}</span></div>` : ""}
          </div>
          <div class="item-actions">
            ${watched
              ? `<button class="icon-btn" type="button" data-action="movie-unwatched" data-id="${movie.id}" aria-label="Вернуть в список">${REOPEN_ICON}</button>`
              : `<button class="icon-btn" type="button" data-action="movie-watched" data-id="${movie.id}" aria-label="Просмотрено">${DONE_ICON}</button>`}
            ${movie.url ? `<button class="icon-btn" type="button" data-action="open-url" data-url="${esc(movie.url)}" aria-label="Ссылка">${LINK_ICON}</button>` : ""}
            <button class="icon-btn" type="button" data-action="delete-item" data-type="movies" data-id="${movie.id}" aria-label="Удалить">${DELETE_ICON}</button>
          </div>
        </div>
        ${watched && movie.my_rating == null ? `<button class="secondary full card-action" type="button" data-action="rate-movie" data-id="${movie.id}">Оценить</button>` : ""}
      </article>
    `;
  }

  // Текущий выпавший фильм. Удалённый или просмотренный с другого устройства
  // тихо снимается с карточки — показывать нечего.
  function currentMoviePick() {
    if (!moviePickId) return null;
    const movie = movieList().find((item) => Number(item.id) === Number(moviePickId));
    if (!movie || Number(movie.watched) === 1) {
      moviePickId = null;
      return null;
    }
    return movie;
  }

  // Колода «Кино» — клон местской: перемешанный список id без повторов,
  // посещённое/удалённое выпадает, новое попадает в следующем цикле.
  function syncMovieDeck(pool) {
    const ids = new Set(pool.map((movie) => Number(movie.id)));
    movieDeck = movieDeck.filter((id) => ids.has(id));
    return pool;
  }

  function drawMovie() {
    const pool = syncMovieDeck(openMovies());
    if (!pool.length) {
      moviePickId = null;
      return null;
    }
    if (!movieDeck.length) {
      movieDeck = shuffleIds(pool.map((movie) => Number(movie.id)));
      // Не показывать то же место дважды подряд, если есть из чего выбрать.
      if (movieDeck.length > 1 && movieDeck[movieDeck.length - 1] === Number(moviePickId)) {
        [movieDeck[movieDeck.length - 1], movieDeck[0]] = [movieDeck[0], movieDeck[movieDeck.length - 1]];
      }
    }
    moviePickId = movieDeck.pop();
    return moviePickId;
  }

  function renderMoviePick(movie) {
    const length = formatMovieLength(movie);
    return `
      <article class="card place-pick movie-pick" aria-live="polite" data-action="open-movie" data-id="${movie.id}" role="button" tabindex="0" aria-label="Открыть описание: ${esc(movie.title)}">
        <p class="eyebrow">Вам выпало</p>
        <h2 class="place-pick-title">${esc(movie.title)}</h2>
        <div class="item-meta">
          ${ratingPill(movie.rating, movie.rating_source)}
          ${length ? `<span>${esc(length)}</span>` : ""}
        </div>
        <div class="place-actions">
          <button class="primary full" type="button" data-action="movie-watched" data-id="${movie.id}">Просмотрели</button>
          <button class="secondary full" type="button" data-action="random-movie">Следующее</button>
        </div>
      </article>
    `;
  }

  // Hero-карточка кино — информер, как у мест: до первого запуска рандома
  // на этом устройстве (флаг в localStorage), потом не нужна.
  const MOVIE_RANDOM_KEY = "duoplan.movieRandomUsed";
  function movieRandomUsed() {
    try { return localStorage.getItem(MOVIE_RANDOM_KEY) === "1"; } catch { return false; }
  }
  function markMovieRandomUsed() {
    try { localStorage.setItem(MOVIE_RANDOM_KEY, "1"); } catch {}
  }

  // Тело вкладки «Планы» для вида «Кино». «Рандом» живёт в карточке-информере
  // до первого запуска рандома (флаг в localStorage); после — карточка
  // исчезает, и кнопка возвращается отдельной, под «Добавить фильм».
  // Пустой список: «Добавить фильм» живёт в карточке «Пока пусто»,
  // карточка «Рандом» — под ней.
  // Сортировка списков «Кино». Выбор живёт отдельно для «В планах» и
  // «Просмотрено»: у просмотренных есть RAofP, у планов — нет.
  const MOVIE_SORT_OPTIONS = [
    ["added", "По добавлению"],
    ["year", "Год"],
    ["rating", "Оценка IMDb/TMDB"],
    ["runtime", "Длительность"],
    ["genre", "Жанр"],
    ["kind", "Фильм/сериал"]
  ];
  const MOVIE_SORT_DIR = {
    added: "desc", year: "desc", rating: "desc", runtime: "desc", genre: "asc", kind: "asc", raofp: "desc"
  };
  const movieSort = {
    open: { key: "added", dir: "desc" },
    watched: { key: "added", dir: "desc" }
  };

  function movieSortOptions(view) {
    return view === "watched" ? [...MOVIE_SORT_OPTIONS, ["raofp", "RAofP"]] : MOVIE_SORT_OPTIONS;
  }

  // Числовое/строковое значение ключа. null — «нет данных», такие записи
  // всегда уходят в конец независимо от направления.
  function movieSortValue(movie, key) {
    if (key === "added") return Number(movie.created_at) || 0;
    if (key === "year") return Number(movie.year) || null;
    if (key === "rating") return Number(movie.rating) > 0 ? Number(movie.rating) : null;
    if (key === "runtime") {
      // У сериала хронометража нет — длину сравниваем по числу серий.
      if (movie.kind === "series") return Number(movie.episodes) > 0 ? Number(movie.episodes) : null;
      return Number(movie.runtime) > 0 ? Number(movie.runtime) : null;
    }
    if (key === "genre") {
      const genre = movie.genres ? String(movie.genres).split(",")[0].trim().toLowerCase() : "";
      return genre || null;
    }
    if (key === "kind") return movie.kind === "series" ? "series" : "movie";
    if (key === "raofp") return Number(movie.pair_rating) > 0 ? Number(movie.pair_rating) : null;
    return null;
  }

  function sortMovies(list, view) {
    const { key, dir } = movieSort[view];
    const decorated = list.map((movie) => ({ movie, value: movieSortValue(movie, key) }));
    decorated.sort((a, b) => {
      const av = a.value;
      const bv = b.value;
      if (av === null && bv === null) return byRowId(a.movie.id, b.movie.id);
      if (av === null) return 1;
      if (bv === null) return -1;
      const cmp = typeof av === "string" ? av.localeCompare(bv, "ru") : av - bv;
      if (cmp === 0) return byRowId(a.movie.id, b.movie.id);
      return dir === "asc" ? cmp : -cmp;
    });
    return decorated.map(({ movie }) => movie);
  }

  function movieSortBar(view, count) {
    const state = movieSort[view];
    return `
      <div class="movie-sort">
        <span class="movie-sort-label">Сортировка</span>
        <div class="movie-sort-field">
          <select data-action="movie-sort-key" aria-label="Сортировка фильмов">
            ${movieSortOptions(view).map(([key, label]) => `<option value="${key}"${key === state.key ? " selected" : ""}>${esc(label)}</option>`).join("")}
          </select>
          <svg class="movie-sort-chevron" viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m6 9 6 6 6-6"/></svg>
        </div>
        <button class="icon-btn movie-sort-dir${state.dir === "asc" ? " is-asc" : ""}" type="button" data-action="movie-sort-dir" aria-label="${state.dir === "asc" ? "По возрастанию" : "По убыванию"}">
          <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 5v14M6 13l6 6 6-6"/></svg>
        </button>
        <span class="day-chip is-muted movie-sort-count">${count}</span>
      </div>
    `;
  }

  function renderMoviesBody() {
    return `
      ${renderSegment("movies", moviesView, [["open", "В планах"], ["watched", "Просмотрено"]], "is-sub")}
      <div id="movies-body">${renderMoviesList()}</div>
    `;
  }

  function renderMoviesList() {
    if (moviesView === "watched") {
      const watched = watchedMovies();
      if (!watched.length) {
        return `<section class="card"><h3>Пока ничего не просмотрено</h3><p>Отметьте фильм просмотренным в «В планах» — он появится здесь.</p></section>`;
      }
      return movieSortBar("watched", watched.length) + sortMovies(watched, "watched").map(movieItem).join("");
    }
    return renderOpenMovies();
  }

  function renderOpenMovies() {
    const open = openMovies();
    const watched = watchedMovies();
    const disabledClass = partnerMissing() ? " is-disabled" : "";
    const pick = currentMoviePick();
    const heroUsed = movieRandomUsed();
    let html = "";
    // Пустой список планов — как в «Кино»: «Добавить фильм» внутри карточки.
    if (!open.length) {
      html += `
        <section class="card">
          <h3>Пока пусто</h3>
          <p>${watched.length
            ? "Все фильмы просмотрены — добавьте новый или верните старый."
            : "Найдите фильм или сериал в IMDb — он появится здесь с рейтингом, жанром и длительностью."}</p>
          <button class="primary full card-action${disabledClass}" type="button" data-action="add-movie">Добавить фильм</button>
        </section>
      `;
    }
    // «Рандом» — кнопка внутри карточки-информера до первого запуска на этом
    // устройстве; после первого выбора карточка исчезает, а кнопка
    // возвращается отдельной — под «Добавить фильм».
    if (!heroUsed) {
      html += `
        <section class="card place-hero movie-hero">
          <p class="eyebrow">Рандом</p>
          <h3>Не знаете, что посмотреть?</h3>
          <p>Приложение выберет случайный фильм или сериал из избранного. Отметить просмотр можно отдельно — уже после титров.</p>
          <button class="secondary full card-action${disabledClass}" type="button" data-action="random-movie">Рандом</button>
        </section>
      `;
    }
    if (pick) html += renderMoviePick(pick);
    if (open.length) {
      html += `<button class="primary full add-button${disabledClass}" type="button" data-action="add-movie">Добавить фильм</button>`;
      if (heroUsed) html += `<button class="secondary full place-random" type="button" data-action="random-movie">Рандом</button>`;
      // На месте прежнего заголовка «Хотим посмотреть» — сортировка списка.
      html += movieSortBar("open", open.length);
      html += sortMovies(open, "open").map(movieItem).join("");
    }
    return html;
  }

  // Списки вкладки «Вишлист» отдельно от переключателя: при смене вида
  // перерисовывается только этот блок — экземпляр капли не пересоздаётся.
  function renderWishLists() {
    const wishDisabledClass = partnerMissing() ? " is-disabled" : "";
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
    let html = "";
    if (isMine) {
      if (openWishes.length || doneWishes.length) {
        html += `<button class="primary full add-button${wishDisabledClass}" type="button" data-action="add-wish">Добавить желание</button>`;
        html += openWishes.map((item) => wishItem(item, true)).join("");
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
    return html;
  }

  function render() {
    // Разметка ниже перезаписывается целиком — экземпляры капли снимаем
    // заранее, иначе они остались бы висеть на window-слушателях.
    destroySwitches();
    // Акцент мог измениться (настройки/тема) — пере-применяем на каждом рендере.
    applyAccent();
    syncArchiveCachePair();
    syncTopControls();
    if (!appUnlocked && storedPin()) {
      appEl.innerHTML = renderLock();
      mountLock();
      return;
    }
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
      // Шапка одна на оба вида «Планы/Кино»: переключатель меняет только
      // тело, поэтому капля остаётся живой и доезжает пружиной.
      appEl.innerHTML = `
        ${renderTabHeader("tasks")}
        ${renderSegment("tasks", tasksView, [["plans", "Планы"], ["movies", "Кино"]])}
        <div id="tab-body">${tasksView === "movies" ? renderMoviesBody() : renderTasksBody()}</div>
      `;
    } else if (currentTab === "dates") {
      // Шапка одна на оба вида: переключатель меняет только тело, поэтому
      // капля остаётся живой и доезжает пружиной.
      appEl.innerHTML = `
        ${renderTabHeader("dates")}
        ${renderSegment("dates", datesView, [["dates", "Наше"], ["birthdays", "Дни рождения"]])}
        <div id="tab-body">${renderDatesBody()}</div>
      `;
    } else if (currentTab === "places") {
      appEl.innerHTML = renderPlaces();
    } else if (currentTab === "memories") {
      appEl.innerHTML = `
        ${renderTabHeader("memories")}
        ${renderSegment("memories", memoriesView, [["memories", "Записи"], ["quotes", "Цитаты"]])}
        <div id="tab-body">${renderMemoriesBody()}</div>
      `;
    } else if (currentTab === "pair") {
      appEl.innerHTML = `
        ${renderTabHeader("pair")}
        ${renderSegment("pair", pairView, [["profile", "Профиль"], ["wishes", "Желания"], ["savings", "Копилка"]])}
        <div id="pair-body">${renderPairView()}</div>
      `;
      // Если активных записей больше лимита /api/state, календарь догружает
      // страницы архива в фоне и перерисовывается сам.
      ensureCalendarArchive();
    }
    mountTabSwitch();
    mountWishSwitch();
    mountMovieSwitch();
    mountPinFields();
  }

  // ------------------------------------------------------------------
  // Сегмент-переключатели внутри вкладок: та же капля, что в нижней панели
  // ------------------------------------------------------------------
  // Виды («Профиль / Желания», «Наше / Дни рождения», «Записи / Цитаты»,
  // «Мои / Её») — те же вкладки, но внутри страницы. Разметка вкладки
  // перерисовывается целиком, поэтому экземпляры снимаем в начале render() и
  // создаём в конце; переключение вида меняет только тело (#tab-body или
  // #pair-body), и капля доезжает пружиной, как в главном баре.
  let segSwitch = null;      // переключатель вида текущей вкладки
  let wishSwitch = null;     // внутренний «Мои / Её» в желаниях
  let wishSwitchPrevView = null;
  let movieSwitch = null;    // внутренний «В планах / Просмотрено» в кино

  function switchValue(key) {
    if (key === "pair") return pairView;
    if (key === "dates") return datesView;
    if (key === "memories") return memoriesView;
    if (key === "tasks") return tasksView;
    return wishView;
  }

  function setSwitchValue(key, value) {
    if (key === "pair") pairView = value;
    else if (key === "dates") datesView = value;
    else if (key === "memories") memoriesView = value;
    else if (key === "tasks") tasksView = value;
    else wishView = value;
  }

  function destroySwitches() {
    if (segSwitch) { segSwitch.destroy(); segSwitch = null; }
    if (wishSwitch) { wishSwitch.destroy(); wishSwitch = null; }
    if (movieSwitch) { movieSwitch.destroy(); movieSwitch = null; }
  }

  function createSwitch(container, key) {
    const items = Array.from(container.querySelectorAll("[data-tab]"));
    if (!window.createLiquidNav || items.length < 2) return null;
    const instance = window.createLiquidNav({
      nav: container,
      items,
      // В переключателе обычный цвет — это цвет подписи на стекле.
      idleVar: "--nav-label",
      onCommit: (value) => commitSwitch(key, value, instance)
    });
    if (!instance) return null;
    instance.setActive(switchValue(key), false);
    return instance;
  }

  function mountTabSwitch() {
    const container = document.querySelector(".seg-switch[data-switch]");
    segSwitch = container ? createSwitch(container, container.dataset.switch) : null;
  }

  function mountWishSwitch() {
    const container = document.querySelector(".wish-switch");
    if (!container) {
      wishSwitchPrevView = null;
      return;
    }
    const instance = createSwitch(container, "wishes");
    if (!instance) return;
    // Вид запоминаем, чтобы капля приезжала с прежнего места, а не появлялась
    // сразу на новом.
    if (wishSwitchPrevView && wishSwitchPrevView !== wishView) {
      instance.setActive(wishSwitchPrevView, false);
      instance.setActive(wishView, true);
    }
    wishSwitch = instance;
    wishSwitchPrevView = wishView;
  }

  // Внутренний бар «В планах / Просмотрено»: отдельный экземпляр капли,
  // потому что он живёт внутри тела «Кино», а не на уровне вкладки.
  function mountMovieSwitch() {
    if (movieSwitch) {
      movieSwitch.destroy();
      movieSwitch = null;
    }
    const container = document.querySelector('.seg-switch[data-switch="movies"]');
    if (!container || !window.createLiquidNav) return;
    const items = Array.from(container.querySelectorAll("[data-tab]"));
    if (items.length < 2) return;
    const instance = window.createLiquidNav({
      nav: container,
      items,
      idleVar: "--nav-label",
      onCommit: (value) => commitMoviesView(value, instance)
    });
    if (!instance) return;
    instance.setActive(moviesView, false);
    movieSwitch = instance;
  }

  // Переключение «В планах / Просмотрено»: меняем только список, чтобы капля
  // и сам бар остались живыми.
  function commitMoviesView(value, instance) {
    if (moviesView === value) return;
    moviesView = value;
    const body = document.getElementById("movies-body");
    if (!body) { render(); return; }
    body.innerHTML = renderMoviesList();
    instance?.setActive(value, true);
    document.querySelectorAll('.seg-switch[data-switch="movies"] .seg-switch-btn').forEach((btn) => {
      btn.setAttribute("aria-selected", String(btn.dataset.tab === value));
    });
  }

  // Перерисовка только списка: бар и его капля остаются на месте.
  function refreshMoviesList() {
    const body = document.getElementById("movies-body");
    if (!body) { render(); return; }
    body.innerHTML = renderMoviesList();
  }

  function setMovieSortKey(key) {
    const state = movieSort[moviesView];
    if (!state || state.key === key) return;
    if (!movieSortOptions(moviesView).some(([value]) => value === key)) return;
    state.key = key;
    state.dir = MOVIE_SORT_DIR[key] || "desc";
    refreshMoviesList();
  }

  function toggleMovieSortDir() {
    const state = movieSort[moviesView];
    if (!state) return;
    state.dir = state.dir === "asc" ? "desc" : "asc";
    refreshMoviesList();
  }

  // Переключение вида: меняем только тело вкладки, чтобы капля и сам
  // переключатель остались живыми.
  function commitSwitch(key, value, instance) {
    if (switchValue(key) === value) return;
    setSwitchValue(key, value);
    if (key === "wishes") {
      const lists = document.getElementById("wish-lists");
      if (!lists) { render(); return; }
      lists.innerHTML = renderWishLists();
      instance?.setActive(value, true);
      document.querySelectorAll(".wish-switch-btn[data-tab]").forEach((btn) => {
        btn.setAttribute("aria-selected", String(btn.dataset.tab === value));
      });
      return;
    }
    const body = document.getElementById(key === "pair" ? "pair-body" : "tab-body");
    if (!body) { render(); return; }
    // Внутренний переключатель желаний живёт в перерисовываемом теле — его
    // экземпляр снимаем до замены разметки, иначе останутся window-слушатели.
    if (key === "pair" && wishSwitch) {
      wishSwitch.destroy();
      wishSwitch = null;
    }
    // Внутренний бар «В планах / Просмотрено» живёт в перерисовываемом теле
    // «Кино» — снимаем экземпляр до замены разметки.
    if (key === "tasks" && movieSwitch) {
      movieSwitch.destroy();
      movieSwitch = null;
    }
    body.innerHTML = key === "pair" ? renderPairView()
      : key === "dates" ? renderDatesBody()
        : key === "tasks" ? (tasksView === "movies" ? renderMoviesBody() : renderTasksBody())
          : renderMemoriesBody();
    instance?.setActive(value, true);
    // aria-selected обновляем у всех сегментов, а не только у желаний:
    // капля двигается классами, скринридер читает атрибут.
    document.querySelectorAll(`.seg-switch[data-switch="${key}"] .seg-switch-btn`).forEach((btn) => {
      btn.setAttribute("aria-selected", String(btn.dataset.tab === value));
    });
    if (key === "pair") mountWishSwitch();
    if (key === "tasks" && tasksView === "movies") mountMovieSwitch();
  }

  // ------------------------------------------------------------------
  // Диалоги создания записей
  // ------------------------------------------------------------------
  function openDialog(config) {
    dialogContext = config;
    dialogTitle.textContent = config.title;
    dialogFields.innerHTML = config.fields ?? "";
    if (dialogSubmit) {
      dialogSubmit.textContent = config.submitLabel ?? "Сохранить";
      // submitLabel === null — режим чтения (просмотр дневника): без кнопки
      // сохранения, только «Закрыть».
      dialogSubmit.hidden = config.submitLabel === null;
    }
    if (dialogCancel) dialogCancel.textContent = config.cancelLabel ?? "Отмена";
    dialog.showModal();
    // Страница за диалогом блокируется от скролла (касания по фону и
    // резиновая прокрутка не двигают контент под окном). Класс на корне:
    // overflow:hidden на body в части WebView не доходил до вьюпорта.
    document.documentElement.classList.add("dialog-locked");
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
    if (!(target instanceof HTMLInputElement)) return;
    const form = target.closest("form");
    // Повторы требуют дату: без неё повторять нечего.
    if (target.hasAttribute("data-requires-day")) {
      const dayInput = form?.querySelector('input[name="day"]');
      if (dayInput) dayInput.required = Boolean(target.value);
    }
    // Ежемесячный и ежегодный повторы взаимоисключающие.
    if (target.type === "checkbox" && target.dataset.excludes) {
      const other = form?.querySelector(`input[name="${target.dataset.excludes}"]`);
      if (other && target.checked) other.checked = false;
    }
  });

  // ------------------------------------------------------------------
  // Живые подсказки IMDb в диалоге «Добавить фильм»: печатаем название —
  // приходят совпадения; тап по строке сразу добавляет фильм и закрывает
  // диалог. Слушатели вешаются один раз на постоянный #dialog-fields,
  // как input-обработчик выше, поэтому на каждое открытие диалога ничего
  // не накопится.
  // ------------------------------------------------------------------
  // PIN-поля: видимая часть — 4 ячейки (точка или цифра), реальный инпут —
  // невидимый слой поверх (тап открывает цифровую клавиатуру, курсора нет).
  // Нативный плейсхолдер не используем: на мобильных он мигает вместе с
  // вводом — ячейки рисуем сами, цифра встаёт на своё место и не исчезает.
  function pinField(id, extraAttrs = "") {
    return `
      <span class="pin-field">
        <span class="pin-cells" id="${id}-cells" aria-hidden="true">
          <span class="pin-cell"></span><span class="pin-cell"></span><span class="pin-cell"></span><span class="pin-cell"></span>
        </span>
        <input id="${id}" class="pin-real" type="text" inputmode="numeric" pattern="[0-9]*" maxlength="4" autocomplete="off" aria-label="ПИН-код, четыре цифры" ${extraAttrs}>
      </span>
    `;
  }

  function renderPinCells(input) {
    const wrap = document.getElementById(`${input.id}-cells`);
    if (!wrap) return;
    const digits = input.value.replace(/\D/g, "").slice(0, 4);
    if (digits !== input.value) input.value = digits;
    [...wrap.querySelectorAll(".pin-cell")].forEach((cell, index) => {
      const digit = digits[index];
      cell.textContent = digit || "•";
      cell.classList.toggle("is-filled", Boolean(digit));
    });
  }

  document.addEventListener("input", (e) => {
    const target = e.target;
    if (!(target instanceof HTMLInputElement) || !target.classList.contains("pin-real")) return;
    renderPinCells(target);
  });

  // Первичное наполнение ячеек точками после каждой отрисовки экрана с PIN.
  function mountPinFields() {
    document.querySelectorAll("input.pin-real").forEach(renderPinCells);
  }

  let movieSuggestTimer = null;
  let movieSuggestSeq = 0;
  const MOVIE_SUGGEST_DEBOUNCE_MS = 350;

  function movieSuggestMeta(movie) {
    const type = movie.kind === "series" ? "сериал" : "фильм";
    return movie.year ? `${movie.year} · ${type}` : type;
  }

  function renderMovieSuggestions(box, results) {
    if (!results.length) {
      box.innerHTML = `<p class="movie-suggest-hint">Ничего не нашлось — попробуйте оригинальное название.</p>`;
      return;
    }
    box.innerHTML = results.map((movie) => `
      <button class="movie-suggest-item" type="button"
        data-imdb-id="${esc(movie.imdb_id)}" data-title="${esc(movie.title)}" data-year="${esc(movie.year || "")}">
        <span class="movie-suggest-title">${esc(movie.title)}</span>
        <span class="movie-suggest-meta">${esc(movieSuggestMeta(movie))}</span>
      </button>
    `).join("");
  }

  dialogFields.addEventListener("input", (e) => {
    const target = e.target;
    if (!(target instanceof HTMLInputElement) || target.name !== "q") return;
    const box = dialogFields.querySelector(".movie-suggest");
    if (!box) return;
    clearTimeout(movieSuggestTimer);
    const query = target.value.trim();
    if (query.length < 2) {
      box.innerHTML = `<p class="movie-suggest-hint">Начните печатать — здесь появятся совпадения с IMDb.</p>`;
      return;
    }
    box.innerHTML = `<p class="movie-suggest-hint">Ищем на IMDb…</p>`;
    const seq = ++movieSuggestSeq;
    movieSuggestTimer = setTimeout(async () => {
      try {
        const data = await request(`/api/movies/search?q=${encodeURIComponent(query)}`);
        if (seq !== movieSuggestSeq) return;
        renderMovieSuggestions(box, data?.results || []);
      } catch (error) {
        if (seq !== movieSuggestSeq) return;
        box.innerHTML = `<p class="movie-suggest-hint">${esc(error?.message || "Не удалось получить подсказки")}</p>`;
      }
    }, MOVIE_SUGGEST_DEBOUNCE_MS);
  });

  dialogFields.addEventListener("click", async (e) => {
    const btn = e.target.closest?.(".movie-suggest-item");
    if (!btn || !dialogContext || dialogSubmitting) return;
    dialogSubmitting = true;
    dialogFields.querySelectorAll(".movie-suggest-item").forEach((item) => { item.disabled = true; });
    try {
      appState = await request("/api/movies", {
        method: "POST",
        body: { imdb_id: btn.dataset.imdbId, year: btn.dataset.year || undefined }
      });
      dialog.close();
      render();
      showToast(`Добавлено: ${btn.dataset.title}`);
    } catch (error) {
      // 409 «уже в списке» и прочие ошибки показываем тостом и возвращаем
      // диалог к жизни — можно продолжить поиск.
      handleRequestError(error);
      dialogFields.querySelectorAll(".movie-suggest-item").forEach((item) => { item.disabled = false; });
    } finally {
      dialogSubmitting = false;
    }
  });
  dialogForm.addEventListener("submit", async (e) => {
    e.preventDefault();
    if (!dialogContext || dialogSubmitting) return;
    // Диалог-«пикер» (поиск фильмов, история копилки): без кнопки сохранения,
    // Enter и прочие нативные сабмиты не должны его закрывать.
    if (dialogContext.readOnly) return;
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
  // Сортировка «Кино»: смена критерия перерисовывает только список.
  document.addEventListener("change", (e) => {
    const select = e.target.closest?.('[data-action="movie-sort-key"]');
    if (select) setMovieSortKey(select.value);
  });

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
      // Повторный тап по пилюле пары не уводит со вкладки: из «Желаний» и
      // «Копилки» возвращает в «Профиль», в «Профиле» ничего не делает.
      if (pairView !== "profile") commitSwitch("pair", "profile", segSwitch);
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
      if (["add-task", "add-date", "add-memory", "add-wish", "add-quote", "add-place", "add-movie", "add-saving", "add-birthday"].includes(action) && partnerMissing()) {
        showToast("Сначала добавьте партнёра");
        return;
      }
      if (action === "close-dialog") {
        dialog.close();
      } else if (action === "seg-switch") {
        // Переключение вида внутри вкладки: меняем только тело, капля и сам
        // переключатель остаются живыми.
        const key = btn.dataset.switch || "";
        const value = btn.dataset.tab || "";
        if (key === "movies") {
          commitMoviesView(value, movieSwitch);
          return;
        }
        if (!["pair", "dates", "memories", "tasks"].includes(key)) return;
        commitSwitch(key, value, segSwitch);
      } else if (action === "movie-sort-dir") {
        toggleMovieSortDir();
      } else if (action === "calendar-prev") {
        shiftCalendarMonth(-1);
      } else if (action === "calendar-next") {
        shiftCalendarMonth(1);
      } else if (action === "calendar-day") {
        selectCalendarDay(btn.dataset.day);
      } else if (action === "show-in-calendar") {
        // Переход к месяцу события из списка: выбираем день и открываем
        // вкладку календаря. Состояние задаём напрямую — промежуточный
        // render() текущей вкладки не нужен. Календарь живёт в виде
        // «Профиль» — вид переключателя возвращаем, иначе попали бы в
        // «Желания»/«Копилку» с последнего визита.
        const day = btn.dataset.day || "";
        if (/^\d{4}-\d{2}-\d{2}$/.test(day)) {
          const [year, month] = day.split("-").map(Number);
          calendarMonth = { year, month };
          calendarSelected = day;
        }
        pairView = "profile";
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
            <label class="field"><span>Время (необязательно)</span><input type="time" name="time" data-requires-day lang="ru"></label>
            <label class="field"><span><input type="checkbox" name="monthly" data-requires-day data-excludes="yearly"> Повторять каждый месяц</span></label>
            <label class="field"><span><input type="checkbox" name="yearly" data-requires-day data-excludes="monthly"> Повторять каждый год</span></label>
            <label class="field"><span><input type="checkbox" name="is_private"> Личный — партнёр не увидит, в уведомлениях будет «Скрытый»</span></label>
          `,
          onSubmit: (fd) => request("/api/tasks", { method: "POST", body: { title: fd.get("title"), day: fd.get("day"), time: fd.get("time"), monthly: fd.get("monthly") === "on", yearly: fd.get("yearly") === "on", is_private: fd.get("is_private") === "on" } })
        });
      } else if (action === "add-date") {
        openDialog({
          title: "Значимая дата",
          fields: `
            <label class="field"><span>Название</span><input name="title" maxlength="120" required placeholder="День нашего знакомства"></label>
            <label class="field"><span>Дата</span><input type="date" name="day" required></label>
            <label class="field"><span>Время (необязательно)</span><input type="time" name="time" lang="ru"></label>
            <label class="field"><span><input type="checkbox" name="monthly" data-excludes="recurs"> Повторять каждый месяц</span></label>
            <label class="field"><span><input type="checkbox" name="recurs" checked data-excludes="monthly"> Повторять каждый год</span></label>
            <label class="field"><span><input type="checkbox" name="is_private"> Личная — партнёр не увидит эту дату</span></label>
          `,
          onSubmit: (fd) => request("/api/dates", { method: "POST", body: { title: fd.get("title"), day: fd.get("day"), time: fd.get("time"), monthly: fd.get("monthly") === "on", recurs: fd.get("recurs") === "on", is_private: fd.get("is_private") === "on" } })
        });
      } else if (action === "add-memory") {
        openDialog({
          title: "Запись в дневник",
          fields: `<label class="field"><span>Заголовок</span><input name="title" maxlength="180" required placeholder="Тёплый вечер у реки"></label>
           <label class="field"><span>Воспоминание</span><textarea name="body" rows="4" maxlength="2000" required placeholder="Сегодня был тёплый вечер…"></textarea></label>`,
          onSubmit: (fd) => request("/api/memories", { method: "POST", body: { title: fd.get("title"), body: fd.get("body") } })
        });
      } else if (action === "add-wish") {
        openDialog({
          title: "Новое желание",
          fields: `<label class="field"><span>О чём мечтаете?</span><input name="body" maxlength="300" required placeholder="Плёночный фотоаппарат"></label>
           <label class="field"><span>Ссылка (необязательно)</span><input name="url" type="url" placeholder="https://example.com"></label>`,
          onSubmit: (fd) => request("/api/wishes", { method: "POST", body: { body: fd.get("body"), url: fd.get("url") } })
        });
      } else if (action === "add-quote") {
        openDialog({
          title: "Новая цитата",
          fields: `
            <label class="field"><span>Цитата</span><textarea name="body" rows="4" maxlength="600" required placeholder="Мы в ответе за тех, кого приручили"></textarea></label>
            <label class="field"><span>Автор</span><select name="source">${quoteAuthorOptions("")}</select></label>
          `,
          onSubmit: (fd) => request("/api/quotes", { method: "POST", body: { body: fd.get("body"), source: fd.get("source") } })
        });
      } else if (action === "add-place") {
        openDialog({
          title: "Новое место",
          fields: `
            <label class="field"><span>Куда сходить?</span><input name="title" maxlength="120" required placeholder="Крыша с видом на город"></label>
            <label class="field"><span>Заметка (необязательно)</span><textarea name="note" rows="3" maxlength="600" placeholder="Почему хочется именно сюда"></textarea></label>
            <label class="field"><span>Ссылка на карту (необязательно)</span><input name="url" type="url" placeholder="https://maps.example.com/..."></label>
          `,
          onSubmit: (fd) => request("/api/places", { method: "POST", body: { title: fd.get("title"), note: fd.get("note"), url: fd.get("url") } })
        });
      } else if (action === "add-movie") {
        // Диалог поиска: без кнопки сохранения — фильм добавляется тапом
        // по подсказке (механика в делегированном слушателе dialogFields).
        // readOnly гасит нативный сабмит по Enter — диалог не закрывается.
        openDialog({
          title: "Добавить фильм",
          submitLabel: null,
          readOnly: true,
          cancelLabel: "Закрыть",
          fields: `
            <label class="field"><span>Название на IMDb</span><input name="q" type="text" autocomplete="off" placeholder="Интерстеллар, Дюна, Во все тяжкие…"></label>
            <div class="movie-suggest" aria-live="polite"><p class="movie-suggest-hint">Начните печатать — здесь появятся совпадения с IMDb.</p></div>
          `,
          onSubmit: async () => appState
        });
      } else if (action === "add-saving") {
        openDialog({
          title: "Новая копилка",
          fields: `
            <label class="field"><span>Название</span><input name="title" maxlength="120" required placeholder="Поездка на море"></label>
            <label class="field"><span>Сколько нужно накопить</span><input name="target" type="number" inputmode="numeric" min="1" step="1" required placeholder="30000"></label>
            <label class="field"><span>Тип копилки</span><select name="kind">
              <option value="shared">Общая — пополняете вдвоём</option>
              <option value="personal">Личная — видна только вам</option>
            </select></label>
          `,
          onSubmit: (fd) => request("/api/savings", {
            method: "POST",
            body: { title: fd.get("title"), target: Number(fd.get("target")), kind: fd.get("kind") }
          })
        });
      } else if (action === "add-birthday") {
        openDialog({
          title: "День рождения",
          fields: `
            <label class="field"><span>Кто именинник?</span><input name="title" maxlength="120" required placeholder="Маша"></label>
            <label class="field"><span>Дата рождения</span><input type="date" name="day" required></label>
            <label class="field"><span><input type="checkbox" name="is_private"> Личное — партнёр не увидит и не получит напоминание</span></label>
          `,
          onSubmit: (fd) => request("/api/dates", { method: "POST", body: { title: fd.get("title"), day: fd.get("day"), kind: "birthday", is_private: fd.get("is_private") === "on" } })
        });
      } else if (action === "daily-done") {
        btn.disabled = true;
        try {
          appState = await request("/api/daily/done", { method: "POST", body: {} });
          showToast(appState?.awarded === false ? "Ритуал уже отмечен сегодня" : "Ритуал выполнен +10 XP");
          render();
        } catch (error) {
          btn.disabled = false;
          throw error;
        }
      } else if (action === "done-item") {
        // Подтверждение в едином стиле: случайный тап по ✓ не завершает запись.
        const typeNames = { tasks: "план", wishes: "желание" };
        const name = typeNames[btn.dataset.type] || "запись";
        const isWish = btn.dataset.type === "wishes";
        openDialog({
          title: isWish ? "Исполнено?" : "Выполнено?",
          fields: `<p style="margin:2px 0 0;">Отметить ${name} как ${isWish ? "исполненное" : "выполненное"}? Запись переедет в завершённые.</p>`,
          submitLabel: isWish ? "Да, исполнено" : "Да, выполнено",
          onSubmit: async () => {
            appState = await request(`/api/${btn.dataset.type}/${btn.dataset.id}/done`, { method: "POST", body: {} });
            return appState;
          }
        });
      } else if (action === "place-visited" || action === "place-unvisited") {
        const id = btn.dataset.id;
        const markVisited = action === "place-visited";
        const place = placeList().find((item) => Number(item.id) === Number(id));
        btn.disabled = true;
        try {
          appState = await request(`/api/places/${id}/${markVisited ? "visited" : "unvisited"}`, { method: "POST", body: {} });
          if (markVisited) {
            // Показ и подтверждение — разные действия: место уходит в
            // «Посещённые» и больше не участвует в рандоме.
            placePickId = null;
            showToast(place ? `Отмечено: ${place.title}` : "Отмечено: мы были здесь");
          } else {
            showToast(place ? `«${place.title}» снова в списке` : "Место вернулось в список");
          }
          render();
        } finally {
          btn.disabled = false;
        }
      } else if (action === "random-place") {
        if (!drawPlace()) {
          showToast("Все места уже посещены");
          return;
        }
        // Первый успешный запуск гасит hero-информер на этом устройстве.
        markPlaceRandomUsed();
        render();
        // Карточка результата вставляется над кнопками — на телефоне она
        // может оказаться ниже сгиба, поэтому мягко доводим её в поле зрения.
        document.querySelector(".place-pick")?.scrollIntoView({
          behavior: window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth",
          block: "nearest"
        });
      } else if (action === "movie-watched") {
        // Оценка обязательна: без неё сервер не переведёт карточку
        // в «Просмотренные», а RAofP не из чего считать.
        const movie = movieList().find((item) => Number(item.id) === Number(btn.dataset.id));
        if (!movie) return;
        openRatingDialog(movie, {
          path: `/api/movies/${movie.id}/watched`,
          hint: "Поставьте оценку от 1 до 10 — без неё карточка не попадёт в «Просмотренные».",
          toast: `Просмотрено: ${movie.title}`,
          clearPick: true
        });
      } else if (action === "movie-unwatched") {
        const id = btn.dataset.id;
        const movie = movieList().find((item) => Number(item.id) === Number(id));
        btn.disabled = true;
        try {
          appState = await request(`/api/movies/${id}/unwatched`, { method: "POST", body: {} });
          showToast(movie ? `«${movie.title}» снова в списке` : "Фильм вернулся в список");
          render();
        } finally {
          btn.disabled = false;
        }
      } else if (action === "rate-movie") {
        // Второй партнёр: кнопка «Оценить» в карточке «Просмотренные».
        const movie = movieList().find((item) => Number(item.id) === Number(btn.dataset.id));
        if (!movie) return;
        openRatingDialog(movie, {
          path: `/api/movies/${movie.id}/rate`,
          hint: "Оценка войдёт в RAofP — среднее по вашей паре.",
          toast: "Оценка сохранена"
        });
      } else if (action === "open-movie") {
        // Тап по карточке: описание и детали в окне. Кнопки внутри карточки
        // (просмотрено/ссылка/удалить/оценить) ловятся раньше — у них свой
        // data-action, closest находит кнопку, а не карточку.
        const movie = movieList().find((item) => Number(item.id) === Number(btn.dataset.id));
        if (movie) openMovieDetails(movie);
      } else if (action === "random-movie") {
        if (!drawMovie()) {
          showToast("Всё из списка уже просмотрено");
          return;
        }
        // Первый успешный запуск гасит hero-информер на этом устройстве.
        markMovieRandomUsed();
        render();
        document.querySelector(".movie-pick")?.scrollIntoView({
          behavior: window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth",
          block: "nearest"
        });
      } else if (action === "deposit-saving") {
        const saving = savingsList().find((item) => Number(item.id) === Number(btn.dataset.id));
        if (!saving) return;
        openDialog({
          title: `Пополнить «${saving.title}»`,
          fields: `
            <label class="field"><span>Сумма пополнения</span><input name="amount" type="number" inputmode="numeric" min="1" step="1" required placeholder="5000"></label>
            <p class="settings-hint">Сейчас собрано ${esc(formatAmount(saving.collected))} из ${esc(formatAmount(saving.target))}.</p>
          `,
          submitLabel: "Пополнить",
          onSubmit: async (fd) => {
            const state = await request(`/api/savings/${saving.id}/deposit`, {
              method: "POST",
              body: { amount: Number(fd.get("amount")) }
            });
            showToast(`Пополнено на ${esc(formatAmount(fd.get("amount")))}`);
            return state;
          }
        });
      } else if (action === "edit-saving") {
        const saving = savingsList().find((item) => Number(item.id) === Number(btn.dataset.id));
        if (!saving) return;
        openDialog({
          title: "Редактировать копилку",
          fields: `
            <label class="field"><span>Название</span><input name="title" maxlength="120" required value="${esc(saving.title)}"></label>
            <label class="field"><span>Сколько нужно накопить</span><input name="target" type="number" inputmode="numeric" min="1" step="1" required value="${esc(saving.target)}"></label>
          `,
          onSubmit: (fd) => request(`/api/savings/${saving.id}`, {
            method: "PATCH",
            body: { title: fd.get("title"), target: Number(fd.get("target")) }
          })
        });
      } else if (action === "open-saving") {
        const saving = savingsList().find((item) => Number(item.id) === Number(btn.dataset.id));
        if (!saving) return;
        openDialog({
          title: saving.title,
          submitLabel: null,
          readOnly: true,
          cancelLabel: "Закрыть",
          fields: `<div class="saving-history" aria-live="polite"><p class="movie-suggest-hint">Загружаем историю…</p></div>`,
          onSubmit: async () => appState
        });
        try {
          const data = await request(`/api/savings/${saving.id}/history`);
          const box = dialogFields.querySelector(".saving-history");
          if (!box) return;
          const rows = data.deposits || [];
          box.innerHTML = rows.length
            ? rows.map((row) => `
                <div class="saving-history-row">
                  <span class="saving-history-name">${esc(row.display_name || "Партнёр")}</span>
                  <span class="saving-history-amount">+${esc(formatAmount(row.amount))}</span>
                  <span class="saving-history-date">${esc(formatTimestamp(row.created_at))}</span>
                </div>
              `).join("")
            : `<p class="movie-suggest-hint">Пополнений пока не было — нажмите «Плюс» на карточке.</p>`;
        } catch (error) {
          handleRequestError(error);
          dialog.close();
        }
      } else if (action === "delete-item") {
        const typeNames = { tasks: "план", dates: "дату", memories: "запись", wishes: "желание", quotes: "цитату", places: "место", movies: "фильм", savings: "копилку" };
        const item = findItem(btn.dataset.type, btn.dataset.id);
        // У дня рождения своё название: «Удалить дату?» звучало бы странно.
        const name = btn.dataset.type === "dates" && item?.kind === "birthday"
          ? "день рождения"
          : (typeNames[btn.dataset.type] || "запись");
        // Родное confirm() заменено диалогом приложения — в едином стиле.
        openDialog({
          title: `Удалить ${name}?`,
          fields: `<p style="margin:2px 0 0;">Это действие нельзя отменить.</p>`,
          submitLabel: "Удалить",
          onSubmit: async () => {
            appState = await request(`/api/${btn.dataset.type}/${btn.dataset.id}`, { method: "DELETE" });
            // Из appState удалённая запись уходит сразу, но в кэше архива она
            // осталась бы и продолжала отображаться (и повторное удаление дало бы 404).
            removeFromArchiveCache(btn.dataset.type, btn.dataset.id);
            return appState;
          }
        });
      } else if (action === "open-memory") {
        // Чтение дневника на весь экран: карточка кликабельна и из списка,
        // и с главной. Кнопка сохранения скрыта — только «Закрыть».
        const item = findItem("memories", btn.dataset.id);
        if (!item) {
          showToast("Запись не найдена");
          return;
        }
        openDialog({
          title: "Запись дневника",
          fields: `
            ${item.title ? `<h3 class="memory-view-title">${renderRichText(item.title)}</h3>` : ""}
            <div class="memory-view-body">${renderRichText(item.body || "")}</div>
            <div class="item-meta" style="margin-top:12px;">
              <span>${esc(item.display_name || "Партнёр")}</span>
              <span>· ${esc(formatDay(item.day))}</span>
            </div>
          `,
          submitLabel: null,
          cancelLabel: "Закрыть",
          onSubmit: async () => appState
        });
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
              <label class="field"><span>Время (необязательно)</span><input type="time" name="time" value="${esc(item.time || "")}" data-requires-day lang="ru"></label>
              <label class="field"><span><input type="checkbox" name="monthly" data-requires-day data-excludes="yearly" ${Number(item.monthly) === 1 ? "checked" : ""}> Повторять каждый месяц</span></label>
              <label class="field"><span><input type="checkbox" name="yearly" data-requires-day data-excludes="monthly" ${Number(item.monthly) !== 1 && item.yearly ? "checked" : ""}> Повторять каждый год</span></label>
              ${ownsPrivacy ? `<label class="field"><span><input type="checkbox" name="is_private" ${item.is_private ? "checked" : ""}> Личный — партнёр не увидит, в уведомлениях будет «Скрытый»</span></label>` : ""}
            `,
            onSubmit: async (fd) => {
              const body = { title: fd.get("title"), day: fd.get("day"), time: fd.get("time"), monthly: fd.get("monthly") === "on", yearly: fd.get("yearly") === "on", is_private: ownsPrivacy ? fd.get("is_private") === "on" : undefined };
              const state = await request(`/api/tasks/${id}`, { method: "PATCH", body });
              patchArchiveItem("tasks", id, body);
              return state;
            }
          });
        } else if (type === "dates") {
          // Чекбокс приватности видит только автор: партнёр чужую дату
          // «личной» сделать не может, сервер его флаг всё равно игнорирует.
          const ownsPrivacy = Number(item.created_by) === Number(appState.user.tg_id);
          // У дня рождения своя форма: ни времени, ни повторов — только имя,
          // дата и приватность.
          if (item.kind === "birthday") {
            openDialog({
              title: "Редактировать день рождения",
              fields: `
                <label class="field"><span>Кто именинник?</span><input name="title" maxlength="120" required value="${esc(item.title || "")}"></label>
                <label class="field"><span>Дата рождения</span><input type="date" name="day" required value="${esc(item.day || "")}"></label>
                ${ownsPrivacy ? `<label class="field"><span><input type="checkbox" name="is_private" ${item.is_private ? "checked" : ""}> Личное — партнёр не увидит и не получит напоминание</span></label>` : ""}
              `,
              onSubmit: (fd) => request(`/api/dates/${id}`, { method: "PATCH", body: { title: fd.get("title"), day: fd.get("day"), is_private: ownsPrivacy ? fd.get("is_private") === "on" : undefined } })
            });
            return;
          }
          openDialog({
            title: "Редактировать дату",
            fields: `
              <label class="field"><span>Название</span><input name="title" maxlength="120" required value="${esc(item.title || "")}"></label>
              <label class="field"><span>Дата</span><input type="date" name="day" required value="${esc(item.day || "")}"></label>
              <label class="field"><span>Время (необязательно)</span><input type="time" name="time" value="${esc(item.time || "")}" lang="ru"></label>
              <label class="field"><span><input type="checkbox" name="monthly" data-excludes="recurs" ${Number(item.monthly) === 1 ? "checked" : ""}> Повторять каждый месяц</span></label>
              <label class="field"><span><input type="checkbox" name="recurs" data-excludes="monthly" ${Number(item.monthly) === 1 ? "" : item.recurs ? "checked" : ""}> Повторять каждый год</span></label>
              ${ownsPrivacy ? `<label class="field"><span><input type="checkbox" name="is_private" ${item.is_private ? "checked" : ""}> Личная — партнёр не увидит эту дату</span></label>` : ""}
            `,
            onSubmit: (fd) => request(`/api/dates/${id}`, { method: "PATCH", body: { title: fd.get("title"), day: fd.get("day"), time: fd.get("time"), monthly: fd.get("monthly") === "on", recurs: fd.get("recurs") === "on", is_private: ownsPrivacy ? fd.get("is_private") === "on" : undefined } })
          });
        } else if (type === "memories") {
          openDialog({
            title: "Редактировать запись",
            fields: `<label class="field"><span>Заголовок</span><input name="title" maxlength="180" placeholder="Без заголовка" value="${esc(item.title || "")}"></label>
             <label class="field"><span>Воспоминание</span><textarea name="body" rows="4" maxlength="2000" required>${esc(item.body || "")}</textarea></label>`,
            onSubmit: async (fd) => {
              const body = { body: fd.get("body"), title: fd.get("title") };
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
        } else if (type === "quotes") {
          openDialog({
            title: "Редактировать цитату",
            fields: `
              <label class="field"><span>Цитата</span><textarea name="body" rows="4" maxlength="600" required>${esc(item.body || "")}</textarea></label>
              <label class="field"><span>Автор</span><select name="source">${quoteAuthorOptions(item.source || "")}</select></label>
            `,
            onSubmit: (fd) => request(`/api/quotes/${id}`, { method: "PATCH", body: { body: fd.get("body"), source: fd.get("source") } })
          });
        } else if (type === "places") {
          openDialog({
            title: "Редактировать место",
            fields: `
              <label class="field"><span>Куда сходить?</span><input name="title" maxlength="120" required value="${esc(item.title || "")}"></label>
              <label class="field"><span>Заметка (необязательно)</span><textarea name="note" rows="3" maxlength="600">${esc(item.note || "")}</textarea></label>
              <label class="field"><span>Ссылка на карту (необязательно)</span><input name="url" type="url" value="${esc(item.url || "")}" placeholder="https://maps.example.com/..."></label>
            `,
            onSubmit: (fd) => request(`/api/places/${id}`, { method: "PATCH", body: { title: fd.get("title"), note: fd.get("note"), url: fd.get("url") } })
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
        const view = btn.dataset.view === "partner" ? "partner" : "mine";
        if (view === wishView) return;
        wishView = view;
        // Тап по переключателю: точечная перерисовка списков + анимация капли
        // на живом экземпляре — полное перерисование вкладки рвал бы движение.
        const lists = document.getElementById("wish-lists");
        if (lists && wishSwitch) {
          wishSwitch.setActive(view, true);
          lists.innerHTML = renderWishLists();
          document.querySelectorAll(".wish-switch-btn[data-tab]").forEach((b) => {
            b.setAttribute("aria-selected", String(b.dataset.tab === view));
          });
        } else {
          render();
        }
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
            dates_digest_time: timeOf("dates-digest-time"),
            show_avatar: document.getElementById("show-avatar")?.checked ?? true,
            // Пустое поле сбрасывает личное имя партнёра на имя из Telegram.
            partner_name: document.getElementById("partner-name-input")?.value?.trim() || null
          }
        });
        showToast("Настройки сохранены");
        render();
      } else if (action === "set-theme") {
        const value = btn.dataset.theme === "dark" || btn.dataset.theme === "light" ? btn.dataset.theme : "system";
        try { localStorage.setItem(THEME_KEY, value); } catch {}
        applyTheme();
        render();
      } else if (action === "save-pin") {
        const value = document.getElementById("pin-input")?.value?.trim() || "";
        if (!/^\d{4}$/.test(value)) {
          showToast("Пароль — ровно 4 цифры");
          return;
        }
        try { localStorage.setItem(PIN_KEY, value); } catch {}
        appUnlocked = true; // только что заданный пароль не запирает текущую сессию
        showToast("Пароль установлен");
        render();
      } else if (action === "clear-pin") {
        try { localStorage.removeItem(PIN_KEY); } catch {}
        showToast("Пароль убран");
        render();
      } else if (action === "export-data") {
        // Диалог выбора разделов: для каждой коллекции — свой состав выгрузки.
        openDialog({
          title: "Что выгрузить?",
          fields: `
            <label class="field"><span>Планы (незавершённые)</span><select name="plans">
              <option value="">Не выгружать</option>
              <option value="all" selected>Все</option>
              <option value="private">Только личные</option>
            </select></label>
            <label class="field"><span>Кино</span><select name="movies">
              <option value="" selected>Не выгружать</option>
              <option value="open">Не просмотренные</option>
            </select></label>
            <label class="field"><span>Значимые даты</span><select name="dates">
              <option value="">Не выгружать</option>
              <option value="all" selected>Все</option>
              <option value="private">Только личные</option>
            </select></label>
            <label class="field"><span>Дни рождения</span><select name="birthdays">
              <option value="">Не выгружать</option>
              <option value="all" selected>Все</option>
              <option value="private">Только личные</option>
            </select></label>
            <label class="field"><span>Места</span><select name="places">
              <option value="" selected>Не выгружать</option>
              <option value="all">Все</option>
              <option value="mine">Только добавленные мной</option>
            </select></label>
            <label class="field"><span>Записи дневника</span><select name="memories">
              <option value="" selected>Не выгружать</option>
              <option value="all">Все записи</option>
              <option value="mine">Только мои</option>
            </select></label>
            <label class="field"><span>Цитаты</span><select name="quotes">
              <option value="" selected>Не выгружать</option>
              <option value="all">Все</option>
              <option value="mine">Только мои</option>
            </select></label>
            <label class="field"><span>Желания (не подаренные)</span><select name="wishes">
              <option value="" selected>Не выгружать</option>
              <option value="all">Все</option>
              <option value="mine">Только мои</option>
            </select></label>
          `,
          onSubmit: async (fd) => {
            const sections = {};
            for (const key of ["plans", "movies", "dates", "birthdays", "places", "memories", "quotes", "wishes"]) {
              const value = fd.get(key);
              if (value) sections[key] = value;
            }
            // Ответ экспорта — счётчики, а не состояние приложения:
            // appState не перезаписываем.
            const result = await request("/api/data/export", { method: "POST", body: { sections } });
            const total = Object.values(result?.counts || {}).reduce((sum, n) => sum + Number(n || 0), 0);
            showToast(`Файл «Экспорт» выслан от бота: ${total} записей`);
            return appState;
          }
        });
      } else if (action === "save-pair-timezone") {
        const value = document.getElementById("pair-timezone")?.value || "";
        if (!value) {
          showToast("Выберите пояс из списка");
          return;
        }
        appState = await request("/api/pair/timezone", { method: "POST", body: { timezone: value } });
        showToast("Часовой пояс сохранён");
        render();
      } else if (action === "set-gender") {
        // Подтверждение выбора: случайный тап не фиксирует пол навсегда.
        const gender = btn.dataset.gender === "female" ? "female" : "male";
        const label = gender === "female" ? "Женщина" : "Мужчина";
        openDialog({
          title: "Ваш пол",
          fields: `<p style="margin:2px 0 0;">Выбрано: <b>${label}</b>. Пол нужен для обращений в интерфейсе и подтверждениях.</p>`,
          submitLabel: "Подтвердить",
          onSubmit: async () => {
            appState = await request("/api/gender", { method: "POST", body: { gender } });
            return appState;
          }
        });
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
    if (liquidNav?.getState?.().dragging || segSwitch?.getState?.().dragging || wishSwitch?.getState?.().dragging) return;
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
    // Пароль запрашиваем до сетевых запросов: приложение не грузится за замком.
    if (!appUnlocked && storedPin()) {
      appEl.innerHTML = renderLock();
      mountLock();
      window.__duoplanInitInProgress = false;
      return;
    }

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
