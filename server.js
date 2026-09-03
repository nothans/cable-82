#!/usr/bin/env node
/* cable-82 server. Dependency-free: serves the static app and proxies
   ONLY the feeds listed in config.json. The browser asks for
   /api/feed/<id>; the URL is looked up server-side, so no URL ever
   crosses the wire and the proxy cannot be pointed anywhere else.
   The control room reads and writes config.json through /api/config.
   Node >= 18 (built-in fetch). */
"use strict";

// Node older than 18 cannot load this file at all: it has no `node:` module
// prefix (Node 12) or no built-in fetch (Node 16), and the error it dies
// with ("Cannot find module 'node:http'") tells nobody what went wrong.
// Raspberry Pi OS Bullseye ships Node 12 from apt. Say it in plain words,
// before anything else runs. Keep this block free of syntax Node 10 or 12
// cannot parse, or they crash before reaching it.
const NODE_MAJOR = Number(String(process.versions.node).split(".")[0]);
if (NODE_MAJOR < 18) {
  process.stderr.write(
    "\n" +
    "CABLE 82 needs Node.js 18 or newer. This is Node v" + process.versions.node + ".\n" +
    "\n" +
    "On a Raspberry Pi (or any Debian/Ubuntu machine), install a current Node.js:\n" +
    "\n" +
    "  curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -\n" +
    "  sudo apt-get install -y nodejs\n" +
    "\n" +
    "Then check with `node -v` and run `node server.js` again.\n" +
    "\n"
  );
  process.exit(1);
}

const http = require("node:http");
const os = require("node:os");
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { pipeline } = require("node:stream");
const { execFileSync } = require("node:child_process");
const SCHEMA = require("./config-schema.js");
const { readMp4Title } = require("./media-meta.js");

const ROOT = __dirname;

// The display's build: a hash of the files the kiosk runs, taken once at
// startup. After `git pull` and a service restart the display reconnects to
// the bus, sees a different token in the hello, and reloads onto the new
// files by itself. Nobody has to touch the TV.
const DISPLAY_FILES = [
  "index.html", "style.css", "config-schema.js",
  "dial.js", "board.js", "guide.js", "video.js", "tuner.js", "app.js",
];
function displayBuild() {
  const h = crypto.createHash("sha1");
  for (const f of DISPLAY_FILES) {
    try {
      h.update(fs.readFileSync(path.join(ROOT, f)));
    } catch (e) {
      h.update(f);
    }
  }
  return h.digest("hex").slice(0, 12);
}
const DISPLAY_BUILD = displayBuild();

const REPO_URL = "https://github.com/nothans/cable-82";

// What release is this? `git describe` names the tag when the checkout sits on
// one (v0.4.0), and says how far past it we are otherwise
// (v0.4.0-3-gabc1234, plus -dirty for local edits). A zip download has no .git
// and no answer, so the control room says "unknown version" rather than
// pretending. Read once at startup: it cannot change without a restart, and
// the release check on the roadmap wants the same fact.
function releaseVersion() {
  const git = (args) =>
    execFileSync("git", args, { cwd: ROOT, encoding: "utf8", timeout: 2000, stdio: ["ignore", "pipe", "ignore"] }).trim();
  try {
    // Git searches upwards, so a copy of this folder sitting inside somebody
    // else's repo would answer with that repo's tags. Only trust the answer
    // when the checkout root is this folder.
    const top = path.resolve(git(["rev-parse", "--show-toplevel"]));
    if (top.toLowerCase() !== path.resolve(ROOT).toLowerCase()) return null;
    return git(["describe", "--tags", "--dirty", "--always"]) || null;
  } catch (e) {
    return null;
  }
}
const VERSION = releaseVersion();

// Is this a Raspberry Pi, and may we power it down without a password? Both
// have to be true before the control room offers the buttons: a machine that
// cannot answer for itself should not be told to switch off.
function hostModel() {
  for (const f of ["/proc/device-tree/model", "/sys/firmware/devicetree/base/model"]) {
    try {
      // The device tree NUL-terminates the string.
      const raw = fs.readFileSync(f, "utf8").replace(/\0/g, "").trim();
      if (raw) return raw;
    } catch (e) {
      /* not a device-tree machine */
    }
  }
  return null;
}
const HOST_MODEL = hostModel();
const IS_PI = /raspberry pi/i.test(HOST_MODEL || "");
// Asked once, the first time anyone needs the answer: sudo rights do not
// come and go while the station is on the air, and spawning sudo on every
// request would be silly. A change needs a restart, like the port does.
let powerAllowed = null;
function canPowerOff() {
  if (powerAllowed === null) {
    powerAllowed = false;
    if (IS_PI && process.platform === "linux") {
      try {
        execFileSync("sudo", ["-n", "true"], { timeout: 2000, stdio: "ignore" });
        powerAllowed = true;
      } catch (e) {
        /* no passwordless sudo: the buttons stay hidden */
      }
    }
  }
  return powerAllowed;
}
// A clean checkout of a release: safe to link straight at that release's page.
const RELEASE_TAG = VERSION && /^v\d+\.\d+\.\d+$/.test(VERSION) ? VERSION : null;

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
  ".mp4": "video/mp4",
  ".m4v": "video/mp4",
  ".webm": "video/webm",
  ".ogv": "video/ogg",
  ".mov": "video/quicktime",
};

