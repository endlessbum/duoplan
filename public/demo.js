// Живое демо на лендинге (public/index.html): уменьшенная копия Mini App.
// Разметка карточек и навигации скопирована из public/app.html/app.js/app.css,
// «жидкая» капля — настоящий public/nav.js (createLiquidNav). Переключение
// сегментов обновляет только тело вкладки и анимирует каплю — как
// commitSwitch() в app.js; переходы между вкладками мгновенные.
// Ритуал дня считает dailyAction() из worker.js (список и хеш — дословно).
(function () {
  "use strict";

  // Дословно из worker.js (DAILY_ACTIONS + dailyAction).
  const DAILY_ACTIONS = [
    "Выделите 15 минут только друг для друга — без телефонов и дел",
    "Назовите друг другу три вещи, за которые вы благодарны этой неделе",
    "Запланируйте маленькое совместное удовольствие на ближайшие выходные",
    "Поделитесь воспоминанием, к которому хочется возвращаться",
    "Сделайте друг другу неожиданный комплимент — конкретный и честный",
    "Выберите общее дело и сделайте первый маленький шаг вместе",
    "Устройте мини-свидание: чай, прогулка или любимый фильм",
    "Отправьте партнёру пять эмодзи, которые описывают ваш день, — пусть угадает"
  ];

  function dailyAction(pairId, day) {
    let seed = 0;
    for (const char of `${pairId}:${day}`) seed = (seed * 31 + char.charCodeAt(0)) >>> 0;
    return DAILY_ACTIONS[seed % DAILY_ACTIONS.length];
  }

  const DEMO_PAIR_ID = 7;

  const pad = (n) => String(n).padStart(2, "0");
  const dayKey = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  const fmtDM = (d) => `${pad(d.getDate())}.${pad(d.getMonth() + 1)}`;
  const WEEKDAYS = ["Вс", "Пн", "Вт", "Ср", "Чт", "Пт", "Сб"];
  const fmtShort = (d) => `${WEEKDAYS[d.getDay()]}, ${fmtDM(d)}`;
  const plural = (n, one, few, many) => {
    const m10 = n % 10, m100 = n % 100;
    if (m10 === 1 && m100 !== 11) return one;
    if (m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14)) return few;
    return many;
  };

  const todayMidnight = () => {
    const t = new Date();
    return new Date(t.getFullYear(), t.getMonth(), t.getDate());
  };
  const offsetDate = (n) => {
    const t = todayMidnight();
    return new Date(t.getFullYear(), t.getMonth(), t.getDate() + n);
  };
  function nextSaturday() {
    const t = new Date();
    return offsetDate((6 - t.getDay() + 7) % 7 || 7);
  }
  const saturday = nextSaturday();
  function daysUntil(month, day) {
    const t = todayMidnight();
    const d = new Date(t.getFullYear(), month - 1, day);
    if (d.getTime() < t.getTime()) d.setFullYear(d.getFullYear() + 1);
    return Math.round((d.getTime() - t.getTime()) / 86400000);
  }
  // Подпись отсчёта — как nextDaysLabel()/dateItem в app.js.
  const nextLabel = (n) =>
    n <= 0 ? "Сегодня" : n === 1 ? "Завтра" : `Через ${n} ${plural(n, "день", "дня", "дней")}`;
  const untilDays = (month, day) => nextLabel(daysUntil(month, day));

  // Иконки — дословно из app.js.
  const DONE_ICON = '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m5 12.5 4.5 4.5L19 7.5"/></svg>';
  const EDIT_ICON = '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 20h4.5L19.5 9a2.1 2.1 0 0 0-3-3L5.5 17 4 20Z"/><path d="M13.5 7.5 16.5 10.5"/></svg>';
  const DELETE_ICON = '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" aria-hidden="true"><path d="m6.5 6.5 11 11M17.5 6.5l-11 11"/></svg>';
  const REOPEN_ICON = '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 10a8 8 0 1 1 2 6"/><path d="M4 4v6h6"/></svg>';
  const FLAME_ICON = '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 3c1.2 3-2.6 4.6-2.6 7.6a3.6 3.6 0 0 0 3.7 3.5c1.8-.1 2.9-1.7 2.6-3.8 1.9 1.5 3.1 3.6 3.1 5.8A6.8 6.8 0 0 1 5.2 15C5.2 9.4 10.4 8 12 3Z"/></svg>';
  // Остальные иконки действий — дословно из app.js.
  const COPY_ICON = '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="9" y="9" width="12" height="12" rx="2.2"/><path d="M5.5 15H4.8A1.8 1.8 0 0 1 3 13.2V4.8A1.8 1.8 0 0 1 4.8 3h8.4A1.8 1.8 0 0 1 15 4.8v.7"/></svg>';
  const PLUS_ICON = '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" aria-hidden="true"><path d="M12 5.5v13M5.5 12h13"/></svg>';
  const STAR_ICON = '<svg viewBox="0 0 24 24" width="10" height="10" fill="currentColor" stroke="none" aria-hidden="true"><path d="m12 3 2.55 5.18 5.72.83-4.14 4.03.98 5.7L12 16.45l-5.11 2.69.98-5.7-4.14-4.03 5.72-.83L12 3Z"/></svg>';
  const CHEVRON_LEFT = '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m14.5 6.5-5.5 5.5 5.5 5.5"/></svg>';
  const CHEVRON_RIGHT = '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m9.5 6.5 5.5 5.5-5.5 5.5"/></svg>';
  const MOVIE_CHEVRON = '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m6 9 6 6 6-6"/></svg>';

  // itemActionButton/itemActions — дословно из app.js.
  function itemActionButton(opts) {
    const { action, type, id, label, icon } = opts;
    const typeAttr = type !== undefined ? ` data-type="${type}"` : "";
    const idAttr = id !== undefined ? ` data-id="${id}"` : "";
    return `<button class="icon-btn" type="button" data-action="${action}"${typeAttr}${idAttr} aria-label="${label}">${icon}</button>`;
  }
  const itemActions = (buttons) => (buttons ? `<div class="item-actions">${buttons}</div>` : "");
  const editDelete = (type, id) => itemActions([
    itemActionButton({ action: "edit-item", type, id, label: "Редактировать", icon: EDIT_ICON }),
    itemActionButton({ action: "delete-item", type, id, label: "Удалить", icon: DELETE_ICON })
  ].join("\n            "));

  // ------------------------------------------------------------------
  // Карточки — структура скопирована из app.js.
  // ------------------------------------------------------------------
  function taskCard(t) {
    const whenText = t.isPrivate
      ? `<div class="item-when-line"><span class="day-chip is-private">Личное</span><span>${t.when}${t.time ? ` · ${t.time}` : ""}</span></div>`
      : `<span>${t.when}${t.time ? ` · ${t.time}` : ""}</span>`;
    return `
      <article class="card">
        <div class="item-row">
          <div class="item-main">
            <h3 class="item-title">${t.title}</h3>
            <div class="item-meta">
              <div class="item-when">
                ${whenText}
                <div class="item-when-row"><span class="day-chip${t.chipClass || ""}">${t.chip}</span></div>
              </div>
            </div>
          </div>
          ${itemActions([
            itemActionButton({ action: "done-item", type: "tasks", id: t.id, label: "Выполнено", icon: DONE_ICON }),
            itemActionButton({ action: "edit-item", type: "tasks", id: t.id, label: "Редактировать", icon: EDIT_ICON }),
            itemActionButton({ action: "delete-item", type: "tasks", id: t.id, label: "Удалить", icon: DELETE_ICON })
          ].join("\n            "))}
        </div>
      </article>`;
  }

  function doneTaskCard(t) {
    return `
      <article class="card" style="opacity:0.72;">
        <div class="item-row">
          <div class="item-main">
            <h3 class="item-title" style="text-decoration:line-through;">${t.title}</h3>
            <div class="item-meta"><span class="day-chip is-muted">${t.meta}</span></div>
          </div>
          ${itemActions([
            itemActionButton({ action: "reopen-item", type: "tasks", id: t.id, label: "Вернуть в планы", icon: REOPEN_ICON }),
            itemActionButton({ action: "edit-item", type: "tasks", id: t.id, label: "Редактировать", icon: EDIT_ICON }),
            itemActionButton({ action: "delete-item", type: "tasks", id: t.id, label: "Удалить", icon: DELETE_ICON })
          ].join("\n            "))}
        </div>
      </article>`;
  }

  function dateCard(d) {
    const whenText = d.isPrivate
      ? `<div class="item-when-line"><span class="day-chip is-private">Личное</span><span>${d.when}</span></div>`
      : `<span>${d.when}</span>`;
    return `
      <article class="card">
        <div class="item-row">
          <div class="item-main">
            <h3 class="item-title">${d.title}</h3>
            <div class="item-meta">
              <div class="item-when">
                ${whenText}
                <div class="item-when-row"><span class="day-chip${d.chipClass || ""}">${d.chip}</span></div>
              </div>
            </div>
          </div>
          ${editDelete("dates", d.id)}
        </div>
      </article>`;
  }

  function birthdayCard(b) {
    return `
      <article class="card birthday-card">
        <div class="item-row">
          <div class="item-main">
            <h3 class="item-title">${b.title}</h3>
            <div class="item-meta">
              ${b.isPrivate ? `<span class="day-chip is-private">Личное</span>` : ""}
              <span>${b.when}</span>
              <span class="day-chip">${b.chip}</span>
            </div>
          </div>
          ${editDelete("dates", b.id)}
        </div>
      </article>`;
  }

  function memoryCard(m) {
    return `
      <article class="card memory-card">
        <div class="item-row">
          <div class="item-main">
            ${m.title ? `<h3 class="item-title">${m.title}</h3>` : ""}
            <p class="memory-body">${m.body}</p>
            <div class="item-meta">
              <span class="memory-author">${m.author}</span>
              <span>· ${m.date}</span>
            </div>
          </div>
          ${editDelete("memories", m.id)}
        </div>
      </article>`;
  }

  function quoteCard(q) {
    return `
      <article class="card quote-card">
        <span class="quote-mark" aria-hidden="true">&ldquo;</span>
        <p class="quote-text">${q.text}</p>
        ${q.source ? `<p class="quote-source">— ${q.source}</p>` : ""}
        <div class="item-row">
          <div class="item-main"><div class="item-meta"><span>${q.date}</span></div></div>
          ${editDelete("quotes", q.id)}
        </div>
      </article>`;
  }

  function placeCard(p) {
    const visited = p.visited === true;
    return `
      <article class="card${visited ? " place-visited" : ""}">
        <div class="item-row">
          <div class="item-main">
            <h3 class="item-title">${p.title}</h3>
            ${p.note ? `<p class="place-note">${p.note}</p>` : ""}
            ${visited ? `<div class="item-meta"><span class="day-chip">${p.visitedAt || "Посещено"}</span></div>` : ""}
          </div>
          ${itemActions([
            itemActionButton(visited
              ? { action: "place-unvisited", id: p.id, label: "Вернуть в список", icon: REOPEN_ICON }
              : { action: "place-visited", id: p.id, label: "Отметить посещённым", icon: DONE_ICON }),
            itemActionButton({ action: "edit-item", type: "places", id: p.id, label: "Редактировать", icon: EDIT_ICON }),
            itemActionButton({ action: "delete-item", type: "places", id: p.id, label: "Удалить", icon: DELETE_ICON })
          ].join("\n            "))}
        </div>
      </article>`;
  }

  function tripCard(t) {
    const visited = t.visited === true;
    return `
      <article class="card${visited ? " place-visited" : ""}">
        <div class="item-row">
          <div class="item-main">
            <h3 class="item-title">${t.title}</h3>
            ${t.note ? `<p class="place-note">${t.note}</p>` : ""}
            ${visited ? `<div class="item-meta"><span class="day-chip">${t.visitedAt || "Съездили"}</span></div>` : ""}
          </div>
          ${itemActions([
            itemActionButton(visited
              ? { action: "trip-unvisited", id: t.id, label: "Вернуть в список", icon: REOPEN_ICON }
              : { action: "trip-visited", id: t.id, label: "Отметить съездили", icon: DONE_ICON }),
            itemActionButton({ action: "edit-item", type: "trips", id: t.id, label: "Редактировать", icon: EDIT_ICON }),
            itemActionButton({ action: "delete-item", type: "trips", id: t.id, label: "Удалить", icon: DELETE_ICON })
          ].join("\n            "))}
        </div>
      </article>`;
  }

  function goalCard(g) {
    return `
      <article class="card goal-card">
        <div class="item-row">
          <div class="item-main">
            <h3 class="item-title">${g.title}</h3>
            ${g.isPrivate ? `<div class="item-meta"><span class="day-chip is-muted">Личная</span></div>` : ""}
          </div>
          ${itemActions(itemActionButton({ action: "delete-item", type: "goals", id: g.id, label: "Удалить цель", icon: DELETE_ICON }))}
        </div>
        <div class="goal-items">
          ${g.items.map((it) => `
            <div class="goal-item${it.done ? " is-done" : ""}">
              <button class="goal-item-check" type="button" data-action="${it.done ? "goal-item-reopen" : "goal-item-done"}" data-id="${it.id}" aria-label="${it.done ? "Вернуть пункт в работу" : "Отметить пункт выполненным"}">${it.done ? REOPEN_ICON : DONE_ICON}</button>
              <span class="goal-item-title">${it.title}</span>
            </div>`).join("")}
        </div>
      </article>`;
  }

  // Пилюли оценок — порты scorePill/ratingPill/raofpPill из app.js.
  function scorePill(label, rating) {
    const r = Number(rating);
    if (!Number.isFinite(r) || r <= 0) return `<span class="day-chip is-rating-gray">${label} —</span>`;
    const cls = r < 4 ? "is-rating-gray" : r < 6 ? "is-rating-red" : r < 8 ? "is-rating-yellow" : "is-rating-green";
    return `<span class="day-chip ${cls}">${label} ${r.toFixed(1)}</span>`;
  }
  const ratingPill = (rating) => scorePill("IMDb", rating);
  const raofpPill = (m) => scorePill("RAofP", m.pair_rating);

  function movieCard(m) {
    const watched = m.watched === true;
    return `
      <article class="card movie-card${watched ? " movie-watched" : ""}">
        <div class="item-row">
          <div class="item-main">
            <h3 class="item-title">${m.title}</h3>
            ${m.genre || m.year ? `<div class="item-meta">${m.genre ? `<span class="day-chip is-muted">${m.genre}</span>` : ""}${m.year ? `<span class="day-chip is-muted">${m.year}</span>` : ""}</div>` : ""}
            <div class="item-meta">
              ${ratingPill(m.rating)}
              ${m.length ? `<span>${m.length}</span>` : ""}
            </div>
            ${watched ? `<div class="item-meta">${raofpPill(m)}</div>` : ""}
            ${watched ? `<div class="item-meta"><span class="day-chip">${m.watchedAt || "Просмотрено"}</span></div>` : ""}
          </div>
          ${itemActions([
            itemActionButton(watched
              ? { action: "movie-unwatched", id: m.id, label: "Вернуть в список", icon: REOPEN_ICON }
              : { action: "movie-watched", id: m.id, label: "Просмотрено", icon: DONE_ICON }),
            itemActionButton({ action: "delete-item", type: "movies", id: m.id, label: "Удалить", icon: DELETE_ICON })
          ].join("\n            "))}
        </div>
        ${watched && m.my_rating == null ? `<button class="secondary full card-action" type="button">Оценить</button>` : ""}
      </article>`;
  }

  function medCard(m) {
    return `
      <article class="card">
        <div class="item-row">
          <div class="item-main">
            <h3 class="item-title">${m.name}</h3>
            <div class="item-meta">
              <span class="day-chip is-muted">${m.form}</span>
              <span>${m.dosage}</span>
            </div>
            <div class="item-meta"><span>${m.schedule}</span></div>
          </div>
          ${itemActions(itemActionButton({ action: "edit-item", type: "health_meds", id: m.id, label: "Редактировать", icon: EDIT_ICON }))}
        </div>
        <button class="primary full card-action" type="button">Принять · +отметка</button>
      </article>`;
  }

  function contactCard(c) {
    return `
      <article class="card">
        <div class="item-row">
          <div class="item-main">
            <h3 class="item-title">${c.name}</h3>
            <div class="item-meta">${c.phones.map((p) => `<span class="day-chip is-muted">${p}</span>`).join("")}</div>
          </div>
          ${editDelete("contacts", c.id)}
        </div>
      </article>`;
  }

  // wishItem/completedWishItem/savingItem — порты из app.js (вкладка «Пара»).
  function wishItem(w) {
    const canEdit = w.mine !== false;
    const actions = [
      itemActionButton({ action: "share-wish", type: "wishes", id: w.id, label: "Скопировать название и ссылку", icon: COPY_ICON }),
      ...(canEdit ? [
        itemActionButton({ action: "done-item", type: "wishes", id: w.id, label: "Исполнено", icon: DONE_ICON }),
        itemActionButton({ action: "edit-item", type: "wishes", id: w.id, label: "Редактировать", icon: EDIT_ICON }),
        itemActionButton({ action: "delete-item", type: "wishes", id: w.id, label: "Удалить", icon: DELETE_ICON })
      ] : [])
    ].join("\n      ");
    return `
      <article class="card">
        <div class="item-row">
          <div class="item-main">
            <h3 class="item-title">${w.body}</h3>
            ${w.comment ? `<div class="wish-comment">${w.comment}</div>` : ""}
          </div>
          ${itemActions(actions)}
        </div>
        ${w.url ? `<button class="secondary full card-action" type="button">Ссылка</button>` : ""}
      </article>`;
  }

  function completedWishItem(w) {
    const canEdit = w.mine !== false;
    const actions = canEdit ? [
      itemActionButton({ action: "reopen-item", type: "wishes", id: w.id, label: "Вернуть в желания", icon: REOPEN_ICON }),
      itemActionButton({ action: "edit-item", type: "wishes", id: w.id, label: "Редактировать", icon: EDIT_ICON }),
      itemActionButton({ action: "delete-item", type: "wishes", id: w.id, label: "Удалить", icon: DELETE_ICON })
    ].join("\n      ") : "";
    return `
      <article class="card" style="opacity:0.72;">
        <div class="item-row">
          <div class="item-main">
            <h3 class="item-title" style="text-decoration:line-through;">${w.body}</h3>
            ${w.comment ? `<div class="wish-comment">${w.comment}</div>` : ""}
            <div class="item-meta"><span class="day-chip is-muted">${w.created}</span><span class="day-chip">${w.doneAt}</span></div>
          </div>
          ${itemActions(actions)}
        </div>
        ${w.url ? `<button class="secondary full card-action" type="button">Ссылка</button>` : ""}
      </article>`;
  }

  const formatAmount = (n) => new Intl.NumberFormat("ru-RU").format(Number(n) || 0);
  const savingIsFull = (s) => Number(s.collected) >= Number(s.target);

  function savingItem(s) {
    const full = savingIsFull(s);
    const percent = Number(s.target) > 0 ? Math.min(100, Math.round((Number(s.collected) / Number(s.target)) * 100)) : 0;
    const actions = full
      ? itemActionButton({ action: "delete-item", type: "savings", id: s.id, label: "Удалить", icon: DELETE_ICON })
      : [
          itemActionButton({ action: "deposit-saving", id: s.id, label: "Пополнить", icon: PLUS_ICON }),
          itemActionButton({ action: "edit-saving", id: s.id, label: "Редактировать", icon: EDIT_ICON }),
          itemActionButton({ action: "delete-item", type: "savings", id: s.id, label: "Удалить", icon: DELETE_ICON })
        ].join("\n        ");
    return `
      <article class="card${full ? " saving-full" : ""}" role="button" tabindex="0"
        aria-label="История пополнений копилки «${s.title}»">
        <div class="item-row">
          <div class="item-main">
            <h3 class="item-title">${s.title}</h3>
            <div class="item-meta">
              ${s.kind === "shared" ? "" : `<span class="day-chip is-muted">Личная</span>`}
              <span>${formatAmount(s.collected)} из ${formatAmount(s.target)}</span>
            </div>
            <div class="saving-progress" aria-hidden="true"><i style="width:${percent}%"></i></div>
          </div>
          ${itemActions(actions)}
        </div>
      </article>`;
  }

  // ------------------------------------------------------------------
  // Сегмент-переключатели — разметка renderSegment() из app.js.
  // ------------------------------------------------------------------
  function segSwitch(key, value, options, extraClass = "") {
    const dense = options.length >= 4 ? " is-dense" : "";
    return `
      <div class="seg-switch${dense}${extraClass ? ` ${extraClass}` : ""}" data-switch="${key}" role="tablist">
        ${options.map(([id, label]) => `
          <button class="seg-switch-btn${id === value ? " is-active" : ""}" type="button" role="tab"
            aria-selected="${id === value}" data-tab="${id}">${label}</button>
        `).join("")}
      </div>`;
  }

  const TAB_META = {
    home: { title: "Наше пространство", sub: "Аня и Максим" },
    tasks: { title: "Наши планы", sub: "Общие дела, свидания и идеи" },
    dates: { title: "Даты", sub: "Значимые дни и дни рождения" },
    places: { title: "Места", sub: "Куда сходить вместе" },
    memories: { title: "Дневник", sub: "Воспоминания и личное" },
    pair: { title: "Наша пара", sub: "Профиль, желания и настройки" }
  };

  // ------------------------------------------------------------------
  // Данные демо — «живые» даты считаются от сегодня посетителя.
  // ------------------------------------------------------------------
  const TASKS = [
    { id: 1, title: "Выбрать фильм на вечер", when: "Сегодня", time: "20:00", chip: "Сегодня", chipClass: " is-countdown" },
    { id: 2, title: "Забронировать столик", when: "Завтра", time: "19:30", chip: "Завтра", chipClass: " is-countdown" },
    { id: 3, title: "Вечер вдвоём", when: fmtShort(saturday), chip: `Сб, ${fmtDM(saturday)}` },
    { id: 4, title: "Собраться на дачу", when: fmtShort(offsetDate(7)), isPrivate: true, chip: `Через 7 ${plural(7, "день", "дня", "дней")}` }
  ];
  const DONE_TASKS = [
    { id: 11, title: "Купить подарок маме", meta: "Выполнено 12 фев" },
    { id: 12, title: "Записаться к стоматологу", meta: "Выполнено 8 фев" }
  ];
  const GOALS = [
    { id: 21, title: "Марафонка осенью", isPrivate: false, items: [
      { id: 211, title: "Купить кроссовки", done: true },
      { id: 212, title: "Пробежать 10 км без остановки", done: true },
      { id: 213, title: "Записаться на медосмотр", done: false },
      { id: 214, title: "Собрать аптечку для длинных пробежек", done: false }
    ]},
    { id: 22, title: "Ремонт на кухне", isPrivate: true, items: [
      { id: 221, title: "Выбрать плитку", done: true },
      { id: 222, title: "Найти мастера", done: false },
      { id: 223, title: "Согласовать смету", done: false }
    ]}
  ];
  const MOVIES_OPEN = [
    { id: 31, title: "Дюна: Часть вторая", genre: "Фантастика", year: "2024", rating: "8.5", length: "2 ч 46 мин", kind: "movie", created: 305 },
    { id: 32, title: "Оппенгеймер", genre: "Драма", year: "2023", rating: "8.4", length: "3 ч 0 мин", kind: "movie", created: 304 },
    { id: 33, title: "Кролик Джоджо", genre: "Комедия", year: "2019", rating: "7.9", length: "1 ч 59 мин", kind: "series", created: 303 }
  ];
  const MOVIES_WATCHED = [
    { id: 34, title: "Паразиты", genre: "Триллер", year: "2019", rating: "8.6", length: "2 ч 12 мин", kind: "movie", created: 210, pair_rating: 9, my_rating: 9, watched: true, watchedAt: "Просмотрено 20 янв" },
    { id: 35, title: "Сто лет тому вперёд", genre: "Фантастика", year: "2023", rating: "7.6", length: "2 ч 18 мин", kind: "movie", created: 208, pair_rating: 0, my_rating: null, watched: true, watchedAt: "Просмотрено 2 фев" }
  ];
  const DATES = [
    { id: 41, title: "Годовщина", when: "14 февраля · Ежегодно", chip: untilDays(2, 14) },
    { id: 42, title: "День рождения дедушки", when: "28 февраля · Ежегодно", chip: untilDays(2, 28), isPrivate: true },
    { id: 43, title: "Первая встреча", when: "3 марта · Ежегодно", chip: untilDays(3, 3) }
  ];
  const BIRTHDAYS = [
    { id: 51, title: "День рождения Ани", when: "12 марта", chip: untilDays(3, 12) },
    { id: 52, title: "День рождения Максима", when: "3 сентября", chip: untilDays(9, 3) }
  ];
  const MEMORIES = [
    { id: 61, title: "Прогулка под дождём", body: "Промокли насквозь, но никуда не хотели уходить. Потом грелись какао на кухне и смотрели старые фото.", author: "Аня", date: "8 февраля" },
    { id: 62, body: "Встретили рассвет на крыше — город ещё спал, а мы уже были счастливы.", author: "Максим", date: "1 февраля" },
    { id: 63, title: "Первый совместный завтрак", body: "Сделали блины всей кухней перепутавшись. Теперь это наш ритуал каждого воскресенья.", author: "Аня", date: "28 января" }
  ];
  const QUOTES = [
    { id: 71, text: "Я не боюсь storms, я боюсь остаться одной в них.", source: "Аня", date: "6 февраля" },
    { id: 72, text: "Дом — это не место, а человек, с которым хочется возвращаться.", source: "Максим", date: "30 января" },
    { id: 73, text: "Маленькие моменты — это и есть большая жизнь.", source: "Аня · фильм «Дневник памяти»", date: "22 января" }
  ];
  const MEDS = [
    { id: 81, name: "Магний", form: "таблетка", dosage: "200 мг", schedule: "ежедневно · 08:00", taken: true },
    { id: 82, name: "Витамин D3", form: "капсула", dosage: "2000 МЕ", schedule: "ежедневно · 09:00", taken: false }
  ];
  const CONTACTS = [
    { id: 91, name: "Мама", phones: ["+7 9•• •••-••-12"] },
    { id: 92, name: "Стоматология «Улыбка»", phones: ["+7 495 •••-••-34", "+7 495 •••-••-35"] },
    { id: 93, name: "Кафе «Тихий двор»", phones: ["+7 495 •••-••-78"] }
  ];
  const PLACES_VISIT = [
    { id: 101, title: "Кафе «Тихий двор»", note: "Уютное место у парка — берём столик у окна", visited: false },
    { id: 102, title: "Парк Горького", note: "Прогулка вдоль набережной и кофе с собой", visited: false },
    { id: 103, title: "Кинотеатр «Октябрь»", note: "IMAX-зал, сеансы по выходным", visited: false }
  ];
  const PLACES_VISITED = [
    { id: 104, title: "Музей современного искусства", note: "", visited: true, visitedAt: "Посещено 18 янв" }
  ];
  const TRIPS = [
    { id: 111, title: "Португалия", note: "Лиссабон и Алгарве — 10 дней осенью", visited: false },
    { id: 112, title: "Япония", note: "Токио и Киото — весной, сакура", visited: false },
    { id: 113, title: "Карелия", note: "", visited: true, visitedAt: "Съездили в декабре" }
  ];

  // --- «Наша пара»: желания, копилки, календарь ---
  const WISHES_OPEN_MINE = [
    { id: 131, mine: true, body: "Кофемашина для кухни", comment: "Хочу готовить капучино как в нашем любимом кафе", url: "" },
    { id: 132, mine: true, body: "Поход в горы на выходные", comment: "Взять термос и плед — и никуда не спешить", url: "" },
    { id: 133, mine: true, body: "Книга «Атлант расправил плечи»", comment: "", url: "https://example.com/book" }
  ];
  const WISHES_OPEN_PARTNER = [
    { id: 141, mine: false, body: "Настольная игра «Бирюльки»", comment: "Видел в магазине у дома — выглядит весело", url: "" },
    { id: 142, mine: false, body: "Куртка из мембраны", comment: "", url: "" }
  ];
  const WISHES_DONE_MINE = [
    { id: 151, mine: true, body: "Электрочайник", comment: "Старый сдох как раз вовремя", created: "12 янв", doneAt: "2 фев" },
    { id: 152, mine: true, body: "Билеты в театр", comment: "", created: "20 янв", doneAt: "28 янв", url: "" }
  ];
  const WISHES_DONE_PARTNER = [
    { id: 153, mine: false, body: "Плед с рукавами", comment: "", created: "5 янв", doneAt: "18 янв" }
  ];
  const SAVINGS = [
    { id: 121, title: "Путешествие в Японию", kind: "shared", collected: 250000, target: 400000 },
    { id: 122, title: "Новый диван", kind: "shared", collected: 48000, target: 60000 },
    { id: 123, title: "Курс фотографии", kind: "personal", collected: 60000, target: 60000 }
  ];

  // События календаря пары: key — разовая дата, md — ежегодная (MM-DD).
  // kind: task | date | birthday | wish; isPrivate — личное событие пары.
  const CAL_EVENTS = [
    { key: dayKey(todayMidnight()), kind: "task", title: "Выбрать фильм на вечер", time: "20:00" },
    { key: dayKey(saturday), kind: "task", title: "Вечер вдвоём" },
    { md: "02-14", kind: "date", title: "Годовщина", note: "Ежегодно" },
    { md: "02-28", kind: "date", title: "День рождения дедушки", note: "Ежегодно", isPrivate: true },
    { md: "02-10", kind: "wish", title: "Кофемашина для кухни", note: "Желание подарено · вручено" },
    { md: "03-03", kind: "date", title: "Первая встреча", note: "Ежегодно" },
    { md: "03-12", kind: "birthday", title: "День рождения Ани" }
  ];
  const calMatch = (ev, cellKey) => (ev.key ? ev.key === cellKey : ev.md === cellKey.slice(5));
  const CAL_KIND_LABEL = { task: "План", date: "Значимая дата", birthday: "День рождения", wish: "Желание подарено" };

  const MOVIE_SORT_OPTIONS = [
    ["added", "По добавлению"], ["year", "Год"], ["rating", "Оценка IMDb/TMDB"],
    ["runtime", "Длительность"], ["genre", "Жанр"]
  ];
  const MOVIE_KIND_OPTIONS = [["all", "Все"], ["movie", "Фильмы"], ["series", "Сериалы"]];
  const MOVIE_SORT_DIR = { added: "desc", year: "desc", rating: "desc", runtime: "desc", genre: "asc" };

  const state = {
    tab: "home",
    views: {
      tasks: "plans", plans: "open", goals: "open", movies: "open",
      dates: "dates", places: "visit", memories: "memories",
      pair: "profile", wishesView: "open", savingsView: "saving"
    },
    wishView: "mine",
    movieSort: { open: { key: "added", dir: "desc" }, watched: { key: "added", dir: "desc" } },
    movieKind: { open: "all", watched: "all" },
    calOffset: 0,
    calSelected: dayKey(todayMidnight()),
    ritualDone: false,
    xp: 240,
    togetherXp: 520
  };

  const view = document.getElementById("demo-view");
  const nav = document.querySelector(".bottom-nav");
  const clockEl = document.getElementById("demo-clock");
  if (!view || !nav || !clockEl || !window.createLiquidNav) return;

  // ------------------------------------------------------------------
  // Тела списков по ключам сегментов (обновляются точечно, без ререндера).
  // ------------------------------------------------------------------
  function plansList() {
    if (state.views.plans === "done") {
      return `
        <div class="section-head-inline"><h3>Завершённые · ${DONE_TASKS.length}</h3></div>
        ${DONE_TASKS.map(doneTaskCard).join("")}`;
    }
    return `
      <button class="primary full add-button" type="button">Добавить план</button>
      ${TASKS.map(taskCard).join("")}`;
  }

  function goalsList() {
    if (state.views.goals === "done") {
      return `<section class="card"><h3>Пока ничего не достигнуто</h3><p>Отметьте все пункты цели — она переедет сюда</p></section>`;
    }
    return `
      <button class="primary full add-button" type="button">Создать цель</button>
      ${GOALS.map(goalCard).join("")}`;
  }

  function datesList() {
    return state.views.dates === "birthdays"
      ? `<button class="primary full add-button" type="button">Добавить день рождения</button>${BIRTHDAYS.map(birthdayCard).join("")}`
      : `<button class="primary full add-button" type="button">Добавить дату</button>${DATES.map(dateCard).join("")}`;
  }

  function placesList() {
    if (state.views.places === "trips") {
      const open = TRIPS.filter((t) => !t.visited);
      const visited = TRIPS.filter((t) => t.visited);
      return `
        <button class="primary full add-button" type="button">Добавить путешествие</button>
        ${open.map(tripCard).join("")}
        <div class="section-head-inline"><h3>Съездили · ${visited.length}</h3></div>
        ${visited.map(tripCard).join("")}`;
    }
    return `
      <section class="card place-hero">
        <h3>Не знаете, куда пойти?</h3>
        <p>Приложение выберет случайное место из списка. Отметить посещение можно отдельно — уже после того, как сходите</p>
        <button class="secondary full card-action" type="button">Рандом</button>
      </section>
      <button class="primary full add-button" type="button">Добавить место</button>
      <div class="section-head-inline"><h3>Хотим посетить · ${PLACES_VISIT.length}</h3></div>
      ${PLACES_VISIT.map(placeCard).join("")}
      <div class="section-head-inline"><h3>Посещённые · ${PLACES_VISITED.length}</h3></div>
      ${PLACES_VISITED.map(placeCard).join("")}`;
  }

  function memoriesList() {
    const v = state.views.memories;
    if (v === "quotes") return `<button class="primary full add-button" type="button">Добавить цитату</button>${QUOTES.map(quoteCard).join("")}`;
    if (v === "health") {
      return `
        <section class="card">
          <p class="eyebrow">Здоровье</p>
          <h3>Личный журнал препаратов</h3>
          <p>Бот напомнит о приёме в заданное время, пока курс активен</p>
        </section>
        ${MEDS.map(medCard).join("")}`;
    }
    if (v === "contacts") return `<button class="primary full add-button" type="button">Добавить контакт</button>${CONTACTS.map(contactCard).join("")}`;
    return `<button class="primary full add-button" type="button">Записать</button>${MEMORIES.map(memoryCard).join("")}`;
  }

  // ------------------------------------------------------------------
  // Кино: сортировка и фильтр — упрощённый порт movieSortBar/sortMovies.
  // ------------------------------------------------------------------
  function movieLengthMinutes(m) {
    const match = /(\d+)\s*ч(?:\s*(\d+)\s*мин)?/.exec(m.length || "");
    return match ? Number(match[1]) * 60 + Number(match[2] || 0) : null;
  }
  function movieSortValue(m, key) {
    if (key === "added") return m.created || 0;
    if (key === "year") return Number(m.year) || null;
    if (key === "rating") return Number(m.rating) > 0 ? Number(m.rating) : null;
    if (key === "runtime") return movieLengthMinutes(m);
    if (key === "genre") return (m.genre || "").toLowerCase() || null;
    if (key === "raofp") return Number(m.pair_rating) > 0 ? Number(m.pair_rating) : null;
    return null;
  }
  function sortMovies(list, view) {
    const { key, dir } = state.movieSort[view];
    const decorated = list.map((m) => ({ m, v: movieSortValue(m, key) }));
    decorated.sort((a, b) => {
      if (a.v === null && b.v === null) return a.m.id - b.m.id;
      if (a.v === null) return 1;
      if (b.v === null) return -1;
      const cmp = typeof a.v === "string" ? a.v.localeCompare(b.v, "ru") : a.v - b.v;
      return cmp === 0 ? a.m.id - b.m.id : dir === "asc" ? cmp : -cmp;
    });
    return decorated.map(({ m }) => m);
  }
  function movieSortBar(view, count) {
    const sort = state.movieSort[view];
    const kind = state.movieKind[view] || "all";
    const opts = view === "watched" ? [...MOVIE_SORT_OPTIONS, ["raofp", "RAofP"]] : MOVIE_SORT_OPTIONS;
    const field = (action, label, select, options, value) => `
      <div class="movie-sort-field${action === "movie-filter-kind" ? " is-kind" : ""}">
        <select data-action="${action}" aria-label="${label}">
          ${options.map(([v, l]) => `<option value="${v}"${v === value ? " selected" : ""}>${l}</option>`).join("")}
        </select>
        ${MOVIE_CHEVRON}
      </div>`;
    return `
      <div class="movie-sort">
        ${field("movie-sort-key", "Сортировка фильмов", true, opts, sort.key)}
        ${field("movie-filter-kind", "Показывать фильмы или сериалы", true, MOVIE_KIND_OPTIONS, kind)}
        <button class="icon-btn movie-sort-dir${sort.dir === "asc" ? " is-asc" : ""}" type="button"
          data-action="movie-sort-dir" aria-label="${sort.dir === "asc" ? "По возрастанию" : "По убыванию"}">
          <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 5v14M6 13l6 6 6-6"/></svg>
        </button>
        <span class="day-chip is-muted movie-sort-count">${count}</span>
      </div>`;
  }
  function filterMoviesByKind(list, view) {
    const kind = state.movieKind[view] || "all";
    return kind === "all" ? list : list.filter((m) => (m.kind === "series" ? "series" : "movie") === kind);
  }
  function moviesList() {
    const view = state.views.movies;
    if (view === "watched") {
      const all = MOVIES_WATCHED;
      if (!all.length) return `<section class="card"><h3>Пока ничего не просмотрено</h3><p>Отметьте фильм просмотренным в «В планах» — он появится здесь</p></section>`;
      const filtered = filterMoviesByKind(all, "watched");
      if (!filtered.length) return movieSortBar("watched", 0) + `<section class="card"><h3>Пусто</h3><p>Под фильтр ничего не попало — добавьте фильм или выберите «Все».</p></section>`;
      return movieSortBar("watched", filtered.length) + sortMovies(filtered, "watched").map(movieCard).join("");
    }
    // «В планах»: hero-карточка «Не знаете, что посмотреть?» с «Рандом» —
    // как renderOpenMovies() в app.js (отдельной кнопки под списком нет,
    // она появляется только после первого рандома).
    const open = filterMoviesByKind(MOVIES_OPEN, "open");
    return `
      <section class="card place-hero movie-hero">
        <h3>Не знаете, что посмотреть?</h3>
        <p>Приложение выберет случайный фильм или сериал из избранного. Отметить просмотр можно отдельно — уже после титров</p>
        <button class="secondary full card-action" type="button">Рандом</button>
      </section>
      <button class="primary full add-button" type="button">Найти кино</button>
      ${movieSortBar("open", open.length)}
      ${open.length ? sortMovies(open, "open").map(movieCard).join("") : `<section class="card"><h3>Пусто</h3><p>Под фильтр ничего не попало — добавьте фильм или выберите «Все».</p></section>`}`;
  }

  // ------------------------------------------------------------------
  // «Наша пара»: профиль (календарь + настройки), желания, копилка.
  // ------------------------------------------------------------------
  const MONTHS_RU = ["Январь", "Февраль", "Март", "Апрель", "Май", "Июнь", "Июль", "Август", "Сентябрь", "Октябрь", "Ноябрь", "Декабрь"];
  const WEEKDAYS_CAL = ["Пн", "Вт", "Ср", "Чт", "Пт", "Сб", "Вс"];

  // Сетка месяца — порт calendarGrid(): неделя с понедельника, дни
  // соседних месяцев приглушены, сетка всегда выровнена по неделям.
  function calendarCells(year, month) {
    const first = new Date(year, month, 1);
    const startOffset = (first.getDay() + 6) % 7;
    const daysInMonth = new Date(year, month + 1, 0).getDate();
    const cells = [];
    const total = Math.ceil((startOffset + daysInMonth) / 7) * 7;
    for (let i = 0; i < total; i++) {
      const d = new Date(year, month, 1 - startOffset + i);
      cells.push({ key: dayKey(d), day: d.getDate(), inMonth: d.getMonth() === month });
    }
    return cells;
  }

  function calDotHtml(ev) {
    if (ev.kind === "wish") return `<span class="cal-star" aria-hidden="true">${STAR_ICON}</span>`;
    const dot = `<i class="cal-dot is-${ev.kind}" aria-hidden="true"></i>`;
    if (ev.isPrivate) return `<span class="cal-dot-pair" aria-hidden="true"><i class="cal-dot is-private"></i>${dot}</span>`;
    return dot;
  }

  function calendarCard() {
    const base = new Date();
    const viewDate = new Date(base.getFullYear(), base.getMonth() + state.calOffset, 1);
    const year = viewDate.getFullYear();
    const month = viewDate.getMonth();
    const todayKey = dayKey(todayMidnight());
    const selected = state.calSelected;

    const cellsHtml = calendarCells(year, month).map((cell) => {
      const events = CAL_EVENTS.filter((ev) => calMatch(ev, cell.key));
      const classes = ["cal-day"];
      if (!cell.inMonth) classes.push("is-outside");
      if (cell.inMonth && cell.key === todayKey) classes.push("is-today");
      if (cell.key === selected) classes.push("is-selected");
      if (events.length) classes.push("has-events");
      const dots = events.map(calDotHtml).join("");
      return `<button class="${classes.join(" ")}" type="button" data-action="cal-day" data-day="${cell.key}">
        <span class="cal-num">${cell.day}</span>
        <span class="cal-dots" aria-hidden="true">${dots}</span>
      </button>`;
    }).join("");

    const selEvents = CAL_EVENTS.filter((ev) => calMatch(ev, selected));
    const selDate = new Date(`${selected}T00:00:00`);
    const selLabel = Number.isNaN(selDate.getTime()) ? selected
      : `${WEEKDAYS[selDate.getDay()]}, ${pad(selDate.getDate())}.${pad(selDate.getMonth() + 1)}.${selDate.getFullYear()}`;
    const details = `
      <div class="cal-events">
        <p class="cal-events-date">${selLabel}</p>
        ${selEvents.length ? selEvents.map((ev) => `
          <div class="cal-event">
            ${calDotHtml(ev)}
            <div class="cal-event-body">
              <span class="cal-event-title">${ev.title}</span>
              <span class="cal-event-meta">${CAL_KIND_LABEL[ev.kind]}${ev.isPrivate ? " · личное" : ""}${ev.note ? ` · ${ev.note}` : ""}${ev.time ? ` · ${ev.time}` : ""}</span>
            </div>
          </div>`).join("") : `<p class="cal-empty">На этот день событий нет.</p>`}
      </div>`;

    return `
      <section class="card calendar-card">
        <div class="cal-head">
          <button class="cal-nav-btn" type="button" data-action="cal-prev" aria-label="Предыдущий месяц">${CHEVRON_LEFT}</button>
          <h3 class="cal-title">${MONTHS_RU[month]} ${year}</h3>
          <button class="cal-nav-btn" type="button" data-action="cal-next" aria-label="Следующий месяц">${CHEVRON_RIGHT}</button>
        </div>
        <div class="cal-weekdays" aria-hidden="true">${WEEKDAYS_CAL.map((d) => `<span>${d}</span>`).join("")}</div>
        <div class="cal-grid">${cellsHtml}</div>
        <div class="cal-legend">
          <span><i class="cal-dot is-task" aria-hidden="true"></i> Планы</span>
          <span><i class="cal-dot is-date" aria-hidden="true"></i> Значимые даты</span>
          <span><i class="cal-dot is-birthday" aria-hidden="true"></i> Дни рождения</span>
          <span><span class="cal-star" aria-hidden="true">${STAR_ICON}</span> Желания</span>
          <span><span class="cal-dot-pair" aria-hidden="true"><i class="cal-dot is-private"></i><i class="cal-dot is-task"></i></span> Личное</span>
        </div>
        ${details}
      </section>`;
  }

  // Настройки — порт renderPairSettings() (значения статичные, как у нового
  // пользователя: акцент berry, сводки включены).
  const ACCENT_SWATCHES = [
    ["berry", "#b85464"], ["sage", "#55766a"], ["ocean", "#4a6f8f"],
    ["violet", "#7a5f9e"], ["amber", "#b06a2c"]
  ];
  function pairSettingsCard() {
    const swatches = ACCENT_SWATCHES.map(([key, color], i) => `
      <button class="swatch${i === 0 ? " is-active" : ""}" type="button" style="background:${color}" aria-label="Акцентный цвет: ${key}"></button>`).join("");
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone || "Europe/Moscow";
    return `
      <section class="card">
        <p class="eyebrow">Настройки</p>
        <h3>Оформление и уведомления</h3>
        <div class="settings-row">
          <span class="settings-label">Акцентный цвет</span>
          <div class="swatch-row">${swatches}</div>
        </div>
        <label class="settings-row">
          <span class="settings-label"><input type="checkbox" checked> Отображение аватара</span>
        </label>
        <p class="settings-hint">Фото профиля Telegram вместо букв в кнопке пары</p>
        <div class="settings-row">
          <span class="settings-label">Ваше имя</span>
          <input type="text" maxlength="80" autocomplete="off" placeholder="Аня">
        </div>
        <p class="settings-hint">Как ваше имя отображается у вас в приложении. Пусто — имя из Telegram</p>
        <div class="settings-row">
          <span class="settings-label">Имя партнёра</span>
          <input type="text" maxlength="80" autocomplete="off" placeholder="Максим">
        </div>
        <p class="settings-hint">Каким вы видите имя партнёра в приложении. Пусто — имя из Telegram</p>
        <div class="settings-row">
          <span class="settings-label">Ваш часовой пояс</span>
          <span class="day-chip is-muted">${tz}</span>
        </div>
        <label class="settings-row">
          <span class="settings-label"><input type="checkbox" checked> Утренняя сводка</span>
          <input type="time" value="09:00">
        </label>
        <p class="settings-hint">Планы и значимые даты на сегодня и завтра — личным сообщением от бота</p>
        <label class="settings-row">
          <span class="settings-label"><input type="checkbox" checked> Даты за сутки</span>
          <input type="time" value="09:00">
        </label>
        <label class="settings-row">
          <span class="settings-label"><input type="checkbox"> Недельная сводка</span>
          <input type="time" value="09:00">
        </label>
        <div class="settings-row">
          <span class="settings-label">День сводки</span>
          <select class="settings-select">
            <option>Воскресенье</option>
            <option>Понедельник</option>
          </select>
        </div>
        <div class="settings-row">
          <span class="settings-label">Тема</span>
          <div class="theme-switch">
            <button class="theme-option is-active" type="button">Как в системе</button>
            <button class="theme-option" type="button">Тёмная</button>
            <button class="theme-option" type="button">Светлая</button>
          </div>
        </div>
        <div style="margin-top:14px; display:grid; gap:8px;">
          <button class="secondary full" type="button">Сохранить настройки</button>
        </div>
      </section>`;
  }

  function pairLockCard() {
    return `
      <section class="card">
        <p class="eyebrow">Безопасность</p>
        <h3>Пароль на вход</h3>
        <input type="text" inputmode="numeric" maxlength="4" placeholder="••••" autocomplete="off"
          style="width:100%;height:44px;border:1px solid var(--line);border-radius:12px;padding:0 12px;background:var(--bg);color:var(--ink);font:inherit;font-size:15px;letter-spacing:.4em;text-align:center;">
        <p class="settings-hint">Четырёхзначный пароль будет запрашиваться при открытии приложения</p>
        <button class="secondary full card-action" type="button">Задать</button>
      </section>`;
  }

  function pairTimezoneCard() {
    const current = Intl.DateTimeFormat().resolvedOptions().timeZone || "Europe/Moscow";
    const zones = [...new Set([current, "Europe/Moscow", "Europe/Kaliningrad", "Asia/Yekaterinburg", "Asia/Novosibirsk", "Europe/Kyiv", "Europe/Minsk", "Europe/Warsaw", "Europe/Berlin", "Asia/Almaty", "UTC"])];
    return `
      <section class="card">
        <p class="eyebrow">Общее</p>
        <h3>Часовой пояс</h3>
        <select class="settings-select">${zones.map((z) => `<option${z === current ? " selected" : ""}>${z.replace(/_/g, " ")}</option>`).join("")}</select>
        <p class="settings-hint">Общий для календаря, ритуала дня, напоминаний и времени событий у обоих партнёров</p>
        <button class="secondary full card-action" type="button">Сохранить пояс</button>
      </section>`;
  }

  function pairExportCard() {
    return `
      <section class="card">
        <p class="eyebrow">Резервная копия</p>
        <h3>Экспорт данных</h3>
        <p class="settings-hint">Выберите разделы — бот пришлёт один файл с выбранным. Удобно хранить вне приложения</p>
        <button class="secondary full card-action" type="button">Экспортировать</button>
      </section>`;
  }

  function pairProfileBody() {
    // renderPairBody() без invite-блока: партнёр в демо уже в паре.
    return `
      ${calendarCard()}
      ${pairSettingsCard()}
      ${pairLockCard()}
      ${pairTimezoneCard()}
      ${pairExportCard()}
      <div class="pair-exit">
        <button class="secondary pair-leave" type="button">Выйти из пространства</button>
      </div>`;
  }

  // Желания: «Загадано/Исполнено» + «Мои/Его» — renderWishBlock()/renderWishLists().
  function wishLists() {
    const isMine = state.wishView === "mine";
    const partnerLabel = "Его";
    const done = state.views.wishesView === "done";
    const open = isMine ? WISHES_OPEN_MINE : WISHES_OPEN_PARTNER;
    const doneList = isMine ? WISHES_DONE_MINE : WISHES_DONE_PARTNER;
    if (done) {
      if (!doneList.length) {
        return `<section class="card"><h3>Пока пусто</h3><p>${isMine ? "Исполненных желаний пока нет" : `У ${partnerLabel === "Её" ? "неё" : "него"} исполненных желаний пока нет`}</p></section>`;
      }
      return doneList.map(completedWishItem).join("");
    }
    if (isMine) {
      return `<button class="primary full add-button" type="button">Добавить желание</button>` + open.map(wishItem).join("");
    }
    return open.length
      ? open.map(wishItem).join("")
      : `<section class="card"><h3>Пока пусто</h3><p>${partnerLabel === "Её" ? "Она" : "Он"} ещё не добавил${partnerLabel === "Её" ? "а" : ""} желаний в общий список</p></section>`;
  }

  function wishBlock() {
    const isMine = state.wishView === "mine";
    return segSwitch("wishesView", state.views.wishesView, [["open", "Загадано"], ["done", "Исполнено"]], "is-sub")
      + `<div class="wish-switch" role="tablist" aria-label="Чьи желания показывать">
          <button class="wish-switch-btn${isMine ? " is-active" : ""}" type="button" role="tab"
            aria-selected="${isMine}" data-action="wish-view" data-view="mine">Мои</button>
          <button class="wish-switch-btn${!isMine ? " is-active" : ""}" type="button" role="tab"
            aria-selected="${!isMine}" data-action="wish-view" data-view="partner">Его</button>
        </div>
        <div class="seg-body" id="seg-body-wishesView">${wishLists()}</div>`;
  }

  // Копилка — renderSavingsBody()/renderSavingsList().
  function savingsListHtml() {
    const saved = state.views.savingsView === "saved";
    const list = SAVINGS.filter((s) => (saved ? savingIsFull(s) : !savingIsFull(s)));
    const addButton = `<button class="primary full add-button" type="button">Создать копилку</button>`;
    if (!list.length) {
      return saved
        ? `<section class="card"><h3>Пока пусто</h3><p>Здесь появятся копилки, у которых цель уже достигнута</p></section>`
        : `<section class="card"><h3>Пока пусто</h3>
            <p>Создайте копилку на общую мечту или личную цель — пополняйте и следите за прогрессом</p>
            <div style="margin-top:12px;">${addButton}</div>
          </section>`;
    }
    return (saved ? "" : addButton) + list.map(savingItem).join("");
  }

  function savingsBody() {
    return segSwitch("savings", state.views.savingsView, [["saving", "Копим"], ["saved", "Накоплено"]], "is-sub")
      + `<div class="seg-body" id="seg-body-savings">${savingsListHtml()}</div>`;
  }

  function pairInner() {
    const v = state.views.pair;
    if (v === "wishes") return wishBlock();
    if (v === "savings") return savingsBody();
    return pairProfileBody();
  }

  function pairBody() {
    return segSwitch("pair", state.views.pair, [["profile", "Профиль"], ["wishes", "Желания"], ["savings", "Копилка"]])
      + `<div class="seg-body" id="seg-body-pair">${pairInner()}</div>`;
  }

  // Тело после сегмента каждой вкладки — для точечной замены при commitSwitch.
  function tasksInner() {
    const v = state.views.tasks;
    if (v === "goals") {
      return segSwitch("goals", state.views.goals, [["open", "Предстоящие"], ["done", "Выполненные"]], "is-sub")
        + `<div class="seg-body" id="seg-body-goals">${goalsList()}</div>`;
    }
    if (v === "movies") {
      // «Кино» — свой внутренний сегмент «В планах / Просмотрено»,
      // как renderMoviesBody() в app.js.
      return segSwitch("movies", state.views.movies, [["open", "В планах"], ["watched", "Просмотрено"]], "is-sub")
        + `<div class="seg-body" id="seg-body-movies">${moviesList()}</div>`;
    }
    return segSwitch("plans", state.views.plans, [["open", "Предстоящие"], ["done", "Выполненные"]], "is-sub")
      + `<div class="seg-body" id="seg-body-plans">${plansList()}</div>`;
  }

  const SEG_BODIES = {
    tasks: tasksInner,
    plans: plansList,
    goals: goalsList,
    movies: moviesList,
    dates: datesList,
    places: placesList,
    memories: memoriesList,
    pair: pairInner,
    wishesView: wishLists,
    savings: savingsListHtml
  };

  // ------------------------------------------------------------------
  // Вкладки.
  // ------------------------------------------------------------------
  function tabHeader() {
    const meta = TAB_META[state.tab];
    return `
      <header class="tab-header">
        <h1 class="tab-header-title">${meta.title}</h1>
        <p class="tab-header-sub">${meta.sub}</p>
      </header>`;
  }

  function homeBody() {
    const action = dailyAction(DEMO_PAIR_ID, dayKey(new Date()));
    const done = state.ritualDone;
    return `
      <section class="card hero-card">
        <p class="eyebrow">Ваша история</p>
        <h2>Аня и Максим</h2>
        <div class="stats-row">
          <span class="stat-pill">${FLAME_ICON} Серия 6 дн.</span>
          <span class="stat-pill" id="demo-xp-pill">${state.xp} XP</span>
          <span class="stat-pill" id="demo-together-pill">Вместе ${state.togetherXp} XP</span>
        </div>
      </section>

      <section class="card${done ? " is-done" : ""}">
        <p class="eyebrow">Ритуал дня</p>
        <h3>${action}</h3>
        <p id="demo-ritual-copy">${done ? "Вы отметили ритуал +10 XP" : "Отметьте ритуал дня и получите +10 XP"}</p>
        ${done ? "" : `<div style="margin-top:18px;"><button class="primary full" type="button" id="demo-ritual">Выполнено +10 XP</button></div>`}
      </section>

      <div class="section-head-inline"><h3>Ближайшие планы</h3></div>
      ${TASKS.slice(0, 3).map(taskCard).join("")}

      <div class="section-head-inline"><h3>Значимые даты</h3></div>
      ${DATES.slice(0, 2).map(dateCard).join("")}

      <div class="section-head-inline"><h3>Дни рождения</h3></div>
      ${BIRTHDAYS.slice(0, 1).map(birthdayCard).join("")}

      <div class="section-head-inline"><h3>Из дневника</h3></div>
      ${memoryCard(MEMORIES[0])}`;
  }

  function tasksBody() {
    return segSwitch("tasks", state.views.tasks, [["plans", "Планы"], ["goals", "Цели"], ["movies", "Кино"]])
      + `<div class="seg-body" id="seg-body-tasks">${tasksInner()}</div>`;
  }

  function datesBody() {
    return segSwitch("dates", state.views.dates, [["dates", "Наши"], ["birthdays", "Дни рождения"]])
      + `<div class="seg-body" id="seg-body-dates">${datesList()}</div>`;
  }

  function placesBody() {
    return segSwitch("places", state.views.places, [["visit", "Посетить"], ["trips", "Путешествие"]])
      + `<div class="seg-body" id="seg-body-places">${placesList()}</div>`;
  }

  function memoriesBody() {
    return segSwitch("memories", state.views.memories, [["memories", "Записи"], ["quotes", "Цитаты"], ["health", "Здоровье"], ["contacts", "Контакты"]])
      + `<div class="seg-body" id="seg-body-memories">${memoriesList()}</div>`;
  }

  const BODIES = { home: homeBody, tasks: tasksBody, dates: datesBody, places: placesBody, memories: memoriesBody, pair: pairBody };

  // ------------------------------------------------------------------
  // Рендер и «жидкие» переключатели.
  // ------------------------------------------------------------------
  const switches = {}; // key -> { nav, instance }
  // Ключ сегмента в DOM (data-switch) → ключ в state.views: в app.js
  // «Копилка» называется savingsView, а сегмент — savings.
  const viewKey = (k) => (k === "savings" ? "savingsView" : k);
  const viewValue = (k) => state.views[viewKey(k)];

  function destroySwitch(key) {
    const sw = switches[key];
    if (sw && sw.instance && sw.instance.destroy) sw.instance.destroy();
    delete switches[key];
  }

  function destroySwitches() {
    Object.keys(switches).forEach(destroySwitch);
  }

  // Капли для всех .seg-switch в области (по умолчанию — весь #demo-view).
  function mountSwitches(scope) {
    (scope || view).querySelectorAll(".seg-switch[data-switch]").forEach((container) => {
      const key = container.dataset.switch;
      destroySwitch(key);
      const items = Array.from(container.querySelectorAll("[data-tab]"));
      if (items.length < 2) return;
      const instance = window.createLiquidNav({
        nav: container,
        items,
        idleVar: "--nav-label",
        onCommit: (value) => commitSwitch(key, value, switches[key] && switches[key].instance)
      });
      if (!instance) return;
      instance.setActive(viewValue(key) || items[0].dataset.tab, false);
      switches[key] = { nav: container, instance };
    });
  }

  function render() {
    destroySwitches();
    view.innerHTML = tabHeader() + BODIES[state.tab]();
    mountSwitches(view);
    if (state.tab === "home") bindRitual();
  }

  // Точечная замена тела сегмента без полного render() — как commitSwitch
  // в app.js. Между сегментом и телом могут быть промежуточные элементы
  // (например, .wish-switch в желаниях) — ищем ближайший .seg-body.
  function refreshSegBody(key) {
    const fn = SEG_BODIES[key];
    const seg = view.querySelector(`.seg-switch[data-switch="${key}"]`);
    let bodyEl = seg && seg.nextElementSibling;
    while (bodyEl && !bodyEl.classList.contains("seg-body")) bodyEl = bodyEl.nextElementSibling;
    if (!bodyEl || !fn) { render(); return; }
    bodyEl.innerHTML = fn();
    mountSwitches(bodyEl);
  }

  // commitSwitch — как в app.js: меняем только тело сегмента, капля
  // доезжает пружиной, DOM вокруг не перерисовывается.
  function commitSwitch(key, value, instance) {
    if (viewValue(key) === value) return;
    state.views[viewKey(key)] = value;
    const seg = view.querySelector(`.seg-switch[data-switch="${key}"]`);
    let bodyEl = seg && seg.nextElementSibling;
    while (bodyEl && !bodyEl.classList.contains("seg-body")) bodyEl = bodyEl.nextElementSibling;
    if (!bodyEl || !SEG_BODIES[key]) {
      render();
      return;
    }
    // Вложенные капли внутри заменяемого тела снимаем — иначе их
    // window-слушатели и SVG остались бы висеть.
    Object.keys(switches).forEach((k) => {
      if (k !== key && bodyEl.contains(switches[k].nav)) destroySwitch(k);
    });
    bodyEl.innerHTML = SEG_BODIES[key]();
    mountSwitches(bodyEl);
    seg.querySelectorAll(".seg-switch-btn").forEach((btn) => {
      const active = btn.dataset.tab === value;
      btn.classList.toggle("is-active", active);
      btn.setAttribute("aria-selected", String(active));
    });
    if (instance) instance.setActive(value, true);
  }

  // Тап по сегменту.
  view.addEventListener("click", (e) => {
    const segBtn = e.target.closest(".seg-switch-btn[data-tab]");
    if (segBtn) {
      const container = segBtn.closest(".seg-switch[data-switch]");
      if (container) {
        commitSwitch(container.dataset.switch, segBtn.dataset.tab, switches[container.dataset.switch] && switches[container.dataset.switch].instance);
      }
      return;
    }
    // «Мои / Его» в желаниях — не капля, а статичный переключатель:
    // меняем только список, как commitSwitch("wish-view") в app.js.
    const wishBtn = e.target.closest('[data-action="wish-view"]');
    if (wishBtn) {
      state.wishView = wishBtn.dataset.view === "partner" ? "partner" : "mine";
      refreshSegBody("wishesView");
      view.querySelectorAll(".wish-switch-btn").forEach((btn) => {
        const active = (btn.dataset.view === "partner") === (state.wishView === "partner");
        btn.classList.toggle("is-active", active);
        btn.setAttribute("aria-selected", String(active));
      });
      return;
    }
    // Календарь пары: месяц и выбранный день.
    const calBtn = e.target.closest('[data-action^="cal-"]');
    if (calBtn) {
      const action = calBtn.dataset.action;
      if (action === "cal-prev") state.calOffset -= 1;
      else if (action === "cal-next") state.calOffset += 1;
      else if (action === "cal-day") state.calSelected = calBtn.dataset.day;
      else return;
      refreshSegBody("pair");
      return;
    }
    // Направление сортировки кино — переключаем dir, список перерисовываем.
    if (e.target.closest('[data-action="movie-sort-dir"]')) {
      const v = state.views.movies;
      state.movieSort[v].dir = state.movieSort[v].dir === "asc" ? "desc" : "asc";
      refreshSegBody("movies");
    }
  });

  // Селекты сортировки/фильтра кино — change, не click.
  view.addEventListener("change", (e) => {
    const sel = e.target.closest('select[data-action]');
    if (!sel) return;
    const action = sel.dataset.action;
    const viewKey = state.views.movies;
    if (action === "movie-sort-key") state.movieSort[viewKey].key = sel.value;
    else if (action === "movie-filter-kind") state.movieKind[viewKey] = sel.value;
    else return;
    refreshSegBody("movies");
  });

  function setTab(tab) {
    if (tab === state.tab) return;
    state.tab = tab;
    if (tab === "pair") {
      // «Наша пара» открывается пилюлей аватаров — в нижнем баре её нет,
      // активный пункт снимаем (как в app.js, где пара — не nav-item).
      navItems.forEach((btn) => {
        btn.classList.remove("is-active");
        btn.removeAttribute("aria-current");
      });
    } else {
      liquidNav.setActive(tab);
      navItems.forEach((btn) => {
        const active = btn.dataset.tab === tab;
        btn.classList.toggle("is-active", active);
        if (active) btn.setAttribute("aria-current", "page");
        else btn.removeAttribute("aria-current");
      });
    }
    render();
  }

  // Нижний бар — тот же контракт, что в app.js.
  const navItems = Array.from(nav.querySelectorAll(".nav-item[data-tab]"));
  const liquidNav = window.createLiquidNav({
    nav,
    svg: nav.querySelector(".nav-droplet"),
    path: nav.querySelector(".nav-droplet-path"),
    items: navItems,
    onCommit: (tab) => setTab(tab)
  });
  nav.addEventListener("click", (e) => {
    const btn = e.target.closest(".nav-item[data-tab]");
    if (btn) setTab(btn.dataset.tab);
  });

  // Пилюля пары в шапке — как #pair-button в app.html: открывает «Нашу пару».
  const pairPill = document.querySelector(".pair-pill");
  if (pairPill) pairPill.addEventListener("click", () => setTab("pair"));

  // «+10» над пилюлей XP — как playXpGainAnimation() в app.js.
  function bumpXp(pillId, delta) {
    const pill = document.getElementById(pillId);
    if (!pill) return;
    const chip = document.createElement("span");
    chip.className = "xp-gain";
    chip.textContent = `${delta > 0 ? "+" : ""}${delta}`;
    pill.appendChild(chip);
    setTimeout(() => {
      chip.remove();
      if (pillId === "demo-xp-pill") pill.textContent = `${state.xp} XP`;
      else pill.textContent = `Вместе ${state.togetherXp} XP`;
    }, 1400);
  }

  function bindRitual() {
    const btn = document.getElementById("demo-ritual");
    if (!btn) return;
    btn.addEventListener("click", () => {
      state.ritualDone = !state.ritualDone;
      const delta = state.ritualDone ? 10 : -10;
      state.xp += delta;
      state.togetherXp += delta;
      render();
      bumpXp("demo-xp-pill", delta);
      bumpXp("demo-together-pill", delta);
    });
  }

  function tickClock() {
    const t = new Date();
    clockEl.textContent = `${pad(t.getHours())}:${pad(t.getMinutes())}`;
  }
  tickClock();
  setInterval(tickClock, 1000);

  liquidNav.setActive("home", false);
  render();
})();
