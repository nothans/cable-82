// node --test test/server.test.mjs
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { createApp, listenUrls } = require("../server.js");

// ---------- upstream mock (the "internet") ----------

const upstreamState = { flakyBroken: false, requests: [] };
const RSS_OK = `<?xml version="1.0"?><rss version="2.0"><channel><item><title>Upstream headline</title></item></channel></rss>`;

const upstream = http.createServer((req, res) => {
  upstreamState.requests.push(req.url);
  if (req.url === "/ok.xml") {
    res.writeHead(200, { "content-type": "application/rss+xml" });
    res.end(RSS_OK);
  } else if (req.url === "/slow.xml") {
    // never responds
  } else if (req.url === "/big.xml") {
    res.writeHead(200, { "content-type": "application/xml" });
    res.end("<rss>" + "x".repeat(100 * 1024) + "</rss>");
  } else if (req.url === "/flaky.xml") {
    if (upstreamState.flakyBroken) {
      res.writeHead(500);
      res.end("boom");
    } else {
      res.writeHead(200, { "content-type": "application/rss+xml" });
      res.end(RSS_OK);
    }
  } else if (req.url.startsWith("/geo")) {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({
      results: [
        { name: "Boston", admin1: "Massachusetts", country: "United States", latitude: 42.36, longitude: -71.06, timezone: "America/New_York" },
        { name: "Boston", admin1: "England", country: "United Kingdom", latitude: 52.97, longitude: -0.02, timezone: "Europe/London" },
      ],
    }));
  } else if (req.url.startsWith("/wx")) {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({
      current: { temperature_2m: 71.6, weather_code: 2, wind_speed_10m: 8.3 },
      daily: { temperature_2m_max: [78.1], temperature_2m_min: [61.4], sunrise: ["2026-07-22T05:27"], sunset: ["2026-07-22T20:14"] },
    }));
  } else if (req.url.startsWith("/cheer")) {
    // ThingSpeak channel 1417 last.json shape: field1 = color, field2 = hex
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ created_at: "2026-07-26T12:00:00Z", field1: "Purple ", field2: "#800080" }));
  } else {
    res.writeHead(404);
    res.end();
  }
});

// ---------- app under test ----------

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cable82-test-"));
const configPath = path.join(tmpDir, "config.json");
let app;
let base;

// Accepts a config object (written as JSON) or a raw string (to simulate a
// corrupt file). Bumping the mtime forward makes the loader notice the change.
function writeConfig(obj, bumpSeconds) {
  fs.writeFileSync(configPath, typeof obj === "string" ? obj : JSON.stringify(obj, null, 2));
  if (bumpSeconds) {
    const t = new Date(Date.now() + bumpSeconds * 1000);
    fs.utimesSync(configPath, t, t);
  }
}

function configFor(upstreamPort, extraFeeds = []) {
  return {
    feeds: [
      { id: "ok", label: "OK", url: `http://127.0.0.1:${upstreamPort}/ok.xml` },
      { id: "slow", label: "SLOW", url: `http://127.0.0.1:${upstreamPort}/slow.xml` },
      { id: "big", label: "BIG", url: `http://127.0.0.1:${upstreamPort}/big.xml` },
      { id: "flaky", label: "FLAKY", url: `http://127.0.0.1:${upstreamPort}/flaky.xml` },
      ...extraFeeds,
    ],
  };
}

before(async () => {
  await new Promise((r) => upstream.listen(0, "127.0.0.1", r));
  const upstreamPort = upstream.address().port;
  writeConfig(configFor(upstreamPort));
  const musicDir = path.join(tmpDir, "music");
  fs.mkdirSync(musicDir);
  for (const f of ["b-track.ogg", "a-track.mp3", "c-track.wav", "notes.txt", "cover.png"]) {
    fs.writeFileSync(path.join(musicDir, f), "x");
  }
  app = createApp({
    configPath,
    musicDir,
    upstreamTimeoutMs: 400,
    maxFeedBytes: 64 * 1024,
    weatherApiBase: `http://127.0.0.1:${upstreamPort}/wx`,
    geocodeApiBase: `http://127.0.0.1:${upstreamPort}/geo`,
    cheerlightsApiBase: `http://127.0.0.1:${upstreamPort}/cheer`,
  });
  await new Promise((r) => app.listen(0, "127.0.0.1", r));
  base = "http://127.0.0.1:" + app.address().port;
});

