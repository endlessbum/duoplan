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

// Действие дня детерминировано парой и датой, чтобы одна и та же пара получала
// одно и то же задание на любой поверхности: полиномиальный хеш по кодовым
// точкам (база 31, переполнение по 32 битам беззнаково), индекс — остаток.
// Точно такой же алгоритм в duoplan/services.py::_daily_action. Менять только
// вместе: tests/test_daily_parity.test.mjs и tests/test_daily_parity.py держат
// обе реализации на общих векторах из tests/fixtures/daily_actions.json.
function dailyAction(pairId, day) {
  let seed = 0;
  for (const char of `${pairId}:${day}`) seed = (seed * 31 + char.charCodeAt(0)) >>> 0;
  return DAILY_ACTIONS[seed % DAILY_ACTIONS.length];
}

const APP_VERSION = "2026.11.06.37";
// Версия схемы D1 — дата последнего изменения структуры таблиц, формат YYYY.MM.DD
// (суффикс .N — вторая и дальнейшие смены схемы за тот же день: строка обязана
// отличаться от уже записанной в app_meta, иначе ensureSchema пропустит ALTER'ы
// и новая колонка никогда не появится на работающей базе).
// Она не может опережать текущую дату: записанная «на будущее» версия совпадёт
// с проверкой в ensureSchema() раньше, чем схема реально изменится, и следующая
// миграция с той же датой будет молча пропущена. На релизе обе версии совпадают.
const DB_SCHEMA_VERSION = "2026.11.06.37";
const DEFAULT_TZ = "Europe/Moscow";

// Акцентные цвета интерфейса: ключ хранится в users.accent_color (NULL = «berry»),
// палитры под светлую/тёмную тему живут на клиенте в public/app.js.
const ACCENT_KEYS = ["berry", "sage", "ocean", "violet", "amber"];

// /api/state отдаёт активные наборы с потолком STATE_ACTIVE_LIMIT и только
// последние записи архивов; остальное догружается страницами через /api/archive
// (у активных наборов база смещения — STATE_ACTIVE_LIMIT, у архивов — STATE_RECENT_LIMIT).
const STATE_ACTIVE_LIMIT = 200;
const STATE_RECENT_LIMIT = 10;
const ARCHIVE_PAGE_SIZE = 20;
const ARCHIVE_QUERIES = {
  memories: {
    sql: `SELECT m.id,m.author_id,m.title,m.body,m.day,m.created_at,u.display_name FROM memories m
      LEFT JOIN users u ON u.tg_id=m.author_id WHERE m.pair_id=? ORDER BY m.created_at DESC, m.id DESC LIMIT ? OFFSET ?`
  },
  done_tasks: {
    userScoped: true,
    // monthly/yearly нужны и завершённым: карточку архива можно редактировать,
    // диалог читает item.monthly/item.yearly — без колонок PATCH обнулял флаги
    // повтора, и повторяющийся план необратимо становился разовым.
    sql: "SELECT id,title,status,day,time,monthly,yearly,is_private,created_by,created_at,completed_at FROM tasks WHERE pair_id=? AND status='done' AND (is_private=0 OR created_by=?) ORDER BY completed_at DESC, id DESC LIMIT ? OFFSET ?"
  },
  done_wishes: {
    sql: `SELECT w.id,w.body,w.owner_id,w.created_at,w.done_at,w.url,u.display_name FROM wishes w
      LEFT JOIN users u ON u.tg_id=w.owner_id WHERE w.pair_id=? AND w.done=1 ORDER BY w.created_at DESC, w.id DESC LIMIT ? OFFSET ?`
  },
  // Активные наборы: продолжение списков /api/state после 200-й записи.
  // Порядок wishes совпадает со state (SQL). Для tasks/dates И state(), И эта
  // страница сортируют ОДНИМ хелпером полный набор без SQL-лимита: state отдаёт
  // первые 200, страница — сдвиг от 200-й. Разные последовательности дают дубли
  // и потерянные записи (репорт 2026-10-29), поэтому SQL здесь намеренно без LIMIT.
  tasks: {
    active: true,
    sort: "deadline",
    userScoped: true,
    sql: "SELECT id,title,status,day,time,monthly,yearly,is_private,created_by,created_at FROM tasks WHERE pair_id=? AND status='open' AND (is_private=0 OR created_by=?) ORDER BY created_at DESC"
  },
  dates: {
    active: true,
    sort: "date",
    // Личные даты видит только создатель: фильтр в SQL, а не после запроса —
    // иначе приватная запись успевает попасть в сортируемый набор.
    userScoped: true,
    sql: "SELECT id,title,day,time,recurs,monthly,is_private,created_by,kind,created_at FROM dates WHERE pair_id=? AND (is_private=0 OR created_by=?) ORDER BY day"
  },
  wishes: {
    active: true,
    sql: `SELECT w.id,w.body,w.owner_id,w.created_at,w.done_at,w.url,u.display_name FROM wishes w
      LEFT JOIN users u ON u.tg_id=w.owner_id WHERE w.pair_id=? AND w.done=0 ORDER BY w.created_at DESC, w.id DESC LIMIT ? OFFSET ?`
  }
};

// Схема D1 поднимается один раз на изолят Worker (CREATE IF NOT EXISTS + ADD COLUMN).
// Это закрывает случай, когда миграции 0003/0004/0005 ещё не применены на remote.
const schemaReady = new WeakMap();
async function ensureSchemaOnce(env) {
  if (!env?.DB) return;
  let pending = schemaReady.get(env.DB);
  if (!pending) {
    pending = ensureSchema(env).catch(error => {
      schemaReady.delete(env.DB);
      throw error;
    });
    schemaReady.set(env.DB, pending);
  }
  await pending;
}

class HttpError extends Error {
  constructor(status, message, code = "REQUEST_ERROR") {
    super(message);
    this.status = status;
    this.code = code;
  }
}

const json = (data, status = 200, extra = {}) => new Response(JSON.stringify(data), {
  status,
  headers: {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
    ...extra
  }
});
const now = () => Math.floor(Date.now() / 1000);
const positiveId = value => Number.isSafeInteger(Number(value)) && Number(value) > 0;
const clean = value => String(value ?? "").trim();
const displayName = user => {
  const name = clean(user.first_name) || clean(user.username) || "Без имени";
  return Array.from(name).slice(0, 80).join("");
};

function textField(body, key, max, label) {
  const value = clean(body?.[key]);
  if (!value) throw new HttpError(400, `Заполните поле «${label}»`, "VALIDATION_ERROR");
  if (Array.from(value).length > max) throw new HttpError(400, `«${label}»: не больше ${max} символов`, "VALIDATION_ERROR");
  return value;
}

// Деньги копилки: целое положительное число. Дробное отклоняется явно:
// Math.floor молча резал копейки (125.90 -> 125), незаметно меняя данные.
function moneyAmount(value, label) {
  const amount = Number(value);
  if (!Number.isSafeInteger(amount) || amount <= 0 || amount > 1000000000) {
    throw new HttpError(400, `${label}: целое число рублей больше нуля, без копеек`, "INVALID_AMOUNT");
  }
  return amount;
}

// /start с кодом приглашения: Telegram позволяет писать /start@botname,
// и такой текст раньше не матчился префиксом "/start " — код после упоминания
// терялся, пользователь получал generic-ответ. Аргумент может быть и после
// простого /start, и после /start@упоминание.
const START_PAYLOAD_RE = /^\/start(?:@[A-Za-z0-9_]+)?(?:\s+(.+))?$/i;

function startPayload(text) {
  const match = START_PAYLOAD_RE.exec(String(text || "").trim());
  return match?.[1]?.trim() || "";
}

// Ссылка желания: опциональна (пусто — у желания нет ссылки), но если
// указана — должна быть корректным http(s) адресом. Иначе через window.open
// через Mini App можно было бы доставить javascript: и прочие опасные схемы.
function wishUrl(value) {
  const url = clean(value);
  if (!url) return "";
  if (Array.from(url).length > 2048) throw new HttpError(400, "Ссылка: не больше 2048 символов", "INVALID_URL");
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    throw new HttpError(400, "Ссылка должна быть корректным адресом", "INVALID_URL");
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new HttpError(400, "Ссылка должна быть адресом http или https", "INVALID_URL");
  }
  return url;
}

// ---------------------------------------------------------------------------
// Кино: данные IMDb. Официального API у IMDb нет, поэтому используем
// публичный suggest-эндпоинт (подсказки при вводе) и страницу тайтла
// (JSON-LD + __NEXT_DATA__ для сезонов сериалов). Данные — снимок на момент
// добавления: хранятся в строке movies, при чтениях наружу не ходим.
// ---------------------------------------------------------------------------
const IMDB_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";
const IMDB_TIMEOUT_MS = 8000;
const IMDB_SUGGEST_TTL_MS = 24 * 3600 * 1000;
const imdbSuggestCache = new Map();

// Поле q у suggestion — текстовый тип («feature», «TV series», …). Берём
// только то, что можно посмотреть: полнометражки, ТВ-фильмы и сериалы.
const IMDB_KIND_BY_TYPE = {
  "feature": "movie",
  "tv movie": "movie",
  "tv series": "series",
  "tv mini series": "series"
};

// Названия подсказок локализуются по TMDB (если задан TMDB_API_KEY);
// без ключа список остаётся английским, как отдал источник.
async function localizeResults(env, items) {
  const localized = await Promise.all(items.map((item) => tmdbLocalize(env, item.imdb_id)));
  return items.map((item, i) => localized[i]?.title ? { ...item, title: localized[i].title } : item);
}

// Поиск подсказок: основной источник — suggest IMDb (у OMDb поиск слаб:
// русские и частичные запросы почти всегда мимо), OMDb — запасной.
async function imdbSearch(rawQuery, env) {
  const query = String(rawQuery || "").trim().slice(0, 100);
  if (!query) throw new HttpError(400, "Введите название фильма или сериала", "INVALID_QUERY");
  const cacheKey = query.toLowerCase();
  const cached = imdbSuggestCache.get(cacheKey);
  if (cached && Date.now() - cached.at < IMDB_SUGGEST_TTL_MS) return cached.results;
  let payload;
  try {
    const response = await fetch(`https://v3.sg.media-imdb.com/suggestion/x/${encodeURIComponent(query)}.json`, {
      headers: { "User-Agent": IMDB_UA, "Accept": "application/json" },
      signal: AbortSignal.timeout(IMDB_TIMEOUT_MS)
    });
    if (!response.ok) throw new Error(`status ${response.status}`);
    payload = await response.json();
  } catch (error) {
    // Прямой IMDb не отвечает — пробуем OMDb-фолбэк (если задан ключ),
    // иначе отдаём ошибку в формате API (сырые Error из fetch заворачиваем).
    const fallback = await omdbSearch(env, query);
    if (fallback?.length) {
      const localizedFallback = await localizeResults(env, fallback);
      imdbSuggestCache.set(cacheKey, { at: Date.now(), results: localizedFallback });
      return localizedFallback;
    }
    throw error instanceof HttpError
      ? error
      : new HttpError(502, "IMDb сейчас недоступен, попробуйте позже", "IMDB_UNAVAILABLE");
  }
  const results = (Array.isArray(payload.d) ? payload.d : [])
    .filter((item) => typeof item?.id === "string" && /^tt\d+$/.test(item.id) && IMDB_KIND_BY_TYPE[String(item?.q || "").toLowerCase()])
    .slice(0, 8)
    .map((item) => ({
      imdb_id: item.id,
      title: String(item.l || "").slice(0, 180),
      year: Number(item.y) || null,
      kind: IMDB_KIND_BY_TYPE[String(item.q).toLowerCase()]
    }));
  // Подсказки показываются пользователю — локализуем названия по TMDB
  // (если задан TMDB_API_KEY; без него остаются английские).
  const localizedResults = await localizeResults(env, results);
  imdbSuggestCache.set(cacheKey, { at: Date.now(), results: localizedResults });
  // Простая гигиена памяти изолята: при переполнении стираем самый старый ключ.
  if (imdbSuggestCache.size > 200) {
    imdbSuggestCache.delete(imdbSuggestCache.keys().next().value);
  }
  return localizedResults;
}

// Карточка по tt-id через публичный suggest-эндпоинт (тот же CDN, что и
// поиск: с egress Cloudflare он отвечает, а www.imdb.com — анти-бот страница
// 202 без JSON-LD, HTML-скрейп из воркера не работает). Отдаёт название, год
// и тип; рейтинга/жанра/длительности в этом ответе нет — их добирает OMDb.
async function imdbSuggestTitle(imdbId) {
  const response = await fetch(`https://v3.sg.media-imdb.com/suggestion/x/${encodeURIComponent(imdbId)}.json`, {
    headers: { "User-Agent": IMDB_UA, "Accept": "application/json" },
    signal: AbortSignal.timeout(IMDB_TIMEOUT_MS)
  });
  if (!response.ok) throw new Error(`status ${response.status}`);
  const payload = await response.json();
  const entry = (Array.isArray(payload.d) ? payload.d : []).find((item) => item.id === imdbId);
  if (!entry) return null;
  return {
    title: String(entry.l || "").slice(0, 180) || null,
    rating: null,
    genre: null,
    kind: suggestKind(entry),
    year: Number(entry.y) || null,
    runtime: null,
    seasons: null,
    episodes: null
  };
}

// Тип из suggest-by-id: qid каноничен («movie»/«tvSeries»), q — человеческий
// («feature»/«TV series»). Всё с «series» — сериал, остальное считаем фильмом.
function suggestKind(entry) {
  const qid = String(entry?.qid || "").toLowerCase();
  if (qid.includes("series")) return "series";
  return IMDB_KIND_BY_TYPE[String(entry?.q || "").toLowerCase()] || "movie";
}

// ---------------------------------------------------------------------------
// OMDb API — основной источник карточки фильма (rating/genre/runtime одним
// ответом; в поиске — запасной, потому что его поиск слаб: русские запросы
// и частичные названия почти всегда «Too many results»/«Movie not found!»).
// Ключ бесплатный (1000 запросов/день) и опционален: без секрета
// OMDB_API_KEY карточка собирается из suggest-эндпоинта IMDb без рейтинга.
// ---------------------------------------------------------------------------
function omdbMinutes(value) {
  const match = /^(\d+)\s*min/i.exec(String(value || ""));
  return match ? Number(match[1]) : null;
}

async function omdbFetch(env, params) {
  const key = env?.OMDB_API_KEY;
  if (!key) return null;
  try {
    const response = await fetch(`https://www.omdbapi.com/?apikey=${encodeURIComponent(key)}&${params}`, {
      signal: AbortSignal.timeout(IMDB_TIMEOUT_MS)
    });
    if (!response.ok) return null;
    const payload = await response.json();
    // OMDb отвечает {"Response":"False","Error":…} со статусом 200.
    return payload?.Response === "True" ? payload : null;
  } catch {
    return null;
  }
}

// Поиск OMDb (s=): отдаёт movie/series с imdbID — тот же формат, что у suggest.
async function omdbSearch(env, query) {
  const payload = await omdbFetch(env, `s=${encodeURIComponent(query)}`);
  if (!payload) return null;
  return (Array.isArray(payload.Search) ? payload.Search : [])
    .filter((item) => /^tt\d+$/.test(String(item?.imdbID || "")) && ["movie", "series"].includes(item?.Type))
    .slice(0, 8)
    .map((item) => ({
      imdb_id: item.imdbID,
      title: String(item.Title || "").slice(0, 180),
      year: Number(String(item.Year || "").slice(0, 4)) || null,
      kind: item.Type === "series" ? "series" : "movie"
    }));
}

// Тайтл OMDb (i=): рейтинг, жанр, длительность и сезоны одним ответом.
async function omdbTitle(env, imdbId) {
  const payload = await omdbFetch(env, `i=${encodeURIComponent(imdbId)}`);
  if (!payload) return null;
  const rating = Number(payload.imdbRating);
  return {
    title: String(payload.Title || "").slice(0, 180) || null,
    rating: Number.isFinite(rating) && rating > 0 && rating <= 10 ? Math.round(rating * 10) / 10 : null,
    genre: String(payload.Genre || "").split(",")[0].trim() || null,
    kind: payload.Type === "series" ? "series" : "movie",
    year: Number(String(payload.Year || "").slice(0, 4)) || null,
    runtime: omdbMinutes(payload.Runtime),
    seasons: Number(payload.totalSeasons) || null,
    episodes: null
  };
}

// ---------------------------------------------------------------------------
// TMDB — локализация «Кино»: русские названия и жанры (suggest IMDb и OMDb
// отдают только оригинальные английские). Ключ бесплатный (themoviedb.org →
// Settings → API), секрет TMDB_API_KEY; без него приложение показывает
// английские названия. Русские тайтлы тянутся find'ом по tt-id и кешируются
// надолго — названия фильмов не меняются.
// ---------------------------------------------------------------------------
const TMDB_RU_TTL_MS = 30 * 86400 * 1000;
const TMDB_GENRE_TTL_MS = 86400 * 1000;
const tmdbRuCache = new Map();    // tt-id → { title, genreIds } | null
const tmdbGenreCache = new Map(); // "movie"/"tv" → { at, map: id → название }

async function tmdbFetch(env, path, params) {
  const key = env?.TMDB_API_KEY;
  if (!key) return null;
  try {
    const response = await fetch(`https://api.themoviedb.org/3${path}?api_key=${encodeURIComponent(key)}&language=ru-RU&${params}`, {
      signal: AbortSignal.timeout(IMDB_TIMEOUT_MS)
    });
    if (!response.ok) return null;
    return await response.json();
  } catch {
    return null;
  }
}

// Русское название и жанровые id по tt-id. null — ключа нет, сбой сети или
// TMDB тайтла не знает. Кешируется только настоящий ответ TMDB (включая
// «не нашли») — сетевой сбой НЕ кешируется, чтобы следующий запрос повторил
// попытку, а не застрял с пустым результатом на месяц.
async function tmdbLocalize(env, imdbId) {
  if (!env?.TMDB_API_KEY) return null;
  const cached = tmdbRuCache.get(imdbId);
  if (cached && Date.now() - cached.at < TMDB_RU_TTL_MS) return cached.value;
  const payload = await tmdbFetch(env, `/find/${encodeURIComponent(imdbId)}`, "external_source=imdb_id");
  if (!payload) return null;
  // tt-id — фильм или сериал: берём первый непустой массив результатов.
  const movieEntry = payload?.movie_results?.[0] || null;
  const tvEntry = payload?.tv_results?.[0] || null;
  const entry = movieEntry || tvEntry;
  const value = entry
    ? {
        // id/kind нужны деталям карточки: /movie/{id} или /tv/{id}.
        id: Number(entry.id) || null,
        kind: movieEntry ? "movie" : "tv",
        title: String(entry.title || entry.name || "").slice(0, 180) || null,
        genreIds: Array.isArray(entry.genre_ids) ? entry.genre_ids : [],
        // Голосов меньше пяти — оценка случайна; 0 — «ещё никто не голосовал».
        rating: Number(entry.vote_count) >= 5 && Number(entry.vote_average) > 0
          ? Math.round(Number(entry.vote_average) * 10) / 10
          : null
      }
    : null;
  tmdbRuCache.set(imdbId, { at: Date.now(), value });
  // Гигиена памяти изолята — как у imdbSuggestCache: без потолка карта росла
  // на каждый новый imdbId всю жизнь изолята.
  if (tmdbRuCache.size > 200) {
    tmdbRuCache.delete(tmdbRuCache.keys().next().value);
  }
  return value;
}

// Русское имя жанра по TMDB genre_id; справочники жанров (movie/tv) — раз в сутки.
async function tmdbGenreName(env, kind, genreId) {
  const listKind = kind === "series" ? "tv" : "movie";
  let genres = tmdbGenreCache.get(listKind);
  if (!genres || Date.now() - genres.at > TMDB_GENRE_TTL_MS) {
    const payload = await tmdbFetch(env, `/genre/${listKind}/list`, "");
    genres = { at: Date.now(), map: Object.fromEntries((payload?.genres || []).map((g) => [g.id, String(g.name || "").slice(0, 40)])) };
    tmdbGenreCache.set(listKind, genres);
  }
  return genres.map[genreId] || null;
}

// Карточка фильма: основной источник — OMDb с ключом OMDB_API_KEY (одним
// ответом даёт название, год, тип, рейтинг, жанр и длительность); запасной —
// публичный suggest-эндпоинт IMDb по tt-id (тот же CDN, что и поиск:
// www.imdb.com с egress Cloudflare отдаёт анти-бот страницу 202 — скрейп
// из воркера не работает). Без ключа или при сбое OMDb фильм добавляется
// на данных suggest — с серой пилюлей «IMDb —»; 502 — только когда не
// ответил ни один источник. Сверху TMDB (если задан TMDB_API_KEY) локализует
// название и жанр на русский.
async function movieInfo(env, imdbId) {
  const primary = await omdbTitle(env, imdbId);
  let info = primary?.title ? primary : null;
  if (!info) {
    try {
      const base = await imdbSuggestTitle(imdbId);
      if (base?.title) info = base;
    } catch { /* оба источника недоступны */ }
  }
  if (!info) throw new HttpError(502, "IMDb сейчас недоступен, попробуйте позже", "IMDB_UNAVAILABLE");
  const ru = await tmdbLocalize(env, imdbId);
  if (!ru) return info;
  const genre = ru.genreIds.length ? await tmdbGenreName(env, info.kind, ru.genreIds[0]) : null;
  // У нового фильма IMDb ещё не имеет оценки (OMDb отдаёт imdbRating "N/A"),
  // а TMDB уже голосует. Показываем оценку TMDB с честной подписью «TMDB»,
  // а не пустую «IMDb —». Источник хранится в movies.rating_source.
  if (!info.rating && ru.rating) {
    return { ...info, title: ru.title || info.title, genre: genre || info.genre, rating: ru.rating, ratingSource: "tmdb" };
  }
  return { ...info, title: ru.title || info.title, genre: genre || info.genre };
}

// OMDb отдаёт дату релиза по-английски («19 Jul 2023») — приводим к ISO,
// чтобы клиент показывал её тем же formatDay, что и остальные даты.
const OMDB_MONTHS = {
  Jan: "01", Feb: "02", Mar: "03", Apr: "04", May: "05", Jun: "06",
  Jul: "07", Aug: "08", Sep: "09", Oct: "10", Nov: "11", Dec: "12"
};
function omdbDate(value) {
  const match = /^(\d{1,2}) ([A-Za-z]{3}) (\d{4})$/.exec(String(value || "").trim());
  if (!match) return null;
  const month = OMDB_MONTHS[match[2]];
  return month ? `${match[3]}-${month}-${match[1].padStart(2, "0")}` : null;
}

// Детали карточки: OMDb с plot=full — актёры, режиссёр, жанры, награды и
// рейтинги Rotten Tomatoes/Metacritic. Описание здесь английское — русское
// берём из TMDB (tmdbTitleDetails), OMDb остаётся запасным источником.
async function omdbDetails(env, imdbId) {
  const payload = await omdbFetch(env, `i=${encodeURIComponent(imdbId)}&plot=full`);
  if (!payload) return null;
  const ratings = Array.isArray(payload.Ratings) ? payload.Ratings : [];
  const rt = ratings.find((item) => item.Source === "Rotten Tomatoes")?.Value || null;
  const metascore = Number(payload.Metascore);
  const plot = String(payload.Plot || "").trim();
  return {
    plot: plot && plot !== "N/A" ? plot : null,
    genres: String(payload.Genre || "").split(",").map((part) => part.trim()).filter(Boolean),
    actors: String(payload.Actors || "").split(",").map((part) => part.trim()).filter(Boolean).slice(0, 6),
    director: String(payload.Director || "").split(",").map((part) => part.trim()).filter(Boolean).slice(0, 3),
    released: omdbDate(payload.Released),
    runtime: omdbMinutes(payload.Runtime),
    metascore: Number.isFinite(metascore) && metascore > 0 ? metascore : null,
    rt: rt && rt !== "N/A" ? rt : null
  };
}

// Детали из TMDB на русском: описание, слоган, все жанры, главные актёры,
// режиссёр (у сериала — создатели), дата премьеры, статус, длительность.
async function tmdbTitleDetails(env, imdbId) {
  const localized = await tmdbLocalize(env, imdbId);
  if (!localized?.id) return null;
  const kind = localized.kind === "tv" ? "tv" : "movie";
  const payload = await tmdbFetch(env, `/${kind}/${localized.id}`, "append_to_response=credits");
  if (!payload) return null;
  const credits = payload.credits || {};
  const directors = (credits.crew || []).filter((person) => person.job === "Director").map((person) => person.name).filter(Boolean);
  const creators = (payload.created_by || []).map((person) => person.name).filter(Boolean);
  return {
    plot: String(payload.overview || "").trim() || null,
    tagline: String(payload.tagline || "").trim() || null,
    genres: (payload.genres || []).map((genre) => genre.name).filter(Boolean),
    actors: (credits.cast || []).slice(0, 6).map((person) => String(person.name || "").trim()).filter(Boolean),
    director: (kind === "tv" ? creators : directors).slice(0, 3),
    released: payload.release_date || payload.first_air_date || null,
    status: payload.status || null,
    runtime: Number(payload.runtime) || null,
    seasons: Number(payload.number_of_seasons) || null,
    episodes: Number(payload.number_of_episodes) || null
  };
}

