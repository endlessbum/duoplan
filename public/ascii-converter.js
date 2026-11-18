// Локальная конвертация изображения в ASCII для дневника DuoPlan.
// Оригинал фото никогда не покидает устройство: здесь только decode ->
// canvas -> пиксели -> текст. В Worker уходит лишь готовая строка.
//
// Модуль — чистые функции (testable в Node) + тонкий браузерный адаптер.
// Экспортируется в window.AsciiConverter; в Node доступен через
// globalThis.AsciiConverter после eval (как у zoom-guard).
(function (global) {
  "use strict";

  // Палитры строго от плотного/тёмного символа к светлому/редкому.
  // Нельзя смешивать ASCII-градацию и Unicode-блоки в одну строку:
  // плотность символов в смешанной строке не монотонна (план §5.4).
  const PALETTES = {
    // Классическая расширенная градация Paul Bourke — только печатный ASCII.
    detail: "$@B%8&WM#*oahkbdpqwmZO0QLCJUYXzcvunxrjft/\\|()1{}[]?-_+~<>i!lI;:,\"^`'. ",
    // Грубый контрастный вариант.
    classic: "@%#*+=-:. ",
    // Пиксельный вид Unicode-блоками (от darkest к lightest).
    blocks: "█▓▒░ "
  };
  const PALETTE_KEYS = Object.keys(PALETTES);

  // Лимиты контракта API v1 (worker.js validateAsciiArt): 144x120, 18000 точек.
  // Серверный потолок (worker.js validateAsciiArt): 144x120 и 18000
  // кодовых точек — покрывает пресет "max"; меньшие сетки валидны всегда.
  const LIMITS = { maxColumns: 144, maxRows: 120, maxLength: 18000 };

  // Уровни качества: плотность ASCII-сетки. "high" — рекомендуемый режим
  // (в 4 раза больше ячеек, чем базовый 48x40); "max" — экспериментальный.
  const QUALITY_PRESETS = {
    standard: { cols: 48, rows: 40, label: "Обычное" },
    high:     { cols: 96, rows: 80, label: "Детальное" },
    max:      { cols: 144, rows: 120, label: "Максимум" }
  };
  // Отношение ширины знакоместа к высоте строки для типичного
  // моноширинного шрифта: символ ~0.6 ширины, строка ~1.2 высоты,
  // ячейка ~0.5. Параметр, подгоняется визуально на реальных WebView.
  const DEFAULT_CELL_RATIO = 0.5;

  const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

  // Вписывание в рамку maxColumns x maxRows с сохранением пропорций
  // (contain): масштаб ограничен обеими сторонами, результат целочисленный.
  function fitSize(srcW, srcH, maxColumns, maxRows, cellRatio) {
    if (!(srcW > 0) || !(srcH > 0)) return { cols: 0, rows: 0 };
    const ratio = cellRatio > 0 ? cellRatio : DEFAULT_CELL_RATIO;
    // Пиксельная «высота» строки в единицах ширины символа: строка выше
    // знакоместа, поэтому один ряд покрывает srcH/srcW * ratio пикселей
    // по вертикали в пересчёте на столбец.
    // ratio — ширина символа к его высоте. Физическое соотношение сторон
    // текстовой сетки (cols*ratio)/rows должно равняться srcW/srcH, откуда
    // rows = cols * ratio * (srcH/srcW). Обе ветки ограничений выведены из
    // этого же равенства (fix-plan: ratio применялся в обратную сторону).
    const rowsByHeight = Math.max(1, Math.floor(maxRows));
    const heightLimitedCols = (rows) =>
      Math.max(1, Math.min(maxColumns, Math.floor(rows * (srcW / srcH) / ratio)));
    let cols = Math.min(maxColumns, heightLimitedCols(rowsByHeight));
    let rows = Math.max(1, Math.round(cols * ratio * (srcH / srcW)));
    if (rows > maxRows) {
      rows = maxRows;
      cols = heightLimitedCols(rows);
    }
    // Символов с переводами строк: rows*(cols+1)-1 <= maxLength
    while (cols > 1 && rows * (cols + 1) - 1 > LIMITS.maxLength) cols--;
    while (rows > 1 && rows * (cols + 1) - 1 > LIMITS.maxLength) rows--;
    return { cols, rows };
  }

  // Воспринимаемая яркость (Rec. 601 приближённо к 709 для ASCII-целей).
  function luma(r, g, b) {
    return 0.299 * r + 0.587 * g + 0.114 * b;
  }

  // Контраст/яркость вокруг середины шкалы, результат в 0..255.
  function adjustBrightness(v, brightness, contrast) {
    // brightness: -100..100 (% сдвига), contrast: -100..100 (% вокруг 128)
    let out = v + (brightness / 100) * 255;
    const c = 1 + contrast / 100;
    out = (out - 128) * c + 128;
    return clamp(out, 0, 255);
  }

  // Чистое преобразование: RGBA-пиксели srcW x srcH -> ASCII-строка.
  // options: { palette, cols, rows, brightness, contrast, invert, cellRatio }
  // cols/rows <= 0 => авто fit по LIMITS.
  // Выборка — среднее значение яркости (Rec.601 luma) по всем пикселям,
  // попадающим в область ASCII-ячейки: уменьшает шум на фото с мелкими
  // деталями по сравнению с выбором одного пикселя. Это НЕ билинейная
  // фильтрация — формального resampling здесь нет, только box-average.
  function pixelsToAscii(pixels, srcW, srcH, options = {}) {
    const palette = PALETTES[options.palette] || PALETTES.detail;
    const { cols, rows } = (() => {
      if (options.cols > 0 && options.rows > 0) {
        return { cols: Math.min(options.cols, LIMITS.maxColumns), rows: Math.min(options.rows, LIMITS.maxRows) };
      }
      return fitSize(srcW, srcH, LIMITS.maxColumns, LIMITS.maxRows, options.cellRatio);
    })();
    if (!cols || !rows || !pixels || srcW <= 0 || srcH <= 0) return "";

    const brightness = options.brightness ?? 0;
    const contrast = options.contrast ?? 10;
    const invert = options.invert === true;

    // Усреднение по области ячейки: границы блока считаем через floor по
    // долям исходника — каждый пиксель попадает ровно в одну ячейку.
    const lines = [];
    for (let y = 0; y < rows; y++) {
      const y0 = Math.floor((y * srcH) / rows);
      const y1 = Math.max(y0 + 1, Math.floor(((y + 1) * srcH) / rows));
      let line = "";
      for (let x = 0; x < cols; x++) {
        const x0 = Math.floor((x * srcW) / cols);
        const x1 = Math.max(x0 + 1, Math.floor(((x + 1) * srcW) / cols));
        let sum = 0, count = 0;
        for (let py = y0; py < Math.min(y1, srcH); py++) {
          let i = (py * srcW + x0) * 4;
          for (let pxI = x0; pxI < Math.min(x1, srcW); pxI++, i += 4) {
            sum += luma(pixels[i], pixels[i + 1], pixels[i + 2]);
            count++;
          }
        }
        const lum = adjustBrightness(sum / Math.max(1, count), brightness, contrast);
        // Тёмное -> плотный символ (начало палитры), светлое -> конец.
        let idx = Math.round((lum / 255) * (palette.length - 1));
        if (invert) idx = palette.length - 1 - idx;
        line += palette[idx];
      }
      lines.push(line);
    }
    return lines.join("\n");
  }

  // Проверка результата на соответствие лимитам API (для UI-предупреждений).
  function validateResult(art) {
    if (typeof art !== "string" || !art) return { ok: false, reason: "empty" };
    const rows = art.split("\n");
    if (rows.length > LIMITS.maxRows) return { ok: false, reason: "rows" };
    for (const row of rows) {
      if (Array.from(row).length > LIMITS.maxColumns) return { ok: false, reason: "columns" };
    }
    if (Array.from(art).length > LIMITS.maxLength) return { ok: false, reason: "length" };
    return { ok: true };
  }

  // ---------------- Браузерный адаптер ----------------

  const MAX_FILE_BYTES = 25 * 1024 * 1024;   // 25 МБ — щедро для фото, щадяще для WebView

  function loadImage(file) {
    return new Promise((resolve, reject) => {
      // createImageBitmap с imageOrientation:"from-image" учитывает EXIF;
      // fallback — <img> + object URL для старых WebView.
      if (typeof createImageBitmap === "function") {
        createImageBitmap(file, { imageOrientation: "from-image" })
          .then(resolve)
          .catch(() => decodeViaImg(file).then(resolve, reject));
        return;
      }
      decodeViaImg(file).then(resolve, reject);
    });
  }

  function decodeViaImg(file) {
    return new Promise((resolve, reject) => {
      const url = URL.createObjectURL(file);
      const img = new Image();
      img.onload = () => {
        URL.revokeObjectURL(url);
        resolve(img);
      };
      img.onerror = () => {
        URL.revokeObjectURL(url);
        reject(new Error("decode"));
      };
      img.src = url;
    });
  }

  function sourceSize(bitmap) {
    return { w: bitmap.width || bitmap.naturalWidth, h: bitmap.height || bitmap.naturalHeight };
  }

  function releaseBitmap(bitmap) {
    try { if (bitmap && typeof bitmap.close === "function") bitmap.close(); } catch (e) { /* noop */ }
  }

  // Главная точка входа UI: File -> ASCII-строка. Бросает Error с .code
  // ("too-large" | "decode" | "empty"), UI показывает понятное сообщение.
  async function fileToAscii(file, options = {}) {
    if (!file) throw Object.assign(new Error("no-file"), { code: "no-file" });
    if (file.size > (options.maxFileBytes || MAX_FILE_BYTES)) {
      throw Object.assign(new Error("too-large"), { code: "too-large" });
    }
    const bitmap = await loadImage(file);
    try {
      const { w, h } = sourceSize(bitmap);
      if (!(w > 0) || !(h > 0)) throw Object.assign(new Error("empty"), { code: "empty" });

      // Сетку считаем ДО чтения пикселей и рендерим сразу в canvas
      // размером cols*SS x rows*SS*2 (ячейка символа ~1:2 по ширине/высоте,
      // SS — supersample для box-усреднения в pixelsToAscii). Для максимума
      // 144x120 это ~1152x1920 вместо 4096x4096 — память и getImageData
      // остаются в пределах (fix-plan P1.2).
      const preset = QUALITY_PRESETS[options.quality] || QUALITY_PRESETS.high;
      const grid = (options.cols > 0 && options.rows > 0)
        ? { cols: Math.min(options.cols, preset.cols), rows: Math.min(options.rows, preset.rows) }
        : fitSize(w, h, preset.cols, preset.rows, options.cellRatio);
      if (!grid.cols || !grid.rows) throw Object.assign(new Error("empty"), { code: "empty" });
      const SS = 8;
      // Верхняя граница размера — сама сетка: cols<=144, rows<=120,
      // SS=8 -> максимум 1152x1920 px. Отдельный лимит декода не нужен.
      const dw = Math.max(1, grid.cols * SS);
      const dh = Math.max(1, grid.rows * SS * 2);

      const canvas = document.createElement("canvas");
      canvas.width = dw;
      canvas.height = dh;
      const ctx = canvas.getContext("2d", { willReadFrequently: true });
      if (!ctx) throw Object.assign(new Error("no-canvas"), { code: "no-canvas" });
      // Монохром считается из RGB — drawImage как есть, альфу игнорируем
      // (прозрачные области считаем белыми через alpha-препmultiply ниже).
      // Сглаживание при даунскейле явно включено: box-фильтр canvas'а
      // уже усредняет области, а pixelsToAscii довернёт остаток до
      // равных долей ячейки.
      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = "high";
      ctx.drawImage(bitmap, 0, 0, dw, dh);
      const imageData = ctx.getImageData(0, 0, dw, dh);
      const px = imageData.data;
      // Прозрачность -> белый фон (как «нет чернил» на бумаге)
      for (let i = 3; i < px.length; i += 4) {
        if (px[i] < 255) {
          const a = px[i] / 255;
          px[i - 3] = Math.round(px[i - 3] * a + 255 * (1 - a));
          px[i - 2] = Math.round(px[i - 2] * a + 255 * (1 - a));
          px[i - 1] = Math.round(px[i - 1] * a + 255 * (1 - a));
          px[i] = 255;
        }
      }
      // Явные cols/rows обязательны: авто-fit в pixelsToAscii считал бы
      // по серверному LIMITS, а не по пресету качества.
      const art = pixelsToAscii(px, dw, dh, { ...options, cols: grid.cols, rows: grid.rows });
      const check = validateResult(art);
      if (!check.ok) throw Object.assign(new Error("result-" + check.reason), { code: "result-" + check.reason });
      return art;
    } finally {
      releaseBitmap(bitmap);
    }
  }

  const api = {
    PALETTES, PALETTE_KEYS, LIMITS, QUALITY_PRESETS, DEFAULT_CELL_RATIO,
    fitSize, luma, adjustBrightness, pixelsToAscii, validateResult,
    fileToAscii
  };
  global.AsciiConverter = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof window !== "undefined" ? window : globalThis);
