"use strict";

const http = require("http");
const tls = require("tls");
const fs = require("fs");
const path = require("path");

const PORT = Number(process.env.PORT || 10000);

/*
  Canal fixo correto.
  Não depende de variável antiga do Render.
*/
const CHANNEL = "icarolinaporto";
const CHANNELS = [CHANNEL];

const TMDB_BEARER = String(
  process.env.TMDB_BEARER ||
  "eyJhbGciOiJIUzI1NiJ9.eyJhdWQiOiJiMDk1Y2NiYmIxODVkMjc3MDNkMDA3YWUwZGVkNWY3ZCIsIm5iZiI6MTc3NjYxMTUzMS4yNTQwMDAyLCJzdWIiOiI2OWU0ZjBjYmE2ZjVkMTQyYzc0YjMyYzkiLCJzY29wZXMiOlsiYXBpX3JlYWQiXSwidmVyc2lvbiI6MX0.F0r1SSOo4SeBFIWtOzE6mkYNjXTZgVRdrVCT0qDPVYA"
).trim();

const TMDB_API_KEY = String(
  process.env.TMDB_API_KEY ||
  "b095ccbbb185d27703d007ae0ded5f7d"
).trim();

const STATE_FILE = path.join(__dirname, "state.json");

let state = loadState();
let socket = null;
let ircBuffer = "";
let reconnectTimer = null;
let reconnectAttempt = 0;
let joined = false;
let lastChatMessage = null;
let lastCommand = null;
let lastError = null;

const streams = new Set();

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
    const value = JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
    return validState(value) ? value : null;
  } catch {
    return null;
  }
}

