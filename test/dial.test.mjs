// node --test test/dial.test.mjs
// The broadcast clock, in Node: dial.js is pure and UMD, so the math that
// puts a channel at the right frame is checked without a browser. The
// browser harness covers the same ground plus the DOM-bound helpers.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const D = require("../dial.js");
const S = require("../config-schema.js");

test("positionAt joins the broadcast mid-program from the wall clock", () => {
  const pl = [{ duration: 30 }, { duration: 60 }, { duration: 10 }];
  assert.deepEqual(D.positionAt(pl, 0, 0), { index: 0, offset: 0 });
  assert.deepEqual(D.positionAt(pl, 45 * 1000, 0), { index: 1, offset: 15 });
  assert.deepEqual(D.positionAt(pl, 95 * 1000, 0), { index: 2, offset: 5 });
  assert.deepEqual(D.positionAt(pl, 130 * 1000, 0), { index: 1, offset: 0 }); // the loop wraps
  const week = 7 * 24 * 3600 * 1000;
  const p = D.positionAt(pl, week + 45 * 1000, 0);
  assert.equal(p.index, 1);
  assert.ok(Math.abs(p.offset - 15) < 0.001, "no drift across a week");
  assert.equal(D.positionAt([{ duration: 30 }, { duration: null }], 1000, 0), null, "an unknown duration stops the clock");
  assert.equal(D.positionAt([], 1000, 0), null);
});

test("two sets agree to the frame: the epoch is fixed, the position is a pure function of the clock", () => {
  const pl = [{ duration: 1800 }, { duration: 3600 }];
  const now = Date.UTC(2026, 8, 2, 20, 12, 33);
  assert.deepEqual(D.positionAt(pl, now, D.EPOCH), D.positionAt(pl, now, D.EPOCH));
  assert.equal(typeof D.EPOCH, "number");
});

test("seededShuffle is stable for a seed and different across seeds", () => {
  const src = ["a", "b", "c", "d", "e", "f", "g"];
  assert.deepEqual(D.seededShuffle(src, "2026-8-31#90"), D.seededShuffle(src, "2026-8-31#90"));
  assert.notDeepEqual(D.seededShuffle(src, "2026-8-31#90"), D.seededShuffle(src, "2026-9-1#90"));
  assert.deepEqual([...D.seededShuffle(src, "x")].sort(), src);
  assert.deepEqual(src, ["a", "b", "c", "d", "e", "f", "g"], "non-mutating");
});

const day = new Date(2026, 8, 2, 12, 0, 0);
const film = (file, duration) => ({ file, url: "channels/movies/" + file, duration });
const spot = (file, duration) => ({ file, url: "channels/spots/" + file, duration });
const programmed = (breaks, order) => ({ number: 3, folder: "movies", order: order || "sequence", breaks });

test("channelTimeline cuts a movie into even acts with a break after every act", () => {
  const ch = programmed({ folder: "spots", everyMinutes: 30, spots: 2 });
  const tl = D.channelTimeline(ch, [film("movie.mp4", 6000)], [spot("s1.mp4", 30), spot("s2.mp4", 15), spot("s3.mp4", 20)], day);
  assert.deepEqual(tl.map((s) => s.file), ["movie.mp4", "s1.mp4", "s2.mp4", "movie.mp4", "s3.mp4", "s1.mp4", "movie.mp4", "s2.mp4", "s3.mp4"]);
  assert.deepEqual([tl[0].from, tl[0].to, tl[3].from, tl[3].to, tl[6].from, tl[6].to], [0, 2000, 2000, 4000, 4000, 6000]);
  const total = tl.reduce((a, s) => a + s.duration, 0);
  assert.ok(Math.abs(total - (6000 + 30 + 15 + 20 + 30 + 15 + 20)) < 1e-9, "the loop is the film plus its spots");
});

test("channelTimeline plays whole while any duration is unknown, and without usable spots", () => {
  const ch = programmed({ folder: "spots", everyMinutes: 15, spots: 1 });
  assert.deepEqual(
    D.channelTimeline(ch, [film("a.mp4", 1200), film("b.mp4", null)], [spot("s1.mp4", 30)], day).map((s) => s.file),
    ["a.mp4", "b.mp4"]
  );
  assert.deepEqual(D.channelTimeline(ch, [film("a.mp4", 600)], [spot("s2.mp4", null)], day).map((s) => s.file), ["a.mp4"]);
});

test("airState: saturday morning cartoons are on saturday morning, and say when they resume", () => {
  const ch = { mode: "schedule", schedule: [{ days: ["sat"], start: "08:00", end: "11:30" }] };
  const on = D.airState(ch, new Date(2026, 7, 29, 9, 0, 0)); // Sat Aug 29 2026
  assert.equal(on.onAir, true);
  assert.equal(new Date(on.untilMs).getHours(), 11);
  assert.equal(D.airState(ch, new Date(2026, 7, 29, 11, 30, 0)).onAir, false, "half-open end");
  const tue = D.airState(ch, new Date(2026, 8, 1, 14, 0, 0));
  assert.equal(tue.onAir, false);
  assert.equal(tue.resumeText, "PROGRAMMING RESUMES SATURDAY 8:00 AM");
  assert.equal(D.airState(ch, new Date(2026, 7, 29, 6, 0, 0)).resumeText, "PROGRAMMING RESUMES TODAY 8:00 AM");
  assert.equal(D.airState({ mode: "continuous" }, new Date()).onAir, true);
});