const AUDIO_RE = /\.(mp3|m4a|aac|ogg|oga|opus|wav|flac)$/i;
const VIDEO_RE = /\.(mp4|m4v|webm|ogv|mov)$/i;

// The running order of a folder is the schema's natural sort: the display
// sorts with the same function, so both sides agree on what airs first.
const naturalCompare = SCHEMA.naturalCompare;

// RFC 9110: a 405 names the methods that would have worked.
function send405(res, allow) {
  res.writeHead(405, { "content-type": "text/plain; charset=utf-8", allow });
  res.end("METHOD NOT ALLOWED");
}

function send(res, code, text) {
  if (res.headersSent) return;
  res.writeHead(code, { "content-type": "text/plain; charset=utf-8" });
  res.end(text || String(code));
}

// Where a JSON parse failed, as a line and column: what a person with the
// file open in an editor needs. V8 words its errors three ways: with a
// position ("... at position 812"), with a snippet of the text around the
// fault ('Unexpected token ',', ..."tagline": ,\n}" is not valid JSON'), or
// with neither ("Unexpected end of JSON input"). The first two can be turned
// into a line and column; the third is already the whole story.
function describeJsonError(text, e) {
  const lineCol = (pos) => {
    const before = text.slice(0, pos);
    return "line " + before.split("\n").length + ", column " + (pos - before.lastIndexOf("\n"));
  };
  const msg = e.message;
  const byPosition = /position (\d+)/.exec(msg);
  if (byPosition) return msg.replace(/ in JSON at position \d+.*$/, "") + " at " + lineCol(Number(byPosition[1]));
  const bySnippet = /^Unexpected token (.+?), (\.\.\.)?"([\s\S]*)"(\.\.\.)? is not valid JSON$/.exec(msg);
  if (bySnippet) {
    const token = bySnippet[1].replace(/^'|'$/g, "");
    const snippet = bySnippet[3].replace(/\\n/g, "\n").replace(/\\t/g, "\t").replace(/\\"/g, '"').replace(/\\\\/g, "\\");
    const at = text.indexOf(snippet);
    if (at >= 0) {
      // the token V8 tripped on is the last one in the snippet's leading half
      const inSnippet = snippet.indexOf(token, Math.max(0, Math.min(snippet.length - 1, 10) - token.length));
      const pos = at + (inSnippet >= 0 ? inSnippet : 0);
      return "unexpected " + JSON.stringify(token) + " at " + lineCol(pos);
    }
  }
  return msg;
}

// Re-read config.json when its mtime changes; keep the last good config if
// the new file is broken so the channel stays on the air. The parsed config
// is run through the shared schema, so the display and the server always
// agree on what the config means. A broken file is remembered as an error
// (`loadConfig.error`) so the display and the control room can say so,
// rather than the log being the only place that knows.
function makeConfigLoader(configPath) {
  let cache = { key: "", cfg: null };
  function loadConfig() {
    let key;
    try {
      const st = fs.statSync(configPath);
      key = st.mtimeMs + ":" + st.size; // size too: mtime granularity can miss quick saves
    } catch (e) {
      return cache.cfg;
    }
    if (key !== cache.key) {
      const text = fs.readFileSync(configPath, "utf8");
      try {
        const raw = JSON.parse(text);
        const { ok, cfg, errors } = SCHEMA.validateConfig(raw);
        if (!ok) throw new Error(errors.join("; "));
        cache = { key, cfg };
        loadConfig.error = null;
      } catch (e) {
        const detail = e instanceof SyntaxError ? describeJsonError(text, e) : e.message;
        loadConfig.error = { message: "config.json could not be read: " + detail, since: new Date().toISOString() };
        console.error("[cable-82] " + loadConfig.error.message + (cache.cfg ? " (keeping the last good config on the air)" : ""));
        cache.key = key; // do not retry until the file changes again
      }
    }
    return cache.cfg;
  }
  loadConfig.error = null;
  return loadConfig;
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
      channelsDir: path.join(ROOT, "channels"),
      // Extra places to look for a channels folder (--media), on top of the
      // drives found by the scan below.
      mediaDirs: [],
      // Where drives turn up: Linux mounts them under /media or /mnt, macOS
      // under /Volumes. Overridable so a test can point the scan at a
      // fixture instead of the machine's real drives; empty means do not look.
      mediaScanDirs: ["/media", "/mnt", "/Volumes"],
      // Set by tests to capture the power commands instead of running them.
      powerRun: null,
      upstreamTimeoutMs: 10000,
      maxFeedBytes: 1024 * 1024,
      maxConfigBytes: 512 * 1024,
      // Open-Meteo: free, no key, no account. Overridable so tests can point
      // at a local mock instead of the real service.
      weatherApiBase: "https://api.open-meteo.com/v1/forecast",
      geocodeApiBase: "https://geocoding-api.open-meteo.com/v1/search",
      // CheerLights (cheerlights.com): the latest global color, one JSON fetch.
      cheerlightsApiBase: "https://api.thingspeak.com/channels/1417/feeds/last.json",
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
  let cheerCache = null; // last good CheerLights color, same idea

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
      const problem = rawLoadConfig.error;
      if (!cfg) {
        // Nothing good to serve. Say why in a shape the display and the
        // control room can show, so a broken hand edit is not mistaken for
        // a server that is down.
        res.writeHead(500, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
        return res.end(JSON.stringify({ ok: false, error: problem ? problem.message : "config.json could not be read", since: problem && problem.since }));
      }
      res.writeHead(200, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
      const out = { version: String(configVersion()), config: cfg };
      // The file on disk is broken but the last good settings are on the
      // air: the room shows this and a Save writes a good file over it.
      if (problem) out.warning = problem.message + ". The last good settings are on the air; Save from here to write a good file over it.";
      return res.end(JSON.stringify(out));
    }
    if (req.method === "POST") {
      // A custom header a same-origin fetch must set; browsers won't attach
      // it to a cross-site request without a CORS preflight we never grant,
      // so a drive-by page can't rewrite the channel.
      if (req.headers["x-cable82-config"] !== "1") return send(res, 403, "MISSING CONFIG HEADER");
      // Optional optimistic lock: if the control room says which version it
      // loaded and the file has moved since (a hand edit, another tab), refuse
      // the stale save instead of silently clobbering the newer config.
      const saidVersion = req.headers["x-cable82-config-version"];
      if (saidVersion && saidVersion !== String(configVersion())) {
        res.writeHead(409, { "content-type": "application/json; charset=utf-8" });
        return res.end(JSON.stringify({ ok: false, conflict: true, version: String(configVersion()) }));
      }
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
          // Tell every connected display immediately; the poll stays as the
          // fallback for a display that connected before SSE existed.
          sseBroadcast("config", { version: String(configVersion()) });
        })
        .catch(() => send(res, 413, "CONFIG BODY TOO LARGE"));
      return;
    }
    return send405(res, "GET, POST");
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

  // The latest CheerLights color (cheerlights.com): one global color anyone
  // in the world can set. Fetched server-side like everything else, last
  // good copy kept so a blip never blanks the ticker item.
  async function handleCheerlights(res) {
    const cfg = loadConfig();
    if (!cfg || !cfg.cheerlights || !cfg.cheerlights.enabled) {
      return send(res, 503, "CHEERLIGHTS NOT ENABLED");
    }
    try {
      const got = await fetchWithCap(o.cheerlightsApiBase, o.upstreamTimeoutMs, o.maxFeedBytes);
      const data = JSON.parse(got.body.toString("utf8"));
      const color = String(data.field1 || "").trim().toLowerCase().slice(0, 24);
      if (!color || !/^[a-z]+$/.test(color)) throw new Error("no color in feed");
      // The name is all the crawl uses: it scrolls the word, not a swatch.
      const out = { color };
      cheerCache = out;
      res.writeHead(200, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
      res.end(JSON.stringify(out));
    } catch (e) {
      if (cheerCache) {
        res.writeHead(200, { "content-type": "application/json; charset=utf-8", "x-cable82-stale": "1" });
        return res.end(JSON.stringify(cheerCache));
      }
      send(res, 502, "CHEERLIGHTS UNAVAILABLE: " + e.message);
    }
  }

  // ---------------- channels (the dial's video folders)

  // Per-folder duration cache, kept beside the videos as .durations.json.
  // The server never probes media itself (dependency-free); the display
  // learns each file's duration once from the <video> metadata and posts it
  // back, so the cache fills itself on first play and then stays.
  // ---------------------------------------------------------- where channels live
  //
  // A channel is a folder of video. The bundled one is channels/ next to the
  // server, but a 16 GB card fills up fast and a library does not have to live
  // on it: plug in a drive, put a channels/ folder at the top of it, and its
  // folders join the same pool under the same names. Removable media is
  // scanned (Linux mounts them under /media or /mnt, macOS under /Volumes),
  // and --media adds any other path, a NAS mount included.
  let rootsCache = { at: 0, roots: [] };

  function mediaCandidates() {
    const out = [];
    for (const base of o.mediaScanDirs) {
      let entries = [];
      try {
        entries = fs.readdirSync(base);
      } catch (e) {
        continue; // that base does not exist on this machine
      }
      for (const name of entries) {
        const dir = path.join(base, name);
        out.push(dir);
        // Linux desktops mount per user: /media/<user>/<label>.
        try {
          if (fs.statSync(dir).isDirectory()) {
            for (const sub of fs.readdirSync(dir)) out.push(path.join(dir, sub));
          }
        } catch (e) {
          /* unreadable mount point, skip it */
        }
      }
    }
    return out;
  }

  // Every root that actually holds a channels folder right now, the built-in
  // one first so a local folder always wins a name it shares with a drive.
  // Cached for a few seconds: a drive can come and go, but not that fast, and
  // this runs on every listing.
  function channelRoots() {
    const now = Date.now();
    if (now - rootsCache.at < 5000) return rootsCache.roots;
    const roots = [{ dir: o.channelsDir, volume: "" }];
    const seen = new Set([path.resolve(o.channelsDir)]);
    const add = (dir, volume) => {
      const abs = path.resolve(dir);
      if (seen.has(abs)) return false;
      try {
        if (!fs.statSync(abs).isDirectory()) return false;
      } catch (e) {
        return false;
      }
      seen.add(abs);
      roots.push({ dir: abs, volume });
      return true;
    };
    // A drive earns a place by carrying a channels folder, and nothing else:
    // every mount point is a directory, so without that rule a plugged-in
    // drive would offer its whole contents as channels.
    for (const mount of mediaCandidates()) add(path.join(mount, "channels"), path.basename(mount));
    // A path named with --media is a deliberate choice, so it may be the
    // channels folder itself.
    for (const dir of o.mediaDirs || []) {
      if (!add(path.join(dir, "channels"), path.basename(dir))) add(dir, path.basename(dir));
    }
    rootsCache = { at: now, roots };
    return roots;
  }

  // The directory a folder name resolves to, and which volume it came from.
  // Names stay single safe segments, so a config written before any of this
  // means exactly what it always did.
  function resolveFolder(name) {
    if (!safeFolder(name)) return null;
    for (const root of channelRoots()) {
      const dir = path.join(root.dir, name);
      if (!dir.startsWith(root.dir + path.sep)) continue; // belt and braces
      try {
        if (fs.statSync(dir).isDirectory()) return { dir, volume: root.volume };
      } catch (e) {
        /* not on this root */
      }
    }
    return null;
  }

  function readDurations(dir) {
    try {
      const raw = JSON.parse(fs.readFileSync(path.join(dir, ".durations.json"), "utf8"));
      return raw && typeof raw === "object" ? raw : {};
    } catch (e) {
      return {};
    }
  }

  // One safe path segment under channels/ - the schema's rule, not a copy
  // of it, so the two can never drift apart.
  function safeFolder(name) {
    return typeof name === "string" && SCHEMA.FOLDER_RE.test(name) && !name.includes("..");
  }

  // The titles written inside a folder's files, read once each and kept
  // beside the videos as .titles.json (null for a file with none). Only a
  // channel set to show titles from its files asks; a folder of two hundred
  // files is walked once, header by header, and never again.
  function readTitles(dir, names) {
    const cachePath = path.join(dir, ".titles.json");
    let cache = {};
    try {
      const raw = JSON.parse(fs.readFileSync(cachePath, "utf8"));
      if (raw && typeof raw === "object") cache = raw;
    } catch (e) {
      /* no cache yet */
    }
    let learned = 0;
    for (const f of names) {
      if (f in cache) continue;
      cache[f] = /\.(mp4|m4v|mov)$/i.test(f) ? readMp4Title(path.join(dir, f)) : null;
      learned++;
    }
    if (learned) {
      try {
        fs.writeFileSync(cachePath, JSON.stringify(cache, null, 2) + "\n");
      } catch (e) {
        /* a read-only drive: the titles are still served, just re-read next time */
      }
    }
    return cache;
  }

  // The playlist of one folder that has already been resolved to a
  // directory: the files in airing order, each with its cached duration,
  // and the title inside it when the channel wants those.
  function listFiles(folder, dir, withTitles) {
    const durations = readDurations(dir);
    let names = [];
    try {
      names = fs.readdirSync(dir).filter((f) => VIDEO_RE.test(f)).sort(naturalCompare);
    } catch (e) {
      return null;
    }
    const titles = withTitles ? readTitles(dir, names) : null;
    return names.map((f) => {
      const entry = {
        file: f,
        url: "channels/" + encodeURIComponent(folder) + "/" + encodeURIComponent(f),
        duration: Number.isFinite(durations[f]) ? durations[f] : null,
      };
      if (titles) entry.title = typeof titles[f] === "string" ? titles[f] : null;
      return entry;
    });
  }

  // The same for a folder named in the config, wherever it lives.
  function listChannelFiles(folder, withTitles) {
    const found = resolveFolder(folder);
    return found ? listFiles(folder, found.dir, withTitles) : null; // null: missing on every root
  }

  // GET /api/channels: every folder under channels/ (for the control room's
  // picker) plus the playlist for each configured video channel (for the
  // display). One endpoint, one scan, both consumers.
  function handleChannels(res) {
    const folders = [];
    const listed = new Set();
    for (const root of channelRoots()) {
      let names = [];
      try {
        names = fs.readdirSync(root.dir).sort(naturalCompare);
      } catch (e) {
        continue; // no channels folder on this root: nothing to add
      }
      for (const name of names) {
        if (!safeFolder(name) || listed.has(name)) continue;
        const dir = path.join(root.dir, name);
        try {
          if (!fs.statSync(dir).isDirectory()) continue;
        } catch (e) {
          continue;
        }
        listed.add(name);
        const files = listFiles(name, dir) || [];
        const known = files.filter((f) => f.duration != null);
        folders.push({
          folder: name,
          volume: root.volume,
          files: files.length,
          seconds: Math.round(known.reduce((a, f) => a + f.duration, 0)),
          probed: known.length,
        });
      }
    }
    folders.sort((a, b) => naturalCompare(a.folder, b.folder));
    const cfg = loadConfig();
    const channels = [];
    for (const ch of (cfg && cfg.channels) || []) {
      if (ch.type !== "video") continue;
      const entry = { number: ch.number, folder: ch.folder, files: listChannelFiles(ch.folder, ch.titles === "metadata") || [] };
      // A programmed channel carries its spots too: one fetch gives the
      // display everything the composite timeline is built from.
      if (ch.breaks) entry.breaks = { folder: ch.breaks.folder, files: listChannelFiles(ch.breaks.folder) || [] };
      channels.push(entry);
    }
    res.writeHead(200, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
    res.end(JSON.stringify({ folders, channels }));
  }

  // POST /api/channels/durations {folder, durations:{file:seconds}} - the
  // display reporting what it measured. Guarded like a config write, and
  // only files that actually exist in the folder are recorded.
  function handleDurations(req, res) {
    if (req.method !== "POST") return send405(res, "POST");
    if (req.headers["x-cable82-config"] !== "1") return send(res, 403, "MISSING CONFIG HEADER");
    readBody(req, 256 * 1024)
      .then((body) => {
        let raw;
        try {
          raw = JSON.parse(body);
        } catch (e) {
          return send(res, 400, "INVALID JSON");
        }
        const folder = raw && raw.folder;
        if (!safeFolder(folder)) return send(res, 400, "BAD FOLDER");
        const found = resolveFolder(folder);
        if (!found) return send(res, 404, "UNKNOWN FOLDER");
        const dir = found.dir;
        let names;
        try {
          names = new Set(fs.readdirSync(dir).filter((f) => VIDEO_RE.test(f)));
        } catch (e) {
          return send(res, 404, "UNKNOWN FOLDER");
        }
        const cache = readDurations(dir);
        let wrote = 0;
        const entries = raw.durations && typeof raw.durations === "object" ? raw.durations : {};
        for (const [file, dur] of Object.entries(entries)) {
          const d = Number(dur);
          if (!names.has(file) || !Number.isFinite(d) || d <= 0 || d > 24 * 3600) continue;
          cache[file] = Math.round(d * 100) / 100;
          wrote++;
        }
        try {
          fs.writeFileSync(path.join(dir, ".durations.json"), JSON.stringify(cache, null, 2) + "\n");
        } catch (e) {
          return send(res, 500, "CACHE WRITE FAILED: " + e.message);
        }
        res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ ok: true, wrote }));
      })
      .catch(() => send(res, 413, "BODY TOO LARGE"));
  }

  // ---------------- the tuner bus (events, not state)

  // Sources send events - up, down, set - and the display applies each one
  // once, tracked by sequence number. The server never asserts a current
  // channel, so an HTTP source can never fight the gamepad. Learned the hard
  // way: a source that re-declares "the channel is X" overrides every local
  // tune a second later.
  const sseClients = new Set();
  let tuneSeq = 0;
  let lastTune = null;
  // The four keys of a 1960s remote plus a direct dial: up/down step the
  // dial, set jumps to a number, volume steps the sound (loud, off, soft,
  // medium, loud), power toggles the picture off and on. Each is an event
  // the display interprets; the server never holds a channel or a level.
  const TUNE_CMDS = ["up", "down", "set", "volume", "power"];

  function sseBroadcast(event, data) {
    const msg = "event: " + event + "\ndata: " + JSON.stringify(data) + "\n\n";
    for (const client of sseClients) {
      try {
        client.write(msg);
      } catch (e) {
        sseClients.delete(client);
      }
    }
  }

  function handleTune(req, res) {
    const cfg = loadConfig();
    if (!cfg || !cfg.tuner.sources.http) return send(res, 403, "HTTP TUNING IS DISABLED");
    if (req.method === "GET") {
      res.writeHead(200, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
      return res.end(JSON.stringify({ seq: tuneSeq, last: lastTune, listeners: sseClients.size }));
    }
    if (req.method !== "POST") return send405(res, "GET, POST");
    readBody(req, 4096)
      .then((body) => {
        let raw;
        try {
          raw = JSON.parse(body);
        } catch (e) {
          return send(res, 400, "INVALID JSON");
        }
        const cmd = raw && raw.cmd;
        if (!TUNE_CMDS.includes(cmd)) return send(res, 400, "CMD MUST BE up, down, set, volume, OR power");
        const evt = { seq: ++tuneSeq, cmd };
        if (cmd === "set") {
          const n = Math.round(Number(raw.channel));
          if (!Number.isFinite(n) || n < 0 || n > 999) return send(res, 400, "SET NEEDS A CHANNEL NUMBER (0-999)");
          evt.channel = n;
        }
        lastTune = evt;
        sseBroadcast("tune", evt);
        res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ ok: true, seq: evt.seq, listeners: sseClients.size }));
      })
      .catch(() => send(res, 413, "BODY TOO LARGE"));
  }

  // GET /api/events: the display's ear. Server-Sent Events - plain HTTP,
  // no dependency, and the browser reconnects by itself, which matters on a
  // box that runs for weeks. A comment ping every 25s keeps middleboxes from
  // closing the idle stream.
  //
  // The hello carries two tokens the display compares against what it
  // booted with: `build` (the display files) and `config` (config.json's
  // version). Either one different after a reconnect means the world moved
  // while the stream was down - a git pull, a hand edit during a restart -
  // and the display reloads. That is what makes a poll unnecessary.
  function handleEvents(req, res) {
    res.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-store",
      connection: "keep-alive",
    });
    res.on("error", () => { /* dead socket: the close handler cleans up */ });
    res.write(": cable-82 tuner bus\n\n");
    const hello = { seq: tuneSeq, build: DISPLAY_BUILD, config: String(configVersion()) };
    res.write("event: hello\ndata: " + JSON.stringify(hello) + "\n\n");
    sseClients.add(res);
    const ping = setInterval(() => {
      try {
        res.write(": ping\n\n");
      } catch (e) {
        /* cleanup happens on close */
      }
    }, 25000);
    req.on("close", () => {
      clearInterval(ping);
      sseClients.delete(res);
    });
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

  // Restarting and switching off the machine the station runs on. Pulling the
  // power on a Pi mid-write is how an SD card dies, so both paths do what the
  // runbook does by hand: stop the station cleanly, flush the disks, and only
  // then hand over to systemd.
  const POWER_STEPS = {
    restart: ["systemctl", "reboot"],
    shutdown: ["systemctl", "poweroff"],
  };

  function handleSystem(req, res) {
    if (req.method === "GET") {
      res.writeHead(200, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
      return res.end(JSON.stringify({
        model: HOST_MODEL,
        pi: IS_PI,
        // Only offered where it can actually be done, so a button never
        // appears that would fail on the press.
        power: o.powerRun ? true : canPowerOff(),
      }));
    }
    if (req.method !== "POST") return send405(res, "GET, POST");
    // Same guard as a config save: a browser will not attach this header to a
    // cross-site request, so a page you happen to be visiting cannot use it.
    if (req.headers["x-cable82-config"] !== "1") return send(res, 403, "MISSING CONFIG HEADER");
    readBody(req, 1024)
      .then((body) => {
        let raw;
        try {
          raw = JSON.parse(body);
        } catch (e) {
          return send(res, 400, "INVALID JSON");
        }
        const cmd = raw && raw.cmd;
        if (!POWER_STEPS[cmd]) return send(res, 400, "CMD MUST BE restart OR shutdown");
        if (!o.powerRun && !canPowerOff()) return send(res, 403, "THIS MACHINE CANNOT BE POWERED FROM HERE");
        const run = o.powerRun || ((args) => execFileSync("sudo", ["-n", ...args], { timeout: 20000, stdio: "ignore" }));
        res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ ok: true, cmd }));
        // Answer first, act after: the control room needs the reply before the
        // machine stops being able to send one.
        setTimeout(() => {
          try {
            run(["systemctl", "stop", "cable82"]);
          } catch (e) {
            /* not running under systemd, or already stopped: keep going */
          }
          try {
            run(["sync"]);
          } catch (e) {
            /* best effort */
          }
          try {
            run(POWER_STEPS[cmd]);
          } catch (e) {
            /* nothing left to report to: the socket is going away */
          }
        }, 400);
      })
      .catch(() => send(res, 400, "BAD REQUEST"));
  }

  // ---------------- vitals: how the machine is doing
  // What a person checking on a Pi in a closet wants to know without a
  // shell: how long it has been up, how warm it is, whether it is starving
  // for power, memory, or disk. Read from /proc, /sys, and the OS; nothing
  // that needs a package. Fields a machine cannot answer are null.

  function readMeminfo() {
    try {
      const text = fs.readFileSync("/proc/meminfo", "utf8");
      const kb = (key) => {
        const m = new RegExp("^" + key + ":\\s+(\\d+)", "m").exec(text);
        return m ? Number(m[1]) * 1024 : null;
      };
      return { available: kb("MemAvailable"), swapTotal: kb("SwapTotal"), swapFree: kb("SwapFree") };
    } catch (e) {
      return {};
    }
  }

  function cpuTemperature() {
    for (const f of ["/sys/class/thermal/thermal_zone0/temp", "/sys/class/hwmon/hwmon0/temp1_input"]) {
      try {
        const v = Number(fs.readFileSync(f, "utf8").trim());
        if (Number.isFinite(v)) return Math.round((v > 1000 ? v / 1000 : v) * 10) / 10;
      } catch (e) {
        /* next */
      }
    }
    return null;
  }

  // vcgencmd get_throttled, decoded. The low bits say what is happening
  // now; bits 16 up say what has happened since boot. Asked at most every
  // ten seconds: it spawns a process.
  let throttledCache = { at: 0, value: null };
  function throttledFlags() {
    if (!IS_PI) return null;
    if (Date.now() - throttledCache.at < 10000) return throttledCache.value;
    let value = null;
    try {
      const out = execFileSync("vcgencmd", ["get_throttled"], { encoding: "utf8", timeout: 2000, stdio: ["ignore", "pipe", "ignore"] });
      const m = /0x([0-9a-f]+)/i.exec(out);
      if (m) {
        const bits = parseInt(m[1], 16);
        value = {
          raw: "0x" + bits.toString(16),
          underVoltageNow: !!(bits & 0x1),
          frequencyCappedNow: !!(bits & 0x2),
          throttledNow: !!(bits & 0x4),
          softTempLimitNow: !!(bits & 0x8),
          underVoltageSinceBoot: !!(bits & 0x10000),
          frequencyCappedSinceBoot: !!(bits & 0x20000),
          throttledSinceBoot: !!(bits & 0x40000),
          softTempLimitSinceBoot: !!(bits & 0x80000),
        };
      }
    } catch (e) {
      /* no vcgencmd here */
    }
    throttledCache = { at: Date.now(), value };
    return value;
  }

  function diskSpace(dir) {
    if (typeof fs.statfsSync !== "function") return null; // Node before 18.15
    try {
      const s = fs.statfsSync(dir);
      return { totalBytes: s.bsize * s.blocks, freeBytes: s.bsize * s.bavail };
    } catch (e) {
      return null;
    }
  }

  function handleVitals(res) {
    const mem = readMeminfo();
    const total = os.totalmem();
    const free = mem.available != null ? mem.available : os.freemem();
    const disks = [];
    const seen = new Set();
    const addDisk = (dir, label) => {
      const space = diskSpace(dir);
      if (!space) return;
      const key = space.totalBytes + ":" + space.freeBytes;
      if (seen.has(key)) return; // the same volume under two paths
      seen.add(key);
      disks.push({ label, path: dir, totalBytes: space.totalBytes, freeBytes: space.freeBytes });
    };
    addDisk(ROOT, IS_PI ? "the card" : "the checkout");
    for (const root of channelRoots()) if (root.volume) addDisk(root.dir, root.volume);
    const out = {
      host: { name: os.hostname(), model: HOST_MODEL, pi: IS_PI, platform: process.platform, arch: process.arch, node: process.versions.node },
      uptimeSec: Math.round(os.uptime()),
      station: { uptimeSec: Math.round(process.uptime()), version: VERSION, build: DISPLAY_BUILD, pid: process.pid },
      load: os.loadavg().map((n) => Math.round(n * 100) / 100),
      cpu: { count: os.cpus().length, temperatureC: cpuTemperature(), throttled: throttledFlags() },
      memory: { totalBytes: total, freeBytes: free, usedPercent: Math.round(((total - free) / total) * 100) },
      swap: mem.swapTotal != null ? { totalBytes: mem.swapTotal, freeBytes: mem.swapFree } : null,
      disks,
      listeners: sseClients.size,
      at: new Date().toISOString(),
    };
    res.writeHead(200, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
    res.end(JSON.stringify(out));
  }

  function serveStatic(pathname, res, rangeHeader) {
    let p = pathname === "/" ? "/index.html" : pathname;
    if (p === "/config") p = "/config.html"; // friendly control-room URL
    if (p === "/remote-control") p = "/remote-control.html"; // the clicker
    const segments = p.split("/").filter(Boolean);
    // No parent traversal, no dotfiles (.git, .meta, .durations.json, ...).
    if (!segments.length || segments.some((s) => s === ".." || s.startsWith("."))) {
      return send(res, 403, "FORBIDDEN");
    }
    let fp;
    if (segments.length === 3 && segments[0] === "channels") {
      // channels/<folder>/<file> resolves through the roots, so a program on
      // a plugged-in drive streams exactly like one on the card.
      const found = resolveFolder(segments[1]);
      if (!found) return send(res, 404, "NOT FOUND");
      fp = path.normalize(path.join(found.dir, segments[2]));
      if (!fp.startsWith(found.dir + path.sep)) return send(res, 403, "FORBIDDEN");
    } else {
      fp = path.normalize(path.join(ROOT, ...segments));
      if (!fp.startsWith(ROOT + path.sep)) return send(res, 403, "FORBIDDEN");
    }
    fs.stat(fp, (err, st) => {
      if (err || !st.isFile()) return send(res, 404, "NOT FOUND");
      const type = MIME[path.extname(fp).toLowerCase()] || "application/octet-stream";
      const base = { "content-type": type, "cache-control": "no-cache", "accept-ranges": "bytes" };
      // Range requests: how <video> seeks, and how the broadcast clock joins
      // a file mid-program without downloading everything before the offset.
      const m = /^bytes=(\d*)-(\d*)$/.exec(rangeHeader || "");
      if (m && (m[1] || m[2])) {
        let start = m[1] ? Number(m[1]) : Math.max(0, st.size - Number(m[2]));
        let end = m[1] && m[2] ? Math.min(Number(m[2]), st.size - 1) : st.size - 1;
        if (!Number.isFinite(start) || !Number.isFinite(end) || start > end || start >= st.size) {
          res.writeHead(416, { "content-range": "bytes */" + st.size });
          return res.end();
        }
        res.writeHead(206, Object.assign(base, {
          "content-range": "bytes " + start + "-" + end + "/" + st.size,
          "content-length": end - start + 1,
        }));
        return sendFile(fp, { start, end }, res);
      }
      res.writeHead(200, Object.assign(base, { "content-length": st.size }));
      sendFile(fp, {}, res);
    });
  }

  // <video> opens a file, reads a little, and drops the connection dozens of
  // times per program. A plain pipe() leaves each dropped read stream (and
  // its file descriptor) open for good; pipeline() tears it down with the
  // response, so a day on the air does not leak hundreds of open files.
  function sendFile(fp, range, res) {
    pipeline(fs.createReadStream(fp, range), res, () => { /* closed or errored: both ends are down */ });
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
      if (pathname === "/api/system") {
        handleSystem(req, res);
        return;
      }
      if (pathname === "/api/vitals") {
        handleVitals(res);
        return;
      }
      if (pathname === "/api/version") {
        res.writeHead(200, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
        res.end(JSON.stringify({ version: VERSION, release: RELEASE_TAG, build: DISPLAY_BUILD, repo: REPO_URL }));
        return;
      }
      if (pathname === "/api/music") {
        handleMusic(res);
        return;
      }
      if (pathname === "/api/channels") {
        handleChannels(res);
        return;
      }
      if (pathname === "/api/channels/durations") {
        handleDurations(req, res);
        return;
      }
      if (pathname === "/api/tune") {
        handleTune(req, res);
        return;
      }
      if (pathname === "/api/events") {
        handleEvents(req, res);
        return;
      }
      if (pathname === "/api/cheerlights") {
        handleCheerlights(res).catch((e) => send(res, 500, "SERVER ERROR: " + e.message));
        return;
      }
      if (pathname.startsWith("/api/feed/")) {
        const id = pathname.slice("/api/feed/".length);
        handleFeed(id, res).catch((e) => send(res, 500, "SERVER ERROR: " + e.message));
        return;
      }
      serveStatic(pathname, res, req.headers.range);
    } catch (e) {
      send(res, 400, "BAD REQUEST");
    }
  });
  server.loadConfig = loadConfig;
  return server;
}