// Сводные детали для окна карточки: TMDB (русский) приоритетен, OMDb
// дополняет рейтингами RT/Metacritic и работает без ключа TMDB.
// null — оба источника недоступны (клиент покажет «описание недоступно»).
async function movieDetails(env, imdbId) {
  const [tmdb, omdb] = await Promise.all([tmdbTitleDetails(env, imdbId), omdbDetails(env, imdbId)]);
  if (!tmdb && !omdb) return null;
  const plot = tmdb?.plot || omdb?.plot || null;
  return {
    plot,
    // ru — перевод TMDB, en — только английский OMDb (клиент подпишет это).
    plot_lang: plot ? (tmdb?.plot ? "ru" : "en") : null,
    tagline: tmdb?.tagline || null,
    genres: tmdb?.genres?.length ? tmdb.genres : (omdb?.genres || []),
    actors: tmdb?.actors?.length ? tmdb.actors : (omdb?.actors || []),
    director: tmdb?.director?.length ? tmdb.director : (omdb?.director || []),
    released: tmdb?.released || omdb?.released || null,
    status: tmdb?.status || null,
    runtime: tmdb?.runtime || omdb?.runtime || null,
    seasons: tmdb?.seasons || null,
    episodes: tmdb?.episodes || null,
    metascore: omdb?.metascore || null,
    rt: omdb?.rt || null
  };
}

// Детали строки с кешем в movies.details: описание не меняется, поэтому
// повторный тап не ходит в TMDB/OMDb. Кеш не критичен — ошибка записи
// не должна ломать показ.
async function movieDetailsFor(env, pairId, id) {
  const row = await env.DB.prepare("SELECT id,imdb_id,details FROM movies WHERE id=? AND pair_id=?")
    .bind(id, pairId).first();
  if (!row) throw new HttpError(404, "Запись не найдена", "NOT_FOUND");
  if (row.details) {
    try {
      return JSON.parse(row.details);
    } catch { /* битый JSON — соберём заново */ }
  }
  const details = await movieDetails(env, row.imdb_id);
  if (!details) return null;
  try {
    await env.DB.prepare("UPDATE movies SET details=? WHERE id=? AND pair_id=?")
      .bind(JSON.stringify(details), id, pairId).run();
  } catch { /* кеш не критичен */ }
  return details;
}

// Оценки перепроверяются при открытии приложения, но не чаще раза в сутки на
// фильм: у новинок IMDb появляется с задержкой, а дёргать OMDb/TMDB на каждом
// запросе нельзя (лимит OMDb — 1000 запросов в день).
const RATING_RECHECK_SECONDS = 86400;

// Дозабор и обновление оценок: строки без источника (добавлены до фолбэка)
// дозаполняются, а строки с оценкой TMDB или без оценки перепроверяются —
// не появился ли наконец рейтинг IMDb. Как только OMDb его отдаёт, оценка
// заменяется на IMDb и подпись пилюли меняется с «TMDB» на «IMDb».
async function refreshMovieRatings(env, movies) {
  const stamp = now();
  const candidates = (movies || []).filter((movie) => {
    if (!movie.imdb_id) return false;
    // Строка без источника: оценку ещё ни разу не пробовали получить.
    if (movie.rating == null && !movie.rating_source) return true;
    // TMDB-фолбэк или «оценки нет»: перепроверяем раз в сутки.
    if (movie.rating_source !== "tmdb" && movie.rating_source !== "none") return false;
    return !movie.rating_checked_at || stamp - Number(movie.rating_checked_at) >= RATING_RECHECK_SECONDS;
  });
  if (!candidates.length) return;
  // Одна строка за открытие: у пары десятки фильмов, последовательная
  // перепроверка не создаёт всплеска запросов к OMDb.
  const row = candidates[0];
  let info;
  try {
    info = await movieInfo(env, row.imdb_id);
  } catch {
    return; // оба источника недоступны — попробуем в следующий раз
  }
  const rating = info?.rating ?? null;
  // ratingSource === "tmdb" — IMDb оценки так и не дал, оставляем TMDB.
  const source = rating ? (info?.ratingSource || "imdb") : "none";
  try {
    await env.DB.prepare("UPDATE movies SET rating=?, rating_source=?, rating_checked_at=? WHERE id=?")
      .bind(rating, source, stamp, row.id).run();
  } catch {
    return;
  }
  row.rating = rating;
  row.rating_source = source;
  row.rating_checked_at = stamp;
}

function validTimeZone(value) {
  if (!value || typeof value !== "string" || value.length > 64) return null;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: value }).format();
    return value;
  } catch {
    return null;
  }
}

