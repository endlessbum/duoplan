// Поиск IMDb для «Кино» (worker.js imdbSearch): публичный suggest-эндпоинт,
// фильтр типов (фильмы/сериалы), кеш подсказок, понятная 502 при недоступности.
// Локализация (tmdbLocalize): русские названия подсказок и карточек по tt-id
// через TMDB find — ключ TMDB_API_KEY, без него остаются английские.
// Карточка тайтла (movieInfo): основной источник — OMDb (ключ OMDB_API_KEY:
// рейтинг/жанр/длительность одним ответом), запасной — suggest-CDN по tt-id
// (скрейп www.imdb.com из воркера не работает: анти-бот 202 без тела).
//
// Функции извлекаются из worker.js как есть; fetch подменяется моком.
//
// Запуск: node tests/test_movies_api.test.mjs
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { deepStrictEqual, equal, ok, rejects } from "node:assert/strict";
import { test } from "node:test";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const workerSource = readFileSync(join(root, "worker.js"), "utf8");

function extractBraced(text, declaration) {
  const start = text.indexOf(declaration);
  if (start === -1) throw new Error(`${declaration} не найдено`);
  let depth = 0;
  for (let j = text.indexOf("{", start); j < text.length; j++) {
    if (text[j] === "{") depth++;
    else if (text[j] === "}") {
      depth--;
      if (depth === 0) return text.slice(start, j + 1);
    }
  }
  throw new Error(`незакрытый блок: ${declaration}`);
}

function extractLine(text, prefix) {
  const start = text.indexOf(prefix);
  if (start === -1) throw new Error(`${prefix} не найдено`);
  return text.slice(start, text.indexOf("\n", start));
}

function loadImdbSearch() {
  return new Function(
    [
      'class HttpError extends Error { constructor(status, message, code) { super(message); this.status = status; this.code = code; } }',
      extractLine(workerSource, "const IMDB_UA = "),
      extractLine(workerSource, "const IMDB_TIMEOUT_MS = "),
      extractLine(workerSource, "const IMDB_SUGGEST_TTL_MS"),
      extractLine(workerSource, "const imdbSuggestCache = new Map();"),
      extractLine(workerSource, "const TMDB_RU_TTL_MS"),
      extractLine(workerSource, "const TMDB_GENRE_TTL_MS"),
      extractLine(workerSource, "const tmdbRuCache = new Map();"),
      extractLine(workerSource, "const tmdbGenreCache = new Map();"),
      extractBraced(workerSource, "const IMDB_KIND_BY_TYPE = {"),
      extractBraced(workerSource, "function omdbMinutes("),
      extractBraced(workerSource, "async function omdbFetch("),
      extractBraced(workerSource, "async function omdbSearch("),
      extractBraced(workerSource, "async function omdbTitle("),
      extractBraced(workerSource, "async function tmdbFetch("),
      extractBraced(workerSource, "async function tmdbLocalize("),
      extractBraced(workerSource, "async function tmdbGenreName("),
      extractBraced(workerSource, "async function localizeResults("),
      extractBraced(workerSource, "async function imdbSearch("),
      extractBraced(workerSource, "async function imdbSuggestTitle("),
      extractBraced(workerSource, "function suggestKind("),
      extractBraced(workerSource, "async function movieInfo("),
      "return { imdbSearch, imdbSuggestTitle, movieInfo, omdbTitle, suggestKind, tmdbLocalize };"
    ].join("\n")
  )();
}

const suggestPayload = {
  d: [
    { id: "tt15398776", l: "Oppenheimer", q: "feature", y: 2023 },
    { id: "tt1520211", l: "The Walking Dead", q: "TV series", y: 2010 },
    { id: "tt0944947", l: "Game of Thrones", q: "TV mini series", y: 2011 },
    { id: "tt9999999", l: "Some Video Game", q: "video game", y: 2020 },
    { id: "nm0000001", l: "Not a title", q: "feature" }
  ]
};

function withFetch(stub, fn) {
  return async () => {
    const real = globalThis.fetch;
    globalThis.fetch = stub;
    try {
      await fn();
    } finally {
      globalThis.fetch = real;
    }
  };
}