function saveState() {
  try {
    fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2), "utf8");
  } catch (error) {
    console.error("[estado]", error.message);
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

function sendText(response, status, value) {
  const body = String(value);

  response.writeHead(status, {
    ...commonHeaders("text/plain; charset=utf-8"),
    "Content-Length": Buffer.byteLength(body)
  });

  response.end(body);
}

function sendJson(response, status, value) {
  const body = JSON.stringify(value);

  response.writeHead(status, {
    ...commonHeaders(),
    "Content-Length": Buffer.byteLength(body)
  });

  response.end(body);
}

function sendEvent(response, value) {
  response.write("event: state\n");
  response.write(`data: ${JSON.stringify(value)}\n\n`);
}

function broadcast() {
  for (const response of [...streams]) {
    try {
      sendEvent(response, state);
    } catch {
      streams.delete(response);
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

function score(item, type, requestedTitle, requestedYear) {
  const wanted = normalize(requestedTitle);
  const title = normalize(titleOf(item, type));
  const original = normalize(originalTitleOf(item, type));
  const year = yearOf(item, type);

  let points = 0;

  if (title === wanted) points += 1000;
  if (original === wanted) points += 950;
  if (title.startsWith(wanted) || wanted.startsWith(title)) points += 300;
  if (original.startsWith(wanted) || wanted.startsWith(original)) points += 260;
  if (title.includes(wanted) || original.includes(wanted)) points += 120;
  if (requestedYear) points += year === requestedYear ? 700 : -350;
  if (item.poster_path) points += 25;

  return points + Math.min(Number(item.popularity || 0), 100) / 10;
}

async function searchTmdb(type, query, year) {
  const url = new URL(`https://api.themoviedb.org/3/search/${type}`);

  url.searchParams.set("api_key", TMDB_API_KEY);
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

  const response = await fetch(url, {
    headers: {
      accept: "application/json",
      Authorization: `Bearer ${TMDB_BEARER}`
    },
    signal: AbortSignal.timeout(15000)
  });

  if (!response.ok) {
    throw new Error(`TMDB respondeu ${response.status}`);
  }

  const payload = await response.json();
  const results = Array.isArray(payload.results) ? payload.results : [];

  if (!results.length) {
    throw new Error("Título não encontrado na TMDB");
  }

  const item = results
    .map(result => ({
      item: result,
      points: score(result, type, query, year)
    }))
    .sort((left, right) => right.points - left.points)[0].item;

  return {
    revision: Date.now(),
    type,
    tmdbId: item.id,
    title: titleOf(item, type) || query,
    year: yearOf(item, type) || year || "",
    typeLabel: type === "tv" ? "Série" : "Filme",
    poster: item.poster_path
      ? `https://image.tmdb.org/t/p/w342${item.poster_path}`
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
      title: value,
      year: ""
    };
  }

  const title = match[1].trim();

  return title
    ? {
        title,
        year: match[2]
      }
    : null;
}

function parseSeries(raw) {
  const value = String(raw || "").trim();

  if (!value) return null;

  const episodeFirst = value.match(
    /^(.*?)\s+(?:EP|E)\s*0*(\d+)\s*(?:[-–—]\s*)?(?:T|TEMP|TEMPORADA)\s*0*(\d+)\s*$/i
  );

  if (episodeFirst) {
    const base = parseTitleAndYear(episodeFirst[1].trim());

    if (!base) return null;

    return {
      ...base,
      episode: Number(episodeFirst[2]),
      season: Number(episodeFirst[3])
    };
  }

  const seasonFirst = value.match(
    /^(.*?)\s+(?:T|TEMP|TEMPORADA)\s*0*(\d+)\s*(?:[-–—]\s*)?(?:EP|E)\s*0*(\d+)\s*$/i
  );

  if (seasonFirst) {
    const base = parseTitleAndYear(seasonFirst[1].trim());

    if (!base) return null;

    return {
      ...base,
      episode: Number(seasonFirst[3]),
      season: Number(seasonFirst[2])
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

async function applyCommand(type, parsed, username) {
  try {
    lastError = null;

    const found = await searchTmdb(type, parsed.title, parsed.year);

    const episodeText =
      type === "tv" && parsed.episode && parsed.season
        ? `EP${parsed.episode} - T${parsed.season}`
        : "";

    const displayTitle = episodeText
      ? `${found.title} ${episodeText}`
      : found.title;

    state = {
      ...found,
      baseTitle: found.title,
      title: displayTitle,
      displayTitle,
      episode: parsed.episode || null,
      season: parsed.season || null,
      updatedBy: username || "chat"
    };

    lastCommand = {
      command: type === "tv" ? "!ts" : "!tf",
      text: displayTitle,
      user: username || "chat",
      at: new Date().toISOString()
    };

    saveState();
    broadcast();

    console.log(`[comando] ${lastCommand.command} -> ${displayTitle}`);
  } catch (error) {
    lastError = error.message;
    console.error("[comando]", error.message);
  }
}

function handleMessage(username, message) {
  lastChatMessage = {
    user: username || "chat",
    text: message,
    at: new Date().toISOString()
  };

  let argument = commandArgument(message, "!tf");

  if (argument !== null) {
    const parsed = parseTitleAndYear(argument);

    if (parsed) {
      applyCommand("movie", parsed, username);
    }

    return;
  }

  argument = commandArgument(message, "!ts");

  if (argument !== null) {
    const parsed = parseSeries(argument);

    if (parsed) {
      applyCommand("tv", parsed, username);
    }
  }
}

function writeIrc(line) {
  if (!socket || socket.destroyed) return;
  socket.write(`${line}\r\n`);
}

function processLine(line) {
  if (!line) return;

  if (line.startsWith("PING")) {
    writeIrc(line.replace(/^PING/, "PONG"));
    return;
  }

  if (line.includes(" RECONNECT")) {
    socket?.destroy();
    return;
  }

  if (/\s001\s/.test(line) && !joined) {
    joined = true;
    writeIrc(`JOIN #${CHANNEL}`);
    console.log(`[twitch] Entrando em #${CHANNEL}`);
    return;
  }

  const match = line.match(
    /^(?:@([^ ]+)\s+)?:([^!]+)![^ ]+\sPRIVMSG\s(#[^ ]+)\s:(.*)$/i
  );

  if (!match) return;

  const tags = parseTags(match[1] || "");
  const username = tags["display-name"] || match[2];
  const channel = match[3].replace(/^#/, "").toLowerCase();
  const message = match[4];

  if (channel !== CHANNEL) return;

  console.log(`[chat] ${username}: ${message}`);
  handleMessage(username, message);
}

function scheduleReconnect() {
  if (reconnectTimer) return;

  const delay = Math.min(
    60000,
    2000 * Math.pow(2, Math.min(reconnectAttempt, 5))
  );

  reconnectAttempt += 1;

  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connectTwitch();
  }, delay);

  console.log(`[twitch] Reconectando em ${Math.ceil(delay / 1000)}s`);
}

function connectTwitch() {
  try {
    socket?.destroy();
  } catch {}

  ircBuffer = "";
  joined = false;

  const nickname = `justinfan${Math.floor(10000 + Math.random() * 89999)}`;

  socket = tls.connect(
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

      console.log(`[twitch] Conectado como ${nickname}`);
    }
  );

  socket.setKeepAlive(true, 30000);
  socket.setTimeout(300000);

  socket.on("data", chunk => {
    ircBuffer += chunk.toString("utf8");

    const lines = ircBuffer.split(/\r?\n/);
    ircBuffer = lines.pop() || "";

    for (const line of lines) {
      processLine(line);
    }
  });

  socket.on("timeout", () => {
    writeIrc(`PING :tela2-${Date.now()}`);
  });

  socket.on("error", error => {
    lastError = error.message;
    console.error("[twitch]", error.message);
  });

  socket.on("close", () => {
    console.error("[twitch] Conexão encerrada");
    scheduleReconnect();
  });
}

function createServer() {
  return http.createServer((request, response) => {
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
        channel: CHANNEL,
        twitchConnected: Boolean(socket && !socket.destroyed),
        joined,
        hasContent: Boolean(state),
        connectedWidgets: streams.size,
        lastChatMessage,
        lastCommand,
        lastError,
        uptimeSeconds: Math.floor(process.uptime())
      });
      return;
    }

    if (url.pathname === "/state") {
      sendJson(response, 200, state);
      return;
    }

    if (url.pathname === "/events") {
      response.writeHead(200, {
        ...commonHeaders("text/event-stream; charset=utf-8"),
        Connection: "keep-alive",
        "X-Accel-Buffering": "no"
      });

      response.write(": conectado\n\n");
      streams.add(response);
      sendEvent(response, state);

      const heartbeat = setInterval(() => {
        try {
          response.write(`: ping ${Date.now()}\n\n`);
        } catch {
          clearInterval(heartbeat);
          streams.delete(response);
        }
      }, 15000);

      request.on("close", () => {
        clearInterval(heartbeat);
        streams.delete(response);
      });

      return;
    }

    sendJson(response, 404, {
      ok: false,
      error: "Rota não encontrada"
    });
  });
}

function runSelfTest() {
  const cases = [
    {
      input: "Elite EP1 - T2",
      expected: {
        title: "Elite",
        episode: 1,
        season: 2
      }
    },
    {
      input: "Elite T2 - EP1",
      expected: {
        title: "Elite",
        episode: 1,
        season: 2
      }
    },
    {
      input: "Elite 2018",
      expected: {
        title: "Elite",
        year: "2018"
      }
    }
  ];

  for (const test of cases) {
    const actual = parseSeries(test.input);

    for (const [key, expectedValue] of Object.entries(test.expected)) {
      if (!actual || actual[key] !== expectedValue) {
        throw new Error(
          `Falha em "${test.input}": ${key} deveria ser ${expectedValue}`
        );
      }
    }
  }

  console.log("[teste] Parser de !ts validado");
}

if (process.argv.includes("--self-test")) {
  runSelfTest();
  process.exit(0);
}

const server = createServer();

server.keepAliveTimeout = 65000;
server.headersTimeout = 66000;
server.requestTimeout = 30000;

server.listen(PORT, "0.0.0.0", () => {
  console.log(`[http] Serviço iniciado na porta ${PORT}`);
  console.log(`[twitch] Canal: ${CHANNEL}`);
  connectTwitch();
});

function shutdown(signal) {
  console.log(`[sistema] Encerrando por ${signal}`);

  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
  }

  try {
    socket?.destroy();
  } catch {}

  server.close(() => process.exit(0));

  setTimeout(() => {
    process.exit(0);
  }, 5000).unref();
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