function localDay(timeZone = DEFAULT_TZ, atMs = Date.now()) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: validTimeZone(timeZone) || DEFAULT_TZ,
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).formatToParts(new Date(atMs));
  const values = Object.fromEntries(parts.map(part => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
}

function validDate(value) {
  const day = clean(value);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return false;
  const parsed = new Date(`${day}T00:00:00Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === day;
}

// Дата и время у плана необязательны: пустая строка означает «не задано».
function optionalDay(value) {
  const day = clean(value);
  if (!day) return null;
  if (!validDate(day)) throw new HttpError(400, "Проверьте дату плана", "INVALID_DATE");
  return day;
}

function optionalTime(value) {
  const time = clean(value);
  if (!time) return null;
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(time)) throw new HttpError(400, "Проверьте время плана", "INVALID_TIME");
  return time;
}

function planSchedule(body) {
  const day = optionalDay(body?.day);
  const time = optionalTime(body?.time);
  if (time && !day) throw new HttpError(400, "Выберите дату, чтобы указать время", "INVALID_DATE");
  return { day, time };
}

// Оценка пары (RAofP): только целые числа 1..10. Дробные, строки и выход
// за диапазон отбиваются 400 — оценка обязательна при отметке просмотра.
function movieRatingValue(value) {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1 || value > 10) {
    throw new HttpError(400, "Оценка должна быть целым числом от 1 до 10", "INVALID_RATING");
  }
  return value;
}

function safeEqual(left, right) {
  const a = new TextEncoder().encode(String(left ?? ""));
  const b = new TextEncoder().encode(String(right ?? ""));
  if (!a.length || a.length !== b.length) return false;
  let difference = 0;
  for (let i = 0; i < a.length; i++) difference |= a[i] ^ b[i];
  return difference === 0;
}

async function hmac(keyData, data) {
  const key = await crypto.subtle.importKey("raw", typeof keyData === "string" ? new TextEncoder().encode(keyData) : keyData,
    { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return crypto.subtle.sign("HMAC", key, new TextEncoder().encode(data));
}

function hex(buffer) {
  return [...new Uint8Array(buffer)].map(byte => byte.toString(16).padStart(2, "0")).join("");
}

async function telegramUser(initData, token) {
  if (!initData || !token) return null;
  const params = new URLSearchParams(initData);
  const received = params.get("hash");
  const authDate = Number(params.get("auth_date"));
  if (!received || !Number.isFinite(authDate)) return null;
  // Mini App может оставаться открытым сутками, а initData обновляется только
  // при запуске: суточный порог обрывал живую сессию на второй день. Неделя
  // покрывает нормальную работу и всё ещё ограничивает replay украденных данных.
  const MAX_AGE = 7 * 86400;
  if (authDate > now() + 300 || now() - authDate > MAX_AGE) return null;
  params.delete("hash");
  // Поле signature (Bot API 9.x, Ed25519-валидация третьими сторонами) при HMAC-проверке
  // не исключается: data-check-string — это «chain of all received fields», кроме hash.
  // Исключать signature нужно только в Ed25519-схеме из раздела third-party документации.
  const check = [...params.entries()]
    .sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
    .map(([key, value]) => `${key}=${value}`)
    .join("\n");
  const secret = await hmac("WebAppData", token);
  const expected = hex(await hmac(secret, check));
  if (!safeEqual(expected, received)) return null;
  try {
    const user = JSON.parse(params.get("user") || "null");
    return positiveId(user?.id) ? user : null;
  } catch {
    return null;
  }
}

async function rateLimit(env, key, limit, windowSeconds = 60) {
  const nowSeconds = now();
  const bucket = Math.floor(nowSeconds / windowSeconds);
  const bucketKey = `${key}:${bucket}`;
  const expiresAt = (bucket + 1) * windowSeconds;
  // Счётчик читается через RETURNING в том же UPSERT: отдельный SELECT давал
  // лишний запрос и мог прочитать устаревшее значение при гонке (репорт 2026-10-29).
  const upsert = () => env.DB.prepare(`INSERT INTO rate_limits(bucket_key,count,expires_at) VALUES(?,1,?)
    ON CONFLICT(bucket_key) DO UPDATE SET count=count+1, expires_at=excluded.expires_at
    RETURNING count`).bind(bucketKey, expiresAt).first();
  let row;
  try {
    row = await upsert();
  } catch (error) {
    // На чистой D1 таблица rate_limits может ещё не существовать (ensureSchema
    // вызывается позже). Создаём минимальную схему и повторяем попытку,
    // чтобы защита от перебора секретов работала с первого запуска.
    const message = String(error?.message || error).toLowerCase();
    if (message.includes("no such table")) {
      await env.DB.prepare("CREATE TABLE IF NOT EXISTS rate_limits (bucket_key TEXT PRIMARY KEY, count INTEGER NOT NULL, expires_at INTEGER NOT NULL DEFAULT 0)").run();
      row = await upsert();
    } else if (message.includes("no column named expires_at")) {
      await env.DB.prepare("ALTER TABLE rate_limits ADD COLUMN expires_at INTEGER NOT NULL DEFAULT 0").run();
      row = await upsert();
    } else {
      throw error;
    }
  }
  if (bucket % 10 === 0) {
    // Удаляем только устаревшие окна того же ключа, сравнивая номер окна численно,
    // а не лексикографически по всей строке bucket_key (иначе затрагиваются другие ключи).
    await env.DB.prepare("DELETE FROM rate_limits WHERE expires_at < ?").bind(nowSeconds).run();
  }
  if ((row?.count || 0) > limit) {
    console.log(`[metric] rate_limit_hit key=${key} count=${row?.count || 0} limit=${limit}`);
    throw new HttpError(429, "Слишком много запросов. Подождите минуту.", "RATE_LIMITED");
  }
}

// Вход по коду — главная точка перебора: успешный подбор открывает чужое
// пространство целиком. Код — 4 байта (2^32 вариантов), общий лимит 240/мин
// на аккаунт даёт сотни тысяч попыток в сутки, а путь /start CODE в вебхуке
// общего лимита не имеет вовсе. Считаем только неудачные попытки («код не
// найден»): опечатки пользователя почти не задевает, перебор упирается в
// 5 неудач за 15 минут на аккаунт. Таблица rate_limits общая с rateLimit —
// устаревшие окна чистятся тем же механизмом по expires_at.
const JOIN_ATTEMPT_LIMIT = 5;
const JOIN_ATTEMPT_WINDOW = 15 * 60;

async function checkJoinAttempts(env, userId) {
  const bucket = Math.floor(now() / JOIN_ATTEMPT_WINDOW);
  const row = await env.DB.prepare("SELECT count FROM rate_limits WHERE bucket_key=?")
    .bind(`jf:${userId}:${bucket}`).first();
  if ((row?.count || 0) >= JOIN_ATTEMPT_LIMIT) {
    throw new HttpError(429, "Слишком много неудачных попыток входа по коду. Попробуйте снова через 15 минут.", "JOIN_RATE_LIMITED");
  }
}

async function recordJoinFailure(env, userId) {
  const bucket = Math.floor(now() / JOIN_ATTEMPT_WINDOW);
  await env.DB.prepare(`INSERT INTO rate_limits(bucket_key,count,expires_at) VALUES(?,1,?)
    ON CONFLICT(bucket_key) DO UPDATE SET count=count+1, expires_at=excluded.expires_at`)
    .bind(`jf:${userId}:${bucket}`, (bucket + 1) * JOIN_ATTEMPT_WINDOW).run();
}

async function ensureUser(env, tgUser, requestedTimeZone) {
  const timestamp = now();
  const existing = await env.DB.prepare("SELECT * FROM users WHERE tg_id=?").bind(tgUser.id).first();
  const timezone = validTimeZone(requestedTimeZone) || existing?.timezone || DEFAULT_TZ;
  // photo_url из initData: Telegram присылает актуальную ссылку при каждом
  // открытии приложения — здесь она обновляется при смене аватара и
  // очищается, когда аватар удалён (тогда клиент показывает букву).
  const photoUrl = /^https:\/\//.test(String(tgUser.photo_url || "")) ? tgUser.photo_url : null;
  // Отсутствие photo_url (webhook-путь, часть клиентов) не стирает сохранённый
  // аватар: COALESCE держит старую ссылку. Цена — после удаления аватара в
  // Telegram может остаться устаревшая ссылка; это мягче обнуления при каждом
  // открытии без фото.
  await env.DB.prepare(`INSERT INTO users(tg_id,username,display_name,timezone,photo_url,created_at,updated_at) VALUES(?,?,?,?,?,?,?)
    ON CONFLICT(tg_id) DO UPDATE SET username=excluded.username,display_name=excluded.display_name,
      timezone=excluded.timezone,photo_url=COALESCE(excluded.photo_url, users.photo_url),updated_at=excluded.updated_at`)
    .bind(tgUser.id, tgUser.username || null, displayName(tgUser), timezone, photoUrl, timestamp, timestamp).run();
  return env.DB.prepare("SELECT * FROM users WHERE tg_id=?").bind(tgUser.id).first();
}

async function membership(env, userId) {
  return env.DB.prepare(`SELECT p.*,pm.role,pm.tg_id,
    (SELECT display_name FROM users WHERE tg_id=p.user_a) AS owner_name,
    (SELECT display_name FROM users WHERE tg_id=p.user_b) AS partner_name,
    (SELECT photo_url FROM users WHERE tg_id=p.user_a) AS owner_photo,
    (SELECT photo_url FROM users WHERE tg_id=p.user_b) AS partner_photo
    FROM pair_members pm JOIN pairs p ON p.id=pm.pair_id WHERE pm.tg_id=? LIMIT 1`).bind(userId).first();
}

async function createPair(env, user) {
  const existing = await membership(env, user.tg_id);
  if (existing) return existing;
  const timestamp = now();
  const timezone = user.timezone || DEFAULT_TZ;
  for (let attempt = 0; attempt < 3; attempt++) {
    const code = hex(crypto.getRandomValues(new Uint8Array(4))).toUpperCase();
    try {
      await env.DB.batch([
        env.DB.prepare(`INSERT INTO pairs(code,name1,user_a,started_at,timezone,created_at,updated_at)
          VALUES(?,?,?,?,?,?,?)`).bind(code, user.display_name, user.tg_id, localDay(timezone), timezone, timestamp, timestamp),
        env.DB.prepare(`INSERT INTO pair_members(tg_id,pair_id,role,joined_at)
          SELECT ?,id,'a',? FROM pairs WHERE code=?`).bind(user.tg_id, timestamp, code),
        env.DB.prepare(`UPDATE users SET pair_id=(SELECT id FROM pairs WHERE code=?),role='a',updated_at=? WHERE tg_id=?`)
          .bind(code, timestamp, user.tg_id)
      ]);
      return membership(env, user.tg_id);
    } catch (error) {
      const raced = await membership(env, user.tg_id);
      if (raced) return raced;
      if (attempt === 2) throw error;
    }
  }
  throw new HttpError(500, "Не удалось создать пространство", "PAIR_CREATE_FAILED");
}

async function joinPair(env, user, rawCode, requestUrl = null) {
  const code = clean(rawCode).toUpperCase().slice(0, 16);
  if (!/^[A-F0-9]{8}$/.test(code)) throw new HttpError(400, "Код должен состоять из 8 символов", "INVALID_CODE");
  if (await membership(env, user.tg_id)) throw new HttpError(409, "Вы уже состоите в пространстве", "ALREADY_PAIRED");
  await checkJoinAttempts(env, user.tg_id);
  const pair = await env.DB.prepare("SELECT * FROM pairs WHERE code=?").bind(code).first();
  if (!pair) {
    // Кода нет среди живых пар: возможно, пространство закрылось (последний
    // участник вышел) — тогда отвечаем об этом, а не «код не найден».
    // Неудача пишется в обоих случаях: различие 410/404 не должно помогать
    // перебору кодов.
    const closed = await env.DB.prepare("SELECT code FROM closed_codes WHERE code=?").bind(code).first();
    await recordJoinFailure(env, user.tg_id);
    if (closed) {
      throw new HttpError(410, "Это пространство закрыто: последний участник вышел. Создайте новое или попросите новый код.", "PAIR_CLOSED");
    }
    throw new HttpError(404, "Код не найден", "CODE_NOT_FOUND");
  }
  if (pair.user_a === user.tg_id) throw new HttpError(400, "Это ваш собственный код", "OWN_CODE");
  if (pair.user_b) throw new HttpError(409, "Пространство уже соединено", "PAIR_FULL");
  const timestamp = now();
  // Партнёр выходил и возвращается по тому же коду — оставшемуся уходит
  // уведомление (зеркально уведомлению о выходе).
  const wasAwaitingReturn = Number(pair.awaiting_return) === 1;
  // Код зарезервирован за ушедшим: пока он не вернулся, тот же код не откроет
  // пространство другому аккаунту, даже если код «уехал» в пересланных
  // сообщениях. Свежие пары (awaiting_return=0) открыты любому по коду.
  if (wasAwaitingReturn && Number(pair.last_partner) !== Number(user.tg_id)) {
    // Неудача пишется и здесь: иначе зарезервированный код можно было бы
    // перебирать безлимитно (в пределах общего лимита на пользователя).
    await recordJoinFailure(env, user.tg_id);
    throw new HttpError(403, "Это пространство ждёт возвращения прежнего партнёра — войти по старому коду может только он. Попросите владельца создать новое пространство.", "PAIR_RESERVED");
  }
  let results;
  try {
    // Два следующих оператора условны на успех UPDATE pairs: D1 batch не
    // откатывается при changes=0, и без EXISTS-проверки конкурентный вход
    // оставил бы pair_members/users.pair_id у пары с user_b=0 — «фантомное»
    // членство, которое ensureSchema-repair уже не починит.
    results = await env.DB.batch([
      env.DB.prepare("UPDATE pairs SET user_b=?,name2=?,awaiting_return=0,last_partner=0,updated_at=? WHERE id=? AND user_b=0")
        .bind(user.tg_id, user.display_name, timestamp, pair.id),
      env.DB.prepare(`INSERT INTO pair_members(tg_id,pair_id,role,joined_at)
        SELECT ?,?,'b',? WHERE EXISTS(SELECT 1 FROM pairs WHERE id=? AND user_b=?)`)
        .bind(user.tg_id, pair.id, timestamp, pair.id, user.tg_id),
      env.DB.prepare(`UPDATE users SET pair_id=?,role='b',updated_at=? WHERE tg_id=?
        AND EXISTS(SELECT 1 FROM pairs WHERE id=? AND user_b=?)`)
        .bind(pair.id, timestamp, user.tg_id, pair.id, user.tg_id)
    ]);
  } catch (error) {
    const message = String(error?.message || error).toLowerCase();
    if (message.includes("unique") || message.includes("constraint") || message.includes("foreign key")) {
      throw new HttpError(409, "Не удалось войти: пространство уже занято", "JOIN_CONFLICT");
    }
    throw error;
  }
  if (!results?.[0]?.meta?.changes) {
    throw new HttpError(409, "Не удалось войти: пространство уже занято", "JOIN_CONFLICT");
  }
  if (wasAwaitingReturn && positiveId(pair.user_a)) {
    const returnerName = user.display_name || "Партнёр";
    try {
      // Сбой Telegram не отменяет вход: запись в базе уже применена.
      await openApp(env, pair.user_a, requestUrl || { origin: "" },
        `<b>${escapeHtml(returnerName)}</b> снова в вашем пространстве.\n\n`
        + "Общие планы, даты и воспоминания на месте — можно продолжать.");
    } catch (error) {
      // Молча: уведомление вторично по отношению к самому входу.
    }
  }
  return membership(env, user.tg_id);
}

async function leavePair(env, member, requestUrl) {
  const partnerId = member.role === "a" ? member.user_b : member.user_a;
  // Имя ушедшего для уведомления: display_name из users свежее, чем
  // денормализованные name1/name2 в pairs.
  const leaverName = (member.role === "a" ? member.owner_name : member.partner_name)
    || (member.role === "a" ? member.name1 : member.name2)
    || "Партнёр";
  const timestamp = now();
  const operations = [];
  if (!partnerId) {
    // Последний держатель покидает пространство: данные пары удаляются
    // полностью, освобождая место в базе (восстановить пару по коду нельзя).
    // Код остаётся в closed_codes: попытка входа по нему получит внятное
    // «пространство закрыто» вместо «код не найден».
    operations.push(
      env.DB.prepare("INSERT OR IGNORE INTO closed_codes(code,closed_at) VALUES(?,?)")
        .bind(clean(member.code).toUpperCase(), timestamp),
      env.DB.prepare("DELETE FROM tasks WHERE pair_id=?").bind(member.id),
      env.DB.prepare("DELETE FROM dates WHERE pair_id=?").bind(member.id),
      env.DB.prepare("DELETE FROM memories WHERE pair_id=?").bind(member.id),
      env.DB.prepare("DELETE FROM wishes WHERE pair_id=?").bind(member.id),
      env.DB.prepare("DELETE FROM daily_rolls WHERE pair_id=?").bind(member.id),
      env.DB.prepare("DELETE FROM daily_completions WHERE pair_id=?").bind(member.id),
      env.DB.prepare("DELETE FROM pair_members WHERE pair_id=?").bind(member.id),
      // Все коллекции после 0016 тоже явно (страховка поверх FK CASCADE):
      // quotes, places, trips, goals+goal_items, movies (вместе с
      // unique-индексом не мешает), savings.
      env.DB.prepare("DELETE FROM quotes WHERE pair_id=?").bind(member.id),
      env.DB.prepare("DELETE FROM places WHERE pair_id=?").bind(member.id),
      env.DB.prepare("DELETE FROM trips WHERE pair_id=?").bind(member.id),
      env.DB.prepare("DELETE FROM goal_items WHERE pair_id=?").bind(member.id),
      env.DB.prepare("DELETE FROM goals WHERE pair_id=?").bind(member.id),
      // Внуки явно, до родителей: movie_ratings/savings_deposits не имеют
      // pair_id и держатся только на FK CASCADE — если enforcement выключен,
      // после удаления movies/savings остались бы сироты.
      env.DB.prepare("DELETE FROM movie_ratings WHERE movie_id IN (SELECT id FROM movies WHERE pair_id=?)").bind(member.id),
      env.DB.prepare("DELETE FROM savings_deposits WHERE saving_id IN (SELECT id FROM savings WHERE pair_id=?)").bind(member.id),
      env.DB.prepare("DELETE FROM movies WHERE pair_id=?").bind(member.id),
      env.DB.prepare("DELETE FROM savings WHERE pair_id=?").bind(member.id),
      env.DB.prepare("DELETE FROM pairs WHERE id=?").bind(member.id)
    );
  } else if (member.role === "a") {
    operations.push(
      env.DB.prepare("DELETE FROM pair_members WHERE tg_id=? AND pair_id=?").bind(member.tg_id, member.id),
      // awaiting_return=1 + last_partner: партнёр вышел, пространство «в
      // ожидании возвращения» — joinPair по этому флагу уведомит оставшегося,
      // API заморозит контент, а войти по коду сможет только тот же аккаунт.
      env.DB.prepare(`UPDATE pairs SET user_a=user_b,name1=(SELECT display_name FROM users WHERE tg_id=?),
        user_b=0,name2='',awaiting_return=1,last_partner=?,updated_at=? WHERE id=?`).bind(partnerId, member.tg_id, timestamp, member.id),
      env.DB.prepare("UPDATE pair_members SET role='a' WHERE tg_id=? AND pair_id=?").bind(partnerId, member.id),
      // Личное имя партнёра оставшегося относилось к ушедшему — сбрасываем,
      // иначе оно прилипнет к следующему присоединившемуся партнёру.
      env.DB.prepare("UPDATE users SET role='a',partner_custom_name=NULL,updated_at=? WHERE tg_id=?").bind(timestamp, partnerId)
    );
  } else {
    operations.push(
      env.DB.prepare("UPDATE pairs SET user_b=0,name2='',awaiting_return=1,last_partner=?,updated_at=? WHERE id=?").bind(member.tg_id, timestamp, member.id),
      env.DB.prepare("DELETE FROM pair_members WHERE tg_id=? AND pair_id=?").bind(member.tg_id, member.id),
      // Оставшийся партнёр (владелец) тоже держал личное имя для ушедшего.
      env.DB.prepare("UPDATE users SET partner_custom_name=NULL,updated_at=? WHERE tg_id=?").bind(timestamp, partnerId)
    );
  }
  operations.push(env.DB.prepare("UPDATE users SET pair_id=NULL,role='a',partner_custom_name=NULL,updated_at=? WHERE tg_id=?").bind(timestamp, member.tg_id));
  await env.DB.batch(operations);
  // Оставшийся партнёр узнаёт о выходе сообщением бота — иначе он просто
  // однажды не находит партнёра в пространстве. Сбой Telegram не отменяет
  // сам выход: запись в базе уже применена.
  if (partnerId) {
    try {
      await openApp(env, partnerId, requestUrl,
        `<b>${escapeHtml(leaverName)}</b> больше не в вашем пространстве.\n\n`
        + "Общие планы, даты и воспоминания остались у вас. "
        + "Чтобы позвать партнёра снова, отправьте ему код приглашения.");
    } catch (error) {
      // Молча: уведомление вторично по отношению к самому выходу.
    }
  }
}

// Ритуал теперь отмечается каждым партнёром отдельно: daily_rolls хранит общее
// действие дня, daily_completions — кто уже отметил. done отражает отметку
// текущего пользователя (userId), partnerDone — отметку второго участника.
async function dailyFor(env, pairId, timeZone, userId = null) {
  const day = localDay(timeZone);
  let row = await env.DB.prepare("SELECT * FROM daily_rolls WHERE pair_id=? AND day=?").bind(pairId, day).first();
  if (!row) {
    await env.DB.prepare("INSERT OR IGNORE INTO daily_rolls(pair_id,day,daily_value) VALUES(?,?,?)")
      .bind(pairId, day, dailyAction(pairId, day)).run();
    row = await env.DB.prepare("SELECT * FROM daily_rolls WHERE pair_id=? AND day=?").bind(pairId, day).first();
  }
  const completions = await env.DB.prepare("SELECT tg_id FROM daily_completions WHERE pair_id=? AND day=?").bind(pairId, day).all();
  const completed = new Set((completions.results || []).map((r) => Number(r.tg_id)));
  const myDone = userId != null && completed.has(Number(userId));
  const partnerDone = userId != null ? completed.size > (myDone ? 1 : 0) : completed.size > 0;
  return { day, action: row.daily_value, done: myDone, partnerDone, completedCount: completed.size };
}

// users.streak хранит последнее достигнутое значение и не обнуляется сам по
// себе: после пропущенных дней там остаётся «7», пока кто-то не отметит ритуал.
// Для вывода считаем серию прерванной, если last_activity не сегодня и не
// вчера — иначе интерфейс показывает устаревшую серию (репорт 2026-10-29).
// last_activity пишется как daily.day в поясе ПАРЫ (dailyFor), поэтому
// «сегодня» для проверки серии считаем в том же поясе — иначе при
// users.timezone != pairs.timezone на границе суток живая серия показывалась
// бы как 0 (репорт 2026-11-03, B-8). Без пары откат к личному поясу.
function displayStreak(user, pairTz = null) {
  const streak = Number(user?.streak || 0);
  if (streak <= 0) return 0;
  const last = String(user?.last_activity || "").slice(0, 10);
  const today = localDay(pairTz || user?.timezone);
  const yesterday = new Date(Date.parse(`${today}T00:00:00Z`) - 86400000).toISOString().slice(0, 10);
  return last === today || last === yesterday ? streak : 0;
}

function publicUser(user, pairTz = null) {
  return {
    tg_id: user.tg_id,
    // Личное имя пользователя (custom_name) имеет приоритет над display_name из Telegram.
    display_name: clean(user.custom_name) || user.display_name,
    points: user.points,
    streak: displayStreak(user, pairTz),
    best_streak: user.best_streak,
    timezone: user.timezone,
    gender: user.gender || null,
    digest_time: user.digest_time || null,
    digest_enabled: Number(user.digest_enabled ?? 1) === 1,
    dates_digest_time: user.dates_digest_time || null,
    dates_digest_enabled: Number(user.dates_digest_enabled ?? 1) === 1,
    accent_color: user.accent_color || null,
    photo_url: user.photo_url || null,
    show_avatar: Number(user.show_avatar ?? 1) === 1,
    // Личное имя партнёра просматривающего — чтобы поле в настройках
    // показывало текущее значение. Партнёру эта строка не видна: в state()
    // подмена идёт только в name его пары и подписи авторов.
    partner_custom_name: clean(user.partner_custom_name) || null,
    // Личное имя пользователя для отображения в поле настроек.
    custom_name: clean(user.custom_name) || null
  };
}

// Личное имя партнёра (users.partner_custom_name) видно только тому, кто его
// задал: подставляется в имя партнёра просматривающего, не меняя порядок
// name1 (владелец) / name2 (партнёр) в выдаче.
// Личное имя пользователя (users.custom_name) аналогично подставляется
// вместо его display_name при отображении партнёру.
function withPartnerOverride(viewer, pair) {
  const viewerOverride = clean(viewer.partner_custom_name) || null;
  const viewerCustomName = clean(viewer.custom_name) || null;
  const ownerName = pair.owner_name || pair.name1;
  const partnerName = pair.partner_name || pair.name2;
  if (pair.role === "a") {
    // viewer — владелец, его имя = custom_name или ownerName, имя партнёра = partner_custom_name или partnerName
    return {
      name1: viewerCustomName || ownerName,
      name2: viewerOverride || partnerName
    };
  }
  // viewer — партнёр, его имя = custom_name или partnerName, имя владельца = ownerName (без изменений)
  return {
    name1: viewerOverride || ownerName,
    name2: viewerCustomName || partnerName
  };
}

// Кеш Intl.DateTimeFormat по «локаль|пояс|опции». Создание форматтера —
// самая дорогая операция дата-математики, а она ходит по строкам state()
// в циклах (дедлайны планов, повторяющиеся даты); набор опций фиксирован.
// Верхний предел защищает изолят от разрастания на экзотических поясах.
const dateTimeFormatCache = new Map();
function cachedFormatter(locale, timeZone, options) {
  const key = `${locale}|${timeZone || "UTC"}|${JSON.stringify(options)}`;
  let formatter = dateTimeFormatCache.get(key);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat(locale, { ...options, timeZone: timeZone || "UTC" });
    if (dateTimeFormatCache.size > 100) dateTimeFormatCache.clear();
    dateTimeFormatCache.set(key, formatter);
  }
  return formatter;
}

function timeZoneOffsetMs(timeZone, date) {
  const formatter = cachedFormatter("en-US", timeZone, {
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false
  });
  const parts = formatter.formatToParts(date);
  const get = (type) => parts.find((part) => part.type === type)?.value || "0";
  const asUtc = Date.UTC(
    Number(get("year")), Number(get("month")) - 1, Number(get("day")),
    Number(get("hour")) % 24, Number(get("minute")), Number(get("second"))
  );
  return asUtc - date.getTime();
}

function makeDateInTimeZone(year, monthIndex, day, hour, minute, timeZone) {
  const tz = timeZone || "UTC";
  const desiredUtc = Date.UTC(year, monthIndex, day, hour, minute, 0, 0);
  function localMatches(utcMs) {
    const parts = cachedFormatter("en-US", tz, {
      year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit", hour12: false
    }).formatToParts(new Date(utcMs));
    const get = (type) => parts.find((p) => p.type === type)?.value || "0";
    return Number(get("year")) === year &&
      Number(get("month")) === monthIndex + 1 &&
      Number(get("day")) === day &&
      Number(get("hour")) % 24 === hour &&
      Number(get("minute")) === minute;
  }
  // Обычный случай: итеративно уточняем смещение.
  let utc = desiredUtc;
  for (let i = 0; i < 3; i++) {
    const offset = timeZoneOffsetMs(tz, new Date(utc));
    const next = desiredUtc - offset;
    if (next === utc) break;
    utc = next;
  }
  if (localMatches(utc)) return new Date(utc);
  // Несуществующее локальное время (весенний перевод часов):
  // используем смещение до перехода, сдвигая момент вперёд.
  const preOffset = timeZoneOffsetMs(tz, new Date(desiredUtc - 24 * 3600000));
  const shifted = desiredUtc - preOffset;
  return new Date(shifted);
}

// Ежемесячный повтор: запись происходит в тот же день месяца, когда такой
// день существует (31-е пропускает короткие месяцы — как 29 февраля у ежегодных).
function monthlyOccursOnDay(item, targetDay) {
  return Number(item?.monthly) === 1 && String(item?.day || "").slice(8) === String(targetDay || "").slice(8);
}

// Ближайшее ежемесячное наступление: первый месяц, где день месяца существует
// и локальная дата не раньше сегодняшней (день-уровень, не время — план на
// сегодня с прошедшим временем всё ещё «сегодня»).
function nextMonthlyOccurrenceMs(item, timeZone, nowMs = Date.now()) {
  const parts = String(item?.day || "").split("-");
  if (parts.length !== 3) return Number.MAX_SAFE_INTEGER;
  const dayOfMonth = Number(parts[2]);
  if (!Number.isFinite(dayOfMonth) || dayOfMonth < 1 || dayOfMonth > 31) return Number.MAX_SAFE_INTEGER;
  const tz = timeZone || "UTC";
  let hours = 12, minutes = 0;
  if (item.time && /^\d{2}:\d{2}$/.test(item.time)) {
    const [hh, mm] = String(item.time).split(":").map(Number);
    if (Number.isFinite(hh) && Number.isFinite(mm)) { hours = hh; minutes = mm; }
  }
  const now = new Date(nowMs);
  const startY = Number(cachedFormatter("en-US", tz, { year: "numeric" }).format(now));
  const startM = Number(cachedFormatter("en-US", tz, { month: "2-digit" }).format(now));
  const todayKey = cachedFormatter("en-CA", tz, { year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
  const dayFmt = cachedFormatter("en-US", tz, { month: "2-digit", day: "2-digit" });
  const keyFmt = cachedFormatter("en-CA", tz, { year: "numeric", month: "2-digit", day: "2-digit" });
  for (let offset = 0; offset < 25; offset++) {
    const absolute = startM - 1 + offset;
    const year = startY + Math.floor(absolute / 12);
    const month = absolute % 12;
    const candidate = makeDateInTimeZone(year, month, dayOfMonth, hours, minutes, tz);
    const cp = dayFmt.formatToParts(candidate);
    const cm = Number(cp.find((p) => p.type === "month")?.value);
    const cd = Number(cp.find((p) => p.type === "day")?.value);
    // 31-го не существует в коротких месяцах — candidate уехал на соседний.
    if (cm !== month + 1 || cd !== dayOfMonth) continue;
    if (keyFmt.format(candidate) >= todayKey) return candidate.getTime();
  }
  return Number.MAX_SAFE_INTEGER;
}

// Ближайшее ежегодное наступление плана: тот же месяц-день в текущем или
// следующем году (29 февраля существует не в каждом году — пропускается).
function nextYearlyOccurrenceMs(item, timeZone, nowMs = Date.now()) {
  const parts = String(item?.day || "").split("-");
  if (parts.length !== 3) return Number.MAX_SAFE_INTEGER;
  const month = Number(parts[1]) - 1;
  const dayOfMonth = Number(parts[2]);
  if (!Number.isFinite(month) || !Number.isFinite(dayOfMonth)) return Number.MAX_SAFE_INTEGER;
  const tz = timeZone || "UTC";
  let hours = 12, minutes = 0;
  if (item.time && /^\d{2}:\d{2}$/.test(item.time)) {
    const [hh, mm] = String(item.time).split(":").map(Number);
    if (Number.isFinite(hh) && Number.isFinite(mm)) { hours = hh; minutes = mm; }
  }
  const now = new Date(nowMs);
  const currentYear = Number(cachedFormatter("en-US", tz, { year: "numeric" }).format(now));
  const todayKey = cachedFormatter("en-CA", tz, { year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
  const dayFmt = cachedFormatter("en-US", tz, { month: "2-digit", day: "2-digit" });
  for (let year = currentYear; year <= currentYear + 9; year++) {
    const candidate = makeDateInTimeZone(year, month, dayOfMonth, hours, minutes, tz);
    const cp = dayFmt.formatToParts(candidate);
    const cm = Number(cp.find((q) => q.type === "month")?.value);
    const cd = Number(cp.find((q) => q.type === "day")?.value);
    if (cm !== month + 1 || cd !== dayOfMonth) continue;
    if (cachedFormatter("en-CA", tz, { year: "numeric", month: "2-digit", day: "2-digit" }).format(candidate) >= todayKey) {
      return candidate.getTime();
    }
  }
  return Number.MAX_SAFE_INTEGER;
}

function taskTargetMs(item, timeZone) {
  if (!item || !item.day) return Number.MAX_SAFE_INTEGER;
  // Повторяющийся план сортируется и напоминает по ближайшему наступлению.
  if (Number(item.monthly) === 1) return nextMonthlyOccurrenceMs(item, timeZone);
  if (Number(item.yearly) === 1) return nextYearlyOccurrenceMs(item, timeZone);
  const parts = String(item.day).split("-");
  if (parts.length !== 3) return Number.MAX_SAFE_INTEGER;
  const year = Number(parts[0]);
  const month = Number(parts[1]) - 1;
  const date = Number(parts[2]);
  if (![year, month + 1, date].every(Number.isFinite)) return Number.MAX_SAFE_INTEGER;
  let hours = 23, minutes = 59;
  if (item.time && /^\d{2}:\d{2}$/.test(item.time)) {
    const [hh, mm] = String(item.time).split(":").map(Number);
    if (Number.isFinite(hh) && Number.isFinite(mm)) { hours = hh; minutes = mm; }
  }
  return makeDateInTimeZone(year, month, date, hours, minutes, timeZone).getTime();
}

// Стабильный tie-break по id: годится и для числовых rowid, и для строковых id.
function byRowId(a, b) {
  return a < b ? -1 : a > b ? 1 : 0;
}

// Единая сортировка открытых планов для state() и archivePage(): по ближайшему
// дедлайну, равные ключи — по id. Хелпер один, чтобы первая страница списка и
// архивное продолжение были согласованными последовательностями (репорт 2026-10-29).
// Ключ считается один раз на запись: taskTargetMs строит Intl.DateTimeFormat
// (несколько на вызов) и слишком дорог, чтобы вызывать его из компаратора
// на каждое сравнение.
function sortByTaskDeadline(rows, timeZone) {
  const decorated = rows.map((row) => ({ row, at: taskTargetMs(row, timeZone) }));
  decorated.sort((a, b) => {
    // taskTargetMs возвращает конечное число или MAX_SAFE_INTEGER: обе
    // «бесконечности» равны и уходят в конец, tie-break по id.
    const ta = a.at, tb = b.at;
    return ta - tb || byRowId(a.row.id, b.row.id);
  });
  return decorated.map(({ row }) => row);
}

function nextDateOccurrence(item, timeZone) {
  if (!item || !item.day) return Number.MAX_SAFE_INTEGER;
  // Ежемесячная дата наступает каждый месяц — считаем ближайшее наступление.
  if (Number(item.monthly) === 1) return nextMonthlyOccurrenceMs(item, timeZone);
  const parts = String(item.day).split("-");
  if (parts.length !== 3) return Number.MAX_SAFE_INTEGER;
  const month = Number(parts[1]) - 1;
  const date = Number(parts[2]);
  if (!Number.isFinite(month) || !Number.isFinite(date)) return Number.MAX_SAFE_INTEGER;
  const tz = timeZone || "UTC";
  const now = new Date();
  const todayParts = cachedFormatter("en-CA", tz, { year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
  const [todayYear, todayMonth, todayDay] = todayParts.split("-").map(Number);
  const today = makeDateInTimeZone(todayYear, todayMonth - 1, todayDay, 0, 0, tz);
  let hours = 12, minutes = 0;
  if (item.time && /^\d{2}:\d{2}$/.test(item.time)) {
    const [hh, mm] = String(item.time).split(":").map(Number);
    if (Number.isFinite(hh) && Number.isFinite(mm)) { hours = hh; minutes = mm; }
  }
  const isRecurring = !!item.recurs;
  const currentYear = Number(cachedFormatter("en-US", tz, { year: "numeric" }).format(now));
  const years = isRecurring
    ? Array.from({ length: 9 }, (_, index) => currentYear + index)
    : [Number(parts[0])];
  const fmt = cachedFormatter("en-US", tz, { month: "2-digit", day: "2-digit" });
  for (const year of years) {
    const candidate = makeDateInTimeZone(year, month, date, hours, minutes, tz);
    const cparts = fmt.formatToParts(candidate);
    const cm = Number(cparts.find((p) => p.type === "month")?.value);
    const cd = Number(cparts.find((p) => p.type === "day")?.value);
    if (cm !== month + 1 || cd !== date) continue;
    if (!isRecurring || candidate >= today) return candidate.getTime();
  }
  // Для ежегодного события не используем исходную (возможно прошедшую) дату как результат.
  if (isRecurring) return Number.MAX_SAFE_INTEGER;
  const fallback = makeDateInTimeZone(Number(parts[0]), month, date, hours, minutes, tz);
  return Number.isNaN(fallback.getTime()) ? Number.MAX_SAFE_INTEGER : fallback.getTime();
}

// Дата — событие дня, а не момента: не-ежегодная запись прошедшая только когда
// прошёл её календарный день. Сравнение по timestamp отправляло «сегодня» в
// прошедшие уже после полудня (12:00 — время по умолчанию), хотя интерфейс
// подписывает её «Сегодня» (репорт 2026-10-29).
function isPastDate(row, timeZone, nowMs) {
  // Ежемесячная дата — повторяющаяся: в «прошедшие» не попадает никогда.
  if (!row || row.recurs || Number(row.monthly) === 1) return false;
  const day = String(row.day || "");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return false;
  return day < localDay(timeZone || "UTC", nowMs);
}

// Сортировка дат для /api/state: сначала будущие по ближайшему наступлению,
// затем прошедшие не-ежегодные от свежих к старым. Timestamp считается один
// раз на запись: nextDateOccurrence строит Intl.DateTimeFormat и слишком
// дорог, чтобы вызывать его из компаратора на каждое сравнение. Равные ключи
// разбираются по id: порядок в state() и в архивном продолжении обязан совпадать.
function sortDateRows(rows, timeZone, nowMs = Date.now()) {
  const decorated = rows.map((row) => ({ row, at: nextDateOccurrence(row, timeZone) }));
  decorated.sort(({ row: a, at: ta }, { row: b, at: tb }) => {
    const aPast = isPastDate(a, timeZone, nowMs);
    const bPast = isPastDate(b, timeZone, nowMs);
    if (aPast !== bPast) return aPast ? 1 : -1;
    if (aPast && bPast) return tb - ta || byRowId(a.id, b.id);
    return ta - tb || byRowId(a.id, b.id);
  });
  return decorated.map(({ row }) => row);
}

// RAofP: my_rating — голос текущего пользователя (null — ещё не оценил),
// pair_rating — среднее по всем голосам пары (1–10, один знак). Оценок
// максимум две, поэтому считаем в памяти, без SQL-агрегата на карточку.
function attachMovieRatings(movies, ratingRows, userId) {
  const ratingIndex = new Map();
  for (const row of ratingRows || []) {
    const key = Number(row.movie_id);
    const entry = ratingIndex.get(key) || { sum: 0, count: 0, mine: null };
    entry.sum += Number(row.rating);
    entry.count += 1;
    if (Number(row.tg_id) === Number(userId)) entry.mine = Number(row.rating);
    ratingIndex.set(key, entry);
  }
  for (const movie of movies || []) {
    const entry = ratingIndex.get(Number(movie.id));
    movie.my_rating = entry?.mine ?? null;
    movie.pair_rating = entry?.count ? Math.round((entry.sum / entry.count) * 10) / 10 : null;
  }
  return movies;
}

async function state(env, userId) {
  const user = await env.DB.prepare("SELECT * FROM users WHERE tg_id=?").bind(userId).first();
  const pair = await membership(env, userId);
  if (!pair) return { user: publicUser(user), pair: null };
  const partnerId = pair.role === "a" ? pair.user_b : pair.user_a;
  const [tasks, completedTasks, dates, memories, wishes, completedWishes, quotes, places, trips, movies, movieRatings, goals, goalItems, savings, daily, partnerUser] = await Promise.all([
    // Личные планы (is_private=1) — только для создателя, как и личные даты.
    env.DB.prepare("SELECT id,title,status,day,time,monthly,yearly,is_private,created_by,created_at FROM tasks WHERE pair_id=? AND status='open' AND (is_private=0 OR created_by=?)").bind(pair.id, user.tg_id).all(),
    // monthly/yearly — как в ARCHIVE_QUERIES.done_tasks: редактирование
    // завершённой карточки читает флаги повтора и отправляет их обратно в PATCH.
    env.DB.prepare("SELECT id,title,status,day,time,monthly,yearly,is_private,created_by,created_at,completed_at FROM tasks WHERE pair_id=? AND status='done' AND (is_private=0 OR created_by=?) ORDER BY completed_at DESC, id DESC LIMIT ?").bind(pair.id, user.tg_id, STATE_RECENT_LIMIT).all(),
    // Личные даты (is_private=1) уходят из выдачи партнёру ещё в SQL:
    // владелец видит и свои личные, и общие, партнёр — только общие.
    // created_by нужен интерфейсу, чтобы показывать чекбокс приватности только автору.
    env.DB.prepare("SELECT id,title,day,time,recurs,monthly,is_private,created_by,kind,created_at FROM dates WHERE pair_id=? AND (is_private=0 OR created_by=?)").bind(pair.id, user.tg_id).all(),
    env.DB.prepare(`SELECT m.id,m.author_id,m.title,m.body,m.day,m.created_at,u.display_name FROM memories m
      LEFT JOIN users u ON u.tg_id=m.author_id WHERE m.pair_id=? ORDER BY m.created_at DESC, m.id DESC LIMIT ?`).bind(pair.id, STATE_RECENT_LIMIT).all(),
    env.DB.prepare(`SELECT w.id,w.body,w.owner_id,w.created_at,w.done_at,w.url,u.display_name FROM wishes w
      LEFT JOIN users u ON u.tg_id=w.owner_id WHERE w.pair_id=? AND w.done=0 ORDER BY w.created_at DESC, w.id DESC LIMIT ?`).bind(pair.id, STATE_ACTIVE_LIMIT).all(),
    env.DB.prepare(`SELECT w.id,w.body,w.owner_id,w.created_at,w.done_at,w.url,u.display_name FROM wishes w
      LEFT JOIN users u ON u.tg_id=w.owner_id WHERE w.pair_id=? AND w.done=1 ORDER BY w.created_at DESC, w.id DESC LIMIT ?`).bind(pair.id, STATE_RECENT_LIMIT).all(),
    // Цитаты и места — общие коллекции пары: приватности у них нет, поэтому
    // фильтровать по created_by нечего. Потолок тот же, что у активных планов:
    // на практике это десятки записей, архив им не нужен.
    env.DB.prepare(`SELECT q.id,q.body,q.source,q.author_id,q.created_at,u.display_name FROM quotes q
      LEFT JOIN users u ON u.tg_id=q.author_id WHERE q.pair_id=? ORDER BY q.created_at DESC, q.id DESC LIMIT ?`).bind(pair.id, STATE_ACTIVE_LIMIT).all(),
    env.DB.prepare("SELECT id,title,note,url,visited,visited_at,visited_by,created_by,created_at FROM places WHERE pair_id=? ORDER BY created_at DESC, id DESC LIMIT ?").bind(pair.id, STATE_ACTIVE_LIMIT).all(),
    // Поездки — общая коллекция пары, как места: без приватности и архива.
    env.DB.prepare("SELECT id,title,note,visited,visited_at,visited_by,created_by,created_at FROM trips WHERE pair_id=? ORDER BY created_at DESC, id DESC LIMIT ?").bind(pair.id, STATE_ACTIVE_LIMIT).all(),
    // Кино — общая коллекция пары, как места: без приватности и архива.
    // Данные (рейтинг/жанр/длительность) — снимок IMDb на момент добавления.
    env.DB.prepare("SELECT id,imdb_id,title,year,kind,rating,rating_source,rating_checked_at,genres,runtime,seasons,episodes,url,watched,watched_at,watched_by,created_by,created_at FROM movies WHERE pair_id=? ORDER BY created_at DESC, id DESC LIMIT ?").bind(pair.id, STATE_ACTIVE_LIMIT).all(),
    // Голоса RAofP всей пары одним запросом: у фильмов до 200 строк, оценки
    // приклеиваются в памяти — без подзапроса на каждую карточку.
    env.DB.prepare(`SELECT r.movie_id,r.tg_id,r.rating FROM movie_ratings r
      JOIN movies m ON m.id=r.movie_id WHERE m.pair_id=?`).bind(pair.id).all(),
    // Копилки: общие видит вся пара, личные — только автор (фильтр в SQL,
    // как у личных дат/планов). collected поддерживается при пополнении.
    env.DB.prepare("SELECT id,created_by,kind,title,target,collected,created_at FROM savings WHERE pair_id=? AND (kind='shared' OR created_by=?) ORDER BY created_at DESC, id DESC LIMIT ?").bind(pair.id, user.tg_id, STATE_ACTIVE_LIMIT).all(),
    // Цели: личные (is_private=1) — только для создателя, как личные планы.
    // Выполненность цели считается по пунктам, поэтому отдаём их вместе с целью.
    env.DB.prepare("SELECT id,title,is_private,created_by,created_at FROM goals WHERE pair_id=? AND (is_private=0 OR created_by=?) ORDER BY created_at DESC, id DESC LIMIT ?").bind(pair.id, user.tg_id, STATE_ACTIVE_LIMIT).all(),
    env.DB.prepare(`SELECT gi.id,gi.goal_id,gi.title,gi.done,gi.done_at,gi.done_by,gi.created_at FROM goal_items gi
      JOIN goals g ON g.id=gi.goal_id WHERE g.pair_id=? AND (g.is_private=0 OR g.created_by=?)
      ORDER BY gi.created_at ASC, gi.id ASC`).bind(pair.id, user.tg_id).all(),
    // Ритуал — совместное действие: пока партнёр не присоединился, карточки нет.
    // dailyFor учитывает отметку текущего пользователя (user.tg_id).
    pair.user_b ? dailyFor(env, pair.id, pair.timezone, user.tg_id) : null,
    // Пол партнёра — для обращений «Его/Её желания» в вишлисте; очки — для
    // «Вместе XP»; accent_color — чтобы аватар партнёра в кнопке пары был
    // его выбранным акцентом (смена видна партнёру после обновления state).
    partnerId ? env.DB.prepare("SELECT gender, points, accent_color FROM users WHERE tg_id=?").bind(partnerId).first() : null
  ]);
  attachMovieRatings(movies.results || [], movieRatings?.results, user.tg_id);
  const sortedDates = sortDateRows(dates.results || [], pair.timezone).slice(0, STATE_ACTIVE_LIMIT);
  // Личное имя партнёра видно только просматривающему — подставляем его и в
  // подписи авторов воспоминаний/желаний (author_id/owner_id совпадает с
  // tg_id партнёра в одной паре), чтобы «везде» значило везде. Своё личное
  // имя (custom_name) работает точно так же: меняет имя только у того, кто
  // его задал, и во всех подписях его собственных записей. Партнёру уходит
  // сырое display_name из Telegram.
  const override = clean(user.partner_custom_name) || null;
  const ownName = clean(user.custom_name) || null;
  if (override || ownName) {
    const viewerId = Number(user.tg_id);
    const partnerIdNum = partnerId ? Number(partnerId) : null;
    for (const list of [memories.results || [], quotes.results || []]) {
      for (const row of list) {
        if (override && partnerIdNum !== null && Number(row.author_id) === partnerIdNum) row.display_name = override;
        if (ownName && Number(row.author_id) === viewerId) row.display_name = ownName;
      }
    }
    for (const list of [wishes.results || [], completedWishes.results || []]) {
      for (const row of list) {
        if (override && partnerIdNum !== null && Number(row.owner_id) === partnerIdNum) row.display_name = override;
        if (ownName && Number(row.owner_id) === viewerId) row.display_name = ownName;
      }
    }
  }
  const names = withPartnerOverride(user, pair);
  return {
    user: publicUser(user, pair.timezone),
    pair: {
      id: pair.id,
      code: pair.user_b ? null : pair.code,
      name1: names.name1,
      name2: names.name2,
      user_b: pair.user_b,
      role: pair.role,
      // Партнёр вышел и не вернулся: код работает только для него самого
      // (last_partner), интерфейс подписывает инвайт соответствующе.
      awaiting_return: Number(pair.awaiting_return) === 1 ? 1 : 0,
      started_at: pair.started_at,
      // Ссылки на фото профиля Telegram: photo1 — владелец, photo2 — партнёр.
      // Свежесть гарантируется ensureUser (обновляется при каждом открытии
      // приложения тем, кому принадлежит фото).
      photo1: pair.owner_photo || null,
      photo2: pair.partner_photo || null,
      // «Вместе XP»: сумма личных XP обоих партнёров за всё время отметок.
      together_pts: (Number(user.points) || 0) + (Number(partnerUser?.points) || 0),
      // Выбранный акцент партнёра для раскраски его аватара на этом устройстве.
      partner_accent: partnerUser?.accent_color || null,
      timezone: pair.timezone,
      partner_gender: partnerUser?.gender || null,
      bot_name: env.BOT_NAME || "DuoPlan",
      bot_username: env.BOT_USERNAME || "duoplanbot"
    },
    tasks: sortByTaskDeadline(tasks.results || [], pair.timezone).slice(0, STATE_ACTIVE_LIMIT),
    completedTasks: completedTasks.results,
    dates: sortedDates,
    memories: memories.results,
    wishes: wishes.results,
    completedWishes: completedWishes.results,
    quotes: quotes.results,
    places: places.results,
    trips: trips.results,
    goals: (goals.results || []).map((goal) => ({
      ...goal,
      items: (goalItems.results || []).filter((item) => Number(item.goal_id) === Number(goal.id))
    })),
    movies: movies.results,
    savings: savings.results,
    daily
  };
}

// Страница догрузки: архивы продолжают первые STATE_RECENT_LIMIT записей
// из /api/state, активные наборы — записи после STATE_ACTIVE_LIMIT.

// Счётчики для точного остатка на кнопке «Показать ещё»: совпадают с
// фильтрами соответствующих запросов ARCHIVE_QUERIES. tasks/dates (sort-путь)
// считают остаток по уже загруженному полному набору — COUNT им не нужен.
const ARCHIVE_COUNT_SQL = {
  memories: "SELECT COUNT(*) AS n FROM memories WHERE pair_id=?",
  done_tasks: "SELECT COUNT(*) AS n FROM tasks WHERE pair_id=? AND status='done' AND (is_private=0 OR created_by=?)",
  done_wishes: "SELECT COUNT(*) AS n FROM wishes WHERE pair_id=? AND done=1",
  wishes: "SELECT COUNT(*) AS n FROM wishes WHERE pair_id=? AND done=0"
};

async function archivePage(env, pair, type, page, userId = null) {
  // Object.hasOwn, а не ARCHIVE_QUERIES[type]: имена из прототипа
  // ("constructor", "toString", "__proto__") дают truthy-функцию, проходят
  // проверку и падают на config.sql уже внутри D1 — 500 вместо 400.
  if (!Object.hasOwn(ARCHIVE_QUERIES, type)) {
    throw new HttpError(400, "Неизвестный тип архива", "INVALID_ARCHIVE_TYPE");
  }
  const config = ARCHIVE_QUERIES[type];
  if (config.sort) {
    // tasks/dates: сервер сортирует весь набор тем же способом, что и state(),
    // и отрезает страницу — порядок продолжения совпадает с порядком списка.
    const bindArgs = config.userScoped ? [pair.id, userId] : [pair.id];
    const all = await env.DB.prepare(config.sql).bind(...bindArgs).all();
    const ordered = config.sort === "date"
      ? sortDateRows(all.results || [], pair.timezone)
      : sortByTaskDeadline(all.results || [], pair.timezone);
    const start = STATE_ACTIVE_LIMIT + page * ARCHIVE_PAGE_SIZE;
    const shown = Math.min(ordered.length, start + ARCHIVE_PAGE_SIZE);
    return {
      items: ordered.slice(start, shown),
      hasMore: ordered.length > start + ARCHIVE_PAGE_SIZE,
      page,
      // Сколько записей ещё не показано после этой страницы — клиент
      // подписывает им кнопку «Показать ещё (N из M)».
      remaining: Math.max(0, ordered.length - shown)
    };
  }
  const offset = (config.active ? STATE_ACTIVE_LIMIT : STATE_RECENT_LIMIT) + page * ARCHIVE_PAGE_SIZE;
  // userScoped-запросы (done_tasks) содержат плейсхолдер created_by=? — биндим
  // userId так же, как это делает COUNT ниже, иначе D1 отдаёт «not enough
  // parameters» и архив «Завершённые» падает с 500 (репорт 2026-11-03, A-1).
  const bindArgs = config.userScoped
    ? [pair.id, userId, ARCHIVE_PAGE_SIZE + 1, offset]
    : [pair.id, ARCHIVE_PAGE_SIZE + 1, offset];
  const rows = await env.DB.prepare(config.sql).bind(...bindArgs).all();
  const results = rows.results || [];
  const shown = offset + Math.min(results.length, ARCHIVE_PAGE_SIZE);
  const totalRow = await env.DB.prepare(ARCHIVE_COUNT_SQL[type])
    .bind(...(config.userScoped ? [pair.id, userId] : [pair.id])).first();
  return {
    items: results.slice(0, ARCHIVE_PAGE_SIZE),
    hasMore: results.length > ARCHIVE_PAGE_SIZE,
    page,
    remaining: Math.max(0, Number(totalRow?.n || 0) - shown)
  };
}

// Все тела запросов приложения — маленькие JSON (диалоги, настройки, код).
// Лимит отсекает гигантские тела до парсинга: без него request.json() читал
// бы сколько прислали, держа всё в памяти изолята (риск OOM до валидации).
const MAX_BODY_BYTES = 1_000_000;

async function readJson(request) {
  const declared = Number(request.headers.get("content-length") || 0);
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) {
    throw new HttpError(413, "Тело запроса слишком большое", "PAYLOAD_TOO_LARGE");
  }
  let body;
  try {
    const text = await request.text();
    if (text.length > MAX_BODY_BYTES) {
      throw new HttpError(413, "Тело запроса слишком большое", "PAYLOAD_TOO_LARGE");
    }
    body = JSON.parse(text);
    if (!body || typeof body !== "object" || Array.isArray(body)) throw new Error("not object");
    return body;
  } catch (error) {
    if (error instanceof HttpError) throw error;
    throw new HttpError(400, "Некорректный запрос", "INVALID_JSON");
  }
}

// Желания личные: партнёр видит их в вишлисте, но менять (PATCH, DELETE,
// done/reopen) может только автор. Условия pair_id в SQL недостаточно — оно
// подтверждает лишь, что запись из общего пространства, а не право на правку
// (репорт 2026-10-29: чужие желания менялись через API при read-only UI).
async function ensureWishOwner(env, pair, user, id) {
  const wish = await env.DB.prepare("SELECT owner_id FROM wishes WHERE id=? AND pair_id=?")
    .bind(id, pair.id).first();
  if (!wish) throw new HttpError(404, "Запись не найдена", "NOT_FOUND");
  if (Number(wish.owner_id) !== Number(user.tg_id)) {
    throw new HttpError(403, "Желание принадлежит партнёру", "WISH_NOT_OWNER");
  }
}

// Копилка видна автору всегда, общая — обоим партнёрам. Личная копилка
// партнёра по прямому id отвечает 404, как несуществующая запись.
async function ensureSavingVisible(env, pair, user, id) {
  const row = await env.DB.prepare("SELECT id,collected FROM savings WHERE id=? AND pair_id=? AND (kind='shared' OR created_by=?)")
    .bind(id, pair.id, user.tg_id).first();
  if (!row) throw new HttpError(404, "Копилка не найдена", "NOT_FOUND");
  return row;
}

// Приватная дата принадлежит автору: партнёр не видит её в списках и не должен
// иметь доступа по прямому id — отвечаем 404, как для несуществующей записи,
// чтобы само существование чужой личной даты не раскрывалось. Возвращает строку
// даты: PATCH берёт из неё created_by (смена приватности — только автору) и
// текущее расписание, чтобы частичный PATCH не затирал неприсланные поля.
async function ensureDateVisible(env, pair, user, id) {
  const row = await env.DB.prepare("SELECT is_private,created_by,kind,day,time,recurs,monthly FROM dates WHERE id=? AND pair_id=?")
    .bind(id, pair.id).first();
  if (!row) return null; // 404 отдаст сам UPDATE/DELETE
  if (Number(row.is_private) === 1 && Number(row.created_by) !== Number(user.tg_id)) {
    throw new HttpError(404, "Запись не найдена", "NOT_FOUND");
  }
  return row;
}

// Личный план — зеркально личной дате: партнёр не видит его в списках и не
// может выполнить/изменить по прямому id; 404 вместо 403 не раскрывает факт
// существования. Как и у дат, строка нужна PATCH'у для частичного обновления.
async function ensureTaskVisible(env, pair, user, id) {
  const row = await env.DB.prepare("SELECT is_private,created_by,day,time,monthly,yearly FROM tasks WHERE id=? AND pair_id=?")
    .bind(id, pair.id).first();
  if (!row) return null;
  if (Number(row.is_private) === 1 && Number(row.created_by) !== Number(user.tg_id)) {
    throw new HttpError(404, "Запись не найдена", "NOT_FOUND");
  }
  return row;
}

// Видимость цели (прямой id) или цели-родителя её пункта (itemId). Личные
// цели спрятаны от партнёра целиком — вместе с пунктами.
async function ensureGoalVisible(env, pair, user, goalId, itemId = null) {
  const row = goalId !== null
    ? await env.DB.prepare("SELECT id,is_private,created_by FROM goals WHERE id=? AND pair_id=?").bind(goalId, pair.id).first()
    : await env.DB.prepare("SELECT g.id,g.is_private,g.created_by FROM goal_items gi JOIN goals g ON g.id=gi.goal_id WHERE gi.id=? AND gi.pair_id=?").bind(itemId, pair.id).first();
  if (!row) return null;
  if (Number(row.is_private) === 1 && Number(row.created_by) !== Number(user.tg_id)) {
    throw new HttpError(404, "Запись не найдена", "NOT_FOUND");
  }
  return row;
}

async function itemRoute(env, pair, user, method, pathname, body) {
  const match = pathname.match(/^\/api\/(tasks|dates|memories|wishes|quotes|places|trips|goals|goal_items|movies|savings)\/(\d+)(?:\/(done|reopen|visited|unvisited|watched|unwatched|rate|deposit))?$/);
  if (!match) return false;
  const [, type, rawId, action] = match;
  const id = Number(rawId);
  if (!positiveId(id)) throw new HttpError(400, "Некорректный идентификатор", "INVALID_ID");
  const table = { tasks: "tasks", dates: "dates", memories: "memories", wishes: "wishes", quotes: "quotes", places: "places", trips: "trips", goals: "goals", goal_items: "goal_items", movies: "movies", savings: "savings" }[type];
  // Проверяем владельца до любой записи, чтобы чужая строка не менялась даже
  // частично (UPDATE ... WHERE не сработал бы, но 403 точнее 404).
  const mutating = method === "DELETE" || method === "PATCH" || (method === "POST" && action);
  if (type === "wishes" && mutating) await ensureWishOwner(env, pair, user, id);
  const savingRow = type === "savings" && mutating ? await ensureSavingVisible(env, pair, user, id) : null;
  const dateRow = type === "dates" && mutating ? await ensureDateVisible(env, pair, user, id) : null;
  const taskRow = type === "tasks" && mutating ? await ensureTaskVisible(env, pair, user, id) : null;
  // Личные цели и их пункты: партнёр получает 404, как на личные планы.
  const goalRow = (type === "goals" || type === "goal_items") && mutating
    ? await ensureGoalVisible(env, pair, user, type === "goals" ? id : null, id)
    : null;
  if (method === "DELETE") {
    const result = await env.DB.prepare(`DELETE FROM ${table} WHERE id=? AND pair_id=?`).bind(id, pair.id).run();
    if (!result.meta.changes) throw new HttpError(404, "Запись не найдена", "NOT_FOUND");
    return true;
  }
  if (method === "PATCH") {
    // Фильм приходит из IMDb целиком: точечных правок у карточки нет.
    // У целей и пунктов PATCH не реализован: без явного 405 запрос падал бы
    // в ветку wishes и умирал на «no such column: body» с 500.
    if (type === "movies" || type === "goals" || type === "goal_items") {
      throw new HttpError(405, "Запись этого раздела нельзя отредактировать", "METHOD_NOT_ALLOWED");
    }
    const patchSchemas = {
      tasks: { title: { type: "string", maxLength: 180 }, day: { type: "string" }, time: { type: "string" }, monthly: { type: "boolean" }, yearly: { type: "boolean" }, is_private: { type: "boolean" } },
      dates: { title: { type: "string", maxLength: 120 }, day: { type: "string" }, time: { type: "string" }, recurs: { type: "boolean" }, monthly: { type: "boolean" }, is_private: { type: "boolean" } },
      memories: { body: { type: "string", maxLength: 2000 }, title: { type: "string", maxLength: 180 } },
      wishes: { body: { type: "string", maxLength: 300 }, url: { type: "string" } },
      quotes: { body: { type: "string", maxLength: 600 }, source: { type: "string", maxLength: 120 } },
      places: { title: { type: "string", maxLength: 120 }, note: { type: "string", maxLength: 600 }, url: { type: "string" } },
      trips: { title: { type: "string", maxLength: 120 }, note: { type: "string", maxLength: 600 } },
      savings: { title: { type: "string", maxLength: 120 }, target: { type: "number" } }
    };
    if (patchSchemas[type]) validateSchema(body, patchSchemas[type]);
    const fields = [];
    const values = [];
    if (type === "tasks") {
      // PATCH частичный: в UPDATE попадают только присланные поля. Раньше
      // title/day/time писались всегда, и запрос с одним title стирал дату и
      // время плана (схема при этом объявляет все поля необязательными).
      if (body.title !== undefined) {
        fields.push("title=?");
        values.push(textField(body, "title", 180, "План"));
      }
      // День и время — одна пара: неприсланное значение берём из строки,
      // чтобы перенос даты не сбрасывал время (и наоборот).
      if (body.day !== undefined || body.time !== undefined) {
        const day = body.day !== undefined ? optionalDay(body.day) : optionalDay(taskRow?.day);
        const time = body.time !== undefined ? optionalTime(body.time) : optionalTime(taskRow?.time);
        if (time && !day) throw new HttpError(400, "Выберите дату, чтобы указать время", "INVALID_DATE");
        fields.push("day=?", "time=?");
        values.push(day, time);
      }
      if (body.monthly !== undefined || body.yearly !== undefined) {
        // Частичный PATCH: неприсланный флаг берём из строки — иначе запрос
        // с одним полем снимал бы и второй (ежемесячный план терял monthly).
        const monthly = body.monthly !== undefined
          ? (body.monthly === true ? 1 : 0)
          : (Number(taskRow?.monthly) === 1 ? 1 : 0);
        const yearly = body.yearly !== undefined
          ? (body.yearly === true ? 1 : 0)
          : (Number(taskRow?.yearly) === 1 ? 1 : 0);
        // Флаги взаимоисключающие: явный «true» одного при незаданном другом —
        // переключение режима повтора, а не попытка включить оба.
        let finalMonthly = monthly;
        let finalYearly = yearly;
        if (body.yearly === true && body.monthly !== true) { finalMonthly = 0; finalYearly = 1; }
        else if (body.monthly === true && body.yearly !== true) { finalMonthly = 1; finalYearly = 0; }
        else if (finalMonthly) finalYearly = 0;
        const effectiveDay = body.day !== undefined ? optionalDay(body.day) : taskRow?.day;
        if ((finalMonthly || finalYearly) && !effectiveDay) throw new HttpError(400, "Для повтора выберите дату", "INVALID_DATE");
        fields.push("monthly=?", "yearly=?");
        values.push(finalMonthly, finalYearly);
      }
      // Приватность переключает только автор (зеркально личным датам).
      if (body.is_private !== undefined && Number(taskRow?.created_by) === Number(user.tg_id)) {
        fields.push("is_private=?");
        values.push(body.is_private === true || body.is_private === 1 ? 1 : 0);
      }
    } else if (type === "dates") {
      if (body.title !== undefined) {
        fields.push("title=?");
        values.push(textField(body, "title", 120, "Название"));
      }
      // День/время/повтор — одна группа: правка названия не должна сбрасывать
      // расписание, а перенос даты — терять время и флаги повтора.
      const scheduleTouched = body.day !== undefined || body.time !== undefined ||
        body.monthly !== undefined || body.recurs !== undefined;
      if (scheduleTouched) {
        const dayValue = body.day !== undefined ? clean(body.day) : dateRow?.day;
        if (!validDate(dayValue)) throw new HttpError(400, "Проверьте дату", "INVALID_DATE");
        // monthly перекрывает recurs: ежемесячная дата не может быть ежегодной.
        // У дня рождения повтор всегда ежегодный — флаги из формы игнорируем,
        // иначе правка карточки могла бы «отключить» сам день рождения.
        const isBirthday = dateRow?.kind === "birthday";
        const monthly = isBirthday ? 0 : (body.monthly !== undefined
          ? (body.monthly === true ? 1 : 0)
          : (Number(dateRow?.monthly) === 1 ? 1 : 0));
        const recurs = isBirthday ? 1 : (monthly === 1 ? 0 : (body.recurs !== undefined
          ? (body.recurs === false || body.recurs === 0 ? 0 : 1)
          : (Number(dateRow?.recurs) === 1 ? 1 : 0)));
        fields.push("day=?", "recurs=?", "time=?");
        values.push(dayValue, recurs, optionalTime(body.time !== undefined ? body.time : dateRow?.time));
        // У дня рождения monthly пишется всегда (как и раньше); у обычной даты —
        // только когда поле пришло, иначе PATCH названия трогал бы флаг.
        if (isBirthday || body.monthly !== undefined) {
          fields.push("monthly=?");
          values.push(monthly);
        }
      }
      // Приватность переключает только автор: партнёр, пометивший чужую общую
      // дату личной, мгновенно терял бы её из своих списков, а у дат без автора
      // (созданы до миграции 0007, created_by=0) фильтр видимости совпадал бы
      // с никем — дата исчезла бы у обоих. Чужие/старые флаги молча игнорируем:
      // диалог партнёра чекбокс не показывает, поле приходит только от автора.
      if (body.is_private !== undefined && Number(dateRow?.created_by) === Number(user.tg_id)) {
        fields.push("is_private=?");
        values.push(body.is_private === true || body.is_private === 1 ? 1 : 0);
      }
    } else if (type === "memories") {
      // PATCH частичный, как у plans/dates: правим только присланные поля,
      // иначе запрос с одним title стирал бы текст воспоминания.
      if (body.body !== undefined) {
        fields.push("body=?");
        values.push(textField(body, "body", 2000, "Воспоминание"));
      }
      if (body.title !== undefined) {
        fields.push("title=?");
        values.push(clean(body.title) || null);
      }
    } else if (type === "quotes") {
      if (body.body !== undefined) {
        fields.push("body=?");
        values.push(textField(body, "body", 600, "Цитата"));
      }
      // Источник необязателен: пустая строка очищает подпись.
      if (body.source !== undefined) {
        fields.push("source=?");
        values.push(clean(body.source) || null);
      }
    } else if (type === "places") {
      if (body.title !== undefined) {
        fields.push("title=?");
        values.push(textField(body, "title", 120, "Место"));
      }
      if (body.note !== undefined) {
        fields.push("note=?");
        values.push(clean(body.note) || null);
      }
      // Ссылка валидируется до UPDATE: иначе при битом URL название уже
      // изменилось бы, а клиент получил бы 400.
      if (body.url !== undefined) {
        fields.push("url=?");
        values.push(wishUrl(body.url) || null);
      }
    } else if (type === "trips") {
      if (body.title !== undefined) {
        fields.push("title=?");
        values.push(textField(body, "title", 120, "Поездка"));
      }
      if (body.note !== undefined) {
        fields.push("note=?");
        values.push(clean(body.note) || null);
      }
    } else if (type === "savings") {
      if (body.title !== undefined) {
        fields.push("title=?");
        values.push(textField(body, "title", 120, "Название копилки"));
      }
      // Цель правится вместе с названием; собранное не трогаем — оно
      // складывается только из пополнений. Цель ниже собранного отклоняем:
      // collected > target ломал бы прогресс и историю пополнений.
      if (body.target !== undefined) {
        const target = moneyAmount(body.target, "Цель");
        if (Number(savingRow?.collected) > target) {
          throw new HttpError(400, "Цель не может быть меньше уже собранной суммы", "TARGET_BELOW_COLLECTED");
        }
        fields.push("target=?");
        values.push(target);
      }
    } else {
      if (body.body !== undefined) {
        fields.push("body=?");
        values.push(textField(body, "body", 300, "Желание"));
      }
      // Ссылка валидируется ДО UPDATE и пишется тем же запросом: иначе при
      // некорректном URL текст уже был бы изменён, а клиент получил бы 400.
      // Пустая строка пишется как NULL — как у places, чтобы не плодить
      // в базе смесь '' и NULL для «ссылки нет».
      if (body.url !== undefined) {
        fields.push("url=?");
        values.push(wishUrl(body.url) || null);
      }
    }
    // Пустой PATCH (ни одного известного поля) — не ошибка, но и «успех»
    // на несуществующей записи выдавать нельзя: 404, как у DELETE и у
    // UPDATE с changes=0. Строки tasks/dates/savings уже прочитаны guard'ами,
    // wishes — ensureWishOwner; для остальных делаем дешёвый SELECT.
    if (!fields.length) {
      const exists = type === "tasks" ? taskRow
        : type === "dates" ? dateRow
        : type === "savings" ? savingRow
        : await env.DB.prepare(`SELECT id FROM ${table} WHERE id=? AND pair_id=?`).bind(id, pair.id).first();
      if (!exists) throw new HttpError(404, "Запись не найдена", "NOT_FOUND");
      return true;
    }
    const result = await env.DB.prepare(`UPDATE ${table} SET ${fields.join(",")} WHERE id=? AND pair_id=?`)
      .bind(...values, id, pair.id).run();
    if (!result.meta.changes) throw new HttpError(404, "Запись не найдена", "NOT_FOUND");
    return true;
  }
  if (method === "POST" && action) {
    let result;
    if (type === "tasks") {
      if (!["done", "reopen"].includes(action)) throw new HttpError(404, "Действие недоступно", "NOT_FOUND");
      result = action === "done"
        ? await env.DB.prepare("UPDATE tasks SET status='done',completed_by=?,completed_at=? WHERE id=? AND pair_id=? AND status='open'")
          .bind(user.tg_id, now(), id, pair.id).run()
        : await env.DB.prepare("UPDATE tasks SET status='open',completed_by=NULL,completed_at=NULL WHERE id=? AND pair_id=? AND status='done'")
          .bind(id, pair.id).run();
    } else if (type === "wishes") {
      if (!["done", "reopen"].includes(action)) throw new HttpError(404, "Действие недоступно", "NOT_FOUND");
      result = action === "done"
        ? await env.DB.prepare("UPDATE wishes SET done=1,done_at=? WHERE id=? AND pair_id=? AND owner_id=? AND done=0").bind(now(), id, pair.id, user.tg_id).run()
        : await env.DB.prepare("UPDATE wishes SET done=0,done_at=NULL WHERE id=? AND pair_id=? AND owner_id=? AND done=1").bind(id, pair.id, user.tg_id).run();
    } else if (type === "places") {
      // Посещение — совместное: отметку ставит любой партнёр, visited_by
      // нужен только для подписи «кто отметил».
      if (!["visited", "unvisited"].includes(action)) throw new HttpError(404, "Действие недоступно", "NOT_FOUND");
      result = action === "visited"
        ? await env.DB.prepare("UPDATE places SET visited=1,visited_at=?,visited_by=? WHERE id=? AND pair_id=? AND visited=0")
          .bind(now(), user.tg_id, id, pair.id).run()
        : await env.DB.prepare("UPDATE places SET visited=0,visited_at=NULL,visited_by=NULL WHERE id=? AND pair_id=? AND visited=1")
          .bind(id, pair.id).run();
    } else if (type === "trips") {
      // «Съездили» — совместная отметка, механика та же, что у мест.
      if (!["visited", "unvisited"].includes(action)) throw new HttpError(404, "Действие недоступно", "NOT_FOUND");
      result = action === "visited"
        ? await env.DB.prepare("UPDATE trips SET visited=1,visited_at=?,visited_by=? WHERE id=? AND pair_id=? AND visited=0")
          .bind(now(), user.tg_id, id, pair.id).run()
        : await env.DB.prepare("UPDATE trips SET visited=0,visited_at=NULL,visited_by=NULL WHERE id=? AND pair_id=? AND visited=1")
          .bind(id, pair.id).run();
    } else if (type === "goal_items") {
      // Отметка пункта цели — совместная, как посещение места: отметившего
      // запоминаем для подписи, на доступность она не влияет.
      if (!["done", "reopen"].includes(action)) throw new HttpError(404, "Действие недоступно", "NOT_FOUND");
      result = action === "done"
        ? await env.DB.prepare("UPDATE goal_items SET done=1,done_at=?,done_by=? WHERE id=? AND pair_id=? AND done=0")
          .bind(now(), user.tg_id, id, pair.id).run()
        : await env.DB.prepare("UPDATE goal_items SET done=0,done_at=NULL,done_by=NULL WHERE id=? AND pair_id=? AND done=1")
          .bind(id, pair.id).run();
    } else if (type === "movies") {
      // Просмотр — совместный, как посещение места: отметку ставит любой
      // партнёр, watched_by нужен только для подписи «кто отметил».
      if (!["watched", "unwatched", "rate"].includes(action)) throw new HttpError(404, "Действие недоступно", "NOT_FOUND");
      const movie = await env.DB.prepare("SELECT id,watched FROM movies WHERE id=? AND pair_id=?")
        .bind(id, pair.id).first();
      if (!movie) throw new HttpError(404, "Запись не найдена", "NOT_FOUND");
      const stamp = now();
      // «Просмотрено» без оценки невозможно: диалог на клиенте обязателен,
      // здесь та же проверка — иначе карточка ушла бы в «Просмотренные»
      // без голоса, и RAofP считался бы по одному партнёру.
      if (action === "watched") {
        const rating = movieRatingValue(body.rating);
        await env.DB.batch([
          env.DB.prepare(`INSERT INTO movie_ratings(movie_id,tg_id,rating,created_at,updated_at) VALUES(?,?,?,?,?)
            ON CONFLICT(movie_id,tg_id) DO UPDATE SET rating=excluded.rating, updated_at=excluded.updated_at`)
            .bind(id, user.tg_id, rating, stamp, stamp),
          // Первого отметившего не перезаписываем: повторный вызов (двойной
          // тап, гонка с партнёром) лишь обновляет его оценку.
          env.DB.prepare("UPDATE movies SET watched=1,watched_at=COALESCE(watched_at,?),watched_by=COALESCE(watched_by,?) WHERE id=? AND pair_id=?")
            .bind(stamp, user.tg_id, id, pair.id)
        ]);
        return true;
      }
      if (action === "rate") {
        // Кнопка «Оценить» живёт только в «Просмотренных»: оценивать фильм
        // из «Хотим посмотреть» нельзя.
        if (Number(movie.watched) !== 1) throw new HttpError(409, "Сначала отметьте просмотр", "MOVIE_NOT_WATCHED");
        const rating = movieRatingValue(body.rating);
        await env.DB.prepare(`INSERT INTO movie_ratings(movie_id,tg_id,rating,created_at,updated_at) VALUES(?,?,?,?,?)
          ON CONFLICT(movie_id,tg_id) DO UPDATE SET rating=excluded.rating, updated_at=excluded.updated_at`)
          .bind(id, user.tg_id, rating, stamp, stamp).run();
        return true;
      }
      // Возврат в «Хотим посмотреть» сбрасывает оценки: после повторного
      // просмотра RAofP должен собираться заново, а не показывать старые голоса.
      if (Number(movie.watched) !== 1) throw new HttpError(409, "Запись уже в этом состоянии", "NO_CHANGE");
      await env.DB.batch([
        env.DB.prepare("DELETE FROM movie_ratings WHERE movie_id=?").bind(id),
        env.DB.prepare("UPDATE movies SET watched=0,watched_at=NULL,watched_by=NULL WHERE id=? AND pair_id=?")
          .bind(id, pair.id)
      ]);
      return true;
    } else if (type === "savings") {
      // Пополнение: запись в историю и прирост collected — одна транзакция
      // (batch), чтобы сумма никогда не разошлась с историей.
      if (action !== "deposit") throw new HttpError(404, "Действие недоступно", "NOT_FOUND");
      validateSchema(body, { amount: { type: "number", required: true, errorCode: "INVALID_AMOUNT" } });
      const amount = moneyAmount(body.amount, "Сумма");
      // UPDATE первым, INSERT — под EXISTS в той же транзакции: если копилку
      // удалили в гонке, голый INSERT упал бы по FK на 500 вместо честного 404.
      const batchResults = await env.DB.batch([
        env.DB.prepare("UPDATE savings SET collected=collected+? WHERE id=? AND pair_id=?")
          .bind(amount, id, pair.id),
        env.DB.prepare("INSERT INTO savings_deposits(saving_id,tg_id,amount,created_at) SELECT ?,?,?,? WHERE EXISTS(SELECT 1 FROM savings WHERE id=? AND pair_id=?)")
          .bind(id, user.tg_id, amount, now(), id, pair.id)
      ]);
      if (!batchResults[0].meta.changes) throw new HttpError(404, "Копилка не найдена", "NOT_FOUND");
      return true;
    } else {
      throw new HttpError(404, "Действие недоступно", "NOT_FOUND");
    }
    if (!result.meta.changes) throw new HttpError(409, "Запись уже в этом состоянии", "NO_CHANGE");
    return true;
  }
  throw new HttpError(405, "Метод не поддерживается", "METHOD_NOT_ALLOWED");
}

function validateSchema(body, schema) {
  if (typeof body !== "object" || body === null) throw new HttpError(400, "Тело запроса должно быть объектом JSON", "INVALID_BODY");
  for (const [key, rule] of Object.entries(schema)) {
    const code = rule.errorCode || "MISSING_FIELD";
    if (rule.required && !(key in body)) throw new HttpError(400, `Отсутствует обязательное поле: ${key}`, code);
    if (key in body && body[key] !== null) {
      const value = body[key];
      if (rule.type === "string" && typeof value !== "string") throw new HttpError(400, `Поле ${key} должно быть строкой`, code);
      if (rule.type === "boolean" && typeof value !== "boolean") throw new HttpError(400, `Поле ${key} должно быть булевым`, code);
      if (rule.type === "number" && typeof value !== "number") throw new HttpError(400, `Поле ${key} должно быть числом`, code);
      if (rule.enum && !rule.enum.includes(value)) throw new HttpError(400, `Недопустимое значение для ${key}`, code);
      // Кодовые точки, а не UTF-16: та же единица, что у textField и
      // бэкенд-валидации бота — эмодзи не должны съедать лимит дважды.
      if (rule.maxLength && Array.from(String(value)).length > rule.maxLength) throw new HttpError(400, `Поле ${key} превышает ${rule.maxLength} символов`, code);
    }
  }
}

function ownerIds(env) {
  const raw = String(env?.OWNER_IDS || "");
  const chunks = raw.split(/[,\s;]+/).map((chunk) => chunk.trim()).filter(Boolean);
  const ids = [];
  for (const chunk of chunks) {
    const parsed = Number(chunk);
    if (Number.isFinite(parsed) && !ids.includes(parsed)) ids.push(parsed);
  }
  return ids;
}

async function api(request, env, url, ctx = null) {
  if (!env.DB) throw new HttpError(503, "База данных ещё не подключена", "DB_UNAVAILABLE");
  const initData = request.headers.get("x-telegram-init-data");
  const tgUser = await telegramUser(initData, env.BOT_TOKEN);
  if (!tgUser) throw new HttpError(401, "Сессия Telegram истекла. Откройте приложение заново.", "AUTH_EXPIRED");
  // Схема поднимается только после проверки подписи initData: ensureSchema
  // выполняет DDL, и вызов до авторизации позволял любому анонимному запросу
  // запускать миграцию на «холодном» изоляте. rateLimit ниже сам создаёт
  // минимальную таблицу rate_limits, поэтому защита от перебора не страдает.
  await ensureSchemaOnce(env);
  const timezone = validTimeZone(request.headers.get("x-timezone"));
  // Лимит проверяем ДО записи пользователя: иначе флуд всё равно создаёт
  // строки в users, а rate limit срабатывает только после (репорт 2026-10-29).
  const ownerIdList = ownerIds(env);
  const isBotOwner = ownerIdList.includes(tgUser.id);
  const knownUser = ownerIdList.length
    ? await env.DB.prepare("SELECT tg_id FROM users WHERE tg_id=?").bind(tgUser.id).first()
    : null;
  // Приватный бот: без OWNER_IDS работает открыто; иначе — только владелец и
  // уже зарегистрированные (по приглашению) люди. Незарегистрированному доступ
  // запрещён ДО создания строки в users.
  if (ownerIdList.length && !isBotOwner && !knownUser) {
    throw new HttpError(403, "Это приватный бот: доступ по приглашению. Откройте ссылку-приглашение от владельца.", "PRIVATE_BOT");
  }
  await rateLimit(env, `u:${tgUser.id}`, 240, 60);
  const user = await ensureUser(env, tgUser, timezone);

  if (request.method === "GET" && url.pathname === "/api/state") {
    const t0 = Date.now();
    const result = await state(env, user.tg_id);
    // Один фильм за открытие: старые строки дозаполняются, а TMDB-оценки
    // перепроверяются — вдруг IMDb уже поставил свою. Обновление уходит в фон
    // (ctx.waitUntil): OMDb/TMDB отвечают до 8 секунд на источник, и ждать их
    // синхронно — значит подставлять /api/state под клиентский таймаут.
    // Свежая оценка доедет к следующему открытию состояния.
    const refresh = refreshMovieRatings(env, result.movies)
      .catch((error) => console.error("movie rating refresh failed", error));
    if (ctx) ctx.waitUntil(refresh);
    console.log(`[metric] api_state_ms=${Date.now() - t0}`);
    return json(result);
  }

  const body = ["POST", "PATCH"].includes(request.method) ? await readJson(request) : {};
  if (request.method === "POST" && url.pathname === "/api/pair/create") {
    await createPair(env, user);
    return json(await state(env, user.tg_id));
  }
  if (request.method === "POST" && url.pathname === "/api/pair/join") {
    validateSchema(body, { code: { type: "string", required: true } });
    await joinPair(env, user, body.code, url);
    return json(await state(env, user.tg_id));
  }
  // Пол запрашивается гейтом до онбординга, поэтому маршрут обязан работать
  // без пары — как pair/create и pair/join: иначе новый пользователь не сможет
  // его сохранить и не попадёт к созданию пространства.
  if (request.method === "POST" && url.pathname === "/api/gender") {
    validateSchema(body, { gender: { type: "string", required: true, enum: ["male", "female"], errorCode: "INVALID_GENDER" } });
    const gender = clean(body.gender);
    await env.DB.prepare("UPDATE users SET gender = ?, updated_at = ? WHERE tg_id = ?").bind(gender, now(), user.tg_id).run();
    return json(await state(env, user.tg_id));
  }
  // Персональные настройки (карточка «Настройки» на вкладке «Наша пара»):
  // время сводок, их вкл/выкл и акцентный цвет. Доступно и без пары.
  if (request.method === "POST" && url.pathname === "/api/settings") {
    validateSchema(body, {
      accent_color: { type: "string" },
      digest_time: { type: "string" },
      digest_enabled: { type: "boolean" },
      dates_digest_time: { type: "string" },
      dates_digest_enabled: { type: "boolean" },
      show_avatar: { type: "boolean" },
      display_name: { type: "string" },
      partner_name: { type: "string" }
    });
    const updates = [];
    const values = [];
    if (body?.accent_color !== undefined) {
      if (body.accent_color !== null && !ACCENT_KEYS.includes(body.accent_color)) {
        throw new HttpError(400, "Неизвестный акцентный цвет", "INVALID_ACCENT");
      }
      updates.push("accent_color=?");
      values.push(body.accent_color);
    }
    // Переключатель «Отображение аватара»: false — буквы вместо фото профиля.
    if (body?.show_avatar !== undefined) {
      if (typeof body.show_avatar !== "boolean") throw new HttpError(400, "Флаг включённости должен быть булевым", "INVALID_SETTING");
      updates.push("show_avatar=?");
      values.push(body.show_avatar ? 1 : 0);
    }
    // Личное имя пользователя: null/пустая строка оставляет имя из Telegram,
    // не пустая — обрезается и ограничивается 80 кодовыми точками.
    if (body?.display_name !== undefined) {
      const name = body.display_name === null ? "" : clean(body.display_name);
      if (Array.from(name).length > 80) {
        throw new HttpError(400, "Ваше имя: не больше 80 символов", "INVALID_NAME");
      }
      updates.push("custom_name=?");
      values.push(name || null);
    }
    // Личное имя партнёра: null/пустая строка сбрасывает на имя из Telegram,
    // не пустая — обрезается и ограничивается 80 кодовыми точками (как
    // displayName, чтобы эмодзи не растянули бюджет UTF-16).
    if (body?.partner_name !== undefined) {
      const name = body.partner_name === null ? "" : clean(body.partner_name);
      if (Array.from(name).length > 80) {
        throw new HttpError(400, "Имя партнёра: не больше 80 символов", "INVALID_NAME");
      }
      updates.push("partner_custom_name=?");
      values.push(name ? name : null);
    }
    for (const [timeColumn, enabledColumn, enabledKey] of [
      ["digest_time", "digest_enabled", "digest_enabled"],
      ["dates_digest_time", "dates_digest_enabled", "dates_digest_enabled"]
    ]) {
      if (body?.[timeColumn] !== undefined) {
        if (body[timeColumn] !== null && !/^([01]\d|2[0-3]):[0-5]\d$/.test(clean(body[timeColumn]))) {
          throw new HttpError(400, "Время указывается в формате ЧЧ:ММ", "INVALID_TIME");
        }
        updates.push(`${timeColumn}=?`);
        values.push(body[timeColumn] === null ? null : clean(body[timeColumn]));
      }
      if (body?.[enabledKey] !== undefined) {
        if (typeof body[enabledKey] !== "boolean") throw new HttpError(400, "Флаг включённости должен быть булевым", "INVALID_SETTING");
        updates.push(`${enabledColumn}=?`);
        values.push(body[enabledKey] ? 1 : 0);
      }
    }
    if (!updates.length) throw new HttpError(400, "Нет настроек для сохранения", "EMPTY_SETTINGS");
    updates.push("updated_at=?");
    values.push(now(), user.tg_id);
    await env.DB.prepare(`UPDATE users SET ${updates.join(", ")} WHERE tg_id=?`).bind(...values).run();
    return json(await state(env, user.tg_id));
  }

  const pair = await membership(env, user.tg_id);
  if (!pair) throw new HttpError(409, "Сначала создайте или соедините пространство", "NO_PAIR");
  // Партнёр вышел (awaiting_return=1): пространство «в ожидании возвращения».
  // Контент заморожен — добавлять, менять и удалять нельзя до возврата
  // партнёра. Остаются доступны чтение (GET) и личное: настройки, часовой
  // пояс, экспорт, выход. Свежая пара без партнёра (awaiting_return=0)
  // ведёт себя как раньше.
  const SOLO_ALLOWED_PATHS = new Set(["/api/pair/leave", "/api/settings", "/api/pair/timezone", "/api/data/export"]);
  if (Number(pair.awaiting_return) === 1 && request.method !== "GET" && !SOLO_ALLOWED_PATHS.has(url.pathname)) {
    throw new HttpError(403, "Партнёр вышел из пространства — изменения будут доступны после его возвращения", "PARTNER_ABSENT");
  }
  if (request.method === "GET" && url.pathname === "/api/archive") {
    const type = String(url.searchParams.get("type") || "");
    const page = Math.min(500, Math.max(0, Math.floor(Number(url.searchParams.get("page")) || 0)));
    return json(await archivePage(env, pair, type, page, user.tg_id));
  }
  // Подсказки IMDb для диалога «Добавить фильм»: как в поисковике —
  // пользователь печатает, воркер возвращает до 8 совпадений (фильмы/сериалы).
  if (request.method === "GET" && url.pathname === "/api/movies/search") {
    await rateLimit(env, `ms:${user.tg_id}`, 30, 60);
    return json({ results: await imdbSearch(url.searchParams.get("q"), env) });
  }
  // Детали карточки «Кино»: описание, актёры, все жанры и прочее — окно
  // открывается тапом по карточке. Первый запрос собирает и кеширует данные.
  const movieDetailsMatch = request.method === "GET" && url.pathname.match(/^\/api\/movies\/(\d+)\/details$/);
  if (movieDetailsMatch) {
    const movieId = Number(movieDetailsMatch[1]);
    if (!positiveId(movieId)) throw new HttpError(400, "Некорректный идентификатор", "INVALID_ID");
    return json({ details: await movieDetailsFor(env, pair.id, movieId) });
  }
  // История пополнений копилки: открывается тапом по карточке. Имя автора
  // подставляем с учётом личного имени партнёра просматривающего.
  const savingHistoryMatch = request.method === "GET" && url.pathname.match(/^\/api\/savings\/(\d+)\/history$/);
  if (savingHistoryMatch) {
    const savingId = Number(savingHistoryMatch[1]);
    if (!positiveId(savingId)) throw new HttpError(400, "Некорректный идентификатор", "INVALID_ID");
    await ensureSavingVisible(env, pair, user, savingId);
    const deposits = await env.DB.prepare(`SELECT d.tg_id,d.amount,d.created_at,u.display_name FROM savings_deposits d
      LEFT JOIN users u ON u.tg_id=d.tg_id WHERE d.saving_id=? ORDER BY d.created_at DESC, d.id DESC LIMIT ?`)
      .bind(savingId, STATE_ACTIVE_LIMIT).all();
    const override = clean(user.partner_custom_name) || null;
    const ownName = clean(user.custom_name) || null;
    for (const row of deposits.results || []) {
      // Личные имена — зеркально state(): партнёру — свой оверрайд,
      // своим пополнениям — собственное личное имя.
      if (override && Number(row.tg_id) !== Number(user.tg_id)) row.display_name = override;
      if (ownName && Number(row.tg_id) === Number(user.tg_id)) row.display_name = ownName;
    }
    return json({ deposits: deposits.results || [] });
  }
  if (request.method === "POST" && url.pathname === "/api/pair/leave") {
    await leavePair(env, pair, url);
    return json(await state(env, user.tg_id));
  }
  // Часовой пояс пары общий: от него считаются календарь, локальный день
  // ритуала и расписание напоминаний (users.timezone — только личная база).
  if (request.method === "POST" && url.pathname === "/api/pair/timezone") {
    validateSchema(body, { timezone: { type: "string", required: true, maxLength: 64 } });
    if (!validTimeZone(clean(body.timezone))) throw new HttpError(400, "Неизвестный часовой пояс", "INVALID_TIMEZONE");
    await env.DB.prepare("UPDATE pairs SET timezone=?, updated_at=? WHERE id=?")
      .bind(clean(body.timezone), now(), pair.id).run();
    return json(await state(env, user.tg_id));
  }
  // Экспорт данных: бот запрашивающему партнёру высылается один TXT-файл —
  // человекочитаемый документ с выбранными разделами. Личные даты партнёра
  // не включаются — фильтры как в UI.
  if (request.method === "POST" && url.pathname === "/api/data/export") {
    await rateLimit(env, `export:${user.tg_id}`, 5, 3600);
    const sections = exportSections(body);
    const counts = {};
    const payload = {};
    for (const [key, scope] of Object.entries(sections)) {
      const rows = (await env.DB.prepare(EXPORT_SQL[key](scope))
        .bind(...exportSectionBinds(key, scope, pair.id, user.tg_id)).all()).results || [];
      payload[key] = rows.map(EXPORT_ROW_MAPPERS[key]);
      counts[key] = rows.length;
    }
    const summary = Object.entries(counts).map(([key, n]) => `${EXPORT_LABELS[key]}: ${n}`).join(", ");
    const form = new FormData();
    form.append("chat_id", String(user.tg_id));
    form.append("caption", `Экспорт данных — ${summary}.`);
    form.append("document", new Blob([exportTxtDoc(APP_VERSION, payload)], { type: "text/plain;charset=utf-8" }), "Экспорт.txt");
    try {
      await telegramForm(env, "sendDocument", form);
    } catch (error) {
      // Отказ выгрузки не должен выглядеть успехом — показываем ошибку явно.
      console.error("data export failed", error);
      throw new HttpError(502, "Telegram не принял файл «Экспорт». Попробуйте позже.", "EXPORT_FAILED");
    }
    return json({ ok: true, counts });
  }
  if (request.method === "POST" && url.pathname === "/api/tasks") {
    validateSchema(body, { title: { type: "string", required: true, maxLength: 180 }, day: { type: "string" }, time: { type: "string" }, monthly: { type: "boolean" }, yearly: { type: "boolean" }, is_private: { type: "boolean" } });
    const title = textField(body, "title", 180, "План");
    const { day, time } = planSchedule(body);
    const isPrivate = body.is_private === true || body.is_private === 1 ? 1 : 0;
    // Повтор осмыслен только с датой; ежемесячный перекрывает ежегодный.
    const monthly = body.monthly === true ? 1 : 0;
    const yearly = monthly ? 0 : (body.yearly === true ? 1 : 0);
    if ((monthly || yearly) && !day) throw new HttpError(400, "Для повтора выберите дату", "INVALID_DATE");
    await env.DB.prepare("INSERT INTO tasks(pair_id,title,day,time,monthly,yearly,is_private,created_by,created_at) VALUES(?,?,?,?,?,?,?,?,?)")
      .bind(pair.id, title, day, time, monthly, yearly, isPrivate, user.tg_id, now()).run();
    return json(await state(env, user.tg_id));
  }
  if (request.method === "POST" && url.pathname === "/api/dates") {
    validateSchema(body, { title: { type: "string", required: true, maxLength: 120 }, day: { type: "string", required: true }, time: { type: "string" }, recurs: { type: "boolean" }, monthly: { type: "boolean" }, is_private: { type: "boolean" }, kind: { type: "string", enum: ["date", "birthday"] } });
    const title = textField(body, "title", 120, "Название");
    if (!validDate(body.day)) throw new HttpError(400, "Проверьте дату", "INVALID_DATE");
    const time = optionalTime(body.time);
    const isPrivate = body.is_private === true || body.is_private === 1 ? 1 : 0;
    // День рождения — та же дата, но повтор всегда ежегодный: monthly из
    // формы игнорируем, recurs принудительно 1.
    const kind = body.kind === "birthday" ? "birthday" : "date";
    // Ежемесячный повтор и ежегодный взаимоисключающие: monthly перекрывает recurs.
    const monthly = kind === "birthday" ? 0 : (body.monthly === true ? 1 : 0);
    const recurs = kind === "birthday" ? 1 : (monthly ? 0 : (body.recurs === false || body.recurs === 0 ? 0 : 1));
    await env.DB.prepare("INSERT INTO dates(pair_id,title,day,time,recurs,monthly,is_private,created_by,kind,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)")
      .bind(pair.id, title, clean(body.day), time, recurs, monthly, isPrivate, user.tg_id, kind, now()).run();
    return json(await state(env, user.tg_id));
  }
  if (request.method === "POST" && url.pathname === "/api/memories") {
    validateSchema(body, { body: { type: "string", required: true, maxLength: 2000 }, title: { type: "string", maxLength: 180 } });
    const text = textField(body, "body", 2000, "Воспоминание");
    // Заголовок необязателен на сервере (у старых записей и записей из бота
    // его нет), но клиент запрашивает его при создании.
    const title = clean(body.title) || null;
    await env.DB.prepare("INSERT INTO memories(pair_id,author_id,title,body,day,created_at) VALUES(?,?,?,?,?,?)")
      .bind(pair.id, user.tg_id, title, text, localDay(pair.timezone), now()).run();
    return json(await state(env, user.tg_id));
  }
  if (request.method === "POST" && url.pathname === "/api/wishes") {
    validateSchema(body, { body: { type: "string", required: true, maxLength: 300 }, url: { type: "string" } });
    const text = textField(body, "body", 300, "Желание");
    const wishLink = wishUrl(body.url) || null;
    await env.DB.prepare("INSERT INTO wishes(pair_id,owner_id,body,url,created_at) VALUES(?,?,?,?,?)")
      .bind(pair.id, user.tg_id, text, wishLink, now()).run();
    return json(await state(env, user.tg_id));
  }
  if (request.method === "POST" && url.pathname === "/api/quotes") {
    validateSchema(body, { body: { type: "string", required: true, maxLength: 600 }, source: { type: "string", maxLength: 120 } });
    const text = textField(body, "body", 600, "Цитата");
    // Источник («Антуан де Сент-Экзюпери», «Мастер и Маргарита») необязателен.
    const source = clean(body.source) || null;
    await env.DB.prepare("INSERT INTO quotes(pair_id,author_id,body,source,created_at) VALUES(?,?,?,?,?)")
      .bind(pair.id, user.tg_id, text, source, now()).run();
    return json(await state(env, user.tg_id));
  }
  if (request.method === "POST" && url.pathname === "/api/places") {
    validateSchema(body, { title: { type: "string", required: true, maxLength: 120 }, note: { type: "string", maxLength: 600 }, url: { type: "string" } });
    const title = textField(body, "title", 120, "Место");
    const note = clean(body.note) || null;
    // Ссылка на карту/сайт: пустая строка — «ссылки нет», а не ошибка.
    const link = wishUrl(body.url) || null;
    await env.DB.prepare("INSERT INTO places(pair_id,created_by,title,note,url,created_at) VALUES(?,?,?,?,?,?)")
      .bind(pair.id, user.tg_id, title, note, link, now()).run();
    return json(await state(env, user.tg_id));
  }
  if (request.method === "POST" && url.pathname === "/api/trips") {
    validateSchema(body, { title: { type: "string", required: true, maxLength: 120 }, note: { type: "string", maxLength: 600 } });
    const title = textField(body, "title", 120, "Поездка");
    const note = clean(body.note) || null;
    await env.DB.prepare("INSERT INTO trips(pair_id,created_by,title,note,created_at) VALUES(?,?,?,?,?)")
      .bind(pair.id, user.tg_id, title, note, now()).run();
    return json(await state(env, user.tg_id));
  }
  // Создание цели: название + пункты выполнения (хотя бы один). Пункты без
  // текста не сохраняем — пустая строка в диалоге означает «строку не заполнили».
  if (request.method === "POST" && url.pathname === "/api/goals") {
    validateSchema(body, { title: { type: "string", required: true, maxLength: 180 }, is_private: { type: "boolean" } });
    const title = textField(body, "title", 180, "Цель");
    if (!Array.isArray(body.items)) throw new HttpError(400, "Добавьте хотя бы один пункт", "INVALID_ITEMS");
    const items = body.items
      .filter((item) => typeof item === "string")
      .map((item) => clean(item))
      .filter(Boolean);
    if (!items.length) throw new HttpError(400, "Добавьте хотя бы один пункт", "INVALID_ITEMS");
    if (items.length > 30) throw new HttpError(400, "Не больше 30 пунктов на цель", "INVALID_ITEMS");
    for (const item of items) {
      if (Array.from(item).length > 180) throw new HttpError(400, "Пункт превышает 180 символов", "INVALID_ITEMS");
    }
    // Атомарность создания: пункты уходят одним batch (D1 исполняет его
    // единой транзакцией — либо все пункты, либо ни одного), а при его сбое
    // цель удаляется компенсирующе. «Осиротевшая» цель без пунктов не
    // остаётся. Один общий batch здесь невозможен: goal_id для пунктов — это
    // meta.last_row_id цели, а last_insert_rowid() внутри batch после первого
    // же пункта возвращал бы rowid пункта, не цели.
    const goalResult = await env.DB.prepare("INSERT INTO goals(pair_id,created_by,title,is_private,created_at) VALUES(?,?,?,?,?)")
      .bind(pair.id, user.tg_id, title, body.is_private === true ? 1 : 0, now()).run();
    const goalId = goalResult.meta.last_row_id;
    try {
      await env.DB.batch(items.map((item) =>
        env.DB.prepare("INSERT INTO goal_items(goal_id,pair_id,created_by,title,created_at) VALUES(?,?,?,?,?)")
          .bind(goalId, pair.id, user.tg_id, item, now())
      ));
    } catch (error) {
      // Компенсация откатывает цель, если пункты не записались. Сбой самой
      // компенсации логируем — исходная ошибка важнее.
      try {
        await env.DB.prepare("DELETE FROM goals WHERE id=? AND pair_id=?").bind(goalId, pair.id).run();
      } catch (cleanupError) {
        console.error("goal cleanup failed", cleanupError);
      }
      throw error;
    }
    return json(await state(env, user.tg_id));
  }
  // Добавление фильма по выбору из подсказок: карточка собирается из IMDb
  // целиком (название/рейтинг/жанр/длительность), ручной ввод названий нет.
  if (request.method === "POST" && url.pathname === "/api/movies") {
    validateSchema(body, { imdb_id: { type: "string", required: true } });
    const imdbId = clean(body.imdb_id);
    if (!/^tt\d+$/.test(imdbId)) throw new HttpError(400, "Некорректный идентификатор фильма", "INVALID_IMDB_ID");
    const existing = await env.DB.prepare("SELECT id FROM movies WHERE pair_id=? AND imdb_id=?")
      .bind(pair.id, imdbId).first();
    if (existing) throw new HttpError(409, "Этот фильм уже в списке", "ALREADY_ADDED");
    const info = await movieInfo(env, imdbId);
    // Источник оценки: IMDb (OMDb) или TMDB-фолбэк для новинок без голосов.
    const ratingSource = info.rating ? (info.ratingSource || "imdb") : null;
    const stamp = now();
    try {
      await env.DB.prepare(`INSERT INTO movies(pair_id,created_by,imdb_id,title,year,kind,rating,rating_source,rating_checked_at,genres,runtime,seasons,episodes,url,created_at)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
        .bind(pair.id, user.tg_id, imdbId,
          clean(info.title) || "Без названия",
          info.year ?? (Number(body.year) || null),
          info.kind,
          info.rating,
          ratingSource,
          // Следующая перепроверка — через сутки: сейчас OMDb только что ответил.
          stamp,
          clean(info.genre) || null,
          info.runtime,
          info.seasons,
          info.episodes,
          `https://www.imdb.com/title/${imdbId}/`,
          stamp).run();
    } catch (error) {
      // Гонка: партнёр добавил тот же фильм, пока мы получали данные с IMDb.
      // UNIQUE(pair_id, imdb_id) — честный 409 вместо 500.
      if (String(error?.message || "").includes("UNIQUE constraint failed")) {
        throw new HttpError(409, "Этот фильм уже в списке", "ALREADY_ADDED");
      }
      throw error;
    }
    return json(await state(env, user.tg_id));
  }
  // Новая копилка: личная (видна только автору) или общая (вся пара).
  if (request.method === "POST" && url.pathname === "/api/savings") {
    validateSchema(body, { title: { type: "string", required: true, maxLength: 120 }, target: { type: "number", required: true, errorCode: "INVALID_AMOUNT" }, kind: { type: "string", required: true, enum: ["personal", "shared"] } });
    const title = textField(body, "title", 120, "Название копилки");
    const target = moneyAmount(body.target, "Цель");
    await env.DB.prepare("INSERT INTO savings(pair_id,created_by,kind,title,target,collected,created_at) VALUES(?,?,?,?,?,0,?)")
      .bind(pair.id, user.tg_id, clean(body.kind), title, target, now()).run();
    return json(await state(env, user.tg_id));
  }
  if (request.method === "POST" && url.pathname === "/api/daily/done") {
    if (!pair.user_b) throw new HttpError(409, "Ритуал дня откроется, когда партнёр присоединится", "PAIR_INCOMPLETE");
    const daily = await dailyFor(env, pair.id, pair.timezone, user.tg_id);
    if (daily.done) return json({ ...(await state(env, user.tg_id)), awarded: false });

    const stamp = now();
    // Захват ритуала и начисление XP выполняются в одной транзакции (D1 batch).
    // Если этап начисления завершится ошибкой, захват откатится вместе с ним,
    // и повторный запрос сможет корректно повторить начисление.
    // changes() отражает результат предыдущего UPDATE в той же транзакции:
    // XP начисляется только если захват ритуала сработал (changes > 0),
    // что исключает дубли и повторное начисление при гонках.
    const batchResults = await env.DB.batch([
      env.DB.prepare("INSERT OR IGNORE INTO daily_completions(pair_id,tg_id,day,completed_at) VALUES(?,?,?,?)")
        .bind(pair.id, user.tg_id, daily.day, stamp),
      env.DB.prepare(`UPDATE users SET
        points = points + 10,
        streak = CASE
          WHEN last_activity IS NULL THEN 1
          WHEN last_activity = ? THEN MAX(1, streak)
          WHEN julianday(?) - julianday(last_activity) = 1 THEN streak + 1
          ELSE 1
        END,
        best_streak = MAX(best_streak, CASE
          WHEN last_activity IS NULL THEN 1
          WHEN last_activity = ? THEN MAX(1, streak)
          WHEN julianday(?) - julianday(last_activity) = 1 THEN streak + 1
          ELSE 1
        END),
        last_activity = ?,
        updated_at = ?
        WHERE tg_id = ?
          AND (SELECT changes()) > 0`)
        .bind(daily.day, daily.day, daily.day, daily.day, daily.day, stamp, user.tg_id)
    ]);
    // Отдельного счётчика у пары больше нет: «Вместе XP» — сумма личных очков
    // обоих партнёров (points), считается на выводе из users, а не в pairs.
    const captured = Number(batchResults?.[0]?.meta?.changes || 0) > 0;
    if (!captured) {
      // Ритуал уже был отмечен — повторный запрос полностью идемпотентен.
      return json({ ...(await state(env, user.tg_id)), awarded: false });
    }
    return json({ ...(await state(env, user.tg_id)), awarded: true });
  }
  if (await itemRoute(env, pair, user, request.method, url.pathname, body)) {
    return json(await state(env, user.tg_id));
  }
  throw new HttpError(404, "Раздел не найден", "NOT_FOUND");
}