// The command line. Every flag is listed in the README's "Command line"
// table; a flag that needs a value and does not get one is an error, said in
// plain words, rather than an undefined that surfaces as a 400 hours later.
const USAGE =
  "usage: node server.js [--port <n>] [--media <path>]... [--mock] [--chaos]\n" +
  "  --port <n>       listen on port n instead of config.json's port\n" +
  "  --media <path>   also look for channel folders under <path> (or <path>/channels)\n" +
  "  --mock           serve the canned feeds in test/mock-feeds instead of fetching\n" +
  "  --chaos          mock feeds that randomly hang and fail (implies --mock)\n";

function parseArgs(argv) {
  const args = { mock: false, chaos: false, port: null, mediaDirs: [], error: null };
  const value = (flag, i) => {
    const v = argv[i + 1];
    if (v === undefined || v.startsWith("--")) {
      args.error = flag + " needs a value";
      return null;
    }
    return v;
  };
  for (let i = 0; i < argv.length && !args.error; i++) {
    const a = argv[i];
    if (a === "--mock") args.mock = true;
    else if (a === "--chaos") { args.chaos = true; args.mock = true; }
    else if (a === "--port") {
      const v = value(a, i++);
      if (v === null) break;
      const n = Number(v);
      if (!Number.isInteger(n) || n < 1 || n > 65535) args.error = "--port needs a number from 1 to 65535, not " + JSON.stringify(v);
      else args.port = n;
    } else if (a === "--media") {
      const v = value(a, i++);
      if (v === null) break;
      args.mediaDirs.push(v);
    } else if (a === "--help" || a === "-h") args.help = true;
    else args.error = "unknown option " + a;
  }
  return args;
}