after(() => {
  app.close();
  upstream.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ---------- static serving ----------

test("serves index.html at /", async () => {
  const r = await fetch(base + "/");
  assert.equal(r.status, 200);
  assert.match(r.headers.get("content-type"), /text\/html/);
  assert.match(await r.text(), /CABLE 82/);
});

test("serves css with the right mime type", async () => {
  const r = await fetch(base + "/style.css");
  assert.equal(r.status, 200);
  assert.match(r.headers.get("content-type"), /text\/css/);
});

// fetch() normalizes ../ away client-side, so send raw paths.
function rawGet(rawPath) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: "127.0.0.1", port: app.address().port, path: rawPath, method: "GET" },
      (res) => {
        res.resume();
        res.on("end", () => resolve(res.statusCode));
      }
    );
    req.on("error", reject);
    req.end();
  });
}

test("rejects parent traversal", async () => {
  // The URL parser normalizes dot segments (plain AND percent-encoded)
  // and clamps them at the root, so those resolve to in-root paths that
  // either exist (200, harmless) or miss (404). Backslash segments skip
  // that normalization and must be rejected by the server's own checks.
  // On win32 the backslash segment resolves out of root and the prefix
  // check 403s; on POSIX a backslash is a literal filename char, so the
  // lookup misses in-root (404). Both are safe; assert no content leaks.
  for (const p of ["/..%5C..%5Cserver.js", "/fonts%5C..%5C..%5Cconfig.js"]) {
    const code = await rawGet(p);
    assert.ok([403, 404].includes(code), p + " must not serve, got " + code);
  }
  // Dot segments can never reach above the root: both of these would hit
  // workspace files if traversal worked, and both must miss in-root.
  assert.equal(await rawGet("/../../../CLAUDE.md"), 404);
  assert.equal(await rawGet("/%2e%2e/%2e%2e/CLAUDE.md"), 404);
});

test("rejects dotfile paths", async () => {
  for (const p of ["/.meta/session.md", "/.git/config", "/test/../.git/HEAD"]) {
    const r = await fetch(base + p);
    assert.equal(r.status, 403, p);
  }
});

// ---------- feed proxy ----------

test("proxies a configured feed id", async () => {
  const r = await fetch(base + "/api/feed/ok");
  assert.equal(r.status, 200);
  assert.match(await r.text(), /<rss/);
});

test("unknown feed id is 404", async () => {
  const r = await fetch(base + "/api/feed/nope");
  assert.equal(r.status, 404);
});

test("no URL parameter is accepted anywhere (SSRF)", async () => {
  const before = upstreamState.requests.length;
  const r1 = await fetch(base + "/api/feed/ok?url=http://127.0.0.1:1/evil");
  assert.equal(r1.status, 200); // query ignored, configured URL fetched
  const r2 = await fetch(base + "/api/feed/" + encodeURIComponent("http://evil.example"));
  assert.equal(r2.status, 404); // a URL is not a feed id
  const seen = upstreamState.requests.slice(before);
  assert.ok(seen.every((u) => u === "/ok.xml"), "upstream saw only configured paths: " + seen);
});

test("upstream timeout becomes 502 when no cache exists", async () => {
  const r = await fetch(base + "/api/feed/slow");
  assert.equal(r.status, 502);
});

test("oversized feed is rejected, not served", async () => {
  const r = await fetch(base + "/api/feed/big");
  assert.equal(r.status, 502);
});