// Повтор при сетевой ошибке безопасен только для методов, у которых нет
// побочного эффекта в чате: обрыв соединения и таймаут (AbortSignal) не говорят,
// дошёл ли запрос до Telegram. Для sendMessage повтор после таймаута давал бы
// второе сообщение, поэтому сеть ретраится только для идемпотентных методов,
// а 429 — для всех: там Telegram явно отверг вызов и ничего не отправил.
const TELEGRAM_IDEMPOTENT = new Set([
  "getMe", "getWebhookInfo", "setWebhook", "deleteWebhook", "setMyCommands", "setChatMenuButton"
]);

async function telegram(env, method, payload, attempt = 0) {
  const retryOnNetwork = TELEGRAM_IDEMPOTENT.has(method);
  let response;
  try {
    response = await fetch(`https://api.telegram.org/bot${env.BOT_TOKEN}/${method}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(12000)
    });
  } catch (error) {
    if (retryOnNetwork && attempt < 2) {
      await new Promise(resolve => setTimeout(resolve, 250 * (attempt + 1)));
      return telegram(env, method, payload, attempt + 1);
    }
    throw error;
  }
  const raw = await response.text();
  let result;
  try {
    result = JSON.parse(raw);
  } catch {
    throw new Error(`Telegram вернул не JSON (${response.status})`);
  }
  if (result.error_code === 429 && attempt < 2) {
    const wait = Math.min(3000, Math.max(500, Number(result.parameters?.retry_after || 1) * 1000));
    await new Promise(resolve => setTimeout(resolve, wait));
    return telegram(env, method, payload, attempt + 1);
  }
  if (!response.ok || !result.ok) throw new Error(result.description || `Telegram API ${response.status}`);
  return result.result;
}

function appUrl(env, requestUrl) {
  return `${(env.APP_ORIGIN || requestUrl.origin).replace(/\/$/, "")}/app`;
}

async function openApp(env, chatId, requestUrl, text) {
  // parse_mode HTML: сводки и напоминания собираются через richToHtml
  // (всё экранировано, теги закрыты статически). Статические тексты вебхука
  // не содержат <>& и безопасны в HTML-режиме.
  return telegram(env, "sendMessage", {
    chat_id: chatId,
    text,
    parse_mode: "HTML",
    reply_markup: { inline_keyboard: [[{ text: "Открыть наше пространство", web_app: { url: appUrl(env, requestUrl) } }]] }
  });
}

async function webhook(request, env, url) {
  if (!env.WEBHOOK_SECRET || !safeEqual(request.headers.get("x-telegram-bot-api-secret-token"), env.WEBHOOK_SECRET)) {
    return new Response("Forbidden", { status: 403 });
  }
  // Схема (включая индекс по received_at) создаётся до INSERT дедупликации.
  await ensureSchemaOnce(env);
  // Чистку дедуп-таблицы делаем в cron (sendDigests), а не здесь: минус один
  // запрос на каждый апдейт вебхука (репорт 2026-11-03, §5.5).

  let update;
  try {
    update = await request.json();
  } catch {
    return json({ ok: true });
  }
  const updateId = positiveId(update?.update_id) ? update.update_id : null;
  let recorded = false;
  if (updateId) {
    const seen = await env.DB.prepare("INSERT OR IGNORE INTO telegram_updates(update_id,received_at) VALUES(?,?)")
      .bind(updateId, now()).run();
    if (!seen.meta.changes) return json({ ok: true });
    recorded = true;
  }
  // Тело апдейта может быть любым JSON: "null" парсится успешно и даёт
  // update === null, поэтому обращение к update.message падало бы TypeError
  // вне try и отдавало 500 вместо тихого {ok:true}.
  const message = update?.message;
  const msgText = message?.text || message?.caption;
  if (!msgText || message.chat?.type !== "private" || !positiveId(message.from?.id)) {
    return json({ ok: true });
  }
  const ownerIdList = ownerIds(env);
  const isBotOwner = ownerIdList.includes(message.from.id);
  const knownUser = ownerIdList.length ? await env.DB.prepare("SELECT tg_id FROM users WHERE tg_id=?").bind(message.from.id).first() : null;
  if (ownerIdList.length && !isBotOwner && !knownUser) {
    // Приватный бот: незнакомцам — только /start <код открытой пары>.
    const text = clean(message.text || message.caption || "");
    const inviteCode = startPayload(text);
    const inviteCodeUpper = inviteCode.toUpperCase();
    // Резерв кода (parity open_pair_for_code в боте): зарезервированный код
// открывает гейт только прежнему партнёру — посторонний не регистрируется.
const openPair = /^[A-F0-9]{8}$/i.test(inviteCode)
  ? await env.DB.prepare("SELECT id FROM pairs WHERE code=? AND user_b=0 AND (awaiting_return=0 OR last_partner=?)").bind(inviteCodeUpper, message.from.id).first()
  : null;
    if (!openPair) {
      // Отказ — некритичный путь: update_id уже записан в telegram_updates,
      // и упавший сюда 500 привёл бы к повтору апдейта, который дедуп вернёт
      // как {ok:true} — отказ так и не был бы доставлен. Гасим сбой тихо.
      try {
        await telegram(env, "sendMessage", {
          chat_id: message.chat.id,
          text: "Это приватный бот DuoPlan — доступ по приглашению. Попросите владельца прислать ссылку-приглашение (t.me/<бот>?start=КОД) и откройте её."
        });
      } catch (error) {
        console.error("private gate denial failed", error);
      }
      return json({ ok: true });
    }
  }
  try {
    const user = await ensureUser(env, message.from, null);
    const text = clean(msgText);
    const code = startPayload(text);
    if (code) {
      let joined = false;
      let joinFailText = "";
      const existingMembership = await membership(env, user.tg_id);
      if (existingMembership) {
        joined = clean(existingMembership.code).toUpperCase() === code.toUpperCase();
        // Чужой код при живом членстве — не «приглашение недоступно»,
        // а «вы уже в пространстве» (зеркально ответу бота).
        if (!joined) joinFailText = "Вы уже в пространстве — этот код к другой паре. Новый код можно применить только после выхода из текущей.";
      } else {
        try {
          await joinPair(env, user, code, url);
          joined = true;
        } catch (error) {
          const racedMembership = await membership(env, user.tg_id);
          joined = !!racedMembership && clean(racedMembership.code).toUpperCase() === code.toUpperCase();
          if (!racedMembership) {
            if (error instanceof HttpError) {
              joined = false;
              // «Пространство закрыто» и «код зарезервирован» честнее общего
              // «приглашение недоступно».
              joinFailText = error.code === "PAIR_CLOSED"
                ? "Это пространство закрыто: последний участник вышел. Попросите партнёра отправить вам код нового пространства."
                : error.code === "PAIR_RESERVED"
                  ? "Это пространство ждёт возвращения прежнего партнёра — старый код на другого аккаунта не действует."
                  : "";
            } else throw error;
          }
        }
      }
      await openApp(env, message.chat.id, url, joined
        ? "Готово — теперь у вас одно пространство на двоих."
        : (joinFailText || "Это приглашение недоступно. Проверьте код у партнёра."));
    } else if (text.startsWith("/help")) {
      await telegram(env, "sendMessage", {
        chat_id: message.chat.id,
        text: "DuoPlan хранит ваши общие планы, даты, воспоминания и желания. Откройте Mini App кнопкой ниже: там можно добавлять, редактировать и завершать записи."
      });
      await openApp(env, message.chat.id, url, "Ваше пространство всегда под рукой.");
    } else {
      await openApp(env, message.chat.id, url, "Совместные планы, воспоминания и желания — в одном месте.");
    }
  } catch (error) {
    console.error("webhook delivery failed", error);
    // Снимаем отметку об обработке, чтобы Telegram мог повторить доставку.
    if (recorded && updateId) {
      try {
        await env.DB.prepare("DELETE FROM telegram_updates WHERE update_id=?").bind(updateId).run();
      } catch (cleanupError) {
        console.error("webhook dedup cleanup failed", cleanupError);
      }
    }
    return json({ ok: false, error: "delivery_failed" }, 500);
  }
  return json({ ok: true });
}

// ------------------------------------------------------------------
// Уведомления в боте (cron каждые 15 минут): утренняя сводка (планы и даты
// на сегодня-завтра, двумя абзацами) в персональное время, отдельная сводка
// о датах за сутки до наступления в своё время и напоминания о планах
// с точным временем — за 3 часа и за 1 час. Личные даты получает их автор.
// ------------------------------------------------------------------

// Ежегодная дата совпадает по месяцу и дню независимо от года (29 февраля
// уведомляется только в високосный год — так же, как в интерфейсе, где
// nextDateOccurrence отбрасывает несуществующие календарные даты).
function dateOccursOnDay(item, targetDay) {
  const day = String(item?.day || "");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return false;
  if (day === targetDay) return true;
  if (monthlyOccursOnDay(item, targetDay)) return true;
  return Boolean(item.recurs) && Number(item.monthly) !== 1 && day.slice(5) === targetDay.slice(5);
}

function parseTimeMinutes(value, fallbackMinutes = 9 * 60) {
  const match = /^(\d{1,2}):(\d{2})$/.exec(String(value ?? ""));
  if (!match) return fallbackMinutes;
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  if (hours > 23 || minutes > 59) return fallbackMinutes;
  return hours * 60 + minutes;
}

// Cron тикает раз в 15 минут (wrangler.jsonc), поэтому время из хвоста суток
// (23:46–23:59) иначе не срабатывает никогда: тик 23:45 ещё раньше назначенного,
// а тик 00:00 уже попадает на новые сутки, где minutes=0 и условие «время
// наступило» ложно до следующих суток — и снова мимо. Считаем время наступившим,
// если до него дошло сегодня, ИЛИ если текущий тик уложился в одно 15-минутное
// окно после времени прошлых суток (полуночная сводка уйдёт с уже новыми
// «сегодня/завтра»; одну отправку гарантирует дедуп-журнал notification_log).
const CRON_TICK_MINUTES = 15;

function timeDueWithRollover(minutes, timeValue) {
  const scheduled = parseTimeMinutes(timeValue);
  if (minutes >= scheduled) return true;
  return 1440 - scheduled + minutes <= CRON_TICK_MINUTES;
}

function localMinutesOfDay(timeZone, stamp) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: timeZone || DEFAULT_TZ, hour: "2-digit", minute: "2-digit", hour12: false
  }).formatToParts(stamp);
  const get = (type) => Number(parts.find((part) => part.type === type)?.value || "0");
  return (get("hour") % 24) * 60 + get("minute");
}

// ------------------------------------------------------------------
// Разметка текста (Telegram-стиль) в уведомлениях. Хранится в самих полях:
// **жирный**, _курсив_, __подчёркнутый__, ~~зачёркнутый~~, ||спойлер|| и
// строки «> » — цитата. Для sendMessage всё экранируется и переводится в
// HTML-теги (parse_mode: HTML в openApp); стек гарантирует закрытость тегов.
// Тот же поднабор поддерживает клиент (renderRichText в public/app.js).
// ------------------------------------------------------------------
function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

const RICH_TOKENS = [["**", "b"], ["__", "u"], ["||", "tg-spoiler"], ["~~", "s"], ["_", "i"]];

function richInline(escaped) {
  const out = [];
  const stack = [];
  let i = 0;
  while (i < escaped.length) {
    const token = RICH_TOKENS.find(([t]) => escaped.startsWith(t, i));
    if (token) {
      const [tok, tag] = token;
      // Балансировка как в HTML: закрывающий маркер закрывает и все вложенные
      // в него элементы — интерливинг «__а _б__ в_» не ломает структуру тегов.
      const openIndex = stack.map(item => item.tok).lastIndexOf(tok);
      if (openIndex !== -1) {
        for (let s = stack.length - 1; s >= openIndex; s--) out.push(`</${stack[s].tag}>`);
        stack.length = openIndex;
      } else {
        out.push(`<${tag}>`);
        stack.push({ tok, tag });
      }
      i += tok.length;
      continue;
    }
    out.push(escaped[i++]);
  }
  while (stack.length) out.push(`</${stack.pop().tag}>`);
  return out.join("");
}

function richToHtml(raw) {
  const lines = escapeHtml(raw).split("\n");
  const out = [];
  let quote = null;
  const flushQuote = () => {
    if (!quote) return;
    out.push(`<blockquote>${quote.map(richInline).join("\n")}</blockquote>`);
    quote = null;
  };
  for (const line of lines) {
    if (line.startsWith("&gt; ")) { (quote ??= []).push(line.slice(5)); continue; }
    if (line === "&gt;") { (quote ??= []).push(""); continue; }
    flushQuote();
    out.push(richInline(line));
  }
  flushQuote();
  // Пустая пара тегов («****» → «<b></b>») не несёт смысла и может сломать
  // разбор entities: вычищаем, повторяя для вложенных пустышек.
  const emptyRe = /<(b|i|u|s|tg-spoiler|blockquote)><\/\1>/g;
  let markup = out.join("\n");
  for (;;) {
    const cleaned = markup.replace(emptyRe, "");
    if (cleaned === markup) return markup;
    markup = cleaned;
  }
}

// Личные события в уведомлениях автора: заголовок скрыт под спойлером,
// чтобы план-сюрприз не читался с экрана блокировки.
const RICH_MASKED = "<tg-spoiler>Скрытый</tg-spoiler>";
const maskTitle = (item) => (Number(item.is_private) === 1 ? RICH_MASKED : richToHtml(item.title));

// Утренняя сводка: два абзаца — значимые даты и планы, внутри каждого
// сегодня/завтра. Один Telegram-месседж (parse_mode HTML в openApp), поэтому
// кап общий: не больше DIGEST_MAX_ITEMS строк И суммарная длина строк в
// пределах DIGEST_MAX_CHARS — разметка и экранирование раздувают строку,
// перебор вернул бы sendMessage 400, и сводка молча не ушла бы.
const DIGEST_MAX_ITEMS = 18;
const DIGEST_MAX_CHARS = 3400;

function digestText(today, tomorrow, dates, tasks) {
  // Дни рождения — отдельный абзац: их читают иначе, чем годовщины, и по ним
  // нужен запас на подарок, а не «сегодня — значит сегодня».
  const birthday = (d) => d.kind === "birthday";
  const todayDates = dates.filter(d => !birthday(d) && dateOccursOnDay(d, today));
  const tomorrowDates = dates.filter(d => !birthday(d) && dateOccursOnDay(d, tomorrow));
  const birthdayLines = [
    // Своё личное напоминание не маскируем: сообщение уходит только автору,
    // а «Скрытый» в строке «день рождения у Скрытый» бесполезен.
    ...dates.filter(d => birthday(d) && dateOccursOnDay(d, today)).map(d => `• Сегодня — ${richToHtml(d.title)}`),
    ...dates.filter(d => birthday(d) && dateOccursOnDay(d, tomorrow)).map(d => `• Завтра — ${richToHtml(d.title)}`)
  ];
  const occurs = (task, day) =>
    String(task.day) === day ||
    monthlyOccursOnDay(task, day) ||
    (Number(task.yearly) === 1 && String(task.day).slice(5) === String(day).slice(5));
  const todayTasks = tasks.filter(t => occurs(t, today));
  const tomorrowTasks = tasks.filter(t => occurs(t, tomorrow));
  if (!todayDates.length && !tomorrowDates.length && !birthdayLines.length && !todayTasks.length && !tomorrowTasks.length) return "";
  const dateLines = [
    ...todayDates.map(d => `• Сегодня — ${maskTitle(d)}${d.time ? ` (${d.time})` : ""}`),
    ...tomorrowDates.map(d => `• Завтра — ${maskTitle(d)}${d.time ? ` (${d.time})` : ""}`)
  ];
  const taskLines = [
    ...todayTasks.map(t => `• Сегодня${t.time ? `, до ${t.time}` : ""} — ${maskTitle(t)}`),
    ...tomorrowTasks.map(t => `• Завтра${t.time ? `, до ${t.time}` : ""} — ${maskTitle(t)}`)
  ];
  const lines = ["Доброе утро! Напоминаю о ближайших событиях:", ""];
  let shown = 0;
  let hidden = 0;
  let used = lines[0].length + 1;
  const pushParagraph = (title, items) => {
    if (!items.length) return;
    lines.push(title);
    used += title.length + 1;
    for (const item of items) {
      if (shown < DIGEST_MAX_ITEMS && used + item.length + 1 <= DIGEST_MAX_CHARS) {
        lines.push(item);
        used += item.length + 1;
        shown++;
      } else hidden++;
    }
    lines.push("");
    used += 1;
  };
  pushParagraph("Дни рождения", birthdayLines);
  pushParagraph("Значимые даты", dateLines);
  pushParagraph("Планы", taskLines);
  if (hidden) lines.push(`…и ещё ${hidden} — полный список в приложении`);
  return lines.join("\n").trim();
}

// Сводка о датах за сутки: только завтрашние даты.
function datesDigestText(timeZone, tomorrow, dates) {
  const fmt = new Intl.DateTimeFormat("ru-RU", { timeZone: timeZone || DEFAULT_TZ, day: "numeric", month: "long" });
  const tomorrowDates = dates.filter(d => dateOccursOnDay(d, tomorrow));
  if (!tomorrowDates.length) return "";
  const [year, month, date] = tomorrow.split("-").map(Number);
  const noon = new Date(makeDateInTimeZone(year, month - 1, date, 12, 0, timeZone || DEFAULT_TZ));
  const lines = [`Завтра · ${fmt.format(noon)}`];
  let shown = 0;
  let hidden = 0;
  let used = lines[0].length + 30;
  for (const item of tomorrowDates) {
    const line = `• ${item.kind === "birthday" ? "День рождения — " : ""}${item.kind === "birthday" ? richToHtml(item.title) : maskTitle(item)}${item.time ? ` (${item.time})` : ""}`;
    if (shown < DIGEST_MAX_ITEMS && used + line.length + 1 <= DIGEST_MAX_CHARS) { lines.push(line); used += line.length + 1; shown++; }
    else hidden++;
  }
  if (hidden) lines.push(`…и ещё ${hidden}`);
  return ["Напоминаю: завтра значимые даты:", "", ...lines].join("\n").trim();
}

// ------------------------------------------------------------------
// Экспорт данных (POST /api/data/export): пользователь выбирает разделы и
// состав каждого, воркер собирает выбранные коллекции пары в один TXT-файл
// («Экспорт.txt») и отправляет sendDocument'ом — без потолка сообщений и
// без резки текста. Приватность — как в интерфейсе: личные записи
// партнёра не попадают в выгрузку ни в каком составе.
// ------------------------------------------------------------------

// Допустимые составы каждой секции. «private» — только личные записи
// запросившего (планы/даты/дни рождения), «mine» — только его записи в
// общих коллекциях (места/дневник/цитаты/желания), «open» — не просмотренные.
const EXPORT_SECTIONS = {
  plans: ["all", "private"],
  movies: ["open"],
  dates: ["all", "private"],
  birthdays: ["all", "private"],
  places: ["all", "mine"],
  trips: ["all", "mine"],
  memories: ["all", "mine"],
  quotes: ["all", "mine"],
  wishes: ["all", "mine"]
};

const EXPORT_LABELS = {
  plans: "планы",
  movies: "кино",
  dates: "значимые даты",
  birthdays: "дни рождения",
  places: "места",
  trips: "поездки",
  memories: "дневник",
  quotes: "цитаты",
  wishes: "желания"
};

// SQL каждой секции: состав меняет второй фильтр — «все» оставляет видимость
// интерфейса, «private»/«mine» жёстко привязывают выборку к запросившему.
const EXPORT_SQL = {
  // Планы — только незавершённые: завершённые живут в архиве приложения и
  // в выгрузку не входят (состав «private» дополнительно сужает до личных).
  plans: (scope) => `SELECT t.id,t.title,t.day,t.time,t.monthly,t.yearly,t.is_private,t.created_at,u.display_name AS author FROM tasks t
    LEFT JOIN users u ON u.tg_id=t.created_by WHERE t.pair_id=? AND t.status='open'${scope === "private" ? " AND t.is_private=1 AND t.created_by=?" : " AND (t.is_private=0 OR t.created_by=?)"} ORDER BY COALESCE(t.day,'9999-99-99') ASC, t.id ASC`,
  movies: () => `SELECT m.id,m.imdb_id,m.title,m.year,m.kind,m.rating,m.rating_source,m.runtime,m.seasons,m.episodes,m.url,m.created_at,(SELECT ROUND(AVG(r.rating),1) FROM movie_ratings r WHERE r.movie_id=m.id) AS pair_rating,u.display_name AS author FROM movies m
    LEFT JOIN users u ON u.tg_id=m.created_by WHERE m.pair_id=? AND m.watched=0 ORDER BY m.created_at ASC, m.id ASC`,
  dates: (scope) => `SELECT d.id,d.title,d.day,d.time,d.recurs,d.monthly,d.is_private,d.kind,d.created_at,u.display_name AS author FROM dates d
    LEFT JOIN users u ON u.tg_id=d.created_by WHERE d.pair_id=? AND d.kind='date'${scope === "private" ? " AND d.is_private=1 AND d.created_by=?" : " AND (d.is_private=0 OR d.created_by=?)"} ORDER BY d.day ASC, d.id ASC`,
  birthdays: (scope) => `SELECT d.id,d.title,d.day,d.time,d.recurs,d.monthly,d.is_private,d.kind,d.created_at,u.display_name AS author FROM dates d
    LEFT JOIN users u ON u.tg_id=d.created_by WHERE d.pair_id=? AND d.kind='birthday'${scope === "private" ? " AND d.is_private=1 AND d.created_by=?" : " AND (d.is_private=0 OR d.created_by=?)"} ORDER BY d.day ASC, d.id ASC`,
  places: (scope) => `SELECT p.id,p.title,p.note,p.url,p.visited,p.visited_at,p.created_at,u.display_name AS author FROM places p
    LEFT JOIN users u ON u.tg_id=p.created_by WHERE p.pair_id=?${scope === "mine" ? " AND p.created_by=?" : ""} ORDER BY p.created_at ASC, p.id ASC`,
  trips: (scope) => `SELECT t.id,t.title,t.note,t.visited,t.visited_at,t.created_at,u.display_name AS author FROM trips t
    LEFT JOIN users u ON u.tg_id=t.created_by WHERE t.pair_id=?${scope === "mine" ? " AND t.created_by=?" : ""} ORDER BY t.created_at ASC, t.id ASC`,
  memories: (scope) => `SELECT m.id,m.title,m.body,m.day,m.created_at,u.display_name AS author FROM memories m
    LEFT JOIN users u ON u.tg_id=m.author_id WHERE m.pair_id=?${scope === "mine" ? " AND m.author_id=?" : ""} ORDER BY m.created_at ASC, m.id ASC`,
  quotes: (scope) => `SELECT q.id,q.body,q.source,q.created_at,u.display_name AS author FROM quotes q
    LEFT JOIN users u ON u.tg_id=q.author_id WHERE q.pair_id=?${scope === "mine" ? " AND q.author_id=?" : ""} ORDER BY q.created_at ASC, q.id ASC`,
  wishes: (scope) => `SELECT w.id,w.body,w.url,w.created_at,u.display_name AS author FROM wishes w
    LEFT JOIN users u ON u.tg_id=w.owner_id WHERE w.pair_id=? AND w.done=0${scope === "mine" ? " AND w.owner_id=?" : ""} ORDER BY w.created_at ASC, w.id ASC`
};

// Бинды каждой секции: у кино состав фиксирован (второй фильтр не нужен);
// у общих коллекций (места/поездки/дневник/цитаты/желания) второй бинд с tg_id
// появляется только в составе «mine» — в составе «all» в SQL один
// плейсхолдер (пары), и лишний бинд роняет запрос. У планов/дат/дней
// рождения фильтр видимости стоит в обоих составах — биндятся всегда.
function exportSectionBinds(key, scope, pairId, userId) {
  if (key === "movies") return [pairId];
  if (scope === "all" && !["plans", "dates", "birthdays"].includes(key)) return [pairId];
  return [pairId, userId];
}

function exportSections(body) {
  const raw = body?.sections;
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new HttpError(400, "Выберите хотя бы один раздел для выгрузки", "INVALID_EXPORT");
  }
  const sections = {};
  for (const [key, value] of Object.entries(raw)) {
    if (!EXPORT_SECTIONS[key] || !EXPORT_SECTIONS[key].includes(value)) {
      throw new HttpError(400, "Неизвестный раздел экспорта", "INVALID_EXPORT");
    }
    sections[key] = value;
  }
  if (!Object.keys(sections).length) throw new HttpError(400, "Выберите хотя бы один раздел для выгрузки", "INVALID_EXPORT");
  return sections;
}

// Нормализация строк по секциям: машиночитаемый JSON с полными текстами,
// created_at — unix-секунды как в базе, флаги приведены к булевым, пустой
// заголовок — null.
function exportMemoryRow(row) {
  return {
    id: row.id,
    day: row.day,
    author: clean(row.author) || "Партнёр",
    title: clean(row.title) || null,
    body: row.body ?? "",
    created_at: row.created_at
  };
}

function exportDateRow(row) {
  return {
    id: row.id,
    day: row.day,
    time: row.time || null,
    title: row.title,
    kind: row.kind === "birthday" ? "birthday" : "date",
    recurs: Number(row.recurs) === 1,
    monthly: Number(row.monthly) === 1,
    is_private: Number(row.is_private) === 1,
    author: clean(row.author) || "Партнёр",
    created_at: row.created_at
  };
}

const EXPORT_ROW_MAPPERS = {
  plans: (row) => ({
    id: row.id,
    title: row.title,
    day: row.day || null,
    time: row.time || null,
    monthly: Number(row.monthly) === 1,
    yearly: Number(row.yearly) === 1,
    is_private: Number(row.is_private) === 1,
    author: clean(row.author) || "Партнёр",
    created_at: row.created_at
  }),
  movies: (row) => ({
    id: row.id,
    imdb_id: row.imdb_id,
    title: row.title,
    year: row.year || null,
    kind: row.kind === "series" ? "series" : "movie",
    rating: row.rating ?? null,
    rating_source: row.rating_source || null,
    pair_rating: row.pair_rating ?? null,
    runtime: row.runtime || null,
    seasons: row.seasons || null,
    episodes: row.episodes || null,
    url: row.url || null,
    author: clean(row.author) || "Партнёр",
    created_at: row.created_at
  }),
  dates: exportDateRow,
  birthdays: exportDateRow,
  places: (row) => ({
    id: row.id,
    title: row.title,
    note: clean(row.note) || null,
    url: row.url || null,
    visited: Number(row.visited) === 1,
    visited_at: row.visited_at || null,
    author: clean(row.author) || "Партнёр",
    created_at: row.created_at
  }),
  trips: (row) => ({
    id: row.id,
    title: row.title,
    note: clean(row.note) || null,
    visited: Number(row.visited) === 1,
    visited_at: row.visited_at || null,
    author: clean(row.author) || "Партнёр",
    created_at: row.created_at
  }),
  memories: exportMemoryRow,
  quotes: (row) => ({
    id: row.id,
    body: row.body ?? "",
    source: clean(row.source) || null,
    author: clean(row.author) || "Партнёр",
    created_at: row.created_at
  }),
  wishes: (row) => ({
    id: row.id,
    body: row.body ?? "",
    url: row.url || null,
    author: clean(row.author) || "Партнёр",
    created_at: row.created_at
  })
};

// ------------------------------------------------------------------
// Рендер TXT: каждая выбранная секция — заголовок с количеством записей,
// далее нумерованные записи. Первая строка записи — заголовок (или сам
// текст для дневника/цитат/желаний), дальше строки «Метка: значение»,
// пустые поля пропускаются, многострочные значения печатаются с отступом.
// ------------------------------------------------------------------

// unix-секунды → «2026-11-05 12:34 UTC» (время всегда в UTC — без пояса пары,
// чтобы выгрузка не зависела от того, откуда её открыли).
function exportTxtTime(unix) {
  if (!unix) return null;
  return `${new Date(unix * 1000).toISOString().slice(0, 16).replace("T", " ")} UTC`;
}

// Главная строка и поля каждой записи. Поля — пары [метка, значение].
const EXPORT_TXT_ROWS = {
  plans: (row) => ({
    head: row.title,
    fields: [
      ["Когда", [row.day, row.time].filter(Boolean).join(" ")],
      ["Повтор", row.monthly ? "ежемесячный" : row.yearly ? "ежегодный" : null],
      ["Личный", row.is_private ? "да" : null],
      ["Добавил", row.author],
      ["Создан", exportTxtTime(row.created_at)]
    ]
  }),
  movies: (row) => ({
    head: row.title,
    fields: [
      ["Год", row.year],
      ["Тип", row.kind === "series" ? "сериал" : "фильм"],
      ["Рейтинг", row.rating ? `${row.rating} (${row.rating_source === "tmdb" ? "TMDB" : "IMDb"})` : null],
      ["RAofP", row.pair_rating],
      ["Длительность", row.runtime ? `${row.runtime} мин` : null],
      ["Сезоны", row.seasons],
      ["Эпизоды", row.episodes],
      ["Ссылка", row.url],
      ["Добавил", row.author],
      ["Создан", exportTxtTime(row.created_at)]
    ]
  }),
  dates: (row) => ({
    head: row.title,
    fields: [
      ["День", [row.day, row.time].filter(Boolean).join(" ")],
      ["Повторяется", row.recurs ? "да" : null],
      ["Ежемесячная", row.monthly ? "да" : null],
      ["Личная", row.is_private ? "да" : null],
      ["Добавил", row.author],
      ["Создан", exportTxtTime(row.created_at)]
    ]
  }),
  // Дни рождения рендерятся той же формой записи, что и значимые даты:
  // это одна таблица dates с разным kind (маппер строк общий — exportDateRow).
  birthdays: (row) => EXPORT_TXT_ROWS.dates(row),
  places: (row) => ({
    head: row.title,
    fields: [
      ["Заметка", row.note],
      ["Ссылка", row.url],
      ["Посещено", row.visited ? (row.visited_at ? `да (${exportTxtTime(row.visited_at)})` : "да") : null],
      ["Добавил", row.author],
      ["Создан", exportTxtTime(row.created_at)]
    ]
  }),
  trips: (row) => ({
    head: row.title,
    fields: [
      ["Заметка", row.note],
      ["Съездили", row.visited ? (row.visited_at ? `да (${exportTxtTime(row.visited_at)})` : "да") : null],
      ["Добавил", row.author],
      ["Создан", exportTxtTime(row.created_at)]
    ]
  }),
  memories: (row) => ({
    head: row.title || "(без заголовка)",
    fields: [
      ["День", row.day],
      ["Текст", row.body],
      ["Добавил", row.author],
      ["Создан", exportTxtTime(row.created_at)]
    ]
  }),
  quotes: (row) => ({
    head: row.body,
    fields: [
      ["Источник", row.source],
      ["Добавил", row.author],
      ["Создан", exportTxtTime(row.created_at)]
    ]
  }),
  wishes: (row) => ({
    head: row.body,
    fields: [
      ["Ссылка", row.url],
      ["Добавил", row.author],
      ["Создан", exportTxtTime(row.created_at)]
    ]
  })
};

// Строки одной записи: номер и главная строка (продолжения — с отступом),
// затем поля «Метка: значение» (пустые пропускаются). Сигнатура без
// деструктуризации — extractBraced в тестах берёт первую «{» после имени.
function exportTxtRecord(n, record) {
  const { head, fields } = record;
  const headLines = String(head ?? "").split("\n");
  const lines = [`${n}. ${headLines[0]}`.trimEnd()];
  for (const chunk of headLines.slice(1)) lines.push(`   ${chunk}`);
  for (const [label, value] of fields) {
    if (value === null || value === undefined || value === "") continue;
    for (const [i, line] of String(value).split("\n").entries()) {
      lines.push(i === 0 ? `   ${label}: ${line}` : `       ${line}`);
    }
  }
  return lines.join("\n");
}

// Весь документ: шапка + секции в порядке EXPORT_LABELS (пустые секции не
// печатаются — их количества и так видны в подписи к файлу).
function exportTxtDoc(version, payload) {
  const parts = [
    "Общий дневник — экспорт данных",
    `Дата выгрузки: ${exportTxtTime(Math.floor(Date.now() / 1000))}`,
    `Версия: ${version}`
  ];
  for (const [key, label] of Object.entries(EXPORT_LABELS)) {
    const rows = payload[key] || [];
    if (!rows.length) continue;
    parts.push("", `${label[0].toUpperCase()}${label.slice(1)} — ${rows.length}`, "");
    parts.push(rows.map((row, i) => exportTxtRecord(i + 1, EXPORT_TXT_ROWS[key](row))).join("\n\n"));
  }
  return `${parts.join("\n")}\n`;
}

// Отправка файла: multipart/form-data — fetch сам ставит boundary, поэтому
// content-type не задаём. sendDocument не идемпотентен: сетевые ошибки не
// ретраим (иначе дубль файла в чате), 429 — ретраим (Telegram ничего не
// отправил, retry_after из ответа).
async function telegramForm(env, method, form, attempt = 0) {
  const response = await fetch(`https://api.telegram.org/bot${env.BOT_TOKEN}/${method}`, {
    method: "POST",
    body: form,
    signal: AbortSignal.timeout(30000)
  });
  const raw = await response.text();
  let result;
  try {
    result = JSON.parse(raw);
  } catch {
    throw new Error(`Telegram вернул не JSON (${response.status})`);
  }
  if (result.error_code === 429 && attempt < 2) {
    const wait = Math.min(3000, Math.max(500, Number(result.parameters?.retry_after || 1) * 1000));
    await new Promise(resolve => setTimeout(resolve, wait));
    return telegramForm(env, method, form, attempt + 1);
  }
  if (!response.ok || !result.ok) throw new Error(result.description || `Telegram API ${response.status}`);
  return result.result;
}

