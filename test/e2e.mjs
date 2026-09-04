// node test/e2e.mjs
//
// The end-to-end drill: the real display in a headless browser, driven the
// way a living room drives it. It boots a server on a temporary config with
// no feeds and no music (nothing leaves the machine), tunes through every
// kind of channel over the bus, watches a real file boundary roll, presses
// the volume and power keys, saves from the control room and sees the set
// reload itself, and asks the remote how many sets are listening.
//
// It needs two things CABLE 82 itself does not: a browser and an encoder.
//   - Playwright, for the browser. Not a dependency of the station; give it
//     a copy: `npm i playwright && npx playwright install chromium` in a
//     scratch folder, then NODE_PATH=<that>/node_modules node test/e2e.mjs.
//   - ffmpeg, to make two four-second clips. FFMPEG=<path> names one that is
//     not on the PATH. Without it the video channel drill is skipped and the
//     rest still runs.
// Without Playwright the script says so and exits 0, so `node --test` on
// the other suites is never blocked by it.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");

// require(), not import(): it honors NODE_PATH, which is how a copy of
// Playwright that lives outside this folder is found.
let playwright = null;
try {
  playwright = require("playwright");
} catch (e) {
  console.log("e2e: Playwright is not installed; skipping the browser drill (see the header of this file).");
  process.exit(0);
}

function findFfmpeg() {
  const candidates = [process.env.FFMPEG, "ffmpeg"];
  for (const c of candidates) {
    if (!c) continue;
    try {
      execFileSync(c, ["-version"], { stdio: "ignore" });
      return c;
    } catch (e) {
      /* try the next */
    }
  }
  return null;
}

const checks = [];
function check(name, ok, detail) {
  checks.push({ name, ok: !!ok, detail });
  console.log((ok ? "  ok   " : "  FAIL ") + name + (ok || !detail ? "" : "  (" + detail + ")"));
}

async function until(fn, ms, every = 100) {
  const end = Date.now() + ms;
  for (;;) {
    let v;
    try { v = await fn(); } catch (e) { v = false; }
    if (v) return v;
    if (Date.now() > end) return false;
    await new Promise((r) => setTimeout(r, every));
  }
}

// ---------------------------------------------------------------- the station

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cable82-e2e-"));
const channelsDir = path.join(tmp, "channels");
const clipsDir = path.join(channelsDir, "e2e clips");
fs.mkdirSync(clipsDir, { recursive: true });

const ffmpeg = findFfmpeg();
let clips = 0;
if (ffmpeg) {
  // Two clips with different colors, VP8 in WebM: the codec every Chromium
  // build plays, Playwright's included. Durations are seeded into the cache
  // so the broadcast clock runs from the first tune.
  const durations = {};
  for (const [n, color] of [["01 Blue", "0x2038C8"], ["02 Green", "0x18A038"]]) {
    const out = path.join(clipsDir, n + ".webm");
    execFileSync(ffmpeg, [
      "-y", "-loglevel", "error",
      "-f", "lavfi", "-i", "color=c=" + color + ":s=320x240:r=15:d=4",
      "-f", "lavfi", "-i", "sine=frequency=440:duration=4",
      "-c:v", "libvpx", "-b:v", "200k", "-c:a", "libvorbis", "-shortest", out,
    ], { stdio: "inherit" });
    durations[path.basename(out)] = 4;
    clips++;
  }
  fs.writeFileSync(path.join(clipsDir, ".durations.json"), JSON.stringify(durations));
} else {
  console.log("e2e: no ffmpeg found (set FFMPEG=<path>); the video channel drill will be skipped.");
}

