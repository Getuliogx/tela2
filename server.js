"use strict";

const http = require("http");
const tls = require("tls");
const fs = require("fs");
const path = require("path");

const BUILD_MODE = process.argv.includes("--build");
const POSTINSTALL_MODE = process.argv.includes("--postinstall");

/*
  Configuração pedida no Render:
  Build Command: npm start
  Start Command: npm install

  - npm start executa este arquivo com --build e encerra.
  - npm install chama postinstall.
  - No runtime do Render existe PORT; então postinstall inicia o servidor.
  - Se npm install for executado durante o build, não existe PORT e ele encerra.
*/
if (BUILD_MODE) {
  console.log("[build] Projeto validado.");
  process.exit(0);
}

if (POSTINSTALL_MODE && !process.env.PORT) {
  console.log("[install] Dependências instaladas.");
  process.exit(0);
}

const PORT = Number(process.env.PORT || 10000);

const DEFAULT_CHANNELS = "icarolinaporto,yzgxx";
const CHANNELS = String(process.env.TWITCH_CHANNEL || DEFAULT_CHANNELS)
  .split(",")
  .map(value => value.trim().replace(/^#/, "").toLowerCase())
  .filter(Boolean);

const TMDB_BEARER = String(
  process.env.TMDB_BEARER ||
  "eyJhbGciOiJIUzI1NiJ9.eyJhdWQiOiJiMDk1Y2NiYmIxODVkMjc3MDNkMDA3YWUwZGVkNWY3ZCIsIm5iZiI6MTc3NjYxMTUzMS4yNTQwMDAyLCJzdWIiOiI2OWU0ZjBjYmE2ZjVkMTQyYzc0YjMyYzkiLCJzY29wZXMiOlsiYXBpX3JlYWQiXSwidmVyc2lvbiI6MX0.F0r1SSOo4SeBFIWtOzE6mkYNjXTZgVRdrVCT0qDPVYA"
).trim();

const TMDB_API_KEY = String(
  process.env.TMDB_API_KEY ||
  "b095ccbbb185d27703d007ae0ded5f7d"
).trim();

const PERMISSION = ["broadcaster", "mods", "everyone"].includes(
  String(process.env.COMMAND_PERMISSION || "mods").toLowerCase()
)
  ? String(process.env.COMMAND_PERMISSION || "mods").toLowerCase()
  : "mods";

const MOVIE_COMMAND = "!tf";
const SERIES_COMMAND = "!ts";
const STATE_FILE = path.join(__dirname, "state.json");

let currentState = loadState();
let ircSocket = null;
let ircBuffer = "";
let reconnectTimer = null;
let reconnectAttempt = 0;
const sseClients = new Set();

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
  try {
    const parsed = JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
    return validState(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function saveState() {
  try {
    fs.writeFileSync(
      STATE_FILE,
      JSON.stringify(currentState, null, 2),
      "utf8"
    );
  } catch (error) {
    console.error("[estado] Falha ao salvar:", error.message);
  }
}

function commonHeaders(contentType = "application/json; charset=utf-8") {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Cache-Control": "no-store, no-cache, must-revalidate",
    "Content-Type": contentType
  };
}

function sendText(response, statusCode, text) {
  const body = String(text);

  response.writeHead(statusCode, {
    ...commonHeaders("text/plain; charset=utf-8"),
    "Content-Length": Buffer.byteLength(body)
  });

  response.end(body);
}

function sendJson(response, statusCode, value) {
  const body = JSON.stringify(value);

  response.writeHead(statusCode, {
    ...commonHeaders(),
    "Content-Length": Buffer.byteLength(body)
  });

  response.end(body);
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

function firstYear(value) {
  return typeof value === "string" && value.length >= 4
    ? value.slice(0, 4)
    : "";
}

function normalizeText(value) {
  return String(value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLocaleLowerCase("pt-BR")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()
    .replace(/\s+/g, " ");
}

function mediaTitle(item, type) {
  return type === "tv" ? item.name : item.title;
}

function originalTitle(item, type) {
  return type === "tv" ? item.original_name : item.original_title;
}

function mediaYear(item, type) {
  return firstYear(
    type === "tv" ? item.first_air_date : item.release_date
  );
}

function scoreResult(item, type, wantedTitle, wantedYear) {
  const wanted = normalizeText(wantedTitle);
  const localized = normalizeText(mediaTitle(item, type));
  const original = normalizeText(originalTitle(item, type));
  const year = mediaYear(item, type);

  let score = 0;

  if (localized === wanted) score += 1000;
  if (original === wanted) score += 950;
  if (localized.startsWith(wanted) || wanted.startsWith(localized)) score += 300;
  if (original.startsWith(wanted) || wanted.startsWith(original)) score += 260;
  if (localized.includes(wanted) || original.includes(wanted)) score += 120;

  if (wantedYear) {
    score += year === wantedYear ? 700 : -350;
  }

  if (item.poster_path) score += 25;
  score += Math.min(Number(item.popularity || 0), 100) / 10;

  return score;
}

async function searchTmdb(type, query, year) {
  const url = new URL(`https://api.themoviedb.org/3/search/${type}`);

  url.searchParams.set("language", "pt-BR");
  url.searchParams.set("include_adult", "false");
  url.searchParams.set("query", query);
  url.searchParams.set("page", "1");

  if (year) {
    url.searchParams.set(
      type === "tv" ? "first_air_date_year" : "year",
      year
    );
  }

  if (TMDB_API_KEY) {
    url.searchParams.set("api_key", TMDB_API_KEY);
  }

  const headers = {
    accept: "application/json"
  };

  if (TMDB_BEARER) {
    headers.Authorization = `Bearer ${TMDB_BEARER}`;
  }

  const response = await fetch(url, {
    method: "GET",
    headers,
    signal: AbortSignal.timeout(15000)
  });

  if (!response.ok) {
    throw new Error(`TMDB respondeu ${response.status}`);
  }

  const payload = await response.json();
  const results = Array.isArray(payload.results) ? payload.results : [];

  if (!results.length) {
    throw new Error("Título não encontrado.");
  }

  const selected = results
    .map(item => ({
      item,
      score: scoreResult(item, type, query, year)
    }))
    .sort((left, right) => right.score - left.score)[0].item;

  return {
    revision: Date.now(),
    type,
    tmdbId: selected.id,
    title: mediaTitle(selected, type) || query,
    originalTitle: originalTitle(selected, type) || "",
    year: mediaYear(selected, type) || year || "",
    typeLabel: type === "tv" ? "Série" : "Filme",
    poster: selected.poster_path
      ? `https://image.tmdb.org/t/p/w342${selected.poster_path}`
      : "",
    updatedAt: new Date().toISOString()
  };
}

function parseTitleAndYear(raw) {
  const value = String(raw || "").trim();

  if (!value) return null;

  const match = value.match(
    /^(.*?)(?:\s*\|\s*|\s+)((?:18|19|20)\d{2})$/
  );

  if (!match) {
    return {
      query: value,
      year: ""
    };
  }

  const query = match[1].trim();

  return query
    ? {
        query,
        year: match[2]
      }
    : null;
}

function commandArgument(message, command) {
  const text = String(message || "").trim();
  const lowered = text.toLocaleLowerCase("pt-BR");

  if (lowered === command) return "";
  if (!lowered.startsWith(`${command} `)) return null;

  return text.slice(command.length).trim();
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

function normalizeChannel(value) {
  return String(value || "").replace(/^#/, "").toLowerCase();
}

function isBroadcaster(channel, username, tags) {
  return String(tags.badges || "").includes("broadcaster/1") ||
    String(username || "").toLowerCase() === normalizeChannel(channel);
}

function isModerator(channel, username, tags) {
  const badges = String(tags.badges || "");

  return isBroadcaster(channel, username, tags) ||
    badges.includes("moderator/1") ||
    tags.mod === "1";
}

function hasPermission(channel, username, tags) {
  if (PERMISSION === "everyone") return true;

  if (PERMISSION === "broadcaster") {
    return isBroadcaster(channel, username, tags);
  }

  return isModerator(channel, username, tags);
}

async function applyCommand(type, parsed, username, displayName) {
  try {
    const media = await searchTmdb(type, parsed.query, parsed.year);

    currentState = {
      ...media,
      updatedBy: displayName || username || "chat"
    };

    saveState();
    broadcastState();

    console.log(
      `[comando] ${currentState.typeLabel}: ${currentState.title}` +
      `${currentState.year ? ` (${currentState.year})` : ""}`
    );
  } catch (error) {
    console.error(`[tmdb] ${error.message}`);
  }
}

function handleChatMessage(channel, username, tags, message) {
  if (!hasPermission(channel, username, tags)) return;

  let argument = commandArgument(message, MOVIE_COMMAND);

  if (argument !== null) {
    const parsed = parseTitleAndYear(argument);

    if (parsed) {
      applyCommand("movie", parsed, username, tags["display-name"]);
    }

    return;
  }

  argument = commandArgument(message, SERIES_COMMAND);

  if (argument !== null) {
    const parsed = parseTitleAndYear(argument);

    if (parsed) {
      applyCommand("tv", parsed, username, tags["display-name"]);
    }
  }
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

  const match = line.match(
    /^@([^ ]+) :([^!]+)![^ ]+ PRIVMSG (#[^ ]+) :(.*)$/
  );

  if (!match) return;

  const tags = parseTags(match[1]);
  const username = match[2];
  const channel = match[3];
  const message = match[4];

  handleChatMessage(channel, username, tags, message);
}

function scheduleReconnect() {
  if (!CHANNELS.length || reconnectTimer) return;

  const delay = Math.min(
    60000,
    2000 * Math.pow(2, Math.min(reconnectAttempt, 5))
  );

  reconnectAttempt += 1;

  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connectTwitch();
  }, delay);

  console.log(`[twitch] Nova tentativa em ${Math.round(delay / 1000)}s`);
}

function connectTwitch() {
  if (!CHANNELS.length) {
    console.error("[twitch] Nenhum canal configurado.");
    return;
  }

  try {
    ircSocket?.destroy();
  } catch {}

  ircBuffer = "";

  const nickname = `justinfan${Math.floor(10000 + Math.random() * 89999)}`;

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
      writeIrc(`NICK ${nickname}`);
      writeIrc(`JOIN ${CHANNELS.map(channel => `#${channel}`).join(",")}`);

      console.log(`[twitch] Conectado: ${CHANNELS.join(", ")}`);
    }
  );

  ircSocket.setKeepAlive(true, 30000);
  ircSocket.setTimeout(300000);

  ircSocket.on("data", chunk => {
    ircBuffer += chunk.toString("utf8");

    const lines = ircBuffer.split(/\r?\n/);
    ircBuffer = lines.pop() || "";

    for (const line of lines) {
      processIrcLine(line);
    }
  });

  ircSocket.on("timeout", () => {
    writeIrc(`PING :tela2-${Date.now()}`);
  });

  ircSocket.on("error", error => {
    console.error(`[twitch] Erro: ${error.message}`);
  });

  ircSocket.on("close", () => {
    console.error("[twitch] Conexão encerrada.");
    scheduleReconnect();
  });
}

const server = http.createServer((request, response) => {
  const url = new URL(
    request.url || "/",
    `http://${request.headers.host || "localhost"}`
  );

  if (request.method === "OPTIONS") {
    response.writeHead(204, commonHeaders());
    response.end();
    return;
  }

  if (request.method !== "GET") {
    sendJson(response, 405, {
      ok: false,
      error: "Método não permitido"
    });
    return;
  }

  if (url.pathname === "/" || url.pathname === "/ping") {
    sendText(response, 200, "OK");
    return;
  }

  if (url.pathname === "/health") {
    sendJson(response, 200, {
      ok: true,
      channels: CHANNELS,
      twitchConnected: Boolean(ircSocket && !ircSocket.destroyed),
      hasContent: Boolean(currentState),
      connectedWidgets: sseClients.size,
      uptimeSeconds: Math.floor(process.uptime())
    });
    return;
  }

  if (url.pathname === "/state") {
    sendJson(response, 200, currentState);
    return;
  }

  if (url.pathname === "/events") {
    response.writeHead(200, {
      ...commonHeaders("text/event-stream; charset=utf-8"),
      "Connection": "keep-alive",
      "X-Accel-Buffering": "no"
    });

    response.write(": conectado\n\n");
    sseClients.add(response);
    sendSse(response, "state", currentState);

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

  if (url.pathname === "/favicon.ico") {
    response.writeHead(204);
    response.end();
    return;
  }

  sendJson(response, 404, {
    ok: false,
    error: "Rota não encontrada"
  });
});

server.keepAliveTimeout = 65000;
server.headersTimeout = 66000;
server.requestTimeout = 30000;

server.listen(PORT, "0.0.0.0", () => {
  console.log(`[http] Serviço iniciado na porta ${PORT}`);
  connectTwitch();
});

function shutdown(signal) {
  console.log(`[sistema] Encerrando por ${signal}`);

  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
  }

  try {
    ircSocket?.destroy();
  } catch {}

  server.close(() => process.exit(0));

  setTimeout(() => {
    process.exit(0);
  }, 5000).unref();
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
process.on("unhandledRejection", error => console.error("[erro]", error));
process.on("uncaughtException", error => console.error("[erro fatal]", error));