async function deliverNotification(env, member, day, kind, text) {
  // Журнал — и дедуп, и защита от повторов при транзиентных сбоях крона.
  const marked = await env.DB.prepare("INSERT OR IGNORE INTO notification_log(tg_id,day,kind,sent_at) VALUES(?,?,?,?)")
    .bind(member, day, kind, now()).run();
  if (!marked.meta.changes) {
    console.log(`[metric] notification_skipped member=${member} kind=${kind} day=${day}`);
    return false;
  }
  try {
    // requestUrl в кроне нет: appUrl использует env.APP_ORIGIN из vars.
    await openApp(env, member, { origin: "" }, text);
    console.log(`[metric] notification_sent member=${member} kind=${kind} day=${day}`);
    return true;
  } catch (error) {
    const description = String(error?.message || error);
    // Постоянные ошибки Telegram (бот заблокирован, чата нет, неверный запрос)
    // не ретраим: отметку оставляем, чтобы не долбить API до конца дня.
    if (/forbidden|chat not found|blocked|bad request|unauthorized/i.test(description)) return false;
    // Транзиентный сбой — снимаем отметку: следующий тик повторит.
    try {
      await env.DB.prepare("DELETE FROM notification_log WHERE tg_id=? AND day=? AND kind=?")
        .bind(member, day, kind).run();
    } catch (cleanupError) {
      console.error("notification_log cleanup failed", cleanupError);
    }
    return false;
  }
}

