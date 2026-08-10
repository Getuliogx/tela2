"use strict";

const http = require("http");
const tls = require("tls");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const PORT = Number(process.env.PORT || 10000);
const TWITCH_CHANNEL = String(
  process.env.TWITCH_CHANNEL || "icarolinaporto"
).trim().replace(/^#/, "").toLowerCase();

const ADMIN_PASSWORD = String(process.env.ADMIN_PASSWORD || "").trim();
const TMDB_BEARER = String(
  process.env.TMDB_BEARER ||
  "eyJhbGciOiJIUzI1NiJ9.eyJhdWQiOiJiMDk1Y2NiYmIxODVkMjc3MDNkMDA3YWUwZGVkNWY3ZCIsIm5iZiI6MTc3NjYxMTUzMS4yNTQwMDAyLCJzdWIiOiI2OWU0ZjBjYmE2ZjVkMTQyYzc0YjMyYzkiLCJzY29wZXMiOlsiYXBpX3JlYWQiXSwidmVyc2lvbiI6MX0.F0r1SSOo4SeBFIWtOzE6mkYNjXTZgVRdrVCT0qDPVYA"
).trim();
const TMDB_API_KEY = String(
  process.env.TMDB_API_KEY || "b095ccbbb185d27703d007ae0ded5f7d"
).trim();

const STATE_FILE = path.join(__dirname, "state.json");
const SAVED_FILE = path.join(__dirname, "saved.json");
const PROGRESS_FILE = path.join(__dirname, "series-progress.json");
const UPNEXT_FILE = path.join(__dirname, "upnext.json");

let currentState = loadState();
let savedItems = loadSavedItems();
let seriesProgress = loadSeriesProgress();
let upNext = loadUpNext();
let ircSocket = null;
let ircBuffer = "";
let ircNickname = "";
let twitchJoined = false;
let reconnectTimer = null;
let reconnectAttempt = 0;
let lastChatAt = null;
let lastCommand = null;
let lastError = null;
const sseClients = new Set();
const seasonCache = new Map();

function loadJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return fallback;
  }
}

function writeJson(file, value) {
  try {
    fs.writeFileSync(file, JSON.stringify(value, null, 2), "utf8");
  } catch (error) {
    lastError = error.message;
    console.error("[arquivo]", error.message);
  }
}

function validState(value) {
  return Boolean(
    value &&
    typeof value === "object" &&
    value.title &&
    value.typeLabel &&
    (value.type === "movie" || value.type === "tv")
  );
}

function loadState() {
  const value = loadJson(STATE_FILE, null);
  return validState(value) ? value : null;
}

function loadSavedItems() {
  const value = loadJson(SAVED_FILE, []);
  return Array.isArray(value) ? value.filter(validMediaItem).slice(0, 200) : [];
}

function loadSeriesProgress() {
  const value = loadJson(PROGRESS_FILE, {});

  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }

  const cleaned = {};

  for (const [key, progress] of Object.entries(value)) {
    const episode = Math.max(1, Math.floor(Number(progress?.episode || 0)));
    const season = Math.max(1, Math.floor(Number(progress?.season || 0)));

    if (
      /^tv:\d+$/.test(key) &&
      episode >= 1 &&
      season >= 1
    ) {
      cleaned[key] = {
        episode,
        season,
        episodeCount: Math.max(
          episode,
          Math.floor(Number(progress.episodeCount || 0))
        ),
        title: String(progress.title || ""),
        year: String(progress.year || ""),
        poster: String(progress.poster || ""),
        updatedAt: String(progress.updatedAt || "")
      };
    }
  }

  return cleaned;
}

function cleanUpNextLabel(value) {
  return String(value || "")
    .replace(/[<>\r\n]/g, "")
    .trim()
    .slice(0, 40) || "Próximo";
}

function defaultUpNext() {
  const now = Date.now();

  return {
    enabled: true,
    label: "Próximo",
    intervalMinutes: 50,
    displaySeconds: 10,
    items: [],
    anchorAt: now,
    triggerAt: 0,
    revision: now
  };
}

function upNextItemKey(item) {
  return item &&
    (item.type === "movie" || item.type === "tv") &&
    Number(item.tmdbId) > 0
      ? `${item.type}:${Number(item.tmdbId)}`
      : "";
}

function cleanUpNextItem(item) {
  if (!validMediaItem(item)) {
    return null;
  }

  return {
    type: item.type,
    tmdbId: Number(item.tmdbId),
    title: String(item.title || ""),
    originalTitle: String(item.originalTitle || ""),
    year: String(item.year || ""),
    typeLabel: String(
      item.typeLabel ||
      (item.type === "tv" ? "Série" : "Filme")
    ),
    poster: String(item.poster || ""),
    seriesPoster: String(item.seriesPoster || ""),
    overview: String(item.overview || ""),
    selectedSeason: Number(item.selectedSeason || item.savedSeason || 0) || null,
    selectedEpisode: Number(item.selectedEpisode || item.savedEpisode || 0) || null,
    savedSeason: Number(item.savedSeason || item.selectedSeason || 0) || null,
    savedEpisode: Number(item.savedEpisode || item.selectedEpisode || 0) || null,
    episodeCount: Number(item.episodeCount || 0) || 0,
    showSeason: item.showSeason !== false,
    seasons: Array.isArray(item.seasons) ? item.seasons : []
  };
}

function sanitizeUpNext(value) {
  const fallback = defaultUpNext();
  const source =
    value && typeof value === "object" && !Array.isArray(value)
      ? value
      : {};

  const items = Array.isArray(source.items)
    ? source.items
        .map(cleanUpNextItem)
        .filter(Boolean)
        .slice(0, 50)
    : [];

  return {
    enabled: source.enabled !== false,
    label: cleanUpNextLabel(source.label || fallback.label),
    intervalMinutes: Math.max(
      1,
      Math.min(1440, Number(source.intervalMinutes || fallback.intervalMinutes))
    ),
    displaySeconds: Math.max(
      1,
      Math.min(300, Number(source.displaySeconds || fallback.displaySeconds))
    ),
    items,
    anchorAt:
      Number(source.anchorAt) > 0
        ? Number(source.anchorAt)
        : fallback.anchorAt,
    triggerAt: Math.max(0, Number(source.triggerAt || 0)),
    revision:
      Number(source.revision) > 0
        ? Number(source.revision)
        : fallback.revision
  };
}

function loadUpNext() {
  return sanitizeUpNext(
    loadJson(UPNEXT_FILE, defaultUpNext())
  );
}

function saveUpNext() {
  upNext = sanitizeUpNext(upNext);
  writeJson(UPNEXT_FILE, upNext);
  return upNext;
}

function touchUpNext(resetTimer = false) {
  const now = Date.now();

  upNext.revision = now;

  if (resetTimer) {
    upNext.anchorAt = now;
  }

  saveUpNext();
  broadcastUpNext();

  return upNext;
}

function validMediaItem(value) {
  return Boolean(
    value &&
    typeof value === "object" &&
    value.tmdbId &&
    value.title &&
    (value.type === "movie" || value.type === "tv")
  );
}

function saveState() {
  writeJson(STATE_FILE, currentState);
}

function saveSavedItems() {
  writeJson(SAVED_FILE, savedItems);
}

function saveSeriesProgress() {
  writeJson(PROGRESS_FILE, seriesProgress);
}

function seriesProgressKey(item) {
  if (!item || item.type !== "tv") {
    return "";
  }

  const tmdbId = Number(item.tmdbId);

  return Number.isFinite(tmdbId) && tmdbId > 0
    ? `tv:${tmdbId}`
    : "";
}

