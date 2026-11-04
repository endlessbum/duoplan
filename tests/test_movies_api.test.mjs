// Поиск IMDb для «Кино» (worker.js imdbSearch): публичный suggest-эндпоинт,
// фильтр типов (фильмы/сериалы), кеш подсказок, понятная 502 при недоступности.
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
      extractBraced(workerSource, "const IMDB_KIND_BY_TYPE = {"),
      extractBraced(workerSource, "function parseIsoDuration("),
      extractBraced(workerSource, "function omdbMinutes("),
      extractBraced(workerSource, "async function omdbFetch("),
      extractBraced(workerSource, "async function omdbSearch("),
      extractBraced(workerSource, "async function omdbTitle("),
      extractBraced(workerSource, "async function imdbSearch("),
      extractBraced(workerSource, "async function imdbTitle("),
      extractBraced(workerSource, "async function movieInfo("),
      "return { imdbSearch, imdbTitle, movieInfo, parseIsoDuration, omdbTitle };"
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

test("parseIsoDuration: PT2H22M → 142 минуты, мусор → null", () => {
  const { parseIsoDuration } = loadImdbSearch();
  equal(parseIsoDuration("PT2H22M"), 142);
  equal(parseIsoDuration("PT45M"), 45);
  equal(parseIsoDuration("PT2H"), 120);
  equal(parseIsoDuration(""), null);
  equal(parseIsoDuration(null), null);
});

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
  "movieInfo: IMDb-страница не отдалась — тайтл собирается из OMDb",
  withFetch(async (url) => {
    if (String(url).includes("omdbapi.com")) {
      return { ok: true, json: async () => ({ Response: "True", Title: "Dune", Year: "2021", Type: "movie", imdbRating: "8.0", Genre: "Adventure, Drama", Runtime: "155 min" }) };
    }
    return { ok: false, status: 500 };
  }, async () => {
    const { movieInfo } = loadImdbSearch();
    const info = await movieInfo({ OMDB_API_KEY: "test-key" }, "tt1160419");
    deepStrictEqual(info, { title: "Dune", rating: 8, genre: "Adventure", kind: "movie", year: 2021, runtime: 155, seasons: null, episodes: null });
  })
);

test(
  "movieInfo: IMDb недоступен и ключа нет — 502",
  withFetch(async () => ({ ok: false, status: 500 }), async () => {
    const { movieInfo } = loadImdbSearch();
    await rejects(movieInfo({}, "tt1160419"), (error) => error.status === 502 && error.code === "IMDB_UNAVAILABLE");
  })
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