// Окна напоминаний не пересекаются: задача, до которой меньше часа, получает
// только «Через час». Раньше обе ветки срабатывали в одном тике, и на задачу
// через 20 минут уходило два сообщения — одно с враньём про «через 3 часа».
const REMINDER_3H = 3 * 3600000;
const REMINDER_1H = 1 * 3600000;

function planTaskReminders(tasks, timeZone, nowMs) {
  const planned = [];
  for (const task of tasks) {
    if (!task.time || !/^\d{2}:\d{2}$/.test(task.time)) continue;
    const target = taskTargetMs(task, timeZone);
    if (!Number.isFinite(target) || target <= nowMs) continue;
    const left = target - nowMs;
    if (left <= REMINDER_1H) {
      // Тик 15-минутный, поэтому «через час» почти всегда неточно: задача
      // может быть хоть через минуту. Называем фактическое время.
      const minutes = Math.max(1, Math.round(left / 60000));
      const lead = minutes >= 55 ? "Через час" : `Через ${minutes} мин`;
      planned.push({ task, kind: `task1h:${task.id}`, lead });
    } else if (left <= REMINDER_3H) planned.push({ task, kind: `task3h:${task.id}`, lead: "Через 3 часа" });
  }
  return planned;
}

async function processPairNotifications(env, pair, stamp, budget) {
  // validTimeZone: битый/чужой tz в базе не должен ронять Intl исключением.
  const timeZone = validTimeZone(pair.timezone) || DEFAULT_TZ;
  const nowMs = stamp.getTime();
  const today = localDay(timeZone, nowMs);
  const tomorrow = new Date(Date.parse(`${today}T00:00:00Z`) + 86400000).toISOString().slice(0, 10);
  const minutes = localMinutesOfDay(timeZone, stamp);
  const members = [pair.user_a, pair.user_b].filter(id => positiveId(id));
  if (!members.length) return;
  budget.left -= 3; // пользователи + даты + планы
  const [userRows, dateRows, taskRows] = await Promise.all([
    env.DB.prepare(`SELECT * FROM users WHERE tg_id IN (${members.map(() => "?").join(",")})`).bind(...members).all(),
    env.DB.prepare("SELECT id,title,day,time,recurs,monthly,is_private,created_by,kind FROM dates WHERE pair_id=?").bind(pair.id).all(),
    env.DB.prepare("SELECT id,title,day,time,monthly,yearly,is_private,created_by FROM tasks WHERE pair_id=? AND status='open' AND day IS NOT NULL").bind(pair.id).all()
  ]);
  const users = userRows.results || [];
  const dates = dateRows.results || [];
  const tasks = taskRows.results || [];

  // Напоминания о планах с точным временем: за 3 часа и за 1 час. Условие
  // «первый тик, когда время пришло» + дедуп в журнале дают одну отправку.
  // Личные планы напоминают только их автору и со скрытым заголовком.
  const reminders = planTaskReminders(tasks, timeZone, nowMs);
  for (const reminder of reminders) {
    for (const member of members) {
      if (budget.left < 2) break;
      if (Number(reminder.task.is_private) === 1 && Number(reminder.task.created_by) !== Number(member)) continue;
      budget.left -= 2;
      const title = Number(reminder.task.is_private) === 1 ? RICH_MASKED : richToHtml(reminder.task.title);
      await deliverNotification(env, member, today, reminder.kind, `${reminder.lead}: ${title} (${reminder.task.time})`);
    }
  }

  // День рождения за 3 дня: запас на подарок и планы. Окно ровно одно —
  // ровно за трое суток, поэтому сообщение приходит один раз; дедуп в журнале
  // страхует от повторного тика. Личный ДР напоминаем только автору.
  const inThreeDays = new Date(Date.parse(`${today}T00:00:00Z`) + 3 * 86400000).toISOString().slice(0, 10);
  for (const member of members) {
    const visible = dates.filter(d => Number(d.is_private) !== 1 || Number(d.created_by) === Number(member));
    for (const date of visible) {
      if (date.kind !== "birthday" || !dateOccursOnDay(date, inThreeDays)) continue;
      if (budget.left < 2) break;
      budget.left -= 2;
      await deliverNotification(env, member, today, `birthday3d:${date.id}`, `Через 3 дня — день рождения: ${richToHtml(date.title)}`);
    }
  }

  for (const member of members) {
    const user = users.find(u => Number(u.tg_id) === Number(member));
    const visibleDates = dates.filter(d => Number(d.is_private) !== 1 || Number(d.created_by) === Number(member));
    // Личные планы — только их автору; заголовок скрыт спойлером в maskTitle.
    const visibleTasks = tasks.filter(t => Number(t.is_private) !== 1 || Number(t.created_by) === Number(member));
    // Утренняя сводка в персональное время (по умолчанию 09:00).
    if (Number(user?.digest_enabled ?? 1) === 1 && timeDueWithRollover(minutes, user?.digest_time)) {
      const text = digestText(today, tomorrow, visibleDates, visibleTasks);
      if (text) {
        if (budget.left < 2) break;
        budget.left -= 2;
        await deliverNotification(env, member, today, "digest", text);
      }
    }
    // Сводка о датах за сутки: завтрашние даты в персональное время.
    if (Number(user?.dates_digest_enabled ?? 1) === 1 && timeDueWithRollover(minutes, user?.dates_digest_time)) {
      const text = datesDigestText(timeZone, tomorrow, visibleDates);
      if (text) {
        if (budget.left < 2) break;
        budget.left -= 2;
        await deliverNotification(env, member, today, "dates_digest", text);
      }
    }
  }
}