test(
  "imdbSearch: только фильмы и сериалы с tt-ID, тип нормализуется",
  withFetch(async () => ({ ok: true, json: async () => suggestPayload }), async () => {
    const { imdbSearch } = loadImdbSearch();
    const results = await imdbSearch("оппенгеймер");
    deepStrictEqual(results, [
      { imdb_id: "tt15398776", title: "Oppenheimer", year: 2023, kind: "movie" },
      { imdb_id: "tt1520211", title: "The Walking Dead", year: 2010, kind: "series" },
      { imdb_id: "tt0944947", title: "Game of Thrones", year: 2011, kind: "series" }
    ]);
  })
);

test(
  "imdbSearch: пустой запрос — 400, недоступность IMDb — 502",
  withFetch(async () => ({ ok: false, status: 503 }), async () => {
    const { imdbSearch } = loadImdbSearch();
    await rejects(imdbSearch("   "), (error) => error.status === 400 && error.code === "INVALID_QUERY");
    await rejects(imdbSearch("дюна"), (error) => error.status === 502 && error.code === "IMDB_UNAVAILABLE");
  })
);

test(
  "imdbSearch: кеш не бьёт повторно в IMDb, лимит 8 результатов",
  withFetch(async () => ({ ok: true, json: async () => suggestPayload }), async () => {
    const { imdbSearch } = loadImdbSearch();
    let calls = 0;
    const real = globalThis.fetch;
    globalThis.fetch = async (...args) => {
      calls++;
      return real(...args);
    };
    try {
      await imdbSearch("тестовый запрос");
      await imdbSearch("Тестовый запрос"); // регистр не важен — тот же кеш
      equal(calls, 1, "второй запрос должен уйти в кеш");
    } finally {
      globalThis.fetch = real;
    }
  })
);

test("suggestKind: qid каноничен, q-человеческий тип как фолбэк", () => {
  const { suggestKind } = loadImdbSearch();
  equal(suggestKind({ qid: "tvSeries", q: "TV series" }), "series");
  equal(suggestKind({ qid: "tvMiniSeries", q: "TV mini series" }), "series");
  equal(suggestKind({ qid: "movie", q: "feature" }), "movie");
  equal(suggestKind({ q: "TV series" }), "series", "без qid — по q");
  equal(suggestKind({ qid: "short", q: "short" }), "movie", "неизвестный тип — фильм");
});

test("imdbSuggestTitle: базовые поля из suggest, рейтинг/жанр — null", async () => {
  const { imdbSuggestTitle } = loadImdbSearch();
  const real = globalThis.fetch;
  globalThis.fetch = async () => ({
    ok: true,
    json: async () => ({ d: [{ id: "tt0944947", l: "Game of Thrones", q: "TV series", qid: "tvSeries", y: 2011 }] })
  });
  try {
    deepStrictEqual(await imdbSuggestTitle("tt0944947"), {
      title: "Game of Thrones", rating: null, genre: null, kind: "series", year: 2011,
      runtime: null, seasons: null, episodes: null
    });
  } finally {
    globalThis.fetch = real;
  }
});

test("imdbSuggestTitle: тайтла нет в ответе — null", async () => {
  const { imdbSuggestTitle } = loadImdbSearch();
  const real = globalThis.fetch;
  globalThis.fetch = async () => ({ ok: true, json: async () => ({ d: [] }) });
  try {
    equal(await imdbSuggestTitle("tt0000001"), null);
  } finally {
    globalThis.fetch = real;
  }
});

test(
  "movieInfo: OMDb основной — тайтл целиком из OMDb, suggest не вызывается",
  withFetch(async (url) => {
    if (String(url).includes("omdbapi.com")) {
      return { ok: true, json: async () => ({ Response: "True", Title: "Dune", Year: "2021", Type: "movie", imdbRating: "8.0", Genre: "Adventure, Drama", Runtime: "155 min" }) };
    }
    throw new Error("suggest не должен вызываться, когда OMDb ответил");
  }, async () => {
    const { movieInfo } = loadImdbSearch();
    const info = await movieInfo({ OMDB_API_KEY: "test-key" }, "tt1160419");
    deepStrictEqual(info, { title: "Dune", rating: 8, genre: "Adventure", kind: "movie", year: 2021, runtime: 155, seasons: null, episodes: null });
  })
);

