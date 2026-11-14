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
    memories: { title: "Дневник", sub: "Записи, цитаты, здоровье и контакты" },
    pair: { title: "Наша пара", sub: "Профиль, желания и настройки" }
  };

  let appState = null;
  let currentTab = "home";
  let wishView = "mine"; // "mine" | "partner" — переключатель вишлиста
  // Виды внутри вкладок: «Наша пара» (профиль/желания), «Даты»
  // (наши/дни рождения), «Дневник» (записи/цитаты). Живут вне рендера, чтобы
  // минутный refresh и возврат на вкладку не сбрасывали выбранный вид.
  let pairView = "profile";
  let floState = null;
  // Под-вкладки внутри «Фло»: Сегодня / Цикл / Статистика / Препараты / Настройки.
  let floView = "today";
  let floMonth = null;
  let floSelectedDate = null;
  let floBusy = false;
  let floPartner = undefined;
  let floPartnerBusy = false;
  let floDeleteArmed = false;
  let floWizard = null;
  let floWizardDismissed = false;
  // Импорт прошлых периодов из карточки истории (bulk /api/cycle/periods).
  let floHistPrev = [];
  let floHistPrevOpen = false;
  let floStats = undefined;
  let floStatsBusy = false;
  // Пагинация истории (P1): помесячная догрузка через /api/cycle/history
  // для месяцев старше окна /api/cycle/state (36 периодов / 400 записей).
  // Исторический API отдаёт периоды, дневник, препараты, факт приёма и
  // измерения — храним весь набор (переработка 9.3), иначе старые БТ/ЛГ и
  // приёмы пропадают из карточки дня при листании календаря назад.
  let floExtra = { periods: [], logs: [], meds: [], med_logs: [], measurements: [] };
  let floFetchedMonths = new Set();
  let floEditing = null;
  // P2: отчёт (печать/CSV/JSON), препараты и черновики форм.
  let floReport = null; // { months, loading, failed, data }
  let floStatsMonths = 12;
  let floMedForm = null; // { id?, ...поля } — открытая форма препарата
  let floMedDeleteArmed = null;
  let floMedDetail = null; // "medId:date" — раскрытые поля факта приёма
  // Здоровье («Дневник → Здоровье»): личный журнал препаратов каждого
  // партнёра + напоминания бота о приёме. Данные персональные (tg_id).
  let healthState = null;
  let healthBusy = false;
  // Контакты («Дневник → Контакты»): телефонная книга, у каждого партнёра
  // своя. Вид «mine/partner» разделяет списки, поиск фильтрует клиентски.
  let contactsState = null;
  let contactsBusy = false;
  let contactsView = "mine";
  let contactsSearch = "";
  let datesView = "dates";
  let memoriesView = "memories";
  // «Планы / Цели / Кино» — виды вкладки «Планы».
  let tasksView = "plans";
  // «Предстоящие / Выполненные» — виды сегмента «Цели».
  let goalsView = "open";
  // «Предстоящие / Выполненные» — виды сегмента «Планы».
  let plansView = "open";
  // «Посетить / Путешествие» — виды вкладки «Места».
  let placesView = "visit";
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
    done_wishes: emptyArchiveEntry(),
    movies: emptyArchiveEntry(),
    quotes: emptyArchiveEntry(),
    places: emptyArchiveEntry(),
    trips: emptyArchiveEntry(),
    goals: emptyArchiveEntry(),
    savings: emptyArchiveEntry()
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
    wishes: ["wishes", "done_wishes"],
    movies: ["movies"],
    quotes: ["quotes"],
    places: ["places"],
    trips: ["trips"],
    goals: ["goals"],
    savings: ["savings"]
  };
  function removeFromArchiveCache(type, id) {
    for (const key of ARCHIVE_KEYS_BY_TYPE[type] || []) {
      archiveCache[key].items = archiveCache[key].items.filter((x) => Number(x.id) !== Number(id));
    }
  }
  function patchArchiveItem(type, id, patch) {
    // undefined-поля отбрасываем: spread перезаписал бы ими значения кэша —
    // is_private: undefined у чужого плана (право приватности только у автора)
    // стирал чип «Личное» и серую точку в календаре до ревалидации архива
    // (репорт 2026-11-10).
    const cleanPatch = Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined));
    for (const key of ARCHIVE_KEYS_BY_TYPE[type] || []) {
      archiveCache[key].items = archiveCache[key].items.map((x) => Number(x.id) === Number(id) ? { ...x, ...cleanPatch } : x);
    }
  }
  // Фоновая догрузка архива перерисовывает экран: если в этот момент открыт
  // диалог или пользователь печатает, полный render() пересоздаёт поля и
  // стирал бы ввод (репорт 2026-11-10). Откладываем перерисовку до безопасного
  // момента — данные никуда не деваются, следующий рендер их подхватит.
  let archiveRenderTimer = null;
  function renderArchiveSafe() {
    if (archiveRenderTimer) return;
    const safe = () => !dialog?.open && !isTypingNow();
    if (safe()) { render(); return; }
    const retry = () => {
      archiveRenderTimer = null;
      if (safe()) render();
      else archiveRenderTimer = setTimeout(retry, 1500);
    };
    archiveRenderTimer = setTimeout(retry, 1500);
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
      renderArchiveSafe();
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
          // Сервер сказал, что дальше пусто — не тянем страницы до lastPage.
          if (!next.hasMore) break;
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
    const threshold = {
      tasks: STATE_ACTIVE_LIMIT, dates: STATE_ACTIVE_LIMIT, wishes: STATE_ACTIVE_LIMIT,
      movies: STATE_ACTIVE_LIMIT, quotes: STATE_ACTIVE_LIMIT, places: STATE_ACTIVE_LIMIT,
      trips: STATE_ACTIVE_LIMIT, goals: STATE_ACTIVE_LIMIT, savings: STATE_ACTIVE_LIMIT
    }[type] || STATE_RECENT_LIMIT;
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
  // Действия, меняющие содержимое пространства. Пока партнёра нет (вышел и
  // не вернулся), они заблокированы — сервер отвечает тем же (PARTNER_ABSENT).
  // Личное остаётся доступным: настройки, акцент, тема, PIN, экспорт, выход.
  const PARTNER_LOCKED_ACTIONS = new Set([
    "add-goal-step", "edit-item", "delete-item", "reopen-item", "done-item",
    "remove-goal-step", "goal-item-done", "goal-item-reopen",
    "movie-watched", "movie-unwatched", "rate-movie",
    "place-visited", "place-unvisited", "trip-visited", "trip-unvisited",
    "deposit-saving", "edit-saving", "daily-done"
  ]);

  // SDK бросает WebAppMethodUnsupported, если метод новее клиента Telegram, —
  // необязательные вызовы гасим, чтобы не валить инициализацию приложения.
  function safeTg(fn) {
    try {
      return fn();
    } catch {
      return undefined;
    }
  }

  // Лёгкая отдача на подтверждённые действия — только там, где результат
  // не очевиден с первого взгляда (отметки, завершения, ритуал дня).
  function haptic(kind = "light") {
    safeTg(() => tg?.HapticFeedback?.impactOccurred?.(kind));
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

  // ------------------------------------------------------------------
  // Прогрев аватаров к моменту показа пилюли
  // ------------------------------------------------------------------
  // Кнопка пары появляется одновременно с главным экраном, а background-image
  // начинает грузиться только у ВИДИМОГО элемента: пользователь успевал
  // увидеть цветную подложку, и только потом поверх «доезжало» фото — это и
  // было мерцание при каждом открытии. Поэтому фото качаем, пока на экране
  // ещё «Открываем ваше пространство…», и ждём decode(): к моменту показа
  // картинка уже в памяти WebView и рисуется первым же кадром. Буквы и
  // акцентные цвета красятся там же — до unhide пилюли, поэтому и буквенный
  // вариант не перекрашивается на глазах.
  const AVATAR_PRELOAD_TIMEOUT_MS = 1500;
  // url → Promise<boolean>: одна и та же ссылка не качается повторно
  // (минутный refresh, смена темы, повторные render()).
  const avatarPreloads = new Map();
  // Фото меняются редко — старые записи не копим на весь сеанс.
  const AVATAR_PRELOAD_CACHE_LIMIT = 8;

  // Ссылки, которые реально попадут в слоты при этом state: ровно та же
  // выборка, что у paintAvatarSlot (флаг показа, https, наличие партнёра).
  function avatarPhotoUrls(state) {
    const pair = state?.pair;
    if (!pair || !state?.user?.gender || state.user.show_avatar === false) return [];
    const role = pair.role === "b" ? "b" : "a";
    return [
      role === "a" ? state.user.photo_url : pair.photo1,
      pair.user_b ? (role === "b" ? state.user.photo_url : pair.photo2) : null
    ].filter((url) => typeof url === "string" && /^https:\/\//.test(url));
  }

  function preloadAvatarPhoto(url) {
    let task = avatarPreloads.get(url);
    if (task) return task;
    if (avatarPreloads.size >= AVATAR_PRELOAD_CACHE_LIMIT) avatarPreloads.clear();
    task = new Promise((resolve) => {
      try {
        const img = new Image();
        // decode() ждёт не только загрузку, но и декодирование: без него
        // background-image мог мигнуть пустым кругом на первом кадре.
        const ready = () => {
          if (typeof img.decode === "function") img.decode().then(() => resolve(true), () => resolve(true));
          else resolve(true);
        };
        img.onload = ready;
        img.onerror = () => resolve(false);
        img.src = url;
      } catch {
        // WebView без Image: прогревать нечем — рисуем как раньше.
        resolve(false);
      }
    }).then((ok) => {
      // Неудачу не кэшируем — следующее открытие попробует снова.
      if (!ok) avatarPreloads.delete(url);
      return ok;
    });
    avatarPreloads.set(url, task);
    return task;
  }

  // Ждём картинки не дольше timeout: медленный CDN не должен держать экран
  // загрузки — тогда фото доедет уже в интерфейсе, как раньше.
  function waitAtMost(promise, ms) {
    return new Promise((resolve) => {
      const timer = setTimeout(() => resolve(false), ms);
      promise.then(
        () => { clearTimeout(timer); resolve(true); },
        () => { clearTimeout(timer); resolve(false); }
      );
    });
  }

  // Слоты красятся в одном месте: и прогрев до первого render(), и
  // syncTopControls — иначе фото/буква/акценты рисовались бы по-разному.
  function paintPairAvatars() {
    const pair = appState?.pair;
    if (!pair || !appState?.user?.gender) return;
    const role = pair.role === "b" ? "b" : "a";
    applyAvatarColors();
    // Моё фото — user.photo_url (если я владелец — слот A, иначе слот B),
    // фото партнёра — соответствующий photo1/photo2 из state.
    paintAvatarSlot(avatarA, pair.name1, "А", role === "a" ? appState.user.photo_url : pair.photo1);
    paintAvatarSlot(avatarB, pair.name2, "Б", pair.user_b ? (role === "b" ? appState.user.photo_url : pair.photo2) : null);
    if (!pair.user_b) avatarB.textContent = "+";
  }

  // Полная подготовка пилюли: буквы и акценты в DOM + фото в памяти WebView.
  // Вызывается до первого render() (кнопка ещё скрыта) и перед перерисовкой,
  // которая может принести новое фото.
  async function preloadPairAvatars(timeout = AVATAR_PRELOAD_TIMEOUT_MS) {
    // Пока пилюля скрыта (старт приложения), буквы и акценты красим сразу:
    // к моменту показа в слотах уже финальный вид. Если пилюля на экране
    // (минутный refresh), промежуточное состояние не показываем — ждём фото
    // и красим один раз, иначе на глазах менялись бы буква, цвет и фото.
    const pillHidden = !pairButton || pairButton.hidden;
    if (pillHidden) paintPairAvatars();
    const urls = [...new Set(avatarPhotoUrls(appState))];
    if (!urls.length) return;
    try {
      await waitAtMost(Promise.all(urls.map(preloadAvatarPhoto)), timeout);
    } catch {
      // Прогрев — оптимизация, а не условие запуска: любой сбой просто
      // оставляет прежнее поведение (фото доедет уже в интерфейсе).
      return;
    }
    // Фото в кэше — перекрашиваем слоты, чтобы background-image встал сразу.
    paintPairAvatars();
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
    // Класс tg-fullscreen (тоггл на fullscreenChanged, Bot API 8.0+) убран:
    // правила для него в app.css не осталось, тоггл был мёртвым кодом.
    // Safe-area закрыта CSS-переменными — полноэкранный режим работает и без него.
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

  // Unix timestamp (seconds) → дд.мм.гггг — в ЛИЧНОМ поясе зрителя: отметка
  // «выполнено/посещено» — момент из прошлого, каждому понятно в его часах.
  // Якоря событий (planTarget и др.) остаются в поясе пары.
  function formatTimestamp(ts) {
    const n = Number(ts);
    if (!Number.isFinite(n) || n <= 0) return "";
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone: viewerTimeZone(), year: "numeric", month: "2-digit", day: "2-digit"
    }).formatToParts(new Date(n * 1000));
    const get = (type) => parts.find((part) => part.type === type)?.value;
    if (!get("year")) return "";
    return `${get("day")}.${get("month")}.${get("year")}`;
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
      // Длинные сообщения (URL-фолбэки копирования, счётчики экспорта)
      // не должны исчезать до прочтения — время растёт с длиной текста.
      toastTimer = setTimeout(() => {
        toastEl.hidden = true;
      }, Math.min(1500 + message.length * 20, 6000));
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
    // HTTP-ошибки несут готовый русский текст; остальное (TypeError и т.п.)
    // наружу не показываем — сырой машинный текст только пугает.
    showToast(error?.status !== undefined || error?.code ? error.message : "Что-то пошло не так, попробуйте ещё раз");
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
    const timeoutError = () => {
      const error = new Error("Сервер не ответил. Попробуйте ещё раз.");
      error.status = 0;
      return error;
    };
    try {
      let response;
      try {
        response = await fetch(path, {
          method: options.method || "GET",
          headers,
          body: options.body ? JSON.stringify(options.body) : undefined,
          signal: controller ? controller.signal : undefined
        });
      } catch (error) {
        // Таймаут на этапе ожидания заголовков.
        if (error?.name === "AbortError") throw timeoutError();
        throw error;
      }
      let payload;
      try {
        // fetch резолвится на заголовках, а тело может зависнуть: AbortController
        // и таймер обязаны жить до конца чтения (аудит 2026-11-11, P2), иначе
        // интерфейс остаётся в ожидании после заявленных 20 секунд.
        payload = await response.json();
      } catch (error) {
        if (error?.name === "AbortError") throw timeoutError();
        // Не-JSON или пустое тело — как раньше, считаем пустым объектом.
        payload = {};
      }
      if (!response.ok) {
        const error = new Error(payload.error || payload.message || `Ошибка ${response.status}`);
        error.status = response.status;
        error.code = payload.code;
        throw error;
      }
      return payload;
    } finally {
      // Общий finally: reject по таймауту снимает таймер и даёт вызывающим
      // (loadArchivePage и др.) сбросить cache.loading/button.disabled.
      if (timer) clearTimeout(timer);
    }
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
    goalsSwitch?.refresh();
    movieSwitch?.refresh();
    plansSwitch?.refresh();
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

    // Слоты красим ДО показа кнопки: пилюля появляется уже с фото, буквами
    // и акцентами — к этому моменту они прогреты на экране загрузки.
    paintPairAvatars();
    pairButton.hidden = false;
    // Панель могла быть скрыта в момент инициализации (нет пары) — размеры
    // появились только сейчас, поэтому пересчитываем геометрию капли.
    // Только на переходе «скрыта → показана»: иначе refresh() на каждом
    // рендере сбрасывал бы незавершённую анимацию капли.
    const wasHidden = bottomNav.hidden;
    bottomNav.hidden = false;
    if (wasHidden) liquidNav?.refresh();
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
    // Открытое окно — первый «Назад» закрывает его, вкладка не трогается.
    // Повторное нажатие уже работает как навигация: не главная → главная.
    if (dialog?.open) {
      dialog.close();
      return;
    }
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

  // Личный пояс зрителя: users.timezone синхронизируется с устройства каждого
  // партнёра (x-timezone на каждом запросе), поэтому уехавший партнёр видит
  // «сегодня», бактеты «Сегодня/Завтра» и отметки по своим часам. Якоря
  // событий (planTarget, nextOccurrence и др.) остаются в поясе ПАРЫ —
  // у события один абсолютный момент для обоих.
  function viewerTimeZone() {
    return validTimeZoneLite(appState?.user?.timezone) || pairTimeZone();
  }

  // Лёгкая валидация без Intl: полный validTimeZone нужен только на сервере,
  // на клиенте пояс приходит из /api/state и устройства.
  function validTimeZoneLite(value) {
    return typeof value === "string" && value.length > 0 && value.length <= 64 ? value : null;
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
      // hour12:false в части ICU возвращает "24" в полночь — нормализуем,
      // как localMinutesOfDay (репорт worker.js timeZoneOffsetMs).
      Number(get("hour")) % 24, Number(get("minute")), Number(get("second"))
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
        Number(get("hour")) % 24 === hour &&
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
    // Окно как в worker и боте (_yearly_occurrence, range(10)): одна
    // константа на все поверхности (29 февраля всегда находится внутри).
    for (let year = currentYear; year <= currentYear + 9; year++) {
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
    // Окно как в worker.nextDateOccurrence и боте next_date_occurrence
    // (range(9) → текущий..+8): одна константа на все поверхности.
    // Отличается от yearlyNext планов — там окно +9 (range(10)).
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

  // Календарные сутки до цели в поясе пары (как в dateItem): «Через N дн.»
  // считалось ceil по часам, и план через 25 часов показывал «Через 2 дн.»,
  // тогда как значимая дата в тот же момент — «Завтра» (репорт 2026-11-10).
  function calendarDaysFromNow(target) {
    // Бактеты «Сегодня/Завтра/Через N дн.» — по календарю ЗРИТЕЛЯ: уехавший
    // партнёр видит «Завтра», когда событие — завтра по его часам. Абсолютный
    // момент (target) по-прежнему якорится в поясе пары.
    const tz = viewerTimeZone();
    const parts = new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
    const [year, month, day] = parts.split("-").map(Number);
    const midnight = makeDateInTimeZone(year, month - 1, day, 12, 0, tz);
    return Math.round((target.getTime() - midnight.getTime()) / 86400000);
  }

  // Конверсия «для вас»: событие закреплено за поясом пары (каноничное время
  // на карточке), уехавший партнёр видит рядом своё местное время. При
  // одинаковых поясах — пустая строка: большинство пар не увидят изменений.
  function viewerTimeHint(day, time) {
    // Записи без времени: planTarget подставил бы 23:59 и подсказка врала.
    if (time == null || time === "") return "";
    const viewer = viewerTimeZone();
    const pair = pairTimeZone();
    if (viewer === pair) return "";
    const target = planTarget(day, time, null);
    if (!target) return "";
    const partsIn = (tz) => {
      const parts = new Intl.DateTimeFormat("en-GB", {
        timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit",
        hour: "2-digit", minute: "2-digit", hour12: false
      }).formatToParts(target);
      const get = (type) => parts.find((p) => p.type === type)?.value || "0";
      const hour = String(Number(get("hour")) % 24).padStart(2, "0");
      return { date: `${get("day")}.${get("month")}`, time: `${hour}:${get("minute")}` };
    };
    const viewerParts = partsIn(viewer);
    const pairParts = partsIn(pair);
    if (viewerParts.date === pairParts.date) return `для вас ${viewerParts.time}`;
    return `для вас ${viewerParts.date} ${viewerParts.time}`;
  }

  // Подсказка в диалогах плана/даты: время события интерпретируется в поясе
  // пары; при разных поясах партнёр должен видеть это при вводе.
  function pairTimeHintHtml() {
    if (viewerTimeZone() === pairTimeZone()) return "";
    return `<p class="settings-hint">Время — по поясу пары (${esc(pairTimeZone())}); ваше местное: ${esc(viewerTimeZone())}</p>`;
  }

  function countdownFromDiff(diff) {
    // Просрочка старше недели помечается stale: событие давно позади, и яркий
    // чип выглядит как ошибка, а не как статус (см. .day-chip.is-stale).
    if (diff <= 0) return { overdue: true, stale: -diff > 7 * 86400000, text: "Время пришло" };
    const totalMinutes = Math.floor(diff / 60000);
    // Меньше минуты — «Через 0 часов 0 минут» выглядит как сбой (репорт 2026-11-10).
    if (totalMinutes < 1) return { overdue: false, text: "Через минуту" };
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
    // Почасовой отсчёт — только на текущий календарный день: план на 02:00
    // ночи показывал «Через 16 ч», хотя дата в тот же момент — «Завтра».
    const days = calendarDaysFromNow(target);
    if (days === 0) {
      const hours = Math.floor(diff / 3600000);
      const mins = Math.max(1, Math.floor((diff % 3600000) / 60000));
      const label = hours > 0 ? `Через ${hours} ч ${mins} мин` : `Через ${mins} мин`;
      return `<span class="day-chip is-countdown" data-countdown="${ctx}">${esc(label)}</span>`;
    }
    if (days === 1) return `<span class="day-chip" data-countdown="${ctx}">Завтра</span>`;
    return `<span class="day-chip" data-countdown="${ctx}">Через ${days} ${plural(days, "день", "дня", "дней")}</span>`;
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
      const input = document.getElementById("lock-pin");
      // Последняя цифра тоже маскируется точкой сразу, до входа или ошибки.
      if (input) renderPinCells(input, true);
      const value = input?.value?.trim() || "";
      if (value !== storedPin()) {
        // Без тайм-аутов: просто повторная попытка. Поле не фокусируем —
        // пустое поле вне фокуса снова показывает точки-плейсхолдер.
        const error = document.getElementById("lock-error");
        if (error) error.hidden = false;
        if (input) { input.value = ""; renderPinCells(input); }
        return;
      }
      appUnlocked = true;
      // Состояние ещё не загружено: initApp вышел ранним выходом за замком.
      // Полная инициализация грузит /api/state и рендерит пространство.
      initApp();
    });
    // Автофокус на PIN убран: клавиатура выезжает только по тапу пользователя.
    setTimeout(() => mountPinFields(), 50);
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
      <section class="card${daily.done ? " is-done" : ""}">
        <p class="eyebrow">Ритуал дня</p>
        <h3>${esc(daily.action)}</h3>
        <p>${daily.done ? `Вы отметили ритуал +10 XP${daily.partnerDone ? " · партнёр тоже отметил" : ""}` : (daily.partnerDone ? "Партнёр уже отметил ритуал — отметьте и вы" : "Отметьте ритуал дня и получите +10 XP")}</p>
        ${daily.done ? "" : `<div style="margin-top:18px;"><button class="primary full" type="button" data-action="daily-done">Выполнено +10 XP</button></div>`}
      </section>
    ` : "";

    const previewTasks = sortByTaskDeadline(tasks).slice(0, 3).map(taskItem).join("");
    // Порядок дат приходит отсортированным из /api/state — повторно не сортируем.
    // На главной каждая группа — не больше трёх карточек, остальное за «Все →».
    // Дни рождения и значимые даты — разные списки с разными заголовками,
    // поэтому смешанный срез заменён двумя фильтрами.
    const previewDates = dates.filter((item) => item.kind !== "birthday").slice(0, 3).map(dateItem).join("");
    const previewBirthdays = dates.filter((item) => item.kind === "birthday").slice(0, 3).map(birthdayItem).join("");
    const latestMemory = memories[0];

    return `
      ${renderTabHeader("home")}
      ${pair.user_b ? `
      <section class="card hero-card" role="button" tabindex="0" data-action="open-history" aria-label="История пары и рекорд серии">
        <p class="eyebrow">Ваша история</p>
        <h2>${esc(pair.name1)} и ${esc(pair.name2)}</h2>
        <div class="stats-row">
          <span class="stat-pill">${FLAME_ICON} Серия ${user.streak || 0} дн.</span>
          <span class="stat-pill">${user.points || 0} XP</span>
          <span class="stat-pill">Вместе ${pair.together_pts || 0} XP</span>
        </div>
      </section>` : `
      <section class="card hero-card">
        <p class="eyebrow">Ожидание партнёра</p>
        <h2>Код пары: ${esc(pair.code)}</h2>
        <p>Отправьте код партнёру, чтобы открыть ритуалы дня и общее пространство.</p>
      </section>`}

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

      ${previewBirthdays ? `
      <div class="section-head-inline">
        <h3>Дни рождения</h3>
      </div>
      ${previewBirthdays}
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
    // Тап по карточке с датой открывает календарь на нужном дне; у плана без
    // даты карточка — просто карточка (data-action не вешается).
    const calendarAttrs = item.day
      ? ` role="button" tabindex="0" data-action="show-in-calendar" data-day="${esc(item.day)}" aria-label="Показать в календаре"`
      : "";
    return `
      <article class="card"${calendarAttrs}>
        <div class="item-row">
          <div class="item-main">
            <h3 class="item-title">${renderRichText(item.title)}</h3>
            <div class="item-meta">
              <div class="item-when">
                ${item.is_private
                  ? `<div class="item-when-line"><span class="day-chip is-private">Личное</span>${item.day ? `<span>${esc(formatDay(item.day))}${item.time ? ` · ${esc(item.time)}` : ""}</span>${viewerTimeHint(item.day, item.time) ? `<span class="day-chip is-muted">${esc(viewerTimeHint(item.day, item.time))}</span>` : ""}` : ""}</div>`
                  : item.day ? `<span>${esc(formatDay(item.day))}${item.time ? ` · ${esc(item.time)}` : ""}</span>${viewerTimeHint(item.day, item.time) ? `<span class="day-chip is-muted">${esc(viewerTimeHint(item.day, item.time))}</span>` : ""}` : ""}
                <div class="item-when-row">
                  ${countdownChip(item.day, item.time, taskRepeat(item))}
                </div>
              </div>
            </div>
          </div>
          ${itemActions([
            itemActionButton({ action: "done-item", type: "tasks", id: item.id, label: "Выполнено", icon: DONE_ICON }),
            itemActionButton({ action: "edit-item", type: "tasks", id: item.id, label: "Редактировать", icon: EDIT_ICON }),
            itemActionButton({ action: "delete-item", type: "tasks", id: item.id, label: "Удалить", icon: DELETE_ICON })
          ].join("\n            "))}
        </div>
      </article>
    `;
  }

  function dateItem(item) {
    const next = nextOccurrence(item);
    // Бактеты «Сегодня/Завтра» у значимых дат — по календарю зрителя,
    // как в чипах планов; сам момент (next) якорится в поясе пары.
    const tz = viewerTimeZone();
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
    const whenText = `<span>${esc(formatDay(item.day))}${item.time ? ` · ${esc(item.time)}` : ""}${Number(item.monthly) === 1 ? " · Ежемесячно" : item.recurs ? " · Ежегодно" : ""}</span>${viewerTimeHint(item.day, item.time) ? `<span class="day-chip is-muted">${esc(viewerTimeHint(item.day, item.time))}</span>` : ""}`;
    return `
      <article class="card" role="button" tabindex="0" data-action="show-in-calendar" data-day="${esc(item.day)}" aria-label="Показать в календаре">
        <div class="item-row">
          <div class="item-main">
            <h3 class="item-title">${renderRichText(item.title)}</h3>
            <div class="item-meta">
              <div class="item-when">
                ${item.is_private ? `<div class="item-when-line"><span class="day-chip is-private">Личное</span>${whenText}</div>` : whenText}
                <div class="item-when-row">
                  ${chip}
                </div>
              </div>
            </div>
          </div>
          ${itemActions([
            itemActionButton({ action: "edit-item", type: "dates", id: item.id, label: "Редактировать", icon: EDIT_ICON }),
            itemActionButton({ action: "delete-item", type: "dates", id: item.id, label: "Удалить", icon: DELETE_ICON })
          ].join("\n            "))}
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
          ${itemActions([
            itemActionButton({ action: "edit-item", type: "memories", id: item.id, label: "Редактировать", icon: EDIT_ICON }),
            itemActionButton({ action: "delete-item", type: "memories", id: item.id, label: "Удалить", icon: DELETE_ICON })
          ].join("\n            "))}
        </div>
      </article>
    `;
  }

  function wishItem(item, editable = true) {
    const canEdit = editable && item.owner_id === appState.user.tg_id;
    // «Скопировать» — чтение, доступно обоим партнёрам: мутации (исполнено/
    // правка/удаление) остаются только владельцу, копирование — всем.
    const actions = [
      itemActionButton({ action: "share-wish", type: "wishes", id: item.id, label: "Скопировать название и ссылку", icon: COPY_ICON }),
      ...(canEdit ? [
        itemActionButton({ action: "done-item", type: "wishes", id: item.id, label: "Исполнено", icon: DONE_ICON }),
        itemActionButton({ action: "edit-item", type: "wishes", id: item.id, label: "Редактировать", icon: EDIT_ICON }),
        itemActionButton({ action: "delete-item", type: "wishes", id: item.id, label: "Удалить", icon: DELETE_ICON })
      ] : [])
    ].join("\n      ");
    // Кнопка «Ссылка» — действие карточки: по центру, с симметричным отступом
    // (как «Сохранить пояс» и прочие card-action), а не прижата к заголовку.
    return `
      <article class="card">
        <div class="item-row">
          <div class="item-main">
            <h3 class="item-title">${renderRichText(item.body)}</h3>
            ${item.comment ? `<div class="wish-comment">${renderRichText(item.comment)}</div>` : ""}
          </div>
          ${itemActions(actions)}
        </div>
        ${item.url ? `<button class="secondary full card-action" data-action="open-url" data-url="${esc(item.url)}">Ссылка</button>` : ""}
      </article>
    `;
  }

  // Текст для «Поделиться»: название, уточнение и ссылка — по строке каждое.
  function wishShareText(wish) {
    const body = String(wish?.body || "").trim();
    const comment = String(wish?.comment || "").trim();
    const url = String(wish?.url || "").trim();
    return [body, comment, url].filter(Boolean).join("\n");
  }

  function findItem(type, id) {
    const collections = {
      tasks: [...mergedArchive("tasks", appState?.tasks || []), ...mergedArchive("done_tasks", appState?.completedTasks || [])],
      dates: mergedArchive("dates", appState?.dates || []),
      memories: mergedArchive("memories", appState?.memories || []),
      wishes: [...mergedArchive("wishes", appState?.wishes || []), ...mergedArchive("done_wishes", appState?.completedWishes || [])],
      quotes: mergedArchive("quotes", appState?.quotes || []),
      places: mergedArchive("places", appState?.places || []),
      trips: mergedArchive("trips", appState?.trips || []),
      goals: mergedArchive("goals", appState?.goals || []),
      movies: mergedArchive("movies", appState?.movies || []),
      savings: mergedArchive("savings", appState?.savings || [])
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
  // Копирование желания (название, уточнение, ссылка): классический значок
  // «копировать» — два перекрывающихся листа — вместо значка «поделиться»
  // из трёх кружков, который читался как шаринг, а не как копирование.
  const COPY_ICON = '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="9" y="9" width="12" height="12" rx="2.2"/><path d="M5.5 15H4.8A1.8 1.8 0 0 1 3 13.2V4.8A1.8 1.8 0 0 1 4.8 3h8.4A1.8 1.8 0 0 1 15 4.8v.7"/></svg>';

  // Кнопки действий карточек собираются из одного шаблона: иконка, data-action
  // и подпись. data-type/data-id/data-url добавляются только когда заданы —
  // у deposit-saving и open-url своих атрибутов нет.
  function itemActionButton(opts) {
    const { action, type, id, url, label, icon } = opts;
    const typeAttr = type !== undefined ? ` data-type="${esc(type)}"` : "";
    const idAttr = id !== undefined ? ` data-id="${esc(id)}"` : "";
    const urlAttr = url !== undefined ? ` data-url="${esc(url)}"` : "";
    return `<button class="icon-btn" type="button" data-action="${action}"${typeAttr}${idAttr}${urlAttr} aria-label="${esc(label)}">${icon}</button>`;
  }

  // Обёртка кнопок справа от карточки; пустой набор — без пустого div.
  function itemActions(buttons) {
    return buttons ? `<div class="item-actions">${buttons}</div>` : "";
  }

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
          ${itemActions([
            itemActionButton({ action: "reopen-item", type: "tasks", id: item.id, label: "Вернуть в планы", icon: REOPEN_ICON }),
            itemActionButton({ action: "edit-item", type: "tasks", id: item.id, label: "Редактировать", icon: EDIT_ICON }),
            itemActionButton({ action: "delete-item", type: "tasks", id: item.id, label: "Удалить", icon: DELETE_ICON })
          ].join("\n            "))}
        </div>
      </article>
    `;
  }

  function completedWishItem(item, editable = true) {
    const canEdit = editable && item.owner_id === appState.user.tg_id;
    const actions = canEdit ? [
      itemActionButton({ action: "reopen-item", type: "wishes", id: item.id, label: "Вернуть в желания", icon: REOPEN_ICON }),
      itemActionButton({ action: "edit-item", type: "wishes", id: item.id, label: "Редактировать", icon: EDIT_ICON }),
      itemActionButton({ action: "delete-item", type: "wishes", id: item.id, label: "Удалить", icon: DELETE_ICON })
    ].join("\n      ") : "";
    const created = formatTimestamp(item.created_at);
    const completed = formatTimestamp(item.done_at);
    return `
      <article class="card" style="opacity:0.72;">
        <div class="item-row">
          <div class="item-main">
            <h3 class="item-title" style="text-decoration:line-through;">${renderRichText(item.body)}</h3>
            ${item.comment ? `<div class="wish-comment">${renderRichText(item.comment)}</div>` : ""}
            ${completionMeta(created, completed)}
          </div>
          ${itemActions(actions)}
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
      // Битая дата не должна рождать ключ вида «2026-05-NaN».
      if (![taskYear, taskMonth, taskDay].every(Number.isFinite)) continue;
      if (Number(task.monthly) === 1) {
        // Ежемесячный план — в каждом месяце, где такой день существует,
        // и не раньше месяца создания (иначе точки лезут в прошлое до записи).
        if (year < taskYear || (year === taskYear && month < taskMonth)) continue;
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
        // Ежемесячная дата — как ежегодная, но каждый месяц того же дня,
        // и не раньше месяца создания.
        if (year < dateYear || (year === dateYear && month < dateMonth)) continue;
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

  // Календарный ключ момента. «Сегодня» для зрителя — по его личному поясу
  // (кольцо календаря и месяц по его часам); точки событий остаются на датах
  // пары. Якорные вычисления событий идут через pairTimeZone().
  function calendarKeyFromDate(date, timeZone = viewerTimeZone()) {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone, year: "numeric", month: "2-digit", day: "2-digit"
    }).formatToParts(date);
    const get = (type) => parts.find((part) => part.type === type)?.value;
    if (!get("year")) return null;
    return `${get("year")}-${get("month")}-${get("day")}`;
  }

  function calendarTodayKey() {
    return calendarKeyFromDate(new Date(), viewerTimeZone());
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
        kind: "task", title: task.title, time: task.time, isPrivate: Number(task.is_private) === 1,
        done: task.status === "done"
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

  // Точка одного события под числом. Личное (is_private) — пара склеенных
  // точек, как у аватаров в шапке: серая выглядывает из-за цветной («личное
  // спрятано»), а цвет передней показывает тип — план, дата или день рождения.
  function calendarEventDot(item, typeClass) {
    if (Number(item.is_private) === 1) {
      return `<span class="cal-dot-pair"><i class="cal-dot is-private"></i><i class="cal-dot ${typeClass}"></i></span>`;
    }
    return `<i class="cal-dot ${typeClass}"></i>`;
  }

  // Все события дня: по точке на каждое, звезда — вручённое желание.
  function calendarCellDots(bucket, cyclePeriods) {
    const dots = [];
    if (!bucket) return dots;
    if (bucket.wishes?.length) dots.push(`<span class="cal-star">${STAR_ICON}</span>`);
    for (const task of bucket.tasks || []) dots.push(calendarEventDot(task, "is-task"));
    for (const date of bucket.dates || []) dots.push(calendarEventDot(date, "is-date"));
    for (const birthday of bucket.birthdays || []) dots.push(calendarEventDot(birthday, "is-birthday"));
    // Фло: месячные для владелицы или партнёра (при шеринге)
    for (const period of cyclePeriods || []) {
      const start = period.start_date;
      const end = period.end_date || start;
      if (bucket.key >= start && bucket.key <= end) {
        dots.push(`<i class="cal-dot is-cycle" aria-hidden="true"></i>`);
        break;
      }
    }
    return dots;
  }

  // Календарь показывает все загруженные записи: state + страницы архива.
  // Приватность уже обеспечена сервером — /api/archive фильтрует is_private
  // по текущему пользователю, здесь никаких обходов нет.
  function renderPairCalendar() {
    // Завершённые планы — тоже события своего дня: точка остаётся, в списке
    // дня помечаем «· выполнено». mergedArchive("tasks") завершённые не
    // отдаёт, поэтому конкатенируем отдельным списком.
    const openTasks = mergedArchive("tasks", appState.tasks || []);
    const doneTasks = mergedArchive("done_tasks", appState.completedTasks || []);
    const dates = mergedArchive("dates", appState.dates || []);
    // Звёздочка — только мои вручённые желания: чужие подарки в календаре
    // пользователя не показываем (owner_id — владелец желания).
    const myId = Number(appState.user?.tg_id);
    const wishes = mergedArchive("done_wishes", appState.completedWishes || [])
      .filter((wish) => Number(wish.owner_id) === myId);
    // Фло: периоды месячных для владелицы или партнёра (при шеринге)
    const cyclePeriods = [];
    if (appState.user?.gender === 'female' && floState) {
      cyclePeriods.push(...floAllPeriods());
    } else if (floPartner?.shared === true && floPartner?.periods) {
      cyclePeriods.push(...floPartner.periods);
    }
    const today = calendarTodayKey();
    const { year, month } = calendarCurrentMonth();
    const index = calendarEventIndex(openTasks.concat(doneTasks), dates, wishes, year, month);
    const selected = calendarSelected;
    const weekdays = ["Пн", "Вт", "Ср", "Чт", "Пт", "Сб", "Вс"];

    const cellsHtml = calendarGrid(year, month).map((cell) => {
      const bucket = index.get(cell.key);
      const dots = calendarCellDots(bucket, cyclePeriods);
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
                <span class="cal-event-meta">${row.kind === "task" ? "План" : row.kind === "date" ? "Значимая дата" : row.kind === "birthday" ? "День рождения" : "Желание подарено"}${row.isPrivate ? " · личное" : ""}${row.done ? " · выполнено" : ""}${row.time ? ` · ${esc(row.time)}` : ""}${row.time && viewerTimeHint(selected, row.time) ? ` · ${esc(viewerTimeHint(selected, row.time))}` : ""}</span>
              </div>
            </div>
          `).join("") : `<p class="cal-empty">На этот день событий нет.</p>`}
        </div>
      `;
    }

    return `
      <section class="card calendar-card">
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
          <span><span class="cal-dot-pair" aria-hidden="true"><i class="cal-dot is-private"></i><i class="cal-dot is-task"></i></span> Личное</span>
          ${cyclePeriods.length ? '<span><i class="cal-dot is-cycle" aria-hidden="true"></i> Месячные</span>' : ''}
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
      : type === "done_tasks" ? (appState?.completedTasks || [])
        : type === "dates" ? (appState?.dates || [])
          : (appState?.completedWishes || []);
    // Завершённые планы и вручённые желания живут в «архиве» уже с 10 записей,
    // активные — с 200.
    const threshold = type === "done_wishes" || type === "done_tasks" ? STATE_RECENT_LIMIT : STATE_ACTIVE_LIMIT;
    if (recent.length < threshold) return false;
    return archiveCache[type].hasMore !== false;
  }

  async function ensureCalendarArchive() {
    if (calendarFetching) return;
    calendarFetching = true;
    try {
      for (const type of ["tasks", "dates", "done_tasks", "done_wishes"]) {
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
        <p class="settings-hint">Фото профиля Telegram вместо букв в кнопке пары. Если у пользователя фото нет, остаётся буква, пока аватар не появится</p>
        <div class="settings-row">
          <span class="settings-label">Ваше имя</span>
          <input id="display-name-input" type="text" maxlength="80" autocomplete="off" placeholder="${esc(user.display_name || "")}" value="${esc(user.custom_name || "")}">
        </div>
        <p class="settings-hint">Как ваше имя отображается у вас в приложении — например, если в Telegram у вас ник. Меняется только у вас. Пусто — имя из Telegram</p>
        <div class="settings-row">
          <span class="settings-label">Имя партнёра</span>
          <input id="partner-name-input" type="text" maxlength="80" autocomplete="off" placeholder="${esc(partnerName)}" value="${esc(user.partner_custom_name || "")}">
        </div>
        <p class="settings-hint">Каким вы видите имя партнёра в приложении — например, если в Telegram у него ник. Меняется только у вас. Пусто — имя партнёра из Telegram</p>
        <div class="settings-row">
          <span class="settings-label">Ваш часовой пояс</span>
          <span class="day-chip is-muted">${esc(viewerTimeZone())}</span>
        </div>
        <p class="settings-hint">Определяется по устройству автоматически и следует за вами в поездках: сводки приходят по вашим часам, календарь показывает ваше «сегодня»</p>
        <label class="settings-row">
          <span class="settings-label"><input type="checkbox" id="digest-enabled" ${user.digest_enabled ? "checked" : ""}> Утренняя сводка</span>
          <input type="time" id="digest-time" lang="ru" value="${esc(user.digest_time || "09:00")}">
        </label>
        <p class="settings-hint">Планы и значимые даты на сегодня и завтра — личным сообщением от бота. Время — местное: сводка придёт в ваш часовой пояс</p>
        <label class="settings-row">
          <span class="settings-label"><input type="checkbox" id="dates-digest-enabled" ${user.dates_digest_enabled ? "checked" : ""}> Даты за сутки</span>
          <input type="time" id="dates-digest-time" lang="ru" value="${esc(user.dates_digest_time || "09:00")}">
        </label>
        <p class="settings-hint">Напомнит о завтрашних датах накануне в выбранное время. Кроме сводок бот предупреждает о плане с точным временем за 3 часа и за час</p>
        <label class="settings-row">
          <span class="settings-label"><input type="checkbox" id="weekly-digest-enabled" ${user.weekly_digest_enabled ? "checked" : ""}> Недельная сводка</span>
          <input type="time" id="weekly-digest-time" lang="ru" value="${esc(user.weekly_digest_time || "09:00")}">
        </label>
        <div class="settings-row">
          <span class="settings-label">День сводки</span>
          <select id="weekly-digest-day" class="settings-select">
            <option value="sun"${user.weekly_digest_day !== "mon" ? " selected" : ""}>Воскресенье</option>
            <option value="mon"${user.weekly_digest_day === "mon" ? " selected" : ""}>Понедельник</option>
          </select>
        </div>
        <p class="settings-hint">Планы и даты на предстоящую неделю (пн–вс) одним сообщением — чтобы строить планы наперёд. Придёт в выбранный день и время по вашим часам</p>
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
        <p class="settings-hint">Четырёхзначный пароль будет запрашиваться при открытии приложения</p>
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
        <p class="settings-hint">Выберите разделы — бот пришлёт один файл с выбранным. Удобно хранить вне приложения</p>
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
        <p class="settings-hint">Общий для календаря, ритуала дня, напоминаний и времени событий у обоих партнёров — события закреплены за этим поясом. Личное «сегодня» и время сводок — по вашему поясу устройства</p>
        <button class="secondary full card-action" type="button" data-action="save-pair-timezone">Сохранить пояс</button>
      </section>
    `;
  }

  // Тело «Нашей пары»: профиль (календарь, настройки, выход) или желания.
  // Шапка и сегмент-переключатель живут в render() и при смене вида не
  // перерисовываются — капля остаётся на живом экземпляре.
  function renderPairView() {
    if (appState?.user?.gender === "male" && floPartner === undefined && !floPartnerBusy) loadFloPartner();
    if (pairView === "flo" && showFloTab()) return floIsOwner() ? renderFloView() : renderFloPartnerView();
    if (pairView === "wishes") return renderWishBlock();
    if (pairView === "savings") return renderSavingsBody();
    return renderPairBody();
  }

  // ------------------------------------------------------------------
  // Фло: трекер цикла (фаза 1). Видит только владелица; данные грузятся
  // с /api/cycle/state, прогноз считает сервер.
  // ------------------------------------------------------------------
  const FLO_PHASE_LABELS = {
    menstruation: "Менструация", follicular: "Фолликулярная", fertile: "Фертильное окно",
    ovulation: "Овуляция", luteal: "Лютеиновая", delay: "Задержка", stale: "Данные устарели"
  };

  async function loadFloState() {
    if (floBusy) return;
    floBusy = true;
    try {
      floState = await request("/api/cycle/state");
      floExtra = { periods: [], logs: [], meds: [], med_logs: [], measurements: [] };
      floFetchedMonths = new Set();
      if (!floMonth) floMonth = floState.today.slice(0, 7);
    } catch (error) {
      floState = { failed: true };
      handleRequestError(error);
    } finally {
      floBusy = false;
    }
    render();
  }

  async function floSave(body) {
    try {
      floState = await request("/api/cycle/period", { method: "POST", body });
      floExtraPutPeriod({ start_date: body.start, end_date: body.end || null });
      floStats = undefined;
      floSelectedDate = null;
    } catch (error) {
      handleRequestError(error);
    }
    render();
  }

  // Объединённые периоды/логи: state (свежие 36/400) поверх догруженных
  // месяцев floExtra. State выигрывает при совпадении ключа — он новее.
  function floAllPeriods() {
    const map = new Map();
    for (const p of floExtra.periods) map.set(p.start_date, p);
    for (const p of floState?.periods || []) map.set(p.start_date, p);
    return [...map.values()];
  }
  function floAllLogs() {
    const map = new Map();
    for (const l of floExtra.logs) map.set(l.date, l);
    for (const l of floState?.logs || []) map.set(l.date, l);
    return [...map.values()];
  }

  // Догрузка месяца через /api/cycle/history, если он старше окна state.
  // Каждый месяц запрашивается не более одного раза (floFetchedMonths).
  // История приносит весь набор данных: периоды, дневник, препараты, факт
  // приёма и измерения (переработка 9.3). Дедуп: периоды/дневник по ключу
  // даты, препараты по id, приёмы и измерения по естественным ключам —
  // повторная догрузка того же месяца не создаёт дубликаты.
  async function floEnsureMonth(ym) {
    if (!floState || floState.failed || floBusy) return;
    if (ym === floState.today.slice(0, 7)) return;
    const [y, m] = ym.split("-").map(Number);
    const last = new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10);
    if (last > floState.today || floFetchedMonths.has(ym)) return;
    floFetchedMonths.add(ym);
    try {
      const data = await request(`/api/cycle/history?from=${ym}-01&to=${last}`);
      const pMap = new Map(floExtra.periods.map(p => [p.start_date, p]));
      for (const p of data.periods || []) pMap.set(p.start_date, p);
      floExtra.periods = [...pMap.values()];
      const lMap = new Map(floExtra.logs.map(l => [l.date, l]));
      for (const l of data.logs || []) lMap.set(l.date, l);
      floExtra.logs = [...lMap.values()];
      const mMap = new Map(floExtra.meds.map(x => [x.id, x]));
      for (const x of data.meds || []) mMap.set(x.id, x);
      floExtra.meds = [...mMap.values()];
      const mlMap = new Map(floExtra.med_logs.map(x => [`${x.med_id}:${x.date}`, x]));
      for (const x of data.med_logs || []) mlMap.set(`${x.med_id}:${x.date}`, x);
      floExtra.med_logs = [...mlMap.values()];
      const measMap = new Map(floExtra.measurements.map(x => [x.id, x]));
      for (const x of data.measurements || []) measMap.set(x.id, x);
      floExtra.measurements = [...measMap.values()];
    } catch (error) {
      floFetchedMonths.delete(ym);
      handleRequestError(error);
      return;
    }
    render();
  }

  // Точечная синхронизация догруженных месяцев после мутаций: записи вне
  // окна state иначе показывали бы устаревшие значения из floExtra.
  function floExtraPutPeriod(p) {
    const map = new Map(floExtra.periods.map(x => [x.start_date, x]));
    const prev = map.get(p.start_date);
    // Флаг «конец неизвестен» сохраняем, если обновление его не несёт.
    map.set(p.start_date, { end_unknown: prev ? !!prev.end_unknown : false, ...p });
    floExtra.periods = [...map.values()];
  }
  function floExtraDelPeriod(start) {
    floExtra.periods = floExtra.periods.filter(x => x.start_date !== start);
  }
  function floExtraPutLog(l) {
    const map = new Map(floExtra.logs.map(x => [x.date, x]));
    map.set(l.date, l);
    floExtra.logs = [...map.values()];
  }

  function floInPeriod(date) {
    const periods = floAllPeriods();
    const today = floState?.today || "";
    return periods.some(p => date >= p.start_date && date <= (p.end_date || (p.start_date === floState?.open_period_start ? today : p.start_date)));
  }

  // Разница дат в днях (строки YYYY-MM-DD, без часовых поясов).
  function floDayDiff(from, to) {
    return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86400000);
  }

  // Сдвиг календарной даты YYYY-MM-DD на N дней (UTC, без часовых поясов).
  function floDateShift(dateStr, days) {
    return new Date(Date.parse(`${dateStr}T00:00:00Z`) + days * 86400000).toISOString().slice(0, 10);
  }

  // Редактор прошлых периодов — общий для шага мастера и карточки истории.
  // items: {start, end|null, end_unknown}. Открытый период сюда не добавляем:
  // у прошлых записей конец известен или честно «не помним».
  function floPrevEditorHtml(prefix, items) {
    const id = `flo-${prefix}-prev-start`;
    const rows = items.map((p, i) => `
      <div class="item-row">
        <div class="item-main">
          <p class="item-title">${esc(formatDay(p.start))}</p>
          <div class="item-meta">
            <span class="day-chip is-muted">${p.end ? `${floDayDiff(p.start, p.end) + 1} дн.` : "конец неизвестен"}</span>
          </div>
        </div>
        <button class="icon-btn" type="button" data-action="flo-prev-del" data-prefix="${prefix}" data-index="${i}" aria-label="Убрать">${DELETE_ICON}</button>
      </div>`).join("");
    return `
      ${rows}
      <label class="field"><span>Начало месячных</span>
        <input type="date" id="${id}" max="${esc(floState.today)}">
      </label>
      <p class="flo-sub">Длились, дней:</p>
      <div class="flo-chips">${[2, 3, 4, 5, 6, 7, 8].map(n =>
        `<button type="button" class="flo-chip" data-action="flo-prev-add" data-prefix="${prefix}" data-days="${n}">${n}</button>`).join("")}</div>
      <div class="flo-chips">
        <button type="button" class="flo-chip" data-action="flo-prev-add" data-prefix="${prefix}" data-unknown="1">Конец не помню</button>
      </div>`;
  }

  function floPrevItems(prefix) {
    return prefix === "wiz" ? (floWizard?.previous || []) : floHistPrev;
  }

  function floPrevSetItems(prefix, items) {
    if (prefix === "wiz") floWizard = { ...floWizard, previous: items };
    else floHistPrev = items;
  }

  function floDayClasses(date, inMonth = true) {
    const f = floState.forecast || {};
    // При устаревших данных прогнозный диапазон целиком в прошлом —
    // подсветку не рисуем, чтобы не создавать ложную картину.
    const fh = f.data_stale ? {} : f;
    // Ориентировочная оценка следующих месячных допустима даже при малой
    // истории (§4.1), но уверенное фертильное окно и день овуляции при
    // недостатке данных не рисуются вовсе — расчёт показан только текстом.
    const ovulationTrusted = fh.quality !== undefined && fh.quality !== "insufficient";
    const classes = [];
    if (floInPeriod(date)) classes.push("is-period");
    else if (!fh.empty && date >= fh.next_period_start && date <= fh.next_period_end) classes.push("is-predicted");
    if (ovulationTrusted && !fh.empty && date >= fh.fertile_start && date <= fh.fertile_end) classes.push("is-fertile");
    if (ovulationTrusted && !fh.empty && date === fh.ovulation_date) classes.push("is-ovulation");
    if (!fh.empty && fh.phase === "delay" && date >= fh.next_period_start && date <= floState.today) classes.push("is-delay");
    // «Сегодня» — только в своём месяце, как в общем календаре: кольцо
    // на приглушённой ячейке соседнего месяца читается как выбор.
    if (inMonth && date === floState.today) classes.push("is-today");
    return classes;
  }

  const FLO_HEART_ICON = '<svg class="cal-heart" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 21.35l-1.45-1.32C5.4 15.36 2 12.28 2 8.5 2 5.42 4.42 3 7.5 3c1.74 0 3.41.81 4.5 2.09C13.09 3.81 14.76 3 16.5 3 19.58 3 22 5.42 22 8.5c0 3.78-3.4 6.86-8.55 11.54L12 21.35z"/></svg>';

  // Количество сердечек в календаре: до 5 штук, дальше «+N», чтобы
  // ячейка не расползалась (flex-wrap уже разрешает перенос).
  function floSexHearts(count) {
    const n = Math.max(0, Math.min(Number(count) || 0, 20));
    const shown = Math.min(n, 5);
    const hearts = FLO_HEART_ICON.repeat(shown);
    return hearts + (n > 5 ? `<span class="cal-sex-more">+${n - 5}</span>` : "");
  }

  function floDayDots(date) {
    const log = floDayLog(date);
    // Секс — отдельный маркер: красные сердечки по числу отметок. Явная
    // отметка «без секса» — тоже факт, показывает её другим маркером (9.4).
    const sexCount = (log.sex === "protected" || log.sex === "unprotected") ? (log.sex_count || 1) : 0;
    const noSex = log.sex === "none";
    // Любая запись дня даёт индикатор: флоу, сгустки, настроение, энергия,
    // симптомы (включая «симптомов не было»), заметка, протечки, боль,
    // сон, стресс, слизь, факторы, вес, сведения о кровотечении.
    const hasLog = log.flow || log.clots || log.mood || log.energy || log.symptoms?.length || log.symptoms_clear || log.note || log.leakage || log.pain_score !== null && log.pain_score !== undefined || log.life_impact || log.pain_locations?.length || log.sleep_hours !== null && log.sleep_hours !== undefined || log.sleep_quality || log.stress || log.sick || log.travel || log.weight_kg !== null && log.weight_kg !== undefined || log.mucus || log.bleeding_details;
    return `${hasLog ? `<i class="cal-dot is-log"></i>` : ""}${sexCount ? floSexHearts(sexCount) : ""}${noSex ? `<i class="cal-dot is-no-sex" aria-hidden="true"></i>` : ""}`;
  }

  // Сводка записей выбранного дня под календарём — как cal-events в общем
  // календаре: маркер + короткие факты, без развёрнутого дневника.
  function floDayEventRows(date) {
    const rows = [];
    const log = floDayLog(date);
    const label = (list, code) => list.find(([c]) => c === code)?.[1] || code || "";
    if (floInPeriod(date)) rows.push({ icon: "period", title: "Месячные", meta: "день цикла" });
    const facts = [];
    if (log.flow) facts.push(`Кровотечение: ${label(FLO_FLOWS, log.flow)}`);
    if (log.clots) facts.push("сгустки");
    if (log.leakage) facts.push(`Протекание: ${label(FLO_LEAKAGE, log.leakage)}`);
    if (log.pain_score !== null && log.pain_score !== undefined) facts.push(`Боль ${log.pain_score}/10`);
    if (log.mood) facts.push(`Настроение: ${label(FLO_MOODS, log.mood)}`);
    if (log.energy) facts.push(`Энергия: ${label(FLO_ENERGY, log.energy)}`);
    if (log.symptoms?.length) facts.push(`Симптомы: ${log.symptoms.map(c => label(FLO_SYMPTOMS, c)).join(", ")}`);
    else if (log.symptoms_clear) facts.push("Симптомов не было");
    const mucusParts = log.mucus ? [log.mucus.amount && label(FLO_MUCUS_AMOUNTS, log.mucus.amount), log.mucus.consistency && label(FLO_MUCUS_CONSISTENCY, log.mucus.consistency), log.mucus.color && label(FLO_MUCUS_COLORS, log.mucus.color)].filter(Boolean) : [];
    if (mucusParts.length) facts.push(`Слизь: ${mucusParts.join(", ")}`);
    if (log.sleep_hours !== null && log.sleep_hours !== undefined) facts.push(`Сон ${log.sleep_hours} ч`);
    if (log.sleep_quality) facts.push(`Сон: ${label(FLO_SLEEP_QUALITY, log.sleep_quality)}`);
    const bleedingParts = log.bleeding_details ? [
      log.bleeding_details.changes_per_day !== null && log.bleeding_details.changes_per_day !== undefined ? `смен ${log.bleeding_details.changes_per_day}` : "",
      log.bleeding_details.saturation ? `пропитывание: ${label(FLO_BLEEDING_SATURATION, log.bleeding_details.saturation)}` : "",
      log.bleeding_details.night_change ? "ночная смена" : ""
    ].filter(Boolean) : [];
    if (bleedingParts.length) facts.push(`Гигиена: ${bleedingParts.join(", ")}`);
    const factors = [log.stress ? `стресс: ${label(FLO_STRESS, log.stress)}` : "", log.sick ? "болезнь" : "", log.travel ? "поездка" : "", log.weight_kg ? `${log.weight_kg} кг` : ""].filter(Boolean);
    if (factors.length) facts.push(factors.join(", "));
    if (facts.length) rows.push({ icon: "log", title: "Дневник", meta: facts.join(" · ") });
    const sexCount = (log.sex === "protected" || log.sex === "unprotected") ? (log.sex_count || 1) : 0;
    if (sexCount) {
      rows.push({ icon: "heart", title: "Секс", meta: `${log.sex === "protected" ? "с защитой" : "без защиты"}${sexCount > 1 ? ` ×${sexCount}` : ""}` });
    } else if (log.sex === "none") {
      // Явная отметка «без секса» — не пустая ячейка, а записанный факт (9.4).
      rows.push({ icon: "none", title: "Секс", meta: "без секса (отмечено)" });
    }
    if (log.note) rows.push({ icon: "log", title: "Заметка", meta: log.note.length > 80 ? `${log.note.slice(0, 80)}…` : log.note });
    for (const m of floMeasurements(date)) {
      const txt = m.kind === "bbt"
        ? `БТ ${m.value}°${m.unit === "F" ? "F" : "C"}${m.time ? ` ${m.time}` : ""}`
        : `ЛГ: ${label(FLO_LH_RESULTS, m.result) || m.result || "—"}`;
      rows.push({ icon: "log", title: "Измерение", meta: txt });
    }
    const medName = id => floMeds().find(m => m.id === id)?.name || "";
    for (const ml of (floState?.med_logs || []).filter(l => l.date === date)) {
      rows.push({ icon: "log", title: "Препарат", meta: `${medName(ml.med_id) || `#${ml.med_id}`}: ${ml.status === "taken" ? "принят" : "пропущен"}${ml.time ? ` ${ml.time}` : ""}` });
    }
    return rows;
  }

  function renderFloCalendar() {
    const [year, month] = floMonth.split("-").map(Number);
    const cells = calendarGrid(year, month).map(cell => {
      const classes = ["cal-day", ...floDayClasses(cell.key, cell.inMonth)];
      if (!cell.inMonth) classes.push("is-outside");
      if (cell.key === floSelectedDate) classes.push("is-selected");
      const dots = floDayDots(cell.key);
      // has-events — как в общем календаре: число дней с записями чуть жирнее.
      if (dots) classes.push("has-events");
      const label = `${calendarLongDate(cell.key)}${dots ? ", есть запись" : ""}`;
      return `<button type="button" class="${classes.join(" ")}" data-action="flo-select-day" data-date="${cell.key}"
        aria-label="${esc(label)}"${cell.key === floSelectedDate ? ' aria-pressed="true"' : ""}>
        <span class="cal-num">${cell.day}</span>
        ${dots ? `<span class="cal-dots" aria-hidden="true">${dots}</span>` : ""}
      </button>`;
    }).join("");
    return `
      <section class="card calendar-card">
        <div class="cal-head">
          <button type="button" class="cal-nav-btn" data-action="flo-month-prev" aria-label="Предыдущий месяц">${CHEVRON_LEFT}</button>
          <h3 class="cal-title">${esc(calendarMonthTitle(year, month))}</h3>
          <button type="button" class="cal-nav-btn" data-action="flo-month-next" aria-label="Следующий месяц">${CHEVRON_RIGHT}</button>
        </div>
        <div class="cal-weekdays" aria-hidden="true">${["Пн", "Вт", "Ср", "Чт", "Пт", "Сб", "Вс"].map(w => `<span>${w}</span>`).join("")}</div>
        <div class="cal-grid">${cells}</div>
        <div class="cal-legend">
          <span><i class="cal-dot is-period" aria-hidden="true"></i>Месячные</span>
          <span><i class="cal-dot is-predicted" aria-hidden="true"></i>Прогноз</span>
          <span><i class="cal-dot is-delay" aria-hidden="true"></i>Задержка</span>
          <span><i class="cal-dot is-fertile" aria-hidden="true"></i>Фертильно (расчёт)</span>
          <span><i class="cal-dot is-ovulation" aria-hidden="true"></i>Овуляция (расчёт)</span>
          <span><i class="cal-dot is-log" aria-hidden="true"></i>Запись</span>
          <span><svg class="cal-heart" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 21.35l-1.45-1.32C5.4 15.36 2 12.28 2 8.5 2 5.42 4.42 3 7.5 3c1.74 0 3.41.81 4.5 2.09C13.09 3.81 14.76 3 16.5 3 19.58 3 22 5.42 22 8.5c0 3.78-3.4 6.86-8.55 11.54L12 21.35z"/></svg>Секс</span>
          <span><i class="cal-dot is-no-sex" aria-hidden="true"></i>Без секса</span>
        </div>
        ${(() => {
          if (!floSelectedDate) return "";
          const rows = floDayEventRows(floSelectedDate);
          return `<div class="cal-events">
            <p class="cal-events-date">${esc(calendarLongDate(floSelectedDate))}</p>
            ${rows.length ? rows.map(row => `
              <div class="cal-event">
                ${row.icon === "heart" ? FLO_HEART_ICON : `<i class="cal-dot ${row.icon === "period" ? "is-period" : row.icon === "none" ? "is-no-sex" : "is-log"}" aria-hidden="true"></i>`}
                <div class="cal-event-body">
                  <span class="cal-event-title">${esc(row.title)}</span>
                  <span class="cal-event-meta">${esc(row.meta)}</span>
                </div>
              </div>`).join("") : `<p class="cal-empty">Записей нет.</p>`}
          </div>`;
        })()}
      </section>`;
  }

  // Этап 4 (P1): сгустки — отдельный признак, эмоции не в симптомах, энергия отдельно.
  const FLO_FLOWS = [["spotting", "мажь"], ["light", "слабые"], ["medium", "средние"], ["heavy", "сильные"]];
  const FLO_SYMPTOMS = [
    ["cramps", "судороги"], ["headache", "голова"], ["bloating", "вздутие"], ["breast_tenderness", "грудь"],
    ["fatigue", "усталость"], ["acne", "акне"], ["nausea", "тошнота"], ["back_pain", "спина"],
    ["dizziness", "головокружение"], ["constipation", "запор"], ["diarrhea", "диарея"],
    ["exercise", "спорт"], ["good_sleep", "хороший сон"],
    ["poor_sleep", "плохой сон"], ["water", "вода"]
  ];

  const FLO_MOODS = [["happy", "радость"], ["calm", "спокойствие"], ["sensitive", "чувствительность"], ["irritable", "раздражительность"], ["anxious", "тревожность"], ["sad", "грусть"], ["mood_swings", "перепады"]];
  const FLO_ENERGY = [["very_low", "очень низкая"], ["low", "низкая"], ["normal", "обычная"], ["high", "высокая"]];
  // Добивка дневника (этап 4/P1): протекание, боль 0–10 с локализацией,
  // влияние симптомов на жизнь. Значения опциональны.
  const FLO_LEAKAGE = [["day", "днём"], ["night", "ночью"]];
  const FLO_PAIN_LOCATIONS = [
    ["lower_abdomen", "низ живота"], ["pelvis", "таз"], ["left_side", "слева"], ["right_side", "справа"],
    ["lower_back", "поясница"], ["breasts", "грудь"], ["other", "другое"]
  ];
  const FLO_LIFE_IMPACT = [["none", "никак"], ["little", "немного"], ["limited", "ограничила дела"], ["gave_up", "отказалась от дел"]];
  // Этап 6/P2: слизь, факторы дня, измерения, препараты.
  const FLO_MUCUS_AMOUNTS = [["none", "нет"], ["low", "мало"], ["medium", "умеренно"], ["high", "много"]];
  const FLO_MUCUS_CONSISTENCY = [["dry", "сухая"], ["sticky", "липкая"], ["creamy", "сливкообразная"], ["watery", "водянистая"], ["stringy", "тягучая"]];
  const FLO_MUCUS_COLORS = [["clear", "прозрачная"], ["white", "белая"], ["cloudy", "мутная"], ["other", "другая"]];
  const FLO_SLEEP_QUALITY = [["good", "хорошо"], ["ok", "средне"], ["poor", "плохо"]];
  const FLO_BLEEDING_SATURATION = [["low", "слабое"], ["medium", "среднее"], ["high", "сильное"]];
  const FLO_STRESS = [["low", "низкий"], ["medium", "средний"], ["high", "высокий"]];
  const FLO_MED_CATEGORIES = [["hormonal", "гормональный"], ["contraceptive", "контрацепция"], ["supplement", "БАД"], ["other", "прочее"]];
  const FLO_MED_FORMS = [["tablet", "таблетка"], ["capsule", "капсула"], ["injection", "укол"], ["patch", "пластырь"], ["iud", "спираль"], ["other", "прочее"]];
  const FLO_MED_STATUS = [["active", "активен"], ["completed", "завершён"], ["paused", "приостановлен"]];
  const FLO_MEASUREMENT_KINDS = [["bbt", "Базальная температура"], ["lh", "Тест на ЛГ"]];
  const FLO_LH_RESULTS = [["negative", "отрицательный"], ["positive", "положительный"], ["unclear", "неясно"]];

  function floDayLog(date) {
    return floAllLogs().find(l => l.date === date) || { flow: null, mood: null, symptoms: [], note: "", sex: null, sex_count: 0, clots: false, energy: null, symptoms_clear: false, leakage: null, pain_score: null, pain_locations: [], life_impact: null, mucus: null, sleep_hours: null, sleep_quality: null, stress: null, sick: false, travel: false, weight_kg: null };
  }

  async function floPostLog(date, patch) {
    const current = floDayLog(date);
    const body = {
      date,
      flow: current.flow, mood: current.mood, symptoms: current.symptoms, note: current.note, sex: current.sex || null,
      sex_count: current.sex_count || 0,
      clots: !!current.clots, energy: current.energy || null, symptoms_clear: !!current.symptoms_clear,
      leakage: current.leakage || null, pain_score: current.pain_score ?? null,
      pain_locations: current.pain_locations || [], life_impact: current.life_impact || null,
      mucus: current.mucus || null, sleep_hours: current.sleep_hours ?? null,
      sleep_quality: current.sleep_quality || null, stress: current.stress || null,
      sick: !!current.sick, travel: !!current.travel, weight_kg: current.weight_kg ?? null,
      ...patch
    };
    // «Симптомов не было» и конкретные симптомы взаимоисключающие (9.2):
    // выбор одного снимает другой, иначе сервер отклонит запись.
    if (body.symptoms_clear && (body.symptoms || []).length) body.symptoms = [];
    if ((body.symptoms || []).length) body.symptoms_clear = false;
    try {
      floState = await request("/api/cycle/log", { method: "POST", body });
      floExtraPutLog({ date, ...body });
      floStats = undefined;
    } catch (error) {
      handleRequestError(error);
    }
    render();
  }

  // --- P2: измерения (БТ/ЛГ) и факт приёма препаратов за выбранный день ---
  // Данные за старые месяцы живут в floExtra (догрузка истории): объединяем
  // с окном state. State выигрывает при совпадении ключа — он новее.
  function floAllMeasurements() {
    const map = new Map(floExtra.measurements.map(m => [m.id, m]));
    for (const m of floState?.measurements || []) map.set(m.id, m);
    return [...map.values()];
  }
  function floAllMedLogs() {
    const map = new Map(floExtra.med_logs.map(l => [`${l.med_id}:${l.date}`, l]));
    for (const l of floState?.med_logs || []) map.set(`${l.med_id}:${l.date}`, l);
    return [...map.values()];
  }
  function floMeasurements(date) {
    return floAllMeasurements().filter(m => m.date === date);
  }
  function floMedLogFor(medId, date) {
    return floAllMedLogs().find(l => l.med_id === medId && l.date === date) || null;
  }
  function floMeds() {
    const map = new Map(floExtra.meds.map(m => [m.id, m]));
    for (const m of floState?.meds || []) map.set(m.id, m);
    return [...map.values()].sort((a, b) => (a.id < b.id ? -1 : 1));
  }
  let floLhDraft = { date: null, result: null };

  // P3: есть ли вообще какая-то запись за день (дневник, измерение, приём).
  // Пропуск ≠ «симптомов не было» — для подсказки в карточке дня.
  function floDayHasRecord(date) {
    return floAllLogs().some(l => l.date === date)
      || floMeasurements(date).length > 0
      || (floState?.med_logs || []).some(l => l.date === date);
  }

  function renderFloMeasurements(d, future) {
    const items = floMeasurements(d);
    const measLabel = m => m.kind === "bbt"
      ? `БТ ${m.value ?? "—"}°${m.unit === "F" ? "F" : "C"}`
      : `ЛГ: ${FLO_LH_RESULTS.find(([c]) => c === m.result)?.[1] || m.result || "—"}`;
    const list = items.map(m => `
      <div class="item-row">
        <div class="item-main">
          <p class="item-title">${esc(measLabel(m))}${m.time ? ` · ${esc(m.time)}` : ""}</p>
          ${m.note ? `<p class="item-meta">${esc(m.note)}</p>` : ""}
        </div>
        <button class="icon-btn" type="button" data-action="flo-del-measurement" data-id="${m.id}" aria-label="Удалить">${DELETE_ICON}</button>
      </div>`).join("");
    const dis = future ? " disabled" : "";
    const lhOn = floLhDraft.date === d ? floLhDraft.result : null;
    return `
      ${list || `<p class="flo-disclaimer">За этот день измерений нет</p>`}
      <p class="settings-hint">БТ: измеряйте сразу после пробуждения, до подъёма с кровати, в одно и то же время, после не менее 3 часов сна. Болезнь, поздний отбой и алкоголь искажают результат — в такой день отметьте «болезнь/температура» в факторах дня, и замер не попадёт в температурный сдвиг.</p>
      <div class="flo-actions" style="margin-top:6px">
        <input id="flo-bbt" class="flo-input" type="number" inputmode="decimal" min="34" max="42" step="0.05" placeholder="БТ, °C" style="width:110px">
        <input id="flo-bbt-time" class="flo-input" type="time" aria-label="Время">
        <button type="button" class="secondary" data-action="flo-add-bbt" data-date="${d}"${dis}>Записать</button>
      </div>
      <div class="flo-chips" style="margin-top:6px">
        ${FLO_LH_RESULTS.map(([code, label]) =>
          `<button type="button" class="flo-chip${lhOn === code ? " is-on" : ""}" data-action="flo-pick-lh" data-date="${d}" data-value="${code}"${dis} aria-pressed="${lhOn === code}">${label}</button>`).join("")}
      </div>
      <div class="flo-actions" style="margin-top:6px">
        <input id="flo-lh-time" class="flo-input" type="time" aria-label="Время теста">
        <button type="button" class="secondary" data-action="flo-add-lh" data-date="${d}"${dis || !lhOn ? " disabled" : ""}>Записать ЛГ</button>
      </div>`;
  }

  function renderFloDayMeds(d, future) {
    const meds = floMeds();
    if (!meds.length) {
      return `<p class="flo-disclaimer">Список пуст — добавьте препараты в настройках Фло («Мои препараты»). Дозы и схемы здесь не назначаются, только фиксируется факт</p>`;
    }
    const rows = meds.map(m => {
      const log = floMedLogFor(m.id, d);
      const statusLabel = log ? ({ taken: "принят", skipped: "пропущен" })[log.status] || log.status : "не отмечен";
      const key = `${m.id}:${d}`;
      const open = floMedDetail === key;
      const meta = [m.dosage, m.schedule].filter(Boolean).join(" · ");
      const chips = future ? "" : `
        <div class="flo-chips" style="margin-top:6px">
          <button type="button" class="flo-chip${log?.status === "taken" ? " is-on" : ""}" data-action="flo-med-intake" data-med="${m.id}" data-date="${d}" data-status="taken">Принят</button>
          <button type="button" class="flo-chip${log?.status === "skipped" ? " is-on" : ""}" data-action="flo-med-intake" data-med="${m.id}" data-date="${d}" data-status="skipped">Пропущен</button>
          ${log ? `<button type="button" class="flo-chip" data-action="flo-med-intake-clear" data-med="${m.id}" data-date="${d}">Снять отметку</button>` : ""}
          <button type="button" class="flo-chip" data-action="flo-med-detail" data-med="${m.id}" data-date="${d}">${open ? "Скрыть детали" : "Время/доза/комментарий"}</button>
        </div>`;
      const detail = open ? `
        <div class="flo-actions" style="margin-top:6px">
          <input id="flo-med-time-${m.id}" class="flo-input" type="time" value="${esc(log?.time || "")}" aria-label="Время приёма">
          <input id="flo-med-dose-${m.id}" class="flo-input" type="text" maxlength="120" placeholder="Фактическая доза" value="${esc(log?.dose_taken || "")}" style="width:130px">
        </div>
        <input id="flo-med-note-${m.id}" class="flo-input" type="text" maxlength="500" placeholder="Комментарий" value="${esc(log?.note || "")}" style="margin-top:6px;width:100%">` : "";
      return `<div class="flo-med-row">
        <p class="item-title">${esc(m.name)}</p>
        <p class="item-meta">${esc(statusLabel)}${log?.time ? ` · ${esc(log.time)}` : ""}${log?.dose_taken ? ` · ${esc(log.dose_taken)}` : ""}${meta ? ` · ${esc(meta)}` : ""}</p>
        ${chips}${detail}
      </div>`;
    }).join("");
    return `${rows}
      <p class="settings-hint">Отметка «принят/пропущен» — общий итог за день, контроль отдельных доз не ведётся</p>
      <p class="flo-disclaimer">Состав и дозы — в «Моих препаратах» в настройках. Приложение не назначает и не отменяет приём</p>`;
  }

  async function floPostMeasurement(body) {
    try {
      floState = await request("/api/cycle/measurement", { method: "POST", body });
      floStats = undefined;
    } catch (error) {
      handleRequestError(error);
    }
    render();
  }
  async function floPostMedLog(body) {
    try {
      floState = await request("/api/cycle/med-log", { method: "POST", body });
      // Синхронизируем догруженные месяцы: иначе старый месяц показывал бы
      // устаревший факт приёма (тот же принцип, что floExtraPutLog).
      const map = new Map(floExtra.med_logs.map(x => [`${x.med_id}:${x.date}`, x]));
      map.set(`${body.med_id}:${body.date}`, { med_id: body.med_id, date: body.date, status: body.status, time: body.time || null, dose_taken: body.dose_taken || null, note: body.note || null });
      floExtra.med_logs = [...map.values()];
    } catch (error) {
      handleRequestError(error);
    }
    render();
  }

  // Карточка дня (переработка 12): три уровня ввода — быстрая отметка
  // (кровотечение, боль, настроение, энергия), дополнительные наблюдения
  // (симптомы по группам, сон, стресс, слизь, измерения, секс) и подробный
  // дневник (препараты, заметка, факторы, сведения о кровотечении).
  // Будущие дни — только просмотр (9.1): сервер всё равно отклоняет записи,
  // так что все элементы ввода дизейблятся.
  function renderFloDayCard() {
    if (!floSelectedDate) return "";
    const open = floState.open_period_start;
    const d = floSelectedDate;
    const future = d > floState.today;
    const canEnd = Boolean(open && d >= open && !future);
    const log = floDayLog(d);
    const dis = future ? " disabled" : "";
    const chip = (action, label, on, attr, value) =>
      `<button type="button" class="flo-chip${on ? " is-on" : ""}" data-action="${action}" data-date="${d}" ${attr}="${esc(value)}"${future ? " disabled" : ""} aria-pressed="${on}">${esc(label)}</button>`;
    // Симптомы по категориям (переработка 5): физиологические симптомы,
    // активность, сон и привычки — раздельные группы. Коды хранятся в одном
    // списке symptoms, группировка — только отображение, старые записи совместимы.
    const symptomGroups = [
      ["Симптомы", ["cramps", "headache", "bloating", "breast_tenderness", "fatigue", "acne", "nausea", "back_pain", "dizziness", "constipation", "diarrhea"]],
      ["Активность", ["exercise"]],
      ["Сон", ["good_sleep", "poor_sleep"]],
      ["Привычки", ["water"]]
    ];
    const symptomChips = symptomGroups.map(([groupTitle, codes]) =>
      `<p class="flo-sub">${esc(groupTitle)}</p><div class="flo-chips">${codes.map(code => {
        const found = FLO_SYMPTOMS.find(([c]) => c === code);
        return chip("flo-toggle-symptom", found?.[1] || code, log.symptoms.includes(code), "data-code", code);
      }).join("")}</div>`).join("");
    return `
      <section class="card" id="flo-day-card">
        <p class="eyebrow">Выбранный день</p>
        <h3>${esc(formatDay(d))}</h3>
        ${future ? `<p class="settings-hint">Будущий день — просмотр: записи можно делать сегодня или в прошлом.</p>` : ""}
        <button type="button" class="primary full card-action" data-action="flo-day-start" data-date="${d}"${dis}>Начало месячных</button>
        ${canEnd ? `<button type="button" class="secondary full card-action" data-action="flo-day-end" data-date="${d}"${dis}>Конец месячных</button>` : ""}
        ${!future && d < floState.today && !floDayHasRecord(d) ? `<p class="settings-hint">За этот день записей нет — это не то же самое, что «симптомов не было»: день просто пропущен.</p>` : ""}
        <p class="eyebrow flo-group">Быстрая отметка</p>
        <p class="flo-sub">Кровотечение</p>
        <div class="flo-chips">${FLO_FLOWS.map(([code, label]) => chip("flo-set-flow", label, log.flow === code, "data-flow", code)).join("")}</div>
        <p class="flo-sub">Боль, 0–10</p>
        <div class="flo-chips flo-pain-scale">${Array.from({ length: 11 }, (_, n) => chip("flo-set-pain", String(n), log.pain_score === n, "data-pain", n)).join("")}</div>
        <p class="flo-sub">Настроение</p>
        <div class="flo-chips">${FLO_MOODS.map(([code, label]) => chip("flo-set-mood", label, log.mood === code, "data-mood", code)).join("")}</div>
        <p class="flo-sub">Энергия</p>
        <div class="flo-chips">${FLO_ENERGY.map(([code, label]) => chip("flo-set-energy", label, log.energy === code, "data-energy", code)).join("")}</div>
        <div class="flo-chips" style="margin-top:6px">
          <button type="button" class="flo-chip${log.symptoms_clear ? " is-on" : ""}" data-action="flo-toggle-clear" data-date="${d}"${dis} aria-pressed="${log.symptoms_clear}">Симптомов не было</button>
        </div>
        <p class="settings-hint">«Симптомов не было» — явная отметка: день записан, но ничего не беспокоило. Пропущенный день — не отметка</p>
        <details class="flo-fold"><summary class="flo-fold-title">Дополнительно: симптомы, сон, слизь, измерения, секс</summary>
        ${symptomChips}
        <p class="flo-sub">Сон</p>
        <div class="flo-chips">${FLO_SLEEP_QUALITY.map(([code, label]) => chip("flo-set-sleep-quality", label, log.sleep_quality === code, "data-value", code)).join("")}</div>
        <p class="flo-sub">Стресс</p>
        <div class="flo-chips">${FLO_STRESS.map(([code, label]) => chip("flo-set-stress", label, log.stress === code, "data-value", code)).join("")}</div>
        <p class="flo-sub">Слизь и выделения</p>
        <p class="settings-hint">Цвет и консистенция — приблизительное наблюдение, не диагноз</p>
        ${([["amount", FLO_MUCUS_AMOUNTS], ["consistency", FLO_MUCUS_CONSISTENCY], ["color", FLO_MUCUS_COLORS]]).map(([field, opts]) =>
          `<div class="flo-chips"${field === "amount" ? "" : ` style="margin-top:6px"`}>${opts.map(([code, label]) =>
            `<button type="button" class="flo-chip${log.mucus?.[field] === code ? " is-on" : ""}" data-action="flo-set-mucus" data-date="${d}" data-field="${field}" data-value="${esc(code)}"${dis} aria-pressed="${log.mucus?.[field] === code}">${esc(label)}</button>`).join("")}</div>`).join("")}
        <div class="flo-chips" style="margin-top:6px">
          <button type="button" class="flo-chip${log.mucus?.discomfort ? " is-on" : ""}" data-action="flo-toggle-mucus-discomfort" data-date="${d}"${dis} aria-pressed="${!!log.mucus?.discomfort}">Дискомфорт</button>
        </div>
        <p class="flo-sub">Измерения</p>
        ${renderFloMeasurements(d, future)}
        <p class="flo-sub">Секс</p>
        <p class="settings-hint">Повторите отметку для нескольких раз за день</p>
        <div class="flo-chips">${[["protected", "с защитой"], ["unprotected", "без защиты"], ["none", "без секса"]].map(([code, label]) => chip("flo-set-sex", label, log.sex === code, "data-sex", code)).join("")}</div>
        ${(log.sex === "protected" || log.sex === "unprotected") ? `<div class="flo-chips" style="margin-top:6px">
          <button type="button" class="flo-chip" data-action="flo-sex-dec" data-date="${d}"${dis} aria-label="Убрать одну отметку">−</button>
          <span class="flo-sex-count">Отметок: ${log.sex_count || 1}</span>
          <button type="button" class="flo-chip" data-action="flo-sex-inc" data-date="${d}"${dis} aria-label="Добавить отметку">+</button>
        </div>` : ""}
        </details>
        <details class="flo-fold"><summary class="flo-fold-title">Подробный дневник: препараты, факторы, кровотечение, заметка</summary>
        <p class="flo-sub">Лекарства и препараты</p>
        ${renderFloDayMeds(d, future)}
        <p class="flo-sub">Факторы дня</p>
        <div class="flo-chips">
          <button type="button" class="flo-chip${log.sick ? " is-on" : ""}" data-action="flo-toggle-sick" data-date="${d}"${dis} aria-pressed="${!!log.sick}">Болезнь/температура</button>
          <button type="button" class="flo-chip${log.travel ? " is-on" : ""}" data-action="flo-toggle-travel" data-date="${d}"${dis} aria-pressed="${!!log.travel}">Поездка/смена времени</button>
        </div>
        <label class="field" style="margin-top:6px"><span>Сон, часов</span>
          <input id="flo-sleep-hours" type="number" inputmode="decimal" min="0" max="24" step="0.5" value="${log.sleep_hours ?? ""}" placeholder="не указано"${dis}>
        </label>
        <label class="field" style="margin-top:6px"><span>Вес, кг</span>
          <input id="flo-weight" type="number" inputmode="decimal" min="30" max="250" step="0.1" value="${log.weight_kg ?? ""}" placeholder="не указано"${dis}>
        </label>
        <button type="button" class="secondary full card-action" data-action="flo-save-factors" data-date="${d}"${dis}>Сохранить сон и вес</button>
        <p class="flo-sub">Кровотечение подробнее</p>
        <div class="flo-chips">
          <button type="button" class="flo-chip${log.clots ? " is-on" : ""}" data-action="flo-set-clots" data-date="${d}" data-value="${!log.clots}"${dis} aria-pressed="${log.clots}">Сгустки были</button>
          ${FLO_LEAKAGE.map(([code, label]) => chip("flo-set-leakage", label, log.leakage === code, "data-leakage", code)).join("")}
        </div>
        <p class="settings-hint">Если сгустки крупные или их много — покажите это врачу</p>
        <div class="flo-chips" style="margin-top:6px">
          ${FLO_BLEEDING_SATURATION.map(([code, label]) => chip("flo-set-bleeding-saturation", label, log.bleeding_details?.saturation === code, "data-value", code)).join("")}
        </div>
        <label class="field" style="margin-top:6px"><span>Смен средства гигиены за день</span>
          <input id="flo-bleeding-changes" type="number" inputmode="numeric" min="0" max="24" step="1" value="${log.bleeding_details?.changes_per_day ?? ""}" placeholder="не указано"${dis}>
        </label>
        <div class="flo-chips" style="margin-top:6px">
          <button type="button" class="flo-chip${log.bleeding_details?.night_change ? " is-on" : ""}" data-action="flo-toggle-bleeding-night" data-date="${d}"${dis} aria-pressed="${!!log.bleeding_details?.night_change}">Ночная смена</button>
        </div>
        <button type="button" class="secondary full card-action" data-action="flo-save-bleeding" data-date="${d}"${dis}>Сохранить сведения о кровотечении</button>
        <p class="flo-sub">Влияние на жизнь</p>
        <div class="flo-chips">${FLO_LIFE_IMPACT.map(([code, label]) => chip("flo-set-impact", label, log.life_impact === code, "data-impact", code)).join("")}</div>
        <p class="flo-sub">Заметка</p>
        <label class="field"><span>Заметка</span><textarea id="flo-note" rows="2" maxlength="2000"${dis}>${esc(log.note || "")}</textarea></label>
        <button type="button" class="secondary full card-action" data-action="flo-save-note" data-date="${d}"${dis}>Сохранить заметку</button>
        </details>
      </section>`;
  }

  function renderFloHistory() {
    const periods = [...floAllPeriods()].sort((a, b) => (a.start_date < b.start_date ? -1 : 1));
    if (!periods.length) return "";
    const day = str => Date.parse(`${str}T00:00:00Z`) / 86400000;
    const rows = periods.map((p, i) => {
      const len = p.end_date ? day(p.end_date) - day(p.start_date) + 1 : null;
      const next = periods[i + 1];
      const cycle = next ? day(next.start_date) - day(p.start_date) : null;
      // Три состояния честно: идёт (открытый), конец неизвестен (импорт),
      // закрыт с датой. NULL-end без флага — открытый, как раньше.
      const kind = p.end_date ? null : (p.end_unknown ? "unknown" : "open");
      return { start: p.start_date, len, cycle, kind };
    });
    const cycles = rows.map(r => r.cycle).filter(c => c !== null);
    const lens = rows.map(r => r.len).filter(l => l !== null);
    const avg = arr => (arr.length ? Math.round((arr.reduce((a, b) => a + b, 0) / arr.length) * 10) / 10 : "—");
    const summary = `<p class="settings-hint">Средний цикл: <b>${avg(cycles)}</b> дн. · месячные: <b>${avg(lens)}</b> дн.</p>`;
    const list = rows.slice().reverse().slice(0, 12).map(r =>
      `<div class="item-row">
        <div class="item-main">
          <p class="item-title">${esc(formatDay(r.start))}</p>
          <div class="item-meta">
            <span class="day-chip is-muted">${r.kind === "unknown" ? "конец неизвестен" : r.len === null ? "идут" : `${r.len} дн.`}</span>
            <span>цикл ${r.cycle ?? "—"} дн.</span>
          </div>
        </div>
        <button class="icon-btn" type="button" data-action="flo-edit-period" data-start="${esc(r.start)}" aria-label="Изменить">${EDIT_ICON}</button>
      </div>`).join("");
    const prevBlock = floHistPrevOpen
      ? `${floPrevEditorHtml("hist", floHistPrev)}
         <button type="button" class="primary full card-action" data-action="flo-hist-prev-save"${floHistPrev.length ? "" : " disabled"}>Сохранить историю</button>
         <button type="button" class="secondary full card-action" data-action="flo-hist-prev-toggle">Отмена</button>`
      : `<button type="button" class="secondary full card-action" data-action="flo-hist-prev-toggle">Добавить прошлые периоды</button>`;
    return `
      <section class="card">
        <p class="eyebrow">История циклов</p>
        <h3>Месячные и длина цикла</h3>
        ${summary}
        <div class="flo-history">${list}</div>
        ${prevBlock}
      </section>`;
  }

  // Настройки общего доступа (переработка P0): категории вместо уровней.
  // Календарь — базовая часть: прогноз и даты месячных передаются самим
  // фактом включённого шеринга. Остальные категории — по явному выбору, и
  // состав подтверждается отдельно (share_confirmed): до подтверждения
  // партнёру передаётся только календарная оценка.
  const FLO_SHARE_CATEGORIES = [
    ["sex", "Секс", "Факты активности: «с защитой», «без защиты» и явная отметка «без секса», с числом отметок за день. Подробностей в записях нет."],
    ["mood", "Настроение", "Только настроение, которое вы отметили сами. Никаких прогнозов настроения."],
    ["sleep", "Качество сна", "Только «хорошо», «средне» или «плохо». Часы сна и другие подробности не передаются."],
    ["bbt", "Базальная температура", "Фактические измерения с датой, временем и единицами. Без интерпретации."]
  ];
  function renderFloShareControls() {
    const share = floState.share || { enabled: false, categories: {}, confirmed: false, notify: false };
    const cats = share.categories || {};
    const consentNeeded = share.enabled && !share.confirmed;
    return `
        <p class="flo-sub">Шеринг с партнёром: ${share.enabled ? "включён" : "выключен"}</p>
        <div class="flo-chips">
          <button type="button" class="flo-chip${share.enabled ? " is-on" : ""}" data-action="flo-share-toggle" data-enabled="${!share.enabled}">${share.enabled ? "Выключить шеринг" : "Включить шеринг"}</button>
        </div>
        <p class="settings-hint">Главный выключатель закрывает доступ сразу. Календарь (прогноз и даты месячных) — базовая часть общего доступа.</p>
        <p class="flo-sub">Категории данных для партнёра</p>
        ${FLO_SHARE_CATEGORIES.map(([key, title, hint]) => `
          <div class="flo-share-cat">
            <div class="flo-share-cat-head">
              <span>${esc(title)}</span>
              <button type="button" class="flo-chip${cats[key] ? " is-on" : ""}" data-action="flo-share-cat" data-cat="${key}" data-enabled="${!cats[key]}" aria-pressed="${!!cats[key]}">${cats[key] ? "Передаётся" : "Не передаётся"}</button>
            </div>
            <p class="settings-hint">${esc(hint)}</p>
          </div>`).join("")}
        ${consentNeeded ? `
        <div class="flo-consent">
          <p class="flo-line">Партнёру сейчас передаётся только календарная оценка — новый состав данных нужно подтвердить. После подтверждения партнёр увидит: календарь (прогноз, даты месячных)${FLO_SHARE_CATEGORIES.filter(([key]) => cats[key]).map(([, title]) => `, ${title.toLowerCase()}`).join("") || ""}.</p>
          <p class="settings-hint">Симптомы, заметки, препараты, боль, вес и стресс не передаются никогда.</p>
          <button type="button" class="primary full card-action" data-action="flo-share-confirm">Подтвердить состав данных</button>
        </div>` : ""}
        <div class="flo-chips"><button type="button" class="flo-chip${share.notify ? " is-on" : ""}" data-action="flo-share-notify" data-enabled="${!share.notify}">${share.notify ? "Уведомлять партнёра: да" : "Уведомлять партнёра: нет"}</button></div>
        <p class="flo-disclaimer">Партнёру не передаются симптомы, заметки, флоу и сгустки, боль, слизь, препараты, вес и стресс. Выключение категории прекращает передачу именно её сразу.</p>`;
  }

  function renderFloNotifyControl() {
    const n = floState.notify || { enabled: false, period: true, ovulation: true, fertile: true, delay: true, period_days: 2, delay_days: 3, diary: false };
    const kinds = [["period", "месячные"], ["ovulation", "овуляция"], ["fertile", "фертильное окно"], ["delay", "задержка"], ["diary", "дневник"]];
    const dayChips = (field, options, current, suffix) => options.map(v =>
      `<button type="button" class="flo-chip${current === v ? " is-on" : ""}" data-action="flo-notify-days" data-field="${field}" data-value="${v}">${v} ${suffix}</button>`).join("");
    const body = n.enabled ? `
        <div class="flo-chips">${kinds.map(([key, label]) =>
          `<button type="button" class="flo-chip${n[key] ? " is-on" : ""}" data-action="flo-notify-kind" data-kind="${key}" data-enabled="${!n[key]}">${label}</button>`).join("")}</div>
        <p class="flo-sub">Предупреждать о месячных за</p>
        <div class="flo-chips">${dayChips("period_days", [1, 2, 3], n.period_days, "дн.")}</div>
        <p class="flo-sub">Сообщать о задержке через</p>
        <div class="flo-chips">${dayChips("delay_days", [1, 2, 3, 5], n.delay_days, "дн.")}</div>` : "";
    return `
        <p class="flo-sub">Напоминания в боте: ${n.enabled ? "включены" : "выключены"}</p>
        <div class="flo-chips">
          <button type="button" class="flo-chip${n.enabled ? " is-on" : ""}" data-action="flo-notify-toggle" data-enabled="${!n.enabled}">${n.enabled ? "Выключить напоминания" : "Включить напоминания"}</button>
        </div>${body}`;
  }

  function renderFloDataControls() {
    if (floDeleteArmed) {
      return `
        <p class="eyebrow flo-group">Данные</p>
        <p class="flo-line">Удалить все данные Фло? Периоды, симптомы и заметки пропадут без возврата, шеринг выключится.</p>
        <button type="button" class="primary is-danger full card-action" data-action="flo-delete-confirm">Да, удалить</button>
        <button type="button" class="secondary full card-action" data-action="flo-delete-cancel">Не удалять</button>`;
    }
    return `
      <p class="eyebrow flo-group">Данные</p>
      <button type="button" class="secondary full card-action" data-action="flo-export">Выгрузить в чат</button>
      <button type="button" class="secondary is-danger full card-action" data-action="flo-delete-start">Удалить все данные</button>`;
  }

  function renderFloSettings() {
    const p = floState.profile || {};
    const context = floState.context || {};
    const contextOptions = [
      ["pregnancy", "Беременность"],
      ["postpartum", "Недавние роды"],
      ["breastfeeding", "Грудное вскармливание"],
      ["perimenopause", "Перименопауза"],
      ["hormonal_contraception", "Гормональная контрацепция"],
      ["cycle_affecting_meds", "Препараты, влияющие на цикл или температуру"],
      ["very_irregular", "Выраженно нерегулярные циклы"],
      ["unusual_bleeding", "Необычные или межменструальные кровотечения"]
    ];
    return `
      <section class="card">
        <p class="eyebrow">Настройки Фло</p>
        <h3>Шеринг и напоминания</h3>
        ${renderFloShareControls()}
        ${renderFloNotifyControl()}
        <label class="field flo-group"><span>Средняя длина цикла, дней</span>
          <input id="flo-avg-cycle" type="number" inputmode="numeric" min="20" max="45" value="${Number(p.avg_cycle_length) || 28}">
        </label>
        <label class="field"><span>Длительность месячных, дней</span>
          <input id="flo-avg-period" type="number" inputmode="numeric" min="2" max="10" value="${Number(p.avg_period_length) || 5}">
        </label>
        <button type="button" class="primary full card-action" data-action="flo-save-profile">Сохранить</button>
        ${Number(p.cycle_length_known) === 1
          ? `<p class="flo-disclaimer">Пока накоплено меньше двух циклов, прогноз считается по этим значениям.</p>`
          : `<p class="flo-disclaimer">Сейчас используется стандартная длина цикла 28 дней — это не ваша личная норма. Сохраните своё значение или отметьте два цикла, и прогноз уточнится.</p>`}
        <p class="eyebrow flo-group">Контекст цикла</p>
        <p class="settings-hint">Необязательные сведения: они ограничивают применимость календарных прогнозов, чтобы не показывать уверенные даты там, где расчёт неприменим. Это не медицинская анкета.</p>
        <div class="flo-chips">
          ${contextOptions.map(([key, title]) =>
            `<button type="button" class="flo-chip${context[key] ? " is-on" : ""}" data-action="flo-context-toggle" data-key="${key}" data-enabled="${!context[key]}" aria-pressed="${!!context[key]}">${esc(title)}</button>`).join("")}
        </div>
        ${renderFloDataControls()}
      </section>`;
  }

  function floIsOwner() {
    return appState?.user?.gender === "female";
  }

  // Вкладка «Фло» доступна обоим партнёрам (переработка 2): владелице —
  // её дневник, партнёру — read-only представление согласованных данных.
  // Если шеринг не включён, партнёр видит понятный пустой экран вместо
  // скрытой вкладки.
  function showFloTab() {
    return true;
  }

  async function loadFloPartner() {
    floPartnerBusy = true;
    try {
      floPartner = await request("/api/cycle/partner");
    } catch (error) {
      floPartner = { shared: false };
    } finally {
      floPartnerBusy = false;
    }
    render();
  }

  // Партнёрский вид Фло (мужская версия): только чтение. Данные приходят
  // строго из allowlist-ответа /api/cycle/partner — категории, которые
  // владелица включила и подтвердила. Редактирования нет: никаких кнопок
  // записи, только просмотр фактов и календарных оценок.
  function floPartnerDayLog(date) {
    return (floPartner?.days || []).find(l => l.date === date) || null;
  }
  function floPartnerBbt(date) {
    return (floPartner?.bbt || []).filter(m => m.date === date);
  }
  function floPartnerInPeriod(date) {
    const today = floPartner?.today || "";
    return (floPartner?.calendar_periods || []).some(p =>
      date >= p.start_date && date <= (p.end_date || (p.end_unknown ? p.start_date : today)));
  }
  function floPartnerDayClasses(date, inMonth = true) {
    const f = floPartner?.forecast || {};
    const fh = f.empty ? {} : f;
    const today = floPartner?.today || "";
    // Паритет с владелицей (§4.1): при недостатке данных уверенные
    // фертильное окно и овуляция не красятся.
    const ovulationTrusted = fh.quality !== undefined && fh.quality !== "insufficient";
    const classes = [];
    if (floPartnerInPeriod(date)) classes.push("is-period");
    else if (!fh.empty && date >= fh.next_period_start && date <= fh.next_period_end) classes.push("is-predicted");
    if (ovulationTrusted && !fh.empty && date >= fh.fertile_start && date <= fh.fertile_end) classes.push("is-fertile");
    if (ovulationTrusted && !fh.empty && date === fh.ovulation_date) classes.push("is-ovulation");
    if (!fh.empty && fh.phase === "delay" && date >= fh.next_period_start && date <= today) classes.push("is-delay");
    if (inMonth && date === today) classes.push("is-today");
    return classes;
  }
  function floPartnerDayDots(date) {
    const log = floPartnerDayLog(date);
    const sexCount = (log?.sex === "protected" || log?.sex === "unprotected") ? (log.sex_count || 1) : 0;
    const noSex = log?.sex === "none";
    const hasOther = log?.mood || log?.sleep || floPartnerBbt(date).length;
    return `${hasOther ? `<i class="cal-dot is-log"></i>` : ""}${sexCount ? floSexHearts(sexCount) : ""}${noSex ? `<i class="cal-dot is-no-sex" aria-hidden="true"></i>` : ""}`;
  }
  function renderFloPartnerCalendar() {
    const v = floPartner;
    if (!v?.shared) return "";
    if (!floMonth) floMonth = (v.today || new Date().toISOString().slice(0, 10)).slice(0, 7);
    const [year, month] = floMonth.split("-").map(Number);
    const cells = calendarGrid(year, month).map(cell => {
      const classes = ["cal-day", ...floPartnerDayClasses(cell.key, cell.inMonth)];
      if (!cell.inMonth) classes.push("is-outside");
      if (cell.key === floSelectedDate) classes.push("is-selected");
      const dots = floPartnerDayDots(cell.key);
      if (dots) classes.push("has-events");
      return `<button type="button" class="${classes.join(" ")}" data-action="flo-select-day" data-date="${cell.key}"
        aria-label="${esc(calendarLongDate(cell.key))}"${cell.key === floSelectedDate ? ' aria-pressed="true"' : ""}>
        <span class="cal-num">${cell.day}</span>
        ${dots ? `<span class="cal-dots" aria-hidden="true">${dots}</span>` : ""}
      </button>`;
    }).join("");
    return `
      <section class="card calendar-card">
        <div class="cal-head">
          <button type="button" class="cal-nav-btn" data-action="flo-month-prev" aria-label="Предыдущий месяц">${CHEVRON_LEFT}</button>
          <h3 class="cal-title">${esc(calendarMonthTitle(year, month))}</h3>
          <button type="button" class="cal-nav-btn" data-action="flo-month-next" aria-label="Следующий месяц">${CHEVRON_RIGHT}</button>
        </div>
        <div class="cal-weekdays" aria-hidden="true">${["Пн", "Вт", "Ср", "Чт", "Пт", "Сб", "Вс"].map(w => `<span>${w}</span>`).join("")}</div>
        <div class="cal-grid">${cells}</div>
        <div class="cal-legend">
          <span><i class="cal-dot is-period" aria-hidden="true"></i>Месячные</span>
          <span><i class="cal-dot is-predicted" aria-hidden="true"></i>Прогноз</span>
          <span><i class="cal-dot is-delay" aria-hidden="true"></i>Задержка</span>
          <span><i class="cal-dot is-fertile" aria-hidden="true"></i>Фертильно (расчёт)</span>
          <span><i class="cal-dot is-ovulation" aria-hidden="true"></i>Овуляция (расчёт)</span>
          <span><i class="cal-dot is-log" aria-hidden="true"></i>Отметки</span>
          <span><svg class="cal-heart" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 21.35l-1.45-1.32C5.4 15.36 2 12.28 2 8.5 2 5.42 4.42 3 7.5 3c1.74 0 3.41.81 4.5 2.09C13.09 3.81 14.76 3 16.5 3 19.58 3 22 5.42 22 8.5c0 3.78-3.4 6.86-8.55 11.54L12 21.35z"/></svg>Секс</span>
          <span><i class="cal-dot is-no-sex" aria-hidden="true"></i>Без секса</span>
        </div>
      </section>`;
  }
  function renderFloPartnerDayCard() {
    const v = floPartner;
    if (!v?.shared || !floSelectedDate) return "";
    const d = floSelectedDate;
    const log = floPartnerDayLog(d);
    const bbt = floPartnerBbt(d);
    const states = floPartnerDayClasses(d).filter(c => ["is-period", "is-predicted", "is-fertile", "is-ovulation", "is-delay"].includes(c));
    const stateNames = { "is-period": "Месячные", "is-predicted": "Прогноз месячных", "is-fertile": "Фертильное окно (расчёт)", "is-ovulation": "Овуляция (расчёт)", "is-delay": "Задержка" };
    const sexCount = (log?.sex === "protected" || log?.sex === "unprotected") ? (log.sex_count || 1) : 0;
    const lines = [];
    if (states.length) lines.push(`<p class="flo-line">${states.map(c => esc(stateNames[c])).join(" · ")}</p>`);
    if (sexCount) {
      lines.push(`<p class="flo-line">${FLO_HEART_ICON.repeat(Math.min(sexCount, 5))}${sexCount > 5 ? `<span class="cal-sex-more">+${sexCount - 5}</span>` : ""} ${esc(log.sex === "protected" ? "с защитой" : "без защиты")}${sexCount > 1 ? ` ×${sexCount}` : ""}</p>`);
    } else if (log?.sex === "none") {
      // Явно отмеченное «без секса» — факт, а не отсутствие записи (9.4).
      lines.push(`<p class="flo-line"><i class="cal-dot is-no-sex" aria-hidden="true"></i> Без секса — отмечено партнёршей</p>`);
    }
    if (log?.mood) {
      const mood = FLO_MOODS.find(([c]) => c === log.mood)?.[1] || log.mood;
      lines.push(`<p class="flo-line">Настроение: ${esc(mood)}</p>`);
    }
    if (log?.sleep) {
      // Качество сна передаётся строго тремя значениями (good/ok/poor) —
      // сервер нормализует allowlist'ом; часы и подробности не приходят.
      const sq = FLO_SLEEP_QUALITY.find(([c]) => c === log.sleep)?.[1] || log.sleep;
      lines.push(`<p class="flo-line">Сон: ${esc(sq)}</p>`);
    }
    if (bbt.length) {
      // Базальная температура: фактические измерения, единицы и время —
      // как записала владелица. Без интерпретации.
      lines.push(`<p class="flo-line">Базальная температура: ${bbt.map(m => `${esc(String(m.value))}°${m.unit === "F" ? "F" : "C"}${m.time ? ` · ${esc(m.time)}` : ""}`).join("; ")}</p>`);
    }
    if (!lines.length) lines.push(`<p class="cal-empty">Отметок нет.</p>`);
    return `
      <section class="card">
        <p class="eyebrow">Выбранный день</p>
        <h3>${esc(formatDay(d))}</h3>
        ${lines.join("")}
      </section>`;
  }

  function renderFloPartnerView() {
    const v = floPartner;
    if (!v || v.shared !== true) {
      return `<section class="card"><p class="eyebrow">Фло</p><h3>Пока не делится</h3><p>Партнёрша пока не делится календарём. Когда она включит общий доступ, здесь появится её календарь</p></section>`;
    }
    const f = v.forecast || {};
    const lines = [];
    if (f.empty) {
      lines.push("Пока мало данных для прогноза.");
    } else {
      lines.push(`<b>День ${f.cycle_day} цикла</b> · ${esc(FLO_PHASE_LABELS[f.phase] || "")}`);
      if (f.phase === "stale") lines.push("Данные давно не обновлялись — прогноз может не отражать текущий цикл.");
      else if (f.phase === "delay") lines.push(`Задержка ${f.delay_days} дн.`);
      else if (f.next_period_in === 0) lines.push("Месячные по прогнозу ожидаются сегодня");
      else if (!f.data_stale && f.next_period_early && f.next_period_late) lines.push(`Месячные ориентировочно ${esc(floDayMonth(f.next_period_early))} — ${esc(floDayMonth(f.next_period_late))}`);
      else if (!f.data_stale) lines.push(`Месячные примерно через ${f.next_period_in} дн.`);
      // Методика и качество — сразу в карточке (переработка 11).
      if (f.based_on === "history" && f.usable_cycles) lines.push(`Расчёт по ${f.usable_cycles} завершённым циклам${v.last_period_start ? `, последнее начало отмечено ${esc(floDayMonth(v.last_period_start))}` : ""}.`);
      else if (f.based_on === "profile") lines.push("Расчёт по длине цикла, указанной партнёршей.");
      else lines.push("Расчёт по стандартной длине цикла — личной истории пока мало.");
      if (f.quality === "insufficient") lines.push("Данных недостаточно: даты очень примерные");
      if (f.ovulation_in > 0 && f.phase !== "delay" && f.phase !== "stale") {
        // §4.1: при недостатке данных уверенной даты овуляции партнёру нет.
        if (f.quality === "insufficient") {
          lines.push("Данных для оценки овуляции пока недостаточно.");
        } else if (f.ovulation_source === "lh" || f.ovulation_source === "bbt") {
          lines.push(`Овуляция — оценка по ${f.ovulation_source === "lh" ? "тесту ЛГ" : "температурному сдвигу"}, примерно через ${f.ovulation_in} дн. Косвенный признак, не подтверждение.`);
        } else {
          lines.push(`Овуляция — календарная оценка, примерно через ${f.ovulation_in} дн. Не подтверждена наблюдениями.`);
        }
      }
      if (f.irregular) lines.push("Цикл нерегулярный, прогнозы приблизительные.");
    }
    if (v.tip) lines.push(esc(v.tip));
    let extra = "";
    if (v.periods?.length) {
      extra += `<p class="flo-sub">Месячные</p><ul class="flo-hist">${v.periods.map(p => `<li>${esc(p.start_date)} · ${esc(p.end_date || (p.end_unknown ? "конец неизвестен" : "идут"))}</li>`).join("")}</ul>`;
    }
    if (!v.confirmed) {
      extra += `<p class="flo-disclaimer">Партнёрша делится календарной оценкой. Подробные отметки появятся, когда она подтвердит состав данных в своих настройках.</p>`;
    }
    return `
      <section class="card flo-today">
        <p class="eyebrow">Фло</p>
        ${lines.map(l => `<p class="flo-line">${l}</p>`).join("")}
        ${extra}
        <p class="flo-disclaimer">${esc(v.forecast_disclaimer || "Прогнозы приблизительны и не являются методом контрацепции")}</p>
        <p class="flo-disclaimer">${esc(v.disclaimer || "")}</p>
      </section>
      ${renderFloPartnerCalendar()}
      ${renderFloPartnerDayCard()}`;
  }

  function floBannerHtml() {
    return `<section class="card"><p class="eyebrow">Фло</p><p>Настройка Фло ещё не пройдена.</p>
      <button type="button" class="primary full card-action" data-action="flo-wiz-open">Пройти настройку</button></section>`;
  }

  function renderFloWizard() {
    const w = floWizard || { step: 0 };
    const today = floState.today;
    const shell = (title, body, nav) => `
      <section class="card">
        <p class="eyebrow">Фло · ${esc(title)}</p>
        ${body}
        ${nav}
      </section>`;
    if (w.step === 0) {
      return shell("знакомство", `
        <p class="flo-line">Фло поможет следить за циклом и предсказывать месячные, овуляцию и задержки.</p>
        <p class="flo-line">Партнёр ничего не увидит, пока вы сами не включите шеринг. Базовая часть — календарь: прогноз и даты месячных. Дополнительно можно открыть секс, настроение, качество сна (только «хорошо/средне/плохо») и базальную температуру — состав подтверждается явно.</p>
        <p class="flo-line">Симптомы, заметки и препараты партнёру не передаются.</p>
        <p class="flo-disclaimer">Это не замена консультации врача.</p>`,
        `<button type="button" class="secondary full card-action" data-action="flo-wiz-postpone">Позже</button>
         <button type="button" class="primary full card-action" data-action="flo-wiz-begin">Начать</button>`);
    }
    if (w.step === 1) {
      return shell("шаг 1 из 5", `
        <label class="field"><span>Когда начались последние месячные</span>
          <input type="date" id="flo-wiz-date" max="${today}" value="${esc(w.lastStart || today)}">
        </label>`,
        `<button type="button" class="secondary full card-action" data-action="flo-wiz-back">Назад</button>
         <button type="button" class="primary full card-action" data-action="flo-wiz-next">Дальше</button>`);
    }
    if (w.step === 2) {
      const current = w.periodLen || 5;
      const chips = [2, 3, 4, 5, 6, 7, 8].map(n => `<button type="button" class="flo-chip${current === n ? " is-on" : ""}" data-action="flo-wiz-set" data-field="periodLen" data-value="${n}">${n}</button>`).join("");
      return shell("шаг 2 из 5", `
        <p class="flo-line">Сколько обычно длятся месячные, дней?</p>
        <div class="flo-chips">${chips}</div>`,
        `<button type="button" class="secondary full card-action" data-action="flo-wiz-back">Назад</button>`);
    }
    if (w.step === 3) {
      return shell("шаг 3 из 5", `
        <label class="field"><span>Средняя длина цикла, дней (от первого дня до первого дня следующих месячных)</span>
          <input type="number" inputmode="numeric" id="flo-wiz-cycle" min="20" max="45" placeholder="28" value="${w.cycle || ""}">
        </label>`,
        `<button type="button" class="secondary full card-action" data-action="flo-wiz-back">Назад</button>
         <button type="button" class="secondary full card-action" data-action="flo-wiz-unknown">Не знаю</button>
         <button type="button" class="primary full card-action" data-action="flo-wiz-next">Дальше</button>`);
    }
    if (w.step === 4) {
      return shell("шаг 4 из 5", `
        <p class="flo-line">Прошлые месячные (необязательно)</p>
        <p class="flo-sub">Реальные даты делают прогноз точнее: два интервала между стартами — уже история, а не среднее «на глаз». Можно добавить позже в истории.</p>
        ${floPrevEditorHtml("wiz", w.previous || [])}`,
        `<button type="button" class="secondary full card-action" data-action="flo-wiz-back">Назад</button>
         <button type="button" class="primary full card-action" data-action="flo-wiz-next">Дальше</button>`);
    }
    return shell("шаг 5 из 5", `
      <p class="flo-line">Хотите делиться с партнёром? По умолчанию нет, и это можно поменять в настройках.</p>
      <p class="flo-sub">Базовая часть — календарь: прогноз и даты месячных. Отметьте дополнительные категории, если хотите передавать их.</p>
      ${FLO_SHARE_CATEGORIES.map(([key, title]) =>
        `<button type="button" class="flo-chip${(w.shareCategories || {})[key] ? " is-on" : ""}" data-action="flo-wiz-share-cat" data-cat="${key}">${esc(title)}</button>`).join("")}
      <p class="settings-hint">Симптомы, заметки и препараты не передаются никогда. Состав можно изменить позже в настройках Фло.</p>`,
      `<button type="button" class="primary full card-action" data-action="flo-wiz-set" data-field="share" data-value="none">Пока не делиться</button>
       <button type="button" class="secondary full card-action" data-action="flo-wiz-set" data-field="share" data-value="share">Делиться с партнёром</button>
       <button type="button" class="secondary full card-action" data-action="flo-wiz-back">Назад</button>`);
  }

  async function floWizardFinish(share) {
    const w = floWizard || {};
    const body = {
      last_start: w.lastStart || floState.today,
      period_length: w.periodLen || 5,
      cycle_length: w.cycle ?? null,
      previous_periods: (w.previous || []).length ? w.previous : undefined,
      share_enabled: share === "share",
      share_level: share === "share" ? "phases" : "phases",
      // Категории передаются всегда: при выключенном шеринге сервер сохранит
      // их как намерение (confirmed=0, передача не начнётся).
      share_categories: { ...(w.shareCategories || {}) }
    };
    try {
      floState = await request("/api/cycle/onboard", { method: "POST", body });
      floStats = undefined;
      floWizard = null;
      floWizardDismissed = false;
      const imported = floState.previous_imported ?? 0;
      const skipped = floState.previous_skipped ?? 0;
      showToast(imported
        ? `Настройка сохранена. Прошлых периодов добавлено: ${imported}${skipped ? `, пропущено: ${skipped}` : ""} — прогноз обновлён`
        : "Настройка сохранена — прогноз обновлён");
    } catch (error) {
      handleRequestError(error);
    }
    return render();
  }

  async function loadFloStats() {
    floStatsBusy = true;
    try {
      floStats = await request(`/api/cycle/stats?months=${floStatsMonths}`);
    } catch (error) {
      floStats = { failed: true };
    } finally {
      floStatsBusy = false;
    }
    render();
  }

  // --- P2: препараты (справочник) ---
  async function floSaveMed(body) {
    try {
      floState = await request("/api/cycle/med", { method: "POST", body });
      floMedForm = null;
      floMedDeleteArmed = null;
      showToast("Препарат сохранён");
    } catch (error) {
      handleRequestError(error);
    }
    render();
  }

  function renderFloMedForm() {
    const f = floMedForm;
    if (!f) return "";
    const del = floMedDeleteArmed === f.id
      ? `<button type="button" class="primary is-danger full card-action" data-action="flo-med-delete" data-id="${f.id}">Точно удалить</button>`
      : f.id ? `<button type="button" class="secondary is-danger full card-action" data-action="flo-med-delete-arm" data-id="${f.id}">Удалить</button>` : "";
    return `
      <div class="flo-med-form">
        <label class="field"><span>Название</span>
          <input id="flo-med-name" type="text" maxlength="120" value="${esc(f.name || "")}" placeholder="Например, КОК">
        </label>
        <div class="flo-actions" style="margin-top:6px">
          <label class="field" style="flex:1"><span>Категория</span>
            <select id="flo-med-category"><option value="">—</option>${FLO_MED_CATEGORIES.map(([c, l]) => `<option value="${c}"${f.category === c ? " selected" : ""}>${esc(l)}</option>`).join("")}</select>
          </label>
        </div>
        <label class="field"><span>Назначенная доза (справочно)</span>
          <input id="flo-med-dosage" type="text" maxlength="120" value="${esc(f.dosage || "")}" placeholder="Например, 1 таблетка">
        </label>
        <div class="flo-actions" style="margin-top:6px">
          <label class="field" style="flex:1"><span>Форма</span>
            <select id="flo-med-form"><option value="">—</option>${FLO_MED_FORMS.map(([c, l]) => `<option value="${c}"${f.form === c ? " selected" : ""}>${esc(l)}</option>`).join("")}</select>
          </label>
          <label class="field" style="flex:1"><span>Статус</span>
            <select id="flo-med-status">${FLO_MED_STATUS.map(([c, l]) => `<option value="${c}"${(f.status || "active") === c ? " selected" : ""}>${esc(l)}</option>`).join("")}</select>
          </label>
        </div>
        <label class="field"><span>Схема приёма</span>
          <input id="flo-med-schedule" type="text" maxlength="200" value="${esc(f.schedule || "")}" placeholder="Например, 1 раз в день утром">
        </label>
        <div class="flo-actions" style="margin-top:6px">
          <label class="field" style="flex:1"><span>Начало курса</span>
            <input id="flo-med-start" type="date" max="${esc(floState.today)}" value="${esc(f.start_date || floState.today)}">
          </label>
          <label class="field" style="flex:1"><span>Конец курса</span>
            <input id="flo-med-end" type="date" max="${esc(floState.today)}" value="${esc(f.end_date || "")}">
          </label>
        </div>
        <label class="field"><span>Комментарий</span>
          <input id="flo-med-note" type="text" maxlength="1000" value="${esc(f.note || "")}">
        </label>
        <button type="button" class="primary full card-action" data-action="flo-med-save-read">Сохранить</button>
        <button type="button" class="secondary full card-action" data-action="flo-med-cancel">Отмена</button>
        ${del}
        <p class="flo-disclaimer">Приложение не назначает и не отменяет приём препаратов — здесь только ваш журнал</p>
      </div>`;
  }

  function renderFloMeds() {
    const meds = floMeds();
    const list = meds.map(m => {
      const taken = (floState.med_logs || []).filter(l => l.med_id === m.id && l.status === "taken").length;
      const skipped = (floState.med_logs || []).filter(l => l.med_id === m.id && l.status === "skipped").length;
      const statusLabel = FLO_MED_STATUS.find(([c]) => c === m.status)?.[1] || m.status;
      const meta = [m.dosage, m.schedule, m.start_date + (m.end_date ? ` — ${m.end_date}` : "")].filter(Boolean).join(" · ");
      return `<div class="item-row">
        <div class="item-main">
          <p class="item-title">${esc(m.name)}</p>
          <div class="item-meta"><span class="day-chip is-muted">${esc(statusLabel)}</span><span>${esc(meta)}</span></div>
          <div class="item-meta"><span>принято ${taken} · пропущено ${skipped}</span></div>
        </div>
        <button class="icon-btn" type="button" data-action="flo-med-edit" data-id="${m.id}" aria-label="Изменить">${EDIT_ICON}</button>
      </div>`;
    }).join("");
    return `
      <section class="card">
        <p class="eyebrow flo-group">Мои препараты</p>
        <h3>Лекарства и курсы</h3>
        <p class="settings-hint">Это ваш личный журнал: препараты не видны партнёру и не используются для рекомендаций. Фактический приём отмечается в дневнике выбранного дня</p>
        ${list || `<p class="flo-disclaimer">Пока нет препаратов</p>`}
        ${floMedForm ? renderFloMedForm() : `<button type="button" class="secondary full card-action" style="margin-top:8px" data-action="flo-med-new">Добавить препарат</button>`}
      </section>`;
  }

  // --- P2: медицинский отчёт (печать / CSV / JSON) ---
  async function loadFloReport() {
    const months = floReport?.months || 6;
    const today = floState?.today || new Date().toISOString().slice(0, 10);
    const [ty, tm, td] = today.split("-").map(Number);
    const fromDate = new Date(Date.UTC(ty, tm - 1 - months, td));
    const from = fromDate.toISOString().slice(0, 10);
    floReport = { months, loading: true, data: floReport?.data || null, failed: false };
    render();
    syncFloReportDialog();
    try {
      const data = await request(`/api/cycle/history?from=${from}&to=${today}`);
      floReport = { months, loading: false, failed: false, data };
    } catch (error) {
      floReport = { months, loading: false, failed: true, data: null };
    }
    render();
    syncFloReportDialog();
  }

  // Отчёт живёт в общем диалоге (#item-dialog): пока он открыт, догрузка
  // данных и смена периода обновляют его содержимое, а не страницу.
  function syncFloReportDialog() {
    if (dialog?.open && dialogContext?.floReport) {
      dialogFields.innerHTML = renderFloReportDialog();
    }
  }

  function openFloReportDialog() {
    openDialog({
      title: "Медицинский отчёт",
      submitLabel: null,
      cancelLabel: "Закрыть",
      readOnly: true,
      floReport: true,
      fields: renderFloReportDialog()
    });
    if (!floReport?.data && !floReport?.loading) loadFloReport();
  }

  function floReportDownload(data, kind) {
    let text, name, type;
    if (kind === "csv") {
      text = floReportCsv(data);
      name = `flo-report-${data.to}.csv`;
      type = "text/csv;charset=utf-8";
    } else {
      text = JSON.stringify({ format: "duoplan-cycle-report", generated_at: new Date().toISOString(), from: data.from, to: data.to, ...data }, null, 2);
      name = `flo-report-${data.to}.json`;
      type = "application/json";
    }
    // BOM нужен Excel для кириллицы в CSV.
    const blob = new Blob(["\uFEFF" + text], { type });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = name;
    a.click();
    URL.revokeObjectURL(url);
  }

  function floCsvCell(v) {
    const s = v === null || v === undefined ? "" : String(v);
    return /[";\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  }
  function floReportCsv(data) {
    const header = ["date", "type", "flow", "clots", "energy", "mood", "symptoms", "symptoms_clear", "leakage", "pain_score", "pain_locations", "life_impact", "mucus", "sleep_hours", "sleep_quality", "stress", "sick", "travel", "weight_kg", "sex", "note", "med_name", "med_status", "dose_taken", "med_time", "med_note", "measurement_kind", "measurement_value", "measurement_unit", "measurement_result", "measurement_time", "measurement_note", "period_end", "period_end_unknown"];
    const lines = [header.join(";")];
    const push = row => {
      while (row.length < header.length) row.push("");
      lines.push(row.map(floCsvCell).join(";"));
    };
    const medName = id => (data.meds || []).find(m => m.id === id)?.name || "";
    // Периоды — тоже данные: start в date, конец и флаг «неизвестен» в
    // хвостовых колонках. Открытый период: period_end пуст, флаг 0.
    for (const p of data.periods || []) {
      push([p.start_date, "period", "", "", "", "", "", "", "", "", "", "", "", "", "", "", "", "", "", "", "", "", "", "", "", "", "", "", "", "",
        p.end_date || "", p.end_unknown ? 1 : 0]);
    }
    for (const l of data.logs || []) {
      const mucus = l.mucus ? [l.mucus.amount, l.mucus.consistency, l.mucus.color, l.mucus.discomfort ? "discomfort" : "", l.mucus.note].filter(Boolean).join(", ") : "";
      push([l.date, "log", l.flow, l.clots ? 1 : 0, l.energy, l.mood,
        (l.symptoms || []).join(","), l.symptoms_clear ? 1 : 0, l.leakage, l.pain_score ?? "",
        (l.pain_locations || []).join(","), l.life_impact, mucus,
        l.sleep_hours ?? "", l.sleep_quality, l.stress, l.sick ? 1 : 0, l.travel ? 1 : 0,
        l.weight_kg ?? "", l.sex ? `${l.sex}${(l.sex_count || 0) > 1 ? ` ×${l.sex_count}` : ""}` : "", l.note]);
    }
    for (const ml of data.med_logs || []) {
      push([ml.date, "med_log", "", "", "", "", "", "", "", "", "", "", "", "", "", "", "", "", "", "",
        medName(ml.med_id), ml.status, ml.dose_taken || "", ml.time || "", ml.note || ""]);
    }
    for (const m of data.meds || []) {
      push([m.start_date, "med_course", "", "", "", "", "", "", "", "", "", "", "", "", "", "", "", "", "", "",
        m.name, m.status, "", "", [m.category, m.dosage, m.form, m.schedule, m.end_date, m.note].filter(Boolean).join(" | ")]);
    }
    for (const m of data.measurements || []) {
      push([m.date, "measurement", "", "", "", "", "", "", "", "", "", "", "", "", "", "", "", "", "", m.note || "",
        "", "", "", "", "", m.kind, m.value ?? "", m.unit || "", m.result || "", m.time || ""]);
    }
    return lines.join("\n");
  }

  // «Сегодня минус N месяцев» с клампом дня: 31 марта −1 мес = 28/29 февраля,
  // а не 3 марта (Date.UTC переполняет короткий месяц).
  function floMonthsAgo(today, months) {
    const [y, m, d] = today.split("-").map(Number);
    const total = y * 12 + (m - 1) - months;
    const ty = Math.floor(total / 12);
    const tm = total % 12 + 1;
    const dim = new Date(Date.UTC(ty, tm, 0)).getUTCDate();
    const dd = Math.min(d, dim);
    return `${ty}-${String(tm).padStart(2, "0")}-${String(dd).padStart(2, "0")}`;
  }

  const FLO_REPORT_MONTHS = [3, 6, 12];
  function floReportRange() {
    const months = floReport?.months || 6;
    const to = floState?.today || new Date().toISOString().slice(0, 10);
    return { from: floMonthsAgo(to, months), to, months };
  }

  // Содержимое диалога отчёта: переключатель периода, статус загрузки
  // и печатаемое тело. id="flo-report" нужен печатным стилям.
  function renderFloReportDialog() {
    const r = floReport;
    const monthsChips = FLO_REPORT_MONTHS.map(m =>
      `<button type="button" class="flo-chip${(r?.months || 6) === m ? " is-on" : ""}" data-action="flo-report-months" data-months="${m}">${m} мес.</button>`).join("");
    return `
      <div id="flo-report">
        <div class="flo-chips no-print">${monthsChips}</div>
        ${!r || r.loading ? `<p class="flo-disclaimer">Загружаем данные…</p>` : ""}
        ${r?.failed ? `<p class="flo-disclaimer">Не удалось загрузить данные.</p>
          <button type="button" class="secondary full card-action no-print" data-action="flo-report-retry">Повторить</button>` : ""}
        ${r?.data ? floReportBody(r.data) : ""}
      </div>`;
  }

  // Тело отчёта — печатаемая разметка. Пустые значения — «—», отсутствие
  // записи не приравнивается к нулю или «симптомов нет».
  function floReportBody(data) {
    const { from, to } = floReportRange();
    const dash = "—";
    const fmtDate = d => formatDay(d);
    const medName = id => (data.meds || []).find(m => m.id === id)?.name || `#${id}`;
    // Дни с любой записью: дневник, приём препарата, измерение.
    const days = new Map();
    const ensure = date => {
      if (!days.has(date)) days.set(date, { date, log: null, meds: [], meas: [] });
      return days.get(date);
    };
    for (const l of data.logs || []) { const d = ensure(l.date); d.log = l; }
    for (const ml of data.med_logs || []) { ensure(ml.date).meds.push(ml); }
    for (const m of data.measurements || []) { ensure(m.date).meas.push(m); }
    const sorted = [...days.values()].sort((a, b) => a.date < b.date ? -1 : 1);
    const flowLabel = c => FLO_FLOWS.find(([x]) => x === c)?.[1] || c || "";
    const moodLabel = c => FLO_MOODS.find(([x]) => x === c)?.[1] || c || "";
    const mucusLabel = m => m ? [FLO_MUCUS_AMOUNTS.find(([x]) => x === m.amount)?.[1], FLO_MUCUS_CONSISTENCY.find(([x]) => x === m.consistency)?.[1], FLO_MUCUS_COLORS.find(([x]) => x === m.color)?.[1]].filter(Boolean).join(", ") || "отмечено" : "";
    const dayRows = sorted.map(d => {
      const l = d.log;
      const symptoms = l ? (l.symptoms_clear ? "симптомов не было" : (l.symptoms || []).map(c => FLO_SYMPTOMS.find(([x]) => x === c)?.[1] || c).join(", ")) : dash;
      const medsTxt = d.meds.map(ml => `${medName(ml.med_id)}: ${ml.status === "taken" ? "принят" : "пропущен"}${ml.dose_taken ? ` (${ml.dose_taken})` : ""}${ml.time ? ` ${ml.time}` : ""}`).join("; ") || dash;
      const measTxt = d.meas.map(m => m.kind === "bbt" ? `БТ ${m.value}°${m.unit === "F" ? "F" : "C"}` : `ЛГ: ${FLO_LH_RESULTS.find(([x]) => x === m.result)?.[1] || m.result}`).join("; ") || dash;
      const pain = l?.pain_score !== null && l?.pain_score !== undefined ? `${l.pain_score}/10` : dash;
      const sleep = l?.sleep_hours !== null && l?.sleep_hours !== undefined ? `${l.sleep_hours} ч` : dash;
      const factors = l ? [l.stress ? `стресс: ${FLO_STRESS.find(([x]) => x === l.stress)?.[1] || l.stress}` : "", l.sick ? "болезнь" : "", l.travel ? "поездка" : "", l.weight_kg ? `${l.weight_kg} кг` : ""].filter(Boolean).join(", ") || dash : dash;
      return `<tr>
        <td>${esc(fmtDate(d.date))}</td>
        <td>${esc(flowLabel(l?.flow)) || dash}</td>
        <td>${pain}</td>
        <td>${esc(moodLabel(l?.mood)) || dash}</td>
        <td>${esc(symptoms)}</td>
        <td>${esc(mucusLabel(l?.mucus)) || dash}</td>
        <td>${esc(sleep)}<br><small>${esc(factors)}</small></td>
        <td>${esc(medsTxt)}</td>
        <td>${esc(measTxt)}</td>
        <td>${esc(l?.note || "") || dash}</td>
      </tr>`;
    }).join("");
    // Циклы: интервалы между стартами месячных в диапазоне.
    const periodRows = (data.periods || []).map(p => {
      // «Конец не помним» не превращаем ни в «идут», ни в придуманную дату.
      const endLabel = p.end_date ? fmtDate(p.end_date) : (p.end_unknown ? "неизвестно" : "идут");
      const len = p.end_date ? Math.round((Date.parse(p.end_date) - Date.parse(p.start_date)) / 86400000) + 1 : null;
      return `<tr><td>${esc(fmtDate(p.start_date))}</td><td>${esc(endLabel)}</td><td>${len === null ? dash : `${len} дн.`}</td></tr>`;
    }).join("");
    const medRows = (data.meds || []).map(m => {
      const taken = (data.med_logs || []).filter(l => l.med_id === m.id && l.status === "taken").length;
      const skipped = (data.med_logs || []).filter(l => l.med_id === m.id && l.status === "skipped").length;
      return `<tr><td>${esc(m.name)}</td><td>${esc([m.category, m.dosage, m.form, m.schedule].filter(Boolean).join(" · ") || dash)}</td><td>${esc(m.start_date)} — ${esc(m.end_date || "…")}</td><td>${esc(m.status)}</td><td>принято ${taken}, пропущено ${skipped}</td></tr>`;
    }).join("");
    const measRows = (data.measurements || []).map(m =>
      `<tr><td>${esc(fmtDate(m.date))}</td><td>${m.kind === "bbt" ? "Базальная температура" : "Тест на ЛГ"}</td><td>${m.kind === "bbt" ? `${m.value}°${m.unit === "F" ? "F" : "C"}` : (FLO_LH_RESULTS.find(([x]) => x === m.result)?.[1] || m.result || dash)}</td><td>${esc(m.time || "") || dash}</td><td>${esc(m.note || "") || dash}</td></tr>`).join("");
    const generated = new Date().toLocaleString("ru-RU", { dateStyle: "long", timeStyle: "short" });
    return `
      <button type="button" class="primary full card-action no-print" data-action="flo-report-print">Печать / PDF</button>
      <button type="button" class="secondary full card-action no-print" data-action="flo-report-csv">Скачать CSV</button>
      <button type="button" class="secondary full card-action no-print" data-action="flo-report-json">Скачать JSON</button>
      <div class="flo-report-doc">
        <h2>Медицинский отчёт — Фло</h2>
        <p>Период: ${esc(fmtDate(from))} — ${esc(fmtDate(to))} · Сформирован: ${esc(generated)}</p>
        <p class="flo-disclaimer">Отчёт содержит только фактически записанные наблюдения; пропуски не приравниваются к отсутствию симптомов. Прогнозы и фазы в отчёт не входят. Приложение не ставит диагнозы — этот документ не заменяет консультацию врача.</p>
        <h3>Месячные в периоде</h3>
        ${periodRows ? `<div class="flo-report-table-wrap"><table class="flo-report-table"><thead><tr><th>Начало</th><th>Конец</th><th>Длительность</th></tr></thead><tbody>${periodRows}</tbody></table></div>` : `<p>Записей о месячных в периоде нет.</p>`}
        <h3>Дневник (${sorted.length} дн. с записями)</h3>
        ${dayRows ? `<div class="flo-report-table-wrap"><table class="flo-report-table flo-report-table--wide"><thead><tr><th>Дата</th><th>Кровотечение</th><th>Боль</th><th>Настроение</th><th>Симптомы</th><th>Слизь</th><th>Сон / факторы</th><th>Препараты</th><th>Измерения</th><th>Заметка</th></tr></thead><tbody>${dayRows}</tbody></table></div>` : `<p>Записей дневника в периоде нет.</p>`}
        <h3>Препараты</h3>
        ${medRows ? `<div class="flo-report-table-wrap"><table class="flo-report-table"><thead><tr><th>Название</th><th>Схема</th><th>Период</th><th>Статус</th><th>Приём</th></tr></thead><tbody>${medRows}</tbody></table></div>` : `<p>Препараты не записаны.</p>`}
        <h3>Измерения</h3>
        ${measRows ? `<div class="flo-report-table-wrap"><table class="flo-report-table"><thead><tr><th>Дата</th><th>Тип</th><th>Значение</th><th>Время</th><th>Заметка</th></tr></thead><tbody>${measRows}</tbody></table></div>` : `<p>Измерений нет.</p>`}
      </div>`;
  }

  // P2/графики: временные ряды по дням — боль, кровотечение, БТ и ЛГ.
  // Только фактические отметки; пропуски — отсутствие точек и разрыв линии,
  // не ноль (переработка 13). Ось подписана датами периода; БТ в один день
  // агрегируется средним для линии, отдельные замеры видны точками.
  function floStatsDayCharts(s) {
    const daily = s.daily || [];
    const meas = s.measurements || [];
    if (!daily.length && !meas.length) return "";
    const W = 320, H = 96, pad = 16;
    const dates = [...new Set([...daily.map(d => d.date), ...meas.map(m => m.date)])].sort();
    const idx = new Map(dates.map((d, i) => [d, i]));
    const X = i => dates.length === 1 ? W / 2 : pad + i * (W - 2 * pad) / (dates.length - 1);
    // Подписи оси: первая и последняя даты + месяц на серединах.
    const axisLabels = [];
    if (dates.length) {
      axisLabels.push(`<text x="${X(0).toFixed(1)}" y="${H - 2}" class="flo-axis" text-anchor="start">${esc(dates[0].slice(5))}</text>`);
      if (dates.length > 4) {
        const mid = Math.floor((dates.length - 1) / 2);
        axisLabels.push(`<text x="${X(mid).toFixed(1)}" y="${H - 2}" class="flo-axis" text-anchor="middle">${esc(dates[mid].slice(5))}</text>`);
      }
      if (dates.length > 1) {
        axisLabels.push(`<text x="${X(dates.length - 1).toFixed(1)}" y="${H - 2}" class="flo-axis" text-anchor="end">${esc(dates[dates.length - 1].slice(5))}</text>`);
      }
    }
    const axisSvg = axisLabels.join("");
    const flowLvl = { spotting: 1, light: 2, medium: 3, heavy: 4 };
    const painPts = daily.filter(d => d.pain_score !== null && d.pain_score !== undefined)
      .map(d => ({ x: X(idx.get(d.date)), y: H - pad - 6 - (d.pain_score / 10) * (H - 2 * pad), label: `${d.date}: боль ${d.pain_score}/10` }));
    const painSvg = painPts.length
      ? `<svg viewBox="0 0 ${W} ${H}" class="flo-chart" role="img" aria-label="Боль по дням">${painPts.map(p => `<circle cx="${p.x.toFixed(1)}" cy="${p.y.toFixed(1)}" r="3.5" class="flo-dot"><title>${esc(p.label)}</title></circle>`).join("")}${axisSvg}</svg>
        <p class="flo-legend">Боль 0–10: каждая точка — день с отметкой (${painPts.length}). Пропуски не считаются нулём</p>`
      : `<p class="flo-disclaimer">Боль не отмечали за период.</p>`;
    const flowBars = daily.filter(d => d.flow)
      .map(d => {
        const lvl = flowLvl[d.flow] || 0;
        const bw = Math.max(3, (W - 2 * pad) / dates.length - 2);
        const h = (lvl / 4) * (H - 2 * pad - 6);
        return `<rect x="${(X(idx.get(d.date)) - bw / 2).toFixed(1)}" y="${(H - pad - 4 - h).toFixed(1)}" width="${bw.toFixed(1)}" height="${h.toFixed(1)}" rx="2" class="flo-bar"><title>${esc(d.date)}: ${esc(FLO_FLOWS.find(([c]) => c === d.flow)?.[1] || d.flow)}</title></rect>`;
      }).join("");
    const flowSvg = flowBars
      ? `<svg viewBox="0 0 ${W} ${H}" class="flo-chart" role="img" aria-label="Кровотечение по дням">${flowBars}${axisSvg}</svg>
        <p class="flo-legend">Высота столбца — интенсивность: ${esc(FLO_FLOWS.map(([, l]) => l).join(" / "))}</p>`
      : `<p class="flo-disclaimer">Кровотечение не отмечали за период.</p>`;
    // БТ (°F → °C) + маркеры ЛГ в верхней полосе. Несколько замеров в день
    // агрегируются средним для линии — документированное правило; отдельные
    // замеры остаются видимыми точками. Линия соединяет только соседние дни:
    // пропуски разрывают её, а не соединяются «непрерывным наблюдением».
    const byDay = new Map();
    for (const m of meas) {
      if (m.kind !== "bbt" || m.value === null || m.value === undefined) continue;
      const v = m.unit === "F" ? (m.value - 32) * 5 / 9 : m.value;
      const arr = byDay.get(m.date) || [];
      arr.push({ v, m });
      byDay.set(m.date, arr);
    }
    const bbtDays = [...byDay.keys()].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
      .map(d => {
        const arr = byDay.get(d);
        const mean = arr.reduce((sum, x) => sum + x.v, 0) / arr.length;
        return { d, mean, first: arr[0], all: arr, x: X(idx.get(d)) };
      });
    const lhPts = meas.filter(m => m.kind === "lh" && m.result)
      .map(m => ({ x: X(idx.get(m.date)), result: m.result, m }));
    let measSvg = `<p class="flo-disclaimer">Измерений (БТ, ЛГ) за период нет</p>`;
    if (bbtDays.length || lhPts.length) {
      const vals = bbtDays.map(p => p.mean);
      const lo = Math.min(...(vals.length ? vals : [36.2]), 36.2);
      const hi = Math.max(...(vals.length ? vals : [37.6]), 37.6);
      const Y = v => H - pad - 6 - ((v - lo) / (hi - lo || 1)) * (H - 2 * pad);
      // Линия по агрегированным дням: сегмент рисуется только между
      // соседними датами — разрыв (день без измерений) не соединяется.
      const segments = [];
      for (let i = 0; i < bbtDays.length; i++) {
        const run = [bbtDays[i]];
        while (i + 1 < bbtDays.length && floDayDiff(bbtDays[i].d, bbtDays[i + 1].d) === 1) {
          run.push(bbtDays[i + 1]);
          i += 1;
        }
        if (run.length > 1) segments.push(run);
      }
      const line = segments.map(run =>
        `<polyline points="${run.map(p => `${p.x.toFixed(1)},${Y(p.mean).toFixed(1)}`).join(" ")}" class="flo-bbt-line"/>`
      ).join("");
      // Пропущенные дни видны явно: серые чёрточки на базовой линии (§13).
      const gapTicks = dates.length <= 120
        ? dates.filter(d => !byDay.has(d)).map(d =>
          `<rect x="${(X(idx.get(d)) - 0.75).toFixed(1)}" y="${(H - pad - 3).toFixed(1)}" width="1.5" height="4" class="flo-gap-tick"><title>${esc(d)}: измерений нет</title></rect>`).join("")
        : "";
      measSvg = `<svg viewBox="0 0 ${W} ${H}" class="flo-chart" role="img" aria-label="Базальная температура и тесты ЛГ">
        ${line}
        ${gapTicks}
        ${bbtDays.flatMap(p => p.all.map(x => `<circle cx="${p.x.toFixed(1)}" cy="${Y(x.v).toFixed(1)}" r="3.5" class="flo-bbt-dot"><title>${esc(`${p.d}${x.m.time ? " " + x.m.time : ""}: БТ ${x.m.value}°${x.m.unit || "C"}`)}</title></circle>`)).join("")}
        ${lhPts.map(p => {
          const y = p.result === "positive" ? pad + 4 : p.result === "unclear" ? pad + 14 : pad + 24;
          const cls = p.result === "positive" ? "flo-lh-pos" : p.result === "unclear" ? "flo-lh-unclear" : "flo-lh-neg";
          const label = { positive: "положительный", negative: "отрицательный", unclear: "неясно" }[p.result] || p.result;
          return `<circle cx="${p.x.toFixed(1)}" cy="${y}" r="4" class="${cls}"><title>${esc(`${p.m.date}${p.m.time ? " " + p.m.time : ""}: ЛГ ${label}`)}</title></circle>`;
        }).join("")}
        ${axisSvg}
      </svg>
      <p class="flo-legend">Линия — базальная температура по дням (°C, °F приведены к °C; несколько замеров за день усредняются, точка есть у каждого замера). Разрыв линии и серые чёрточки внизу — дни без измерений. Маркеры вверху — тесты ЛГ: <span class="flo-lh-pos">●</span> положительный, <span class="flo-lh-unclear">●</span> неясно, <span class="flo-lh-neg">●</span> отрицательный.</p>`;
    }
    // Текстовое представление рядов (§13): точные даты и значения доступны
    // без наведения мыши — на мобильном <title> не читается.
    const lhByDate = new Map();
    for (const p of lhPts) lhByDate.set(p.m.date, p.result);
    const textRows = dates.map(d => {
      const day = daily.find(x => x.date === d);
      const bits = [];
      if (day?.pain_score !== null && day?.pain_score !== undefined) bits.push(`боль ${day.pain_score}/10`);
      if (day?.flow) bits.push(`кровотечение: ${FLO_FLOWS.find(([c]) => c === day.flow)?.[1] || day.flow}`);
      const dayBbt = byDay.get(d);
      if (dayBbt) bits.push(dayBbt.map(x => `БТ ${x.m.value}°${x.m.unit || "C"}${x.m.time ? ` (${x.m.time})` : ""}`).join("; "));
      if (lhByDate.has(d)) bits.push(`ЛГ: ${{ positive: "положительный", negative: "отрицательный", unclear: "неясно" }[lhByDate.get(d)] || lhByDate.get(d)}`);
      return bits.length ? `<tr><td>${esc(d)}</td><td>${esc(bits.join(" · "))}</td></tr>` : "";
    }).join("");
    const textBlock = textRows
      ? `<details class="flo-fold"><summary class="flo-fold-title">Данные по дням (текстом)</summary>
        <div class="flo-report-table-wrap"><table class="flo-report-table"><tbody>${textRows}</tbody></table></div>
        <p class="flo-disclaimer">Дни без строк — дни без отметок; пропуски не приравниваются к нулю.</p>
      </details>`
      : "";
    return `
      <p class="flo-sub">По дням (только отмеченные дни)</p>
      <p class="flo-line"><b>Боль</b></p>${painSvg}
      <p class="flo-line" style="margin-top:8px"><b>Кровотечение</b></p>${flowSvg}
      <p class="flo-line" style="margin-top:8px"><b>Измерения</b></p>${measSvg}
      ${textBlock}`;
  }

  function renderFloStats() {
    if (floStats === undefined) {
      if (!floStatsBusy) loadFloStats();
      return `<section class="card"><p class="eyebrow">Статистика</p><p>Считаем…</p></section>`;
    }
    if (floStats.failed) return "";
    const s = floStats;
    if (!s.cycles.length && !s.logged_days) {
      return `<section class="card"><p class="eyebrow">Статистика</p><p>Пока мало данных: нужны два старта месячных и несколько записей дня.</p></section>`;
    }
    // Подпись фактического диапазона (переработка 10.3): статистика всегда
    // помечена теми датами, по которым она посчитана.
    const rangeLabel = `с ${esc(formatDay(s.from || ""))} по ${esc(formatDay(s.to || ""))}`;
    let chart = `<p class="flo-disclaimer">Нужно минимум два старта месячных за период</p>`;
    if (s.cycles.length) {
      const W = 320, H = 130, pad = 18;
      const slot = (W - pad * 2) / s.cycles.length;
      const barW = Math.max(6, Math.min(28, slot - 6));
      // Диапазон шкалы — по фактическим длинам циклов (15–60): без клампа
      // короткие циклы рисовались бы на уровне 20, а не своей длины.
      const lens = s.cycles.map(c => c.length);
      const lo = Math.min(20, ...lens);
      const hi = Math.max(45, ...lens);
      const yFor = len => H - pad - ((Math.min(Math.max(len, lo), hi) - lo) / (hi - lo)) * (H - pad * 2);
      const bars = s.cycles.map((c, i) => {
        const y = yFor(c.length);
        return `<rect x="${(pad + i * slot + (slot - barW) / 2).toFixed(1)}" y="${y.toFixed(1)}" width="${barW.toFixed(1)}" height="${(H - pad - y).toFixed(1)}" rx="4" class="flo-bar"><title>${esc(c.start)}: ${c.length} дн.</title></rect>`;
      }).join("");
      const avgY = yFor(s.avg_cycle_length).toFixed(1);
      chart = `
        <svg viewBox="0 0 ${W} ${H}" class="flo-chart" role="img" aria-label="Длина циклов, дней">
          ${bars}
          <line x1="${pad}" x2="${W - pad}" y1="${avgY}" y2="${avgY}" class="flo-avg"></line>
        </svg>
        <p class="flo-legend">Столбцы: длина цикла. Линия: средняя длина завершённых циклов — ${s.avg_cycle_length} дн. (по ${s.cycles.length} ${s.cycles.length === 1 ? "циклу" : "циклам"} периода).</p>`;
    }
    // Этап 5/P1 + 10.4: среднее и медиана подписаны разными словами, у
    // каждого расчёта указано количество циклов — под одинаковыми подписями
    // разные методы не скрываются.
    const statBits = [];
    if (s.cycles.length) statBits.push(`средняя длина завершённых циклов ${s.avg_cycle_length} дн. (${s.cycles.length})`);
    if (s.median_cycle_length !== null && s.median_cycle_length !== undefined) statBits.push(`медиана ${s.median_cycle_length} дн. (последние пригодные циклы: ${s.usable_cycles})`);
    if (s.min_cycle_length !== null && s.max_cycle_length !== null) statBits.push(`от ${s.min_cycle_length} до ${s.max_cycle_length} дн.`);
    if (s.spread) statBits.push(`разброс ${s.spread} дн.`);
    if (s.period_lengths) statBits.push(`Месячные в среднем ${s.period_lengths.avg} дн. (от ${s.period_lengths.min} до ${s.period_lengths.max}, ${s.period_lengths.count} закрытых)`);
    const statLine = statBits.length ? `<p class="flo-line">${statBits.map(esc).join(" · ")}</p>` : "";
    const unusual = (s.unusual_intervals || []).length
      ? `<p class="flo-disclaimer">Необычные интервалы (вне 15–60 дн.) сохранены в истории, но не участвуют в среднем: ${s.unusual_intervals.map(iv => `${iv.start} — ${iv.length} дн.`).join(", ")}.</p>`
      : "";
    // Длинные периоды не отбрасываются молча (переработка 7).
    const longPeriods = (s.long_periods || []).length
      ? `<p class="flo-disclaimer">Необычно длинные месячные (больше 14 дней) сохранены как есть, но не участвуют в средней длительности: ${s.long_periods.map(p => `${formatDay(p.start)} — ${p.length} дн.`).join(", ")}. Если это повторяется, обсудите с врачом.</p>`
      : "";
    // Охват дневника (переработка 10.1): сколько календарных дней периода
    // заполнено хотя бы одной записью.
    const coverage = s.coverage && s.coverage.days_total
      ? `<p class="flo-line">Дневник заполнен за ${s.coverage.diary_days} из ${s.coverage.days_total} дней выбранного периода${s.logged_days ? ` (в фазах учтено дней с записями: ${s.logged_days})` : ""}.</p>`
      : "";
    // Доля показывается как «N из D дней» с числителем и знаменателем
    // (переработка 10.1): у каждого показателя свой знаменатель — дни, где
    // он вообще отмечался.
    const frac = (n, d) => d > 0 ? `${n} из ${d} дн. · ${Math.round((n / d) * 100)}%` : "нет отметок";
    const order = [["menstruation", "Менструация"], ["follicular", "Фолликулярная"], ["fertile", "Фертильное окно"], ["ovulation", "Овуляция"], ["luteal", "Лютеиновая"]];
    const rows = order.filter(([key]) => s.phases[key]).map(([key, label]) => {
      const bucket = s.phases[key];
      const top = Object.entries(bucket.symptoms).sort((a, b) => b[1] - a[1]).slice(0, 3);
      const meters = top.length
        ? top.map(([code, n]) => {
          const pct = Math.round((n / bucket.symptom_days) * 100);
          const name = FLO_SYMPTOMS.find(([c]) => c === code)?.[1] || code;
          return `<div class="flo-bar-row"><span>${esc(name)}</span><div class="flo-meter"><i style="width:${pct}%"></i></div><span>${esc(frac(n, bucket.symptom_days))}</span></div>`;
        }).join("")
        : `<p class="flo-disclaimer">Симптомов не отмечали</p>`;
      const symptomDen = bucket.symptom_days
        ? `<p class="flo-sub">Симптомы: знаменатель — дни с заполненным дневником симптомов (${bucket.symptom_days}${bucket.clear_days ? `, из них «симптомов не было»: ${bucket.clear_days}` : ""}).</p>`
        : "";
      const moodTop = Object.entries(bucket.moods || {}).sort((a, b) => b[1] - a[1]).slice(0, 3);
      const moodRows = moodTop.length
        ? moodTop.map(([code, n]) => {
          const pct = Math.round((n / bucket.mood_days) * 100);
          const name = FLO_MOODS.find(([c]) => c === code)?.[1] || code;
          return `<div class="flo-bar-row"><span>${esc(name)}</span><div class="flo-meter"><i style="width:${pct}%"></i></div><span>${esc(frac(n, bucket.mood_days))}</span></div>`;
        }).join("")
        : `<p class="flo-disclaimer">Настроение не отмечали</p>`;
      const energyParts = Object.entries(bucket.energy || {}).sort((a, b) => b[1] - a[1])
        .map(([code, n]) => `${esc(FLO_ENERGY.find(([c]) => c === code)?.[1] || code)} ${esc(frac(n, bucket.energy_days))}`);
      const energyLine = energyParts.length ? `<p class="flo-line">Энергия: ${energyParts.join(" · ")}</p>` : "";
      const painLine = bucket.avg_pain !== null && bucket.avg_pain !== undefined ? `<p class="flo-line">Боль в среднем ${bucket.avg_pain}/10 (за ${bucket.pain_count} ${bucket.pain_count === 1 ? "отметку" : "отметок"})</p>` : "";
      return `<div class="flo-phase"><p class="flo-line"><b>${label}</b> · дней с записями: ${bucket.days}</p>${symptomDen}${meters}${moodRows}${energyLine}${painLine}</div>`;
    }).join("");
    // Расширенная аналитика (переработка 10.5): описательные блоки по
    // фактическим записям, без причинно-следственных утверждений.
    const ins = s.insights || {};
    const insightBits = [];
    if (ins.bleeding && ins.bleeding.flow_days) {
      insightBits.push(`<p class="flo-line"><b>Кровотечение</b></p>
        <p class="flo-line">Дни с отмеченным кровотечением: ${ins.bleeding.flow_days}, из них обильные: ${ins.bleeding.heavy_days}, со сгустками: ${ins.bleeding.clot_days}.</p>
        ${s.period_lengths ? `<p class="flo-line">Длительность закрытых месячных в периоде: ${s.period_lengths.min}–${s.period_lengths.max} дн., в среднем ${s.period_lengths.avg} дн.</p>` : ""}`);
    }
    if (ins.wellbeing && ins.wellbeing.symptom_days) {
      const top = (ins.wellbeing.top_symptoms || []).map(t => {
        const name = FLO_SYMPTOMS.find(([c]) => c === t.code)?.[1] || t.code;
        return `${esc(name)} — ${esc(frac(t.count, t.denominator))}`;
      }).join("; ");
      insightBits.push(`<p class="flo-line"><b>Самочувствие</b></p>
        <p class="flo-line">Самые частые симптомы: ${top}.</p>
        ${ins.wellbeing.avg_pain !== null && ins.wellbeing.avg_pain !== undefined ? `<p class="flo-line">Боль в среднем ${ins.wellbeing.avg_pain}/10 за ${ins.wellbeing.pain_days} отметок.</p>` : ""}`);
    }
    if (ins.reproductive && (ins.reproductive.bbt_days || ins.reproductive.lh_days || ins.reproductive.mucus_days)) {
      // Пригодные БТ-дни — без дней болезни (переработка 6); пик слизи —
      // отдельное наблюдение, в смещение овуляции не подставляется (§4).
      const peak = (ins.reproductive.mucus_peak_dates || []).map(d => formatDay(d)).join(", ");
      insightBits.push(`<p class="flo-line"><b>Репродуктивные наблюдения</b></p>
        <p class="flo-line">БТ — дней с измерениями: ${ins.reproductive.bbt_days}, пригодных (без болезни): ${ins.reproductive.bbt_days_usable}; тесты ЛГ — дней: ${ins.reproductive.lh_days}, из них положительных: ${ins.reproductive.lh_positive_days}; слизь — дней с отметкой: ${ins.reproductive.mucus_days}${peak ? `, плодородный тип: ${esc(peak)}` : ""}.</p>`);
    }
    if (ins.lifestyle && (ins.lifestyle.sleep.good || ins.lifestyle.sleep.ok || ins.lifestyle.sleep.poor || ins.lifestyle.stress_days)) {
      insightBits.push(`<p class="flo-line"><b>Образ жизни</b></p>
        <p class="flo-line">Сон: хорошо — ${ins.lifestyle.sleep.good}, средне — ${ins.lifestyle.sleep.ok}, плохо — ${ins.lifestyle.sleep.poor}${ins.lifestyle.sleep_hours_avg !== null && ins.lifestyle.sleep_hours_avg !== undefined ? `; средняя длительность ${ins.lifestyle.sleep_hours_avg} ч за ${ins.lifestyle.sleep_hours_days} отметок` : ""}.</p>
        ${ins.lifestyle.stress_days ? `<p class="flo-line">Стресс отмечен ${ins.lifestyle.stress_days} дн.</p>` : ""}`);
    }
    if ((s.meds || []).length) {
      insightBits.push(`<p class="flo-line"><b>Препараты</b></p>
        ${s.meds.map(m => `<p class="flo-line">${esc(m.name)}: принято ${m.taken}, пропущено ${m.skipped}.</p>`).join("")}`);
    }
    const insightsBlock = insightBits.length ? `<p class="flo-sub">Аналитика за период</p>${insightBits.join("")}` : "";
    return `
      <section class="card">
        <p class="eyebrow">Статистика</p>
        <p class="flo-sub">Период: ${rangeLabel}</p>
        <div class="flo-chips" style="margin-bottom:8px">
          ${[3, 6, 12].map(m => `<button type="button" class="flo-chip${floStatsMonths === m ? " is-on" : ""}" data-action="flo-stats-months" data-months="${m}">${m} мес.</button>`).join("")}
        </div>
        ${chart}
        ${statLine}
        ${unusual}
        ${longPeriods}
        ${coverage}
        <p class="flo-sub">Симптомы по фазам (у каждого показателя свой знаменатель)</p>
        ${rows || `<p class="flo-disclaimer">Пока нет записей по фазам.</p>`}
        ${insightsBlock}
        ${floStatsDayCharts(s)}
        ${(s.pms_patterns || []).length ? `
        <p class="flo-sub">Повторяющиеся симптомы перед месячными (ПМС-паттерны, описательно)</p>
        <div class="flo-history">
          ${s.pms_patterns.map(p => {
            const name = FLO_SYMPTOMS.find(([c]) => c === p.code)?.[1] || p.code;
            const confidence = p.confidence === "good"
              ? "достаточная база"
              : "мало данных";
            return `<div class="item-row"><div class="item-main"><p class="item-title">${esc(name)}</p>
              <div class="item-meta"><span>обычно за ${p.avg_lead_days} дн. до месячных</span><span>в ${p.cycles_with_symptom} из ${p.cycles_with_data} циклов с записями</span></div>
              <div class="item-meta"><span>дней с отметкой: ${p.days}</span><span>${confidence}</span></div></div></div>`;
          }).join("")}
        </div>
        <p class="flo-disclaimer">Паттерн — не диагноз: это повторяемость отметок в ваших записях. Уверенный вывод строится только от 3 циклов с заполненным предменструальным окном; при меньшей базе паттерн показан как предварительный.</p>` : ""}
        <p class="flo-disclaimer">Фазы и овуляция — расчётные по датам месячных, не подтверждённые. Это не диагноз</p>
      </section>`;
  }

  function renderFloPeriodEditor() {
    if (!floEditing) return "";
    const p = floAllPeriods().find(x => x.start_date === floEditing.start);
    if (!p) return "";
    const del = floEditing.armDelete
      ? `<button type="button" class="primary is-danger full card-action" data-action="flo-delete-period" data-start="${esc(p.start_date)}">Точно удалить</button>`
      : `<button type="button" class="secondary is-danger full card-action" data-action="flo-delete-period-arm">Удалить</button>`;
    return `
      <section class="card">
        <p class="eyebrow">Месячные ${esc(p.start_date)}</p>
        <label class="field"><span>Начало</span>
          <input type="date" id="flo-edit-start" max="${esc(floState.today)}" value="${esc(p.start_date)}">
        </label>
        <label class="field"><span>Конец</span>
          <input type="date" id="flo-edit-end" max="${esc(floState.today)}" value="${esc(p.end_date || "")}">
        </label>
        ${p.end_unknown ? `<p class="flo-sub">Дата окончания не была указана — это не «идут», а неизвестный конец. Впишите факт или оставьте пустым.</p>` : ""}
        <button type="button" class="primary full card-action" data-action="flo-save-period" data-start="${esc(p.start_date)}">Сохранить</button>
        <button type="button" class="secondary full card-action" data-action="flo-edit-cancel">Отмена</button>
        ${del}
      </section>`;
  }

  // P3: честное объяснение прогноза — откуда взяты числа и насколько им
  // можно доверять. Прогноз остаётся оценкой, не фактом.
  function floForecastExplain(f) {
    if (!f || f.empty) return "";
    const bits = [];
    if (f.based_on === "history") bits.push(`Даты посчитаны по вашим записям: использовано циклов — ${f.usable_cycles ?? "—"}.`);
    else if (f.based_on === "profile") bits.push("Личной истории циклов пока мало — даты считаются по указанной вами длине цикла.");
    else bits.push("Истории пока нет — используется стандартная длина цикла 28 дней");
    if (f.quality === "insufficient") bits.push("Данных недостаточно: все даты очень примерные");
    else if (f.quality === "few") bits.push("Истории немного: даты могут заметно отличаться от факта.");
    if (f.next_period_early && f.next_period_late) {
      bits.push(`Разброс ожидания месячных: ${esc(floDayMonth(f.next_period_early))} — ${esc(floDayMonth(f.next_period_late))}. Это календарная оценка, а не гарантия`);
    }
    if (f.ovulation_source === "lh") bits.push("Дата овуляции уточнена по положительному тесту ЛГ — это оценка по косвенному признаку, а не подтверждение: тест не доказывает, что овуляция произошла.");
    else if (f.ovulation_source === "bbt") bits.push("Дата овуляции уточнена по подъёму базальной температуры — это оценка по косвенному признаку, а не подтверждение.");
    else if (f.ovulation_estimated && f.ovulation_offset_learned) bits.push(`Овуляция — календарная оценка с личным смещением, подобранным по вашим наблюдениям (${f.ovulation_offset_observations} цикла). Приложение продолжает уточнять смещение по новым данным.`);
    else if (f.ovulation_estimated) bits.push("Овуляция — календарная оценка (ожидаемое начало месячных минус 14 дней), она не подтверждена наблюдениями. Личные наблюдения ЛГ и БТ из нескольких циклов уточнят смещение автоматически.");
    if (f.ovulation_conflict) bits.push(`Признаки расходятся (ЛГ: ${esc(floDayMonth(f.ovulation_conflict.lh))}, БТ: ${esc(floDayMonth(f.ovulation_conflict.bbt))}) — показаны оба, для расчёта взят признак ЛГ как более ранний. Никакая дата овуляции не является подтверждённой.`);
    if (f.data_stale) bits.push("Последняя запись старая: прогноз может не отражать текущий цикл. Отметьте прошедшие месячные.");
    if (f.irregular) bits.push("Цикл нерегулярный: прогноз особенно приблизителен.");
    bits.push("Пропущенные дни дневника не считаются «днями без симптомов»");
    bits.push("Календарные прогнозы не являются надёжным методом предотвращения беременности");
    return `<details class="flo-fold flo-forecast"><summary class="flo-fold-title">Как считается прогноз?</summary><ul class="flo-explain">${bits.map(b => `<li>${b}</li>`).join("")}</ul></details>`;
  }

  function renderFloView() {
    if (!floState) {
      if (!floBusy) loadFloState();
      return `<section class="card"><p class="eyebrow">Фло</p><p>Загружаем календарь…</p></section>`;
    }
    if (floState.failed) {
      return `<section class="card"><p class="eyebrow">Фло</p><p>Не получилось загрузить календарь.</p>
        <button type="button" class="secondary full card-action" data-action="flo-retry">Повторить</button></section>`;
    }
    if (!floState.onboarded && !floWizardDismissed) return renderFloWizard();
    return `
      ${floState.onboarded ? "" : floBannerHtml()}
      ${renderSegment("flo", floView, [["today", "Сегодня"], ["cycle", "Цикл"], ["stats", "Статистика"], ["meds", "Препараты"], ["settings", "Настройки"]], "is-sub")}
      <div id="flo-body">${renderFloSection()}</div>`;
  }

  // Тело активной под-вкладки «Фло»: секции те же, что были на одной странице,
  // просто разнесены по группам. Партнёрский вид (renderFloPartnerView) под-бар
  // не получает — у него короткий экран без дневника и настроек.
  function renderFloSection() {
    if (floView === "cycle") return `${renderFloHistory()}${renderFloPeriodEditor()}`;
    if (floView === "stats") return renderFloStats();
    if (floView === "meds") return renderFloMeds();
    if (floView === "settings") return `
      <section class="card">
        <p class="eyebrow flo-group">Отчёт и экспорт</p>
        <button type="button" class="secondary full card-action" data-action="flo-report-open">Медицинский отчёт</button>
        <p class="flo-disclaimer">Печать в PDF — через диалог печати браузера. CSV и JSON скачиваются файлом.</p>
      </section>
      ${renderFloSettings()}`;
    return renderFloToday();
  }

  // «7 декабря» — число цифрой + месяц письменно, без года (для строк
  // прогноза в карточке «сегодня»).
  function floDayMonth(key) {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(key ?? ""));
    if (!m) return String(key ?? "");
    return new Intl.DateTimeFormat("ru-RU", { day: "numeric", month: "long", timeZone: "UTC" })
      .format(new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]))));
  }

  // «Сегодня»: прогноз, календарь месяца и дневник выбранного дня.
  // Карточка прогноза стоит над календарём и сама объясняет, на основании
  // чего посчитана (переработка 11): что прогнозируется, по скольким циклам,
  // когда последнее начало, насколько полны данные и что ограничивает
  // достоверность. Методика — в раскрывающемся блоке.
  // Ограничения применимости прогноза по контексту цикла (переработка 5.1):
  // паритет с cycleContextCaveats в worker.js — менять синхронно.
  const FLO_CONTEXT_CAVEATS = {
    pregnancy: "Отмечена беременность: календарные прогнозы месячных и овуляции неприменимы.",
    postpartum: "После родов и на грудном вскармливании цикл часто нерегулярный: прогнозы особенно приблизительны.",
    breastfeeding: "После родов и на грудном вскармливании цикл часто нерегулярный: прогнозы особенно приблизительны.",
    perimenopause: "В перименопаузе цикл меняется: прогнозы приблизительны.",
    hormonal_contraception: "Гормональная контрацепция управляет циклом сама: календарный прогноз овуляции неприменим.",
    cycle_affecting_meds: "Препараты, влияющие на цикл или температуру, могут искажать прогноз и температурные наблюдения.",
    very_irregular: "Отмечены выраженно нерегулярные циклы: прогнозы очень приблизительные.",
    unusual_bleeding: "Отмечены необычные или межменструальные кровотечения — если это повторяется, обсудите с врачом."
  };
  function floContextCaveats() {
    const context = floState.context || {};
    return Object.keys(FLO_CONTEXT_CAVEATS).filter(key => context[key]).map(key => FLO_CONTEXT_CAVEATS[key]);
  }
  function renderFloForecastCard() {
    const f = floState.forecast;
    const openStart = floState.open_period_start;
    const actionBtn = openStart
      ? `<button type="button" class="primary full card-action" data-action="flo-period-end">Завершить месячные</button>`
      : `<button type="button" class="primary full card-action" data-action="flo-period-start">Отметить месячные</button>`;
    let todayBody;
    if (f.empty) {
      todayBody = `<p>Отметьте первые месячные, и появится прогноз.</p>`;
    } else {
      const lines = [`<b>День ${f.cycle_day} цикла</b> · ${esc(FLO_PHASE_LABELS[f.phase] || "")}`];
      if (f.phase === "stale") lines.push("С последней записи прошло много времени — данные могли устареть. Отметьте прошедшие месячные, чтобы прогноз снова стал точным.");
      else if (f.phase === "delay") lines.push(`Задержка ${f.delay_days} дн. Возможно, стоит заглянуть в календарь.`);
      else if (openStart) {
        lines.push(`Месячные идут с ${esc(openStart)}`);
        // Долго незакрытый период: нейтральная подсказка уточнить дату
        // окончания, без диагнозов (аудит 3.1.E).
        const openDays = floDayDiff(openStart, floState.today);
        if (openDays >= 10) lines.push(`Месячные идут уже ${openDays} дн. — уточните дату окончания в календаре. Если кровотечение заметно дольше обычного, обсудите это с врачом.`);
      }
      else if (f.next_period_in === 0) lines.push("Месячные по прогнозу ожидаются сегодня");
      else if (!f.data_stale) lines.push(`Месячные ориентировочно ${esc(floDayMonth(f.next_period_early))} — ${esc(floDayMonth(f.next_period_late))}`);
      // Основание прогноза — прямо в карточке, без необходимости искать методику.
      if (f.based_on === "history" && f.usable_cycles) lines.push(`Расчёт по ${f.usable_cycles} ${f.usable_cycles === 1 ? "завершённому циклу" : "завершённым циклам"}. Последнее начало месячных отмечено ${esc(floDayMonth(f.last_period_start))}.`);
      else if (f.based_on === "profile") lines.push("Расчёт по указанной вами длине цикла — личной истории пока мало.");
      else lines.push("Расчёт по стандартной длине цикла 28 дней — это не ваша личная норма.");
      if (f.quality === "insufficient") lines.push("Данных недостаточно: даты очень примерные");
      // §4.1: при недостатке данных уверенной оценки овуляции нет вовсе —
      // вместо даты показывается, каких данных не хватает.
      if (f.phase !== "delay" && f.phase !== "stale" && f.ovulation_in > 0) {
        if (f.quality === "insufficient") {
          lines.push("Для оценки овуляции данных пока недостаточно: отметьте ещё один цикл или наблюдения (ЛГ, БТ), и оценка появится.");
        } else if (f.ovulation_source === "lh") {
          lines.push(`Овуляция — оценка по положительному тесту ЛГ, примерно через ${f.ovulation_in} дн. Это косвенный признак, не подтверждение.`);
        } else if (f.ovulation_source === "bbt") {
          lines.push(`Овуляция — оценка по температурному сдвигу, примерно через ${f.ovulation_in} дн. Это косвенный признак, не подтверждение.`);
        } else if (f.ovulation_offset_learned) {
          lines.push(`Овуляция — календарная оценка, примерно через ${f.ovulation_in} дн. Смещение подобрано по вашим наблюдениям (${f.ovulation_offset_observations} цикла).`);
        } else {
          lines.push("Овуляция — календарная оценка (старт минус 14 дней), не подтверждена наблюдениями.");
        }
      }
      // §6: расхождение ЛГ и БТ показывается по отдельности, а не усредняется.
      if (f.ovulation_conflict) {
        lines.push(`Наблюдения расходятся: ЛГ указывает на ${esc(floDayMonth(f.ovulation_conflict.lh))}, температурный сдвиг — на ${esc(floDayMonth(f.ovulation_conflict.bbt))}. Показаны оба признака; уточнит следующий цикл.`);
      }
      if (f.irregular) lines.push(`Цикл нерегулярный, прогнозы приблизительные.`);
      const caveats = floContextCaveats();
      for (const c of caveats) lines.push(esc(c));
      todayBody = lines.map(l => `<p class="flo-line">${l}</p>`).join("");
    }
    return `
      <section class="card flo-today">
        <p class="eyebrow">Фло · сегодня</p>
        ${todayBody}
        ${actionBtn}<button type="button" class="secondary full card-action" data-action="flo-record-today">Записать сегодня</button>
        ${floFreshnessLine()}
        ${floForecastExplain(f)}
        <p class="flo-disclaimer">${esc(floState.disclaimer)}. ${esc(floState.contraception_disclaimer || "Календарные прогнозы не являются надёжным методом предотвращения беременности")}</p>
      </section>`;
  }

  // Актуальность данных по категориям (§11.1): последнее начало месячных,
  // запись дневника, измерение и приём препарата — отдельно, «нет записей»
  // не приравнивается к нулю и не смешивается с устареванием.
  function floFreshnessLine() {
    const fr = floState.data_freshness || {};
    const fmt = d => d ? floDayMonth(d) : "нет записей";
    return `<p class="flo-sub">Свежесть данных</p>
      <p class="flo-line">Месячные: ${esc(fmt(fr.last_period_start))} · Дневник: ${esc(fmt(fr.last_diary_date))} · Измерения: ${esc(fmt(fr.last_measurement_date))} · Препараты: ${esc(fmt(fr.last_medication_log_date))}</p>`;
  }
  function renderFloToday() {
    return `
      ${renderFloForecastCard()}
      ${renderFloCalendar()}
      ${renderFloDayCard()}`;
  }

  async function handleFloAction(action, btn) {
    const date = btn.dataset.date || "";
    const shift = (delta) => {
      const [y, m] = floMonth.split("-").map(Number);
      const d = new Date(Date.UTC(y, m - 1 + delta, 1));
      floMonth = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
      render();
      floEnsureMonth(floMonth);
    };
    if (action === "flo-month-prev") return shift(-1);
    if (action === "flo-month-next") return shift(1);
    if (action === "flo-retry") { floState = null; return render(); }
    if (action === "flo-select-day") { floSelectedDate = date; return render(); }
    if (action === "flo-record-today") {
      floSelectedDate = floState.today;
      render();
      // Плавный переход к карточке дня после перерисовки.
      setTimeout(() => document.getElementById("flo-day-card")?.scrollIntoView({ behavior: "smooth", block: "start" }), 50);
      return;
    }
    if (action === "flo-period-start") return floSave({ start: floState.today });
    if (action === "flo-period-end") return floSave({ start: floState.open_period_start, end: floState.today });
    if (action === "flo-day-start") return floSave({ start: date });
    if (action === "flo-day-end") return floSave({ start: floState.open_period_start, end: date });
    if (action === "flo-set-sex") {
      const value = btn.dataset.sex;
      const cur = floDayLog(date);
      // Повторный тап по той же отметке снимает её; смена типа сохраняет счётчик.
      if (cur.sex === value) return floPostLog(date, { sex: null, sex_count: 0 });
      return floPostLog(date, { sex: value, sex_count: value === "none" ? 0 : Math.max(1, cur.sex_count || 1) });
    }
    if (action === "flo-sex-inc" || action === "flo-sex-dec") {
      const cur = floDayLog(date);
      const delta = action === "flo-sex-inc" ? 1 : -1;
      const sex_count = Math.min(20, Math.max(1, (cur.sex_count || 1) + delta));
      return floPostLog(date, { sex_count });
    }
    if (action === "flo-set-flow") {
      const flow = btn.dataset.flow;
      return floPostLog(date, { flow: floDayLog(date).flow === flow ? null : flow });
    }
    if (action === "flo-set-clots") {
      // data-value — новое значение-инверт текущего.
      return floPostLog(date, { clots: btn.dataset.value === "true" });
    }
    if (action === "flo-set-leakage") {
      const leakage = btn.dataset.leakage;
      return floPostLog(date, { leakage: floDayLog(date).leakage === leakage ? null : leakage });
    }
    if (action === "flo-set-pain") {
      const pain = Number(btn.dataset.pain);
      // Повторный тап по той же оценке снимает её (NULL = не отмечено).
      return floPostLog(date, { pain_score: floDayLog(date).pain_score === pain ? null : pain });
    }
    if (action === "flo-toggle-pain-loc") {
      const code = btn.dataset.code;
      const current = floDayLog(date).pain_locations || [];
      const pain_locations = current.includes(code) ? current.filter(c => c !== code) : [...current, code];
      return floPostLog(date, { pain_locations });
    }
    if (action === "flo-set-impact") {
      const impact = btn.dataset.impact;
      return floPostLog(date, { life_impact: floDayLog(date).life_impact === impact ? null : impact });
    }
    if (action === "flo-set-energy") {
      const energy = btn.dataset.energy;
      return floPostLog(date, { energy: floDayLog(date).energy === energy ? null : energy });
    }
    if (action === "flo-toggle-clear") {
      // Включение «симптомов не было» снимает конкретные симптомы (9.2).
      const next = !floDayLog(date).symptoms_clear;
      return floPostLog(date, next ? { symptoms_clear: true, symptoms: [] } : { symptoms_clear: false });
    }
    if (action === "flo-set-mood") {
      const mood = btn.dataset.mood;
      return floPostLog(date, { mood: floDayLog(date).mood === mood ? null : mood });
    }
    if (action === "flo-toggle-symptom") {
      const code = btn.dataset.code;
      const current = floDayLog(date).symptoms;
      const symptoms = current.includes(code) ? current.filter(c => c !== code) : [...current, code];
      // Выбор симптома снимает «симптомов не было» (9.2).
      return floPostLog(date, symptoms.length ? { symptoms, symptoms_clear: false } : { symptoms });
    }
    if (action === "flo-save-note") {
      return floPostLog(date, { note: document.getElementById("flo-note")?.value || "" });
    }
    // --- P2: слизь, факторы, измерения, приём препаратов ---
    if (action === "flo-set-mucus") {
      const field = btn.dataset.field;
      const value = btn.dataset.value;
      const mucus = { ...(floDayLog(date).mucus || {}) };
      if (mucus[field] === value) delete mucus[field]; else mucus[field] = value;
      return floPostLog(date, { mucus: Object.keys(mucus).length ? mucus : null });
    }
    if (action === "flo-toggle-mucus-discomfort") {
      const mucus = { ...(floDayLog(date).mucus || {}) };
      if (mucus.discomfort) delete mucus.discomfort; else mucus.discomfort = true;
      return floPostLog(date, { mucus: Object.keys(mucus).length ? mucus : null });
    }
    // Дополнительные сведения о кровотечении (переработка 7): пропитывание —
    // чип, частота смены и ночная смена — форма с сохранением.
    if (action === "flo-set-bleeding-saturation") {
      const value = btn.dataset.value;
      const current = floDayLog(date).bleeding_details || {};
      const saturation = current.saturation === value ? null : value;
      return floPostLog(date, { bleeding_details: { ...current, saturation } });
    }
    if (action === "flo-toggle-bleeding-night") {
      const current = floDayLog(date).bleeding_details || {};
      return floPostLog(date, { bleeding_details: { ...current, night_change: !current.night_change } });
    }
    if (action === "flo-save-bleeding") {
      const raw = document.getElementById("flo-bleeding-changes")?.value;
      const changes = raw === "" || raw === undefined ? null : Number(raw);
      if (changes !== null && (!Number.isInteger(changes) || changes < 0 || changes > 24)) {
        showToast("Смен средства гигиены — от 0 до 24");
        return;
      }
      const current = floDayLog(date).bleeding_details || {};
      const details = { ...current, changes_per_day: changes };
      if (details.changes_per_day === null && details.saturation === undefined && !details.night_change) {
        return floPostLog(date, { bleeding_details: null });
      }
      return floPostLog(date, { bleeding_details: details });
    }
    if (action === "flo-set-sleep-quality") {
      const v = btn.dataset.value;
      return floPostLog(date, { sleep_quality: floDayLog(date).sleep_quality === v ? null : v });
    }
    if (action === "flo-set-stress") {
      const v = btn.dataset.value;
      return floPostLog(date, { stress: floDayLog(date).stress === v ? null : v });
    }
    if (action === "flo-toggle-sick") {
      return floPostLog(date, { sick: !floDayLog(date).sick });
    }
    if (action === "flo-toggle-travel") {
      return floPostLog(date, { travel: !floDayLog(date).travel });
    }
    if (action === "flo-save-factors") {
      const rawSleep = document.getElementById("flo-sleep-hours")?.value;
      const rawWeight = document.getElementById("flo-weight")?.value;
      const sleep = rawSleep === "" || rawSleep === undefined ? null : Number(rawSleep);
      const weight = rawWeight === "" || rawWeight === undefined ? null : Number(rawWeight);
      if (sleep !== null && (!Number.isFinite(sleep) || sleep < 0 || sleep > 24)) {
        showToast("Сон — от 0 до 24 часов");
        return;
      }
      if (weight !== null && (!Number.isFinite(weight) || weight < 30 || weight > 250)) {
        showToast("Проверьте вес");
        return;
      }
      return floPostLog(date, { sleep_hours: sleep, weight_kg: weight });
    }
    if (action === "flo-pick-lh") {
      floLhDraft = { date, result: btn.dataset.value };
      return render();
    }
    if (action === "flo-add-bbt") {
      const raw = document.getElementById("flo-bbt")?.value;
      const value = raw === "" || raw === undefined ? NaN : Number(raw);
      if (!Number.isFinite(value)) { showToast("Введите температуру"); return; }
      return floPostMeasurement({
        date, kind: "bbt", value, unit: "C",
        time: document.getElementById("flo-bbt-time")?.value || null
      });
    }
    if (action === "flo-add-lh") {
      if (floLhDraft.date !== date || !floLhDraft.result) return;
      const result = floLhDraft.result;
      floLhDraft = { date: null, result: null };
      return floPostMeasurement({
        date, kind: "lh", result,
        time: document.getElementById("flo-lh-time")?.value || null
      });
    }
    if (action === "flo-del-measurement") {
      try {
        floState = await request("/api/cycle/measurement/delete", { method: "POST", body: { id: Number(btn.dataset.id) } });
        // Точка исчезает из графиков и расчётов сразу: кэш статистики
        // инвалидируется вместе с удалением (9.5).
        floStats = undefined;
        floExtra.measurements = floExtra.measurements.filter(m => m.id !== Number(btn.dataset.id));
      } catch (error) { handleRequestError(error); }
      return render();
    }
    if (action === "flo-med-detail") {
      const key = `${btn.dataset.med}:${btn.dataset.date || date}`;
      floMedDetail = floMedDetail === key ? null : key;
      return render();
    }
    if (action === "flo-med-intake" || action === "flo-med-intake-clear") {
      const medId = Number(btn.dataset.med);
      const d = btn.dataset.date || date;
      if (action === "flo-med-intake-clear") {
        try {
          floState = await request("/api/cycle/med-log/delete", { method: "POST", body: { med_id: medId, date: d } });
          floExtra.med_logs = floExtra.med_logs.filter(x => !(x.med_id === medId && x.date === d));
        } catch (error) { handleRequestError(error); }
        floMedDetail = null;
        return render();
      }
      const key = `${medId}:${d}`;
      const body = { med_id: medId, date: d, status: btn.dataset.status };
      if (floMedDetail === key) {
        body.time = document.getElementById(`flo-med-time-${medId}`)?.value || null;
        body.dose_taken = document.getElementById(`flo-med-dose-${medId}`)?.value || null;
        body.note = document.getElementById(`flo-med-note-${medId}`)?.value || null;
      }
      floMedDetail = null;
      return floPostMedLog(body);
    }
    // --- P2: статистика (период), отчёт ---
    if (action === "flo-stats-months") {
      floStatsMonths = Number(btn.dataset.months) || 12;
      floStats = undefined;
      return loadFloStats();
    }
    if (action === "flo-report-open") {
      return openFloReportDialog();
    }
    if (action === "flo-report-months") {
      if (floReport) floReport = { ...floReport, months: Number(btn.dataset.months) || 6 };
      return loadFloReport();
    }
    if (action === "flo-report-retry") {
      floReport = null;
      return loadFloReport();
    }
    if (action === "flo-report-print") {
      window.print();
      return;
    }
    if (action === "flo-report-csv" || action === "flo-report-json") {
      if (!floReport?.data) return;
      floReportDownload(floReport.data, action === "flo-report-csv" ? "csv" : "json");
      return;
    }
    // --- P2: «Мои препараты» ---
    if (action === "flo-med-new") {
      floMedForm = { name: "", category: "", dosage: "", form: "", schedule: "", start_date: floState.today, end_date: "", status: "active", note: "" };
      return render();
    }
    if (action === "flo-med-edit") {
      const m = floMeds().find(x => x.id === Number(btn.dataset.id));
      if (!m) return;
      floMedForm = { ...m, end_date: m.end_date || "" };
      floMedDeleteArmed = null;
      return render();
    }
    if (action === "flo-med-cancel") {
      floMedForm = null;
      floMedDeleteArmed = null;
      return render();
    }
    if (action === "flo-med-save-read") {
      const f = { ...(floMedForm || {}) };
      f.name = document.getElementById("flo-med-name")?.value || "";
      f.category = document.getElementById("flo-med-category")?.value || "";
      f.dosage = document.getElementById("flo-med-dosage")?.value || "";
      f.form = document.getElementById("flo-med-form")?.value || "";
      f.status = document.getElementById("flo-med-status")?.value || "active";
      f.schedule = document.getElementById("flo-med-schedule")?.value || "";
      f.start_date = document.getElementById("flo-med-start")?.value || "";
      f.end_date = document.getElementById("flo-med-end")?.value || "";
      f.note = document.getElementById("flo-med-note")?.value || "";
      floMedForm = f;
      if (!f.name.trim()) { showToast("Укажите название препарата"); return; }
      if (!f.start_date) { showToast("Укажите дату начала курса"); return; }
      return floSaveMed({
        name: f.name, category: f.category || null, dosage: f.dosage || null,
        form: f.form || null, schedule: f.schedule || null,
        start_date: f.start_date, end_date: f.end_date || null,
        status: f.status || "active", note: f.note || null, ...(f.id ? { id: f.id } : {})
      });
    }
    if (action === "flo-med-save") {
      const f = floMedForm || {};
      const body = {
        name: f.name, category: f.category || null, dosage: f.dosage || null,
        form: f.form || null, schedule: f.schedule || null,
        start_date: f.start_date, end_date: f.end_date || null,
        status: f.status || "active", note: f.note || null
      };
      if (f.id) body.id = f.id;
      return floSaveMed(body);
    }
    if (action === "flo-med-delete-arm") {
      floMedDeleteArmed = Number(btn.dataset.id);
      return render();
    }
    if (action === "flo-med-delete") {
      try {
        floState = await request("/api/cycle/med/delete", { method: "POST", body: { id: Number(btn.dataset.id) } });
        floMedForm = null;
        floMedDeleteArmed = null;
        showToast("Препарат и история приёма удалены");
      } catch (error) { handleRequestError(error); }
      return render();
    }
    if (action === "flo-share-toggle") {
      const enabled = btn.dataset.enabled === "true";
      try {
        floState = await request("/api/cycle/share", { method: "PATCH", body: { enabled } });
        showToast(enabled
          ? "Шеринг включён: партнёр видит календарную оценку. Подтвердите состав данных, чтобы открыть категории."
          : "Шеринг выключен — передача данных прекращена сразу");
      } catch (error) {
        handleRequestError(error);
      }
      return render();
    }
    if (action === "flo-share-cat") {
      const key = btn.dataset.cat;
      const current = floState.share || { enabled: false, categories: {} };
      const categories = { ...(current.categories || {}), [key]: btn.dataset.enabled === "true" };
      try {
        // Категории можно менять при выключенном шеринге: сохраняются как
        // намерение и начнут передаваться только после включения и подтверждения.
        floState = await request("/api/cycle/share", { method: "PATCH", body: { enabled: current.enabled === true, categories } });
      } catch (error) {
        handleRequestError(error);
      }
      return render();
    }
    if (action === "flo-share-confirm") {
      const current = floState.share || { enabled: false, categories: {} };
      try {
        floState = await request("/api/cycle/share", {
          method: "PATCH",
          body: { enabled: true, categories: current.categories || {}, confirmed: true }
        });
        showToast("Состав данных подтверждён — партнёр видит выбранные категории");
      } catch (error) {
        handleRequestError(error);
      }
      return render();
    }
    if (action === "flo-export") {
      try {
        const res = await request("/api/cycle/export", { method: "POST", body: {} });
        showToast(`Файл отправлен в чат с ботом: периодов ${res.periods}, записей ${res.logs}`);
      } catch (error) {
        handleRequestError(error);
      }
      return;
    }
    if (action === "flo-delete-start" || action === "flo-delete-cancel") {
      floDeleteArmed = action === "flo-delete-start";
      return render();
    }
    if (action === "flo-delete-confirm") {
      try {
        floState = await request("/api/cycle/delete", { method: "POST", body: { confirm: "DELETE" } });
        floStats = undefined;
        floDeleteArmed = false;
        floSelectedDate = null;
        showToast("Данные Фло удалены");
      } catch (error) {
        handleRequestError(error);
      }
      return render();
    }
    if (action === "flo-wiz-open") {
      floWizardDismissed = false;
      floWizard = { step: 0 };
      return render();
    }
    if (action === "flo-wiz-postpone") {
      floWizard = null;
      floWizardDismissed = true;
      return render();
    }
    if (action === "flo-wiz-begin") {
      floWizard = { step: 1, lastStart: floState.today, periodLen: 5, cycle: null, previous: [], shareCategories: {} };
      return render();
    }
    if (action === "flo-wiz-back") {
      floWizard = { ...floWizard, step: Math.max(0, (floWizard?.step || 1) - 1) };
      return render();
    }
    if (action === "flo-wiz-next") {
      const w = { ...floWizard };
      if (w.step === 1) {
        const value = document.getElementById("flo-wiz-date")?.value || "";
        if (!value || value > floState.today) {
          showToast("Укажите дату не позже сегодня");
          return;
        }
        w.lastStart = value;
      }
      if (w.step === 3) {
        const raw = document.getElementById("flo-wiz-cycle")?.value || "";
        if (raw !== "") {
          const num = Number(raw);
          if (!Number.isInteger(num) || num < 20 || num > 45) {
            showToast("Длина цикла от 20 до 45 дней");
            return;
          }
          w.cycle = num;
        } else {
          w.cycle = null;
        }
      }
      floWizard = { ...w, step: w.step + 1 };
      return render();
    }
    if (action === "flo-wiz-unknown") {
      floWizard = { ...floWizard, cycle: null, step: 5 };
      return render();
    }
    if (action === "flo-wiz-set") {
      if (btn.dataset.field === "periodLen") {
        floWizard = { ...floWizard, periodLen: Number(btn.dataset.value), step: 3 };
        return render();
      }
      return floWizardFinish(btn.dataset.value);
    }
    if (action === "flo-wiz-share-cat") {
      const key = btn.dataset.cat;
      const current = floWizard?.shareCategories || {};
      floWizard = { ...floWizard, shareCategories: { ...current, [key]: !current[key] } };
      return render();
    }
    // Импорт прошлых периодов: общий редактор для мастера (wiz) и истории (hist).
    if (action === "flo-prev-add") {
      const prefix = btn.dataset.prefix === "hist" ? "hist" : "wiz";
      const start = document.getElementById(`flo-${prefix}-prev-start`)?.value || "";
      if (!start || start > floState.today) {
        showToast("Укажите дату не позже сегодня");
        return;
      }
      const items = floPrevItems(prefix);
      if (items.length >= 12) {
        showToast("Не больше 12 прошлых периодов за раз");
        return;
      }
      if (items.some(p => p.start === start)) {
        showToast("Такой старт уже добавлен");
        return;
      }
      const days = btn.dataset.days ? Number(btn.dataset.days) : null;
      const item = days
        ? { start, end: floDateShift(start, days - 1), end_unknown: false }
        : { start, end: null, end_unknown: true };
      // Дата окончания не может быть позже сегодня — иначе сервер отклонит
      // весь пакет, а пользователь не поймёт почему.
      if (item.end && item.end > floState.today) {
        showToast("Такая длительность выводит конец за сегодня — укажите «конец не помню»");
        return;
      }
      // Прошлый период обязан быть раньше текущей (открытой) менструации:
      // в мастере это lastStart, в истории — open_period_start. «Конец не
      // помним» всегда заканчивается до следующего старта, так что для
      // unknown-end достаточно проверки start < anchor.
      const anchor = prefix === "wiz" ? floWizard?.lastStart : floState?.open_period_start;
      if (anchor && start >= anchor) {
        showToast("Прошлый период должен начинаться раньше последних месячных");
        return;
      }
      if (anchor && item.end && item.end >= anchor) {
        showToast("Период пересекается с последними месячными — уменьшите длительность");
        return;
      }
      floPrevSetItems(prefix, [...items, item]);
      return render();
    }
    if (action === "flo-prev-del") {
      const prefix = btn.dataset.prefix === "hist" ? "hist" : "wiz";
      const items = floPrevItems(prefix).filter((_, i) => i !== Number(btn.dataset.index));
      floPrevSetItems(prefix, items);
      return render();
    }
    if (action === "flo-hist-prev-toggle") {
      floHistPrevOpen = !floHistPrevOpen;
      if (!floHistPrevOpen) floHistPrev = [];
      return render();
    }
    if (action === "flo-hist-prev-save") {
      if (!floHistPrev.length) {
        showToast("Добавьте хотя бы один прошлый период");
        return;
      }
      try {
        const sent = floHistPrev.length;
        floState = await request("/api/cycle/periods", { method: "POST", body: { periods: floHistPrev } });
        floExtra = { periods: [], logs: [], meds: [], med_logs: [], measurements: [] };
        floHistPrev = [];
        floHistPrevOpen = false;
        floStats = undefined;
        showToast(`Добавлено периодов: ${floState.periods_imported ?? sent}, пропущено: ${floState.periods_skipped ?? 0}`);
      } catch (error) {
        handleRequestError(error);
      }
      return render();
    }
    if (action === "flo-share-notify") {
      try {
        floState = await request("/api/cycle/share-notify", { method: "PATCH", body: { enabled: btn.dataset.enabled === "true" } });
      } catch (error) {
        handleRequestError(error);
      }
      return render();
    }
    if (action === "flo-notify-toggle") {
      try {
        floState = await request("/api/cycle/notify", { method: "PATCH", body: { enabled: btn.dataset.enabled === "true" } });
      } catch (error) {
        handleRequestError(error);
      }
      return render();
    }
    if (action === "flo-edit-period") {
      floEditing = { start: btn.dataset.start, armDelete: false };
      return render();
    }
    if (action === "flo-edit-cancel") {
      floEditing = null;
      return render();
    }
    if (action === "flo-delete-period-arm") {
      floEditing = { ...floEditing, armDelete: true };
      return render();
    }
    if (action === "flo-save-period") {
      const start = document.getElementById("flo-edit-start")?.value || "";
      const end = document.getElementById("flo-edit-end")?.value || null;
      if (!start) {
        showToast("Укажите дату начала");
        return;
      }
      try {
        floState = await request("/api/cycle/period", { method: "PATCH", body: { original_start: btn.dataset.start, start, end } });
        floExtraDelPeriod(btn.dataset.start);
        floExtraPutPeriod({ start_date: start, end_date: end || null });
        floEditing = null;
        floStats = undefined;
      } catch (error) {
        handleRequestError(error);
      }
      return render();
    }
    if (action === "flo-delete-period") {
      try {
        floState = await request("/api/cycle/period/delete", { method: "POST", body: { start: btn.dataset.start } });
        floExtraDelPeriod(btn.dataset.start);
        floEditing = null;
        floStats = undefined;
        showToast("Месячные удалены");
      } catch (error) {
        handleRequestError(error);
      }
      return render();
    }
    if (action === "flo-notify-kind") {
      try {
        floState = await request("/api/cycle/notify", { method: "PATCH", body: { [btn.dataset.kind]: btn.dataset.enabled === "true" } });
      } catch (error) {
        handleRequestError(error);
      }
      return render();
    }
    if (action === "flo-notify-days") {
      try {
        floState = await request("/api/cycle/notify", { method: "PATCH", body: { [btn.dataset.field]: Number(btn.dataset.value) } });
      } catch (error) {
        handleRequestError(error);
      }
      return render();
    }
    if (action === "flo-save-profile") {
      const body = {
        avg_cycle_length: Number(document.getElementById("flo-avg-cycle")?.value),
        avg_period_length: Number(document.getElementById("flo-avg-period")?.value)
      };
      try {
        floState = await request("/api/cycle/profile", { method: "PATCH", body });
      } catch (error) {
        handleRequestError(error);
      }
      return render();
    }
    if (action === "flo-context-toggle") {
      const key = btn.dataset.key;
      const current = floState.context || {};
      const context = { ...current, [key]: btn.dataset.enabled === "true" };
      try {
        floState = await request("/api/cycle/context", { method: "PATCH", body: { context } });
      } catch (error) {
        handleRequestError(error);
      }
      return render();
    }
  }

  function renderPairBody() {
    const { pair } = appState;
    // Карточка приглашения живёт ровно пока партнёра нет: как только он
    // присоединился (user_b заполнен) — скрываем; если партнёр вышел
    // (сервер обнуляет user_b) — карточка возвращается.
    const inviteBlock = partnerMissing() ? `
      <section class="card">
        <p class="eyebrow">${Number(pair.awaiting_return) === 1 ? "Ожидание возвращения" : "Приглашение партнёра"}</p>
        <h3>${Number(pair.awaiting_return) === 1 ? "Пространство ждёт вашего партнёра" : "Отправьте код партнёру"}</h3>
        <p>${Number(pair.awaiting_return) === 1
          ? "Партнёр вышел, и код зарезервирован за ним: войти по нему сможет только его аккаунт. Изменения в пространстве заморожены до возвращения."
          : "После его присоединения здесь появятся общие планы, значимые даты, общий дневник, вишлист и ритуал дня."}</p>
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
    return mergedArchive("savings", appState.savings || []);
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
      ? itemActionButton({ action: "delete-item", type: "savings", id: saving.id, label: "Удалить", icon: DELETE_ICON })
      : [
          itemActionButton({ action: "deposit-saving", id: saving.id, label: "Пополнить", icon: PLUS_ICON }),
          itemActionButton({ action: "edit-saving", id: saving.id, label: "Редактировать", icon: EDIT_ICON }),
          itemActionButton({ action: "delete-item", type: "savings", id: saving.id, label: "Удалить", icon: DELETE_ICON })
        ].join("\n        ");
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
          ${itemActions(actions)}
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
          <p>Создайте копилку на общую мечту или личную цель — пополняйте и следите за прогрессом</p>
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
    return html + archiveMoreHtml("savings", (appState.savings || []).length);
  }

  // Сегмент-переключатель вида: те же кнопки, что в доке, но внутри вкладки.
  // data-action="seg-switch" обрабатывается общим делегированным кликом.
  function renderSegment(key, value, options, extraClass = "") {
    // 4+ вкладки («Дневник», «Наша пара») — плотный шаг: стандартные отступы
    // выталкивали бар за границу дисплея.
    const dense = options.length >= 4 ? " is-dense" : "";
    return `
      <div class="seg-switch${dense}${extraClass ? ` ${extraClass}` : ""}" data-switch="${key}" role="tablist">
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
    return `
      ${renderSegment("plans", plansView, [["open", "Предстоящие"], ["done", "Выполненные"]], "is-sub")}
      <div id="plans-body">${renderPlansList()}</div>
    `;
  }

  // Список сегмента «Планы»: ветки те же, что до появления переключателя,
  // «Завершённые» переехали из хвоста списка в отдельный вид.
  function renderPlansList() {
    const taskDisabledClass = partnerMissing() ? " is-disabled" : "";
    const doneTasks = mergedArchive("done_tasks", appState.completedTasks || []);
    if (plansView === "done") {
      if (!doneTasks.length) {
        return `<section class="card"><h3>Пока ничего не завершено</h3><p>Отметьте план выполненным — он переедет сюда</p></section>`;
      }
      return `
        <div class="section-head-inline"><h3>Завершённые · ${doneTasks.length}</h3></div>
        ${doneTasks.map(completedTaskItem).join("")}
        ${archiveMoreHtml("done_tasks", (appState.completedTasks || []).length)}
      `;
    }
    const openTasks = mergedArchive("tasks", sortByTaskDeadline(appState.tasks || []));
    let html = "";
    if (openTasks.length) {
      html += `<button class="primary full add-button${taskDisabledClass}" type="button" data-action="add-task">Добавить план</button>`;
      html += openTasks.map(taskItem).join("");
    } else if (!doneTasks.length) {
      html += `
        <section class="card">
          <h3>Всё впереди</h3>
          <p>Запишите идею свидания, поездки или общего дела</p>
          <div style="margin-top:12px;">
            <button class="primary full${taskDisabledClass}" type="button" data-action="add-task">Добавить план</button>
          </div>
        </section>
      `;
    } else {
      html += `<button class="primary full add-button${taskDisabledClass}" type="button" data-action="add-task">Добавить план</button>`;
    }
    html += archiveMoreHtml("tasks", (appState.tasks || []).length);
    return html;
  }

  // ------------------------------------------------------------------
  // Даты: «Наши» и «Дни рождения» — один конвейер, два списка
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
            <p>Добавьте день рождения близкого человека — напомним за 3 дня и в сам день</p>
            <div style="margin-top:12px;">
              <button class="primary full${disabledClass}" type="button" data-action="add-birthday">Добавить день рождения</button>
            </div>
          </section>
        `;
      }
      return `
        <button class="primary full add-button${disabledClass}" type="button" data-action="add-birthday">Добавить день рождения</button>
        ${rows.map(birthdayItem).join("")}
        ${archiveMoreHtml("dates", (appState.dates || []).length)}
      `;
    }
    // Порядок приходит отсортированным из /api/state (sortDateRows):
    // повторная сортировка с часовыми поясами на каждое сравнение не нужна.
    return renderListTab(datesOfKind("date"), "add-date", "Добавить дату", "Хочу запомнить", "Добавьте годовщину, день знакомства или важный праздник", dateItem)
      + archiveMoreHtml("dates", (appState.dates || []).length);
  }

  // ------------------------------------------------------------------
  // Дневник: записи и цитаты
  // ------------------------------------------------------------------
  function renderMemoriesBody() {
    if (memoriesView === "quotes") {
      const quotes = mergedArchive("quotes", appState.quotes || []);
      return renderListTab(quotes, "add-quote", "Добавить цитату", "Ни одной цитаты", "Сохраните фразу партнёра, которая зацепила или показалось смешной", quoteItem)
        + archiveMoreHtml("quotes", (appState.quotes || []).length);
    }
    if (memoriesView === "health") {
      // Личный журнал препаратов: загружается один раз, при переключении вида.
      if (!healthState && !healthBusy) loadHealth();
      return renderHealthBody();
    }
    if (memoriesView === "contacts") {
      // Телефонная книга: живёт в пространстве пары, у каждого партнёра свой список.
      if (partnerMissing()) {
        return `<section class="card"><p class="eyebrow">Контакты</p><h3>Пока недоступно</h3><p>Контакты живут в пространстве пары — сначала добавьте партнёра.</p></section>`;
      }
      if (!contactsState && !contactsBusy) loadContacts();
      return renderContactsBody();
    }
    const recentMemories = appState.memories || [];
    return renderListTab(mergedArchive("memories", recentMemories), "add-memory", "Записать", "Воспоминание", "Сохраняйте тёплые воспоминания, к которым хочется возвращаться", memoryItem)
      + archiveMoreHtml("memories", recentMemories.length);
  }

  // ------------------------------------------------------------------
  // Здоровье: личный журнал препаратов (вкладка «Дневник → Здоровье»).
  // Данные строго персональные (tg_id на сервере): партнёр список не видит
  // и не редактирует. Бот напоминает о приёме в заданное время (HH:MM),
  // пока курс активен; отметка приёма — общий итог за день.
  // ------------------------------------------------------------------
  const HEALTH_MED_FORMS = [["tablet", "таблетка"], ["capsule", "капсула"], ["injection", "укол"], ["patch", "пластырь"], ["iud", "спираль"], ["other", "прочее"]];
  const HEALTH_MED_STATUS = [["active", "активен"], ["paused", "пауза"], ["completed", "завершён"]];
  const HEALTH_MED_STATUS_LABELS = Object.fromEntries(HEALTH_MED_STATUS);

  // «Сегодня» зрителя: отметки приёма привязаны к личному дню, не к паре.
  function healthToday() {
    return new Intl.DateTimeFormat("en-CA", { timeZone: viewerTimeZone(), year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
  }

  async function loadHealth(force = false) {
    if (healthBusy || (healthState && !force)) return;
    healthBusy = true;
    try {
      healthState = await request("/api/health/meds");
    } catch (error) {
      healthState = { failed: true };
      handleRequestError(error);
    } finally {
      healthBusy = false;
    }
    render();
  }

  function healthMedLog(medId, date) {
    return (healthState?.med_logs || []).find(l => l.med_id === medId && l.date === date) || null;
  }

  function healthIntakeCounts(medId) {
    const logs = healthState?.med_logs || [];
    return {
      taken: logs.filter(l => l.med_id === medId && l.status === "taken").length,
      skipped: logs.filter(l => l.med_id === medId && l.status === "skipped").length
    };
  }

  // Диалог препарата (добавление/правка) — как в других вкладках: отдельное
  // окно поверх, а не разворачивающийся список. Чистый сборщик тела запроса
  // вынесен отдельно (тестируется без диалога).
  function healthMedDialogFields(m) {
    const f = m || {};
    return `
      <label class="field"><span>Название</span>
        <input name="name" data-fmt="none" type="text" maxlength="120" required value="${esc(f.name || "")}" placeholder="Например, магний">
      </label>
      <div class="flo-actions" style="margin-top:6px">
        <label class="field" style="flex:1"><span>Форма</span>
          <select name="form"><option value="">—</option>${HEALTH_MED_FORMS.map(([c, l]) => `<option value="${c}"${f.form === c ? " selected" : ""}>${esc(l)}</option>`).join("")}</select>
        </label>
        <label class="field" style="flex:1"><span>Статус</span>
          <select name="status">${HEALTH_MED_STATUS.map(([c, l]) => `<option value="${c}"${(f.status || "active") === c ? " selected" : ""}>${esc(l)}</option>`).join("")}</select>
        </label>
      </div>
      <label class="field"><span>Доза (справочно)</span>
        <input name="dosage" data-fmt="none" type="text" maxlength="120" value="${esc(f.dosage || "")}" placeholder="Например, 1 таблетка">
      </label>
      <label class="field"><span>Схема приёма</span>
        <input name="schedule" data-fmt="none" type="text" maxlength="200" value="${esc(f.schedule || "")}" placeholder="Например, 1 раз в день после еды">
      </label>
      <div class="flo-actions" style="margin-top:6px">
        <label class="field" style="flex:1"><span>Начало курса</span>
          <input name="start_date" type="date" required value="${esc(f.start_date || healthToday())}">
        </label>
        <label class="field" style="flex:1"><span>Конец курса</span>
          <input name="end_date" type="date" value="${esc(f.end_date || "")}">
        </label>
      </div>
      <label class="field"><span><input type="checkbox" name="remind_enabled"${f.remind_enabled ? " checked" : ""}> Напоминание в боте</span></label>
      <label class="field"><span>Время напоминания</span>
        <input name="remind_time" type="time" value="${esc(f.remind_time || "09:00")}">
      </label>
      <p class="settings-hint">Бот напомнит о приёме в указанное время, пока курс активен. Отметка о приёме — общий итог за день.</p>
      <label class="field"><span>Комментарий</span>
        <input name="note" data-fmt="none" type="text" maxlength="1000" value="${esc(f.note || "")}">
      </label>
      ${f.id ? `<button type="button" class="secondary is-danger full card-action" data-action="health-med-delete" data-id="${f.id}">Удалить препарат</button>` : ""}
      <p class="flo-disclaimer">Приложение не назначает и не отменяет приём препаратов — здесь только ваш личный журнал. Препараты не видны партнёру</p>`;
  }

  // FormData диалога → тело запроса. Ошибки несут code, чтобы тост показал
  // понятный текст, а диалог остался открытым для правки.
  function healthMedBodyFromForm(fd, id) {
    const name = String(fd.get("name") || "").trim();
    if (!name) {
      const err = new Error("Укажите название препарата");
      err.code = "INVALID_NAME";
      throw err;
    }
    const startDate = String(fd.get("start_date") || "");
    if (!startDate) {
      const err = new Error("Укажите дату начала курса");
      err.code = "INVALID_DATE";
      throw err;
    }
    const remindEnabled = fd.get("remind_enabled") === "on";
    const remindTime = String(fd.get("remind_time") || "");
    if (remindEnabled && !remindTime) {
      const err = new Error("Укажите время напоминания");
      err.code = "INVALID_TIME";
      throw err;
    }
    return {
      name, dosage: String(fd.get("dosage") || "").trim() || null,
      form: String(fd.get("form") || "") || null, schedule: String(fd.get("schedule") || "").trim() || null,
      start_date: startDate, end_date: String(fd.get("end_date") || "") || null,
      status: String(fd.get("status") || "active"), note: String(fd.get("note") || "").trim() || null,
      remind_enabled: remindEnabled, remind_time: remindEnabled ? remindTime : null,
      ...(id ? { id } : {})
    };
  }

  function openHealthMedDialog(m = null) {
    openDialog({
      title: m ? "Изменить препарат" : "Новый препарат",
      submitLabel: m ? "Сохранить" : "Добавить",
      cancelLabel: "Отмена",
      fields: healthMedDialogFields(m),
      onSubmit: async (fd) => {
        const body = healthMedBodyFromForm(fd, m?.id);
        healthState = await request("/api/health/med", { method: "POST", body });
        showToast(body.remind_enabled ? "Препарат сохранён — бот напомнит о приёме" : "Препарат сохранён");
        return appState;
      }
    });
  }

  function renderHealthBody() {
    if (healthState?.failed) {
      return `<section class="card"><p class="eyebrow">Здоровье</p><p>Не получилось загрузить список.</p>
        <button type="button" class="secondary full card-action" data-action="health-retry">Повторить</button></section>`;
    }
    if (!healthState) {
      return `<section class="card"><p class="eyebrow">Здоровье</p><p>Загружаем список…</p></section>`;
    }
    const today = healthToday();
    const meds = healthState.meds || [];
    const rows = meds.map(m => {
      const log = healthMedLog(m.id, today);
      const statusLabel = HEALTH_MED_STATUS_LABELS[m.status] || m.status;
      const { taken, skipped } = healthIntakeCounts(m.id);
      const meta = [m.dosage, m.schedule, m.form ? HEALTH_MED_FORMS.find(([c]) => c === m.form)?.[1] : ""].filter(Boolean).join(" · ");
      const remind = m.remind_enabled && m.remind_time ? `<span class="day-chip">Напоминание ${esc(m.remind_time)}</span>` : "";
      const chips = m.status === "active" ? `
        <div class="flo-chips" style="margin-top:6px">
          <button type="button" class="flo-chip${log?.status === "taken" ? " is-on" : ""}" data-action="health-intake" data-med="${m.id}" data-status="taken">Принят</button>
          <button type="button" class="flo-chip${log?.status === "skipped" ? " is-on" : ""}" data-action="health-intake" data-med="${m.id}" data-status="skipped">Пропущен</button>
          ${log ? `<button type="button" class="flo-chip" data-action="health-intake-clear" data-med="${m.id}">Снять отметку</button>` : ""}
          <button type="button" class="flo-chip${m.remind_enabled ? " is-on" : ""}" data-action="health-remind-toggle" data-med="${m.id}" data-enabled="${!m.remind_enabled}">${m.remind_enabled ? `Напоминание: ${esc(m.remind_time)}` : "Напоминание: выкл"}</button>
        </div>` : "";
      return `<div class="item-row">
        <div class="item-main">
          <p class="item-title">${esc(m.name)}</p>
          <div class="item-meta"><span class="day-chip is-muted">${esc(statusLabel)}</span>${remind}<span>${esc(meta)}</span></div>
          <div class="item-meta"><span>${esc(m.start_date || "")}${m.end_date ? ` — ${esc(m.end_date)}` : ""}</span><span>принято ${taken} · пропущено ${skipped}</span></div>
          ${chips}
        </div>
        <button class="icon-btn" type="button" data-action="health-med-edit" data-id="${m.id}" aria-label="Изменить">${EDIT_ICON}</button>
      </div>`;
    }).join("");
    return `
      <section class="card">
        <h3>Мои препараты</h3>
        <p class="settings-hint">Личный журнал: препараты и приём не видны партнёру. Бот напомнит о приёме в заданное время, пока курс активен</p>
        ${rows || `<p class="flo-disclaimer">Пока нет препаратов</p>`}
        <button type="button" class="primary full card-action" style="margin-top:8px" data-action="health-med-new">Добавить препарат</button>
        <p class="flo-disclaimer">Отметка «принят/пропущен» — общий итог за день, контроль отдельных доз не ведётся. Приложение не назначает лечение</p>
      </section>`;
  }

  async function handleHealthAction(action, btn) {
    const medId = Number(btn.dataset.med || btn.dataset.id);
    if (action === "health-retry") { healthState = null; return render(); }
    if (action === "health-med-new") {
      openHealthMedDialog(null);
      return;
    }
    if (action === "health-med-edit") {
      const m = (healthState?.meds || []).find(x => x.id === medId);
      if (m) openHealthMedDialog(m);
      return;
    }
    if (action === "health-med-delete") {
      const m = (healthState?.meds || []).find(x => x.id === medId);
      if (!m) return;
      dialog.close();
      openDialog({
        title: "Удалить препарат?",
        fields: `<p>«${esc(m.name)}» и история приёма будут удалены.</p>`,
        submitLabel: "Удалить",
        cancelLabel: "Оставить",
        onSubmit: async () => {
          healthState = await request("/api/health/med/delete", { method: "POST", body: { id: m.id } });
          showToast("Препарат и история приёма удалены");
          return appState;
        }
      });
      return;
    }
    if (action === "health-intake" || action === "health-intake-clear") {
      const d = healthToday();
      try {
        if (action === "health-intake-clear") {
          healthState = await request("/api/health/med-log/delete", { method: "POST", body: { med_id: medId, date: d } });
        } else {
          healthState = await request("/api/health/med-log", { method: "POST", body: { med_id: medId, date: d, status: btn.dataset.status } });
        }
      } catch (error) { handleRequestError(error); }
      return render();
    }
    if (action === "health-remind-toggle") {
      const m = (healthState?.meds || []).find(x => x.id === medId);
      if (!m) return;
      if (btn.dataset.enabled === "true" && !m.remind_time) {
        // Включение без времени — открываем диалог: «вкл без времени» на
        // сервере отклоняется, лучше сразу дать ввести время.
        openHealthMedDialog({ ...m, end_date: m.end_date || "", remind_enabled: true });
        showToast("Укажите время напоминания и сохраните");
        return;
      }
      try {
        healthState = await request("/api/health/med", {
          method: "POST",
          body: {
            id: m.id, name: m.name, dosage: m.dosage, form: m.form, schedule: m.schedule,
            start_date: m.start_date, end_date: m.end_date, status: m.status, note: m.note,
            remind_enabled: btn.dataset.enabled === "true", remind_time: m.remind_time
          }
        });
      } catch (error) { handleRequestError(error); }
      return render();
    }
  }

  // ------------------------------------------------------------------
  // Контакты: телефонная книга пары (вкладка «Дневник → Контакты»).
  // У каждого партнёра свой список; списки обоих видны («Мои / Её(Его)»),
  // редактировать можно только свой. Номера — до 3 на контакт, единый
  // формат «+7 ХХХ ХХХ ХХ ХХ», неполные не сохраняются. Тап по имени
  // открывает окно контакта, тап по номеру копирует его в буфер.
  // ------------------------------------------------------------------
  function contactPartnerLabel() {
    return appState.pair?.partner_gender === "female" ? "Её" : "Его";
  }

  // Цифры номера → «ХХХ ХХХ ХХ ХХ» (без префикса +7: он стоит в отдельном
  // префиксе поля, пользователь вводит только 10 цифр).
  function contactsFormatDigits(digits) {
    const d = String(digits || "").replace(/\D/g, "").slice(0, 10);
    return [d.slice(0, 3), d.slice(3, 6), d.slice(6, 8), d.slice(8, 10)].filter(Boolean).join(" ");
  }

  // Читаемая строка номера из любого ввода: «+79151234567», «8915…»,
  // «915 123 45 67» → «+7 915 123 45 67». null — неполный номер.
  function contactsNormalizePhone(raw) {
    let digits = String(raw || "").replace(/\D/g, "");
    if (digits.length === 11 && (digits[0] === "7" || digits[0] === "8")) digits = digits.slice(1);
    if (digits.length !== 10) return null;
    return `+7 ${digits.slice(0, 3)} ${digits.slice(3, 6)} ${digits.slice(6, 8)} ${digits.slice(8, 10)}`;
  }

  async function loadContacts(force = false) {
    if (contactsBusy || (contactsState && !force)) return;
    contactsBusy = true;
    try {
      contactsState = await request("/api/contacts");
    } catch (error) {
      contactsState = { failed: true };
      handleRequestError(error);
    } finally {
      contactsBusy = false;
    }
    render();
  }

  function contactsListFor(isMine) {
    const list = isMine ? (contactsState?.mine || []) : (contactsState?.partner || []);
    // Алфавитный порядок по имени; сервер сортирует тоже, но поиск и локальные
    // мутации держат порядок на клиенте.
    return [...list].sort((a, b) => String(a.name).localeCompare(String(b.name), "ru"));
  }

  // Поиск по имени, фамилии, цифрам номера и комментарию.
  function contactsMatches(contact, query) {
    const q = query.trim().toLowerCase();
    if (!q) return true;
    const qDigits = q.replace(/\D/g, "");
    if (qDigits.length >= 3) {
      const allPhones = (contact.phones || []).join(" ").replace(/\D/g, "");
      if (allPhones.includes(qDigits)) return true;
    }
    return [contact.name, contact.surname, contact.comment]
      .some(field => String(field || "").toLowerCase().includes(q));
  }

  function contactsCurrentList() {
    return contactsListFor(contactsView === "mine").filter(c => contactsMatches(c, contactsSearch));
  }

  function renderContactsList() {
    const list = contactsCurrentList();
    if (!list.length) return "";
    // Одна карточка на контакт: номера группируются под именем, высота
    // карточки растёт с числом номеров. Кнопок в списке нет — тап по имени
    // открывает окно контакта, тап по номеру копирует его.
    return list.map(c => `
      <section class="card contact-card">
        <button class="contact-name" type="button" data-action="contact-open" data-id="${c.id}">
          ${esc(c.name)}${c.surname ? ` <span class="contact-surname">${esc(c.surname)}</span>` : ""}
        </button>
        <div class="contact-phones">
          ${(c.phones || []).map(phone => `
            <button class="contact-phone" type="button" data-action="contacts-copy" data-phone="${esc(phone)}">${esc(phone)}</button>`).join("")}
        </div>
        ${c.comment ? `<p class="contact-comment">${esc(c.comment)}</p>` : ""}
      </section>`).join("");
  }

  function renderContactsBody() {
    if (contactsState?.failed) {
      return `<section class="card"><p class="eyebrow">Контакты</p><h3>Ошибка</h3><p>Не получилось загрузить книгу.</p>
        <button type="button" class="secondary full card-action" data-action="contacts-retry">Повторить</button></section>`;
    }
    if (!contactsState) {
      return `<section class="card"><p class="eyebrow">Контакты</p><h3>Контакты</h3><p>Загружаем книгу…</p></section>`;
    }
    const isMine = contactsView === "mine";
    const hasAny = (contactsState.mine || []).length || (contactsState.partner || []).length;
    const searching = Boolean(contactsSearch.trim());
    const list = contactsCurrentList();
    // Переключатель — сразу под баром «Записи/Цитаты/Здоровье/Контакты».
    const switchHtml = `
      <div class="wish-switch" role="tablist" aria-label="Чьи контакты показывать">
        <button class="wish-switch-btn${isMine ? " is-active" : ""}" type="button" role="tab" aria-selected="${isMine}" data-action="contacts-view" data-view="mine" data-tab="mine">Мои</button>
        <button class="wish-switch-btn${!isMine ? " is-active" : ""}" type="button" role="tab" aria-selected="${!isMine}" data-action="contacts-view" data-view="partner" data-tab="partner">${esc(contactPartnerLabel())}</button>
      </div>`;
    // Кнопка добавления: пока контактов нет — внутри карточки-приглашения
    // (как в других вкладках); после первого контакта — под переключателем.
    const addButton = `<button class="primary full card-action" type="button" data-action="add-contact">Добавить контакт</button>`;
    let bodyHtml;
    if (!(contactsView === "mine" ? contactsState.mine : contactsState.partner).length) {
      bodyHtml = isMine && !searching
        ? `<section class="card"><p class="eyebrow">Контакты</p><h3>Контакт</h3>
            <p>Имена и номера всегда под рукой — и ваши, и партнёрши</p>
            <div style="margin-top:12px;">${addButton}</div>
          </section>`
        : `<section class="card"><p class="eyebrow">Контакты</p><h3>Пока пусто</h3><p>${searching ? `По запросу «${esc(contactsSearch.trim())}» никого не нашлось.` : `${esc(contactPartnerLabel())} контактах пока пусто`}</p></section>`;
    } else {
      bodyHtml = `
        ${isMine ? addButton : ""}
        ${hasAny ? `<label class="field contacts-search"><span>Поиск</span>
          <input id="contacts-search" type="text" data-fmt="none" placeholder="Имя, фамилия, номер или комментарий" value="${esc(contactsSearch)}">
        </label>` : ""}
        <div id="contacts-list">${renderContactsList() || (searching ? `<section class="card"><p class="eyebrow">Контакты</p><h3>Пока пусто</h3><p>По запросу «${esc(contactsSearch.trim())}» никого не нашлось.</p></section>` : "")}</div>`;
    }
    return `${switchHtml}${bodyHtml}`;
  }

  // Строка номера в диалоге: префикс «+7» уже стоит, вводятся только 10 цифр.
  function contactPhoneRowHtml(phone) {
    const digits = String(phone || "").replace(/\D/g, "");
    const trimmed = digits.length === 11 && (digits[0] === "7" || digits[0] === "8") ? digits.slice(1) : digits;
    return `
      <div class="goal-step-row contact-phone-row">
        <span class="contact-phone-prefix" aria-hidden="true">+7</span>
        <input name="phones" data-contact-phone data-fmt="none" inputmode="tel" maxlength="13" placeholder="ХХХ ХХХ ХХ ХХ" value="${esc(contactsFormatDigits(trimmed))}">
        <button class="icon-btn" type="button" data-action="remove-contact-phone" aria-label="Удалить номер" hidden>${DELETE_ICON}</button>
      </div>`;
  }

  function contactPhonesBox() {
    return document.getElementById("contact-phones");
  }

  function syncContactPhoneButtons() {
    const box = contactPhonesBox();
    if (!box) return;
    const rows = Array.from(box.querySelectorAll(".contact-phone-row"));
    for (const row of rows) {
      const del = row.querySelector("[data-action='remove-contact-phone']");
      if (del) del.hidden = rows.length <= 1;
    }
  }

  function addContactPhoneRow() {
    const box = contactPhonesBox();
    if (!box) return;
    if (box.querySelectorAll(".contact-phone-row").length >= 3) {
      showToast("Максимум 3 номера на контакт");
      return;
    }
    const wrap = document.createElement("div");
    wrap.innerHTML = contactPhoneRowHtml("");
    box.appendChild(wrap.firstElementChild);
    syncContactPhoneButtons();
    box.querySelector(".contact-phone-row:last-child input")?.focus();
  }

  function removeContactPhoneRow(btn) {
    const box = contactPhonesBox();
    const row = btn.closest(".contact-phone-row");
    if (!box || !row) return;
    if (box.querySelectorAll(".contact-phone-row").length <= 1) return;
    row.remove();
    syncContactPhoneButtons();
  }

  // Диалог контакта: создание, правка и вариант «имя занято» (warning).
  // warning: undefined — обычный диалог; "proceed" — подтверждение добавления
  // при занятом имени; "block" — оба контакта без комментария: менять имя
  // или добавить комментарий, иначе сервер отклонит (409 NAME_TAKEN).
  function openContactDialog(contact = null, opts = {}) {
    const draft = opts.draft || null;
    const source = contact || draft || {};
    const warning = opts.warning;
    const phones = (source.phones && source.phones.length ? source.phones : [""]);
    const header = warning
      ? `<p class="contact-name-warning">Имя занято. Укажите наводящую информацию в комментарии или измените имя.</p>`
      : "";
    const config = {
      title: warning ? "Имя занято" : (contact ? "Изменить контакт" : "Новый контакт"),
      submitLabel: warning === "proceed" ? "Всё равно добавить" : (contact ? "Сохранить" : "Добавить"),
      cancelLabel: warning ? "Изменить имя" : "Отмена",
      fields: `
        ${header}
        <label class="field"><span>Имя</span><input name="name" data-fmt="none" maxlength="120" required placeholder="Как записать в книге" value="${esc(source.name || "")}"></label>
        <label class="field"><span>Фамилия (необязательно)</span><input name="surname" data-fmt="none" maxlength="120" placeholder="Чтобы не путать однофамильцев" value="${esc(source.surname || "")}"></label>
        <div class="field"><span>Номера — до 3</span>
          <div class="goal-steps" id="contact-phones">
            ${phones.map(p => contactPhoneRowHtml(p)).join("")}
          </div>
        </div>
        <button class="goal-add" type="button" data-action="add-contact-phone" aria-label="Добавить номер">+</button>
        <label class="field"><span>Комментарий (необязательно)</span><textarea name="comment" data-fmt="none" rows="2" maxlength="500" placeholder="Кто это, где знакомы, наводящая информация">${esc(source.comment || "")}</textarea></label>
      `,
      onSubmit: async (fd) => {
        const name = String(fd.get("name") || "").trim();
        const surname = String(fd.get("surname") || "").trim();
        const comment = String(fd.get("comment") || "").trim();
        const digitsList = [...new Set((fd.getAll("phones") || []).map(v => String(v).replace(/\D/g, "")).filter(Boolean))];
        if (!digitsList.length) {
          const err = new Error("Введите хотя бы один номер");
          err.code = "INVALID_PHONES";
          throw err;
        }
        for (const d of digitsList) {
          if (d.length !== 10) {
            const err = new Error("Введите полный номер — 10 цифр после +7, он сохранится как +7 ХХХ ХХХ ХХ ХХ");
            err.code = "INVALID_PHONE";
            throw err;
          }
        }
        const phonesOut = digitsList.map(d => `+7 ${d.slice(0, 3)} ${d.slice(3, 6)} ${d.slice(6, 8)} ${d.slice(8, 10)}`);
        const body = { name, surname: surname || null, comment: comment || null, phones: phonesOut, ...(source.id ? { id: source.id } : {}) };
        if (!warning) {
          const other = (contactsState?.mine || []).find(c => c.id !== source.id && String(c.name || "").trim().toLowerCase() === name.toLowerCase());
          if (other && !other.comment) {
            // Точное совпадение имени: существующий без комментария —
            // предупреждение. С комментарием у нового — можно продолжить,
            // оба пустых — сервер отклонит, диалог требует правку.
            config.chain = () => openContactDialog(null, {
              draft: { name, surname, comment, phones: phonesOut, id: source.id },
              warning: comment ? "proceed" : "block"
            });
            return appState;
          }
          // Существующий с комментарием — пропускаем без предупреждения.
        }
        contactsState = await request("/api/contacts", { method: "POST", body });
        showToast(source.id ? "Контакт сохранён" : "Контакт добавлен");
        return appState;
      }
    };
    openDialog(config);
  }

  // Окно контакта: вся информация, копирование номеров с иконкой, правка
  // и удаление — только для своего списка.
  function openContactInfoDialog(contact) {
    const isMine = Number(contact.owner_id) === Number(appState.user?.tg_id);
    const rows = (contact.phones || []).map(phone => `
      <div class="contact-info-row">
        <button class="contact-phone" type="button" data-action="contacts-copy" data-phone="${esc(phone)}">${esc(phone)}</button>
        <button class="icon-btn" type="button" data-action="contacts-copy" data-phone="${esc(phone)}" aria-label="Скопировать номер">${COPY_ICON}</button>
      </div>`).join("");
    openDialog({
      title: "Контакт",
      submitLabel: null,
      readOnly: true,
      cancelLabel: "Закрыть",
      fields: `
        <p class="contact-info-name">${esc(contact.name)}${contact.surname ? ` <span class="contact-surname">${esc(contact.surname)}</span>` : ""}</p>
        <div class="field"><span>Номера — тап копирует</span>
          <div class="contact-phones">${rows || `<p class="flo-disclaimer">Номеров нет.</p>`}</div>
        </div>
        ${contact.comment ? `<div class="field"><span>Комментарий</span><p class="contact-comment">${esc(contact.comment)}</p></div>` : ""}
        ${isMine ? `
        <button type="button" class="secondary full card-action" data-action="contacts-edit" data-id="${contact.id}">Изменить</button>
        <button type="button" class="secondary is-danger full card-action" data-action="contacts-delete" data-id="${contact.id}">Удалить контакт</button>` : ""}
      `
    });
  }

  function findContactById(id) {
    return [...(contactsState?.mine || []), ...(contactsState?.partner || [])].find(c => Number(c.id) === Number(id)) || null;
  }

  async function handleContactsAction(action, btn) {
    const id = Number(btn.dataset.id);
    if (action === "contacts-retry") { contactsState = null; return render(); }
    if (action === "contacts-copy") {
      const phone = btn.dataset.phone || "";
      if (navigator.clipboard?.writeText) {
        try {
          await navigator.clipboard.writeText(phone);
          showToast("Номер скопирован");
          return;
        } catch (error) { /* фолбэк ниже */ }
      }
      showToast(`Номер: ${phone}`);
      return;
    }
    if (action === "contact-open") {
      const contact = findContactById(id);
      if (contact) openContactInfoDialog(contact);
      return;
    }
    if (action === "contacts-edit") {
      const contact = findContactById(id);
      if (!contact) return;
      dialog.close();
      openContactDialog(contact);
      return;
    }
    if (action === "contacts-delete") {
      const contact = findContactById(id);
      if (!contact) return;
      dialog.close();
      openDialog({
        title: "Удалить контакт?",
        fields: `<p>«${esc(contact.name)}» и все его номера будут удалены.</p>`,
        submitLabel: "Удалить",
        cancelLabel: "Оставить",
        onSubmit: async () => {
          contactsState = await request("/api/contacts/delete", { method: "POST", body: { id: contact.id } });
          showToast("Контакт удалён");
          return appState;
        }
      });
      return;
    }
  }

  // Поиск по книге: перерисовывается только список — фокус в поле поиска
  // не теряется, ввод не прерывается.
  document.addEventListener("input", (e) => {
    const target = e.target;
    if (!(target instanceof HTMLInputElement) || target.id !== "contacts-search") return;
    contactsSearch = target.value;
    const list = document.getElementById("contacts-list");
    if (list) list.innerHTML = renderContactsList();
  });

  // Автор цитаты — select вместо свободного ввода: по запросу выбор
  // ограничен двумя пользователями пространства (имена из pair уже учитывают
  // личное имя партнёра). Пустого варианта «Не указан» нет: автор установлен
  // всегда, по умолчанию это первый партнёр. Старые цитаты с источником-текстом
  // (книга, фильм) при редактировании получают свой источник лишним вариантом —
  // иначе select молча затёр бы его.
  function quoteAuthorOptions(selected) {
    const pair = appState.pair || {};
    const names = [pair.name1, pair.name2].filter((name) => name);
    if (selected && !names.includes(selected)) names.push(selected);
    return names.map((name) => `<option value="${esc(name)}"${name === selected ? " selected" : ""}>${esc(name)}</option>`).join("");
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
          ${itemActions([
            itemActionButton({ action: "edit-item", type: "quotes", id: item.id, label: "Редактировать", icon: EDIT_ICON }),
            itemActionButton({ action: "delete-item", type: "quotes", id: item.id, label: "Удалить", icon: DELETE_ICON })
          ].join("\n            "))}
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
    // timeZone:"UTC": полдень UTC в поясе устройства UTC+13/+14 — уже
    // следующие сутки, и день рождения сдвигался бы на +1.
    return new Intl.DateTimeFormat("ru-RU", { timeZone: "UTC", day: "numeric", month: "long" }).format(value);
  }

  function nextDaysLabel(item) {
    const next = nextOccurrence(item);
    if (!next) return "";
    // Бактеты «Сегодня/Завтра» — по календарю ЗРИТЕЛЯ (как calendarDaysFromNow
    // и dateItem), иначе один экран показывал разные подписи у пары в разных
    // поясах. Абсолютный момент next остаётся якорем в поясе пары.
    const days = calendarDaysFromNow(next);
    // Экстремальная разница поясов (зритель UTC+14, пара UTC-12): ближайшее
    // наступление может оказаться чуть раньше полуночи зрителя — «сегодня».
    if (days <= 0) return "Сегодня";
    if (days === 1) return "Завтра";
    return `Через ${days} ${plural(days, "день", "дня", "дней")}`;
  }

  function birthdayItem(item) {
    const label = nextDaysLabel(item);
    // Тап по карточке открывает календарь на ближайшем наступлении: день
    // рождения ежегодный, сырой item.day увёл бы календарь в год рождения.
    // recurs не читаем: сервер ставит его всем дням рождения, но карточка не
    // должна зависеть от того, доехал ли флаг до старых записей.
    const next = nextOccurrence({ ...item, recurs: 1 });
    // next — абсолютный момент в поясе ПАРЫ: календарный ключ извлекаем в том
    // же поясе, иначе при большой разнице часовых поясов data-day указывал
    // на соседнюю дату и карточка открывала не тот день.
    const targetDay = (next && calendarKeyFromDate(next, pairTimeZone())) || item.day || "";
    return `
      <article class="card birthday-card" role="button" tabindex="0" data-action="show-in-calendar" data-day="${esc(targetDay)}" aria-label="Показать в календаре">
        <div class="item-row">
          <div class="item-main">
            <h3 class="item-title">${renderRichText(item.title)}</h3>
            <div class="item-meta">
              ${item.is_private ? `<span class="day-chip is-private">Личное</span>` : ""}
              <span>${esc(formatBirthday(item.day))}</span>
              ${label ? `<span class="day-chip">${esc(label)}</span>` : ""}
            </div>
          </div>
          ${itemActions([
            itemActionButton({ action: "edit-item", type: "dates", id: item.id, label: "Редактировать", icon: EDIT_ICON }),
            itemActionButton({ action: "delete-item", type: "dates", id: item.id, label: "Удалить", icon: DELETE_ICON })
          ].join("\n            "))}
        </div>
      </article>
    `;
  }

  // ------------------------------------------------------------------
  // Места: список «куда сходить» и «Рандом»
  // ------------------------------------------------------------------

  // Общие помощники «случайного выбора» для мест и кино: флаг первого
  // запуска в localStorage, актуальность выпавшей карточки и колода id.
  function randomFlagUsed(key) {
    try { return localStorage.getItem(key) === "1"; } catch { return false; }
  }
  function markRandomFlagUsed(key) {
    try { localStorage.setItem(key, "1"); } catch {}
  }

  // Текущий выбор, если он ещё актуален: элемент удалён или отмечен
  // с другого устройства — stale, вызывающий сбрасывает pickId.
  function findLivePick(list, pickId, isDone) {
    if (!pickId) return { pick: null, stale: false };
    const item = list.find((entry) => Number(entry.id) === Number(pickId));
    if (!item || isDone(item)) return { pick: null, stale: true };
    return { pick: item, stale: false };
  }

  function shuffleIds(list) {
    for (let i = list.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [list[i], list[j]] = [list[j], list[i]];
    }
    return list;
  }

  // Синхронизация колоды с текущим списком: отмеченные и удалённые элементы
  // выпадают. Новые попадают в начале следующего цикла — дописывать их на ходу
  // нельзя: уже выпавшее снова считалось бы «новым» и повторялось через раз.
  function syncDeckIds(deck, pool) {
    const ids = new Set(pool.map((item) => Number(item.id)));
    return deck.filter((id) => ids.has(id));
  }

  // Колода, а не Math.random() на каждый тап: перемешанный список id, тянем
  // по одному, пока не кончится. Иначе на коротком списке «случайность»
  // возвращала бы одно и то же через раз.
  function shuffledDeck(pool, currentPickId) {
    const deck = shuffleIds(pool.map((item) => Number(item.id)));
    // Не показывать то же место дважды подряд, если есть из чего выбрать.
    if (deck.length > 1 && deck[deck.length - 1] === Number(currentPickId)) {
      [deck[deck.length - 1], deck[0]] = [deck[0], deck[deck.length - 1]];
    }
    return deck;
  }

  function placeList() {
    return mergedArchive("places", appState.places || []);
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
    return randomFlagUsed(PLACE_RANDOM_KEY);
  }
  function markPlaceRandomUsed() {
    markRandomFlagUsed(PLACE_RANDOM_KEY);
  }

  // Текущий выпавший выбор. Если место успели удалить или отметить с другого
  // устройства, карточка тихо снимается — показывать нечего.
  function currentPlacePick() {
    const { pick, stale } = findLivePick(placeList(), placePickId, (place) => Number(place.visited) === 1);
    if (stale) placePickId = null;
    return pick;
  }

  function syncPlaceDeck(pool) {
    placeDeck = syncDeckIds(placeDeck, pool);
    return pool;
  }

  function drawPlace() {
    const pool = syncPlaceDeck(unvisitedPlaces());
    if (!pool.length) {
      placePickId = null;
      return null;
    }
    if (!placeDeck.length) {
      placeDeck = shuffledDeck(pool, placePickId);
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
          <button class="secondary full" type="button" data-action="close-pick">Закрыть</button>
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
          ${itemActions([
            itemActionButton(visited
              ? { action: "place-unvisited", id: place.id, label: "Вернуть в список", icon: REOPEN_ICON }
              : { action: "place-visited", id: place.id, label: "Отметить посещённым", icon: DONE_ICON }),
            ...(place.url ? [itemActionButton({ action: "open-url", url: place.url, label: "Ссылка", icon: LINK_ICON })] : []),
            itemActionButton({ action: "edit-item", type: "places", id: place.id, label: "Редактировать", icon: EDIT_ICON }),
            itemActionButton({ action: "delete-item", type: "places", id: place.id, label: "Удалить", icon: DELETE_ICON })
          ].join("\n            "))}
        </div>
      </article>
    `;
  }

  function renderPlacesBody() {
    const open = unvisitedPlaces();
    const visited = visitedPlaces();
    const total = open.length + visited.length;
    const disabledClass = partnerMissing() ? " is-disabled" : "";
    const pick = currentPlacePick();
    const empty = !total;
    const heroUsed = placeRandomUsed();
    let html = "";
    // Пустой список — как в «Кино»: «Добавить место» живёт в карточке
    // «Пока пусто», а не отдельной кнопкой над списком.
    if (empty) {
      html += `
        <section class="card">
          <h3>Пока пусто</h3>
          <p>Добавьте кафе, парк или другое место, куда давно хотели выбраться</p>
          <button class="primary full card-action${disabledClass}" type="button" data-action="add-place">Добавить место</button>
        </section>
      `;
    }
    // «Рандом» — кнопка внутри карточки-информера до первого запуска на этом
    // устройстве; после первого выбора карточка исчезает, а кнопка
    // возвращается отдельной — под «Добавить место».
    if (!heroUsed) {
      const hint = empty
        ? "Пока нечего выбирать — добавьте первое место"
        : open.length ? "" : "Все места уже посещены — добавьте новое";
      html += `
        <section class="card place-hero">
          <h3>Не знаете, куда пойти?</h3>
          <p>Приложение выберет случайное место из списка. Отметить посещение можно отдельно — уже после того, как сходите</p>
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
    return html + archiveMoreHtml("places", (appState.places || []).length);
  }

  // ------------------------------------------------------------------
  // Путешествия: желанные поездки в дальние города и страны (сегмент
  // вкладки «Места»). Механика та же, что у мест, но без ссылок и рандома.
  // ------------------------------------------------------------------
  function tripList() {
    return mergedArchive("trips", appState.trips || []);
  }

  function openTrips() {
    return tripList().filter((trip) => Number(trip.visited) !== 1);
  }

  function visitedTrips() {
    return tripList().filter((trip) => Number(trip.visited) === 1);
  }

  function tripItem(trip) {
    const visited = Number(trip.visited) === 1;
    return `
      <article class="card${visited ? " place-visited" : ""}">
        <div class="item-row">
          <div class="item-main">
            <h3 class="item-title">${esc(trip.title)}</h3>
            ${trip.note ? `<p class="place-note">${esc(trip.note)}</p>` : ""}
            ${visited ? `<div class="item-meta"><span class="day-chip">${esc(formatTimestamp(trip.visited_at) || "Съездили")}</span></div>` : ""}
          </div>
          ${itemActions([
            itemActionButton(visited
              ? { action: "trip-unvisited", id: trip.id, label: "Вернуть в список", icon: REOPEN_ICON }
              : { action: "trip-visited", id: trip.id, label: "Отметить съездили", icon: DONE_ICON }),
            itemActionButton({ action: "edit-item", type: "trips", id: trip.id, label: "Редактировать", icon: EDIT_ICON }),
            itemActionButton({ action: "delete-item", type: "trips", id: trip.id, label: "Удалить", icon: DELETE_ICON })
          ].join("\n            "))}
        </div>
      </article>
    `;
  }

  function renderTripsBody() {
    const open = openTrips();
    const visited = visitedTrips();
    const total = open.length + visited.length;
    const disabledClass = partnerMissing() ? " is-disabled" : "";
    let html = "";
    if (!total) {
      html += `
        <section class="card">
          <h3>Пока пусто</h3>
          <p>Добавьте город или страну, куда мечтаете съездить вдвоём</p>
          <button class="primary full card-action${disabledClass}" type="button" data-action="add-trip">Добавить поездку</button>
        </section>
      `;
      return html + archiveMoreHtml("trips", (appState.trips || []).length);
    }
    html += `<button class="primary full add-button${disabledClass}" type="button" data-action="add-trip">Добавить поездку</button>`;
    if (open.length) {
      html += `<div class="section-head-inline"><h3>Хотим съездить · ${open.length}</h3></div>`;
      html += open.map((trip) => tripItem(trip)).join("");
    }
    if (visited.length) {
      html += `<div class="section-head-inline"><h3>Съездили · ${visited.length}</h3></div>`;
      html += visited.map((trip) => tripItem(trip)).join("");
    }
    return html + archiveMoreHtml("trips", (appState.trips || []).length);
  }

  // ------------------------------------------------------------------
  // Кино: избранное к просмотру с данными IMDb (сегмент вкладки «Планы»)
  // ------------------------------------------------------------------
  function movieList() {
    return mergedArchive("movies", appState.movies || []);
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
        // Архивная карточка фильма (201+) не входит в /api/state: перекачиваем
        // загруженные страницы, иначе my_rating/pair_rating остались бы старыми.
        revalidateArchiveCache();
        haptic();
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
          ${itemActions([
            itemActionButton(watched
              ? { action: "movie-unwatched", id: movie.id, label: "Вернуть в список", icon: REOPEN_ICON }
              : { action: "movie-watched", id: movie.id, label: "Просмотрено", icon: DONE_ICON }),
            ...(movie.url ? [itemActionButton({ action: "open-url", url: movie.url, label: "Ссылка", icon: LINK_ICON })] : []),
            itemActionButton({ action: "delete-item", type: "movies", id: movie.id, label: "Удалить", icon: DELETE_ICON })
          ].join("\n            "))}
        </div>
        ${watched && movie.my_rating == null ? `<button class="secondary full card-action" type="button" data-action="rate-movie" data-id="${movie.id}">Оценить</button>` : ""}
      </article>
    `;
  }

  // Текущий выпавший фильм. Удалённый или просмотренный с другого устройства
  // тихо снимается с карточки — показывать нечего.
  function currentMoviePick() {
    const { pick, stale } = findLivePick(movieList(), moviePickId, (movie) => Number(movie.watched) === 1);
    if (stale) moviePickId = null;
    return pick;
  }

  // Колода «Кино» — та же механика, что у мест: перемешанный список id
  // без повторов, отмеченное/удалённое выпадает, новое — в следующем цикле.
  function syncMovieDeck(pool) {
    movieDeck = syncDeckIds(movieDeck, pool);
    return pool;
  }

  function drawMovie() {
    const pool = syncMovieDeck(openMovies());
    if (!pool.length) {
      moviePickId = null;
      return null;
    }
    if (!movieDeck.length) {
      movieDeck = shuffledDeck(pool, moviePickId);
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
          <button class="secondary full" type="button" data-action="close-pick">Закрыть</button>
        </div>
      </article>
    `;
  }

  // Hero-карточка кино — информер, как у мест: до первого запуска рандома
  // на этом устройстве (флаг в localStorage), потом не нужна.
  const MOVIE_RANDOM_KEY = "duoplan.movieRandomUsed";
  function movieRandomUsed() {
    return randomFlagUsed(MOVIE_RANDOM_KEY);
  }
  function markMovieRandomUsed() {
    markRandomFlagUsed(MOVIE_RANDOM_KEY);
  }

  // Тело вкладки «Планы» для вида «Кино». «Рандом» живёт в карточке-информере
  // до первого запуска рандома (флаг в localStorage); после — карточка
  // исчезает, и кнопка возвращается отдельной, под «Найти кино».
  // Пустой список: «Найти кино» живёт в карточке «Пока пусто»,
  // карточка «Рандом» — под ней.
  // Сортировка списков «Кино». Выбор живёт отдельно для «В планах» и
  // «Просмотрено»: у просмотренных есть RAofP, у планов — нет.
  // Тип (фильм/сериал) — не критерий сортировки, а отдельный фильтр:
  // пользователь сначала выбирает, что показывать, потом — как сортировать.
  const MOVIE_SORT_OPTIONS = [
    ["added", "По добавлению"],
    ["year", "Год"],
    ["rating", "Оценка IMDb/TMDB"],
    ["runtime", "Длительность"],
    ["genre", "Жанр"]
  ];
  const MOVIE_SORT_DIR = {
    added: "desc", year: "desc", rating: "desc", runtime: "desc", genre: "asc", raofp: "desc"
  };
  const MOVIE_KIND_OPTIONS = [["all", "Все"], ["movie", "Фильмы"], ["series", "Сериалы"]];
  const movieKindFilter = {
    open: "all",
    watched: "all"
  };

  function filterMoviesByKind(list, view) {
    const kind = movieKindFilter[view] || "all";
    if (kind === "all") return list;
    return list.filter((movie) => (movie.kind === "series" ? "series" : "movie") === kind);
  }
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
    const kind = movieKindFilter[view] || "all";
    return `
      <div class="movie-sort">
        <div class="movie-sort-field">
          <select data-action="movie-sort-key" aria-label="Сортировка фильмов">
            ${movieSortOptions(view).map(([key, label]) => `<option value="${key}"${key === state.key ? " selected" : ""}>${esc(label)}</option>`).join("")}
          </select>
          <svg class="movie-sort-chevron" viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m6 9 6 6 6-6"/></svg>
        </div>
        <div class="movie-sort-field is-kind">
          <select data-action="movie-filter-kind" aria-label="Показывать фильмы или сериалы">
            ${MOVIE_KIND_OPTIONS.map(([value, label]) => `<option value="${value}"${value === kind ? " selected" : ""}>${esc(label)}</option>`).join("")}
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

  // Пустой результат фильтра (при непустом списке): подсказка вместо тишины.
  function movieEmptyByKind(view) {
    const kindLabel = movieKindFilter[view] === "series" ? "сериал" : "фильм";
    return `<section class="card"><h3>Пусто</h3><p>Под фильтр ничего не попало — добавьте ${kindLabel} или выберите «Все».</p></section>`;
  }

  function renderMoviesList() {
    if (moviesView === "watched") {
      const all = watchedMovies();
      if (!all.length) {
        return `<section class="card"><h3>Пока ничего не просмотрено</h3><p>Отметьте фильм просмотренным в «В планах» — он появится здесь</p></section>`
          + archiveMoreHtml("movies", (appState.movies || []).length);
      }
      const watched = filterMoviesByKind(all, "watched");
      // Пустой результат фильтра не прячет панель сортировки — иначе
      // пользователь не смог бы вернуться к «Все» без смены вида.
      if (!watched.length) return movieSortBar("watched", 0) + movieEmptyByKind("watched")
        + archiveMoreHtml("movies", (appState.movies || []).length);
      return movieSortBar("watched", watched.length) + sortMovies(watched, "watched").map(movieItem).join("")
        + archiveMoreHtml("movies", (appState.movies || []).length);
    }
    return renderOpenMovies();
  }

  function renderOpenMovies() {
    const all = openMovies();
    // Пустые карточки и кнопки добавления смотрят на полный список — фильтр
    // типа скрывает записи, но не должен прятать «Найти кино» и «Рандом».
    const open = filterMoviesByKind(all, "open");
    const watched = watchedMovies();
    const disabledClass = partnerMissing() ? " is-disabled" : "";
    const pick = currentMoviePick();
    const heroUsed = movieRandomUsed();
    let html = "";
    // Пустой список планов — как в «Кино»: «Найти кино» внутри карточки.
    // Условие — по нефильтрованному all: пустой результат фильтра («только
    // фильмы» при одних сериалах) уже показывает movieEmptyByKind под
    // сортировкой, вторая «Пока пусто» сверху была бы дублем.
    if (!all.length) {
      html += `
        <section class="card">
          <h3>Пока пусто</h3>
          <p>${watched.length
            ? "Все фильмы просмотрены — добавьте новый"
            : "Найдите фильм или сериал в IMDb — он появится здесь с рейтингом, жанром и длительностью"}</p>
          <button class="primary full card-action${disabledClass}" type="button" data-action="add-movie">Найти кино</button>
        </section>
      `;
    }
    // «Рандом» — кнопка внутри карточки-информера до первого запуска на этом
    // устройстве; после первого выбора карточка исчезает, а кнопка
    // возвращается отдельной — под «Найти кино». Подсказка различает
    // «список пуст» и «всё просмотрено», как в «Местах».
    if (!heroUsed) {
      // Пул рандома — нефильтрованный all: фильтр вида не сужает выбор.
      // «Всё просмотрено» — только когда непросмотренных нет вообще.
      const hint = !all.length
        ? (watched.length ? "Всё из списка уже просмотрено — добавьте новое" : "Сначала добавьте фильм или сериал")
        : "";
      html += `
        <section class="card place-hero movie-hero">
          <h3>Не знаете, что посмотреть?</h3>
          <p>Приложение выберет случайный фильм или сериал из избранного. Отметить просмотр можно отдельно — уже после титров</p>
          ${hint ? `<p class="place-count">${hint}</p>` : ""}
          <button class="secondary full card-action${disabledClass}" type="button" data-action="random-movie">Рандом</button>
        </section>
      `;
    }
    if (pick) html += renderMoviePick(pick);
    if (all.length) {
      html += `<button class="primary full add-button${disabledClass}" type="button" data-action="add-movie">Найти кино</button>`;
      if (heroUsed) html += `<button class="secondary full place-random" type="button" data-action="random-movie">Рандом</button>`;
      // На месте прежнего заголовка «Хотим посмотреть» — сортировка списка.
      html += movieSortBar("open", open.length);
      html += open.length
        ? sortMovies(open, "open").map(movieItem).join("")
        : movieEmptyByKind("open");
    }
    return html + archiveMoreHtml("movies", (appState.movies || []).length);
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
            <p>Поделитесь идеями подарков и маленькими мечтами</p>
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
          <p>${partnerLabel === "Её" ? "Она" : "Он"} ещё не добавил${partnerLabel === "Её" ? "а" : ""} желаний в общий список</p>
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
        ${renderSegment("tasks", tasksView, [["plans", "Планы"], ["goals", "Цели"], ["movies", "Кино"]])}
        <div id="tab-body">${tasksView === "movies" ? renderMoviesBody() : tasksView === "goals" ? renderGoalsBody() : renderTasksBody()}</div>
      `;
    } else if (currentTab === "dates") {
      // Шапка одна на оба вида: переключатель меняет только тело, поэтому
      // капля остаётся живой и доезжает пружиной.
      appEl.innerHTML = `
        ${renderTabHeader("dates")}
        ${renderSegment("dates", datesView, [["dates", "Наши"], ["birthdays", "Дни рождения"]])}
        <div id="tab-body">${renderDatesBody()}</div>
      `;
    } else if (currentTab === "places") {
      // Шапка одна на оба вида «Посетить/Путешествие»: переключатель меняет
      // только тело, поэтому капля остаётся живой и доезжает пружиной.
      appEl.innerHTML = `
        ${renderTabHeader("places")}
        ${renderSegment("places", placesView, [["visit", "Посетить"], ["trips", "Путешествие"]])}
        <div id="tab-body">${placesView === "trips" ? renderTripsBody() : renderPlacesBody()}</div>
      `;
    } else if (currentTab === "memories") {
      appEl.innerHTML = `
        ${renderTabHeader("memories")}
        ${renderSegment("memories", memoriesView, [["memories", "Записи"], ["quotes", "Цитаты"], ["health", "Здоровье"], ["contacts", "Контакты"]])}
        <div id="tab-body">${renderMemoriesBody()}</div>
      `;
    } else if (currentTab === "pair") {
      appEl.innerHTML = `
        ${renderTabHeader("pair")}
        ${renderSegment("pair", pairView, [["profile", "Профиль"], ["wishes", "Желания"], ["savings", "Копилка"], ["flo", "Фло"]])}
        <div id="pair-body">${renderPairView()}</div>
      `;
      // Если активных записей больше лимита /api/state, календарь догружает
      // страницы архива в фоне и перерисовывается сам.
      ensureCalendarArchive();
    }
    mountTabSwitch();
    mountWishSwitch();
    mountMovieSwitch();
    mountGoalsSwitch();
    mountPlansSwitch();
    mountFloSwitch();
    mountPinFields();
  }

  // Анимация начисления XP в «Вашей истории»: карточка ритуала уже сменилась,
  // 0.5 с — и над пилюлями личного и общего XP всплывает «+N» в акцентном
  // цвете; секунду спустя оно исчезает и только тогда числа меняются.
  function playXpGainAnimation({ prevUser, prevTogether, newUser, newTogether }) {
    const pills = document.querySelectorAll(".hero-card .stats-row .stat-pill");
    if (pills.length < 3) return;
    const userPill = pills[1];
    const togetherPill = pills[2];
    // До конца анимации держим прежние числа.
    userPill.textContent = `${prevUser} XP`;
    togetherPill.textContent = `Вместе ${prevTogether} XP`;
    const spawn = (pill, delta) => {
      const chip = document.createElement("span");
      chip.className = "xp-gain";
      chip.textContent = `+${delta}`;
      pill.appendChild(chip);
    };
    setTimeout(() => {
      const userDelta = newUser - prevUser;
      const togetherDelta = newTogether - prevTogether;
      if (userDelta > 0) spawn(userPill, userDelta);
      if (togetherDelta > 0) spawn(togetherPill, togetherDelta);
    }, 500);
    setTimeout(() => {
      // Пилюли могли перестроиться (тик, переход) — тогда числа уже актуальны.
      if (userPill.isConnected) userPill.textContent = `${newUser} XP`;
      if (togetherPill.isConnected) togetherPill.textContent = `Вместе ${newTogether} XP`;
      document.querySelectorAll(".hero-card .xp-gain").forEach((chip) => chip.remove());
    }, 1500);
  }

  // ------------------------------------------------------------------
  // Сегмент-переключатели внутри вкладок: та же капля, что в нижней панели
  // ------------------------------------------------------------------
  // Виды («Профиль / Желания», «Наши / Дни рождения», «Записи / Цитаты»,
  // «Мои / Её») — те же вкладки, но внутри страницы. Разметка вкладки
  // перерисовывается целиком, поэтому экземпляры снимаем в начале render() и
  // создаём в конце; переключение вида меняет только тело (#tab-body или
  // #pair-body), и капля доезжает пружиной, как в главном баре.
  let segSwitch = null;      // переключатель вида текущей вкладки
  let wishSwitch = null;     // внутренний «Мои / Её» в желаниях
  let wishSwitchPrevView = null;
  let movieSwitch = null;    // внутренний «В планах / Просмотрено» в кино
  let goalsSwitch = null;    // внутренний «Предстоящие / Выполненные» в целях
  let plansSwitch = null;    // внутренний «Предстоящие / Выполненные» в планах
  let floSwitch = null;      // внутренний бар под-вкладок внутри «Фло»

  function switchValue(key) {
    if (key === "pair") return pairView;
    if (key === "dates") return datesView;
    if (key === "memories") return memoriesView;
    if (key === "tasks") return tasksView;
    if (key === "places") return placesView;
    if (key === "goals") return goalsView;
    if (key === "plans") return plansView;
    return wishView;
  }

  function setSwitchValue(key, value) {
    if (key === "pair") pairView = value;
    else if (key === "dates") datesView = value;
    else if (key === "memories") memoriesView = value;
    else if (key === "tasks") tasksView = value;
    else if (key === "places") placesView = value;
    else if (key === "goals") goalsView = value;
    else if (key === "plans") plansView = value;
    else wishView = value;
  }

  function destroySwitches() {
    if (segSwitch) { segSwitch.destroy(); segSwitch = null; }
    if (wishSwitch) { wishSwitch.destroy(); wishSwitch = null; }
    if (movieSwitch) { movieSwitch.destroy(); movieSwitch = null; }
    if (goalsSwitch) { goalsSwitch.destroy(); goalsSwitch = null; }
    if (plansSwitch) { plansSwitch.destroy(); plansSwitch = null; }
    if (floSwitch) { floSwitch.destroy(); floSwitch = null; }
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

  // Под-бар «Сегодня / Цикл / …» внутри «Фло»: третий уровень капли —
  // живёт в теле #pair-body рядом с переключателем «Профиль/…».
  function mountFloSwitch() {
    if (floSwitch) {
      floSwitch.destroy();
      floSwitch = null;
    }
    const container = document.querySelector('.seg-switch[data-switch="flo"]');
    if (!container || !window.createLiquidNav) return;
    const items = Array.from(container.querySelectorAll("[data-tab]"));
    if (items.length < 2) return;
    const instance = window.createLiquidNav({
      nav: container,
      items,
      idleVar: "--nav-label",
      onCommit: (value) => commitFloView(value)
    });
    if (!instance) return;
    instance.setActive(floView, false);
    floSwitch = instance;
  }

  // Переключение под-вкладки «Фло»: меняем только #flo-body, капля и бар живые.
  function commitFloView(value) {
    if (floView === value) return;
    floView = value;
    const body = document.getElementById("flo-body");
    if (!body) { render(); return; }
    body.innerHTML = renderFloSection();
    floSwitch?.setActive(value, true);
    document.querySelectorAll('.seg-switch[data-switch="flo"] .seg-switch-btn').forEach((btn) => {
      btn.setAttribute("aria-selected", String(btn.dataset.tab === value));
    });
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

  // ------------------------------------------------------------------
  // Цели: задача с описанием и пунктами выполнения (сегмент вкладки
  // «Планы»). Цель выполнена, когда отмечены все её пункты — тогда она
  // переезжает в «Выполненные». Личные цели партнёр не видит вовсе.
  // ------------------------------------------------------------------
  function goalList() {
    return mergedArchive("goals", appState.goals || []);
  }

  function goalCompleted(goal) {
    const items = goal.items || [];
    return items.length > 0 && items.every((item) => Number(item.done) === 1);
  }

  function openGoals() {
    return goalList().filter((goal) => !goalCompleted(goal));
  }

  function completedGoals() {
    return goalList().filter(goalCompleted);
  }

  function goalItemRow(item) {
    const done = Number(item.done) === 1;
    return `
      <div class="goal-item${done ? " is-done" : ""}">
        <button class="goal-item-check" type="button" data-action="${done ? "goal-item-reopen" : "goal-item-done"}" data-id="${item.id}" aria-label="${done ? "Вернуть пункт в работу" : "Отметить пункт выполненным"}">${done ? REOPEN_ICON : DONE_ICON}</button>
        <span class="goal-item-title">${esc(item.title)}</span>
      </div>
    `;
  }

  function goalItem(goal) {
    const items = goal.items || [];
    return `
      <article class="card goal-card">
        <div class="item-row">
          <div class="item-main">
            <h3 class="item-title">${esc(goal.title)}</h3>
            ${Number(goal.is_private) === 1 ? `<div class="item-meta"><span class="day-chip is-muted">Личная</span></div>` : ""}
          </div>
          ${itemActions(itemActionButton({ action: "delete-item", type: "goals", id: goal.id, label: "Удалить цель", icon: DELETE_ICON }))}
        </div>
        <div class="goal-items">
          ${items.map(goalItemRow).join("")}
        </div>
      </article>
    `;
  }

  function renderGoalsList() {
    const disabledClass = partnerMissing() ? " is-disabled" : "";
    if (goalsView === "done") {
      const done = completedGoals();
      if (!done.length) {
        return `<section class="card"><h3>Пока ничего не достигнуто</h3><p>Отметьте все пункты цели — она переедет сюда</p></section>`
          + archiveMoreHtml("goals", (appState.goals || []).length);
      }
      return done.map(goalItem).join("")
        + archiveMoreHtml("goals", (appState.goals || []).length);
    }
    const open = openGoals();
    if (!open.length) {
      return `
        <section class="card">
          <h3>Пока пусто</h3>
          <p>Опишите большую цель и разбейте её на шаги — отмечайте выполненные вместе</p>
          <button class="primary full card-action${disabledClass}" type="button" data-action="add-goal">Создать цель</button>
        </section>
      ` + archiveMoreHtml("goals", (appState.goals || []).length);
    }
    return `<button class="primary full add-button${disabledClass}" type="button" data-action="add-goal">Создать цель</button>`
      + open.map(goalItem).join("")
      + archiveMoreHtml("goals", (appState.goals || []).length);
  }

  function renderGoalsBody() {
    return `
      ${renderSegment("goals", goalsView, [["open", "Предстоящие"], ["done", "Выполненные"]], "is-sub")}
      <div id="goals-body">${renderGoalsList()}</div>
    `;
  }

  // Внутренний бар «Предстоящие / Выполненные»: живёт внутри тела «Цели» —
  // отдельный экземпляр капли, механика та же, что у кино.
  function mountGoalsSwitch() {
    if (goalsSwitch) {
      goalsSwitch.destroy();
      goalsSwitch = null;
    }
    const container = document.querySelector('.seg-switch[data-switch="goals"]');
    if (!container || !window.createLiquidNav) return;
    const items = Array.from(container.querySelectorAll("[data-tab]"));
    if (items.length < 2) return;
    const instance = window.createLiquidNav({
      nav: container,
      items,
      idleVar: "--nav-label",
      onCommit: (value) => commitSwitch("goals", value, instance)
    });
    if (!instance) return;
    instance.setActive(goalsView, false);
    goalsSwitch = instance;
  }

  function mountPlansSwitch() {
    if (plansSwitch) {
      plansSwitch.destroy();
      plansSwitch = null;
    }
    const container = document.querySelector('.seg-switch[data-switch="plans"]');
    if (!container || !window.createLiquidNav) return;
    const items = Array.from(container.querySelectorAll("[data-tab]"));
    if (items.length < 2) return;
    const instance = window.createLiquidNav({
      nav: container,
      items,
      idleVar: "--nav-label",
      onCommit: (value) => commitSwitch("plans", value, instance)
    });
    if (!instance) return;
    instance.setActive(plansView, false);
    plansSwitch = instance;
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

  function setMovieKindFilter(value) {
    if (!MOVIE_KIND_OPTIONS.some(([option]) => option === value)) return;
    if (movieKindFilter[moviesView] === value) return;
    movieKindFilter[moviesView] = value;
    refreshMoviesList();
  }

  // Переключение вида: меняем только тело вкладки, чтобы капля и сам
  // переключатель остались живыми.
  function commitSwitch(key, value, instance) {
    if (switchValue(key) === value) return;
    setSwitchValue(key, value);
    if (key === "goals") {
      // Внутренний бар целей: меняем только список, капля и бар остаются живыми.
      const list = document.getElementById("goals-body");
      if (!list) { render(); return; }
      list.innerHTML = renderGoalsList();
      instance?.setActive(value, true);
      document.querySelectorAll('.seg-switch[data-switch="goals"] .seg-switch-btn').forEach((btn) => {
        btn.setAttribute("aria-selected", String(btn.dataset.tab === value));
      });
      return;
    }
    if (key === "plans") {
      // Внутренний бар планов: меняем только список, капля и бар остаются живыми.
      const list = document.getElementById("plans-body");
      if (!list) { render(); return; }
      list.innerHTML = renderPlansList();
      instance?.setActive(value, true);
      document.querySelectorAll('.seg-switch[data-switch="plans"] .seg-switch-btn').forEach((btn) => {
        btn.setAttribute("aria-selected", String(btn.dataset.tab === value));
      });
      return;
    }
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
    // Бар «Предстоящие / Выполненные» живёт в теле «Цели» — так же.
    if (key === "tasks" && goalsSwitch) {
      goalsSwitch.destroy();
      goalsSwitch = null;
    }
    // И в теле «Планы» — тот же внутренний бар.
    if (key === "tasks" && plansSwitch) {
      plansSwitch.destroy();
      plansSwitch = null;
    }
    // Под-бар «Фло» живёт в теле «Наша пара» — снимаем до замены разметки.
    if (key === "pair" && floSwitch) {
      floSwitch.destroy();
      floSwitch = null;
    }
    body.innerHTML = key === "pair" ? renderPairView()
      : key === "dates" ? renderDatesBody()
        : key === "tasks" ? (tasksView === "movies" ? renderMoviesBody() : tasksView === "goals" ? renderGoalsBody() : renderTasksBody())
          : key === "places" ? (placesView === "trips" ? renderTripsBody() : renderPlacesBody())
            : renderMemoriesBody();
    instance?.setActive(value, true);
    // aria-selected обновляем у всех сегментов, а не только у желаний:
    // капля двигается классами, скринридер читает атрибут.
    document.querySelectorAll(`.seg-switch[data-switch="${key}"] .seg-switch-btn`).forEach((btn) => {
      btn.setAttribute("aria-selected", String(btn.dataset.tab === value));
    });
    if (key === "pair") {
      mountWishSwitch();
      if (pairView === "flo") mountFloSwitch();
    }
    if (key === "tasks" && tasksView === "movies") mountMovieSwitch();
    if (key === "tasks" && tasksView === "goals") mountGoalsSwitch();
    if (key === "tasks" && tasksView === "plans") mountPlansSwitch();
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
    // Нативные фокус-шаги showModal отдают фокус первой кнопке («Закрыть»).
    // Забираем его на контейнер диалога: никакая строка ввода фокус не
    // получает — клавиатура выезжает только по тапу пользователя; визуально
    // фокус на контейнере не рисуется (outline подавлен глобально).
    dialog.focus();
    // Страница за диалогом блокируется от скролла (касания по фону и
    // резиновая прокрутка не двигают контент под окном). Класс на корне:
    // overflow:hidden на body в части WebView не доходил до вьюпорта.
    document.documentElement.classList.add("dialog-locked");
    // Focus trap для старых WebView, которые не поддерживают нативный <dialog> focus.
    const focusables = () => Array.from(dialog.querySelectorAll('button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])')).filter(el => !el.disabled && el.offsetParent !== null);
    // Автофокус убран (репорт 2026-11-05): поле не получает фокус, пока
    // пользователь сам не тапнет по нему — клавиатура не выезжает сама.
    // В цепочках диалогов (confirmLeaveSpace → chain) trap предыдущего окна
    // ещё висит: снимаем, иначе ссылка на него теряется и слушатель копится.
    if (dialog._focusTrap) dialog.removeEventListener("keydown", dialog._focusTrap);
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
    // Guard как в обработчике выше (app.js:19-24): close асинхронен, и в
    // цепочке диалогов (confirmLeaveSpace → chain → openDialog) событие close
    // предыдущего окна прибывало уже ПОСЛЕ открытия следующего — trap нового
    // диалога удалялся, а старый оставался висеть навсегда (репорт 2026-11-10).
    if (dialog.open) return;
    if (dialog._focusTrap) { dialog.removeEventListener("keydown", dialog._focusTrap); dialog._focusTrap = null; }
    // Нативное закрытие возвращает фокус на нажатую кнопку/карточку — в
    // мобильном WebView вокруг неё остаётся синее выделение. Снимаем фокус.
    if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
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
  // Флаг сабмита входа по коду: кнопка живёт вне диалога, dialogSubmitting её
  // не покрывает, а сервер на повторный запрос после успеха отвечает 409.
  let joinSubmitting = false;
  // У планов дата обязательна, если указано время (ограничение API) — такие
  // поля time помечены data-requires-day. У значимых дат дата обязательна
  // всегда, поэтому общий обработчик их не трогает: иначе очистка времени
  // снимала бы required с даты, и форма уходила на сервер без неё.
  dialogFields.addEventListener("input", (e) => {
    const target = e.target;
    if (!(target instanceof HTMLInputElement)) return;
    // Номер контакта: маска «ХХХ ХХХ ХХ ХХ» на 10 цифрах, «+7» стоит префиксом.
    // Легаси-ввод «8 915…» / «+7915…» сворачивается до 10 цифр.
    if (target.hasAttribute("data-contact-phone")) {
      let digits = target.value.replace(/\D/g, "");
      if (digits.length === 11 && (digits[0] === "7" || digits[0] === "8")) digits = digits.slice(1);
      target.value = contactsFormatDigits(digits);
      return;
    }
    const form = target.closest("form");
    // Повторы требуют дату: без неё повторять нечего.
    if (target.hasAttribute("data-requires-day")) {
      const dayInput = form?.querySelector('input[name="day"]');
      if (dayInput) {
        // Дата нужна, если задано время ИЛИ включён любой из повторов.
        // Пересчитываем по состоянию всех трёх полей: target.value у чекбокса
        // всегда "on" (даже когда снят), и снятие галочки «Повторять…» раньше
        // никогда не снимало required — необязательная дата навсегда
        // блокировала сабмит (репорт 2026-11-10).
        const timeInput = form?.querySelector('input[name="time"]');
        const monthly = form?.querySelector('input[name="monthly"]');
        const yearly = form?.querySelector('input[name="yearly"]');
        dayInput.required = Boolean(timeInput?.value) || Boolean(monthly?.checked) || Boolean(yearly?.checked);
      }
    }
    // Ежемесячный и ежегодный повторы взаимоисключающие.
    if (target.type === "checkbox" && target.dataset.excludes) {
      const other = form?.querySelector(`input[name="${target.dataset.excludes}"]`);
      if (other && target.checked) other.checked = false;
    }
  });

  // ------------------------------------------------------------------
  // Живые подсказки IMDb в диалоге «Найти кино»: печатаем название —
  // приходят совпадения; тап по строке сразу добавляет фильм и закрывает
  // диалог. Слушатели вешаются один раз на постоянный #dialog-fields,
  // как input-обработчик выше, поэтому на каждое открытие диалога ничего
  // не накопится.
  // ------------------------------------------------------------------
  // PIN-поля: видимая часть — 4 ячейки (точка или цифра), реальный инпут —
  // невидимый слой поверх (тап открывает цифровую клавиатуру, курсора нет).
  // Нативный плейсхолдер не используем — на мобильных он мигает вместе с
  // вводом, ячейки рисуем сами (модель репорта 2026-11-05):
  //  · поле не активно и пусто  → четыре точки-плейсхолдера;
  //  · поле активировано тапом  → точки пропадают (пустые ячейки);
  //  · введена цифра            → она встаёт на место своей точки, а
  //    предыдущая цифра снова скрывается за точкой; будущие позиции пусты;
  //  · сабмит («Войти»/«Задать») → все ячейки — точки (maskAll).
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

  function renderPinCells(input, maskAll = false) {
    const wrap = document.getElementById(`${input.id}-cells`);
    if (!wrap) return;
    const digits = input.value.replace(/\D/g, "").slice(0, 4);
    if (digits !== input.value) input.value = digits;
    const activated = document.activeElement === input;
    [...wrap.querySelectorAll(".pin-cell")].forEach((cell, index) => {
      let text = "";
      let filled = false;
      if (maskAll || (!digits.length && !activated)) {
        // Маска сабмита или нетронутое поле: точки-плейсхолдеры.
        text = "•";
      } else if (digits.length) {
        // Предыдущие цифры скрыты точками, последняя видна, будущие пусты.
        if (index < digits.length - 1) text = "•";
        else if (index === digits.length - 1) { text = digits[index]; filled = true; }
      }
      cell.textContent = text;
      cell.classList.toggle("is-filled", filled);
    });
  }

  document.addEventListener("input", (e) => {
    const target = e.target;
    if (!(target instanceof HTMLInputElement) || !target.classList.contains("pin-real")) return;
    renderPinCells(target);
  });

  // Активация поля (тап) убирает точки-плейсхолдеры, уход из поля при пустом
  // значении возвращает их. focusout срабатывает до смены activeElement —
  // перерисовываем после того, как фокус действительно сместился.
  document.addEventListener("focusin", (e) => {
    const target = e.target;
    if (!(target instanceof HTMLInputElement) || !target.classList.contains("pin-real")) return;
    renderPinCells(target);
  });
  document.addEventListener("focusout", (e) => {
    const target = e.target;
    if (!(target instanceof HTMLInputElement) || !target.classList.contains("pin-real")) return;
    setTimeout(() => renderPinCells(target), 0);
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

  // Пункты цели в диалоге создания: «+» добавляет строку, крестик удаляет
  // (кроме единственной — цель без пунктов не создаётся, первый input required).
  function goalStepsBox() {
    return document.getElementById("goal-steps");
  }

  function syncGoalStepButtons() {
    const box = goalStepsBox();
    if (!box) return;
    const rows = Array.from(box.querySelectorAll(".goal-step-row"));
    for (const row of rows) {
      const del = row.querySelector("[data-action='remove-goal-step']");
      if (del) del.hidden = rows.length <= 1;
    }
  }

  function addGoalStepRow() {
    const box = goalStepsBox();
    if (!box) return;
    if (box.querySelectorAll(".goal-step-row").length >= 30) {
      showToast("Не больше 30 пунктов на цель");
      return;
    }
    const row = document.createElement("div");
    row.className = "goal-step-row";
    row.innerHTML = `
      <input name="items" data-fmt="** _" maxlength="180" placeholder="Ещё один шаг к цели">
      <button class="icon-btn" type="button" data-action="remove-goal-step" aria-label="Удалить пункт">${DELETE_ICON}</button>
    `;
    box.appendChild(row);
    syncGoalStepButtons();
  }

  function removeGoalStepRow(btn) {
    const box = goalStepsBox();
    const row = btn.closest(".goal-step-row");
    if (!box || !row) return;
    if (box.querySelectorAll(".goal-step-row").length <= 1) return;
    row.remove();
    syncGoalStepButtons();
  }

  dialogFields.addEventListener("click", async (e) => {
    const stepBtn = e.target.closest?.("[data-action='add-goal-step'], [data-action='remove-goal-step']");
    if (stepBtn) {
      if (stepBtn.dataset.action === "add-goal-step") addGoalStepRow();
      else removeGoalStepRow(stepBtn);
      return;
    }
    // Номера контакта: «+» добавляет строку (до 3), крестик удаляет (кроме
    // единственной — контакт без номеров не создаётся).
    const phoneBtn = e.target.closest?.("[data-action='add-contact-phone'], [data-action='remove-contact-phone']");
    if (phoneBtn) {
      if (phoneBtn.dataset.action === "add-contact-phone") addContactPhoneRow();
      else removeContactPhoneRow(phoneBtn);
      return;
    }
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
  // Политика форматирования поля задаётся атрибутом data-fmt: список
  // разрешённых маркеров («** _ __ ~~»), "none" — форматирование выключено
  // (заголовки окон), без атрибута — доступны все кнопки тулбара.
  function allowedFmt(field) {
    const spec = field?.dataset?.fmt;
    if (spec === undefined) return null;
    if (spec === "none") return [];
    return spec.split(/\s+/).filter(Boolean);
  }
  // Показываем только кнопки, разрешённые активному полю; без атрибута — все.
  function syncFmtButtons(field) {
    const allowed = allowedFmt(field);
    for (const btn of fmtToolbar.querySelectorAll("[data-fmt]")) {
      btn.hidden = allowed !== null && !allowed.includes(btn.dataset.fmt);
    }
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
    // Поле без форматирования (data-fmt="none") — меню целиком не показываем.
    const allowed = allowedFmt(el);
    if (allowed !== null && allowed.length === 0) {
      hideFmtToolbar();
      return;
    }
    syncFmtButtons(el);
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
      // Одиночный «>» без пробела — тоже цитированная строка.
      const selected = field.value.slice(start, end);
      const quoted = selected.split("\n")
        .map(line => (line.startsWith("> ") || line === ">") ? line.slice(2) : `> ${line}`)
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
    // btn.hidden держит syncFmtButtons: не разрешённая полю кнопка мертва,
    // даже если тулбар остался висеть от предыдущего поля.
    if (btn && !btn.hidden && isFmtTarget(field)) applyFmtMarker(field, btn.dataset.fmt);
  });
  dialog?.addEventListener("close", hideFmtToolbar);

  // Спойлер в карточках раскрывается тапом (как в Telegram).
  // Сортировка «Кино»: смена критерия или фильтра типа перерисовывает список.
  document.addEventListener("change", (e) => {
    const select = e.target.closest?.('[data-action="movie-sort-key"]');
    if (select) setMovieSortKey(select.value);
    const kindSelect = e.target.closest?.('[data-action="movie-filter-kind"]');
    if (kindSelect) setMovieKindFilter(kindSelect.value);
  });

  document.addEventListener("click", (e) => {
    const spoiler = e.target.closest?.("[data-spoiler]");
    if (!spoiler) return;
    spoiler.classList.toggle("is-revealed");
    // Останавливаем всплытие (обработчик зарегистрирован раньше делегата
    // [data-action]): спойлеры рендерятся внутри карточек-кнопок планов/дат/
    // дневника, и тап по спойлеру одновременно «нажимал» карточку —
    // раскрывал текст и перебрасывал на календарь/открывал диалог
    // (репорт 2026-11-10).
    e.stopImmediatePropagation();
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
      if (["add-task", "add-goal", "add-date", "add-memory", "add-wish", "add-quote", "add-place", "add-trip", "add-movie", "add-saving", "add-birthday", "add-contact"].includes(action) && partnerMissing()) {
        showToast("Сначала добавьте партнёра");
        return;
      }
      if (PARTNER_LOCKED_ACTIONS.has(action) && partnerMissing()) {
        showToast("Партнёра нет в пространстве — изменения недоступны до его возвращения");
        return;
      }
      if (action === "close-dialog") {
        dialog.close();
      } else if (action.startsWith("flo-")) {
        handleFloAction(action, btn);
      } else if (action.startsWith("health-")) {
        // Здоровье — личный журнал: работает и без пары, блокировок нет.
        handleHealthAction(action, btn);
      } else if (action === "add-contact") {
        openContactDialog(null);
      } else if (action === "contacts-view") {
        const view = btn.dataset.view === "partner" ? "partner" : "mine";
        if (view !== contactsView) {
          contactsView = view;
          contactsSearch = "";
          // Капля анимируется на живом экземпляре: перерисовываем только список.
          const body = document.getElementById("tab-body");
          if (body) {
            body.innerHTML = renderContactsBody();
            document.querySelectorAll(".wish-switch-btn[data-tab]").forEach((b) => {
              b.setAttribute("aria-selected", String(b.dataset.tab === contactsView));
            });
          } else {
            render();
          }
        }
      } else if (["contacts-retry", "contact-open", "contacts-copy", "contacts-edit", "contacts-delete"].includes(action)) {
        await handleContactsAction(action, btn);
      } else if (action === "seg-switch") {
        // Переключение вида внутри вкладки: меняем только тело, капля и сам
        // переключатель остаются живыми.
        const key = btn.dataset.switch || "";
        const value = btn.dataset.tab || "";
        if (key === "movies") {
          commitMoviesView(value, movieSwitch);
          return;
        }
        // Внутренние бары идут к своим экземплярам капли: setActive от
        // внешнего segSwitch двигал бы каплю вкладки, а не бара.
        if (key === "goals") {
          commitSwitch("goals", value, goalsSwitch);
          return;
        }
        if (key === "plans") {
          commitSwitch("plans", value, plansSwitch);
          return;
        }
        // Под-вкладки «Фло»: свой экземпляр капли, как у «Кино»/«Целей».
        if (key === "flo") {
          commitFloView(value);
          return;
        }
        if (!["pair", "dates", "memories", "tasks", "places"].includes(key)) return;
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
        // Двойной тап: второй запрос при уже успешном первом отвечал
        // 409 «Вы уже состоите в пространстве» поверх успеха (репорт 2026-11-10).
        if (joinSubmitting) return;
        joinSubmitting = true;
        try {
          const inputId = btn.dataset.input;
          const input = inputId ? document.getElementById(inputId) : null;
          const code = input?.value?.trim() || "";
          appState = await request("/api/pair/join", { method: "POST", body: { code } });
          if (input) input.value = "";
          switchTab("home");
        } finally {
          joinSubmitting = false;
        }
      } else if (action === "add-task") {
        openDialog({
          title: "Новый план",
          fields: `
            <label class="field"><span>Что запланируем?</span><input name="title" data-fmt="none" maxlength="180" required placeholder="Поехать за город на выходных"></label>
            <label class="field"><span>Дата (необязательно)</span><input type="date" name="day"></label>
            <label class="field"><span>Время (необязательно)</span><input type="time" name="time" data-requires-day lang="ru"></label>
            <label class="field"><span><input type="checkbox" name="monthly" data-requires-day data-excludes="yearly"> Повторять каждый месяц</span></label>
            <label class="field"><span><input type="checkbox" name="yearly" data-requires-day data-excludes="monthly"> Повторять каждый год</span></label>
            <label class="field"><span><input type="checkbox" name="is_private"> Личный — видите только вы</span></label>
            ${pairTimeHintHtml()}
          `,
          onSubmit: (fd) => request("/api/tasks", { method: "POST", body: { title: fd.get("title"), day: fd.get("day"), time: fd.get("time"), monthly: fd.get("monthly") === "on", yearly: fd.get("yearly") === "on", is_private: fd.get("is_private") === "on" } })
        });
      } else if (action === "add-goal") {
        // Цель: название + пункты выполнения. Строк одна, «Добавить пункт»
        // добавляет ещё, крестик справа удаляет (syncGoalStepButtons прячет
        // его у единственной строки).
        openDialog({
          title: "Новая цель",
          fields: `
            <label class="field"><span>Что за цель?</span><input name="title" data-fmt="none" maxlength="180" required placeholder="Обменять квартиру на дом у моря"></label>
            <div class="field"><span>Пункты выполнения</span>
              <div class="goal-steps" id="goal-steps">
                <div class="goal-step-row">
                  <input name="items" data-fmt="** _" maxlength="180" required placeholder="Первый шаг к цели">
                  <button class="icon-btn" type="button" data-action="remove-goal-step" aria-label="Удалить пункт" hidden>${DELETE_ICON}</button>
                </div>
              </div>
            </div>
            <button class="goal-add" type="button" data-action="add-goal-step" aria-label="Добавить пункт">+</button>
            <label class="field"><span><input type="checkbox" name="is_private"> Личная — видите только вы</span></label>
          `,
          onSubmit: (fd) => request("/api/goals", {
            method: "POST",
            body: {
              title: fd.get("title"),
              items: fd.getAll("items").map((value) => value.trim()).filter(Boolean),
              is_private: fd.get("is_private") === "on"
            }
          })
        });
      } else if (action === "add-date") {
        openDialog({
          title: "Значимая дата",
          fields: `
            <label class="field"><span>Название</span><input name="title" data-fmt="none" maxlength="120" required placeholder="День нашего знакомства"></label>
            <label class="field"><span>Дата</span><input type="date" name="day" required></label>
            <label class="field"><span>Время (необязательно)</span><input type="time" name="time" lang="ru"></label>
            <label class="field"><span><input type="checkbox" name="monthly" data-excludes="recurs"> Повторять каждый месяц</span></label>
            <label class="field"><span><input type="checkbox" name="recurs" checked data-excludes="monthly"> Повторять каждый год</span></label>
            <label class="field"><span><input type="checkbox" name="is_private"> Личная — видите только вы</span></label>
            ${pairTimeHintHtml()}
          `,
          onSubmit: (fd) => request("/api/dates", { method: "POST", body: { title: fd.get("title"), day: fd.get("day"), time: fd.get("time"), monthly: fd.get("monthly") === "on", recurs: fd.get("recurs") === "on", is_private: fd.get("is_private") === "on" } })
        });
      } else if (action === "add-memory") {
        openDialog({
          title: "Запись в дневник",
          fields: `<label class="field"><span>Заголовок</span><input name="title" data-fmt="none" maxlength="180" required placeholder="Тёплый вечер у реки"></label>
           <label class="field"><span>Воспоминание</span><textarea name="body" rows="4" maxlength="2000" required placeholder="Сегодня был тёплый вечер…"></textarea></label>`,
          onSubmit: (fd) => request("/api/memories", { method: "POST", body: { title: fd.get("title"), body: fd.get("body") } })
        });
      } else if (action === "add-wish") {
        openDialog({
          title: "Новое желание",
          fields: `<label class="field"><span>О чём мечтаете?</span><input name="body" data-fmt="none" maxlength="300" required placeholder="Плёночный фотоаппарат"></label>
           <label class="field"><span>Уточнение (необязательно)</span><textarea name="comment" data-fmt="** _ __ ~~" rows="3" maxlength="500" placeholder="Размер, цвет, где купить или чем можно заменить"></textarea></label>
           <label class="field"><span>Ссылка (необязательно)</span><input name="url" type="url" placeholder="https://example.com"></label>`,
          onSubmit: (fd) => request("/api/wishes", { method: "POST", body: { body: fd.get("body"), comment: fd.get("comment"), url: fd.get("url") } })
        });
      } else if (action === "add-quote") {
        openDialog({
          title: "Новая цитата",
          fields: `
            <label class="field"><span>Цитата</span><textarea name="body" data-fmt="** _" rows="4" maxlength="600" required placeholder="Мы в ответе за тех, кого приручили"></textarea></label>
            <label class="field"><span>Автор</span><select name="source">${quoteAuthorOptions("")}</select></label>
          `,
          onSubmit: (fd) => request("/api/quotes", { method: "POST", body: { body: fd.get("body"), source: fd.get("source") } })
        });
      } else if (action === "add-place") {
        openDialog({
          title: "Новое место",
          fields: `
            <label class="field"><span>Куда сходить?</span><input name="title" data-fmt="none" maxlength="120" required placeholder="Крыша с видом на город"></label>
            <label class="field"><span>Заметка (необязательно)</span><textarea name="note" data-fmt="** _ __" rows="3" maxlength="600" placeholder="Почему хочется именно сюда"></textarea></label>
            <label class="field"><span>Ссылка на карту (необязательно)</span><input name="url" type="url" placeholder="https://maps.example.com/..."></label>
          `,
          onSubmit: (fd) => request("/api/places", { method: "POST", body: { title: fd.get("title"), note: fd.get("note"), url: fd.get("url") } })
        });
      } else if (action === "add-trip") {
        openDialog({
          title: "Новая поездка",
          fields: `
            <label class="field"><span>Куда хотим съездить?</span><input name="title" data-fmt="none" maxlength="120" required placeholder="Байкал, Италия, Владивосток"></label>
            <label class="field"><span>Заметка (необязательно)</span><textarea name="note" data-fmt="** _ __" rows="3" maxlength="600" placeholder="Когда хочется поехать и что посмотреть"></textarea></label>
          `,
          onSubmit: (fd) => request("/api/trips", { method: "POST", body: { title: fd.get("title"), note: fd.get("note") } })
        });
      } else if (action === "add-movie") {
        // Диалог поиска: без кнопки сохранения — фильм добавляется тапом
        // по подсказке (механика в делегированном слушателе dialogFields).
        // readOnly гасит нативный сабмит по Enter — диалог не закрывается.
        openDialog({
          title: "Найти кино",
          submitLabel: null,
          readOnly: true,
          cancelLabel: "Закрыть",
          fields: `
            <label class="field"><span>Название на IMDb</span><input name="q" type="text" data-fmt="none" autocomplete="off" placeholder="Интерстеллар, Дюна, Во все тяжкие…"></label>
            <div class="movie-suggest" aria-live="polite"><p class="movie-suggest-hint">Начните печатать — здесь появятся совпадения с IMDb.</p></div>
          `,
          onSubmit: async () => appState
        });
      } else if (action === "add-saving") {
        openDialog({
          title: "Новая копилка",
          fields: `
            <label class="field"><span>Название</span><input name="title" data-fmt="none" maxlength="120" required placeholder="Поездка на море"></label>
            <label class="field"><span>Сколько нужно накопить</span><input name="target" type="number" inputmode="numeric" min="1" step="1" required placeholder="30000"></label>
            <label class="field"><span>Тип копилки</span><select name="kind">
              <option value="shared">Общая — пополняете вдвоём</option>
              <option value="personal">Личная — видите только вы</option>
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
            <label class="field"><span>Кто именинник?</span><input name="title" data-fmt="none" maxlength="120" required placeholder="Маша"></label>
            <label class="field"><span>Дата рождения</span><input type="date" name="day" required></label>
            <label class="field"><span><input type="checkbox" name="is_private"> Личное — видите только вы</span></label>
          `,
          onSubmit: (fd) => request("/api/dates", { method: "POST", body: { title: fd.get("title"), day: fd.get("day"), kind: "birthday", is_private: fd.get("is_private") === "on" } })
        });
      } else if (action === "daily-done") {
        // Подтверждение: ритуал дня разовый на сутки и необратим — случайный
        // тап по «Выполнено +10 XP» не должен списывать его и начислять XP.
        openDialog({
          title: "Ритуал дня",
          fields: `<p style="margin:2px 0 0;">Отметить ритуал дня выполненным и получить +10 XP? Отменить потом нельзя.</p>`,
          submitLabel: "Да, выполнено",
          cancelLabel: "Отмена",
          onSubmit: async () => {
            // Прежние XP нужны анимации: числа в «Вашей истории» обновляются
            // только после того, как исчез летящий «+10».
            const prevUserPoints = Number(appState?.user?.points || 0);
            const prevTogether = Number(appState?.pair?.together_pts || 0);
            const result = await request("/api/daily/done", { method: "POST", body: {} });
            const awarded = result.awarded !== false;
            // awarded — служебный флаг ответа, в state его нет: оставшийся ключ
            // ломал бы сравнение состояния и давал лишний ре-рендер.
            delete result.awarded;
            appState = result;
            if (awarded) haptic("medium");
            // Серия 7 и каждый следующий месяц — повод для чуть более тёплого
            // тоста: маленькая мотивация без конфетти.
            const streak = Number(appState.user?.streak || 0);
            const milestone = awarded && streak > 0 && (streak === 7 || streak % 30 === 0);
            showToast(!awarded
              ? "Ритуал уже отмечен сегодня"
              : milestone
                ? `Ритуал выполнен +10 XP · Серия: ${streak} дн.!`
                : "Ритуал выполнен +10 XP");
            render();
            if (awarded && currentTab === "home") {
              playXpGainAnimation({
                prevUser: prevUserPoints,
                prevTogether,
                newUser: Number(appState?.user?.points || 0),
                newTogether: Number(appState?.pair?.together_pts || 0)
              });
            }
            return appState;
          }
        });
      } else if (action === "done-item") {
        // Подтверждение в едином стиле: случайный тап по ✓ не завершает запись.
        const typeNames = { tasks: "план", wishes: "желание" };
        const name = typeNames[btn.dataset.type] || "запись";
        const isWish = btn.dataset.type === "wishes";
        const doneItem = findItem(btn.dataset.type, btn.dataset.id);
        openDialog({
          title: isWish ? "Исполнено?" : "Выполнено?",
          fields: `<p style="margin:2px 0 0;">Отметить ${name} как ${isWish ? "исполненное" : "выполненное"}? Запись переедет в завершённые.</p>`,
          submitLabel: isWish ? "Да, исполнено" : "Да, выполнено",
          onSubmit: async () => {
            appState = await request(`/api/${btn.dataset.type}/${btn.dataset.id}/done`, { method: "POST", body: {} });
            haptic();
            showToast(doneItem?.title
              ? `${isWish ? "Исполнено" : "Выполнено"}: «${doneItem.title}»`
              : (isWish ? "Желание исполнено" : "План выполнен"));
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
          haptic();
          if (markVisited) {
            // Показ и подтверждение — разные действия: место уходит в
            // «Посещённые» и больше не участвует в рандоме.
            placePickId = null;
            showToast(place ? `Отмечено: «${place.title}»` : "Отмечено: мы были здесь");
          } else {
            showToast(place ? `«${place.title}» снова в списке` : "Место вернулось в список");
          }
          // Архивные строки (201+) не входят в /api/state — после смены
          // visited перекачиваем загруженные страницы, иначе карточка в
          // кэше осталась бы протухшей (тик не видит изменения state).
          revalidateArchiveCache();
          render();
        } finally {
          btn.disabled = false;
        }
      } else if (action === "trip-visited" || action === "trip-unvisited") {
        const id = btn.dataset.id;
        const markVisited = action === "trip-visited";
        const trip = tripList().find((item) => Number(item.id) === Number(id));
        btn.disabled = true;
        try {
          appState = await request(`/api/trips/${id}/${markVisited ? "visited" : "unvisited"}`, { method: "POST", body: {} });
          haptic();
          showToast(markVisited
            ? (trip ? `Съездили: «${trip.title}»` : "Отмечено: съездили")
            : (trip ? `«${trip.title}» снова в списке` : "Поездка вернулась в список"));
          revalidateArchiveCache();
          render();
        } finally {
          btn.disabled = false;
        }
      } else if (action === "goal-item-done" || action === "goal-item-reopen") {
        const id = btn.dataset.id;
        const markDone = action === "goal-item-done";
        btn.disabled = true;
        try {
          appState = await request(`/api/goal_items/${id}/${markDone ? "done" : "reopen"}`, { method: "POST", body: {} });
          haptic();
          // Отмеченный последним пункт закрывает цель — отдельный акцент.
          let toast = markDone ? "Пункт цели выполнен" : "Пункт возвращён в работу";
          if (markDone) {
            const goal = (appState.goals || []).find((g) => (g.items || []).some((i) => Number(i.id) === Number(id)));
            if (goal && goalCompleted(goal)) toast = `Цель «${goal.title}» выполнена!`;
          }
          showToast(toast);
          revalidateArchiveCache();
          render();
        } finally {
          btn.disabled = false;
        }
      } else if (action === "close-pick") {
        // «Закрыть» на карточке результата рандома: выбор сбрасывается,
        // hero-информер и кнопка «Рандом» остаются как были.
        placePickId = null;
        moviePickId = null;
        render();
      } else if (action === "random-place") {
        if (!drawPlace()) {
          // Пустой список и «всё посещено» — разные ситуации: предлагать
          // «добавьте новое» при нуле мест бессмысленно.
          showToast(placeList().length
            ? "Все места уже посещены — добавьте новое"
            : "Сначала добавьте места");
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
          haptic();
          showToast(movie ? `«${movie.title}» снова в списке` : "Фильм вернулся в список");
          revalidateArchiveCache();
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
          showToast(movieList().length
            ? "Всё из списка уже просмотрено"
            : "Сначала добавьте фильм или сериал");
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
            const amount = Number(fd.get("amount"));
            const state = await request(`/api/savings/${saving.id}/deposit`, {
              method: "POST",
              body: { amount }
            });
            // Пополнение, закрывающее цель, — маленький праздник.
            const filled = Number(saving.collected) + amount >= Number(saving.target);
            haptic(filled ? "medium" : "light");
            // textContent — экранирование не нужно (и esc() показал бы
            // сущности буквально).
            showToast(filled
              ? `Копилка «${saving.title}» заполнена!`
              : `Пополнено на ${formatAmount(amount)}`);
            // collected считает сервер — архивную карточку (201+) освежаем
            // перекачкой загруженных страниц.
            revalidateArchiveCache();
            return state;
          }
        });
      } else if (action === "edit-saving") {
        const saving = savingsList().find((item) => Number(item.id) === Number(btn.dataset.id));
        if (!saving) return;
        openDialog({
          title: "Редактировать копилку",
          fields: `
            <label class="field"><span>Название</span><input name="title" data-fmt="none" maxlength="120" required value="${esc(saving.title)}"></label>
            <label class="field"><span>Сколько нужно накопить</span><input name="target" type="number" inputmode="numeric" min="1" step="1" required value="${esc(saving.target)}"></label>
          `,
          onSubmit: async (fd) => {
            const body = { title: fd.get("title"), target: Number(fd.get("target")) };
            const state = await request(`/api/savings/${saving.id}`, {
              method: "PATCH",
              body
            });
            patchArchiveItem("savings", saving.id, body);
            return state;
          }
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
        // Гонка (репорт 2026-11-10): окно закрывали и открывали другое —
        // история первой копилки вставлялась в диалог второй. Паттерн —
        // как openMovieDetails: захват dialogContext и сверка перед вставкой.
        const context = dialogContext;
        try {
          const data = await request(`/api/savings/${saving.id}/history`);
          if (dialogContext !== context || !dialog.open) return;
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
          if (dialogContext !== context || !dialog.open) return;
          handleRequestError(error);
          dialog.close();
        }
      } else if (action === "delete-item") {
        const typeNames = { tasks: "план", dates: "дату", memories: "запись", wishes: "желание", quotes: "цитату", places: "место", trips: "поездку", goals: "цель", movies: "фильм", savings: "копилку" };
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
            showToast(item?.title ? `Удалено: «${item.title}»` : `Удалено: ${name}`);
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
        const item = findItem(type, id);
        // Двойной тап до ответа получал 409 «уже в этом состоянии» — гасим кнопку.
        btn.disabled = true;
        try {
          appState = await request(`/api/${type}/${id}/reopen`, { method: "POST", body: {} });
        } finally {
          btn.disabled = false;
        }
        showToast(item?.title ? `Возвращено: «${item.title}»` : "Запись возвращена");
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
              <label class="field"><span>Что запланируем?</span><input name="title" data-fmt="none" maxlength="180" required value="${esc(item.title || "")}"></label>
              <label class="field"><span>Дата (необязательно)</span><input type="date" name="day" value="${esc(item.day || "")}"></label>
              <label class="field"><span>Время (необязательно)</span><input type="time" name="time" value="${esc(item.time || "")}" data-requires-day lang="ru"></label>
              <label class="field"><span><input type="checkbox" name="monthly" data-requires-day data-excludes="yearly" ${Number(item.monthly) === 1 ? "checked" : ""}> Повторять каждый месяц</span></label>
              <label class="field"><span><input type="checkbox" name="yearly" data-requires-day data-excludes="monthly" ${Number(item.monthly) !== 1 && item.yearly ? "checked" : ""}> Повторять каждый год</span></label>
              ${ownsPrivacy ? `<label class="field"><span><input type="checkbox" name="is_private" ${item.is_private ? "checked" : ""}> Личный — видите только вы</span></label>` : ""}
              ${pairTimeHintHtml()}
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
                <label class="field"><span>Кто именинник?</span><input name="title" data-fmt="none" maxlength="120" required value="${esc(item.title || "")}"></label>
                <label class="field"><span>Дата рождения</span><input type="date" name="day" required value="${esc(item.day || "")}"></label>
                ${ownsPrivacy ? `<label class="field"><span><input type="checkbox" name="is_private" ${item.is_private ? "checked" : ""}> Личное — видите только вы</span></label>` : ""}
              `,
              onSubmit: async (fd) => {
                const body = { title: fd.get("title"), day: fd.get("day"), is_private: ownsPrivacy ? fd.get("is_private") === "on" : undefined };
                const state = await request(`/api/dates/${id}`, { method: "PATCH", body });
                patchArchiveItem("dates", id, body);
                return state;
              }
            });
            return;
          }
          openDialog({
            title: "Редактировать дату",
            fields: `
              <label class="field"><span>Название</span><input name="title" data-fmt="none" maxlength="120" required value="${esc(item.title || "")}"></label>
              <label class="field"><span>Дата</span><input type="date" name="day" required value="${esc(item.day || "")}"></label>
              <label class="field"><span>Время (необязательно)</span><input type="time" name="time" value="${esc(item.time || "")}" lang="ru"></label>
              <label class="field"><span><input type="checkbox" name="monthly" data-excludes="recurs" ${Number(item.monthly) === 1 ? "checked" : ""}> Повторять каждый месяц</span></label>
              <label class="field"><span><input type="checkbox" name="recurs" data-excludes="monthly" ${Number(item.monthly) === 1 ? "" : item.recurs ? "checked" : ""}> Повторять каждый год</span></label>
              ${ownsPrivacy ? `<label class="field"><span><input type="checkbox" name="is_private" ${item.is_private ? "checked" : ""}> Личная — видите только вы</span></label>` : ""}
              ${pairTimeHintHtml()}
            `,
            onSubmit: async (fd) => {
              const body = { title: fd.get("title"), day: fd.get("day"), time: fd.get("time"), monthly: fd.get("monthly") === "on", recurs: fd.get("recurs") === "on", is_private: ownsPrivacy ? fd.get("is_private") === "on" : undefined };
              const state = await request(`/api/dates/${id}`, { method: "PATCH", body });
              patchArchiveItem("dates", id, body);
              return state;
            }
          });
        } else if (type === "memories") {
          openDialog({
            title: "Редактировать запись",
            fields: `<label class="field"><span>Заголовок</span><input name="title" data-fmt="none" maxlength="180" placeholder="Без заголовка" value="${esc(item.title || "")}"></label>
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
            fields: `<label class="field"><span>О чём мечтаете?</span><input name="body" data-fmt="none" maxlength="300" required value="${esc(item.body || "")}"></label>
           <label class="field"><span>Уточнение (необязательно)</span><textarea name="comment" data-fmt="** _ __ ~~" rows="3" maxlength="500" placeholder="Размер, цвет, где купить или чем можно заменить">${esc(item.comment || "")}</textarea></label>
           <label class="field"><span>Ссылка (необязательно)</span><input name="url" type="url" placeholder="https://example.com" value="${esc(item.url || "")}"></label>`,
            onSubmit: async (fd) => {
              const body = { body: fd.get("body") };
              if (fd.get("comment") !== undefined) body.comment = fd.get("comment");
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
              <label class="field"><span>Цитата</span><textarea name="body" data-fmt="** _" rows="4" maxlength="600" required>${esc(item.body || "")}</textarea></label>
              <label class="field"><span>Автор</span><select name="source">${quoteAuthorOptions(item.source || "")}</select></label>
            `,
            onSubmit: async (fd) => {
              const body = { body: fd.get("body"), source: fd.get("source") };
              const state = await request(`/api/quotes/${id}`, { method: "PATCH", body });
              patchArchiveItem("quotes", id, body);
              return state;
            }
          });
        } else if (type === "places") {
          openDialog({
            title: "Редактировать место",
            fields: `
              <label class="field"><span>Куда сходить?</span><input name="title" data-fmt="none" maxlength="120" required value="${esc(item.title || "")}"></label>
              <label class="field"><span>Заметка (необязательно)</span><textarea name="note" data-fmt="** _ __" rows="3" maxlength="600">${esc(item.note || "")}</textarea></label>
              <label class="field"><span>Ссылка на карту (необязательно)</span><input name="url" type="url" value="${esc(item.url || "")}" placeholder="https://maps.example.com/..."></label>
            `,
            onSubmit: async (fd) => {
              const body = { title: fd.get("title"), note: fd.get("note"), url: fd.get("url") };
              const state = await request(`/api/places/${id}`, { method: "PATCH", body });
              patchArchiveItem("places", id, body);
              return state;
            }
          });
        } else if (type === "trips") {
          openDialog({
            title: "Редактировать поездку",
            fields: `
              <label class="field"><span>Куда хотим съездить?</span><input name="title" data-fmt="none" maxlength="120" required value="${esc(item.title || "")}"></label>
              <label class="field"><span>Заметка (необязательно)</span><textarea name="note" data-fmt="** _ __" rows="3" maxlength="600">${esc(item.note || "")}</textarea></label>
            `,
            onSubmit: async (fd) => {
              const body = { title: fd.get("title"), note: fd.get("note") };
              const state = await request(`/api/trips/${id}`, { method: "PATCH", body });
              patchArchiveItem("trips", id, body);
              return state;
            }
          });
        }
      } else if (action === "open-url") {
        openExternal(btn.dataset.url);
      } else if (action === "open-history") {
        // Окно «Ваша история»: тап по карточке героя. Рекорд серии (best_streak)
        // хранится у каждого партнёра свой; огонёк — в акценте из настроек.
        openDialog({
          title: "Ваша история",
          submitLabel: null,
          readOnly: true,
          cancelLabel: "Закрыть",
          fields: `
            <div class="saving-history">
              <div class="saving-history-row"><span class="saving-history-name">Начало истории</span><span>${esc(formatDay(appState?.pair?.started_at || ""))}</span></div>
              <div class="saving-history-row"><span class="saving-history-name"><span style="color: var(--berry);">${FLAME_ICON}</span> Рекорд серии</span><span>${Number(appState?.user?.best_streak || 0)} дн.</span></div>
            </div>`
        });
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
      } else if (action === "share-wish") {
        // Копирование в буфер: чтение, доступно обоим партнёрам даже без
        // второго в пространстве (в PARTNER_LOCKED_ACTIONS не входит).
        const wish = findItem("wishes", btn.dataset.id);
        if (!wish) return;
        const text = wishShareText(wish);
        let copied = false;
        if (navigator.clipboard?.writeText) {
          try {
            await navigator.clipboard.writeText(text);
            copied = true;
          } catch (error) {
            copied = false;
          }
        }
        if (!copied) {
          // Фолбэк для WebView без async clipboard: скрытая textarea +
          // устаревший execCommand — его поддерживают даже старые движки.
          const area = document.createElement("textarea");
          area.value = text;
          area.setAttribute("readonly", "");
          area.style.position = "fixed";
          area.style.opacity = "0";
          document.body.appendChild(area);
          area.select();
          try {
            copied = document.execCommand("copy");
          } catch (error) {
            copied = false;
          } finally {
            area.remove();
          }
        }
        showToast(copied ? "Скопировано" : "Не удалось скопировать");
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
            weekly_digest_enabled: document.getElementById("weekly-digest-enabled")?.checked ?? false,
            weekly_digest_time: timeOf("weekly-digest-time"),
            weekly_digest_day: document.getElementById("weekly-digest-day")?.value === "mon" ? "mon" : "sun",
            show_avatar: document.getElementById("show-avatar")?.checked ?? true,
            // Пустое поле оставляет текущее имя из Telegram.
            display_name: document.getElementById("display-name-input")?.value?.trim() || null,
            // Пустое поле сбрасывает личное имя партнёра на имя из Telegram.
            partner_name: document.getElementById("partner-name-input")?.value?.trim() || null
          }
        });
        showToast("Настройки сохранены");
        // Переключатель «Отображение аватара» мог включить фото: прогреваем
        // его до перерисовки, чтобы аватар появился сразу, а не поверх буквы.
        await preloadPairAvatars();
        render();
      } else if (action === "set-theme") {
        const value = btn.dataset.theme === "dark" || btn.dataset.theme === "light" ? btn.dataset.theme : "system";
        try { localStorage.setItem(THEME_KEY, value); } catch {}
        applyTheme();
        render();
      } else if (action === "save-pin") {
        const pinInput = document.getElementById("pin-input");
        // Последняя цифра тоже маскируется точкой сразу, до результата.
        if (pinInput) renderPinCells(pinInput, true);
        const value = pinInput?.value?.trim() || "";
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
            <label class="field"><span>Поездки</span><select name="trips">
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
            ${appState?.user?.gender === "female" ? `<label class="field"><span>Фло (месячные и дневник)</span><select name="cycle">
              <option value="" selected>Не выгружать</option>
              <option value="all">Всё</option>
            </select></label>` : ""}
          `,
          onSubmit: async (fd) => {
            const sections = {};
            for (const key of ["plans", "movies", "dates", "birthdays", "places", "trips", "memories", "quotes", "wishes", "cycle"]) {
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

  // Фокус ушёл из поля недавно: между blur и кликом по «Сохранить» тик с
  // render() успевал перерисовать настройки старыми значениями, и клик
  // сохранял их вместо правок (репорт 2026-11-10). Grace 1.5с закрывает окно.
  let lastInputBlur = 0;
  document.addEventListener("focusout", (e) => {
    if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) lastInputBlur = Date.now();
  });
  function isTypingNow() {
    return document.activeElement instanceof HTMLInputElement
      || document.activeElement instanceof HTMLTextAreaElement
      || Date.now() - lastInputBlur < 1500;
  }

  let refreshInProgress = false;
  async function refreshState() {
    if (sessionExpired || refreshInProgress) return;
    if (dialog?.open) return;
    // За PIN-замком сеть не нужна (initApp выходит рано): тик с render()
    // перерисовывал экран блокировки и стирал недобранный PIN (репорт 2026-11-10).
    if (!appUnlocked && storedPin()) return;
    // Пользователь печатает (код приглашения в онбординге) — тик пропускаем
    // целиком, данные придут снова на следующем тике после ухода фокуса.
    if (isTypingNow()) return;
    // Жест по капле в разгаре: перерисовка пересоздала бы переключатель и
    // оборвала движение. Пропускаем тик — данные придут на следующем.
    // Внутренние бары (цели, кино, планы) тоже тащат свою каплю.
    if (liquidNav?.getState?.().dragging || segSwitch?.getState?.().dragging || wishSwitch?.getState?.().dragging
      || goalsSwitch?.getState?.().dragging || movieSwitch?.getState?.().dragging || plansSwitch?.getState?.().dragging) return;
    refreshInProgress = true;
    try {
      const hadPartner = Boolean(appState?.pair?.user_b);
      const next = await request("/api/state");
      // Фокус могли включить, пока запрос летел, — тогда данные не забираем,
      // чтобы не потерять изменение для следующего тика.
      if (isTypingNow()) return;
      // Партнёр зашёл в пространство, пока приложение было открыто —
      // минутный тик заметит это без действия пользователя.
      const gainedPartner = !hadPartner && Boolean(next?.pair?.user_b);
      // Данные не изменились — перерисовка не нужна: она сбрасывает ввод,
      // выделение текста и фокус.
      const unchanged = deepEqual(next, appState);
      appState = next;
      if (gainedPartner) showToast("Партнёр в пространстве!");
      if (unchanged) return;
      // Новое фото (своё или партнёра) прогреваем до перерисовки: иначе оно
      // «доедет» поверх подложки уже в открытом интерфейсе. Для тех же ссылок
      // вызов мгновенный — картинки уже в кэше.
      await preloadPairAvatars();
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
      // Пока на экране «Открываем ваше пространство…», прогреваем аватары:
      // фото — в память WebView, буквы и акценты — в слоты пилюли. Пилюля
      // показывается уже готовой, без мерцания подложки под фото.
      await preloadPairAvatars();
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
          // Перезапуск нужен и в обычном браузере (там initData пуст): клик с
          // preventDefault без reload молча умирал (репорт 2026-11-10).
          location.reload();
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