// Free-план Workers даёт 50 подзапросов на вызов: бюджет считаем явно
// (3 запроса на пару + 2 на каждую отправку) и останавливаемся на пороге.
// Два подзапроса тика съедает сам курсор очереди (чтение + запись).
const DIGEST_MAX_PAIRS = 10;
const DIGEST_BUDGET = 44;

// Страница очереди тика по устойчивому курсору: следующие после курсора пары
// по возрастанию id; хвост исчерпан — начинаем с начала. В отличие от прежней
// ротации «по минутам суток» обход доходит до каждой пары за
// ceil(N / DIGEST_MAX_PAIRS) тиков при любом N, а разница числа посещений
// пар за любое окно тиков не превышает 1. Чистая функция — покрывается
// тестом tests/test_notification_queue.test.mjs.
function queuePage(sortedPairs, cursorId, max = DIGEST_MAX_PAIRS) {
  const after = sortedPairs.filter((p) => p.id > cursorId);
  return after.length ? after.slice(0, max) : sortedPairs.slice(0, max);
}

async function nextNotificationQueue(env, pairs) {
  const sorted = [...pairs].sort((a, b) => a.id - b.id);
  let cursor = 0;
  try {
    const row = await env.DB.prepare("SELECT value FROM app_meta WHERE key='notification_cursor'").first();
    const parsed = Number(row?.value);
    if (Number.isFinite(parsed)) cursor = parsed;
  } catch (error) {
    console.error("notification cursor read failed", error);
  }
  const page = queuePage(sorted, cursor);
  const last = page[page.length - 1];
  if (last) {
    try {
      await env.DB.prepare("INSERT INTO app_meta(key,value) VALUES('notification_cursor',?) " +
        "ON CONFLICT(key) DO UPDATE SET value=excluded.value").bind(String(last.id)).run();
    } catch (error) {
      // Курсор не продвинется: следующий тик повторит ту же страницу.
      // Дедуп через notification_log не даст задвоить уже отправленное.
      console.error("notification cursor write failed", error);
    }
  }
  return page;
}

