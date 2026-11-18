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
  const keyToDate = (key) => {
    const [y, m, d] = String(key).split("-").map(Number);
    return new Date(y, m - 1, d);
  };
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
  const addDays = (d, n) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);
  const diffDays = (a, b) => Math.round((a.getTime() - b.getTime()) / 86400000);
  function nextSaturday() {
    const t = new Date();
    return offsetDate((6 - t.getDay() + 7) % 7 || 7);
  }
  const saturday = nextSaturday();
  // Ближайшее наступление месяца/дня (для ежегодных дат и дней рождения).
  function nextOccurrenceMD(month, day) {
    const t = todayMidnight();
    const d = new Date(t.getFullYear(), month - 1, day);
    if (d.getTime() < t.getTime()) d.setFullYear(d.getFullYear() + 1);
    return d;
  }
  // Подпись отсчёта — как nextDaysLabel() в app.js.
  const nextLabel = (n) =>
    n <= 0 ? "Сегодня" : n === 1 ? "Завтра" : `Через ${n} ${plural(n, "день", "дня", "дней")}`;
  const untilDays = (month, day) => nextLabel(diffDays(nextOccurrenceMD(month, day), todayMidnight()));

  // ------------------------------------------------------------------
  // Текст: esc + Telegram-разметка — дословный порт из app.js.
  // ------------------------------------------------------------------
  function esc(value) {
    return String(value ?? "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  const RICH_TOKENS = [["**", "b", ""], ["__", "u", ""], ["||", "span", "rich-spoiler"], ["~~", "s", ""], ["_", "i", ""]];

  function richInline(escaped) {
    const out = [];
    const stack = [];
    let i = 0;
    while (i < escaped.length) {
      const token = RICH_TOKENS.find(([t]) => escaped.startsWith(t, i));
      if (token) {
        const [tok, tag, cls] = token;
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

  // Даты всегда в виде дд.мм.гггг — как formatDay() в app.js.
  function formatDay(value) {
    if (value instanceof Date) {
      return `${pad(value.getDate())}.${pad(value.getMonth() + 1)}.${value.getFullYear()}`;
    }
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(value ?? ""));
    return m ? `${m[3]}.${m[2]}.${m[1]}` : String(value ?? "");
  }

  // Unix timestamp (seconds) → дд.мм.гггг.
  function formatTimestamp(ts) {
    const n = Number(ts);
    if (!Number.isFinite(n) || n <= 0) return "";
    const d = new Date(n * 1000);
    return `${pad(d.getDate())}.${pad(d.getMonth() + 1)}.${d.getFullYear()}`;
  }

  // Год в дне рождения технический: показываем месяц и число.
  function formatBirthday(day) {
    const [, month, date] = String(day || "").split("-").map(Number);
    if (!month || !date) return "";
    const value = new Date(Date.UTC(2000, month - 1, date, 12));
    return new Intl.DateTimeFormat("ru-RU", { timeZone: "UTC", day: "numeric", month: "long" }).format(value);
  }

  // ------------------------------------------------------------------
  // Иконки — дословно из app.js.
  // ------------------------------------------------------------------
  const DONE_ICON = '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m5 12.5 4.5 4.5L19 7.5"/></svg>';
  const EDIT_ICON = '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 20h4.5L19.5 9a2.1 2.1 0 0 0-3-3L5.5 17 4 20Z"/><path d="M13.5 7.5 16.5 10.5"/></svg>';
  const DELETE_ICON = '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" aria-hidden="true"><path d="m6.5 6.5 11 11M17.5 6.5l-11 11"/></svg>';
  const REOPEN_ICON = '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 10a8 8 0 1 1 2 6"/><path d="M4 4v6h6"/></svg>';
  const FLAME_ICON = '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 3c1.2 3-2.6 4.6-2.6 7.6a3.6 3.6 0 0 0 3.7 3.5c1.8-.1 2.9-1.7 2.6-3.8 1.9 1.5 3.1 3.6 3.1 5.8A6.8 6.8 0 0 1 5.2 15C5.2 9.4 10.4 8 12 3Z"/></svg>';
  const COPY_ICON = '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="9" y="9" width="12" height="12" rx="2.2"/><path d="M5.5 15H4.8A1.8 1.8 0 0 1 3 13.2V4.8A1.8 1.8 0 0 1 4.8 3h8.4A1.8 1.8 0 0 1 15 4.8v.7"/></svg>';
  // Частичное копирование желания: «название» и «ссылка» получают составную
  // иконку «звено цепочки + строки текста» — как в app.js.
  const LINK_TEXT_ICON = '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><g transform="translate(4.4 -0.4) scale(0.62)"><path d="M9.5 14.5a4.24 4.24 0 0 0 6 0l3.2-3.2a4.24 4.24 0 1 0-6-6L11.5 6.5"/><path d="M14.5 9.5a4.24 4.24 0 0 0-6 0l-3.2 3.2a4.24 4.24 0 1 0 6 6l1.2-1.2"/></g><path d="M4.5 15.5h15M4.5 18.5h10M4.5 21h13"/></svg>';
  const PLUS_ICON = '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" aria-hidden="true"><path d="M12 5.5v13M5.5 12h13"/></svg>';
  const STAR_ICON = '<svg viewBox="0 0 24 24" width="10" height="10" fill="currentColor" stroke="none" aria-hidden="true"><path d="m12 3 2.55 5.18 5.72.83-4.14 4.03.98 5.7L12 16.45l-5.11 2.69.98-5.7-4.14-4.03 5.72-.83L12 3Z"/></svg>';
  const CHEVRON_LEFT = '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m14.5 6.5-5.5 5.5 5.5 5.5"/></svg>';
  const CHEVRON_RIGHT = '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m9.5 6.5 5.5 5.5-5.5 5.5"/></svg>';
  const MOVIE_CHEVRON = '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m6 9 6 6 6-6"/></svg>';
  const LINK_ICON = '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9.5 14.5a4.24 4.24 0 0 0 6 0l3.2-3.2a4.24 4.24 0 1 0-6-6L11.5 6.5"/><path d="M14.5 9.5a4.24 4.24 0 0 0-6 0l-3.2 3.2a4.24 4.24 0 1 0 6 6l1.2-1.2"/></svg>';
  const RESUME_ICON = '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M8 5.5v13l11-6.5-11-6.5Z"/></svg>';
  const FLO_HEART_ICON = '<svg class="cal-heart" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 21.35l-1.45-1.32C5.4 15.36 2 12.28 2 8.5 2 5.42 4.42 3 7.5 3c1.74 0 3.41.81 4.5 2.09C13.09 3.81 14.76 3 16.5 3 19.58 3 22 5.42 22 8.5c0 3.78-3.4 6.86-8.55 11.54L12 21.35z"/></svg>';

  // itemActionButton/itemActions — дословно из app.js: «⋮» в правом верхнем
  // углу карточки, по тапу выпадает меню действий.
  function itemActionButton(opts) {
    const { action, type, id, url, label, icon, part } = opts;
    const typeAttr = type !== undefined ? ` data-type="${esc(type)}"` : "";
    const idAttr = id !== undefined ? ` data-id="${esc(id)}"` : "";
    const urlAttr = url !== undefined ? ` data-url="${esc(url)}"` : "";
    const partAttr = part !== undefined ? ` data-part="${esc(part)}"` : "";
    return `<button class="item-menu-item" type="button" role="menuitem" data-action="${action}"${typeAttr}${idAttr}${urlAttr}${partAttr}><span class="item-menu-icon" aria-hidden="true">${icon}</span><span class="item-menu-label">${esc(label)}</span></button>`;
  }

  function itemActions(buttons) {
    if (!buttons) return "";
    return `<div class="item-actions">
      <button class="item-menu-toggle" type="button" data-action="item-menu-toggle" aria-label="Действия" aria-haspopup="menu" aria-expanded="false">⋮</button>
      <div class="item-menu" role="menu" hidden>${buttons}</div>
    </div>`;
  }

  const editDelete = (type, id) => itemActions([
    itemActionButton({ action: "edit-item", type, id, label: "Редактировать", icon: EDIT_ICON }),
    itemActionButton({ action: "delete-item", type, id, label: "Удалить", icon: DELETE_ICON })
  ].join("\n            "));

  // Одно открытое меню максимум — как closeItemMenus() в app.js.
  function closeItemMenus(except) {
    document.querySelectorAll("#demo-view .item-actions.is-open").forEach((el) => {
      if (el === except) return;
      el.classList.remove("is-open");
      const menu = el.querySelector(".item-menu");
      if (menu) menu.hidden = true;
      const toggle = el.querySelector(".item-menu-toggle");
      if (toggle) toggle.setAttribute("aria-expanded", "false");
    });
  }

  // ------------------------------------------------------------------
  // Чип отсчёта — упрощённый порт countdownChip() в app.js (один пояс,
  // без 30-секундного тика: значения статичны на момент рендера).
  // ------------------------------------------------------------------
  function countdownChipFor(date, time) {
    if (!date) return "";
    const target = time ? new Date(date.getFullYear(), date.getMonth(), date.getDate(), ...time.split(":").map(Number)) : date;
    const diff = target.getTime() - Date.now();
    if (diff <= 0) return `<span class="day-chip is-overdue">Время пришло</span>`;
    const days = diffDays(new Date(target.getFullYear(), target.getMonth(), target.getDate()), todayMidnight());
    if (days === 0) {
      const hours = Math.floor(diff / 3600000);
      const mins = Math.max(1, Math.floor((diff % 3600000) / 60000));
      const label = hours > 0 ? `Через ${hours} ч ${mins} мин` : `Через ${mins} мин`;
      return `<span class="day-chip is-countdown">${esc(label)}</span>`;
    }
    if (days === 1) return `<span class="day-chip">Завтра</span>`;
    return `<span class="day-chip">Через ${days} ${plural(days, "день", "дня", "дней")}</span>`;
  }

  // Чип для ежегодной даты/дня рождения — порт nextDaysLabel().
  function recurringChip(month, day) {
    const next = nextOccurrenceMD(month, day);
    const days = diffDays(next, todayMidnight());
    if (days <= 0) return { label: "Сегодня", cls: "" };
    if (days === 1) return { label: "Завтра", cls: "" };
    return { label: `Через ${days} ${plural(days, "день", "дня", "дней")}`, cls: "" };
  }

  // ------------------------------------------------------------------
  // Карточки — структура скопирована из app.js.
  // ------------------------------------------------------------------
  function taskCard(t) {
    const whenText = t.isPrivate
      ? `<div class="item-when-line"><span class="day-chip is-private">Личное</span>${t.day ? `<span>${esc(formatDay(t.day))}${t.time ? ` · ${esc(t.time)}` : ""}</span>` : ""}</div>`
      : t.day ? `<span>${esc(formatDay(t.day))}${t.time ? ` · ${esc(t.time)}` : ""}</span>` : "";
    const calendarAttrs = t.day
      ? ` role="button" tabindex="0" data-action="show-in-calendar" data-day="${dayKey(t.day)}" aria-label="Показать в календаре"`
      : "";
    return `
      <article class="card"${calendarAttrs}>
        <div class="item-row">
          <div class="item-main">
            <h3 class="item-title">${renderRichText(t.title)}</h3>
            <div class="item-meta">
              <div class="item-when">
                ${whenText}
                <div class="item-when-row">${countdownChipFor(t.day, t.time)}</div>
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
            <h3 class="item-title" style="text-decoration:line-through;">${renderRichText(t.title)}</h3>
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
    const [month, day] = d.day.split("-").map(Number);
    const chip = recurringChip(month, day);
    const whenText = `<span>${esc(formatDay(d.day))}${d.time ? ` · ${esc(d.time)}` : ""}${d.recurs ? " · Ежегодно" : ""}</span>`;
    return `
      <article class="card" role="button" tabindex="0" data-action="show-in-calendar" data-day="${esc(d.day)}" aria-label="Показать в календаре">
        <div class="item-row">
          <div class="item-main">
            <h3 class="item-title">${renderRichText(d.title)}</h3>
            <div class="item-meta">
              <div class="item-when">
                ${d.isPrivate ? `<div class="item-when-line"><span class="day-chip is-private">Личное</span>${whenText}</div>` : whenText}
                <div class="item-when-row">${chip.label ? `<span class="day-chip">${esc(chip.label)}</span>` : ""}</div>
              </div>
            </div>
          </div>
          ${itemActions([
            itemActionButton({ action: "edit-item", type: "dates", id: d.id, label: "Редактировать", icon: EDIT_ICON }),
            itemActionButton({ action: "delete-item", type: "dates", id: d.id, label: "Удалить", icon: DELETE_ICON })
          ].join("\n            "))}
        </div>
      </article>`;
  }

  function birthdayCard(b) {
    const [month, day] = b.day.split("-").map(Number);
    const chip = recurringChip(month, day);
    const next = nextOccurrenceMD(month, day);
    const targetDay = dayKey(next);
    return `
      <article class="card birthday-card" role="button" tabindex="0" data-action="show-in-calendar" data-day="${esc(targetDay)}" aria-label="Показать в календаре">
        <div class="item-row">
          <div class="item-main">
            <h3 class="item-title">${renderRichText(b.title)}</h3>
            <div class="item-meta">
              ${b.isPrivate ? `<span class="day-chip is-private">Личное</span>` : ""}
              <span>${esc(formatBirthday(b.day))}</span>
              ${chip.label ? `<span class="day-chip">${esc(chip.label)}</span>` : ""}
            </div>
          </div>
          ${itemActions([
            itemActionButton({ action: "edit-item", type: "dates", id: b.id, label: "Редактировать", icon: EDIT_ICON }),
            itemActionButton({ action: "delete-item", type: "dates", id: b.id, label: "Удалить", icon: DELETE_ICON })
          ].join("\n            "))}
        </div>
      </article>`;
  }

  function memoryCard(m) {
    return `
      <article class="card memory-card" data-action="open-memory" data-id="${m.id}" role="button" tabindex="0" aria-label="Открыть запись дневника">
        <div class="item-row">
          <div class="item-main">
            ${m.title ? `<h3 class="item-title">${renderRichText(m.title)}</h3>` : ""}
            <p class="memory-body">${renderRichText(m.body)}</p>
            <div class="item-meta">
              <span class="memory-author">${esc(m.author)}</span>
              <span>· ${esc(m.date)}</span>
            </div>
          </div>
          ${itemActions([
            itemActionButton({ action: "edit-item", type: "memories", id: m.id, label: "Редактировать", icon: EDIT_ICON }),
            itemActionButton({ action: "delete-item", type: "memories", id: m.id, label: "Удалить", icon: DELETE_ICON })
          ].join("\n            "))}
        </div>
      </article>`;
  }

  function quoteCard(q) {
    return `
      <article class="card quote-card">
        <span class="quote-mark" aria-hidden="true">&ldquo;</span>
        <p class="quote-text">${renderRichText(q.text)}</p>
        ${q.source ? `<p class="quote-source">— ${esc(q.source)}</p>` : ""}
        <div class="item-row">
          <div class="item-main"><div class="item-meta"><span>${esc(q.date)}</span></div></div>
          ${itemActions([
            itemActionButton({ action: "edit-item", type: "quotes", id: q.id, label: "Редактировать", icon: EDIT_ICON }),
            itemActionButton({ action: "delete-item", type: "quotes", id: q.id, label: "Удалить", icon: DELETE_ICON })
          ].join("\n            "))}
        </div>
      </article>`;
  }

  function placeCard(p) {
    const visited = p.visited === true;
    return `
      <article class="card${visited ? " place-visited" : ""}">
        <div class="item-row">
          <div class="item-main">
            <h3 class="item-title">${esc(p.title)}</h3>
            ${p.note ? `<p class="place-note">${esc(p.note)}</p>` : ""}
            ${visited ? `<div class="item-meta"><span class="day-chip">${esc(p.visitedAt || "Посещено")}</span></div>` : ""}
          </div>
          ${itemActions([
            itemActionButton(visited
              ? { action: "place-unvisited", id: p.id, label: "Вернуть в список", icon: REOPEN_ICON }
              : { action: "place-visited", id: p.id, label: "Отметить посещённым", icon: DONE_ICON }),
            ...(p.url ? [itemActionButton({ action: "open-url", url: p.url, label: "Ссылка", icon: LINK_ICON })] : []),
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
            <h3 class="item-title">${esc(t.title)}</h3>
            ${t.note ? `<p class="place-note">${esc(t.note)}</p>` : ""}
            ${visited ? `<div class="item-meta"><span class="day-chip">${esc(t.visitedAt || "Съездили")}</span></div>` : ""}
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
            <h3 class="item-title">${esc(g.title)}</h3>
            ${g.isPrivate ? `<div class="item-meta"><span class="day-chip is-muted">Личная</span></div>` : ""}
          </div>
          ${itemActions(itemActionButton({ action: "delete-item", type: "goals", id: g.id, label: "Удалить цель", icon: DELETE_ICON }))}
        </div>
        <div class="goal-items">
          ${g.items.map((it) => `
            <div class="goal-item${it.done ? " is-done" : ""}">
              <button class="goal-item-check" type="button" data-action="${it.done ? "goal-item-reopen" : "goal-item-done"}" data-id="${it.id}" aria-label="${it.done ? "Вернуть пункт в работу" : "Отметить пункт выполненным"}">${it.done ? REOPEN_ICON : DONE_ICON}</button>
              <span class="goal-item-title">${esc(it.title)}</span>
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
  const ratingPill = (m) => scorePill(m.rating_source === "tmdb" ? "TMDB" : "IMDb", m.rating);
  const raofpPill = (m) => scorePill("RAofP", m.pair_rating);

  function movieCard(m) {
    const watched = m.watched === true;
    const genre = m.genre ? String(m.genre).split(",")[0].trim() : "";
    const yearPill = m.year ? `<span class="day-chip is-muted">${esc(m.year)}</span>` : "";
    return `
      <article class="card movie-card${watched ? " movie-watched" : ""}" data-action="open-movie" data-id="${m.id}" role="button" tabindex="0" aria-label="Открыть описание: ${esc(m.title)}">
        <div class="item-row">
          <div class="item-main">
            <h3 class="item-title">${esc(m.title)}</h3>
            ${genre || m.year ? `<div class="item-meta">${genre ? `<span class="day-chip is-muted">${esc(genre)}</span>` : ""}${yearPill}</div>` : ""}
            <div class="item-meta">
              ${ratingPill(m)}
              ${m.length ? `<span>${esc(m.length)}</span>` : ""}
              ${m.resume_position ? `<span class="day-chip is-resume" title="Точка, на которой остановились">▶ ${esc(m.resume_position)}</span>` : ""}
            </div>
            ${watched ? `<div class="item-meta">${raofpPill(m)}</div>` : ""}
            ${watched ? `<div class="item-meta"><span class="day-chip">${esc(m.watchedAt || "Просмотрено")}</span></div>` : ""}
          </div>
          ${itemActions([
            itemActionButton(watched
              ? { action: "movie-unwatched", id: m.id, label: "Вернуть в список", icon: REOPEN_ICON }
              : { action: "movie-watched", id: m.id, label: "Просмотрено", icon: DONE_ICON }),
            ...(m.url ? [itemActionButton({ action: "open-url", url: m.url, label: "Ссылка", icon: LINK_ICON })] : []),
            ...(!watched ? [
              itemActionButton({
                action: "movie-resume",
                id: m.id,
                label: m.resume_position ? "Изменить точку просмотра" : "Остановились",
                icon: RESUME_ICON
              }),
              ...(m.resume_position ? [itemActionButton({ action: "movie-resume-clear", id: m.id, label: "Сбросить точку просмотра", icon: DELETE_ICON })] : [])
            ] : []),
            itemActionButton({ action: "delete-item", type: "movies", id: m.id, label: "Удалить", icon: DELETE_ICON })
          ].join("\n            "))}
        </div>
        ${watched && m.my_rating == null ? `<button class="secondary full card-action" type="button" data-action="rate-movie" data-id="${m.id}">Оценить</button>` : ""}
      </article>`;
  }

  // wishItem/completedWishItem/savingItem — порты из app.js (вкладка «Пара»).
  function wishItem(w) {
    const canEdit = w.mine !== false;
    const hasUrl = Boolean(String(w.url || "").trim());
    const shareButtons = hasUrl
      ? [
          itemActionButton({ action: "share-wish", type: "wishes", id: w.id, part: "name", label: "Скопировать название", icon: LINK_TEXT_ICON }),
          itemActionButton({ action: "share-wish", type: "wishes", id: w.id, part: "url", label: "Скопировать ссылку", icon: LINK_TEXT_ICON }),
          itemActionButton({ action: "share-wish", type: "wishes", id: w.id, part: "all", label: "Скопировать все", icon: COPY_ICON })
        ]
      : [
          itemActionButton({ action: "share-wish", type: "wishes", id: w.id, part: "name", label: "Скопировать название", icon: LINK_TEXT_ICON })
        ];
    const actions = [
      ...shareButtons,
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
            <h3 class="item-title">${renderRichText(w.body)}</h3>
            ${w.comment ? `<div class="wish-comment">${renderRichText(w.comment)}</div>` : ""}
          </div>
          ${itemActions(actions)}
        </div>
        ${w.url ? `<button class="secondary full card-action" type="button" data-action="open-url" data-url="${esc(w.url)}">Ссылка</button>` : ""}
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
            <h3 class="item-title" style="text-decoration:line-through;">${renderRichText(w.body)}</h3>
            ${w.comment ? `<div class="wish-comment">${renderRichText(w.comment)}</div>` : ""}
            <div class="item-meta"><span class="day-chip is-muted">${esc(w.created)}</span><span class="day-chip">${esc(w.doneAt)}</span></div>
          </div>
          ${itemActions(actions)}
        </div>
        ${w.url ? `<button class="secondary full card-action" type="button" data-action="open-url" data-url="${esc(w.url)}">Ссылка</button>` : ""}
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
      <article class="card${full ? " saving-full" : ""}" data-action="open-saving" data-id="${s.id}"
        role="button" tabindex="0" aria-label="История пополнений копилки «${esc(s.title)}»">
        <div class="item-row">
          <div class="item-main">
            <h3 class="item-title">${esc(s.title)}</h3>
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
    pair: { title: "Наша пара", sub: "Профиль, желания, копилка и Фло" }
  };

  // ------------------------------------------------------------------
  // Данные демо — «живые» даты считаются от сегодня посетителя.
  // ------------------------------------------------------------------
  const TASKS = [
    { id: 1, title: "Выбрать фильм на вечер", day: todayMidnight(), time: "20:00", chip: "Сегодня", chipClass: " is-countdown" },
    { id: 2, title: "Забронировать столик", day: offsetDate(1), time: "19:30", chip: "Завтра", chipClass: " is-countdown" },
    { id: 3, title: "Вечер вдвоём", day: saturday },
    { id: 4, title: "Собраться на дачу", day: offsetDate(7), isPrivate: true }
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
    { id: 32, title: "Оппенгеймер", genre: "Драма", year: "2023", rating: "8.4", length: "3 ч 0 мин", kind: "movie", created: 304, resume_position: "1:23:45" },
    { id: 33, title: "Кролик Джоджо", genre: "Комедия", year: "2019", rating: "7.9", length: "1 ч 59 мин", kind: "series", created: 303, resume_position: "2 сезон, 5 серия · 34:12" }
  ];
  const MOVIES_WATCHED = [
    { id: 34, title: "Паразиты", genre: "Триллер", year: "2019", rating: "8.6", length: "2 ч 12 мин", kind: "movie", created: 210, pair_rating: 9, my_rating: 9, watched: true, watchedAt: "Просмотрено 20 янв" },
    { id: 35, title: "Сто лет тому вперёд", genre: "Фантастика", year: "2023", rating: "7.6", length: "2 ч 18 мин", kind: "movie", created: 208, pair_rating: 0, my_rating: null, watched: true, watchedAt: "Просмотрено 2 фев" }
  ];
  const DATES = [
    { id: 41, title: "Годовщина", day: "2027-02-14", time: "", recurs: true },
    { id: 42, title: "День рождения дедушки", day: "2027-02-28", time: "", recurs: true, isPrivate: true },
    { id: 43, title: "Первая встреча", day: "2027-03-03", time: "", recurs: true }
  ];
  const BIRTHDAYS = [
    { id: 51, title: "День рождения Ани", day: `${new Date().getFullYear() + 1}-03-12` },
    { id: 52, title: "День рождения Максима", day: `${new Date().getFullYear() + 1}-09-03` }
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
  // Личный журнал препаратов — как renderHealthBody() в app.js.
  const MEDS = [
    { id: 81, name: "Магний", form: "tablet", dosage: "1 таблетка", schedule: "2 раза в день", start_date: "2026-09-01", end_date: "", status: "active", taken: 14, skipped: 1, today: "taken" },
    { id: 82, name: "Витамин D3", form: "capsule", dosage: "1 капсула", schedule: "1 раз в день", start_date: "2026-10-15", end_date: "", status: "active", taken: 22, skipped: 0, today: null }
  ];
  const HEALTH_MED_FORMS = { tablet: "таблетка", capsule: "капсула", injection: "укол", patch: "пластырь", iud: "спираль", other: "прочее" };
  const HEALTH_MED_STATUS_LABELS = { active: "активен", paused: "пауза", completed: "завершён" };
  const CONTACTS_MINE = [
    { id: 91, name: "Мама", surname: "Иванова", phones: ["+7 915 123 45 67"], comment: "" },
    { id: 92, name: "Стоматология «Улыбка»", surname: "", phones: ["+7 495 123 45 67", "+7 495 765 43 21"], comment: "Запись раз в полгода" },
    { id: 93, name: "Кафе «Тихий двор»", surname: "", phones: ["+7 495 987 65 43"], comment: "" }
  ];
  const CONTACTS_PARTNER = [
    { id: 94, name: "Брат", surname: "Максимов", phones: ["+7 903 555 44 33"], comment: "" },
    { id: 95, name: "Фитнес-клуб «Вектор»", surname: "", phones: ["+7 495 111 22 33"], comment: "Абонемент до марта" }
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

  // ------------------------------------------------------------------
  // Фло: статичная модель цикла, привязанная к «сегодня» посетителя.
  // Упрощённый порт renderFloView()/renderFloToday()/renderFloCalendar().
  // ------------------------------------------------------------------
  const FLO_PHASE_LABELS = {
    menstruation: "Менструация", follicular: "Фолликулярная", fertile: "Фертильное окно",
    ovulation: "Овуляция", luteal: "Лютеиновая", delay: "Задержка", stale: "Данные устарели"
  };
  const FLO_PERIOD_LEN = 5;
  const FLO_CYCLE_LEN = 28;
  const floLastStart = offsetDate(-14);          // прошлое начало месячных (14 дней назад)
  const floNextStart = addDays(floLastStart, FLO_CYCLE_LEN);
  const floOvulation = addDays(floNextStart, -14);
  const floInRange = (d, a, b) => d >= a && d <= b;
  const floDayKey = (d) => dayKey(d);
  function floDayKind(key) {
    const d = keyToDate(key);
    if (floInRange(d, floLastStart, addDays(floLastStart, FLO_PERIOD_LEN - 1))) return "period";
    if (floInRange(d, floNextStart, addDays(floNextStart, FLO_PERIOD_LEN - 1))) return "predicted";
    if (d.getTime() === floOvulation.getTime()) return "ovulation";
    if (floInRange(d, addDays(floOvulation, -4), addDays(floOvulation, -1))) return "fertile";
    return "";
  }
  // Дневник выбранных дней — пара статичных записей.
  const FLO_LOGS = (() => {
    const map = new Map();
    const periodDay = dayKey(offsetDate(-14));
    map.set(periodDay, { flow: "medium", mood: "calm", symptoms: ["cramps", "fatigue"], sex: 0, note: "Первый день, обычные ощущения." });
    const today = dayKey(todayMidnight());
    map.set(today, { flow: null, mood: "happy", symptoms: ["good_sleep"], sex: 1, note: "Хороший день, вечером прогулка." });
    return map;
  })();
  const FLO_SYMPTOMS = { cramps: "судороги", headache: "голова", bloating: "вздутие", fatigue: "усталость", good_sleep: "хороший сон", nausea: "тошнота", back_pain: "спина" };
  const FLO_MOODS = { happy: "радость", calm: "спокойствие", sensitive: "чувствительность", irritable: "раздражительность", anxious: "тревожность", sad: "грусть" };
  const FLO_FLOWS = { spotting: "мажь", light: "слабые", medium: "средние", heavy: "сильные" };

  function floDayClasses(key, inMonth) {
    const classes = [];
    if (!inMonth) classes.push("is-outside");
    if (key === dayKey(todayMidnight())) classes.push("is-today");
    const kind = floDayKind(key);
    if (kind === "period") classes.push("is-period");
    if (kind === "predicted") classes.push("is-predicted");
    if (kind === "fertile") classes.push("is-fertile");
    if (kind === "ovulation") classes.push("is-ovulation");
    if (FLO_LOGS.has(key)) classes.push("has-events");
    if (key === state.floSelected) classes.push("is-selected");
    return classes;
  }

  function floDayDots(key) {
    const kind = floDayKind(key);
    const dots = [];
    if (kind === "period" || kind === "predicted" || kind === "fertile" || kind === "ovulation") {
      dots.push(`<i class="cal-dot is-${kind === "predicted" ? "predicted" : kind === "fertile" ? "fertile" : kind === "ovulation" ? "ovulation" : "period"}" aria-hidden="true"></i>`);
    }
    const log = FLO_LOGS.get(key);
    if (log) {
      dots.push(`<i class="cal-dot is-log" aria-hidden="true"></i>`);
      for (let i = 0; i < Math.min(log.sex || 0, 3); i++) dots.push(`<span class="cal-heart" aria-hidden="true">♥</span>`);
      if ((log.sex || 0) > 3) dots.push(`<span class="cal-sex-more">+${log.sex - 3}</span>`);
    }
    return dots.join("");
  }

  function floDayEventRows(key) {
    const rows = [];
    const kind = floDayKind(key);
    const d = keyToDate(key);
    if (kind === "period") rows.push({ icon: "period", title: "Месячные", meta: "факт · 5 дн. по истории" });
    if (kind === "predicted") rows.push({ icon: "predicted", title: "Прогноз месячных", meta: "расчёт по истории циклов" });
    if (kind === "fertile") rows.push({ icon: "fertile", title: "Фертильное окно", meta: "календарная оценка" });
    if (kind === "ovulation") rows.push({ icon: "ovulation", title: "Овуляция", meta: "календарная оценка (старт минус 14 дней)" });
    const log = FLO_LOGS.get(key);
    if (log) {
      if (log.flow) rows.push({ icon: "log", title: `Кровотечение: ${FLO_FLOWS[log.flow] || log.flow}`, meta: "запись дня" });
      if (log.mood) rows.push({ icon: "log", title: `Настроение: ${FLO_MOODS[log.mood] || log.mood}`, meta: "запись дня" });
      const syms = (log.symptoms || []).map(s => FLO_SYMPTOMS[s] || s);
      if (syms.length) rows.push({ icon: "log", title: `Симптомы: ${syms.join(", ")}`, meta: "запись дня" });
      if (log.sex) rows.push({ icon: "heart", title: `Секс ×${log.sex}`, meta: "отметка дня" });
      if (log.note) rows.push({ icon: "log", title: log.note, meta: "заметка" });
    }
    return rows;
  }

  function calendarMonthTitle(year, month) {
    return `${MONTHS_RU[month]} ${year}`;
  }
  function calendarLongDate(key) {
    const d = keyToDate(key);
    return `${WEEKDAYS[d.getDay()]}, ${pad(d.getDate())}.${pad(d.getMonth() + 1)}.${d.getFullYear()}`;
  }

  function floForecastCard() {
    const cycleDay = Math.max(1, diffDays(todayMidnight(), floLastStart) + 1);
    let phase = "luteal";
    if (cycleDay <= FLO_PERIOD_LEN) phase = "menstruation";
    else if (cycleDay <= 13) phase = "follicular";
    else if (cycleDay <= 18) phase = "fertile";
    else if (cycleDay <= 20) phase = "ovulation";
    const lines = [
      `<b>День ${cycleDay} цикла</b> · ${esc(FLO_PHASE_LABELS[phase] || "")}`,
      `Месячные ориентировочно ${esc(formatDay(floNextStart))} — ${esc(formatDay(addDays(floNextStart, FLO_PERIOD_LEN - 1)))}`,
      `Ожидаемая продолжительность: ${FLO_PERIOD_LEN} дн.`,
      `Предполагаемое окончание: ${esc(formatDay(addDays(floNextStart, FLO_PERIOD_LEN - 1)))}`,
      `Расчёт по 6 завершённым циклам. Последнее начало месячных отмечено ${esc(formatDay(floLastStart))}.`,
      `Овуляция — календарная оценка (старт минус 14 дней), не подтверждена наблюдениями.`
    ];
    return `
      <section class="card flo-today">
        ${lines.map(l => `<p class="flo-line">${l}</p>`).join("")}
        <button type="button" class="primary full card-action" data-action="flo-period-start">Отметить месячные</button>
        <button type="button" class="secondary full card-action" data-action="flo-record-today">Записать сегодня</button>
        <p class="flo-sub">Свежесть данных</p>
        <p class="flo-line">Месячные: ${esc(formatDay(floLastStart))} · Дневник: ${esc(dayKey(offsetDate(-1)))} · Измерения: нет записей · Препараты: нет записей</p>
        <details class="flo-fold flo-forecast">
          <summary class="flo-fold-title">Как считается прогноз?</summary>
          <ul class="flo-explain">
            <li>Прогноз строится по личной истории циклов: даты начал и длительность месячных.</li>
            <li>Фертильное окно и овуляция — календарные оценки, не подтверждённые наблюдениями.</li>
            <li>Календарные прогнозы не являются надёжным методом контрацепции.</li>
          </ul>
        </details>
        <p class="flo-disclaimer">Прогноз не является медицинской рекомендацией. Календарные прогнозы не являются надёжным методом предотвращения беременности.</p>
      </section>`;
  }

  function floCalendarCard() {
    const base = new Date();
    const viewDate = new Date(base.getFullYear(), base.getMonth() + state.floOffset, 1);
    const year = viewDate.getFullYear();
    const month = viewDate.getMonth();
    const cells = calendarCells(year, month).map((cell) => {
      const classes = ["cal-day", ...floDayClasses(cell.key, cell.inMonth)];
      const dots = floDayDots(cell.key);
      return `<button type="button" class="${classes.join(" ")}" data-action="flo-select-day" data-date="${cell.key}"
        aria-label="${esc(calendarLongDate(cell.key))}${dots ? ", есть запись" : ""}">
        <span class="cal-num">${cell.day}</span>
        ${dots ? `<span class="cal-dots" aria-hidden="true">${dots}</span>` : ""}
      </button>`;
    }).join("");
    const sel = state.floSelected || dayKey(todayMidnight());
    const rows = floDayEventRows(sel);
    return `
      <section class="card calendar-card">
        <div class="cal-head">
          <button type="button" class="cal-nav-btn" data-action="flo-month-prev" aria-label="Предыдущий месяц">${CHEVRON_LEFT}</button>
          <h3 class="cal-title">${esc(calendarMonthTitle(year, month))}</h3>
          <button type="button" class="cal-nav-btn" data-action="flo-month-next" aria-label="Следующий месяц">${CHEVRON_RIGHT}</button>
        </div>
        <div class="cal-weekdays" aria-hidden="true">${WEEKDAYS_CAL.map(w => `<span>${w}</span>`).join("")}</div>
        <div class="cal-grid">${cells}</div>
        <div class="cal-legend">
          <span><i class="cal-dot is-period" aria-hidden="true"></i>Месячные</span>
          <span><i class="cal-dot is-predicted" aria-hidden="true"></i>Прогноз</span>
          <span><i class="cal-dot is-fertile" aria-hidden="true"></i>Фертильно (расчёт)</span>
          <span><i class="cal-dot is-ovulation" aria-hidden="true"></i>Овуляция (расчёт)</span>
          <span><i class="cal-dot is-log" aria-hidden="true"></i>Запись</span>
          <span><span class="cal-heart" aria-hidden="true">♥</span>Секс</span>
        </div>
        <div class="cal-events">
          <p class="cal-events-date">${esc(calendarLongDate(sel))}</p>
          ${rows.length ? rows.map(row => `
            <div class="cal-event">
              ${row.icon === "heart" ? `<span class="cal-heart" aria-hidden="true">♥</span>` : `<i class="cal-dot ${row.icon === "period" ? "is-period" : row.icon === "predicted" ? "is-predicted" : row.icon === "fertile" ? "is-fertile" : row.icon === "ovulation" ? "is-ovulation" : "is-log"}" aria-hidden="true"></i>`}
              <div class="cal-event-body">
                <span class="cal-event-title">${esc(row.title)}</span>
                <span class="cal-event-meta">${esc(row.meta)}</span>
              </div>
            </div>`).join("") : `<p class="cal-empty">Записей нет.</p>`}
        </div>
      </section>`;
  }

  function floTodayBody() {
    return `${floForecastCard()}${floCalendarCard()}`;
  }

  // Упрощённые под-вкладки «Фло»: история, статистика, препараты, настройки.
  function floCycleBody() {
    const rows = [
      { start: offsetDate(-41), end: offsetDate(-36), len: 28 },
      { start: offsetDate(-13), end: null, len: null },
      { start: offsetDate(-69), end: offsetDate(-64), len: 27 },
      { start: offsetDate(-97), end: offsetDate(-91), len: 29 }
    ];
    return `
      <section class="card">
        <p class="eyebrow flo-group">История циклов</p>
        <h3>Циклы</h3>
        ${rows.map(r => `
          <p class="flo-line">${esc(formatDay(r.start))} — ${r.end ? esc(formatDay(r.end)) : "идут"}${r.len ? ` · ${r.len} дн.` : ""}</p>`).join("")}
        <p class="flo-disclaimer">Длина цикла считается от начала месячных до начала следующих. Прогнозы опираются на эти записи.</p>
      </section>`;
  }

  function floStatsBody() {
    return `
      <section class="card">
        <p class="eyebrow flo-group">Статистика</p>
        <h3>Ваш цикл в цифрах</h3>
        <p class="flo-line"><b>Средняя длина цикла:</b> 28 дн.</p>
        <p class="flo-line"><b>Средняя длительность месячных:</b> 5 дн.</p>
        <p class="flo-line"><b>Регулярность:</b> стабильная (разброс ±1 день)</p>
        <p class="flo-line"><b>Записей в дневнике:</b> 12 дней за 3 месяца</p>
        <p class="flo-disclaimer">Статистика считается по вашим фактическим отметкам. Прогнозы не являются медицинской рекомендацией.</p>
      </section>`;
  }

  function floMedsBody() {
    return `
      <button class="primary full add-button" type="button" data-action="flo-med-new">Добавить препарат</button>
      <section class="card">
        ${MEDS.map(m => `
          <div class="flo-med-row">
            <p class="item-title">${esc(m.name)}</p>
            <p class="item-meta">${esc(HEALTH_MED_FORMS[m.form] || m.form)} · ${esc(m.dosage)} · ${esc(m.schedule)}</p>
          </div>`).join("")}
        <p class="flo-disclaimer">Состав и дозы — в «Моих препаратах» в настройках. Приложение не назначает и не отменяет приём</p>
      </section>`;
  }

  function floSettingsBody() {
    return `
      <section class="card">
        <p class="eyebrow flo-group">Отчёт и экспорт</p>
        <button type="button" class="secondary full card-action" data-action="flo-report-open">Медицинский отчёт</button>
        <p class="flo-disclaimer">Сохранение/Печать в PDF — через диалог печати браузера</p>
      </section>
      <section class="card">
        <p class="eyebrow flo-group">Шеринг</p>
        <h3>Календарь для партнёра</h3>
        <p class="flo-line">Партнёр видит только факт месячных — без симптомов, заметок и измерений.</p>
        <p class="settings-hint">Доступ открывается после первого подтверждённого дня цикла с его стороны</p>
      </section>`;
  }

  const FLO_SECTIONS = { today: floTodayBody, cycle: floCycleBody, stats: floStatsBody, meds: floMedsBody, settings: floSettingsBody };
  function floSection() {
    return FLO_SECTIONS[state.views.flo]();
  }
  function floBody() {
    return segSwitch("flo", state.views.flo, [["today", "Сегодня"], ["cycle", "Цикл"], ["stats", "Статистика"], ["meds", "Препараты"], ["settings", "Настройки"]], "is-sub")
      + `<div class="seg-body" id="seg-body-flo">${floSection()}</div>`;
  }

  // ------------------------------------------------------------------
  // «Наша пара»: профиль (календарь + настройки), желания, копилка, Фло.
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
              <span class="cal-event-title">${esc(ev.title)}</span>
              <span class="cal-event-meta">${CAL_KIND_LABEL[ev.kind]}${ev.isPrivate ? " · личное" : ""}${ev.note ? ` · ${esc(ev.note)}` : ""}${ev.time ? ` · ${esc(ev.time)}` : ""}</span>
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
  // пользователя: акцент berry, сводки включены, владелица видит «Месячные
  // в основном календаре» включёнными).
  const ACCENT_SWATCHES = [
    ["berry", "#b85464"], ["sage", "#55766a"], ["ocean", "#4a6f8f"],
    ["violet", "#7a5f9e"], ["amber", "#9a5a24"]
  ];
  function pairSettingsCard() {
    const swatches = ACCENT_SWATCHES.map(([key, color], i) => `
      <button class="swatch${i === 0 ? " is-active" : ""}" type="button" style="background:${color}" aria-label="Акцентный цвет: ${key}" data-action="set-accent" data-accent="${key}"></button>`).join("");
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
        <p class="settings-hint">Фото профиля Telegram вместо букв в кнопке пары. Если у пользователя фото нет, остаётся буква, пока аватар не появится</p>
        <label class="settings-row">
          <span class="settings-label"><input type="checkbox" checked> Месячные в основном календаре</span>
        </label>
        <p class="settings-hint">Отметки месячных в общем календаре — только фактические дни</p>
        <div class="settings-row">
          <span class="settings-label">Ваше имя</span>
          <input type="text" maxlength="80" autocomplete="off" placeholder="Аня" value="">
        </div>
        <p class="settings-hint">Как ваше имя отображается у вас в приложении — например, если в Telegram у вас ник. Меняется только у вас. Пусто — имя из Telegram</p>
        <div class="settings-row">
          <span class="settings-label">Имя партнёра</span>
          <input type="text" maxlength="80" autocomplete="off" placeholder="Максим" value="">
        </div>
        <p class="settings-hint">Каким вы видите имя партнёра в приложении — например, если в Telegram у него ник. Меняется только у вас. Пусто — имя партнёра из Telegram</p>
        <div class="settings-row">
          <span class="settings-label">Ваш часовой пояс</span>
          <span class="day-chip is-muted">${esc(tz)}</span>
        </div>
        <p class="settings-hint">Определяется по устройству автоматически и следует за вами в поездках: сводки приходят по вашим часам, календарь показывает ваше «сегодня»</p>
        <label class="settings-row">
          <span class="settings-label"><input type="checkbox" checked> Утренняя сводка</span>
          <input type="time" value="09:00">
        </label>
        <p class="settings-hint">Планы и значимые даты на сегодня и завтра — личным сообщением от бота. Время — местное: сводка придёт в ваш часовой пояс</p>
        <label class="settings-row">
          <span class="settings-label"><input type="checkbox" checked> Даты за сутки</span>
          <input type="time" value="09:00">
        </label>
        <p class="settings-hint">Напомнит о завтрашних датах накануне в выбранное время. Кроме сводок бот предупреждает о плане с точным временем за 3 часа и за час</p>
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
        <p class="settings-hint">Планы и даты на предстоящую неделю (пн–вс) одним сообщением — чтобы строить планы наперёд. Придёт в выбранный день и время по вашим часам</p>
        <div class="settings-row">
          <span class="settings-label">Тема</span>
          <div class="theme-switch">
            <button class="theme-option is-active" type="button" data-action="set-theme" data-theme="system">Как в системе</button>
            <button class="theme-option" type="button" data-action="set-theme" data-theme="dark">Тёмная</button>
            <button class="theme-option" type="button" data-action="set-theme" data-theme="light">Светлая</button>
          </div>
        </div>
        <div style="margin-top:18px; display:grid; gap:8px;">
          <button class="secondary full" type="button" data-action="save-settings">Сохранить настройки</button>
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
        <button class="secondary full card-action" type="button" data-action="save-pin">Задать</button>
      </section>`;
  }

  function pairTimezoneCard() {
    const current = Intl.DateTimeFormat().resolvedOptions().timeZone || "Europe/Moscow";
    const zones = [...new Set([current, "Europe/Moscow", "Europe/Kaliningrad", "Europe/Samara", "Asia/Yekaterinburg", "Asia/Novosibirsk", "Europe/Kyiv", "Europe/Minsk", "Europe/Warsaw", "Europe/Berlin", "Asia/Almaty", "UTC"])];
    return `
      <section class="card">
        <p class="eyebrow">Общее</p>
        <h3>Часовой пояс</h3>
        <select class="settings-select">${zones.map((z) => `<option${z === current ? " selected" : ""}>${esc(z.replace(/_/g, " "))}</option>`).join("")}</select>
        <p class="settings-hint">Общий для календаря, ритуала дня, напоминаний и времени событий у обоих партнёров — события закреплены за этим поясом. Личное «сегодня» и время сводок — по вашему поясу устройства</p>
        <button class="secondary full card-action" type="button" data-action="save-pair-timezone">Сохранить пояс</button>
      </section>`;
  }

  function pairExportCard() {
    return `
      <section class="card">
        <p class="eyebrow">Резервная копия</p>
        <h3>Экспорт данных</h3>
        <p class="settings-hint">Выберите разделы — бот пришлёт один файл с выбранным. Удобно хранить вне приложения</p>
        <button class="secondary full card-action" type="button" data-action="export-data">Экспортировать</button>
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
        <button class="secondary pair-leave" type="button" data-action="leave-pair">Выйти из пространства</button>
      </div>`;
  }

  // ------------------------------------------------------------------
  // Здоровье («Дневник → Здоровье») — порт renderHealthBody().
  // ------------------------------------------------------------------
  function healthBody() {
    if (!MEDS.length) {
      return `<section class="card"><h3>Пока пусто</h3>
        <p>Личный журнал: препараты и приём не видны партнёру</p>
        <div style="margin-top:12px;"><button class="primary full card-action" type="button" data-action="health-med-new">Добавить препарат</button></div>
      </section>`;
    }
    const rows = MEDS.map((m) => {
      const statusLabel = HEALTH_MED_STATUS_LABELS[m.status] || m.status;
      const meta = [m.dosage, m.schedule, HEALTH_MED_FORMS[m.form] || ""].filter(Boolean).join(" · ");
      const chips = m.status === "active" ? `
        <div class="health-intake">
          <button type="button" class="primary full card-action${m.today === "taken" ? " is-on" : ""}" data-action="health-intake" data-med="${m.id}" data-status="taken">Принят</button>
          <button type="button" class="secondary full card-action${m.today === "skipped" ? " is-on" : ""}" data-action="health-intake" data-med="${m.id}" data-status="skipped">Пропущен</button>
          ${m.today ? `<button type="button" class="flo-chip" data-action="health-intake-clear" data-med="${m.id}">Снять отметку</button>` : ""}
        </div>` : "";
      return `<div class="item-row">
        <div class="item-main">
          <h3 class="health-med-name">${esc(m.name)}</h3>
          <div class="item-meta"><span class="day-chip is-muted">${esc(statusLabel)}</span><span>${esc(meta)}</span></div>
          <div class="item-meta"><span>${esc(m.start_date || "")}${m.end_date ? ` — ${esc(m.end_date)}` : ""}</span><span>принято ${m.taken} · пропущено ${m.skipped}</span></div>
          ${chips}
        </div>
        <button class="icon-btn" type="button" data-action="edit-item" data-type="health_meds" data-id="${m.id}" aria-label="Изменить">${EDIT_ICON}</button>
      </div>`;
    }).join("");
    return `
      <button class="primary full add-button" type="button" data-action="health-med-new">Добавить препарат</button>
      <section class="card">
        ${rows}
        <p class="flo-disclaimer">Отметка «принят/пропущен» — общий итог за день, контроль отдельных доз не ведётся. Приложение не назначает лечение</p>
      </section>`;
  }

  // ------------------------------------------------------------------
  // Контакты («Дневник → Контакты») — порт renderContactsBody()/
  // renderContactsContent(): переключатель «Мои/Его», книга одной картой.
  // ------------------------------------------------------------------
  function contactsContentHtml() {
    const isMine = state.contactsView === "mine";
    const list = isMine ? CONTACTS_MINE : CONTACTS_PARTNER;
    const addButton = `<button class="primary full card-action" type="button" data-action="add-contact">Добавить контакт</button>`;
    if (!list.length) {
      return isMine
        ? `<section class="card"><h3>Пока пусто</h3>
            <p>Имена и номера всегда под рукой — и ваши, и партнёра</p>
            <div style="margin-top:12px;">${addButton}</div>
          </section>`
        : `<section class="card"><h3>Пока пусто</h3><p>У партнёра контактов пока пусто</p></section>`;
    }
    return `
      ${isMine ? addButton : ""}
      <section class="card contact-card">
        ${list.map((c) => `
          <div class="contact-item">
            <button class="contact-name" type="button" data-action="contact-open" data-id="${c.id}">
              ${esc(c.name)}${c.surname ? ` <span class="contact-surname">${esc(c.surname)}</span>` : ""}
            </button>
            <div class="contact-phones">
              ${(c.phones || []).map((phone) => `
                <button class="contact-phone" type="button" data-action="contacts-copy" data-phone="${esc(phone)}">${esc(phone)}</button>`).join("")}
            </div>
            ${c.comment ? `<p class="contact-comment">${esc(c.comment)}</p>` : ""}
          </div>`).join("")}
      </section>`;
  }

  function contactsBody() {
    const isMine = state.contactsView === "mine";
    return `
      <div class="contacts-switch" role="tablist" aria-label="Чьи контакты показывать">
        <button class="contacts-switch-btn${isMine ? " is-active" : ""}" type="button" role="tab" aria-selected="${isMine}" data-action="contacts-view" data-view="mine" data-tab="mine">Мои</button>
        <button class="contacts-switch-btn${!isMine ? " is-active" : ""}" type="button" role="tab" aria-selected="${!isMine}" data-action="contacts-view" data-view="partner" data-tab="partner">Его</button>
      </div>
      <div class="seg-body" id="seg-body-contacts">${contactsContentHtml()}</div>`;
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
      if (!open.length) {
        return `<section class="card">
          <h3>Желание</h3>
          <p>Поделитесь идеями подарков и маленькими мечтами</p>
          <div style="margin-top:12px;">
            <button class="primary full" type="button" data-action="add-wish">Добавить желание</button>
          </div>
        </section>`;
      }
      return `<button class="primary full add-button" type="button" data-action="add-wish">Добавить желание</button>` + open.map(wishItem).join("");
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
    const addButton = `<button class="primary full add-button" type="button" data-action="add-saving">Создать копилку</button>`;
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
    if (v === "flo") return floBody();
    return pairProfileBody();
  }

  function pairBody() {
    return segSwitch("pair", state.views.pair, [["profile", "Профиль"], ["wishes", "Желания"], ["savings", "Копилка"], ["flo", "Фло"]])
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
    savings: savingsListHtml,
    flo: floSection,
    contacts: contactsContentHtml
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
    const partnerDone = false;
    return `
      <section class="card hero-card" role="button" tabindex="0" data-action="open-history" aria-label="История пары и рекорд серии">
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
        <h3>${esc(action)}</h3>
        <p id="demo-ritual-copy">${done ? `Вы отметили ритуал +10 XP${partnerDone ? " · партнёр тоже отметил" : ""}` : (partnerDone ? "Партнёр уже отметил ритуал — отметьте и вы" : "Отметьте ритуал дня и получите +10 XP")}</p>
        ${done ? "" : `<div style="margin-top:18px;"><button class="primary full" type="button" id="demo-ritual">Выполнено +10 XP</button></div>`}
      </section>

      ${TASKS.slice(0, 3).map(taskCard).join("") ? `
      <div class="section-head-inline"><h3>Ближайшие планы</h3></div>
      ${TASKS.slice(0, 3).map(taskCard).join("")}` : ""}

      ${DATES.slice(0, 2).map(dateCard).join("") ? `
      <div class="section-head-inline"><h3>Значимые даты</h3></div>
      ${DATES.slice(0, 2).map(dateCard).join("")}` : ""}

      ${BIRTHDAYS.slice(0, 1).map(birthdayCard).join("") ? `
      <div class="section-head-inline"><h3>Дни рождения</h3></div>
      ${BIRTHDAYS.slice(0, 1).map(birthdayCard).join("")}` : ""}

      ${memoryCard(MEMORIES[0]) ? `
      <div class="section-head-inline"><h3>Из дневника</h3></div>
      ${memoryCard(MEMORIES[0])}` : ""}`;
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

  // DOM-контракты лендинга: экран демо, нижний бар с SVG-каплей и часы
  // статусбара iPhone. Без них демо не запускаем.
  const view = document.getElementById("demo-view");
  const nav = document.querySelector(".demo-screen .bottom-nav");
  const clockEl = document.getElementById("demo-clock");
  if (!view || !nav || !clockEl || typeof window.createLiquidNav !== "function") return;

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

  // ------------------------------------------------------------------
  // Действия демо. Каждая видимая кнопка либо меняет demo-state в памяти
  // (DEMO_ACTIONS), либо явно отвечает тостом с причиной (DEMO_INERT) —
  // молча неработающих элементов нет. API не вызывается, данные не
  // сохраняются: всё живёт до перезагрузки страницы.
  // Полноту покрывает tests/test_demo_actions.test.mjs.
  // ------------------------------------------------------------------
  const MONTHS_SHORT = ["янв", "фев", "мар", "апр", "мая", "июн", "июл", "авг", "сен", "окт", "ноя", "дек"];
  const todayDMLabel = `${new Date().getDate()} ${MONTHS_SHORT[new Date().getMonth()]}`;

  const toastEl = document.createElement("div");
  toastEl.className = "demo-toast";
  toastEl.setAttribute("role", "status");
  view.parentElement.appendChild(toastEl);
  let toastTimer = null;
  function toast(msg) {
    toastEl.textContent = msg;
    toastEl.classList.add("is-show");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toastEl.classList.remove("is-show"), 1700);
  }

  // Перерисовать только блок, в котором нажали: ближайший .seg-body,
  // иначе — весь экран (карточки главной). Скролл сохраняем.
  function refreshAround(el) {
    const st = view.scrollTop;
    const bodyEl = el && el.closest(".seg-body");
    const key = bodyEl && bodyEl.id ? bodyEl.id.replace("seg-body-", "") : null;
    if (bodyEl && SEG_BODIES[key]) {
      bodyEl.innerHTML = SEG_BODIES[key]();
      mountSwitches(bodyEl);
    } else {
      render();
    }
    view.scrollTop = st;
  }

  const findById = (arr, id) => arr.find((x) => Number(x.id) === Number(id));
  const ALL_LISTS = [
    TASKS, DONE_TASKS, DATES, BIRTHDAYS, MEMORIES, QUOTES, MEDS, CONTACTS_MINE, CONTACTS_PARTNER,
    PLACES_VISIT, PLACES_VISITED, TRIPS, MOVIES_OPEN, MOVIES_WATCHED,
    WISHES_OPEN_MINE, WISHES_OPEN_PARTNER, WISHES_DONE_MINE, WISHES_DONE_PARTNER,
    SAVINGS
  ];
  const WISH_PAIRS = [
    [WISHES_OPEN_MINE, WISHES_DONE_MINE],
    [WISHES_OPEN_PARTNER, WISHES_DONE_PARTNER]
  ];

  function moveTask(id, done) {
    const src = done ? TASKS : DONE_TASKS;
    const dst = done ? DONE_TASKS : TASKS;
    const i = src.findIndex((t) => Number(t.id) === Number(id));
    if (i < 0) return;
    const [t] = src.splice(i, 1);
    dst.push(done ? { ...t, meta: `Выполнено ${todayDMLabel}` } : t);
  }

  function moveWish(id, done) {
    for (const [open, doneArr] of WISH_PAIRS) {
      if (done) {
        const i = open.findIndex((w) => Number(w.id) === Number(id));
        if (i < 0) continue;
        const [w] = open.splice(i, 1);
        doneArr.push({ ...w, created: todayDMLabel, doneAt: todayDMLabel });
        return;
      }
      const j = doneArr.findIndex((w) => Number(w.id) === Number(id));
      if (j < 0) continue;
      const [w] = doneArr.splice(j, 1);
      open.push(w);
      return;
    }
  }

  function removeDemoItem(type, id) {
    if (type === "goals") {
      const i = GOALS.findIndex((g) => Number(g.id) === Number(id));
      if (i >= 0) GOALS.splice(i, 1);
      return;
    }
    for (const arr of ALL_LISTS) {
      const i = arr.findIndex((x) => Number(x.id) === Number(id));
      if (i >= 0) { arr.splice(i, 1); return; }
    }
  }

  function setPlaceVisited(id, visited) {
    const src = visited ? PLACES_VISIT : PLACES_VISITED;
    const dst = visited ? PLACES_VISITED : PLACES_VISIT;
    const i = src.findIndex((p) => Number(p.id) === Number(id));
    if (i < 0) return;
    const [p] = src.splice(i, 1);
    dst.push(visited ? { ...p, visited: true, visitedAt: `Посещено ${todayDMLabel}` } : { ...p, visited: false });
    if (state.placePick === Number(id)) state.placePick = null;
  }

  function setTripVisited(id, visited) {
    const t = findById(TRIPS, id);
    if (!t) return;
    t.visited = visited;
    t.visitedAt = visited ? `Съездили ${todayDMLabel}` : undefined;
  }

  function setMovieWatched(id, watched) {
    const src = watched ? MOVIES_OPEN : MOVIES_WATCHED;
    const dst = watched ? MOVIES_WATCHED : MOVIES_OPEN;
    const i = src.findIndex((m) => Number(m.id) === Number(id));
    if (i < 0) return;
    const [m] = src.splice(i, 1);
    dst.push(watched
      ? { ...m, watched: true, watchedAt: `Просмотрено ${todayDMLabel}`, my_rating: null, resume_position: null }
      : { ...m, watched: false, my_rating: null });
    if (watched && state.moviePick === Number(id)) state.moviePick = null;
  }

  function toggleGoalItem(id, done) {
    for (const g of GOALS) {
      const it = g.items.find((x) => Number(x.id) === Number(id));
      if (it) { it.done = done; return; }
    }
  }

  function pickRandomPlace() {
    const pool = PLACES_VISIT.filter((p) => p.id !== state.placePick);
    if (!pool.length) { toast("Откройте приложение в Telegram"); return; }
    state.placePick = pool[Math.floor(Math.random() * pool.length)].id;
  }

  function pickRandomMovie() {
    const pool = MOVIES_OPEN.filter((m) => m.id !== state.moviePick);
    if (!pool.length) { toast("Откройте приложение в Telegram"); return; }
    state.moviePick = pool[Math.floor(Math.random() * pool.length)].id;
    state.movieRandomUsed = true;
  }

  const demoAddToast = () => toast("Откройте приложение в Telegram");
  const demoInertToast = (msg) => () => toast("Откройте приложение в Telegram");

  // === DEMO_ACTIONS_BEGIN ===
  // Локальные действия: меняют только данные в памяти этой страницы.
  const DEMO_ACTIONS = {
    "done-item"(e, btn) {
      const type = btn.dataset.type;
      if (type === "tasks") moveTask(btn.dataset.id, true);
      else if (type === "wishes") moveWish(btn.dataset.id, true);
      refreshAround(btn);
    },
    "reopen-item"(e, btn) {
      const type = btn.dataset.type;
      if (type === "tasks") moveTask(btn.dataset.id, false);
      else if (type === "wishes") moveWish(btn.dataset.id, false);
      refreshAround(btn);
    },
    "delete-item"(e, btn) {
      removeDemoItem(btn.dataset.type, btn.dataset.id);
      refreshAround(btn);
    },
    "add-task": demoAddToast, "add-date": demoAddToast, "add-birthday": demoAddToast,
    "add-goal": demoAddToast, "add-movie": demoAddToast, "add-place": demoAddToast,
    "add-trip": demoAddToast, "add-memory": demoAddToast, "add-quote": demoAddToast,
    "add-contact": demoAddToast, "add-wish": demoAddToast, "add-saving": demoAddToast,
    "health-med-new": demoAddToast, "flo-med-new": demoAddToast,
    "share-wish"(e, btn) {
      const w = [...WISHES_OPEN_MINE, ...WISHES_OPEN_PARTNER, ...WISHES_DONE_MINE, ...WISHES_DONE_PARTNER]
        .find((x) => Number(x.id) === Number(btn.dataset.id));
      const part = btn.dataset.part || "all";
      const lines = part === "name" ? [w.body, w.comment] : part === "url" ? [w.url] : [w.body, w.comment, w.url];
      const text = w ? lines.filter(Boolean).join("\n") : "";
      if (text && navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(text).then(
          () => toast("Откройте приложение в Telegram"),
          () => toast("Откройте приложение в Telegram")
        );
      } else {
        toast("Откройте приложение в Telegram");
      }
    },
    "save-settings": demoInertToast("Откройте приложение в Telegram"),
    "save-pair-timezone": demoInertToast("Откройте приложение в Telegram"),
    "save-pin": demoInertToast("Откройте приложение в Telegram"),
    "export-data": demoInertToast("Откройте приложение в Telegram"),
    "leave-pair": demoInertToast("Откройте приложение в Telegram"),
    "set-theme": demoInertToast("Откройте приложение в Telegram"),
    "flo-report-open": demoInertToast("Откройте приложение в Telegram"),
    "place-visited": demoInertToast("Откройте приложение в Telegram"),
    "place-unvisited": demoInertToast("Откройте приложение в Telegram"),
    "trip-visited": demoInertToast("Откройте приложение в Telegram"),
    "trip-unvisited": demoInertToast("Откройте приложение в Telegram"),
    "movie-watched": demoInertToast("Откройте приложение в Telegram"),
    "movie-unwatched": demoInertToast("Откройте приложение в Telegram"),
    "goal-item-done": demoInertToast("Откройте приложение в Telegram"),
    "goal-item-reopen": demoInertToast("Откройте приложение в Telegram"),
    "health-intake": demoInertToast("Откройте приложение в Telegram"),
    "health-intake-clear": demoInertToast("Откройте приложение в Telegram"),
    "random-place": demoInertToast("Откройте приложение в Telegram"),
    "random-movie": demoInertToast("Откройте приложение в Telegram"),
    "close-pick": demoInertToast("Откройте приложение в Telegram"),
    "set-accent": demoInertToast("Откройте приложение в Telegram"),
    "deposit-saving": demoInertToast("Откройте приложение в Telegram"),
    "contacts-copy": demoInertToast("Откройте приложение в Telegram")
  };
  // === DEMO_ACTIONS_END ===

  // === DEMO_INERT_BEGIN ===
  // Действия без локальной реализации: кнопка отвечает тостом с причиной,
  // чтобы не выглядеть сломанной.
  const DEMO_INERT = {
    "edit-item": "Откройте приложение в Telegram",
    "edit-saving": "Откройте приложение в Telegram",
    "rate-movie": "Откройте приложение в Telegram",
    "movie-resume": "Откройте приложение в Telegram",
    "movie-resume-clear": "Откройте приложение в Telegram",
    "open-url": "Откройте приложение в Telegram",
    "open-movie": "Откройте приложение в Telegram",
    "open-memory": "Откройте приложение в Telegram",
    "open-saving": "Откройте приложение в Telegram",
    "open-history": "Откройте приложение в Telegram",
    "contact-open": "Откройте приложение в Telegram",
    "flo-period-start": "Откройте приложение в Telegram",
    "flo-period-end": "Откройте приложение в Telegram",
    "flo-record-today": "Откройте приложение в Telegram",
    "flo-day-start": "Откройте приложение в Telegram",
    "flo-day-end": "Откройте приложение в Telegram"
  };
  // === DEMO_INERT_END ===

  // === DEMO_NATIVE_BEGIN ===
  // Обрабатываются отдельными ветками ниже (не через DEMO_ACTIONS):
  const DEMO_NATIVE_ACTIONS = [
    "wish-view", "contacts-view", "cal-prev", "cal-next", "cal-day",
    "flo-month-prev", "flo-month-next", "flo-select-day",
    "movie-sort-dir", "movie-sort-key", "movie-filter-kind",
    "item-menu-toggle", "show-in-calendar"
  ];
  // === DEMO_NATIVE_END ===

  // Тап по сегменту и по кнопкам действий.
  view.addEventListener("click", (e) => {
    // Спойлеры разметки (||…||) раскрываются тапом — как в app.js.
    const spoiler = e.target.closest("[data-spoiler]");
    if (spoiler) {
      spoiler.classList.toggle("is-revealed");
      return;
    }
    // Тап по фону открытого меню (не по пункту) — закрыть.
    if (e.target.closest(".item-menu") && !e.target.closest(".item-menu-item")) {
      closeItemMenus();
      return;
    }
    // «⋮» карточки: одно открытое меню за раз; повторный тап — закрыть.
    const menuToggle = e.target.closest('[data-action="item-menu-toggle"]');
    if (menuToggle) {
      const wrap = menuToggle.closest(".item-actions");
      const menu = wrap?.querySelector(".item-menu");
      const wasOpen = wrap?.classList.contains("is-open");
      closeItemMenus();
      if (wrap && menu && !wasOpen) {
        wrap.classList.add("is-open");
        menu.hidden = false;
        menuToggle.setAttribute("aria-expanded", "true");
      }
      return;
    }
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
    // «Мои / Его» в контактах — тот же статичный переключатель.
    const contactsBtn = e.target.closest('[data-action="contacts-view"]');
    if (contactsBtn) {
      state.contactsView = contactsBtn.dataset.view === "partner" ? "partner" : "mine";
      const content = view.querySelector("#seg-body-contacts");
      if (content) {
        content.innerHTML = contactsContentHtml();
        view.querySelectorAll(".contacts-switch-btn").forEach((btn) => {
          const active = (btn.dataset.view === "partner") === (state.contactsView === "partner");
          btn.classList.toggle("is-active", active);
          btn.setAttribute("aria-selected", String(active));
        });
      } else {
        refreshSegBody("contacts");
      }
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
    // Фло-календарь: месяц и выбранный день.
    const floBtn = e.target.closest('[data-action^="flo-"]');
    if (floBtn) {
      const action = floBtn.dataset.action;
      if (action === "flo-month-prev") state.floOffset -= 1;
      else if (action === "flo-month-next") state.floOffset += 1;
      else if (action === "flo-select-day") {
        state.floSelected = floBtn.dataset.date;
        const sd = keyToDate(floBtn.dataset.date);
        const tm = todayMidnight();
        state.floOffset = (sd.getFullYear() - tm.getFullYear()) * 12 + (sd.getMonth() - tm.getMonth());
      }
      else return;
      refreshSegBody("flo");
      return;
    }
    // Тап по карточке с датой открывает календарь пары на нужном дне.
    const calOpen = e.target.closest('[data-action="show-in-calendar"]');
    if (calOpen) {
      const day = calOpen.dataset.day;
      if (!day) return;
      const d = keyToDate(day);
      const tm = todayMidnight();
      state.calSelected = day;
      state.calOffset = (d.getFullYear() - tm.getFullYear()) * 12 + (d.getMonth() - tm.getMonth());
      state.views.pair = "profile";
      if (state.tab === "pair") {
        // Уже в паре: setTab не сработает — повторяем его ветку для pair.
        navItems.forEach((btn) => {
          btn.classList.remove("is-active");
          btn.removeAttribute("aria-current");
        });
        render();
      } else {
        setTab("pair");
      }
      return;
    }
    // Кнопки действий: локальная demo-логика (DEMO_ACTIONS), тост с
    // причиной для нереализованных (DEMO_INERT) или отдельные ветки
    // (DEMO_NATIVE_ACTIONS). Молча неработающих кнопок нет.
    const actionBtn = e.target.closest("[data-action]");
    if (actionBtn) {
      const action = actionBtn.dataset.action;
      closeItemMenus();
      const fn = DEMO_ACTIONS[action];
      if (fn) { fn(e, actionBtn); return; }
      if (action === "movie-sort-dir") {
        const v = state.views.movies;
        state.movieSort[v].dir = state.movieSort[v].dir === "asc" ? "desc" : "asc";
        refreshSegBody("movies");
        return;
      }
      const reason = DEMO_INERT[action];
      if (reason) { toast(reason); return; }
      if (!DEMO_NATIVE_ACTIONS.includes(action)) toast("Откройте приложение в Telegram");
      return;
    }
    // Любой другой тап закрывает открытые меню карточек.
    closeItemMenus();
  });

  // Селекты сортировки/фильтра кино — change, не click.
  view.addEventListener("change", (e) => {
    const sel = e.target.closest('select[data-action]');
    if (!sel) return;
    const action = sel.dataset.action;
    const viewKeyName = state.views.movies;
    if (action === "movie-sort-key") state.movieSort[viewKeyName].key = sel.value;
    else if (action === "movie-filter-kind") state.movieKind[viewKeyName] = sel.value;
    else return;
    refreshSegBody("movies");
  });

  // Клавиатурная активация карточек role="button" — тот же приём, что в
  // app.js: Enter по keydown (без автоповтора), Space по keyup.
  const screenEl = view.parentElement;
  let spaceCard = null;
  const demoCardFromEvent = (e) => {
    const t = e.target;
    if (!t || typeof t.closest !== "function") return null;
    if (t.closest("button, a[href], input, select, textarea, summary, [contenteditable]")) return null;
    return t.closest('[role="button"][tabindex]:not([tabindex="-1"])');
  };
  screenEl.addEventListener("keydown", (e) => {
    if (e.key !== "Enter" && e.key !== " " && e.key !== "Spacebar") return;
    const card = demoCardFromEvent(e);
    if (!card) return;
    e.preventDefault();
    if (e.key === "Enter") { if (!e.repeat) card.click(); }
    else spaceCard = card;
  });
  screenEl.addEventListener("keyup", (e) => {
    if (e.key !== " " && e.key !== "Spacebar") { spaceCard = null; return; }
    const card = spaceCard;
    spaceCard = null;
    if (card && e.target === card && document.activeElement === card) card.click();
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

const state = {
  tab: "home",
  views: {
    tasks: "plans", plans: "open", goals: "open", movies: "open",
    dates: "dates", places: "visit", memories: "memories",
    pair: "profile", wishesView: "open", savingsView: "saving",
    flo: "today"
  },
  wishView: "mine",
  contactsView: "mine",
  movieSort: { open: { key: "added", dir: "desc" }, watched: { key: "added", dir: "desc" } },
  movieKind: { open: "all", watched: "all" },
  calOffset: 0,
  calSelected: dayKey(todayMidnight()),
  placePick: null,
  moviePick: null,
  movieRandomUsed: false,
  ritualDone: false,
  xp: 240,
  togetherXp: 520,
  floOffset: 0,
  floSelected: dayKey(todayMidnight())
};

  liquidNav.setActive("home", false);
  render();


// ------------------------------------------------------------------
// Списки по ключам сегментов.
// ------------------------------------------------------------------
function plansList() {
  if (state.views.plans === "done") {
    return `
      <div class="section-head-inline"><h3>Завершённые · ${DONE_TASKS.length}</h3></div>
      ${DONE_TASKS.map(doneTaskCard).join("")}`;
  }
  return `
    <button class="primary full add-button" type="button" data-action="add-task">Добавить план</button>
    ${TASKS.map(taskCard).join("")}`;
}

function goalsList() {
  // Цель «завершена», когда выполнены все её пункты — как completedGoals()
  // в app.js; выполненные уходят в вид «Выполненные».
  const open = GOALS.filter((g) => g.items.some((it) => !it.done));
  const done = GOALS.filter((g) => !g.items.some((it) => !it.done));
  if (state.views.goals === "done") {
    if (!done.length) {
      return `<section class="card"><h3>Пока ничего не достигнуто</h3><p>Отметьте все пункты цели — она переедет сюда</p></section>`;
    }
    return done.map(goalCard).join("");
  }
  if (!open.length) {
    return `<section class="card"><h3>Пока пусто</h3>
      <p>Опишите большую цель и разбейте её на шаги — отмечайте выполненные вместе</p>
      <div style="margin-top:12px;"><button class="primary full" type="button" data-action="add-goal">Создать цель</button></div>
    </section>`;
  }
  return `
    <button class="primary full add-button" type="button" data-action="add-goal">Создать цель</button>
    ${open.map(goalCard).join("")}`;
}

function datesList() {
  return state.views.dates === "birthdays"
    ? `<button class="primary full add-button" type="button" data-action="add-birthday">Добавить день рождения</button>${BIRTHDAYS.map(birthdayCard).join("")}`
    : `<button class="primary full add-button" type="button" data-action="add-date">Добавить дату</button>${DATES.map(dateCard).join("")}`;
}

// Карточка результата «Рандом» — порт renderPlacePick()/renderMoviePick().
function placePickCard() {
  const p = [...PLACES_VISIT, ...PLACES_VISITED].find((x) => x.id === state.placePick);
  if (!p) { state.placePick = null; return ""; }
  return `
    <article class="card place-pick" aria-live="polite">
      <p class="eyebrow">Вам выпало</p>
      <h2 class="place-pick-title">${esc(p.title)}</h2>
      ${p.note ? `<p class="place-pick-note">${esc(p.note)}</p>` : ""}
      <div class="place-actions">
        <button class="primary full" type="button" data-action="place-visited" data-id="${p.id}">Посетили</button>
        <button class="secondary full" type="button" data-action="random-place">Следующее</button>
        <button class="secondary full" type="button" data-action="close-pick">Закрыть</button>
      </div>
    </article>`;
}

function moviePickCard() {
  const m = [...MOVIES_OPEN, ...MOVIES_WATCHED].find((x) => x.id === state.moviePick);
  if (!m) { state.moviePick = null; return ""; }
  return `
    <article class="card place-pick movie-pick" aria-live="polite" data-action="open-movie" data-id="${m.id}" role="button" tabindex="0" aria-label="Открыть описание: ${esc(m.title)}">
      <p class="eyebrow">Вам выпало</p>
      <h2 class="place-pick-title">${esc(m.title)}</h2>
      <div class="item-meta">
        ${ratingPill(m)}
        ${m.length ? `<span>${esc(m.length)}</span>` : ""}
      </div>
      <div class="place-actions">
        <button class="primary full" type="button" data-action="movie-watched" data-id="${m.id}">Просмотрели</button>
        <button class="secondary full" type="button" data-action="random-movie">Следующее</button>
        <button class="secondary full" type="button" data-action="close-pick">Закрыть</button>
      </div>
    </article>`;
}

function placesList() {
  if (state.views.places === "trips") {
    const open = TRIPS.filter((t) => !t.visited);
    const visited = TRIPS.filter((t) => t.visited);
    if (!open.length && !visited.length) {
      return `<section class="card"><h3>Пока пусто</h3>
        <p>Добавьте город или страну, куда мечтаете съездить вдвоём</p>
        <button class="primary full card-action" type="button" data-action="add-trip">Добавить поездку</button>
      </section>`;
    }
    return `
      <button class="primary full add-button" type="button" data-action="add-trip">Добавить поездку</button>
      ${open.length ? `<div class="section-head-inline"><h3>Хотим съездить · ${open.length}</h3></div>${open.map(tripCard).join("")}` : ""}
      ${visited.length ? `<div class="section-head-inline"><h3>Съездили · ${visited.length}</h3></div>${visited.map(tripCard).join("")}` : ""}`;
  }
  const open = PLACES_VISIT;
  const visited = PLACES_VISITED;
  if (!open.length && !visited.length) {
    return `<section class="card"><h3>Пока пусто</h3>
      <p>Добавьте кафе, парк или другое место, куда давно хотели выбраться</p>
      <button class="primary full card-action" type="button" data-action="add-place">Добавить место</button>
    </section>`;
  }
  return `
    <section class="card place-hero">
      <h3>Не знаете, куда пойти?</h3>
      <p>Приложение выберет случайное место из списка. Отметить посещение можно отдельно — уже после того, как сходите</p>
      <button class="secondary full card-action" type="button" data-action="random-place">Рандом</button>
    </section>
    ${placePickCard()}
    <button class="primary full add-button" type="button" data-action="add-place">Добавить место</button>
    ${open.length ? `<div class="section-head-inline"><h3>Хотим посетить · ${open.length}</h3></div>${open.map(placeCard).join("")}` : ""}
    ${visited.length ? `<div class="section-head-inline"><h3>Посещённые · ${visited.length}</h3></div>${visited.map(placeCard).join("")}` : ""}`;
}

function memoriesList() {
  const v = state.views.memories;
  if (v === "quotes") {
    return `<button class="primary full add-button" type="button" data-action="add-quote">Добавить цитату</button>${QUOTES.map(quoteCard).join("")}`;
  }
  if (v === "health") return healthBody();
  if (v === "contacts") return contactsBody();
  return `<button class="primary full add-button" type="button" data-action="add-memory">Записать</button>${MEMORIES.map(memoryCard).join("")}`;
}

// ------------------------------------------------------------------
// Кино: сортировка и фильтр — порт movieSortBar/sortMovies.
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
  const field = (action, label, options, value) => `
    <div class="movie-sort-field${action === "movie-filter-kind" ? " is-kind" : ""}">
      <select data-action="${action}" aria-label="${label}">
        ${options.map(([v, l]) => `<option value="${v}"${v === value ? " selected" : ""}>${l}</option>`).join("")}
      </select>
      ${MOVIE_CHEVRON}
    </div>`;
  return `
    <div class="movie-sort">
      ${field("movie-sort-key", "Сортировка фильмов", opts, sort.key)}
      ${field("movie-filter-kind", "Показывать фильмы или сериалы", MOVIE_KIND_OPTIONS, kind)}
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
function movieEmptyByKind(view) {
  const kindLabel = state.movieKind[view] === "series" ? "сериал" : "фильм";
  return `<section class="card"><h3>Пусто</h3><p>Под фильтр ничего не попало — добавьте ${kindLabel} или выберите «Все».</p></section>`;
}
function moviesList() {
  const view = state.views.movies;
  if (view === "watched") {
    const all = MOVIES_WATCHED;
    if (!all.length) return `<section class="card"><h3>Пока ничего не просмотрено</h3><p>Отметьте фильм просмотренным в «В планах» — он появится здесь</p></section>`;
    const filtered = filterMoviesByKind(all, "watched");
    if (!filtered.length) return movieSortBar("watched", 0) + movieEmptyByKind("watched");
    return movieSortBar("watched", filtered.length) + sortMovies(filtered, "watched").map(movieCard).join("");
  }
  // «В планах»: hero-карточка «Не знаете, что посмотреть?» с «Рандом» —
  // как renderOpenMovies() в app.js (до первого рандома кнопка внутри
  // информера, после — отдельная под «Найти кино»).
  const all = MOVIES_OPEN;
  const open = filterMoviesByKind(all, "open");
  const heroUsed = state.movieRandomUsed === true;
  let html = "";
  if (!heroUsed) {
    html += `
      <section class="card place-hero movie-hero">
        <h3>Не знаете, что посмотреть?</h3>
        <p>Приложение выберет случайный фильм или сериал из избранного. Отметить просмотр можно отдельно — уже после титров</p>
        <button class="secondary full card-action" type="button" data-action="random-movie">Рандом</button>
      </section>`;
  }
  html += moviePickCard();
  html += `<button class="primary full add-button" type="button" data-action="add-movie">Найти кино</button>`;
  if (heroUsed) html += `<button class="secondary full place-random" type="button" data-action="random-movie">Рандом</button>`;
  html += movieSortBar("open", open.length);
  html += open.length ? sortMovies(open, "open").map(movieCard).join("") : movieEmptyByKind("open");
  return html;
}

})();