const configPath = path.join(tmp, "config.json");
fs.writeFileSync(configPath, JSON.stringify({
  channelName: "E2E 82",
  tagline: "DRILL",
  feeds: [],
  rotation: [{ type: "clock" }, { type: "messages" }, { type: "facts" }],
  messages: [{ text: "HELLO FROM THE DRILL" }],
  music: { enabled: false },
  cheerlights: { enabled: false },
  pageSeconds: 3,
  channels: [
    { number: 0, type: "guide" },
    ...(clips ? [{ number: 2, type: "video", name: "CLIPS", folder: "e2e clips" }] : []),
    { number: 5, type: "video", name: "NEVER", folder: "e2e clips", mode: "schedule", schedule: [], offAir: "testcard" },
    { number: 82, type: "bulletin" },
  ],
  tuner: { cut: "none", power: "black" },
}, null, 2));

const { createApp } = require("../server.js");
const app = createApp({ configPath, channelsDir, mediaScanDirs: [], musicDir: path.join(tmp, "no-music") });
await new Promise((r) => app.listen(0, "127.0.0.1", r));
const base = "http://127.0.0.1:" + app.address().port;
const tune = (body) =>
  fetch(base + "/api/tune", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }).then((r) => r.json());

// ---------------------------------------------------------------- the browser

const browser = await playwright.chromium.launch({ args: ["--autoplay-policy=no-user-gesture-required"] });
const context = await browser.newContext({ viewport: { width: 640, height: 480 } });
const page = await context.newPage();
const pageErrors = [];
page.on("pageerror", (e) => pageErrors.push(String(e)));
page.on("console", (m) => { if (m.type() === "error") pageErrors.push(m.text()); });