test("airState: an overnight window is one window across midnight", () => {
  const ch = { mode: "schedule", schedule: [{ days: ["sat"], start: "20:00", end: "01:00" }] };
  assert.equal(D.airState(ch, new Date(2026, 7, 29, 23, 30, 0)).onAir, true);
  assert.equal(D.airState(ch, new Date(2026, 7, 30, 0, 30, 0)).onAir, true);
  assert.equal(D.airState(ch, new Date(2026, 7, 30, 1, 0, 0)).onAir, false);
  assert.equal(D.airState(ch, new Date(2026, 7, 30, 2, 0, 0)).resumeText, "PROGRAMMING RESUMES SATURDAY 8:00 PM");
  assert.deepEqual(S.windowSegments({ days: ["sat"], start: "20:00", end: "01:00" }), [
    { day: 6, start: 1200, end: 1440 },
    { day: 0, start: 0, end: 60, cont: true },
  ]);
});

test("the dial wraps or clamps, and the volume key walks the Zenith order", () => {
  const dial = [{ number: 82 }, { number: 90 }, { number: 91 }];
  assert.equal(D.nextChannelIndex(dial, 2, +1, true), 0);
  assert.equal(D.nextChannelIndex(dial, 2, +1, false), 2);
  assert.equal(D.nextChannelIndex(dial, 0, -1, true), 2);
  assert.equal(D.nextChannelIndex([{ number: 82 }], 0, +1, true), 0);
  assert.deepEqual(D.VOLUME_STEPS.map((v) => v.name), ["LOUD", "SOUND OFF", "SOFT", "MEDIUM"]);
  let i = 0;
  const seen = [];
  for (let n = 0; n < 5; n++) { i = D.nextVolumeStep(i); seen.push(i); }
  assert.deepEqual(seen, [1, 2, 3, 0, 1]);
  assert.equal(D.nextVolumeStep(NaN), 1, "a bad step is loud, and steps to off");
});

test("the guide reads the same clock as the player and merges a long program across slots", () => {
  assert.equal(D.programTitle("02 Design for Dreaming (1956).mp4"), "DESIGN FOR DREAMING (1956)");
  assert.equal(D.programTitle("S01.E13 Duck and Cover.mkv"), "DUCK AND COVER");
  const at = new Date(2026, 8, 2, 20, 12, 0);
  assert.deepEqual(
    D.guideSlots(at, 3).map((d) => d.getHours() + ":" + String(d.getMinutes()).padStart(2, "0")),
    ["20:00", "20:30", "21:00"]
  );
  const films = [
    { file: "Long Movie.mp4", url: "channels/r/a.mp4", duration: 5400 },
    { file: "Short.mp4", url: "channels/r/b.mp4", duration: 1800 },
  ];
  const ch = { number: 2, type: "video", enabled: true, mode: "continuous", order: "sequence", folder: "r" };
  const tl = D.channelTimeline(ch, films, [], at);
  const pos = D.positionAt(tl, at.getTime(), D.EPOCH);
  assert.equal(D.programAt(ch, { files: films }, at, D.EPOCH).title, D.programTitle(tl[pos.index].file));
  const dial = [{ number: 0, type: "guide", name: "CABLEVUE", enabled: true }, ch, { number: 7, type: "video", enabled: false }];
  const g = D.guideGrid(dial, { 2: { files: films, spots: [] } }, at, 3, D.EPOCH);
  assert.equal(g.rows.length, 2, "a channel off the dial is not listed");
  assert.equal(g.rows[0].cells[0].span, 3, "the guide's own row is one cell across");
  assert.equal(g.rows[1].cells.reduce((n, c) => n + c.span, 0), 3, "every slot is covered");
});

test("the clock face writes 12h, 24h, and seconds when asked", () => {
  const d = new Date(2026, 8, 2, 20, 4, 7);
  assert.equal(D.formatClock(d, "12h"), "8:04 PM");
  assert.equal(D.formatClock(d, "24h"), "20:04");
  assert.equal(D.formatClock(d, "12h", { seconds: true }), "8:04:07 PM");
  assert.equal(D.formatClock(new Date(2026, 6, 21, 0, 30), "12h"), "12:30 AM");
  assert.equal(D.formatHeaderDate(new Date(2026, 6, 21)), "TUE JUL 21");
  assert.equal(D.formatLongDate(new Date(2026, 6, 21)), "TUESDAY, JULY 21, 2026");
});
