#!/usr/bin/env node
/* cable-82 server. Dependency-free: serves the static app and proxies
   ONLY the feeds listed in config.json. The browser asks for
   /api/feed/<id>; the URL is looked up server-side, so no URL ever
   crosses the wire and the proxy cannot be pointed anywhere else.
   The control room reads and writes config.json through /api/config.
   Node >= 18 (built-in fetch). */
"use strict";

const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const SCHEMA = require("./config-schema.js");

const ROOT = __dirname;

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
  ".md": "text/plain; charset=utf-8",
  ".xml": "application/xml; charset=utf-8",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".svg": "image/svg+xml",
  ".mp3": "audio/mpeg",
  ".m4a": "audio/mp4",
  ".aac": "audio/aac",
  ".ogg": "audio/ogg",
  ".oga": "audio/ogg",
  ".opus": "audio/ogg",
  ".wav": "audio/wav",
  ".flac": "audio/flac",
};

const AUDIO_RE = /\.(mp3|m4a|aac|ogg|oga|opus|wav|flac)$/i;

function send(res, code, text) {
  if (res.headersSent) return;
  res.writeHead(code, { "content-type": "text/plain; charset=utf-8" });
  res.end(text || String(code));
}

// Re-read config.json when its mtime changes; keep the last good config if
// the new file is broken so the channel stays on the air. The parsed config
// is run through the shared schema, so the display and the server always
// agree on what the config means.
function makeConfigLoader(configPath) {
  let cache = { key: "", cfg: null };
  return function loadConfig() {
    let key;
    try {
      const st = fs.statSync(configPath);
      key = st.mtimeMs + ":" + st.size; // size too: mtime granularity can miss quick saves
    } catch (e) {
      return cache.cfg;
    }
    if (key !== cache.key) {
      try {
        const raw = JSON.parse(fs.readFileSync(configPath, "utf8"));
        const { ok, cfg } = SCHEMA.validateConfig(raw);
        if (!ok) throw new Error("config failed validation");
        cache = { key, cfg };
      } catch (e) {
        console.error("[cable-82] config.json error: " + e.message + " (keeping last good config)");
        cache.key = key; // do not retry until the file changes again
      }
    }
    return cache.cfg;
  };
}