test("last-good copy is served when upstream breaks", async () => {
  upstreamState.flakyBroken = false;
  const r1 = await fetch(base + "/api/feed/flaky");
  assert.equal(r1.status, 200);
  assert.equal(r1.headers.get("x-cable82-stale"), null);
  upstreamState.flakyBroken = true;
  const r2 = await fetch(base + "/api/feed/flaky");
  assert.equal(r2.status, 200);
  assert.equal(r2.headers.get("x-cable82-stale"), "1");
  assert.match(await r2.text(), /Upstream headline/);
});

// ---------- config lifecycle ----------

test("config change is picked up without a restart", async () => {
  const upstreamPort = upstream.address().port;
  const r1 = await fetch(base + "/api/feed/added");
  assert.equal(r1.status, 404);
  writeConfig(
    configFor(upstreamPort, [{ id: "added", label: "ADDED", url: `http://127.0.0.1:${upstreamPort}/ok.xml` }]),
    2
  );
  const r2 = await fetch(base + "/api/feed/added");
  assert.equal(r2.status, 200);
});

test("broken config keeps last good config on the air", async () => {
  const upstreamPort = upstream.address().port;
  writeConfig("{ this is not valid json", 4);
  const r1 = await fetch(base + "/");
  assert.equal(r1.status, 200); // static never depends on config
  const r2 = await fetch(base + "/api/feed/ok");
  assert.equal(r2.status, 200); // last good config still serving
  writeConfig(configFor(upstreamPort), 6); // restore
  const r3 = await fetch(base + "/api/feed/ok");
  assert.equal(r3.status, 200);
});

// ---------- config API (control room) ----------

test("GET /api/config returns the current config and a version", async () => {
  const r = await fetch(base + "/api/config");
  assert.equal(r.status, 200);
  assert.match(r.headers.get("content-type"), /application\/json/);
  const j = await r.json();
  assert.ok(j.version, "has a version token");
  assert.ok(Array.isArray(j.config.feeds), "has feeds");
  assert.ok(j.config.feeds.some((f) => f.id === "ok"), "includes the ok feed");
});

test("POST /api/config without the guard header is refused (CSRF)", async () => {
  const before = await (await fetch(base + "/api/config")).json();
  const r = await fetch(base + "/api/config", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ channelName: "DRIVE-BY", feeds: [] }),
  });
  assert.equal(r.status, 403);
  const after = await (await fetch(base + "/api/config")).json();
  assert.equal(after.config.channelName, before.config.channelName, "config unchanged");
});

test("POST /api/config with invalid JSON is 400", async () => {
  const r = await fetch(base + "/api/config", {
    method: "POST",
    headers: { "content-type": "application/json", "x-cable82-config": "1" },
    body: "definitely not json",
  });
  assert.equal(r.status, 400);
});

test("POST /api/config validates, writes, and is reflected", async () => {
  const upstreamPort = upstream.address().port;
  const next = configFor(upstreamPort);
  next.channelName = "TEST CHANNEL";
  next.crawl = { flag: "WIRE", feeds: ["ok"] };
  next.crtMode = true;
  next.textScale = 1.25;
  const r = await fetch(base + "/api/config", {
    method: "POST",
    headers: { "content-type": "application/json", "x-cable82-config": "1" },
    body: JSON.stringify(next),
  });
  assert.equal(r.status, 200);
  const j = await r.json();
  assert.equal(j.ok, true);
  assert.equal(j.config.channelName, "TEST CHANNEL");
  assert.equal(j.config.crawl.flag, "WIRE");
  assert.equal(j.config.crtMode, true);
  assert.equal(j.config.textScale, 1.25);
  // Reflected on a fresh GET and the feed proxy still serves the kept feeds.
  const g = await (await fetch(base + "/api/config")).json();
  assert.equal(g.config.channelName, "TEST CHANNEL");
  assert.equal((await fetch(base + "/api/feed/ok")).status, 200);
});

// ---------- weather + geocode ----------

test("GET /api/geocode returns normalized matches", async () => {
  const r = await fetch(base + "/api/geocode?q=Boston");
  assert.equal(r.status, 200);
  const j = await r.json();
  assert.equal(j.results.length, 2);
  assert.equal(j.results[0].name, "Boston");
  assert.equal(j.results[0].admin1, "Massachusetts");
  assert.equal(j.results[0].timezone, "America/New_York");
});