try {
  await page.goto(base + "/");
  const visible = (sel) => page.evaluate((s) => { const e = document.querySelector(s); return !!e && !e.hidden; }, sel);

  // Sign on: a fresh set comes up on the board, the one channel every
  // install has of its own.
  check("the set signs on to channel 82, the board", await until(async () => !(await visible("#guide-layer")) && (await page.textContent("#ch-name")) === "E2E 82", 5000));
  check("the bus counts one listener", (await (await fetch(base + "/api/tune")).json()).listeners === 1);

  // The guide.
  await tune({ cmd: "set", channel: 0 });
  check("set 0 puts the guide on the air", await until(() => visible("#guide-layer"), 5000));
  const rows = await page.evaluate(() => document.querySelectorAll("#guide-rows .guide-row").length);
  check("the guide lists every enabled channel", rows === (clips ? 4 : 3), "rows=" + rows);
  check("the guide clock is running", /\d:\d\d/.test(await page.textContent("#guide-clock")));
  check("the on-screen display is a centered plate in the upper third, with a dark backing", await page.evaluate(() => {
    const el = document.getElementById("channel-bug");
    const bug = el.getBoundingClientRect();
    const stage = document.getElementById("stage").getBoundingClientRect();
    const centered = Math.abs((bug.left + bug.right) / 2 - (stage.left + stage.right) / 2) < 2;
    const upper = (bug.top + bug.bottom) / 2 < stage.top + stage.height * 0.4;
    const backed = /rgba\(\d+, \d+, \d+, 0\.[5-9]/.test(getComputedStyle(el).backgroundColor);
    return centered && upper && backed;
  }));

  // The board.
  await tune({ cmd: "set", channel: 82 });
  check("set 82 puts the board on the air", await until(async () => !(await visible("#guide-layer")) && (await page.textContent("#ch-name")) === "E2E 82", 5000));
  check("the crawl falls back to the station name with no feeds", (await page.textContent("#crawl-track")).includes("E2E 82"));
  check("the channel bug names the channel", await until(async () => (await page.textContent("#bug-number")) === "CH 82", 3000));
  const crawlMoving = await page.evaluate(async () => {
    const t = document.getElementById("crawl-track");
    const a = getComputedStyle(t).transform;
    await new Promise((r) => setTimeout(r, 400));
    return a !== getComputedStyle(t).transform;
  });
  check("the crawl moves", crawlMoving);

  // A video channel on the broadcast clock, and a file boundary.
  if (clips) {
    await tune({ cmd: "set", channel: 2 });
    check("set 2 puts the video layer up", await until(() => visible("#video-layer"), 5000));
    const playing = await until(() => page.evaluate(() => {
      const v = Array.from(document.querySelectorAll("#video-layer video")).find((x) => !x.hidden);
      return !!v && !v.paused && v.currentTime > 0.3;
    }), 10000);
    check("the program plays", playing);
    const firstSrc = await page.evaluate(() => Array.from(document.querySelectorAll("#video-layer video")).find((x) => !x.hidden).getAttribute("src"));
    const rolled = await until(() => page.evaluate((was) => {
      const v = Array.from(document.querySelectorAll("#video-layer video")).find((x) => !x.hidden);
      return !!v && v.getAttribute("src") !== was && !v.paused;
    }, firstSrc), 9000, 150);
    check("the next program rolls at the file boundary", rolled, "still on " + firstSrc);
  }

  // Off the air: a scheduled channel with no window.
  await tune({ cmd: "set", channel: 5 });
  check("a scheduled channel with no window shows the test card", await until(async () => (await visible("#card-layer")) && /NO PROGRAMMING SCHEDULED/.test(await page.textContent("#card-msg")), 5000));

  // The volume and power keys.
  await tune({ cmd: "volume" });
  check("the volume key steps to sound off, drawn as an empty meter", await until(() => page.evaluate(() => {
    const m = document.getElementById("bug-meter");
    return document.getElementById("bug-number").textContent === "VOLUME" && !m.hidden && m.children.length === 8 && m.querySelectorAll(".on").length === 0;
  }), 3000));
  await tune({ cmd: "volume" });
  check("one more step is soft: three cells", await until(() => page.evaluate(() => document.querySelectorAll("#bug-meter .on").length === 3), 3000));
  await tune({ cmd: "volume" }); await tune({ cmd: "volume" }); // medium, loud
  await new Promise((r) => setTimeout(r, 300));
  await tune({ cmd: "power" });
  check("the power key darkens the set", await until(() => visible("#power-off"), 3000));
  await tune({ cmd: "set", channel: 82 });
  await new Promise((r) => setTimeout(r, 500));
  check("every other key is dead while it is off", (await visible("#power-off")) && !(await visible("#card-layer")));
  await tune({ cmd: "power" });
  check("power again brings the picture back on the same channel", await until(async () => !(await visible("#power-off")) && (await visible("#card-layer")), 3000));

  // The keyboard: up from 5 wraps to 82 here (or to 82 via 2 -> no, 5 -> 82).
  await page.keyboard.press("ArrowUp");
  check("ArrowUp turns the dial", await until(async () => (await page.textContent("#bug-number")) === "CH 82", 3000));
  await page.keyboard.type("0");
  check("digits jump to a number", await until(() => visible("#guide-layer"), 5000));

  // A control-room save reloads the set by itself.
  await page.evaluate(() => { window.__drill = "before"; });
  const cfgNow = await (await fetch(base + "/api/config")).json();
  const saved = await fetch(base + "/api/config", {
    method: "POST",
    headers: { "content-type": "application/json", "x-cable82-config": "1", "x-cable82-config-version": cfgNow.version },
    body: JSON.stringify({ ...cfgNow.config, channelName: "E2E 83" }),
  });
  check("a save is accepted", saved.status === 200);
  check("the set reloads itself on the save", await until(() => page.evaluate(() => window.__drill === undefined && document.getElementById("ch-name").textContent === "E2E 83").catch(() => false), 8000));
  check("the set remembers its channel across the reload", await until(() => visible("#guide-layer"), 5000));

  // The control room.
  const room = await context.newPage();
  await room.goto(base + "/config");
  check("the control room loads the config", await until(async () => /Loaded/.test(await room.textContent("#status")), 5000));
  const groups = await room.evaluate(() => Array.from(document.querySelectorAll(".group-head")).map((h) => h.textContent));
  check("the room shows the six groups, quick settings first", groups.join("|") === "Quick settings|Channels|Community Board|Channel Preview|Display|Server", groups.join("|"));
  check("the vitals panel fills in", await until(async () => (await room.locator("#vitals .vital").count()) >= 4, 5000));
  check("the power panel stays hidden off a Pi", await room.evaluate(() => document.getElementById("p-power").hidden));
  check("the room names the channel", (await room.inputValue("#f-channelName")) === "E2E 83");
  await room.fill("#f-tagline", "SAVED FROM THE ROOM");
  await room.click("#save");
  check("the room saves", await until(async () => /Saved/.test(await room.textContent("#status")), 5000));
  check("the save landed in config.json", JSON.parse(fs.readFileSync(configPath, "utf8")).tagline === "SAVED FROM THE ROOM");
  await room.close();

  // The remote.
  const remote = await context.newPage();
  await remote.goto(base + "/remote-control");
  check("the remote finds the listening set", await until(async () => /One set is listening/.test(await remote.textContent("#status")), 5000));
  await remote.click(".key[data-cmd=\"up\"]");
  check("a key on the remote reports the press", await until(async () => /Channel higher/.test(await remote.textContent("#status")), 3000));
  // Installable: the worker registers on the remote's own scope and covers
  // neither the display nor the control room.
  const scopes = await remote.evaluate(async () => {
    const reg = await navigator.serviceWorker.ready;
    const covers = async (p) => !!(await navigator.serviceWorker.getRegistration(p));
    return { scope: new URL(reg.scope).pathname, root: await covers("/"), room: await covers("/config"), self: await covers("/remote-control") };
  });
  check("the remote's service worker is scoped to /remote-control", scopes.scope === "/remote-control" && scopes.self);
  check("the display and the control room are outside it", !scopes.root && !scopes.room);
  check("the install key waits for the browser's offer", await remote.evaluate(() => document.getElementById("install").hidden));
  await remote.close();

  // A broken config.json at first start: the set says so instead of
  // showing factory defaults, and a Save from the room brings it back.
  const tmp2 = fs.mkdtempSync(path.join(os.tmpdir(), "cable82-e2e-broken-"));
  fs.writeFileSync(path.join(tmp2, "config.json"), "{ this is not json");
  const app2 = createApp({ configPath: path.join(tmp2, "config.json"), mediaScanDirs: [] });
  await new Promise((r) => app2.listen(0, "127.0.0.1", r));
  const base2 = "http://127.0.0.1:" + app2.address().port;
  const broken = await context.newPage();
  await broken.goto(base2 + "/");
  check("a broken config.json shows the error card, with the line and column", await until(async () => {
    const card = await broken.evaluate(() => ({ shown: !document.getElementById("error-card").hidden, text: document.getElementById("error-detail").textContent }));
    return card.shown && /LINE 1, COLUMN 3/.test(card.text);
  }, 5000));
  const room2 = await context.newPage();
  await room2.goto(base2 + "/config");
  check("the room names the broken file rather than blaming the server", await until(async () => /config\.json could not be read/.test(await room2.textContent("#status")), 5000));
  await room2.click("#save");
  check("a Save from the room writes a good file over it", await until(async () => /Saved/.test(await room2.textContent("#status")), 5000));
  check("and the set comes back on its own", await until(() => broken.evaluate(() => document.getElementById("error-card").hidden && document.getElementById("ch-name").textContent === "CABLE 82").catch(() => false), 8000));
  await broken.close();
  await room2.close();
  app2.close();
  fs.rmSync(tmp2, { recursive: true, force: true });

  check("no page errors on the display", pageErrors.length === 0, pageErrors.slice(0, 3).join(" | "));
} finally {
  await browser.close();
  app.close();
  fs.rmSync(tmp, { recursive: true, force: true });
}

const failed = checks.filter((c) => !c.ok);
console.log("\ne2e: " + (checks.length - failed.length) + " passed, " + failed.length + " failed" + (clips ? "" : " (video drill skipped: no ffmpeg)"));
process.exit(failed.length ? 1 : 0);
