/*
 * Нижняя навигация DuoPlan — «жидкая» стеклянная капля в духе Telegram iOS.
 *
 * Модуль отвечает только за каплю и жест: геометрию панели, деформацию формы,
 * перетаскивание с захватом указателя и выбор вкладки по площади пересечения.
 * Само переключение страницы остаётся в app.js — модуль лишь сообщает цель
 * через onCommit(), поэтому второй системы навигации не появляется.
 *
 * Почему SVG-путь, а не transform: scaleX/scaleY масштабируют пилюлю целиком,
 * из-за чего она выглядит резиновой, но не жидкой. Здесь контур пересчитывается
 * по скорости и направлению: передний край вытягивается, задний отстаёт,
 * высота проседает, центр смещается вслед за движением.
 */
(() => {
  "use strict";

  const TAP_SLOP = 6;          // px: меньше — это тап, а не перетаскивание
  const SPRING_K = 320;        // жёсткость пружины возврата
  const SPRING_C = 34;         // демпфирование (ζ ≈ 0.95 — мягкий доводчик)
  const MAX_SPEED = 1500;      // px/s: скорость, при которой деформация максимальна
  const MAX_LEAD = 0.18;       // вытягивание переднего края, доля ширины капли
  const MAX_TRAIL = 0.11;      // поджатие заднего края
  const MAX_SQUASH = 0.16;     // просадка высоты
  const MAX_SHIFT = 0.05;      // смещение центра вслед за движением
  const FOLLOW_TAU = 0.045;    // с: инерция капли под пальцем
  const SAMPLES = 48;          // точек контура для расчёта площади
  const PAD_FALLBACK = 5;
  const MAX_RELEASE_SPEED = 1800;
  // Доля полной площади капли, при которой вкладка считается целью. Запас
  // 0.2% гасит численную погрешность: ровно 50/50 не должно превращаться в
  // 50.00001% из-за округлений при клиппинге полигона.
  const MAJORITY = 0.5;
  const MAJORITY_EPSILON = 0.002;
  // Одноразовая защита от синтетического click после drag.
  const CLICK_GUARD_TTL = 700;    // мс: click приходит сразу после pointerup
  const CLICK_GUARD_RADIUS = 14;  // px: та же точка, где отпустили палец

  // Линза капли: копия контента, обрезанная по форме капли. Внутри капли
  // иконки и подписи крупнее, а на скорости край подхватывает перспективу —
  // вместе с деформацией контура это и даёт ощущение жидкого стекла.
  // Базовая панель при этом не двигается вообще: у неё меняется только цвет.
  const LENS_SCALE = 1.06;        // увеличение под каплей в покое
  const LENS_SCALE_SPEED = 0.10;  // добавка на максимальной скорости
  const LENS_TILT = 10;           // градусы перспективы у края капли
  const LENS_PERSPECTIVE = 200;   // px: меньше — резче искажение у краёв

  // Уникальный id маски на каждую панель: на странице их может быть больше одной.
  let maskSeq = 0;

  const clamp = (value, min, max) => Math.min(Math.max(value, min), max);
  const round2 = (value) => Math.round(value * 100) / 100;

  // ------------------------------------------------------------------
  // Геометрия: площадь полигона и пересечение с прямоугольником вкладки
  // ------------------------------------------------------------------

  function polygonArea(points) {
    if (points.length < 3) return 0;
    let sum = 0;
    for (let i = 0; i < points.length; i++) {
      const [x1, y1] = points[i];
      const [x2, y2] = points[(i + 1) % points.length];
      sum += x1 * y2 - x2 * y1;
    }
    return Math.abs(sum) / 2;
  }

  // Одна полуплоскость (Sutherland–Hodgman): оставляем точки с нужной стороны.
  function clipHalfPlane(points, axis, limit, keepGreater) {
    const out = [];
    for (let i = 0; i < points.length; i++) {
      const a = points[i];
      const b = points[(i + 1) % points.length];
      const av = a[axis] - limit;
      const bv = b[axis] - limit;
      const aIn = keepGreater ? av >= 0 : av <= 0;
      const bIn = keepGreater ? bv >= 0 : bv <= 0;
      if (aIn) out.push(a);
      if (aIn !== bIn) {
        const t = av / (av - bv);
        out.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]);
      }
    }
    return out;
  }

  function clipPolygonToRect(points, rect) {
    let out = points;
    out = clipHalfPlane(out, 0, rect.left, true);
    if (!out.length) return out;
    out = clipHalfPlane(out, 0, rect.right, false);
    if (!out.length) return out;
    out = clipHalfPlane(out, 1, rect.top, true);
    if (!out.length) return out;
    return clipHalfPlane(out, 1, rect.bottom, false);
  }

  function overlapArea(points, rect) {
    return polygonArea(clipPolygonToRect(points, rect));
  }

  // Доля полной площади капли над каждой вкладкой.
  //
  // Знаменатель — площадь самой капли, а не сумма пересечений: часть капли
  // может лежать вне кнопок (в отступах панели), и тогда «сумма пересечений»
  // завысила бы долю до 100%, хотя реально вкладка накрывает 40%.
  function coverageRatios(polygon, rects) {
    const total = polygonArea(polygon);
    const ratios = {};
    for (const entry of rects || []) {
      const rect = entry.rect;
      const intersection = overlapArea(polygon, {
        left: rect.left,
        top: rect.top,
        right: rect.right,
        bottom: rect.bottom
      });
      ratios[entry.tab] = total > 0 ? intersection / total : 0;
    }
    return { total, ratios };
  }

  function isMajority(ratio) {
    return ratio > MAJORITY + MAJORITY_EPSILON;
  }

  // Строго больше половины ПОЛНОЙ площади капли — иначе оставляем последнюю
  // однозначную цель (в том числе при 50/50 и когда капля «размазана»).
  function pickTarget(ratios, fallback) {
    let bestTab = fallback;
    let best = 0;
    for (const [tab, ratio] of Object.entries(ratios || {})) {
      if (ratio > best) {
        best = ratio;
        bestTab = tab;
      }
    }
    return isMajority(best) ? bestTab : fallback;
  }

  // ------------------------------------------------------------------
  // Цвет под каплей: перекраска по мере накрытия вкладки
  // ------------------------------------------------------------------

  // Разбор цвета из CSS-переменной. Нужны только hex и rgb()/rgba():
  // ровно так заданы --muted и --berry в app.css.
  function parseColor(value) {
    const text = String(value == null ? "" : value).trim();
    if (!text) return null;
    const hexMatch = /^#([0-9a-f]{3,8})$/i.exec(text);
    if (hexMatch) {
      let hex = hexMatch[1];
      if (hex.length === 3 || hex.length === 4) {
        hex = hex.split("").map((char) => char + char).join("");
      }
      const num = parseInt(hex.slice(0, 6), 16);
      if (Number.isNaN(num)) return null;
      return [(num >> 16) & 255, (num >> 8) & 255, num & 255];
    }
    const rgbMatch = /^rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)/i.exec(text);
    if (rgbMatch) {
      return [rgbMatch[1], rgbMatch[2], rgbMatch[3]].map((part) => clamp(Math.round(Number(part)), 0, 255));
    }
    return null;
  }

  // Линейная интерполяция цвета: 0 — обычный, 1 — активный.
  function mixColor(from, to, ratio) {
    const t = clamp(Number(ratio) || 0, 0, 1);
    const channel = (index) => Math.round(from[index] + (to[index] - from[index]) * t);
    return `rgb(${channel(0)}, ${channel(1)}, ${channel(2)})`;
  }

  // Какая доля вкладки накрыта каплей: 0 — мимо, 1 — целиком внутри.
  // Именно доля, а не «попал/не попал»: подпись перекрашивается постепенно,
  // по мере того как капля наезжает на неё.
  function coverageOf(span, rect) {
    if (!span || !rect || !(rect.width > 0)) return 0;
    const left = Math.max(span.left, rect.left);
    const right = Math.min(span.right, rect.right);
    return clamp((right - left) / rect.width, 0, 1);
  }

  // ------------------------------------------------------------------
  // Модуль навигации
  // ------------------------------------------------------------------

  function createLiquidNav(options) {
    const { nav, svg, path, items, onCommit } = options || {};
    if (!nav || !svg || !path || !items || !items.length) return null;

    const state = {
      active: null,
      pos: 0,
      target: 0,
      vel: 0,
      raf: 0,
      lastTs: 0,
      press: null,
      drag: null,
      geom: null,
      svgRect: null,
      lastUnambiguous: null,
      previewTab: null,
      // Одноразовая запись о завершённом drag: { pointerId, x, y, time }.
      clickGuard: null,
      lastPreviewX: NaN,
      reduced: false,
      // Цвета вкладок и текущая доля накрытия каждой из них каплей.
      palette: { idle: [118, 110, 104], accent: [184, 84, 100] },
      tints: {},
      colorsApplied: false
    };

    const motionQuery = window.matchMedia ? window.matchMedia("(prefers-reduced-motion: reduce)") : null;
    const syncReduced = () => {
      state.reduced = Boolean(motionQuery && motionQuery.matches);
    };
    syncReduced();
    if (motionQuery) {
      if (motionQuery.addEventListener) motionQuery.addEventListener("change", syncReduced);
      else if (motionQuery.addListener) motionQuery.addListener(syncReduced);
    }

    // ------------------------------------------------------------- линза

    const baseMaskId = `nav-base-mask-${(maskSeq += 1)}`;
    // Слой-линза строится сразу: он живёт рядом с вкладками и повторяет их
    // раскладку, поэтому дальше остаётся только обрезать его по контуру капли.
    const lens = buildLens();
    // Базовый слой под каплей вырезается маской: иначе обычная подпись
    // просвечивала бы сквозь увеличенную копию и давала «двоение».
    const baseMask = buildBaseMask();

    function buildBaseMask() {
      if (typeof document === "undefined" || !document.createElement) return null;
      // Вкладки переезжают в обёртку, чтобы её можно было вырезать целиком:
      // раскладка не меняется — обёртка занимает все колонки панели и сама
      // раскладывает вкладки таким же grid'ом.
      const base = document.createElement("div");
      base.className = "nav-base";
      base.style.gridTemplateColumns = `repeat(${items.length}, 1fr)`;
      nav.insertBefore(base, items[0]);
      for (const item of items) base.appendChild(item);

      const ns = "http://www.w3.org/2000/svg";
      const holder = document.createElementNS(ns, "svg");
      holder.setAttribute("class", "nav-mask");
      holder.setAttribute("aria-hidden", "true");
      const defs = document.createElementNS(ns, "defs");

      // Мягкая кромка: без размытия контур капли рубит подпись по живому и
      // на границе видно «разрыв». С blur базовый слой гаснет, а линза
      // проявляется — переход читается как кромка стекла.
      const filter = document.createElementNS(ns, "filter");
      filter.setAttribute("id", `${baseMaskId}-soft`);
      filter.setAttribute("filterUnits", "userSpaceOnUse");
      const blur = document.createElementNS(ns, "feGaussianBlur");
      blur.setAttribute("stdDeviation", "1.2");
      filter.appendChild(blur);
      defs.appendChild(filter);

      const mask = document.createElementNS(ns, "mask");
      mask.setAttribute("id", `${baseMaskId}-base`);
      mask.setAttribute("maskUnits", "userSpaceOnUse");
      const rect = document.createElementNS(ns, "rect");
      rect.setAttribute("fill", "#fff");
      const hole = document.createElementNS(ns, "path");
      hole.setAttribute("fill", "#000");
      hole.setAttribute("filter", `url(#${baseMaskId}-soft)`);
      mask.appendChild(rect);
      mask.appendChild(hole);
      defs.appendChild(mask);

      // Обратная маска для линзы: внутри капли — белое, снаружи — чёрное.
      const lensMask = document.createElementNS(ns, "mask");
      lensMask.setAttribute("id", `${baseMaskId}-lens`);
      lensMask.setAttribute("maskUnits", "userSpaceOnUse");
      const lensRect = document.createElementNS(ns, "rect");
      lensRect.setAttribute("fill", "#000");
      const lensPath = document.createElementNS(ns, "path");
      lensPath.setAttribute("fill", "#fff");
      lensPath.setAttribute("filter", `url(#${baseMaskId}-soft)`);
      lensMask.appendChild(lensRect);
      lensMask.appendChild(lensPath);
      defs.appendChild(lensMask);

      holder.appendChild(defs);
      nav.appendChild(holder);

      base.style.mask = `url(#${baseMaskId}-base)`;
      base.style.webkitMask = `url(#${baseMaskId}-base)`;
      // Линза обрезается не clip-path, а такой же мягкой маской: жёсткий
      // clip давал «обрубленный» край у подписи на кромке капли.
      if (lens) {
        lens.layer.style.mask = `url(#${baseMaskId}-lens)`;
        lens.layer.style.webkitMask = `url(#${baseMaskId}-lens)`;
        lens.layer.style.clipPath = "none";
      }
      return { base, holder, mask, rect, hole, lensMask, lensRect, lensPath, filter };
    }

    // Копия иконок и подписей поверх капли. Слой обрезается по контуру капли
    // и увеличивается — внутри капли контент крупнее, у краёв ловится
    // перспектива. Базовая панель при этом остаётся нетронутой.
    function buildLens() {
      if (typeof document === "undefined" || !document.createElement) return null;
      const layer = document.createElement("div");
      layer.className = "nav-lens";
      layer.setAttribute("aria-hidden", "true");
      const track = document.createElement("div");
      track.className = "nav-lens-track";
      track.style.gridTemplateColumns = `repeat(${items.length}, 1fr)`;
      for (const item of items) {
        const clone = item.cloneNode(true);
        // Копия декоративная: она не должна участвовать ни в фокусе, ни в
        // кликах, ни в поиске по data-tab (иначе querySelector найдёт двойника).
        clone.removeAttribute("data-tab");
        clone.removeAttribute("id");
        clone.removeAttribute("aria-current");
        clone.setAttribute("aria-hidden", "true");
        clone.setAttribute("tabindex", "-1");
        clone.classList.remove("is-active", "is-preview-target", "is-dragover");
        track.appendChild(clone);
      }
      layer.appendChild(track);
      nav.appendChild(layer);
      return { layer, track, clones: Array.from(track.children) };
    }

    // Цвета читаем из CSS-переменных панели: акцентная палитра меняется на
    // :root, поэтому при смене темы/акцента refresh() перечитывает их.
    function readPalette() {
      if (!window.getComputedStyle) return;
      const cs = window.getComputedStyle(nav);
      const idle = parseColor(cs.getPropertyValue("--muted"));
      const accent = parseColor(cs.getPropertyValue("--berry"));
      if (idle) state.palette.idle = idle;
      if (accent) state.palette.accent = accent;
      // Палитра могла измениться — перекрасим при следующем рендере.
      state.colorsApplied = false;
    }

    function applyLens(shape) {
      if (!lens || !state.rects) return;
      // При reduced-motion линза не увеличивает: контент остаётся как есть.
      const s = state.reduced ? 0 : shape.s;
      // Прибавка к масштабу: в покое лёгкая, на скорости капля «надувает»
      // контент сильнее — вместе с деформацией контура это и есть жизнь.
      const boost = (LENS_SCALE - 1) + s * LENS_SCALE_SPEED;
      const span = {
        left: state.svgRect.left + shape.xL,
        right: state.svgRect.left + shape.xR
      };
      for (let index = 0; index < lens.clones.length; index += 1) {
        const clone = lens.clones[index];
        const entry = state.rects[index];
        // Доля накрытия: по ней считается и масштаб, и наклон.
        const ratio = coverageOf(span, entry.rect);
        state.tints[entry.tab] = ratio;
        if (ratio <= 0.001) {
          if (clone.style.transform) clone.style.transform = "";
          continue;
        }
        // Каждый элемент растёт на своём месте: масштаб от центра вкладки,
        // поэтому контент не «уезжает» из капли, как при зуме всего слоя.
        const center = entry.rect.left + entry.rect.width / 2 - state.svgRect.left;
        const offset = clamp((center - shape.cx) / (state.geom.slotW * 0.5), -1, 1);
        // Перспектива: у краёв капли элемент наклоняется от центра — край
        // поджимается, и картинка читается как преломление в стекле.
        const tilt = -offset * LENS_TILT * ratio * (0.35 + 0.65 * s);
        const scale = 1 + boost * ratio;
        // В покое перспективы нет — чистый 2D-scale перерисовывается резко,
        // а perspective()/rotateY() включили бы 3D-контекст и мыло иконку.
        clone.style.transform = Math.abs(tilt) < 0.05
          ? `scale(${round2(scale)})`
          : `perspective(${LENS_PERSPECTIVE}px) rotateY(${round2(tilt)}deg) scale(${round2(scale)})`;
      }
      // Тот же контур с мягкой кромкой вырезает базовый слой и проявляет
      // линзу: под каплей остаётся только увеличенная копия, а на границе
      // подпись не рвётся, а плавно уступает место преломлённой.
      if (baseMask) {
        baseMask.hole.setAttribute("d", shape.d);
        baseMask.lensPath.setAttribute("d", shape.d);
      }
    }

    // Цвет: базовый слой всегда обычный, копия в линзе — акцентная. Поэтому
    // вкладка красится не целиком, а ровно там, где её накрыла капля: граница
    // цвета идёт по кромке стекла и едет вместе с ней.
    function applyColors() {
      if (state.colorsApplied) return;
      const idle = mixColor(state.palette.idle, state.palette.accent, 0);
      const accent = mixColor(state.palette.idle, state.palette.accent, 1);
      for (let index = 0; index < items.length; index += 1) {
        items[index].style.color = idle;
        if (lens && lens.clones[index]) lens.clones[index].style.color = accent;
      }
      state.colorsApplied = true;
    }

    // ------------------------------------------------------------- замеры

    function measure() {
      const width = nav.clientWidth;
      const height = nav.clientHeight;
      // Скрытая панель (первичная настройка, нет пары) имеет нулевой размер:
      // геометрию пересчитаем при показе через refresh().
      if (!width || !height) {
        state.geom = null;
        return null;
      }
      const cs = window.getComputedStyle(nav);
      const padLeft = parseFloat(cs.paddingLeft) || PAD_FALLBACK;
      const padRight = parseFloat(cs.paddingRight) || padLeft;
      const padTop = parseFloat(cs.paddingTop) || PAD_FALLBACK;
      const padBottom = parseFloat(cs.paddingBottom) || padTop;
      const inner = {
        x: padLeft,
        y: padTop,
        w: Math.max(width - padLeft - padRight, 1),
        h: Math.max(height - padTop - padBottom, 1)
      };
      const slotW = inner.w / items.length;
      state.geom = {
        width,
        height,
        inner,
        slotW,
        centers: items.map((_, index) => inner.x + slotW * (index + 0.5))
      };
      svg.setAttribute("viewBox", `0 0 ${width} ${height}`);
      // Кэш экранной рамки: панель fixed, поэтому между resize она не едет.
      state.svgRect = svg.getBoundingClientRect();
      state.ctm = svg.getScreenCTM();
      // Рамки вкладок на время жеста не меняются — читаем один раз, а не
      // каждым кадром (иначе layout пересчитывался бы 60 раз в секунду).
      state.rects = items.map((item) => ({
        tab: item.dataset.tab,
        rect: item.getBoundingClientRect()
      }));
      // Копия в линзе повторяет раскладку панели: та же внутренняя область,
      // тот же grid. Ставим её по пикселям, чтобы не зависеть от padding.
      if (lens) {
        lens.track.style.left = `${round2(inner.x)}px`;
        lens.track.style.top = `${round2(inner.y)}px`;
        lens.track.style.width = `${round2(inner.w)}px`;
        lens.track.style.height = `${round2(inner.h)}px`;
      }
      // Маска базового слоя живёт в координатах самой обёртки: она начинается
      // на внутреннем отступе панели, поэтому контур капли сдвигаем на него.
      if (baseMask) {
        const pad = 24;
        const box = { x: -pad, y: -pad, width: width + pad * 2, height: height + pad * 2 };
        for (const node of [baseMask.rect, baseMask.lensRect]) {
          node.setAttribute("x", box.x);
          node.setAttribute("y", box.y);
          node.setAttribute("width", box.width);
          node.setAttribute("height", box.height);
        }
        // Область самой маски: у maskUnits="userSpaceOnUse" проценты по
        // умолчанию считаются от рамки элемента и для HTML дают пустоту —
        // тогда маска гасит всё содержимое.
        for (const maskNode of [baseMask.mask, baseMask.lensMask]) {
          maskNode.setAttribute("x", box.x);
          maskNode.setAttribute("y", box.y);
          maskNode.setAttribute("width", box.width);
          maskNode.setAttribute("height", box.height);
        }
        baseMask.hole.setAttribute("transform", `translate(${round2(-inner.x)} ${round2(-inner.y)})`);
        // Область фильтра должна покрывать размытие по краям контура.
        for (const key of ["x", "y", "width", "height"]) {
          baseMask.filter.setAttribute(key, box[key]);
        }
      }
      return state.geom;
    }

    function centerOf(tab) {
      const index = items.findIndex((item) => item.dataset.tab === tab);
      if (index === -1 || !state.geom) return null;
      return state.geom.centers[index];
    }

    function clampCenter(x) {
      const geom = state.geom;
      if (!geom) return x;
      const half = (geom.slotW - 2) / 2;
      return clamp(x, geom.inner.x + half, geom.inner.x + geom.inner.w - half);
    }

    // ------------------------------------------------------------- форма

    // Возвращает не только путь, но и геометрию: линзе нужен центр и границы,
    // перекраске — горизонтальный отрезок, накрытый каплей.
    function dropletShape(centerX, speed, dir) {
      const geom = state.geom;
      const w0 = geom.slotW - 2;
      const h0 = geom.inner.h - 2;
      const raw = Math.min(Math.abs(speed) / MAX_SPEED, 1);
      // При reduced-motion форма почти не деформируется, но жест работает.
      const s = raw * (state.reduced ? 0.35 : 1);
      const height = h0 * (1 - s * MAX_SQUASH);
      const lead = s * w0 * MAX_LEAD;
      const trail = s * w0 * MAX_TRAIL;

      const cx = centerX + dir * s * w0 * MAX_SHIFT;
      let xL = cx - w0 / 2 + dir * trail;
      let xR = cx + w0 / 2 + dir * lead;

      // Капля не должна вылезать за внутреннюю область панели: сдвигаем обе
      // границы, сохраняя ширину — так у края она «упирается», а не сплющивается.
      const minX = geom.inner.x;
      const maxX = geom.inner.x + geom.inner.w;
      if (xL < minX) {
        xR += minX - xL;
        xL = minX;
      }
      if (xR > maxX) {
        xL -= xR - maxX;
        xR = maxX;
      }

      const cy = geom.inner.y + geom.inner.h / 2;
      const yT = cy - height / 2;
      const yB = cy + height / 2;
      const r = Math.min(height / 2, (xR - xL) / 2);
      // Передняя дуга чуть «острее» задней — капля тянется носом вперёд.
      const kLead = 0.5523 + s * 0.1;
      const kTrail = 0.5523 - s * 0.06;

      const d = [
        `M${round2(xL + r)},${round2(yT)}`,
        `L${round2(xR - r)},${round2(yT)}`,
        `C${round2(xR - r + kLead * r)},${round2(yT)} ${round2(xR)},${round2(yT + r - kLead * r)} ${round2(xR)},${round2(yT + r)}`,
        `C${round2(xR)},${round2(yB - r + kLead * r)} ${round2(xR - r + kLead * r)},${round2(yB)} ${round2(xR - r)},${round2(yB)}`,
        `L${round2(xL + r)},${round2(yB)}`,
        `C${round2(xL + r - kTrail * r)},${round2(yB)} ${round2(xL)},${round2(yB - r + kTrail * r)} ${round2(xL)},${round2(yB - r)}`,
        `C${round2(xL)},${round2(yT + r - kTrail * r)} ${round2(xL + r - kTrail * r)},${round2(yT)} ${round2(xL + r)},${round2(yT)}`,
        "Z"
      ].join(" ");

      return { d, cx, xL, xR, yT, yB, height, s, dir };
    }

    function render() {
      if (!state.geom) return;
      const dir = state.vel < 0 ? -1 : 1;
      const shape = dropletShape(state.pos, state.vel, dir);
      path.setAttribute("d", shape.d);
      // Цвет ставим один раз на палитру, линза — каждый кадр.
      applyColors();
      applyLens(shape);
      if (state.drag) updatePreview();
    }

    // --------------------------------------------------- площадь под вкладками

    function samplePolygon() {
      const points = [];
      const length = path.getTotalLength();
      const matrix = state.ctm;
      if (!length || !matrix) return points;
      for (let i = 0; i < SAMPLES; i++) {
        const point = path.getPointAtLength((length * i) / SAMPLES);
        points.push([
          matrix.a * point.x + matrix.c * point.y + matrix.e,
          matrix.b * point.x + matrix.d * point.y + matrix.f
        ]);
      }
      return points;
    }

    function analyze() {
      const polygon = samplePolygon();
      const { total, ratios } = coverageRatios(polygon, state.rects);
      let bestTab = null;
      let bestRatio = 0;
      for (const [tab, ratio] of Object.entries(ratios)) {
        if (ratio > bestRatio) {
          bestRatio = ratio;
          bestTab = tab;
        }
      }
      return { ratios, dropletArea: total, bestTab, bestRatio };
    }

    function setPreview(tab) {
      if (state.previewTab === tab) return;
      state.previewTab = tab;
      for (const item of items) {
        const on = Boolean(tab) && item.dataset.tab === tab && tab !== state.active;
        item.classList.toggle("is-preview-target", on);
      }
    }

    function updatePreview() {
      if (!state.drag) return;
      // Пересчитываем не каждый кадр: на медленном движении площадь не меняется.
      if (Math.abs(state.pos - state.lastPreviewX) < 1.2) return;
      state.lastPreviewX = state.pos;
      const info = analyze();
      if (isMajority(info.bestRatio)) state.lastUnambiguous = info.bestTab;
      setPreview(isMajority(info.bestRatio) ? info.bestTab : null);
    }

    // ------------------------------------------------------------- анимация

    function startLoop() {
      if (state.raf) return;
      state.lastTs = 0;
      state.raf = window.requestAnimationFrame(tick);
    }

    function stopLoop() {
      if (state.raf) window.cancelAnimationFrame(state.raf);
      state.raf = 0;
      state.lastTs = 0;
    }

    function tick(timestamp) {
      state.raf = 0;
      const dt = state.lastTs ? Math.min((timestamp - state.lastTs) / 1000, 1 / 30) : 1 / 60;
      state.lastTs = timestamp;
      let moving = false;

      if (state.drag) {
        // Под пальцем капля догоняет точку захвата с небольшой инерцией.
        const k = 1 - Math.exp(-dt / FOLLOW_TAU);
        state.pos += (state.drag.desired - state.pos) * k;
        // Скорость для деформации берём у пальца, а не у сглаженной позиции.
        if (timestamp - state.drag.lastT > 40) {
          state.drag.speed *= Math.exp(-dt / 0.08);
        }
        state.vel = state.drag.speed;
        moving = true;
      } else {
        const accel = -SPRING_K * (state.pos - state.target) - SPRING_C * state.vel;
        state.vel += accel * dt;
        state.pos += state.vel * dt;
        if (Math.abs(state.pos - state.target) < 0.4 && Math.abs(state.vel) < 6) {
          state.pos = state.target;
          state.vel = 0;
        } else {
          moving = true;
        }
      }

      render();
      if (moving) state.raf = window.requestAnimationFrame(tick);
      else state.lastTs = 0;
    }

    // -------------------------------------------------------------- указатель

    function isActiveTab(tab) {
      return tab === state.active;
    }

    function onPointerDown(event) {
      if (event.isPrimary === false) {
        console.debug("[nav] pointerdown ignored: non-primary pointer");
        return;
      }
      if (event.pointerType === "mouse" && event.button !== 0) return;
      // Новый жест отменяет незавершённую защиту клика: если прошлый drag
      // закончился вне панели, click туда не придёт и запись осталась бы висеть.
      state.clickGuard = null;
      // closest() на SVG в некоторых WebView не поднимается до <button>,
      // поэтому ищем вручную — надёжнее и не зависит от реализации closest.
      let item = null;
      let el = event.target;
      while (el && el !== nav) {
        if (el.classList && el.classList.contains("nav-item") && el.dataset && el.dataset.tab) {
          item = el;
          break;
        }
        el = el.parentNode;
      }
      let tab = item ? item.dataset.tab : null;
      // Когда палец нажимает прямо на каплю (SVG), .nav-item через closest не находится,
      // но геометрия подсказывает, что это всё ещё активная вкладка: проверяем
      // пересечение точки с прямоугольником активной вкладки из state.rects.
      if (!tab && state.active && state.rects) {
        const rect = state.rects.find(r => r.tab === state.active);
        if (rect) {
          const r = rect.rect;
          const inRect = event.clientX >= r.left && event.clientX <= r.right && event.clientY >= r.top && event.clientY <= r.bottom;
          if (inRect) {
            tab = state.active;
            // item остаётся null — это не настоящая кнопка, но захват разрешаем
            item = { dataset: { tab } };
          }
        }
      }
      if (!item) return;
      tab = item.dataset.tab;
      // Захватить каплю можно только с активной вкладки: она лежит под ней.
      // Нажатие на неактивную — обычный тап, его обработает click.
      if (!isActiveTab(tab)) {
        state.press = null;
        return;
      }
      measure();
      if (!state.geom) return;
      const now = event.timeStamp || performance.now();
      state.press = {
        pointerId: event.pointerId,
        startX: event.clientX,
        startY: event.clientY,
        lastX: event.clientX,
        lastT: now,
        speed: 0,
        dragging: false,
        // Смещение точки захвата от центра капли: в момент захвата она не
        // прыгает под палец, а остаётся там, где её взяли.
        grabOffset: event.clientX - (state.svgRect.left + state.pos)
      };
    }

    function beginDrag(event, press) {
      // Класс снимает :active-масштаб с вкладок ДО замера: иначе кэш рамок
      // получил бы уменьшенные на 7% прямоугольники.
      nav.classList.add("is-dragging");
      measure();
      if (!state.geom) {
        nav.classList.remove("is-dragging");
        return;
      }
      press.dragging = true;
      state.drag = {
        pointerId: press.pointerId,
        grabOffset: press.grabOffset,
        desired: state.pos,
        speed: 0,
        lastX: event.clientX,
        lastT: event.timeStamp || performance.now()
      };
      state.vel = 0;
      state.lastPreviewX = NaN;
      // pointer capture держит жест даже когда палец уходит за пределы панели.
      try {
        nav.setPointerCapture(press.pointerId);
      } catch (error) {
        // Синтетические события и старые webview: дальше работают window-слушатели.
      }
      updateDrag(event);
      startLoop();
    }

    function updateDrag(event) {
      const drag = state.drag;
      if (!drag) return;
      const now = event.timeStamp || performance.now();
      const dt = Math.max(now - drag.lastT, 8);
      const instant = ((event.clientX - drag.lastX) / dt) * 1000;
      drag.speed = drag.speed * 0.7 + instant * 0.3;
      drag.lastX = event.clientX;
      drag.lastT = now;
      drag.desired = clampCenter(event.clientX - drag.grabOffset - state.svgRect.left);
      startLoop();
    }

    function onPointerMove(event) {
      if (event.isPrimary === false) return;
      const press = state.press;
      if (!press || event.pointerId !== press.pointerId) return;
      if (!press.dragging) {
        const dx = event.clientX - press.startX;
        const dy = event.clientY - press.startY;
        // Стартуем на горизонтальном или диагональном движении с достаточным
        // горизонтальным смещением: вертикальный свайп прокручивает страницу.
        if (Math.abs(dx) < TAP_SLOP) return;
        if (Math.abs(dx) < Math.abs(dy) * 0.5) return;
        beginDrag(event, press);
        return;
      }
      updateDrag(event);
    }

    function releaseCapture(pointerId) {
      try {
        if (nav.hasPointerCapture && nav.hasPointerCapture(pointerId)) {
          nav.releasePointerCapture(pointerId);
        }
      } catch (error) {
        // уже отпущен
      }
    }

    function finishDrag(commit, point) {
      const drag = state.drag;
      const press = state.press;
      state.drag = null;
      state.press = null;
      state.lastPreviewX = NaN;
      nav.classList.remove("is-dragging");
      setPreview(null);
      if (press) releaseCapture(press.pointerId);
      if (!drag) return;

      if (!commit) {
        // Отмена жеста: ни переключения, ни защиты клика — следующее нажатие
        // пользователя должно сработать как обычное.
        state.clickGuard = null;
        state.lastUnambiguous = state.active;
        setActive(state.active, true);
        return;
      }

      // Успешный drag: запоминаем, какой именно click породил этот жест.
      // Подавляется только он — по указателю, координатам и времени.
      state.clickGuard = {
        pointerId: drag.pointerId,
        x: point ? point.x : 0,
        y: point ? point.y : 0,
        time: performance.now()
      };

      state.vel = clamp(drag.speed, -MAX_RELEASE_SPEED, MAX_RELEASE_SPEED);
      const info = analyze();
      if (isMajority(info.bestRatio)) state.lastUnambiguous = info.bestTab;
      const fallback = state.lastUnambiguous || state.active;
      const target = pickTarget(info.ratios, fallback);
      if (target && target !== state.active) {
        // switchTab в app.js вызовет updateDroplet → setActive и доведёт каплю.
        onCommit(target);
      } else {
        setActive(state.active, true);
      }
    }

    function onPointerUp(event) {
      if (event.isPrimary === false) return;
      const press = state.press;
      if (!press || event.pointerId !== press.pointerId) return;
      if (press.dragging) {
        // Финальную позицию фиксируем по последней координате указателя.
        if (state.drag) {
          state.drag.desired = clampCenter(event.clientX - state.drag.grabOffset - state.svgRect.left);
          state.pos = state.drag.desired;
          render();
        }
        finishDrag(true, { x: event.clientX, y: event.clientY });
      } else {
        state.press = null;
      }
    }

    function onPointerCancel(event) {
      if (event.isPrimary === false) return;
      // lostpointercapture всплывает от дочерних элементов. Палец попадает в
      // иконку/SVG внутри вкладки, браузер ставит неявный capture на неё, а наш
      // setPointerCapture(nav) его снимает — и это событие прилетало сюда как
      // «отмена», убивая жест сразу после старта. Реальная потеря захвата
      // приходит на саму панель (target === nav) вместе с pointercancel.
      if (event.type === "lostpointercapture" && event.target !== nav) return;
      const press = state.press;
      if (!press || event.pointerId !== press.pointerId) return;
      if (press.dragging) {
        console.debug("[nav] drag cancelled: pointercancel/lostcapture");
        finishDrag(false);
      } else state.press = null;
    }

    // click после drag: гасим одноразово и только «свой» — тот же указатель,
    // та же точка и сразу после pointerup. Самостоятельные клики проходят.
    function onClickCapture(event) {
      const guard = state.clickGuard;
      if (!guard) return;
      // Запись одноразовая: любое следующее событие её снимает.
      state.clickGuard = null;
      // Клавиатурный click (Enter/Space) не имеет координат и detail — не наш.
      if (!event.detail) return;
      const now = event.timeStamp || performance.now();
      const samePointer = event.pointerId === undefined || event.pointerId === guard.pointerId;
      const near = Math.hypot((event.clientX || 0) - guard.x, (event.clientY || 0) - guard.y) <= CLICK_GUARD_RADIUS;
      if (now - guard.time > CLICK_GUARD_TTL || !samePointer || !near) return;
      event.preventDefault();
      event.stopImmediatePropagation();
    }

    // ------------------------------------------------------------ публичное

    function setActive(tab, animate = true) {
      const center = centerOf(tab);
      if (center === null) {
        // Панель скрыта — запомним вкладку, каплю поставим при refresh().
        state.active = tab;
        return;
      }
      state.active = tab;
      state.lastUnambiguous = tab;
      for (const item of items) {
        const active = item.dataset.tab === tab;
        item.classList.toggle("is-active", active);
        if (active) item.setAttribute("aria-current", "page");
        else item.removeAttribute("aria-current");
        if (active) item.classList.remove("is-preview-target");
      }
      state.target = center;
      if (!animate || state.reduced) {
        stopLoop();
        state.pos = center;
        state.vel = 0;
        render();
        return;
      }
      startLoop();
    }

    function refresh() {
      const previousTarget = state.target;
      measure();
      if (!state.geom) return;
      // Тема и акцентная палитра могли смениться — перечитываем цвета.
      readPalette();
      const center = centerOf(state.active);
      state.target = center === null ? previousTarget : center;
      if (!state.drag) {
        state.pos = state.target;
        state.vel = 0;
        render();
      } else {
        // Размер изменился во время жеста — пересчитываем точку захвата.
        state.drag.desired = clampCenter(state.drag.desired);
      }
    }

    function destroy() {
      stopLoop();
      if (lens && lens.layer.parentNode) lens.layer.parentNode.removeChild(lens.layer);
      if (baseMask && baseMask.holder.parentNode) baseMask.holder.parentNode.removeChild(baseMask.holder);
      nav.removeEventListener("pointerdown", onPointerDown);
      window.removeEventListener("pointermove", onPointerMove);
      window.removeEventListener("pointerup", onPointerUp);
      window.removeEventListener("pointercancel", onPointerCancel);
      nav.removeEventListener("lostpointercapture", onPointerCancel);
      nav.removeEventListener("click", onClickCapture, true);
      nav.removeEventListener("touchmove", onTouchMove);
      window.removeEventListener("resize", onResize);
      window.removeEventListener("blur", onBlur);
      if (observer) observer.disconnect();
      if (motionQuery) {
        if (motionQuery.removeEventListener) motionQuery.removeEventListener("change", syncReduced);
        else if (motionQuery.removeListener) motionQuery.removeListener(syncReduced);
      }
    }

    function onResize() {
      refresh();
    }

    function onBlur() {
      // Вкладка ушла в фон посреди жеста — не оставляем каплю «в руке».
      if (state.press) finishDrag(false);
    }

    // Fallback для WebView, где touch-action не отключает скролл:
    // пока жест жив, preventDefault() гарантирует, что браузер
    // не уведёт pointer в pointercancel из-за начавшегося скролла.
    function onTouchMove(event) {
      if (state.press || state.drag) event.preventDefault();
    }

    nav.addEventListener("pointerdown", onPointerDown);
    // Слушатели на window: при pointer capture события всё равно всплывают сюда,
    // а если capture не сработал (старый webview) — жест не потеряется.
    window.addEventListener("pointermove", onPointerMove);
    window.addEventListener("pointerup", onPointerUp);
    window.addEventListener("pointercancel", onPointerCancel);
    nav.addEventListener("lostpointercapture", onPointerCancel);
    nav.addEventListener("click", onClickCapture, true);
    window.addEventListener("resize", onResize);
    window.addEventListener("blur", onBlur);
    // passive: false обязателен, иначе preventDefault() проигнорируется.
    nav.addEventListener("touchmove", onTouchMove, { passive: false });

    let observer = null;
    if (window.ResizeObserver) {
      observer = new ResizeObserver(() => refresh());
      observer.observe(nav);
    }

    measure();
    readPalette();
    render();

    return {
      setActive,
      refresh,
      destroy,
      getState: () => ({
        active: state.active,
        pos: state.pos,
        target: state.target,
        dragging: Boolean(state.drag),
        // Доля накрытия каждой вкладки каплей: 0 — вне, 1 — целиком внутри.
        tints: { ...state.tints }
      })
    };
  }

  window.createLiquidNav = createLiquidNav;
  // Чистые функции наружу — для юнит-тестов геометрии.
  createLiquidNav.geometry = {
    polygonArea,
    clipPolygonToRect,
    overlapArea,
    coverageRatios,
    isMajority,
    pickTarget
  };
  // Линза и перекраска: чистые функции для юнит-тестов.
  createLiquidNav.lens = { parseColor, mixColor, coverageOf };
})();