// Every address the channel answers on: localhost for a browser on this
// machine, then each LAN IPv4 address for a browser on any other device.
// "localhost" is the first thing people type from a laptop and the first
// thing that cannot work there, so the real addresses go on screen at start.
function listenUrls(port) {
  const urls = ["http://localhost:" + port];
  const ifaces = os.networkInterfaces();
  for (const name of Object.keys(ifaces)) {
    for (const addr of ifaces[name] || []) {
      if (addr.internal) continue;
      if (addr.family !== "IPv4" && addr.family !== 4) continue;
      urls.push("http://" + addr.address + ":" + port);
    }
  }
  return urls;
}

if (require.main === module) {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    process.stdout.write(USAGE);
    process.exit(0);
  }
  if (args.error) {
    process.stderr.write("CABLE 82: " + args.error + "\n\n" + USAGE);
    process.exit(2);
  }
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
    const urls = listenUrls(port);
    const lines = [
      "CABLE 82 broadcasting" +
        (args.mock ? "  [mock feeds]" : "") +
        (args.chaos ? "  [chaos on]" : ""),
      "  " + urls[0] + "   (a browser on this machine)",
    ];
    for (const u of urls.slice(1)) lines.push("  " + u + "   (a browser on another device on your network)");
    lines.push("Control room: " + urls[0] + "/config");
    lines.push("Remote control: " + (urls[1] || urls[0]) + "/remote-control   (open it on your phone)");
    console.log(lines.join("\n"));
  });
}

module.exports = { createApp, listenUrls, parseArgs, displayBuild, releaseVersion };