async function sendDigests(env) {
  await ensureSchemaOnce(env);
  // Дедуп-таблица вебхука растёт на каждый апдейт: чистим её здесь, раз в
  // cron-тик, а не в обработчике вебхука (репорт 2026-11-03, §5.5).
  try {
    await env.DB.prepare("DELETE FROM telegram_updates WHERE received_at < ?").bind(now() - 7 * 24 * 60 * 60).run();
  } catch (error) {
    console.error("telegram_updates prune failed", error);
  }
  // Журнал растёт на несколько строк в день: хвост старше недели бесполезен.
  try {
    await env.DB.prepare("DELETE FROM notification_log WHERE day < ?")
      .bind(localDay(DEFAULT_TZ, Date.now() - 7 * 86400000)).run();
  } catch (error) {
    console.error("notification_log prune failed", error);
  }
  let pairs;
  try {
    pairs = (await env.DB.prepare("SELECT * FROM pairs").all()).results || [];
  } catch (error) {
    console.error("digest pairs query failed", error);
    return;
  }
  if (!pairs.length) return;
  console.log(`[metric] active_pairs=${pairs.length}`);
  const stamp = new Date();
  const queue = await nextNotificationQueue(env, pairs);
  const budget = { left: DIGEST_BUDGET - 2 };
  for (const pair of queue) {
    if (budget.left < 4) break;
    try {
      await processPairNotifications(env, pair, stamp, budget);
    } catch (error) {
      console.error("notifications failed for pair", pair?.id, error);
    }
  }
}

async function ensureSchema(env) {
  try {
    const meta = await env.DB.prepare("SELECT value FROM app_meta WHERE key='schema_version'").first();
    if (meta?.value === DB_SCHEMA_VERSION) {
      try {
        await env.DB.batch([
          env.DB.prepare(`INSERT OR IGNORE INTO pair_members(tg_id,pair_id,role,joined_at)
            SELECT user_a,id,'a',created_at FROM pairs WHERE user_a!=0 AND EXISTS(SELECT 1 FROM users WHERE tg_id=pairs.user_a)`),
          env.DB.prepare(`INSERT OR IGNORE INTO pair_members(tg_id,pair_id,role,joined_at)
            SELECT user_b,id,'b',created_at FROM pairs WHERE user_b!=0 AND EXISTS(SELECT 1 FROM users WHERE tg_id=pairs.user_b)`)
        ]);
      } catch (repairError) {
        console.error("pair_members repair failed", repairError);
      }
      return;
    }
  } catch {
    // Таблицы app_meta ещё нет — продолжаем полную инициализацию
  }

  const statements = [
    `CREATE TABLE IF NOT EXISTS pairs (id INTEGER PRIMARY KEY AUTOINCREMENT,code TEXT NOT NULL UNIQUE,name1 TEXT NOT NULL,name2 TEXT NOT NULL DEFAULT '',user_a INTEGER NOT NULL,user_b INTEGER NOT NULL DEFAULT 0,started_at TEXT NOT NULL,together_pts INTEGER NOT NULL DEFAULT 0,timezone TEXT NOT NULL DEFAULT 'Europe/Moscow',awaiting_return INTEGER NOT NULL DEFAULT 0,last_partner INTEGER NOT NULL DEFAULT 0,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL)`,
    // Коды удалённых пространств (последний участник вышел): вход по такому
    // коду отвечает «пространство закрыто», а не «код не найден».
    `CREATE TABLE IF NOT EXISTS closed_codes (code TEXT PRIMARY KEY,closed_at INTEGER NOT NULL)`,
    `CREATE TABLE IF NOT EXISTS users (tg_id INTEGER PRIMARY KEY,username TEXT,display_name TEXT NOT NULL DEFAULT '',role TEXT NOT NULL DEFAULT 'a',pair_id INTEGER REFERENCES pairs(id) ON DELETE SET NULL,points INTEGER NOT NULL DEFAULT 0,streak INTEGER NOT NULL DEFAULT 0,last_activity TEXT,best_streak INTEGER NOT NULL DEFAULT 0,timezone TEXT NOT NULL DEFAULT 'Europe/Moscow',gender TEXT,digest_time TEXT,digest_enabled INTEGER NOT NULL DEFAULT 1,dates_digest_time TEXT,dates_digest_enabled INTEGER NOT NULL DEFAULT 1,accent_color TEXT,photo_url TEXT,show_avatar INTEGER NOT NULL DEFAULT 1,partner_custom_name TEXT,custom_name TEXT,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL)`,
    `CREATE TABLE IF NOT EXISTS pair_members (tg_id INTEGER PRIMARY KEY,pair_id INTEGER NOT NULL REFERENCES pairs(id) ON DELETE CASCADE,role TEXT NOT NULL DEFAULT 'a',joined_at INTEGER NOT NULL)`,
    `CREATE TABLE IF NOT EXISTS tasks (id INTEGER PRIMARY KEY AUTOINCREMENT,pair_id INTEGER NOT NULL REFERENCES pairs(id) ON DELETE CASCADE,title TEXT NOT NULL,status TEXT NOT NULL DEFAULT 'open',day TEXT,time TEXT,monthly INTEGER NOT NULL DEFAULT 0,yearly INTEGER NOT NULL DEFAULT 0,is_private INTEGER NOT NULL DEFAULT 0,created_by INTEGER NOT NULL,created_at INTEGER NOT NULL,completed_by INTEGER,completed_at INTEGER)`,
    `CREATE TABLE IF NOT EXISTS dates (id INTEGER PRIMARY KEY AUTOINCREMENT,pair_id INTEGER NOT NULL REFERENCES pairs(id) ON DELETE CASCADE,title TEXT NOT NULL,day TEXT NOT NULL,time TEXT,recurs INTEGER NOT NULL DEFAULT 1,monthly INTEGER NOT NULL DEFAULT 0,is_private INTEGER NOT NULL DEFAULT 0,created_by INTEGER NOT NULL DEFAULT 0,kind TEXT NOT NULL DEFAULT 'date',created_at INTEGER NOT NULL)`,
    `CREATE TABLE IF NOT EXISTS memories (id INTEGER PRIMARY KEY AUTOINCREMENT,pair_id INTEGER NOT NULL REFERENCES pairs(id) ON DELETE CASCADE,author_id INTEGER NOT NULL,title TEXT,body TEXT NOT NULL,day TEXT NOT NULL,created_at INTEGER NOT NULL)`,
    `CREATE TABLE IF NOT EXISTS wishes (id INTEGER PRIMARY KEY AUTOINCREMENT,pair_id INTEGER NOT NULL REFERENCES pairs(id) ON DELETE CASCADE,owner_id INTEGER NOT NULL,body TEXT NOT NULL,done INTEGER NOT NULL DEFAULT 0,done_at INTEGER,created_at INTEGER NOT NULL,url TEXT)`,
    `CREATE TABLE IF NOT EXISTS quotes (id INTEGER PRIMARY KEY AUTOINCREMENT,pair_id INTEGER NOT NULL REFERENCES pairs(id) ON DELETE CASCADE,author_id INTEGER NOT NULL,body TEXT NOT NULL,source TEXT,created_at INTEGER NOT NULL)`,
    `CREATE TABLE IF NOT EXISTS places (id INTEGER PRIMARY KEY AUTOINCREMENT,pair_id INTEGER NOT NULL REFERENCES pairs(id) ON DELETE CASCADE,created_by INTEGER NOT NULL,title TEXT NOT NULL,note TEXT,url TEXT,visited INTEGER NOT NULL DEFAULT 0,visited_at INTEGER,visited_by INTEGER,created_at INTEGER NOT NULL)`,
    `CREATE TABLE IF NOT EXISTS trips (id INTEGER PRIMARY KEY AUTOINCREMENT,pair_id INTEGER NOT NULL REFERENCES pairs(id) ON DELETE CASCADE,created_by INTEGER NOT NULL,title TEXT NOT NULL,note TEXT,visited INTEGER NOT NULL DEFAULT 0,visited_at INTEGER,visited_by INTEGER,created_at INTEGER NOT NULL)`,
    `CREATE TABLE IF NOT EXISTS goals (id INTEGER PRIMARY KEY AUTOINCREMENT,pair_id INTEGER NOT NULL REFERENCES pairs(id) ON DELETE CASCADE,created_by INTEGER NOT NULL,title TEXT NOT NULL,is_private INTEGER NOT NULL DEFAULT 0,created_at INTEGER NOT NULL)`,
    `CREATE TABLE IF NOT EXISTS goal_items (id INTEGER PRIMARY KEY AUTOINCREMENT,goal_id INTEGER NOT NULL REFERENCES goals(id) ON DELETE CASCADE,pair_id INTEGER NOT NULL REFERENCES pairs(id) ON DELETE CASCADE,created_by INTEGER NOT NULL,title TEXT NOT NULL,done INTEGER NOT NULL DEFAULT 0,done_at INTEGER,done_by INTEGER,created_at INTEGER NOT NULL)`,
    `CREATE TABLE IF NOT EXISTS movies (id INTEGER PRIMARY KEY AUTOINCREMENT,pair_id INTEGER NOT NULL REFERENCES pairs(id) ON DELETE CASCADE,created_by INTEGER NOT NULL,imdb_id TEXT NOT NULL,title TEXT NOT NULL,year INTEGER,kind TEXT NOT NULL DEFAULT 'movie',rating REAL,rating_source TEXT,rating_checked_at INTEGER,details TEXT,genres TEXT,runtime INTEGER,seasons INTEGER,episodes INTEGER,url TEXT,watched INTEGER NOT NULL DEFAULT 0,watched_at INTEGER,watched_by INTEGER,created_at INTEGER NOT NULL)`,
    `CREATE TABLE IF NOT EXISTS movie_ratings (movie_id INTEGER NOT NULL REFERENCES movies(id) ON DELETE CASCADE,tg_id INTEGER NOT NULL,rating INTEGER NOT NULL,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL,PRIMARY KEY (movie_id,tg_id))`,
    `CREATE TABLE IF NOT EXISTS savings (id INTEGER PRIMARY KEY AUTOINCREMENT,pair_id INTEGER NOT NULL REFERENCES pairs(id) ON DELETE CASCADE,created_by INTEGER NOT NULL,kind TEXT NOT NULL DEFAULT 'personal',title TEXT NOT NULL,target INTEGER NOT NULL,collected INTEGER NOT NULL DEFAULT 0,created_at INTEGER NOT NULL)`,
    `CREATE TABLE IF NOT EXISTS savings_deposits (id INTEGER PRIMARY KEY AUTOINCREMENT,saving_id INTEGER NOT NULL REFERENCES savings(id) ON DELETE CASCADE,tg_id INTEGER NOT NULL,amount INTEGER NOT NULL,created_at INTEGER NOT NULL)`,
    `CREATE TABLE IF NOT EXISTS daily_rolls (pair_id INTEGER NOT NULL REFERENCES pairs(id) ON DELETE CASCADE,day TEXT NOT NULL,daily_value TEXT NOT NULL,PRIMARY KEY (pair_id,day))`,  /* done_by/done_at removed: relic of pre-daily_completions schema */
    `CREATE TABLE IF NOT EXISTS rate_limits (bucket_key TEXT PRIMARY KEY,count INTEGER NOT NULL,expires_at INTEGER NOT NULL DEFAULT 0)`,
    `CREATE TABLE IF NOT EXISTS telegram_updates (update_id INTEGER PRIMARY KEY,received_at INTEGER NOT NULL)`,
    `CREATE TABLE IF NOT EXISTS daily_completions (pair_id INTEGER NOT NULL REFERENCES pairs(id) ON DELETE CASCADE,tg_id INTEGER NOT NULL,day TEXT NOT NULL,completed_at INTEGER NOT NULL,PRIMARY KEY (pair_id,tg_id,day))`,
    `CREATE TABLE IF NOT EXISTS app_meta (key TEXT PRIMARY KEY,value TEXT NOT NULL)`,
    `CREATE TABLE IF NOT EXISTS notification_log (tg_id INTEGER NOT NULL,day TEXT NOT NULL,kind TEXT NOT NULL,sent_at INTEGER NOT NULL,PRIMARY KEY (tg_id,day,kind))`,
    `CREATE INDEX IF NOT EXISTS idx_tasks_pair ON tasks(pair_id,status)`,
    `CREATE INDEX IF NOT EXISTS idx_dates_pair ON dates(pair_id,day)`,
    `CREATE INDEX IF NOT EXISTS idx_memories_pair ON memories(pair_id,created_at)`,
    `CREATE INDEX IF NOT EXISTS idx_wishes_pair ON wishes(pair_id,done)`,
    `CREATE INDEX IF NOT EXISTS idx_quotes_pair ON quotes(pair_id,created_at)`,
    `CREATE INDEX IF NOT EXISTS idx_places_pair ON places(pair_id,visited)`,
    `CREATE INDEX IF NOT EXISTS idx_trips_pair ON trips(pair_id,visited)`,
    `CREATE INDEX IF NOT EXISTS idx_goals_pair ON goals(pair_id,is_private)`,
    `CREATE INDEX IF NOT EXISTS idx_goal_items_goal ON goal_items(goal_id,done)`,
    `CREATE INDEX IF NOT EXISTS idx_movies_pair ON movies(pair_id,watched)`,
    `CREATE INDEX IF NOT EXISTS idx_savings_pair ON savings(pair_id,kind)`,
    `CREATE INDEX IF NOT EXISTS idx_savings_deposits_saving ON savings_deposits(saving_id,created_at)`,
    // Дубли кино, накопленные гонкой до появления уникального индекса, убираем
    // здесь же: иначе CREATE UNIQUE INDEX упадёт и весь batch схемы не применится.
    // Оставляем просмотренную строку, при равенстве — самую раннюю.
    `DELETE FROM movies WHERE id NOT IN (SELECT id FROM (SELECT id, ROW_NUMBER() OVER (PARTITION BY pair_id, imdb_id ORDER BY watched DESC, id ASC) AS rn FROM movies) WHERE rn = 1)`,
    `CREATE UNIQUE INDEX IF NOT EXISTS idx_movies_pair_imdb ON movies(pair_id,imdb_id)`,
    `CREATE INDEX IF NOT EXISTS idx_movie_ratings_movie ON movie_ratings(movie_id)`,
    `CREATE INDEX IF NOT EXISTS idx_pair_members_pair ON pair_members(pair_id)`,
    `CREATE UNIQUE INDEX IF NOT EXISTS idx_pair_members_role ON pair_members(pair_id,role)`,
    `CREATE INDEX IF NOT EXISTS idx_telegram_updates_received_at ON telegram_updates(received_at)`,
    `CREATE INDEX IF NOT EXISTS idx_daily_completions_pair_day ON daily_completions(pair_id,day)`
  ];
  await env.DB.batch(statements.map(sql => env.DB.prepare(sql)));
  for (const [table, column, definition] of [
    ["users", "timezone", "TEXT NOT NULL DEFAULT 'Europe/Moscow'"],
    ["users", "gender", "TEXT"],
    ["users", "digest_time", "TEXT"],
    ["users", "digest_enabled", "INTEGER NOT NULL DEFAULT 1"],
    ["users", "dates_digest_time", "TEXT"],
    ["users", "dates_digest_enabled", "INTEGER NOT NULL DEFAULT 1"],
    ["users", "accent_color", "TEXT"],
    ["users", "photo_url", "TEXT"],
    ["users", "show_avatar", "INTEGER NOT NULL DEFAULT 1"],
    ["users", "partner_custom_name", "TEXT"],
    ["users", "custom_name", "TEXT"],
    ["pairs", "timezone", "TEXT NOT NULL DEFAULT 'Europe/Moscow'"],
    ["pairs", "awaiting_return", "INTEGER NOT NULL DEFAULT 0"],
    ["pairs", "last_partner", "INTEGER NOT NULL DEFAULT 0"],
    ["tasks", "day", "TEXT"],
    ["tasks", "time", "TEXT"],
    ["tasks", "is_private", "INTEGER NOT NULL DEFAULT 0"],
    ["dates", "time", "TEXT"],
    ["dates", "is_private", "INTEGER NOT NULL DEFAULT 0"],
    ["dates", "created_by", "INTEGER NOT NULL DEFAULT 0"],
    ["wishes", "done_at", "INTEGER"],
    ["wishes", "url", "TEXT"],
    ["memories", "title", "TEXT"],
    ["tasks", "monthly", "INTEGER NOT NULL DEFAULT 0"],
    ["tasks", "yearly", "INTEGER NOT NULL DEFAULT 0"],
    ["dates", "monthly", "INTEGER NOT NULL DEFAULT 0"],
    ["dates", "kind", "TEXT NOT NULL DEFAULT 'date'"],
    ["movies", "rating_source", "TEXT"],
    ["movies", "rating_checked_at", "INTEGER"],
    ["movies", "details", "TEXT"],
    ["rate_limits", "expires_at", "INTEGER NOT NULL DEFAULT 0"]
  ]) {
    const info = await env.DB.prepare(`PRAGMA table_info(${table})`).all();
    if (!info.results.some(row => row.name === column)) {
      try {
        await env.DB.prepare(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`).run();
      } catch (alterError) {
        // Другой isolate мог добавить колонку между проверкой и ALTER.
        // Считаем шаг выполненным только если колонка действительно есть,
        // остальные ошибки миграции не глушим.
        const fresh = await env.DB.prepare(`PRAGMA table_info(${table})`).all();
        if (!fresh.results.some(row => row.name === column)) throw alterError;
      }
    }
  }
  await env.DB.batch([
    env.DB.prepare(`INSERT OR IGNORE INTO pair_members(tg_id,pair_id,role,joined_at)
      SELECT user_a,id,'a',created_at FROM pairs WHERE user_a!=0 AND EXISTS(SELECT 1 FROM users WHERE tg_id=pairs.user_a)`),
    env.DB.prepare(`INSERT OR IGNORE INTO pair_members(tg_id,pair_id,role,joined_at)
      SELECT user_b,id,'b',created_at FROM pairs WHERE user_b!=0 AND EXISTS(SELECT 1 FROM users WHERE tg_id=pairs.user_b)`)
  ]);
  await env.DB.prepare(
    "INSERT INTO app_meta(key, value) VALUES('schema_version', ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value"
  ).bind(DB_SCHEMA_VERSION).run();
}

async function setup(request, env, url) {
  const missing = ["BOT_TOKEN", "WEBHOOK_SECRET"].filter(key => !env[key]);
  if (missing.length) {
    return json({ error: `Cloudflare Worker не видит: ${missing.join(", ")}`, missing }, 503);
  }
  const ip = request.headers.get("cf-connecting-ip") || "unknown";
  // Лимит применяем до проверки секрета, чтобы неудачные попытки тоже учитывались.
  await rateLimit(env, `setup:${ip}`, 5, 600);
  const supplied = request.headers.get("x-setup-token") ||
    (request.headers.get("authorization") || "").replace(/^Bearer\s+/i, "");
  const expected = env.SETUP_TOKEN || env.BOT_TOKEN;
  if (!safeEqual(supplied, expected)) return json({ error: "Неверный секрет настройки" }, 403, { "www-authenticate": "Bearer" });
  const origin = request.headers.get("origin");
  if (origin && origin !== (env.APP_ORIGIN || url.origin)) return json({ error: "Origin не разрешён" }, 403);
  try {
    await ensureSchema(env);
  } catch (error) {
    console.error("D1 setup failed", error);
    return json({ error: "Не удалось обновить таблицы D1" }, 500);
  }
  const base = (env.APP_ORIGIN || url.origin).replace(/\/$/, "");
  // getMe заодно проверяет токен и возвращает has_main_web_app — признак
  // Main Mini App, которая задаётся вручную в @BotFather (кнопка «ОТКРЫТЬ»
  // в списке чатов появляется только после этого).
  let hasMainApp = false;
  try {
    await telegram(env, "setWebhook", {
      url: `${base}/telegram/webhook`,
      secret_token: env.WEBHOOK_SECRET,
      allowed_updates: ["message"],
      drop_pending_updates: false
    });
    const [, , me] = await Promise.all([
      telegram(env, "setMyCommands", { commands: [
        { command: "menu", description: "Наше пространство" },
        { command: "help", description: "Как работает DuoPlan" }
      ] }),
      telegram(env, "setChatMenuButton", { menu_button: { type: "web_app", text: "DuoPlan", web_app: { url: `${base}/app` } } }),
      telegram(env, "getMe", {})
    ]);
    hasMainApp = me?.has_main_web_app === true;
    await env.DB.prepare("INSERT INTO app_meta(key,value) VALUES('setup_version',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value")
      .bind(DB_SCHEMA_VERSION).run();
  } catch (error) {
    console.error("Telegram setup failed", error);
    return json({ error: "Таблицы готовы, но Telegram не ответил. Проверьте BOT_TOKEN." }, 502);
  }
  return json({ ok: true, webhook_url: `${base}/telegram/webhook`, mini_app_url: `${base}/app`, has_main_web_app: hasMainApp, version: APP_VERSION });
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    try {
      if (url.pathname === "/health") {
        let database = false;
        try {
          await env.DB.prepare("SELECT 1").first();
          database = true;
        } catch {}
        return json({
          ok: database,
          service: "duoplan",
          version: APP_VERSION,
          database,
        }, database ? 200 : 503);
      }
      if (url.pathname === "/api/setup" && request.method === "POST") return await setup(request, env, url);
      if (url.pathname.startsWith("/api/")) return await api(request, env, url, ctx);
      if (url.pathname === "/telegram/webhook" && request.method === "POST") return await webhook(request, env, url);
      return env.ASSETS.fetch(request);
    } catch (error) {
      // HttpError обрабатываем первыми, так как у них есть код и статус
      if (error instanceof HttpError) {
        const requestId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        console.error(`[DuoPlan HttpError] requestId=${requestId} code=${error.code}`, error);
        return json({ error: error.message, code: error.code, requestId }, error.status);
      }

      // Для остальных ошибок генерируем ID запроса для трассировки
      const requestId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

      // Безопасная диагностика: собираем информацию для логов, но не раскрываем секреты
      const errorInfo = {
        requestId,
        method: request.method,
        endpoint: url.pathname.startsWith("/api/") ? url.pathname : "assets",
        exception: error.constructor?.name || "Error",
        message: error.message || "Unknown error",
      };

      // Полный стек трейс пишем в консоль (internal logs), но не отправляем пользователю
      console.error(`[DuoPlan error] ${JSON.stringify(errorInfo)}`, error);

      // Пользовательское сообщение без стека/подробностей (скрываем initData, BOT_TOKEN и прочее)
      return json({ error: "Не получилось выполнить запрос. Попробуйте ещё раз.", code: "INTERNAL_ERROR", requestId }, 500);
    }
  },
  // Cron (wrangler.jsonc → triggers.crons): сводки и напоминания о планах.
  async scheduled(event, env) {
    await sendDigests(env);
  }
};