function getSeriesProgress(item) {
  const key = seriesProgressKey(item);
  const progress = key ? seriesProgress[key] : null;

  if (
    !progress ||
    Number(progress.episode) < 1 ||
    Number(progress.season) < 1
  ) {
    return null;
  }

  return {
    episode: Math.floor(Number(progress.episode)),
    season: Math.floor(Number(progress.season)),
    episodeCount: Math.max(
      Math.floor(Number(progress.episode)),
      Math.floor(Number(progress.episodeCount || 0))
    ),
    poster: String(progress.poster || ""),
    suffix: `EP${Math.floor(Number(progress.episode))} - T${Math.floor(Number(progress.season))}`
  };
}

function rememberSeriesProgress(item, episode, season) {
  const key = seriesProgressKey(item);

  if (!key) {
    return null;
  }

  const normalizedEpisode = Math.max(
    1,
    Math.floor(Number(episode) || 1)
  );

  const normalizedSeason = Math.max(
    1,
    Math.floor(Number(season) || 1)
  );

  seriesProgress[key] = {
    episode: normalizedEpisode,
    season: normalizedSeason,
    episodeCount: Math.max(
      normalizedEpisode,
      Math.floor(Number(item.episodeCount || 0))
    ),
    title: String(item.baseTitle || item.title || ""),
    year: String(item.year || ""),
    poster: String(item.poster || ""),
    updatedAt: new Date().toISOString()
  };

  saveSeriesProgress();

  return getSeriesProgress(item);
}

function decorateWithSeriesProgress(item) {
  if (!item || item.type !== "tv") {
    return item;
  }

  const progress = getSeriesProgress(item);
  const saved = savedItems.find(entry => (
    entry.type === "tv" &&
    Number(entry.tmdbId) === Number(item.tmdbId)
  ));

  const showSeason =
    typeof item.showSeason === "boolean"
      ? item.showSeason
      : typeof saved?.showSeason === "boolean"
        ? saved.showSeason
        : true;

  if (!progress) {
    return {
      ...item,
      showSeason
    };
  }

  return {
    ...item,
    showSeason,
    poster: progress.poster || item.poster,
    selectedEpisode: progress.episode,
    selectedSeason: progress.season,
    episodeCount: progress.episodeCount || item.episodeCount || 0,
    savedEpisode: progress.episode,
    savedSeason: progress.season,
    savedSuffix: progress.suffix
  };
}

function commonHeaders(contentType = "application/json; charset=utf-8") {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, X-Admin-Password",
    "Cache-Control": "no-store, no-cache, must-revalidate",
    "Content-Type": contentType
  };
}

function sendText(response, statusCode, text, contentType = "text/plain; charset=utf-8") {
  const body = String(text);
  response.writeHead(statusCode, {
    ...commonHeaders(contentType),
    "Content-Length": Buffer.byteLength(body)
  });
  response.end(body);
}

function sendJson(response, statusCode, value) {
  sendText(
    response,
    statusCode,
    JSON.stringify(value),
    "application/json; charset=utf-8"
  );
}

function readJson(request) {
  return new Promise((resolve, reject) => {
    let body = "";
    request.setEncoding("utf8");
    request.on("data", chunk => {
      body += chunk;
      if (body.length > 200000) {
        reject(new Error("Dados muito grandes"));
        request.destroy();
      }
    });
    request.on("end", () => {
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch {
        reject(new Error("JSON inválido"));
      }
    });
    request.on("error", reject);
  });
}

