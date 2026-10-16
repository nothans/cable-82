// node test/e2e.mjs
//
// The end-to-end drill: the real display in a headless browser, driven the
// way a living room drives it. It boots a server on a temporary config with
// no feeds and no music (nothing leaves the machine), tunes through every
// kind of channel over the bus, watches a real file boundary roll, presses
// the volume and power keys, works a joystick (a stand-in for one: the
// browser is told a pad is plugged in), saves from the control room and sees
// the set reload itself, and asks the remote how many sets are listening.
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
// A joystick for the drill: one stick, eight buttons, nothing pressed, and
// not plugged in until the drill says so. Every page load gets a fresh one.
await context.addInitScript(() => {
  const pad = { index: 0, id: "E2E stick", connected: true, mapping: "", timestamp: 0, axes: [0, 0], buttons: Array.from({ length: 8 }, () => ({ pressed: false, value: 0 })) };
  let plugged = false;
  navigator.getGamepads = () => (plugged ? [pad] : []);
  window.__pad = pad;
  window.__plug = () => { plugged = true; window.dispatchEvent(new Event("gamepadconnected")); };
});
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

  // Jarvis: a line over the bus puts the host on the screen with the words
  // typed under him, his picture actually drawn, and he leaves by himself.
  const said = await (await fetch(base + "/api/jarvis", { method: "POST", body: JSON.stringify({ text: "Good evening, E2E 82." }) })).json();
  check("POST /api/jarvis is accepted and heard by the set", said.ok === true && said.listeners === 1, JSON.stringify(said));
  check("Jarvis pops up over the channel", await until(() => visible("#jarvis"), 3000));
  check("his line types out in the caption", await until(async () => (await page.textContent("#jarvis .jv-text")) === "GOOD EVENING, E2E 82.", 5000));
  check("his picture is drawn, not a blank frame", await page.evaluate(() => {
    const c = document.querySelector("#jarvis canvas");
    const d = c.getContext("2d").getImageData(0, 0, c.width, c.height).data;
    const seen = new Set();
    for (let i = 0; i < d.length; i += 4 * 97) seen.add(d[i] + "," + d[i + 1] + "," + d[i + 2]);
    return seen.size > 20;
  }));
  check("he goes when he is done", await until(async () => !(await visible("#jarvis")), 8000));

  // The keyboard: up from 5 wraps to 82 here (or to 82 via 2 -> no, 5 -> 82).
  await page.keyboard.press("ArrowUp");
  check("ArrowUp turns the dial", await until(async () => (await page.textContent("#bug-number")) === "CH 82", 3000));
  await page.keyboard.type("0");
  check("digits jump to a number", await until(() => visible("#guide-layer"), 5000));

  // The joystick. Left and right move the sound a cell at a time, a held
  // stick keeps moving it, a corner is no direction. Two presses of the
  // button are the power key; ten shut the machine down, counted on the
  // screen from the third.
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const stick = (x, y) => page.evaluate(([ax, ay]) => { window.__pad.axes = [ax, ay]; }, [x, y]);
  const nudge = async (x, y) => { await stick(x, y); await wait(120); await stick(0, 0); await wait(120); };
  const button = (b, down) => page.evaluate(([i, d]) => { window.__pad.buttons[i] = { pressed: d, value: d ? 1 : 0 }; }, [b, down]);
  const tap = async (times, b = 0) => {
    for (let n = 0; n < times; n++) { await button(b, true); await wait(80); await button(b, false); await wait(80); }
  };
  const cells = () => page.evaluate(() => document.querySelectorAll("#bug-meter .on").length);
  const plate = () => page.evaluate(() => {
    const b = document.getElementById("channel-bug");
    return { big: document.getElementById("bug-number").textContent, small: document.getElementById("bug-name").textContent, shown: !b.hidden && !b.classList.contains("fading"), on: b.parentNode.id };
  });
  await page.evaluate(() => window.__plug());
  await nudge(-1, 0);
  check("the stick pushed left turns the sound down one cell", await until(async () => (await plate()).big === "VOLUME" && (await cells()) === 7, 3000), "cells=" + (await cells()));
  await nudge(1, 0);
  check("pushed right, up one cell", await until(async () => (await cells()) === 8, 3000), "cells=" + (await cells()));
  await nudge(1, 0);
  check("loud is the top", (await cells()) === 8);
  await stick(-1, 0);
  await wait(1300);
  await stick(0, 0);
  const held = await cells();
  check("held left, it keeps going down", held <= 4 && held >= 1, "cells=" + held);
  await wait(400);
  check("and stops when the stick is let go", (await cells()) === held);
  await stick(1, -1);
  await wait(400);
  await stick(1, 0);
  await wait(700);
  await stick(0, 0);
  await wait(150);
  check("a corner is no direction, and the stick is spent until it has been back to the middle", (await cells()) === held && (await visible("#guide-layer")), "cells=" + (await cells()));
  await nudge(0, -1);
  check("up on the stick still turns the dial", await until(async () => /^CH (2|5)$/.test((await plate()).big), 3000), (await plate()).big);
  await wait(400);
  await nudge(0, 1);
  check("and down turns it back", await until(() => visible("#guide-layer"), 5000));
  await wait(400);

  await tap(1);
  await wait(700);
  check("one press of the button does nothing", !(await visible("#power-off")));
  await tap(2);
  check("two presses switch the set off", await until(() => visible("#power-off"), 3000));
  await wait(300);
  await nudge(-1, 0);
  check("the stick is dead while it is off", await visible("#power-off"));
  await tap(2);
  check("two more bring the picture back on the same channel", await until(async () => !(await visible("#power-off")) && (await visible("#guide-layer")), 3000));
  await wait(300);
  await tap(1, 0); await tap(1, 1);
  await wait(700);
  check("one press each of two buttons is not a double press", !(await visible("#power-off")));

  await tap(4);
  const counting = await plate();
  check("from the third press the screen counts toward the shutdown", counting.big === "SHUT DOWN" && counting.small === "4 OF 10" && counting.shown && (await cells()) === 3, JSON.stringify(counting));
  await wait(900);
  check("a run that stops short does nothing", !(await visible("#power-off")) && !(await plate()).shown);

  // Off a Pi the server refuses, and the set says why and stays on.
  await tap(10);
  check("ten presses ask the server; a machine that cannot be powered says so and stays on", await until(async () => {
    const p = await plate();
    return p.big === "STILL ON" && p.small === "CANNOT SHUT DOWN FROM HERE";
  }, 5000), JSON.stringify(await plate()));
  check("and the picture is still there", !(await visible("#power-off")));
  await wait(700);
  // The browser writes a refused request to its console. That one line is
  // the drill's own doing, so it is taken off the list of page errors.
  const refused = pageErrors.findIndex((e) => /403/.test(e));
  check("the refusal is the only thing the display complained about", refused >= 0 && pageErrors.length === 1, JSON.stringify(pageErrors));
  if (refused >= 0) pageErrors.splice(refused, 1);

  // A machine that can: the answer is played by the drill, so nothing here
  // is switched off. The request is the control room's own.
  const asked = [];
  await page.route("**/api/system", (route) => {
    const rq = route.request();
    asked.push({ method: rq.method(), header: rq.headers()["x-cable82-config"], body: rq.postData() });
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ok: true, cmd: "shutdown" }) });
  });
  await tap(10);
  check("ten presses send the shutdown the control room sends", (await until(() => asked.length === 1, 5000)) && asked[0].method === "POST" && asked[0].header === "1" && JSON.parse(asked[0].body).cmd === "shutdown", JSON.stringify(asked));
  check("the picture goes out", await until(() => visible("#power-off"), 3000));
  check("and the dark screen says SHUTTING DOWN", await until(async () => {
    const p = await plate();
    return p.big === "SHUTTING DOWN" && p.shown && p.on === "power-off";
  }, 4000), JSON.stringify(await plate()));
  const plateBox = await page.evaluate(() => {
    const b = document.getElementById("channel-bug").getBoundingClientRect();
    return { w: b.width, h: b.height, mid: (b.left + b.right) / 2, font: parseFloat(getComputedStyle(document.getElementById("bug-number")).fontSize) };
  });
  check("the plate on the dark screen is drawn at the size it has on the picture", Math.abs(plateBox.font - 56) < 1 && Math.abs(plateBox.mid - 320) < 2 && plateBox.w > 200 && plateBox.w < 600, JSON.stringify(plateBox));
  await tap(12);
  await wait(300);
  check("it is asked once, however long the button is mashed", asked.length === 1, "asked=" + asked.length);
  await page.unroute("**/api/system");

  // Put the set back the way the rest of the drill expects it: a reload
  // comes up dark (the set remembers), and two presses switch it on.
  await page.reload();
  check("the set remembers it was off across a reload", await until(() => visible("#power-off"), 5000));
  await page.evaluate(() => window.__plug());
  await tap(2);
  check("two presses switch it back on, on the guide", await until(async () => !(await visible("#power-off")) && (await visible("#guide-layer")), 5000));
  await wait(300);
  await nudge(1, 0);
  check("and it remembers the sound level too", await until(async () => (await cells()) === held + 1, 3000), "cells=" + (await cells()) + " held=" + held);
  await wait(300);

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
  check("the room shows the seven groups, quick settings first", groups.join("|") === "Quick settings|Channels|Community Board|Channel Preview|Jarvis|Display|Server", groups.join("|"));
  check("the vitals panel fills in", await until(async () => (await room.locator("#vitals .vital").count()) >= 4, 5000));
  check("the power panel stays hidden off a Pi", await room.evaluate(() => document.getElementById("p-power").hidden));
  check("the room names the channel", (await room.inputValue("#f-channelName")) === "E2E 83");
  check("the room shows ten presses to shut down", (await room.inputValue("#f-tunerShutdown")) === "10");
  check("the room says whether Jarvis has a voice here", await until(async () => /voice|switched off/i.test(await room.textContent("#jarvisVoiceStatus")), 5000));
  await room.fill("#f-jarvisName", "e2e host");
  await room.fill("#f-tunerShutdown", "7");
  await room.fill("#f-tagline", "SAVED FROM THE ROOM");
  check("the faux CRT panel shows the sliders with their numbers", await room.evaluate(() => document.getElementById("f-fauxCurve").value === "3" && document.getElementById("o-fauxCurve").value === "3" && !document.getElementById("f-fauxOn").checked));
  await room.evaluate(() => { const s = document.getElementById("f-fauxCurve"); s.value = "6"; s.dispatchEvent(new Event("input", { bubbles: true })); });
  check("a slider shows its new number as it moves", await room.evaluate(() => document.getElementById("o-fauxCurve").value === "6"));
  await room.click("#save");
  check("the room saves", await until(async () => /Saved/.test(await room.textContent("#status")), 5000));
  const savedCfg = JSON.parse(fs.readFileSync(configPath, "utf8"));
  check("the save landed in config.json", savedCfg.tagline === "SAVED FROM THE ROOM");
  check("the faux CRT sliders round-trip through the room", savedCfg.fauxCrt && savedCfg.fauxCrt.curve === 6 && savedCfg.fauxCrt.on === false, JSON.stringify(savedCfg.fauxCrt));
  check("and so do the presses to shut down", savedCfg.tuner.shutdownPresses === 7, JSON.stringify(savedCfg.tuner));
  check("and Jarvis's name, lettered the station's way", savedCfg.jarvis && savedCfg.jarvis.name === "E2E HOST", JSON.stringify(savedCfg.jarvis));
  // Try him from the room: the set reloads on the save, then the Time key
  // puts him on it under the new name.
  await until(async () => (await (await fetch(base + "/api/tune")).json()).listeners === 1, 8000);
  await room.click('#p-jarvis-try [data-ask="time"]');
  check("Try him reports the set that heard him", await until(async () => /^On 1 set: It's /.test(await room.textContent("#jarvisTryOut")), 5000), await room.textContent("#jarvisTryOut"));
  check("and the set shows him under his new name", await until(async () => (await visible("#jarvis")) && (await page.textContent("#jarvis .jv-flag")) === "E2E HOST", 5000));
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

  // Faux CRT: the flat-panel path. A save turns it on; the set reloads into
  // the console, the picture sits in its glass at 4:3, the dial follows the
  // tune, a click on the dial tunes, and switching off leaves the console
  // on the wall. Then the tube rule: CRT mode on turns it back off, with a
  // warning.
  await page.setViewportSize({ width: 1280, height: 720 });
  const cfgFaux = await (await fetch(base + "/api/config")).json();
  const fauxSave = await fetch(base + "/api/config", {
    method: "POST",
    headers: { "content-type": "application/json", "x-cable82-config": "1", "x-cable82-config-version": cfgFaux.version },
    body: JSON.stringify({ ...cfgFaux.config, fauxCrt: { ...cfgFaux.config.fauxCrt, on: true, curve: 4, wave: 2, bloom: 2, noise: 3 } }),
  });
  check("a save can turn faux CRT on", fauxSave.status === 200);
  check("the set reloads into the console", await until(() => page.evaluate(() => document.getElementById("letterbox").classList.contains("faux") && !document.getElementById("set").hidden && !!document.querySelector("#set svg")).catch(() => false), 8000));
  const glass = await page.evaluate(() => {
    const set = document.getElementById("letterbox").getBoundingClientRect();
    const st = document.getElementById("stage").getBoundingClientRect();
    return { setW: set.width, setH: set.height, x: st.left - set.left, y: st.top - set.top, w: st.width, h: st.height, clip: getComputedStyle(document.getElementById("stage")).clipPath, filter: getComputedStyle(document.getElementById("stage")).filter };
  });
  check("the console covers the panel at 16:9", Math.abs(glass.setW / glass.setH - 16 / 9) < 0.01 && glass.setW >= 1280 - 1, JSON.stringify(glass));
  check("the picture sits in the glass at 4:3", Math.abs(glass.w / glass.h - 4 / 3) < 0.01 && glass.x > 0 && glass.y > 0 && glass.x + glass.w < glass.setW * 0.75, JSON.stringify(glass));
  check("the glass is cut to the picture's own curve", /^polygon\(/.test(glass.clip), glass.clip);
  check("the picture tells run as one filter on the stage", /url\(/.test(glass.filter), glass.filter);
  const numbersOnRing = await page.evaluate(() => Array.from(document.querySelectorAll("#set .dn")).map((g) => g.dataset.ch));
  check("the dial carries the lineup's numbers in order", numbersOnRing.join(",") === (clips ? "0,2,5,82" : "0,5,82"), numbersOnRing.join(","));
  const pointerBefore = await page.evaluate(() => document.getElementById("set-pointer").style.transform);
  await tune({ cmd: "set", channel: 82 });
  check("the pointer turns on a tune", await until(() => page.evaluate((was) => document.getElementById("set-pointer").style.transform !== was && document.querySelector("#set .dn.on") && document.querySelector("#set .dn.on").dataset.ch === "82", pointerBefore), 5000));
  await page.click("#set .dn[data-ch=\"0\"]");
  check("a click on the dial tunes", await until(() => visible("#guide-layer"), 5000));
  await tune({ cmd: "power" });
  check("switched off, the console stays and the dark screen fills only the glass", await until(() => page.evaluate(() => {
    const p = document.getElementById("power-off");
    if (p.hidden) return false;
    const pr = p.getBoundingClientRect(), sr = document.getElementById("stage").getBoundingClientRect();
    return !document.getElementById("set").hidden && Math.abs(pr.left - sr.left) < 1 && Math.abs(pr.width - sr.width) < 1;
  }), 3000));
  await tune({ cmd: "power" });
  await until(() => page.evaluate(() => document.getElementById("power-off").hidden), 3000);
  const cfgTube = await (await fetch(base + "/api/config")).json();
  const tubeSave = await (await fetch(base + "/api/config", {
    method: "POST",
    headers: { "content-type": "application/json", "x-cable82-config": "1", "x-cable82-config-version": cfgTube.version },
    body: JSON.stringify({ ...cfgTube.config, crtMode: true }),
  })).json();
  check("CRT mode turns faux CRT off on save, and says so", tubeSave.ok && tubeSave.config.fauxCrt.on === false && tubeSave.warnings.some((w) => /FAUX CRT TURNED OFF/.test(w)), JSON.stringify(tubeSave.warnings));
  check("the set reloads out of the console", await until(() => page.evaluate(() => !document.getElementById("letterbox").classList.contains("faux") && document.getElementById("set").hidden).catch(() => false), 8000));
  await page.setViewportSize({ width: 640, height: 480 });

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
