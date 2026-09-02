// node --test test/server.test.mjs
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const { createApp, listenUrls, displayBuild, releaseVersion } = require("../server.js");

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
  const channelsDir = path.join(tmpDir, "channels");
  fs.mkdirSync(path.join(channelsDir, "cartoons"), { recursive: true });
  for (const f of ["S01.E1.mp4", "S01.E10.mp4", "S01.E2.mp4", "notes.txt"]) {
    fs.writeFileSync(path.join(channelsDir, "cartoons", f), "x");
  }
  fs.writeFileSync(
    path.join(channelsDir, "cartoons", ".durations.json"),
    JSON.stringify({ "S01.E1.mp4": 31.2 })
  );
  fs.mkdirSync(path.join(channelsDir, "empty"));
  fs.mkdirSync(path.join(channelsDir, "spots"));
  for (const f of ["ad-1.mp4", "ad-2.mp4"]) fs.writeFileSync(path.join(channelsDir, "spots", f), "x");
  fs.writeFileSync(path.join(channelsDir, "spots", ".durations.json"), JSON.stringify({ "ad-1.mp4": 30 }));
  app = createApp({
    configPath,
    musicDir,
    channelsDir,
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

test("serves the remote at /remote-control", async () => {
  const r = await fetch(base + "/remote-control");
  assert.equal(r.status, 200);
  assert.match(r.headers.get("content-type"), /text\/html/);
  const html = await r.text();
  assert.match(html, /Remote Control/);
  for (const cmd of ["down", "volume", "power", "up"]) assert.match(html, new RegExp('data-cmd="' + cmd + '"'));
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
  next.crtInkText = true;
  next.textScale = 1.25;
  next.overscanX = 10;
  next.overscanY = 5;
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
  assert.equal(j.config.crtInkText, true);
  assert.equal(j.config.textScale, 1.25);
  assert.equal(j.config.overscanX, 10);
  assert.equal(j.config.overscanY, 5);
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

test("GET /api/version reports the release, the build, and the repo", async () => {
  const r = await fetch(base + "/api/version");
  assert.equal(r.status, 200);
  const j = await r.json();
  assert.match(j.build, /^[0-9a-f]{12}$/);
  assert.equal(j.repo, "https://github.com/nothans/cable-82");
  // Either a real checkout (a describe string, with `release` set only when it
  // sits exactly on a tag) or no checkout at all, which is what a zip download
  // looks like. Never a guess.
  if (j.version === null) assert.equal(j.release, null);
  else assert.equal(typeof j.version, "string");
  if (j.release !== null) assert.match(j.release, /^v\d+\.\d+\.\d+$/);
});

test("releaseVersion only answers for a checkout of this project", () => {
  // Git searches upwards, so a copy vendored inside a parent repo would
  // otherwise report that repo's tags as CABLE 82's release. This holds either
  // way: a real checkout of the project answers, anything else says nothing.
  const projectRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
  const v = releaseVersion();
  let top = null;
  try {
    top = execFileSync("git", ["rev-parse", "--show-toplevel"], {
      cwd: projectRoot,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch (e) {
    /* not a checkout at all */
  }
  const ownCheckout =
    top !== null && path.resolve(top).toLowerCase() === path.resolve(projectRoot).toLowerCase();
  if (ownCheckout) assert.equal(typeof v, "string", "a checkout of the project names its version");
  else assert.equal(v, null, "a vendored or unpacked copy claims no version");
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

// ---------- channels, the dial, and the tuner bus ----------

test("GET /api/config synthesizes a one-channel dial for a legacy config", async () => {
  const r = await fetch(base + "/api/config");
  const j = await r.json();
  assert.equal(j.config.channels.length, 1);
  assert.equal(j.config.channels[0].number, 82);
  assert.equal(j.config.channels[0].type, "bulletin");
  assert.equal(j.config.tuner.wrap, true);
  assert.equal(j.config.tuner.cut, "static");
});

test("schema rejects duplicate channel numbers and sorts the dial", async () => {
  const { validateConfig } = require("../config-schema.js");
  const r = validateConfig({
    channels: [
      { number: 90, type: "video", folder: "cartoons" },
      { number: 82, type: "bulletin" },
      { number: 90, type: "video", folder: "cartoons" },
    ],
  });
  assert.equal(r.cfg.channels.length, 2);
  assert.deepEqual(r.cfg.channels.map((c) => c.number), [82, 90]);
  assert.ok(r.errors.some((e) => e.includes("DUPLICATE CHANNEL NUMBER")));
});

test("schema drops traversal folders and urlless externals", async () => {
  const { validateConfig } = require("../config-schema.js");
  const r = validateConfig({
    channels: [
      { number: 5, type: "video", folder: "../secrets" },
      { number: 6, type: "external", url: "ftp://nope" },
      { number: 7, type: "bulletin" },
    ],
  });
  assert.deepEqual(r.cfg.channels.map((c) => c.number), [7]);
});

test("GET /api/channels lists folders and naturally sorts playlists", async () => {
  writeConfig(
    Object.assign(configFor(upstream.address().port), {
      channels: [
        { number: 82, type: "bulletin" },
        { number: 90, type: "video", folder: "cartoons" },
      ],
    }),
    2
  );
  const r = await fetch(base + "/api/channels");
  const j = await r.json();
  const cartoons = j.folders.find((f) => f.folder === "cartoons");
  assert.equal(cartoons.files, 3); // notes.txt and .durations.json excluded
  const ch = j.channels.find((c) => c.number === 90);
  assert.deepEqual(ch.files.map((f) => f.file), ["S01.E1.mp4", "S01.E2.mp4", "S01.E10.mp4"]);
  assert.equal(ch.files[0].duration, 31.2); // cached
  assert.equal(ch.files[1].duration, null); // not probed yet
});

test("POST /api/channels/durations records only real files, guarded", async () => {
  const noHeader = await fetch(base + "/api/channels/durations", {
    method: "POST",
    body: JSON.stringify({ folder: "cartoons", durations: { "S01.E2.mp4": 12 } }),
  });
  assert.equal(noHeader.status, 403);
  const r = await fetch(base + "/api/channels/durations", {
    method: "POST",
    headers: { "content-type": "application/json", "x-cable82-config": "1" },
    body: JSON.stringify({ folder: "cartoons", durations: { "S01.E2.mp4": 29.9, "ghost.mp4": 10, "S01.E10.mp4": -5 } }),
  });
  const j = await r.json();
  assert.equal(j.ok, true);
  assert.equal(j.wrote, 1);
  const again = await (await fetch(base + "/api/channels")).json();
  const ch = again.channels.find((c) => c.number === 90);
  assert.equal(ch.files.find((f) => f.file === "S01.E2.mp4").duration, 29.9);
});

test("POST /api/tune broadcasts an event with a rising sequence to SSE listeners", async () => {
  // open an SSE listener
  const events = [];
  const es = await new Promise((resolve, reject) => {
    const req = http.get(base + "/api/events", (res) => {
      let buf = "";
      res.on("data", (c) => {
        buf += c;
        let idx;
        while ((idx = buf.indexOf("\n\n")) >= 0) {
          const chunk = buf.slice(0, idx);
          buf = buf.slice(idx + 2);
          const ev = /event: (\S+)/.exec(chunk);
          const data = /data: (.*)/.exec(chunk);
          if (ev && data) events.push({ event: ev[1], data: JSON.parse(data[1]) });
        }
      });
      resolve({ req, res });
    });
    req.on("error", reject);
  });
  await new Promise((r) => setTimeout(r, 100));
  const t1 = await (await fetch(base + "/api/tune", { method: "POST", body: JSON.stringify({ cmd: "up" }) })).json();
  const t2 = await (await fetch(base + "/api/tune", { method: "POST", body: JSON.stringify({ cmd: "set", channel: 90 }) })).json();
  assert.ok(t2.seq > t1.seq);
  await new Promise((r) => setTimeout(r, 150));
  es.req.destroy();
  const tunes = events.filter((e) => e.event === "tune");
  assert.equal(tunes.length, 2);
  assert.equal(tunes[0].data.cmd, "up");
  assert.deepEqual(tunes[1].data, { seq: t2.seq, cmd: "set", channel: 90 });
  const hello = events.find((e) => e.event === "hello");
  assert.ok(hello, "the stream opens with a hello");
  // The display's build token: 12 hex characters, stable for one server
  // process, so a reconnect after a restart can tell a stale page to reload.
  assert.match(hello.data.build, /^[0-9a-f]{12}$/);
  assert.equal(hello.data.build, displayBuild());
});

test("the remote's volume and power keys ride the same bus", async () => {
  const events = [];
  const req = await new Promise((resolve, reject) => {
    const q = http.get(base + "/api/events", (res) => {
      let buf = "";
      res.on("data", (c) => {
        buf += c;
        let idx;
        while ((idx = buf.indexOf("\n\n")) >= 0) {
          const chunk = buf.slice(0, idx);
          buf = buf.slice(idx + 2);
          const ev = /event: (\S+)/.exec(chunk);
          const data = /data: (.*)/.exec(chunk);
          if (ev && data) events.push({ event: ev[1], data: JSON.parse(data[1]) });
        }
      });
      resolve(q);
    });
    q.on("error", reject);
  });
  await new Promise((r) => setTimeout(r, 100));
  const v = await (await fetch(base + "/api/tune", { method: "POST", body: JSON.stringify({ cmd: "volume" }) })).json();
  const p = await (await fetch(base + "/api/tune", { method: "POST", body: JSON.stringify({ cmd: "power" }) })).json();
  assert.equal(v.ok, true);
  assert.equal(p.listeners, 1); // the remote reads this to say "one set is listening"
  await new Promise((r) => setTimeout(r, 150));
  req.destroy();
  const tunes = events.filter((e) => e.event === "tune").map((e) => e.data);
  assert.deepEqual(tunes, [{ seq: v.seq, cmd: "volume" }, { seq: p.seq, cmd: "power" }]);
});

test("POST /api/tune validates commands", async () => {
  const bad = await fetch(base + "/api/tune", { method: "POST", body: JSON.stringify({ cmd: "explode" }) });
  assert.equal(bad.status, 400);
  assert.match(await bad.text(), /up, down, set, volume, OR power/);
  const noChannel = await fetch(base + "/api/tune", { method: "POST", body: JSON.stringify({ cmd: "set" }) });
  assert.equal(noChannel.status, 400);
});

test("static serving honors Range requests (how video seeks)", async () => {
  const whole = await fetch(base + "/README.md");
  assert.equal(whole.status, 200);
  assert.equal(whole.headers.get("accept-ranges"), "bytes");
  const text = await whole.text();
  const part = await fetch(base + "/README.md", { headers: { range: "bytes=2-5" } });
  assert.equal(part.status, 206);
  assert.equal(part.headers.get("content-range"), "bytes 2-5/" + text.length);
  assert.equal(await part.text(), text.slice(2, 6));
  const off = await fetch(base + "/README.md", { headers: { range: "bytes=999999999-" } });
  assert.equal(off.status, 416);
});

test("a dropped range request closes its file (no leaked descriptors)", async () => {
  // <video> opens, reads a little, and drops the connection many times per
  // program; after 12 hours on the air a Pi had 300 leaked open files.
  // Static files come from the project root; channels/* is gitignored, so a
  // throwaway file there is served and never committed.
  const big = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "channels", "tmp-fd-leak.bin");
  fs.writeFileSync(big, Buffer.alloc(8 * 1024 * 1024, 7));
  const opened = [];
  const real = fs.createReadStream;
  fs.createReadStream = function (...args) {
    const st = real.apply(this, args);
    opened.push(st);
    return st;
  };
  try {
    await new Promise((resolve, reject) => {
      const req = http.get(base + "/channels/tmp-fd-leak.bin", { headers: { range: "bytes=1000-" } }, (res) => {
        assert.equal(res.statusCode, 206);
        res.once("data", () => req.destroy()); // the client walks away mid-stream
        res.on("close", resolve);
        res.on("error", () => {}); // aborted by us
      });
      req.on("error", (e) => (e.code === "ECONNRESET" ? resolve() : reject(e)));
    });
  } finally {
    fs.createReadStream = real;
    fs.rmSync(big, { force: true });
  }
  assert.equal(opened.length, 1);
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(opened[0].destroyed, true, "read stream torn down with the response");
  assert.equal(opened[0].closed, true, "file descriptor released");
});

test("naturalCompare orders seasons and episodes like a human", () => {
  const { naturalCompare } = require("../server.js");
  const names = ["S01.E10.mp4", "S02.E1.mp4", "S01.E2.mp4", "S01.E1.mp4"];
  assert.deepEqual(names.sort(naturalCompare), ["S01.E1.mp4", "S01.E2.mp4", "S01.E10.mp4", "S02.E1.mp4"]);
});

test("naturalCompare survives mixed zero-padding (S1E2 airs before S01E10)", () => {
  const { naturalCompare } = require("../server.js");
  assert.ok(naturalCompare("S1E2.mp4", "S01E10.mp4") < 0);
  assert.deepEqual(
    ["S01E10.mp4", "S1E2.mp4", "S1E1.mp4"].sort(naturalCompare),
    ["S1E1.mp4", "S1E2.mp4", "S01E10.mp4"]
  );
  // Only-padding differences still order deterministically.
  assert.ok(naturalCompare("S1E2.mp4", "S01E2.mp4") !== 0);
});

test("/api/tune answers 403 while HTTP tuning is switched off", async () => {
  const upstreamPort = upstream.address().port;
  writeConfig({ ...configFor(upstreamPort), tuner: { sources: { http: false } } }, 2);
  const get = await fetch(base + "/api/tune");
  assert.equal(get.status, 403);
  const post = await fetch(base + "/api/tune", { method: "POST", body: JSON.stringify({ cmd: "up" }) });
  assert.equal(post.status, 403);
  writeConfig(configFor(upstreamPort), 4);
  const back = await fetch(base + "/api/tune");
  assert.equal(back.status, 200);
});

test("405 responses carry an Allow header", async () => {
  const r = await fetch(base + "/api/tune", { method: "DELETE" });
  assert.equal(r.status, 405);
  assert.equal(r.headers.get("allow"), "GET, POST");
  const d = await fetch(base + "/api/channels/durations");
  assert.equal(d.status, 405);
  assert.equal(d.headers.get("allow"), "POST");
});

test("schema accepts an overnight window and skips channel number 0", async () => {
  const upstreamPort = upstream.address().port;
  writeConfig({
    ...configFor(upstreamPort),
    channels: [
      { number: 82, type: "bulletin" },
      { number: 0, type: "video", folder: "cartoons" },
      { number: 9, type: "video", folder: "cartoons", mode: "schedule",
        schedule: [{ days: ["sat"], start: "20:00", end: "01:00" }] },
    ],
  }, 6);
  const j = await (await fetch(base + "/api/config")).json();
  const nums = j.config.channels.map((c) => c.number);
  assert.deepEqual(nums, [9, 82]); // number 0 skipped, never clamped to 1
  const nine = j.config.channels[0];
  assert.equal(nine.schedule.length, 1);
  assert.equal(nine.schedule[0].start, "20:00");
  assert.equal(nine.schedule[0].end, "01:00"); // overnight window kept as written
  writeConfig(configFor(upstreamPort), 8);
});

test("schema keeps a channel's breaks, clamps the numbers, drops a same-folder break", async () => {
  const { validateConfig, BREAKS } = require("../config-schema.js");
  const r = validateConfig({
    channels: [
      { number: 82, type: "bulletin" },
      { number: 3, type: "video", folder: "movies", breaks: { folder: "spots", everyMinutes: 999, spots: 0 } },
      { number: 4, type: "video", folder: "movies", breaks: { folder: "spots" } },
      { number: 5, type: "video", folder: "movies", breaks: { folder: "movies", everyMinutes: 10, spots: 2 } },
      { number: 6, type: "video", folder: "movies", breaks: { folder: "../etc", everyMinutes: 10, spots: 2 } },
      { number: 7, type: "video", folder: "movies", breaks: { folder: "", everyMinutes: 10, spots: 2 } },
    ],
  });
  const by = Object.fromEntries(r.cfg.channels.map((c) => [c.number, c]));
  assert.deepEqual(by[3].breaks, { folder: "spots", everyMinutes: BREAKS.everyMinutes.max, spots: BREAKS.spots.min });
  assert.deepEqual(by[4].breaks, { folder: "spots", everyMinutes: BREAKS.everyMinutes.dflt, spots: BREAKS.spots.dflt });
  assert.equal(by[5].breaks, undefined); // the program folder cannot be its own break
  assert.ok(r.errors.some((e) => e.includes("CHANNEL 5") && e.includes("PROGRAM FOLDER")));
  assert.equal(by[6].breaks, undefined);
  assert.ok(r.errors.some((e) => e.includes("CHANNEL 6") && e.includes("BAD BREAKS FOLDER")));
  assert.equal(by[7].breaks, undefined); // an empty folder is "no breaks", not an error
  assert.ok(!r.errors.some((e) => e.includes("CHANNEL 7")));
  assert.equal(by[7].folder, "movies"); // the channel itself is untouched
});

test("GET /api/channels carries a programmed channel's spots with their cached durations", async () => {
  const upstreamPort = upstream.address().port;
  writeConfig(
    Object.assign(configFor(upstreamPort), {
      channels: [
        { number: 82, type: "bulletin" },
        { number: 3, type: "video", folder: "cartoons", breaks: { folder: "spots", everyMinutes: 0, spots: 2 } },
        { number: 90, type: "video", folder: "cartoons" },
      ],
    }),
    10
  );
  const j = await (await fetch(base + "/api/channels")).json();
  const three = j.channels.find((c) => c.number === 3);
  assert.equal(three.breaks.folder, "spots");
  assert.deepEqual(three.breaks.files.map((f) => f.file), ["ad-1.mp4", "ad-2.mp4"]);
  assert.equal(three.breaks.files[0].duration, 30); // cached
  assert.equal(three.breaks.files[1].duration, null); // not probed yet
  assert.equal(three.breaks.files[0].url, "channels/spots/ad-1.mp4");
  const ninety = j.channels.find((c) => c.number === 90);
  assert.equal(ninety.breaks, undefined); // a plain channel stays plain
  assert.ok(j.folders.some((f) => f.folder === "spots" && f.files === 2)); // the picker sees the spots folder too
  writeConfig(configFor(upstreamPort), 12);
});