// Read the request body with a hard size cap, so a giant POST can't exhaust
// memory before we reject it.
function readBody(req, maxBytes) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on("data", (c) => {
      size += c.length;
      if (size > maxBytes) {
        req.destroy();
        reject(new Error("body exceeds " + maxBytes + " byte cap"));
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

async function fetchWithCap(url, timeoutMs, maxBytes) {
  const r = await fetch(url, {
    redirect: "follow",
    signal: AbortSignal.timeout(timeoutMs),
    headers: {
      "user-agent": "cable-82/1.0 (community bulletin board channel)",
      accept: "application/rss+xml, application/atom+xml, application/xml;q=0.9, text/xml;q=0.8, */*;q=0.1",
    },
  });
  if (!r.ok) throw new Error("upstream HTTP " + r.status);
  const reader = r.body.getReader();
  const chunks = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      try { await reader.cancel(); } catch (e) { /* ignore */ }
      throw new Error("feed exceeds " + maxBytes + " byte cap");
    }
    chunks.push(Buffer.from(value));
  }
  return { body: Buffer.concat(chunks), type: r.headers.get("content-type") || "application/xml" };
}

let mockCounter = 0;
function mockBody(id) {
  const dir = path.join(ROOT, "test", "mock-feeds");
  let xml;
  try {
    xml = fs.readFileSync(path.join(dir, id + ".xml"), "utf8");
  } catch (e) {
    xml = fs.readFileSync(path.join(dir, "news.xml"), "utf8");
  }
  // Inject a fresh item each serve so refresh cycles see new content.
  mockCounter++;
  if (xml.includes("</channel>")) {
    xml = xml.replace("</channel>", "<item><title>MOCK UPDATE " + mockCounter + "</title></item></channel>");
  } else if (xml.includes("</feed>")) {
    xml = xml.replace("</feed>", "<entry><title>MOCK UPDATE " + mockCounter + "</title></entry></feed>");
  }
  return Buffer.from(xml);
}

function createApp(opts = {}) {
  const o = Object.assign(
    {
      mock: false,
      chaos: false,
      configPath: path.join(ROOT, "config.json"),
      musicDir: path.join(ROOT, "music"),
      upstreamTimeoutMs: 10000,
      maxFeedBytes: 1024 * 1024,
      maxConfigBytes: 512 * 1024,
      // Open-Meteo: free, no key, no account. Overridable so tests can point
      // at a local mock instead of the real service.
      weatherApiBase: "https://api.open-meteo.com/v1/forecast",
      geocodeApiBase: "https://geocoding-api.open-meteo.com/v1/search",
    },
    opts
  );

  // Seed config.json from the schema defaults on a fresh clone so the
  // channel and the control room both have something to read.
  try {
    fs.statSync(o.configPath);
  } catch (e) {
    try {
      const seed = SCHEMA.validateConfig(SCHEMA.DEFAULT_CONFIG).cfg;
      fs.writeFileSync(o.configPath, JSON.stringify(seed, null, 2) + "\n");
    } catch (e2) {
      console.error("[cable-82] could not seed config.json: " + e2.message);
    }
  }

  const rawLoadConfig = makeConfigLoader(o.configPath);
  const lastGood = new Map(); // feed id -> { body, type }
  let weatherCache = null; // last good normalized weather, so a blip keeps the card up

  // A cheap version token (the file mtime) the display polls to notice a
  // control-room save and reload itself.
  function configVersion() {
    try {
      return fs.statSync(o.configPath).mtimeMs;
    } catch (e) {
      return 0;
    }
  }

  // Validate then atomically replace config.json. Returns { ok, cfg,
  // warnings } or { ok:false, errors }. The write is temp-file + rename so a
  // crash mid-write never leaves a truncated config on the air.
  function writeConfig(raw) {
    const { ok, cfg, errors } = SCHEMA.validateConfig(raw);
    if (!ok) return { ok: false, errors };
    const text = JSON.stringify(cfg, null, 2) + "\n";
    const tmp = o.configPath + ".tmp";
    try {
      fs.writeFileSync(tmp, text);
      fs.renameSync(tmp, o.configPath);
    } catch (e) {
      // Some filesystems refuse rename-over-existing; fall back to a direct
      // write so a save still lands.
      try {
        fs.writeFileSync(o.configPath, text);
        try { fs.unlinkSync(tmp); } catch (e3) { /* tmp may not exist */ }
      } catch (e2) {
        return { ok: false, errors: ["WRITE FAILED: " + e2.message] };
      }
    }
    return { ok: true, cfg, warnings: errors };
  }

  function loadConfig() {
    const cfg = rawLoadConfig();
    if (cfg && Array.isArray(cfg.feeds)) {
      const ids = new Set(cfg.feeds.map((f) => f && f.id));
      for (const k of lastGood.keys()) if (!ids.has(k)) lastGood.delete(k);
    }
    return cfg;
  }

  async function handleFeed(id, res) {
    const cfg = loadConfig();
    if (!cfg || !Array.isArray(cfg.feeds)) return send(res, 500, "CONFIG UNAVAILABLE");
    const feed = cfg.feeds.find((f) => f && f.id === id);
    if (!feed) return send(res, 404, "UNKNOWN FEED ID");

    if (o.mock) {
      if (o.chaos) {
        const roll = Math.random();
        if (roll < 0.25) return send(res, 502, "CHAOS 502");
        if (roll < 0.4) {
          setTimeout(() => send(res, 502, "CHAOS SLOW 502"), 15000);
          return;
        }
      }
      res.writeHead(200, { "content-type": "application/xml; charset=utf-8" });
      return res.end(mockBody(id));
    }

    try {
      const got = await fetchWithCap(feed.url, o.upstreamTimeoutMs, o.maxFeedBytes);
      lastGood.set(id, got);
      res.writeHead(200, { "content-type": got.type });
      res.end(got.body);
    } catch (e) {
      const cached = lastGood.get(id);
      if (cached) {
        res.writeHead(200, { "content-type": cached.type, "x-cable82-stale": "1" });
        return res.end(cached.body);
      }
      send(res, 502, "FEED UNAVAILABLE: " + e.message);
    }
  }

  function handleConfig(req, res) {
    if (req.method === "GET") {
      const cfg = loadConfig();
      if (!cfg) return send(res, 500, "CONFIG UNAVAILABLE");
      res.writeHead(200, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
      return res.end(JSON.stringify({ version: String(configVersion()), config: cfg }));
    }
    if (req.method === "POST") {
      // A custom header a same-origin fetch must set; browsers won't attach
      // it to a cross-site request without a CORS preflight we never grant,
      // so a drive-by page can't rewrite the channel.
      if (req.headers["x-cable82-config"] !== "1") return send(res, 403, "MISSING CONFIG HEADER");
      readBody(req, o.maxConfigBytes)
        .then((body) => {
          let raw;
          try {
            raw = JSON.parse(body);
          } catch (e) {
            return send(res, 400, "INVALID JSON");
          }
          const result = writeConfig(raw);
          if (!result.ok) {
            res.writeHead(400, { "content-type": "application/json; charset=utf-8" });
            return res.end(JSON.stringify({ ok: false, errors: result.errors }));
          }
          res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
          res.end(JSON.stringify({ ok: true, version: String(configVersion()), config: result.cfg, warnings: result.warnings }));
        })
        .catch(() => send(res, 413, "CONFIG BODY TOO LARGE"));
      return;
    }
    return send(res, 405, "METHOD NOT ALLOWED");
  }

  // Geocode a place name into coordinates + timezone for the control room.
  // Only the search string varies; the host and path are fixed here, so this
  // can't be pointed anywhere else.
  async function handleGeocode(query, res) {
    const name = String(query || "").trim().slice(0, 80);
    if (!name) return send(res, 400, "MISSING SEARCH");
    try {
      const url = o.geocodeApiBase + "?name=" + encodeURIComponent(name) + "&count=5&language=en&format=json";
      const got = await fetchWithCap(url, o.upstreamTimeoutMs, o.maxFeedBytes);
      const data = JSON.parse(got.body.toString("utf8"));
      const results = (Array.isArray(data.results) ? data.results : []).map((r) => ({
        name: r.name,
        admin1: r.admin1 || "",
        country: r.country || "",
        latitude: r.latitude,
        longitude: r.longitude,
        timezone: r.timezone || "auto",
      }));
      res.writeHead(200, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
      res.end(JSON.stringify({ results }));
    } catch (e) {
      send(res, 502, "GEOCODE UNAVAILABLE: " + e.message);
    }
  }

  // Fetch current conditions + today's hi/lo/sun for the configured location,
  // normalized to a small shape the display renders. Serves the last good
  // copy if a refresh fails, same as the feed proxy.
  async function handleWeather(res) {
    const cfg = loadConfig();
    const w = cfg && cfg.weather;
    const loc = w && w.location;
    if (!loc || !Number.isFinite(loc.latitude) || !Number.isFinite(loc.longitude)) {
      return send(res, 503, "NO WEATHER LOCATION SET");
    }
    const tempParam = w.tempUnit === "C" ? "celsius" : "fahrenheit";
    const windParam = w.windUnit === "kmh" ? "kmh" : "mph";
    const url =
      o.weatherApiBase +
      "?latitude=" + encodeURIComponent(loc.latitude) +
      "&longitude=" + encodeURIComponent(loc.longitude) +
      "&current=temperature_2m,weather_code,wind_speed_10m" +
      "&daily=temperature_2m_max,temperature_2m_min,sunrise,sunset" +
      "&temperature_unit=" + tempParam +
      "&wind_speed_unit=" + windParam +
      "&timezone=" + encodeURIComponent(loc.timezone || "auto") +
      "&forecast_days=1";
    try {
      const got = await fetchWithCap(url, o.upstreamTimeoutMs, o.maxFeedBytes);
      const data = JSON.parse(got.body.toString("utf8"));
      const cur = data.current || {};
      const daily = data.daily || {};
      const first = (arr) => (Array.isArray(arr) && arr.length ? arr[0] : null);
      const num = (v) => (Number.isFinite(Number(v)) ? Math.round(Number(v)) : null);
      const out = {
        name: loc.name || "",
        tempNow: num(cur.temperature_2m),
        tempUnit: w.tempUnit === "C" ? "C" : "F",
        code: cur.weather_code,
        condition: SCHEMA.weatherText(cur.weather_code),
        wind: num(cur.wind_speed_10m),
        windUnit: w.windUnit === "kmh" ? "KM/H" : "MPH",
        tempHi: num(first(daily.temperature_2m_max)),
        tempLo: num(first(daily.temperature_2m_min)),
        sunrise: first(daily.sunrise),
        sunset: first(daily.sunset),
      };
      weatherCache = out;
      res.writeHead(200, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
      res.end(JSON.stringify(out));
    } catch (e) {
      if (weatherCache) {
        res.writeHead(200, { "content-type": "application/json; charset=utf-8", "x-cable82-stale": "1" });
        return res.end(JSON.stringify(weatherCache));
      }
      send(res, 502, "WEATHER UNAVAILABLE: " + e.message);
    }
  }

  // List the audio files in the music folder (sorted). The display plays
  // them as continuous background music; the control room shows the list.
  function handleMusic(res) {
    let files = [];
    try {
      files = fs.readdirSync(o.musicDir).filter((f) => AUDIO_RE.test(f)).sort();
    } catch (e) {
      /* no music folder yet: an empty playlist is fine */
    }
    const tracks = files.map((f) => ({ file: f, url: "music/" + encodeURIComponent(f) }));
    res.writeHead(200, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
    res.end(JSON.stringify({ tracks }));
  }

  function serveStatic(pathname, res) {
    let p = pathname === "/" ? "/index.html" : pathname;
    if (p === "/config") p = "/config.html"; // friendly control-room URL
    const segments = p.split("/").filter(Boolean);
    // No parent traversal, no dotfiles (.git, .meta, ...).
    if (!segments.length || segments.some((s) => s === ".." || s.startsWith("."))) {
      return send(res, 403, "FORBIDDEN");
    }
    const fp = path.normalize(path.join(ROOT, ...segments));
    if (!fp.startsWith(ROOT + path.sep)) return send(res, 403, "FORBIDDEN");
    fs.readFile(fp, (err, buf) => {
      if (err) return send(res, 404, "NOT FOUND");
      res.writeHead(200, {
        "content-type": MIME[path.extname(fp).toLowerCase()] || "application/octet-stream",
        "cache-control": "no-cache",
      });
      res.end(buf);
    });
  }

  const server = http.createServer((req, res) => {
    try {
      const u = new URL(req.url, "http://localhost");
      const pathname = decodeURIComponent(u.pathname);
      if (pathname === "/api/config") {
        handleConfig(req, res);
        return;
      }
      if (pathname === "/api/weather") {
        handleWeather(res).catch((e) => send(res, 500, "SERVER ERROR: " + e.message));
        return;
      }
      if (pathname === "/api/geocode") {
        handleGeocode(u.searchParams.get("q"), res).catch((e) => send(res, 500, "SERVER ERROR: " + e.message));
        return;
      }
      if (pathname === "/api/music") {
        handleMusic(res);
        return;
      }
      if (pathname.startsWith("/api/feed/")) {
        const id = pathname.slice("/api/feed/".length);
        handleFeed(id, res).catch((e) => send(res, 500, "SERVER ERROR: " + e.message));
        return;
      }
      serveStatic(pathname, res);
    } catch (e) {
      send(res, 400, "BAD REQUEST");
    }
  });
  server.loadConfig = loadConfig;
  return server;
}

function parseArgs(argv) {
  const args = { mock: false, chaos: false, port: null };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--mock") args.mock = true;
    else if (argv[i] === "--chaos") { args.chaos = true; args.mock = true; }
    else if (argv[i] === "--port") args.port = Number(argv[++i]) || null;
  }
  return args;
}

if (require.main === module) {
  const args = parseArgs(process.argv.slice(2));
  const server = createApp(args);
  const cfg = server.loadConfig() || {};
  const port = args.port || Number(cfg.port) || 1982;
  server.on("error", (e) => {
    if (e.code === "EADDRINUSE") {
      console.error("PORT " + port + " IS ALREADY IN USE - IS CABLE 82 ALREADY ON THE AIR? (try --port <n>)");
      process.exit(1);
    }
    throw e;
  });
  server.listen(port, () => {
    console.log(
      "CABLE 82 broadcasting on http://localhost:" + port +
      (args.mock ? "  [mock feeds]" : "") +
      (args.chaos ? "  [chaos on]" : "")
    );
  });
}

module.exports = { createApp };