test("GET /api/geocode without a query is 400", async () => {
  assert.equal((await fetch(base + "/api/geocode")).status, 400);
});

test("GET /api/weather is 503 when no location is configured", async () => {
  const upstreamPort = upstream.address().port;
  writeConfig(configFor(upstreamPort), 8); // no weather.location
  assert.equal((await fetch(base + "/api/weather")).status, 503);
});

test("POST /api/config with a stale version header is refused (409)", async () => {
  const g = await (await fetch(base + "/api/config")).json();
  const stale = await fetch(base + "/api/config", {
    method: "POST",
    headers: { "content-type": "application/json", "x-cable82-config": "1", "x-cable82-config-version": "0:stale" },
    body: JSON.stringify(g.config),
  });
  assert.equal(stale.status, 409);
  assert.equal((await stale.json()).conflict, true);
  // With the version it actually loaded, the save goes through.
  const fresh = await fetch(base + "/api/config", {
    method: "POST",
    headers: { "content-type": "application/json", "x-cable82-config": "1", "x-cable82-config-version": g.version },
    body: JSON.stringify(g.config),
  });
  assert.equal(fresh.status, 200);
});

// ---------- cheerlights ----------

test("GET /api/cheerlights returns the normalized color when enabled", async () => {
  const upstreamPort = upstream.address().port;
  const cfg = configFor(upstreamPort);
  cfg.cheerlights = { enabled: true, template: "THE WORLD IS SET TO {COLOR}" };
  writeConfig(cfg, 8);
  const r = await fetch(base + "/api/cheerlights");
  assert.equal(r.status, 200);
  const j = await r.json();
  assert.equal(j.color, "purple"); // trimmed + lowercased
  assert.equal(j.hex, "#800080");
});

test("GET /api/cheerlights is 503 when disabled", async () => {
  const upstreamPort = upstream.address().port;
  const cfg = configFor(upstreamPort);
  cfg.cheerlights = { enabled: false };
  writeConfig(cfg, 8);
  assert.equal((await fetch(base + "/api/cheerlights")).status, 503);
});

test("GET /api/music lists only audio files, sorted", async () => {
  const r = await fetch(base + "/api/music");
  assert.equal(r.status, 200);
  const j = await r.json();
  assert.deepEqual(j.tracks.map((t) => t.file), ["a-track.mp3", "b-track.ogg", "c-track.wav"]);
  assert.ok(j.tracks[0].url.startsWith("music/"), "url points into the music folder");
});

test("GET /api/weather returns normalized current conditions", async () => {
  const upstreamPort = upstream.address().port;
  const cfg = configFor(upstreamPort);
  cfg.weather = {
    location: { name: "Boston, MA", latitude: 42.36, longitude: -71.06, timezone: "America/New_York", country: "United States" },
    tempUnit: "F",
    windUnit: "mph",
  };
  writeConfig(cfg, 10);
  const r = await fetch(base + "/api/weather");
  assert.equal(r.status, 200);
  const j = await r.json();
  assert.equal(j.name, "Boston, MA");
  assert.equal(j.tempNow, 72); // 71.6 rounded
  assert.equal(j.tempUnit, "F");
  assert.equal(j.condition, "PARTLY CLOUDY"); // code 2
  assert.equal(j.tempHi, 78);
  assert.equal(j.tempLo, 61);
  assert.equal(j.sunrise, "2026-07-22T05:27");
});

test("listenUrls leads with localhost and lists every LAN IPv4 address", () => {
  const urls = listenUrls(1982);
  assert.equal(urls[0], "http://localhost:1982");
  const lan = Object.values(os.networkInterfaces()).flat()
    .filter((a) => !a.internal && (a.family === "IPv4" || a.family === 4))
    .map((a) => "http://" + a.address + ":1982");
  assert.deepEqual(urls.slice(1), lan);
  for (const u of urls) assert.equal(new URL(u).port, "1982");
});