test(
  "movieInfo: с TMDB-ключом название и жанр карточки на русском",
  withFetch(async (url) => {
    url = String(url);
    if (url.includes("omdbapi.com")) {
      return { ok: true, json: async () => ({ Response: "True", Title: "Dune", Year: "2021", Type: "movie", imdbRating: "8.0", Genre: "Adventure, Drama", Runtime: "155 min" }) };
    }
    if (url.includes("themoviedb.org/3/find/tt1160419")) {
      return { ok: true, json: async () => ({ movie_results: [{ title: "Дюна", genre_ids: [878, 12] }], tv_results: [] }) };
    }
    if (url.includes("themoviedb.org/3/genre/movie/list")) {
      return { ok: true, json: async () => ({ genres: [{ id: 878, name: "Фантастика" }, { id: 12, name: "Приключения" }] }) };
    }
    throw new Error("неожиданный запрос: " + url);
  }, async () => {
    const { movieInfo } = loadImdbSearch();
    const info = await movieInfo({ OMDB_API_KEY: "k", TMDB_API_KEY: "k" }, "tt1160419");
    deepStrictEqual(info, { title: "Дюна", rating: 8, genre: "Фантастика", kind: "movie", year: 2021, runtime: 155, seasons: null, episodes: null });
  })
);

test(
  "movieInfo: без OMDb-ключа фильм добавляется на данных suggest (пилюля «IMDb —»)",
  withFetch(async (url) => {
    if (String(url).includes("omdbapi.com")) throw new Error("omdb не должен вызываться без ключа");
    return {
      ok: true,
      json: async () => ({ d: [{ id: "tt1160419", l: "Dune", q: "feature", qid: "movie", y: 2021 }] })
    };
  }, async () => {
    const { movieInfo } = loadImdbSearch();
    deepStrictEqual(await movieInfo({}, "tt1160419"), {
      title: "Dune", rating: null, genre: null, kind: "movie", year: 2021, runtime: null, seasons: null, episodes: null
    });
  })
);

test(
  "movieInfo: OMDb не ответил (с ключом) — тайтл собирается из suggest",
  withFetch(async (url) => {
    if (String(url).includes("omdbapi.com")) return { ok: false, status: 500 };
    return {
      ok: true,
      json: async () => ({ d: [{ id: "tt1160419", l: "Dune", q: "feature", qid: "movie", y: 2021 }] })
    };
  }, async () => {
    const { movieInfo } = loadImdbSearch();
    deepStrictEqual(await movieInfo({ OMDB_API_KEY: "test-key" }, "tt1160419"), {
      title: "Dune", rating: null, genre: null, kind: "movie", year: 2021, runtime: null, seasons: null, episodes: null
    });
  })
);

test(
  "movieInfo: OMDb и suggest не ответили — 502",
  withFetch(async () => ({ ok: false, status: 500 }), async () => {
    const { movieInfo } = loadImdbSearch();
    await rejects(movieInfo({ OMDB_API_KEY: "test-key" }, "tt1160419"), (error) => error.status === 502 && error.code === "IMDB_UNAVAILABLE");
  })
);

test(
  "imdbSearch: IMDb лежит — фолбэк на OMDb при заданном ключе",
  withFetch(async (url) => {
    if (String(url).includes("sg.media-imdb.com")) throw new Error("imdb down");
    return { ok: true, json: async () => ({ Response: "True", Search: [
      { imdbID: "tt1160419", Title: "Dune", Year: "2021", Type: "movie" },
      { imdbID: "nm0000129", Title: "Не тайтл", Type: "movie" }
    ] }) };
  }, async () => {
    const { imdbSearch } = loadImdbSearch();
    const results = await imdbSearch("дюна", { OMDB_API_KEY: "test-key" });
    deepStrictEqual(results, [{ imdb_id: "tt1160419", title: "Dune", year: 2021, kind: "movie" }]);
  })
);

test(
  "imdbSearch: без OMDb-ключа фолбэк не активируется — исходная 502",
  withFetch(async () => { throw new Error("imdb down"); }, async () => {
    const { imdbSearch } = loadImdbSearch();
    await rejects(imdbSearch("дюна"), (error) => error.status === 502 && error.code === "IMDB_UNAVAILABLE");
  })
);