function safeEqual(left, right) {
  const a = Buffer.from(String(left));
  const b = Buffer.from(String(right));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function adminAuthorized(request) {
  if (!ADMIN_PASSWORD) return true;
  return safeEqual(request.headers["x-admin-password"] || "", ADMIN_PASSWORD);
}

function requireAdmin(request, response) {
  if (adminAuthorized(request)) return true;
  sendJson(response, 401, {
    ok: false,
    error: "Senha do painel incorreta"
  });
  return false;
}

function sendSse(response, eventName, value) {
  response.write(`event: ${eventName}\n`);
  response.write(`data: ${JSON.stringify(value)}\n\n`);
}

function broadcastState() {
  for (const response of [...sseClients]) {
    try {
      sendSse(response, "state", currentState);
    } catch {
      sseClients.delete(response);
    }
  }
}

function broadcastUpNext() {
  for (const response of [...sseClients]) {
    try {
      sendSse(response, "upnext", upNext);
    } catch {
      sseClients.delete(response);
    }
  }
}

function firstYear(value) {
  return typeof value === "string" && value.length >= 4
    ? value.slice(0, 4)
    : "";
}

function normalize(value) {
  return String(value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLocaleLowerCase("pt-BR")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()
    .replace(/\s+/g, " ");
}

function titleOf(item, type) {
  return type === "tv" ? item.name : item.title;
}

function originalTitleOf(item, type) {
  return type === "tv" ? item.original_name : item.original_title;
}

function yearOf(item, type) {
  return firstYear(type === "tv" ? item.first_air_date : item.release_date);
}

function typeLabel(type) {
  return type === "tv" ? "Série" : "Filme";
}

function escapeXml(value) {
  return String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function placeholderPoster(title, type) {
  const safeTitle = escapeXml(String(title || "Sem capa").slice(0, 42));
  const safeType = type === "tv" ? "SÉRIE" : "FILME";
  const svg = [
    '<svg xmlns="http://www.w3.org/2000/svg" width="342" height="513" viewBox="0 0 342 513">',
    '<defs>',
    '<linearGradient id="g" x1="0" y1="0" x2="1" y2="1">',
    '<stop offset="0" stop-color="#2a1740"/>',
    '<stop offset="1" stop-color="#0b0b10"/>',
    '</linearGradient>',
    '</defs>',
    '<rect width="342" height="513" rx="20" fill="url(#g)"/>',
    '<rect x="18" y="18" width="306" height="477" rx="16" fill="none" stroke="#a855f7" stroke-opacity=".55" stroke-width="2"/>',
    '<text x="171" y="220" text-anchor="middle" fill="#a855f7" font-size="23" font-family="Arial, sans-serif" font-weight="700">',
    safeType,
    '</text>',
    '<foreignObject x="34" y="250" width="274" height="150">',
    '<div xmlns="http://www.w3.org/1999/xhtml" style="color:#fff;font:700 28px Arial,sans-serif;text-align:center;line-height:1.15;word-break:break-word;">',
    safeTitle,
    '</div>',
    '</foreignObject>',
    '</svg>'
  ].join("");

  return `data:image/svg+xml;charset=UTF-8,${encodeURIComponent(svg)}`;
}

function imageUrl(pathValue, size = "w342") {
  return pathValue
    ? `https://image.tmdb.org/t/p/${size}${pathValue}`
    : "";
}

function mediaFromTmdb(item, type, resolvedPoster = "") {
  const title = titleOf(item, type) || originalTitleOf(item, type) || "Sem título";

  return {
    tmdbId: Number(item.id),
    type,
    title,
    originalTitle: originalTitleOf(item, type) || "",
    year: yearOf(item, type),
    typeLabel: typeLabel(type),
    poster:
      resolvedPoster ||
      imageUrl(item.poster_path, "w342") ||
      imageUrl(item.backdrop_path, "w500") ||
      placeholderPoster(title, type),
    overview: String(item.overview || "").trim()
  };
}

function tmdbRequestHeaders() {
  const headers = { accept: "application/json" };

  if (TMDB_BEARER) {
    headers.Authorization = `Bearer ${TMDB_BEARER}`;
  }

  return headers;
}

async function fetchTmdbJson(url) {
  if (TMDB_API_KEY && !url.searchParams.has("api_key")) {
    url.searchParams.set("api_key", TMDB_API_KEY);
  }

  const response = await fetch(url, {
    headers: tmdbRequestHeaders(),
    signal: AbortSignal.timeout(15000)
  });

  if (!response.ok) {
    throw new Error(`TMDB respondeu ${response.status}`);
  }

  return response.json();
}

function bestImage(images) {
  return [...images]
    .filter(image => image && image.file_path)
    .sort((left, right) => {
      const leftScore =
        Number(left.vote_average || 0) * 10 +
        Math.min(Number(left.vote_count || 0), 100) +
        Math.min(Number(left.width || 0), 2000) / 1000;

      const rightScore =
        Number(right.vote_average || 0) * 10 +
        Math.min(Number(right.vote_count || 0), 100) +
        Math.min(Number(right.width || 0), 2000) / 1000;

      return rightScore - leftScore;
    })[0] || null;
}

async function resolvePoster(item, type) {
  const directPoster = imageUrl(item.poster_path, "w342");

  if (directPoster) {
    return directPoster;
  }

  try {
    const url = new URL(
      `https://api.themoviedb.org/3/${type}/${Number(item.id)}/images`
    );

    url.searchParams.set("include_image_language", "pt,en,null");

    const images = await fetchTmdbJson(url);
    const poster = bestImage(Array.isArray(images.posters) ? images.posters : []);

    if (poster) {
      return imageUrl(poster.file_path, "w342");
    }

    const backdrop = bestImage(
      Array.isArray(images.backdrops) ? images.backdrops : []
    );

    if (backdrop) {
      return imageUrl(backdrop.file_path, "w500");
    }
  } catch (error) {
    console.error(`[capa] ${type}:${item.id} - ${error.message}`);
  }

  return (
    imageUrl(item.backdrop_path, "w500") ||
    placeholderPoster(
      titleOf(item, type) || originalTitleOf(item, type) || "Sem capa",
      type
    )
  );
}

async function hydrateMediaItem(item) {
  if (!validMediaItem(item)) {
    return item;
  }

  if (String(item.poster || "").trim()) {
    return item;
  }

  const tmdbItem = {
    id: Number(item.tmdbId),
    title: item.type === "movie" ? item.title : undefined,
    name: item.type === "tv" ? item.title : undefined,
    original_title: item.type === "movie" ? item.originalTitle : undefined,
    original_name: item.type === "tv" ? item.originalTitle : undefined,
    release_date: item.type === "movie" && item.year ? `${item.year}-01-01` : "",
    first_air_date: item.type === "tv" && item.year ? `${item.year}-01-01` : "",
    poster_path: "",
    backdrop_path: ""
  };

  return {
    ...item,
    poster: await resolvePoster(tmdbItem, item.type)
  };
}

async function mapLimit(items, limit, mapper) {
  const results = new Array(items.length);
  let nextIndex = 0;

  async function worker() {
    while (true) {
      const index = nextIndex;
      nextIndex += 1;

      if (index >= items.length) {
        return;
      }

      results[index] = await mapper(items[index], index);
    }
  }

  await Promise.all(
    Array.from(
      { length: Math.min(limit, items.length) },
      () => worker()
    )
  );

  return results;
}

function normalizeSeasonList(value, fallbackPoster = "") {
  const source = Array.isArray(value) ? value : [];

  return source
    .map(season => {
      const seasonNumber = Math.floor(
        Number(
          season.seasonNumber ??
          season.season_number
        )
      );

      const episodeCount = Math.max(
        0,
        Math.floor(
          Number(
            season.episodeCount ??
            season.episode_count ??
            0
          )
        )
      );

      const rawPoster =
        season.poster ||
        season.poster_path ||
        "";

      return {
        seasonNumber,
        name:
          String(season.name || "").trim() ||
          `Temporada ${seasonNumber}`,
        episodeCount,
        poster:
          String(rawPoster).startsWith("http") ||
          String(rawPoster).startsWith("data:")
            ? String(rawPoster)
            : imageUrl(rawPoster, "w342") || fallbackPoster
      };
    })
    .filter(season => (
      Number.isFinite(season.seasonNumber) &&
      season.seasonNumber >= 1
    ))
    .sort((left, right) => (
      left.seasonNumber - right.seasonNumber
    ));
}

async function fetchSeriesDetails(tmdbId) {
  const id = Number(tmdbId);

  if (!Number.isFinite(id) || id < 1) {
    throw new Error("ID da série inválido");
  }

  if (process.env.TMDB_MOCK === "1") {
    return {
      id,
      poster_path: "",
      seasons: [1, 2, 3, 4].map(number => ({
        season_number: number,
        name: `Temporada ${number}`,
        episode_count: 8 + number,
        poster_path: ""
      }))
    };
  }

  const url = new URL(
    `https://api.themoviedb.org/3/tv/${id}`
  );

  url.searchParams.set("language", "pt-BR");

  return fetchTmdbJson(url);
}

async function fetchSeasonDetails(
  tmdbId,
  seasonNumber,
  fallbackItem = {}
) {
  const id = Number(tmdbId);
  const season = Math.max(
    1,
    Math.floor(Number(seasonNumber) || 1)
  );
  const cacheKey = `${id}:${season}`;

  if (seasonCache.has(cacheKey)) {
    return seasonCache.get(cacheKey);
  }

  if (process.env.TMDB_MOCK === "1") {
    const result = {
      seasonNumber: season,
      name: `Temporada ${season}`,
      episodeCount: 8 + season,
      poster: placeholderPoster(
        `${fallbackItem.title || "Série"} — Temporada ${season}`,
        "tv"
      )
    };

    seasonCache.set(cacheKey, result);
    return result;
  }

  const url = new URL(
    `https://api.themoviedb.org/3/tv/${id}/season/${season}`
  );

  url.searchParams.set("language", "pt-BR");
  url.searchParams.set("append_to_response", "images");

  const details = await fetchTmdbJson(url);

  let poster =
    imageUrl(details.poster_path, "w342") ||
    "";

  if (!poster) {
    const appendedPosters =
      details.images &&
      Array.isArray(details.images.posters)
        ? details.images.posters
        : [];

    const appendedPoster = bestImage(appendedPosters);

    if (appendedPoster) {
      poster = imageUrl(
        appendedPoster.file_path,
        "w342"
      );
    }
  }

  if (!poster) {
    try {
      const imagesUrl = new URL(
        `https://api.themoviedb.org/3/tv/${id}/season/${season}/images`
      );

      imagesUrl.searchParams.set(
        "include_image_language",
        "pt,en,null"
      );

      const images = await fetchTmdbJson(imagesUrl);
      const image = bestImage(
        Array.isArray(images.posters)
          ? images.posters
          : []
      );

      if (image) {
        poster = imageUrl(image.file_path, "w342");
      }
    } catch (error) {
      console.error(
        `[capa-temporada] tv:${id}:T${season} - ${error.message}`
      );
    }
  }

  const fallbackPoster =
    String(fallbackItem.seriesPoster || "") ||
    String(fallbackItem.poster || "") ||
    placeholderPoster(
      `${fallbackItem.title || "Série"} — Temporada ${season}`,
      "tv"
    );

  const result = {
    seasonNumber: season,
    name:
      String(details.name || "").trim() ||
      `Temporada ${season}`,
    episodeCount: Math.max(
      1,
      Array.isArray(details.episodes)
        ? details.episodes.length
        : Number(details.episode_count || 0)
    ),
    poster: poster || fallbackPoster
  };

  seasonCache.set(cacheKey, result);
  return result;
}

async function enrichSeriesItem(item) {
  if (!validMediaItem(item) || item.type !== "tv") {
    return item;
  }

  const progress = getSeriesProgress(item);
  const existingSeriesPoster =
    String(item.seriesPoster || "") ||
    String(item.poster || "");

  let seasons = normalizeSeasonList(
    item.seasons,
    existingSeriesPoster
  );

  let seriesPoster = existingSeriesPoster;

  if (!seasons.length) {
    try {
      const details = await fetchSeriesDetails(item.tmdbId);

      seriesPoster =
        imageUrl(details.poster_path, "w342") ||
        seriesPoster ||
        placeholderPoster(item.title, "tv");

      seasons = normalizeSeasonList(
        details.seasons,
        seriesPoster
      );
    } catch (error) {
      console.error(
        `[temporadas] tv:${item.tmdbId} - ${error.message}`
      );
    }
  }

  if (!seasons.length) {
    seasons = [{
      seasonNumber: Math.max(
        1,
        Number(progress?.season || item.selectedSeason || 1)
      ),
      name: `Temporada ${Math.max(
        1,
        Number(progress?.season || item.selectedSeason || 1)
      )}`,
      episodeCount: Math.max(
        1,
        Number(
          progress?.episodeCount ||
          item.episodeCount ||
          progress?.episode ||
          item.selectedEpisode ||
          1
        )
      ),
      poster:
        String(progress?.poster || "") ||
        String(item.poster || "") ||
        placeholderPoster(item.title, "tv")
    }];
  }

  const selectedSeason = Math.max(
    1,
    Math.floor(
      Number(
        progress?.season ||
        item.selectedSeason ||
        seasons[0].seasonNumber
      )
    )
  );

  let selected =
    seasons.find(season => (
      season.seasonNumber === selectedSeason
    )) ||
    seasons[0];

  if (
    !selected.poster ||
    selected.episodeCount < 1
  ) {
    try {
      const details = await fetchSeasonDetails(
        item.tmdbId,
        selected.seasonNumber,
        {
          ...item,
          seriesPoster
        }
      );

      selected = {
        ...selected,
        ...details
      };

      seasons = seasons.map(season => (
        season.seasonNumber === selected.seasonNumber
          ? selected
          : season
      ));
    } catch (error) {
      console.error(
        `[temporada] tv:${item.tmdbId}:T${selected.seasonNumber} - ${error.message}`
      );
    }
  }

  const selectedEpisode = Math.max(
    1,
    Math.min(
      Math.floor(
        Number(
          progress?.episode ||
          item.selectedEpisode ||
          1
        )
      ),
      Math.max(
        1,
        Number(
          selected.episodeCount ||
          progress?.episodeCount ||
          item.episodeCount ||
          1
        )
      )
    )
  );

  return decorateWithSeriesProgress({
    ...item,
    seriesPoster:
      seriesPoster ||
      String(item.poster || ""),
    seasons,
    selectedSeason: selected.seasonNumber,
    selectedEpisode,
    episodeCount: Math.max(
      1,
      Number(selected.episodeCount || 1)
    ),
    poster:
      String(progress?.poster || "") ||
      selected.poster ||
      String(item.poster || "") ||
      placeholderPoster(item.title, "tv")
  });
}

async function applySeriesSelection(
  item,
  seasonNumber,
  episodeNumber
) {
  const enriched = await enrichSeriesItem(item);

  if (!validMediaItem(enriched) || enriched.type !== "tv") {
    throw new Error("Série inválida");
  }

  const season = Math.max(
    1,
    Math.floor(
      Number(
        seasonNumber ||
        enriched.selectedSeason ||
        enriched.savedSeason ||
        1
      )
    )
  );

  const details = await fetchSeasonDetails(
    enriched.tmdbId,
    season,
    enriched
  );

  const episodeCount = Math.max(
    1,
    Number(details.episodeCount || 1)
  );

  const episode = Math.max(
    1,
    Math.min(
      Math.floor(
        Number(
          episodeNumber ||
          enriched.selectedEpisode ||
          enriched.savedEpisode ||
          1
        )
      ),
      episodeCount
    )
  );

  const seasons = normalizeSeasonList(
    enriched.seasons,
    enriched.seriesPoster || enriched.poster
  );

  const updatedSeasons = seasons.some(entry => (
    entry.seasonNumber === season
  ))
    ? seasons.map(entry => (
        entry.seasonNumber === season
          ? {
              ...entry,
              ...details
            }
          : entry
      ))
    : [
        ...seasons,
        details
      ].sort((left, right) => (
        left.seasonNumber - right.seasonNumber
      ));

  return {
    ...enriched,
    seasons: updatedSeasons,
    selectedSeason: season,
    selectedEpisode: episode,
    episodeCount,
    poster:
      details.poster ||
      enriched.seriesPoster ||
      enriched.poster
  };
}

function scoreResult(item, type, wantedTitle, wantedYear) {
  const wanted = normalize(wantedTitle);
  const localized = normalize(titleOf(item, type));
  const original = normalize(originalTitleOf(item, type));
  const year = yearOf(item, type);
  let score = 0;

  if (localized === wanted) score += 1000;
  if (original === wanted) score += 950;
  if (localized.startsWith(wanted) || wanted.startsWith(localized)) score += 300;
  if (original.startsWith(wanted) || wanted.startsWith(original)) score += 260;
  if (localized.includes(wanted) || original.includes(wanted)) score += 120;
  if (wantedYear) score += year === wantedYear ? 700 : -350;
  if (item.poster_path) score += 25;

  return score + Math.min(Number(item.popularity || 0), 100) / 10;
}

async function tmdbSearch(type, query, year = "") {
  if (process.env.TMDB_MOCK === "1") {
    return [
      decorateWithSeriesProgress({
        tmdbId: type === "tv" ? 1399 : 550,
        type,
        title: query,
        originalTitle: query,
        year: year || (type === "tv" ? "2018" : "1999"),
        typeLabel: typeLabel(type),
        poster: placeholderPoster(query, type),
        overview: "Resultado de teste"
      })
    ];
  }

  const url = new URL(`https://api.themoviedb.org/3/search/${type}`);
  url.searchParams.set("language", "pt-BR");
  url.searchParams.set("include_adult", "false");
  url.searchParams.set("query", query);
  url.searchParams.set("page", "1");

  if (TMDB_API_KEY) url.searchParams.set("api_key", TMDB_API_KEY);
  if (year) {
    url.searchParams.set(type === "tv" ? "first_air_date_year" : "year", year);
  }

  const payload = await fetchTmdbJson(url);
  const results = Array.isArray(payload.results) ? payload.results : [];

  const selected = results
    .map(item => ({
      item,
      score: scoreResult(item, type, query, year)
    }))
    .sort((left, right) => right.score - left.score)
    .slice(0, 20);

  const hydrated = await mapLimit(selected, 5, async entry => {
    const poster = await resolvePoster(entry.item, type);
    return mediaFromTmdb(entry.item, type, poster);
  });

  return hydrated.map(decorateWithSeriesProgress);
}

async function findBestMedia(type, query, year = "") {
  const results = await tmdbSearch(type, query, year);
  if (!results.length) throw new Error("Título não encontrado");
  return results[0];
}

function cleanSuffix(value) {
  return String(value || "")
    .replace(/[<>]/g, "")
    .trim()
    .slice(0, 80);
}

function updateOverlay(item, suffix = "", updatedBy = "painel") {
  if (!validMediaItem(item)) {
    throw new Error("Filme ou série inválido");
  }

  let extra = cleanSuffix(suffix);
  let episodeMatch = extra.match(
    /^(?:EP|E)\s*0*(\d+)\s*[-–—]?\s*(?:T|TEMP|TEMPORADA)\s*0*(\d+)$/i
  );

  /*
    Quando a série é colocada novamente sem EP/T informado,
    recupera automaticamente o último progresso salvo dela.
  */
  if (item.type === "tv" && !extra) {
    const savedProgress = getSeriesProgress(item);

    if (savedProgress) {
      extra = savedProgress.suffix;
      episodeMatch = extra.match(
        /^(?:EP|E)\s*0*(\d+)\s*[-–—]?\s*(?:T|TEMP|TEMPORADA)\s*0*(\d+)$/i
      );
    }
  }

  const showSeason =
    item.type === "tv"
      ? item.showSeason !== false
      : true;

  const visibleExtra =
    item.type === "tv" &&
    episodeMatch &&
    !showSeason
      ? `EP${Number(episodeMatch[1])}`
      : extra;

  const displayTitle = visibleExtra
    ? `${item.title} ${visibleExtra}`
    : item.title;

  currentState = {
    revision: Date.now(),
    type: item.type,
    tmdbId: Number(item.tmdbId),
    baseTitle: item.title,
    originalTitle: String(item.originalTitle || ""),
    title: displayTitle,
    displayTitle,
    showSeason,
    episode: episodeMatch ? Number(episodeMatch[1]) : null,
    season: episodeMatch ? Number(episodeMatch[2]) : null,
    episodeCount: Math.max(
      Number(item.episodeCount || 0),
      episodeMatch ? Number(episodeMatch[1]) : 0
    ),
    seasons: Array.isArray(item.seasons)
      ? item.seasons
      : [],
    seriesPoster: String(item.seriesPoster || ""),
    suffix: extra,
    year: String(item.year || ""),
    typeLabel: item.typeLabel || typeLabel(item.type),
    poster: String(item.poster || ""),
    overview: String(item.overview || ""),
    updatedBy,
    updatedAt: new Date().toISOString()
  };

  if (
    currentState.type === "tv" &&
    currentState.episode &&
    currentState.season
  ) {
    rememberSeriesProgress(
      currentState,
      currentState.episode,
      currentState.season
    );
  }

  saveState();
  broadcastState();
  console.log(`[overlay] ${currentState.title}`);
  return currentState;
}

function clearOverlay(updatedBy = "painel") {
  currentState = null;
  lastError = null;

  writeJson(STATE_FILE, null);
  broadcastState();

  console.log(`[overlay] Removida por ${updatedBy}`);
  return currentState;
}

function stripEpisodeSuffix(value) {
  return String(value || "")
    .replace(
      /\s+(?:EP|E)\s*0*\d+\s*[-–—]?\s*(?:T|TEMP|TEMPORADA)\s*0*\d+\s*$/i,
      ""
    )
    .trim();
}

function advanceEpisode(updatedBy = "chat") {
  if (!currentState) {
    throw new Error("Não existe série na overlay");
  }

  if (currentState.type !== "tv") {
    throw new Error("O conteúdo atual não é uma série");
  }

  const currentEpisode = Math.max(
    0,
    Number(currentState.episode || 0)
  );

  const currentSeason = Math.max(
    1,
    Number(currentState.season || 1)
  );

  const nextEpisode = currentEpisode > 0
    ? currentEpisode + 1
    : 1;

  const item = {
    tmdbId: Number(currentState.tmdbId),
    type: "tv",
    title:
      currentState.baseTitle ||
      stripEpisodeSuffix(currentState.title),
    originalTitle: String(currentState.originalTitle || ""),
    year: String(currentState.year || ""),
    typeLabel: currentState.typeLabel || "Série",
    poster: String(currentState.poster || ""),
    seriesPoster: String(currentState.seriesPoster || ""),
    seasons: Array.isArray(currentState.seasons)
      ? currentState.seasons
      : [],
    selectedSeason: currentSeason,
    selectedEpisode: nextEpisode,
    episodeCount: Number(currentState.episodeCount || 0),
    showSeason: currentState.showSeason !== false,
    overview: String(currentState.overview || "")
  };

  return updateOverlay(
    item,
    `EP${nextEpisode} - T${currentSeason}`,
    updatedBy
  );
}

function parseTitleAndYear(raw) {
  const value = String(raw || "").trim();
  if (!value) return null;

  const match = value.match(/^(.*?)(?:\s*\|\s*|\s+)((?:18|19|20)\d{2})$/);
  if (!match) return { title: value, year: "" };

  const title = match[1].trim();
  return title ? { title, year: match[2] } : null;
}

function parseSeries(raw) {
  const value = String(raw || "").trim();
  if (!value) return null;

  let match = value.match(
    /^(.*?)\s+(?:EP|E)\s*0*(\d+)\s*(?:[-–—]\s*)?(?:T|TEMP|TEMPORADA)\s*0*(\d+)\s*$/i
  );

  if (match) {
    return {
      title: match[1].trim(),
      year: "",
      suffix: `EP${Number(match[2])} - T${Number(match[3])}`
    };
  }

  match = value.match(
    /^(.*?)\s+(?:T|TEMP|TEMPORADA)\s*0*(\d+)\s*(?:[-–—]\s*)?(?:EP|E)\s*0*(\d+)\s*$/i
  );

  if (match) {
    return {
      title: match[1].trim(),
      year: "",
      suffix: `EP${Number(match[3])} - T${Number(match[2])}`
    };
  }

  return parseTitleAndYear(value);
}

function commandArgument(message, command) {
  const text = String(message || "").trim();
  const lower = text.toLocaleLowerCase("pt-BR");
  if (lower === command) return "";
  if (!lower.startsWith(`${command} `)) return null;
  return text.slice(command.length).trim();
}

async function applyChatCommand(type, parsed, username) {
  try {
    lastError = null;
    const item = await findBestMedia(type, parsed.title, parsed.year || "");
    const result = updateOverlay(item, parsed.suffix || "", username || "chat");
    lastCommand = {
      command: type === "tv" ? "!ts" : "!tf",
      result: result.title,
      user: username || "chat",
      at: new Date().toISOString()
    };
  } catch (error) {
    lastError = error.message;
    console.error("[comando]", error.message);
  }
}

function handleChatMessage(username, message) {
  lastChatAt = new Date().toISOString();

  const normalizedMessage = String(message || "").trim().toLocaleLowerCase("pt-BR");

  if (normalizedMessage === "!d") {
    try {
      const result = advanceEpisode(username || "chat");

      lastCommand = {
        command: "!d",
        result: result.title,
        user: username || "chat",
        at: new Date().toISOString()
      };

      lastError = null;
    } catch (error) {
      lastError = error.message;
      console.error("[comando !d]", error.message);
    }

    return;
  }

  if (normalizedMessage === "!t") {
    clearOverlay(username || "chat");

    lastCommand = {
      command: "!t",
      result: "Overlay removida",
      user: username || "chat",
      at: new Date().toISOString()
    };

    return;
  }

  let argument = commandArgument(message, "!tf");
  if (argument !== null) {
    const parsed = parseTitleAndYear(argument);
    if (parsed) applyChatCommand("movie", parsed, username);
    return;
  }

  argument = commandArgument(message, "!ts");
  if (argument !== null) {
    const parsed = parseSeries(argument);
    if (parsed) applyChatCommand("tv", parsed, username);
  }
}

function decodeTag(value) {
  return String(value || "")
    .replace(/\\s/g, " ")
    .replace(/\\:/g, ";")
    .replace(/\\\\/g, "\\")
    .replace(/\\r/g, "\r")
    .replace(/\\n/g, "\n");
}

function parseTags(raw) {
  const tags = {};
  for (const pair of String(raw || "").split(";")) {
    const separator = pair.indexOf("=");
    const key = separator >= 0 ? pair.slice(0, separator) : pair;
    const value = separator >= 0 ? pair.slice(separator + 1) : "";
    tags[key] = decodeTag(value);
  }
  return tags;
}

function writeIrc(line) {
  if (!ircSocket || ircSocket.destroyed) return;
  ircSocket.write(`${line}\r\n`);
}

function processIrcLine(line) {
  if (!line) return;

  if (line.startsWith("PING")) {
    writeIrc(line.replace(/^PING/, "PONG"));
    return;
  }

  if (line.includes(" RECONNECT")) {
    ircSocket?.destroy();
    return;
  }

  if (/\s001\s/.test(line) && !twitchJoined) {
    writeIrc(`JOIN #${TWITCH_CHANNEL}`);
    return;
  }

  const joinMatch = line.match(/:([^!]+)![^ ]+\sJOIN\s#([^\s]+)/i);
  if (joinMatch && joinMatch[1].toLowerCase() === ircNickname.toLowerCase()) {
    twitchJoined = true;
    console.log(`[twitch] Entrou em #${joinMatch[2].toLowerCase()}`);
    return;
  }

  const match = line.match(
    /^(?:@([^ ]+)\s+)?:([^!]+)![^ ]+\sPRIVMSG\s#([^\s]+)\s:(.*)$/i
  );
  if (!match) return;

  const tags = parseTags(match[1] || "");
  const username = tags["display-name"] || match[2];
  const channel = match[3].toLowerCase();
  const message = match[4];

  if (channel !== TWITCH_CHANNEL) return;
  handleChatMessage(username, message);
}

function scheduleReconnect() {
  if (reconnectTimer) return;
  const delay = Math.min(60000, 2000 * Math.pow(2, Math.min(reconnectAttempt, 5)));
  reconnectAttempt += 1;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connectTwitch();
  }, delay);
}

function connectTwitch() {
  if (!TWITCH_CHANNEL) return;

  try {
    ircSocket?.destroy();
  } catch {}

  ircBuffer = "";
  twitchJoined = false;
  ircNickname = `justinfan${Math.floor(10000 + Math.random() * 89999)}`;

  ircSocket = tls.connect(
    {
      host: "irc.chat.twitch.tv",
      port: 6697,
      servername: "irc.chat.twitch.tv",
      rejectUnauthorized: true
    },
    () => {
      reconnectAttempt = 0;
      writeIrc("CAP REQ :twitch.tv/tags twitch.tv/commands");
      writeIrc("PASS SCHMOOPIIE");
      writeIrc(`NICK ${ircNickname}`);
      console.log(`[twitch] Conectando em #${TWITCH_CHANNEL}`);
    }
  );

  ircSocket.setKeepAlive(true, 30000);
  ircSocket.setTimeout(300000);

  ircSocket.on("data", chunk => {
    ircBuffer += chunk.toString("utf8");
    const lines = ircBuffer.split(/\r?\n/);
    ircBuffer = lines.pop() || "";
    for (const line of lines) processIrcLine(line);
  });

  ircSocket.on("timeout", () => {
    writeIrc(`PING :tela2-${Date.now()}`);
  });

  ircSocket.on("error", error => {
    lastError = error.message;
    console.error("[twitch]", error.message);
  });

  ircSocket.on("close", () => {
    scheduleReconnect();
  });
}

const ADMIN_HTML = fs.readFileSync(path.join(__dirname, "admin.html"), "utf8");

async function handleApi(request, response, url) {
  if (!requireAdmin(request, response)) return;

  if (request.method === "GET" && url.pathname === "/api/upnext") {
    sendJson(response, 200, {
      ok: true,
      upnext: upNext
    });
    return;
  }

  if (request.method === "POST" && url.pathname === "/api/upnext/config") {
    try {
      const body = await readJson(request);

      upNext.enabled =
        typeof body.enabled === "boolean"
          ? body.enabled
          : upNext.enabled;

      upNext.label = cleanUpNextLabel(
        body.label ?? upNext.label
      );

      upNext.intervalMinutes = Math.max(
        1,
        Math.min(
          1440,
          Number(
            body.intervalMinutes ??
            upNext.intervalMinutes
          )
        )
      );

      upNext.displaySeconds = Math.max(
        1,
        Math.min(
          300,
          Number(
            body.displaySeconds ??
            upNext.displaySeconds
          )
        )
      );

      touchUpNext(true);

      sendJson(response, 200, {
        ok: true,
        upnext: upNext
      });
    } catch (error) {
      sendJson(response, 400, {
        ok: false,
        error: error.message
      });
    }
    return;
  }

  if (request.method === "POST" && url.pathname === "/api/upnext/items") {
    try {
      const body = await readJson(request);
      let item = await hydrateMediaItem(body.item);

      if (item?.type === "tv") {
        item = await enrichSeriesItem(item);
      }

      item = decorateWithSeriesProgress(item);

      const cleanItem = cleanUpNextItem(item);

      if (!cleanItem) {
        throw new Error("Conteúdo inválido");
      }

      const key = upNextItemKey(cleanItem);
      const wasEmpty = upNext.items.length === 0;

      upNext.items = [
        ...upNext.items.filter(entry => (
          upNextItemKey(entry) !== key
        )),
        cleanItem
      ].slice(0, 50);

      touchUpNext(wasEmpty);

      sendJson(response, 200, {
        ok: true,
        upnext: upNext
      });
    } catch (error) {
      sendJson(response, 400, {
        ok: false,
        error: error.message
      });
    }
    return;
  }

  if (
    request.method === "DELETE" &&
    /^\/api\/upnext\/items\/(movie|tv)\/\d+$/.test(url.pathname)
  ) {
    const parts = url.pathname.split("/").filter(Boolean);
    const type = parts[3];
    const tmdbId = Number(parts[4]);
    const key = `${type}:${tmdbId}`;

    upNext.items = upNext.items.filter(item => (
      upNextItemKey(item) !== key
    ));

    touchUpNext(false);

    sendJson(response, 200, {
      ok: true,
      upnext: upNext
    });
    return;
  }

  if (request.method === "POST" && url.pathname === "/api/upnext/trigger") {
    upNext.triggerAt = Date.now();
    touchUpNext(false);

    sendJson(response, 200, {
      ok: true,
      upnext: upNext
    });
    return;
  }

  if (request.method === "GET" && url.pathname === "/api/search") {
    const type = url.searchParams.get("type") === "tv" ? "tv" : "movie";
    const query = String(url.searchParams.get("q") || "").trim();
    const year = String(url.searchParams.get("year") || "").trim();

    if (!query) {
      sendJson(response, 400, { ok: false, error: "Digite o nome" });
      return;
    }

    try {
      const results = await tmdbSearch(type, query, year);
      sendJson(response, 200, { ok: true, results });
    } catch (error) {
      lastError = error.message;
      sendJson(response, 502, { ok: false, error: error.message });
    }
    return;
  }

  if (request.method === "GET" && url.pathname === "/api/saved") {
    const hydrated = await mapLimit(
      savedItems,
      4,
      async item => {
        const hydratedItem = await hydrateMediaItem(item);

        return hydratedItem.type === "tv"
          ? enrichSeriesItem(hydratedItem)
          : hydratedItem;
      }
    );

    const changed = hydrated.some(
      (item, index) => item.poster !== savedItems[index].poster
    );

    savedItems = hydrated;

    if (changed) {
      saveSavedItems();
    }

    sendJson(response, 200, {
      ok: true,
      items: savedItems.map(decorateWithSeriesProgress)
    });
    return;
  }

  if (request.method === "POST" && url.pathname === "/api/saved") {
    try {
      const body = await readJson(request);
      let item = await hydrateMediaItem(body.item);

      if (item?.type === "tv") {
        item = await enrichSeriesItem(item);
      }

      if (!validMediaItem(item)) {
        throw new Error("Título inválido");
      }

      const key = `${item.type}:${item.tmdbId}`;
      savedItems = [
        { ...item, savedAt: new Date().toISOString() },
        ...savedItems.filter(entry => `${entry.type}:${entry.tmdbId}` !== key)
      ].slice(0, 200);
      saveSavedItems();
      sendJson(response, 200, {
        ok: true,
        items: savedItems.map(decorateWithSeriesProgress)
      });
    } catch (error) {
      sendJson(response, 400, { ok: false, error: error.message });
    }
    return;
  }

  if (
    request.method === "GET" &&
    /^\/api\/tv\/\d+\/season\/\d+$/.test(url.pathname)
  ) {
    try {
      const parts = url.pathname.split("/").filter(Boolean);
      const tmdbId = Number(parts[2]);
      const seasonNumber = Number(parts[4]);
      const saved = savedItems.find(item => (
        item.type === "tv" &&
        Number(item.tmdbId) === tmdbId
      ));

      const season = await fetchSeasonDetails(
        tmdbId,
        seasonNumber,
        saved || {}
      );

      sendJson(response, 200, {
        ok: true,
        season
      });
    } catch (error) {
      sendJson(response, 400, {
        ok: false,
        error: error.message
      });
    }
    return;
  }

  if (
    request.method === "POST" &&
    /^\/api\/saved\/tv\/\d+\/progress$/.test(url.pathname)
  ) {
    try {
      const parts = url.pathname.split("/").filter(Boolean);
      const tmdbId = Number(parts[3]);
      const body = await readJson(request);
      const key = `tv:${tmdbId}`;

      let item = savedItems.find(entry => (
        entry.type === "tv" &&
        Number(entry.tmdbId) === tmdbId
      ));

      if (!item && validMediaItem(body.item)) {
        item = body.item;
      }

      if (!item) {
        throw new Error("Série salva não encontrada");
      }

      let selected = await applySeriesSelection(
        item,
        body.season,
        body.episode
      );

      selected = {
        ...selected,
        showSeason:
          typeof body.showSeason === "boolean"
            ? body.showSeason
            : typeof item.showSeason === "boolean"
              ? item.showSeason
              : true
      };

      rememberSeriesProgress(
        selected,
        selected.selectedEpisode,
        selected.selectedSeason
      );

      savedItems = [
        {
          ...selected,
          savedAt:
            savedItems.find(entry => (
              `${entry.type}:${entry.tmdbId}` === key
            ))?.savedAt ||
            new Date().toISOString()
        },
        ...savedItems.filter(entry => (
          `${entry.type}:${entry.tmdbId}` !== key
        ))
      ].slice(0, 200);

      saveSavedItems();

      sendJson(response, 200, {
        ok: true,
        item: decorateWithSeriesProgress(savedItems[0]),
        items: savedItems.map(decorateWithSeriesProgress)
      });
    } catch (error) {
      sendJson(response, 400, {
        ok: false,
        error: error.message
      });
    }
    return;
  }

  if (request.method === "DELETE" && url.pathname.startsWith("/api/saved/")) {
    const parts = url.pathname.split("/").filter(Boolean);
    const type = parts[2];
    const tmdbId = Number(parts[3]);
    savedItems = savedItems.filter(
      entry => !(entry.type === type && Number(entry.tmdbId) === tmdbId)
    );
    saveSavedItems();
    sendJson(response, 200, {
      ok: true,
      items: savedItems.map(decorateWithSeriesProgress)
    });
    return;
  }

  if (request.method === "POST" && url.pathname === "/api/overlay") {
    try {
      const body = await readJson(request);
      let item = await hydrateMediaItem(body.item);
      let suffix = cleanSuffix(body.suffix);

      if (item?.type === "tv") {
        const suffixMatch = suffix.match(
          /^(?:EP|E)\s*0*(\d+)\s*[-–—]?\s*(?:T|TEMP|TEMPORADA)\s*0*(\d+)$/i
        );

        const episode =
          Number(body.episode) ||
          Number(suffixMatch?.[1]) ||
          Number(item.selectedEpisode) ||
          Number(item.savedEpisode) ||
          1;

        const season =
          Number(body.season) ||
          Number(suffixMatch?.[2]) ||
          Number(item.selectedSeason) ||
          Number(item.savedSeason) ||
          1;

        item = await applySeriesSelection(
          item,
          season,
          episode
        );

        suffix =
          `EP${item.selectedEpisode} - T${item.selectedSeason}`;
      }

      const state = updateOverlay(
        item,
        suffix,
        "painel adm"
      );

      sendJson(response, 200, {
        ok: true,
        state
      });
    } catch (error) {
      sendJson(response, 400, {
        ok: false,
        error: error.message
      });
    }
    return;
  }

  if (request.method === "POST" && url.pathname === "/api/command") {
    try {
      const body = await readJson(request);
      const rawCommand = String(body.command || "").trim();
      const username = String(body.user || "chat").trim() || "chat";
      const normalized = rawCommand.toLocaleLowerCase("pt-BR");

      if (normalized === "!d") {
        const state = advanceEpisode(username);

        lastCommand = {
          command: "!d",
          result: state.title,
          user: username,
          at: new Date().toISOString()
        };

        lastError = null;
        sendJson(response, 200, { ok: true, state });
        return;
      }

      if (normalized === "!t") {
        clearOverlay(username);

        lastCommand = {
          command: "!t",
          result: "Overlay removida",
          user: username,
          at: new Date().toISOString()
        };

        lastError = null;
        sendJson(response, 200, { ok: true, state: null });
        return;
      }

      let argument = commandArgument(rawCommand, "!tf");

      if (argument !== null) {
        const parsed = parseTitleAndYear(argument);

        if (!parsed) {
          throw new Error("Use !tf seguido do nome do filme");
        }

        const item = await findBestMedia("movie", parsed.title, parsed.year || "");
        const state = updateOverlay(item, "", username);

        lastCommand = {
          command: "!tf",
          result: state.title,
          user: username,
          at: new Date().toISOString()
        };

        lastError = null;
        sendJson(response, 200, { ok: true, state });
        return;
      }

      argument = commandArgument(rawCommand, "!ts");

      if (argument !== null) {
        const parsed = parseSeries(argument);

        if (!parsed) {
          throw new Error("Use !ts seguido do nome da série");
        }

        let item = await findBestMedia("tv", parsed.title, parsed.year || "");

        const suffixMatch = String(parsed.suffix || "").match(
          /^(?:EP|E)\s*0*(\d+)\s*[-–—]?\s*(?:T|TEMP|TEMPORADA)\s*0*(\d+)$/i
        );

        if (suffixMatch) {
          item = await applySeriesSelection(
            item,
            Number(suffixMatch[2]),
            Number(suffixMatch[1])
          );
        } else {
          item = await enrichSeriesItem(item);
        }

        const suffix = suffixMatch
          ? `EP${item.selectedEpisode} - T${item.selectedSeason}`
          : parsed.suffix || "";

        const state = updateOverlay(item, suffix, username);

        lastCommand = {
          command: "!ts",
          result: state.title,
          user: username,
          at: new Date().toISOString()
        };

        lastError = null;
        sendJson(response, 200, { ok: true, state });
        return;
      }

      throw new Error("Comando inválido");
    } catch (error) {
      lastError = error.message;
      sendJson(response, 400, {
        ok: false,
        error: error.message
      });
    }
    return;
  }

  if (request.method === "DELETE" && url.pathname === "/api/overlay") {
    clearOverlay("painel adm");

    lastCommand = {
      command: "PAINEL",
      result: "Overlay removida",
      user: "painel adm",
      at: new Date().toISOString()
    };

    sendJson(response, 200, {
      ok: true,
      state: null
    });
    return;
  }

  sendJson(response, 404, { ok: false, error: "Rota da API não encontrada" });
}

async function runSelfTest() {
  const first = parseSeries("Elite EP1 - T2");
  const second = parseSeries("The Office T2 - EP3");

  if (!first || first.title !== "Elite" || first.suffix !== "EP1 - T2") {
    throw new Error("Falha em !ts Elite EP1 - T2");
  }

  if (!second || second.title !== "The Office" || second.suffix !== "EP3 - T2") {
    throw new Error("Falha em !ts The Office T2 - EP3");
  }

  const testState = updateOverlay(
    {
      tmdbId: 1,
      type: "tv",
      title: "Elite",
      year: "2018",
      typeLabel: "Série",
      poster: "",
      overview: ""
    },
    "EP1 - T2",
    "teste"
  );

  if (testState.title !== "Elite EP1 - T2") {
    throw new Error("Falha ao atualizar a overlay");
  }

  const fallback = placeholderPoster("Título sem imagem", "movie");

  if (!fallback.startsWith("data:image/svg+xml")) {
    throw new Error("Falha ao criar capa substituta");
  }

  if (testState.episode !== 1 || testState.season !== 2) {
    throw new Error("Falha ao guardar episódio e temporada no estado");
  }

  const advancedState = advanceEpisode("autoteste");

  if (
    advancedState.title !== "Elite EP2 - T2" ||
    advancedState.episode !== 2 ||
    advancedState.season !== 2
  ) {
    throw new Error("Falha no comando !d");
  }

  clearOverlay("autoteste");

  const darkState = updateOverlay(
    {
      tmdbId: 2,
      type: "tv",
      title: "Dark",
      year: "2017",
      typeLabel: "Série",
      poster: "",
      overview: ""
    },
    "EP7 - T3",
    "autoteste"
  );

  if (darkState.title !== "Dark EP7 - T3") {
    throw new Error("Falha ao guardar progresso de Dark");
  }

  const restoredElite = updateOverlay(
    {
      tmdbId: 1,
      type: "tv",
      title: "Elite",
      year: "2018",
      typeLabel: "Série",
      poster: "",
      overview: ""
    },
    "",
    "autoteste"
  );

  if (
    restoredElite.title !== "Elite EP2 - T2" ||
    restoredElite.episode !== 2 ||
    restoredElite.season !== 2
  ) {
    throw new Error("Falha ao restaurar o progresso antigo de Elite");
  }

  const restoredDark = updateOverlay(
    {
      tmdbId: 2,
      type: "tv",
      title: "Dark",
      year: "2017",
      typeLabel: "Série",
      poster: "",
      overview: ""
    },
    "",
    "autoteste"
  );

  if (
    restoredDark.title !== "Dark EP7 - T3" ||
    restoredDark.episode !== 7 ||
    restoredDark.season !== 3
  ) {
    throw new Error("Falha ao manter progresso separado por série");
  }

  clearOverlay("autoteste");

  if (currentState !== null) {
    throw new Error("Falha ao excluir o conteúdo da overlay");
  }

  const seasonSelection = await applySeriesSelection(
    {
      tmdbId: 1399,
      type: "tv",
      title: "Série Teste",
      year: "2018",
      typeLabel: "Série",
      poster: placeholderPoster("Série Teste", "tv"),
      overview: ""
    },
    3,
    4
  );

  if (
    seasonSelection.selectedSeason !== 3 ||
    seasonSelection.selectedEpisode !== 4 ||
    !seasonSelection.poster
  ) {
    throw new Error(
      "Falha ao selecionar temporada, episódio e capa"
    );
  }

  console.log(
    "[teste] Temporadas, capas, episódios, progresso, !d e !t validados"
  );
}

if (process.argv.includes("--self-test")) {
  runSelfTest()
    .then(() => process.exit(0))
    .catch(error => {
      console.error(error);
      process.exit(1);
    });
}

const server = http.createServer(async (request, response) => {
  const url = new URL(
    request.url || "/",
    `http://${request.headers.host || "localhost"}`
  );

  if (request.method === "OPTIONS") {
    response.writeHead(204, commonHeaders());
    response.end();
    return;
  }

  if (request.method === "GET" && url.pathname === "/admin") {
    sendText(response, 200, ADMIN_HTML, "text/html; charset=utf-8");
    return;
  }

  if (url.pathname.startsWith("/api/")) {
    await handleApi(request, response, url);
    return;
  }

  if (
    (request.method === "GET" || request.method === "HEAD") &&
    (url.pathname === "/" || url.pathname === "/ping")
  ) {
    if (request.method === "HEAD") {
      response.writeHead(200, {
        ...commonHeaders("text/plain; charset=utf-8"),
        "Content-Length": "0"
      });
      response.end();
    } else {
      sendText(response, 200, "OK");
    }
    return;
  }

  if (
    (request.method === "GET" || request.method === "HEAD") &&
    url.pathname === "/health"
  ) {
    const health = {
      ok: true,
      commandMode: "streamelements-api",
      channel: TWITCH_CHANNEL,
      twitchConnected: false,
      twitchJoined: false,
      hasContent: Boolean(currentState),
      savedCount: savedItems.length,
      upNextCount: upNext.items.length,
      upNextEnabled: upNext.enabled,
      connectedWidgets: sseClients.size,
      lastChatAt,
      lastCommand,
      lastError,
      uptimeSeconds: Math.floor(process.uptime())
    };

    if (request.method === "HEAD") {
      response.writeHead(200, {
        ...commonHeaders("application/json; charset=utf-8"),
        "Content-Length": "0"
      });
      response.end();
    } else {
      sendJson(response, 200, health);
    }
    return;
  }

  if (request.method === "GET" && url.pathname === "/state") {
    sendJson(response, 200, currentState);
    return;
  }

  if (request.method === "GET" && url.pathname === "/upnext") {
    sendJson(response, 200, upNext);
    return;
  }

  if (request.method === "GET" && url.pathname === "/events") {
    response.writeHead(200, {
      ...commonHeaders("text/event-stream; charset=utf-8"),
      Connection: "keep-alive",
      "X-Accel-Buffering": "no"
    });

    response.write(": conectado\n\n");
    sseClients.add(response);
    sendSse(response, "state", currentState);
    sendSse(response, "upnext", upNext);

    const heartbeat = setInterval(() => {
      try {
        response.write(`: ping ${Date.now()}\n\n`);
      } catch {
        clearInterval(heartbeat);
        sseClients.delete(response);
      }
    }, 15000);

    request.on("close", () => {
      clearInterval(heartbeat);
      sseClients.delete(response);
    });
    return;
  }

  sendJson(response, 404, { ok: false, error: "Rota não encontrada" });
});

server.keepAliveTimeout = 65000;
server.headersTimeout = 70000;
server.requestTimeout = 30000;

server.on("clientError", (error, socket) => {
  console.error("[http client]", error.message);
  if (socket.writable) {
    socket.end("HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n");
  }
});

server.on("error", error => {
  console.error("[http fatal]", error);
  process.exitCode = 1;
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`[http] Serviço iniciado na porta ${PORT}`);
  console.log(`[admin] http://localhost:${PORT}/admin`);
  console.log("[comandos] StreamElements via /api/command");
});

function shutdown(signal) {
  console.log(`[sistema] Encerrando por ${signal}`);
  if (reconnectTimer) clearTimeout(reconnectTimer);
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 5000).unref();
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
process.on("unhandledRejection", error => {
  lastError = error.message;
  console.error("[erro]", error);
});
process.on("uncaughtException", error => {
  lastError = error.message;
  console.error("[erro fatal]", error);
});