test(
  "imdbSearch: с TMDB-ключом подсказки на русском, без ключа — английские",
  withFetch(async (url) => {
    url = String(url);
    if (url.includes("themoviedb.org/3/find/tt15398776")) {
      return { ok: true, json: async () => ({ movie_results: [{ title: "Оппенгеймер", genre_ids: [18] }], tv_results: [] }) };
    }
    if (url.includes("themoviedb.org/3/find/tt1520211")) {
      return { ok: true, json: async () => ({ movie_results: [], tv_results: [{ name: "Ходячие мертвецы", genre_ids: [18] }] }) };
    }
    return { ok: true, json: async () => suggestPayload };
  }, async () => {
    const { imdbSearch } = loadImdbSearch();
    const ru = await imdbSearch("тест", { TMDB_API_KEY: "test-key" });
    equal(ru[0].title, "Оппенгеймер", "фильм локализован через movie_results");
    equal(ru[1].title, "Ходячие мертвецы", "сериал локализован через tv_results");
    equal(ru[1].imdb_id, "tt1520211", "остальные поля не тронуты");
    const en = await imdbSearch("другой запрос");
    equal(en[0].title, "Oppenheimer", "без ключа — английское название");
  })
);

test(
  "tmdbLocalize: «не нашли» кешируется — второй вызов без запроса в TMDB",
  async () => {
    let calls = 0;
    const real = globalThis.fetch;
    globalThis.fetch = async () => {
      calls++;
      return { ok: true, json: async () => ({ movie_results: [], tv_results: [] }) };
    };
    try {
      const { tmdbLocalize } = loadImdbSearch();
      equal(await tmdbLocalize({ TMDB_API_KEY: "k" }, "tt0000002"), null);
      equal(await tmdbLocalize({ TMDB_API_KEY: "k" }, "tt0000002"), null);
      equal(calls, 1, "пустой результат должен кешироваться");
    } finally {
      globalThis.fetch = real;
    }
  }
);

test("маршруты movies зарегистрированы в воркере (itemRoute + коллекция)", () => {
  ok(workerSource.includes("places|movies|savings)"), "movies нет в itemRoute regex");
  ok(workerSource.includes('"/api/movies/search"'), "нет маршрута поиска");
  ok(workerSource.includes('"UPDATE movies SET watched=1'), "нет действия watched");
  ok(workerSource.includes('"UPDATE movies SET watched=0'), "нет действия unwatched");
  ok(workerSource.includes('movies: "movies"'), "movies нет в таблице itemRoute");
  // Фолбэк: POST обогащается через movieInfo (с OMDb внутри), ключ — секрет.
  ok(workerSource.includes("await movieInfo(env, imdbId)"), "POST не использует movieInfo с фолбэком");
  ok(workerSource.includes("OMDB_API_KEY"), "нет секрета OMDB_API_KEY");
});

test("уникальный индекс кино создаётся после очистки дублей", () => {
  // Без DELETE CREATE UNIQUE INDEX упал бы на базе с дублями (гонка до 0019),
  // и весь batch ensureSchema / миграция не применились бы.
  const dedupe = workerSource.indexOf("DELETE FROM movies WHERE id NOT IN");
  const index = workerSource.indexOf("CREATE UNIQUE INDEX IF NOT EXISTS idx_movies_pair_imdb");
  ok(dedupe !== -1, "ensureSchema: нет очистки дублей перед уникальным индексом");
  ok(index !== -1 && dedupe < index, "ensureSchema: очистка дублей должна идти до индекса");
  const migration = readFileSync(join(root, "migrations", "0019_movies_unique.sql"), "utf8");
  const migrationIndex = migration.indexOf("CREATE UNIQUE INDEX IF NOT EXISTS idx_movies_pair_imdb");
  ok(migration.indexOf("DELETE FROM movies") !== -1, "0019: нет очистки дублей");
  ok(migrationIndex !== -1 && migration.indexOf("DELETE FROM movies") < migrationIndex, "0019: очистка дублей должна идти до индекса");
});
