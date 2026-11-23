// node --test test/dial.test.mjs
// The broadcast clock, in Node: dial.js is pure and UMD, so the math that
// puts a channel at the right frame is checked without a browser. The
// browser harness covers the same ground plus the DOM-bound helpers.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const D = require("../dial.js");
// A second copy of the dial with nothing remembered: the block clock keeps
// a walk per channel, and a fresh copy shows that memory never changes an
// answer.
const freshDial = () => {
  const keep = require.cache[require.resolve("../dial.js")];
  delete require.cache[require.resolve("../dial.js")];
  const copy = require("../dial.js");
  require.cache[require.resolve("../dial.js")] = keep;
  return copy;
};
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

test("channelTimeline spaces between-program breaks with everyPrograms, and breaks at the loop's seam", () => {
  const ch = programmed({ folder: "spots", everyMinutes: 0, spots: 1, everyPrograms: 5 });
  const songs = Array.from({ length: 12 }, (_, i) => film("song" + String(i + 1).padStart(2, "0") + ".mp4", 200));
  const tl = D.channelTimeline(ch, songs, [spot("s1.mp4", 30), spot("s2.mp4", 15)], day);
  const kinds = tl.map((s) => (s.kind === "spot" ? "|" : "."));
  assert.equal(kinds.join(""), ".....|.....|..|", "a break after songs 5 and 10, and after the last");
  assert.deepEqual(tl.filter((s) => s.kind === "spot").map((s) => s.file), ["s1.mp4", "s2.mp4", "s1.mp4"]);
  assert.deepEqual(
    D.channelTimeline(programmed({ folder: "spots", everyMinutes: 0, spots: 1 }), songs.slice(0, 3), [spot("s1.mp4", 30)], day)
      .map((s) => s.kind),
    ["program", "spot", "program", "spot", "program", "spot"],
    "no everyPrograms: a break after every program, as before"
  );
  const cut = D.channelTimeline(programmed({ folder: "spots", everyMinutes: 30, spots: 1, everyPrograms: 5 }),
    [film("movie.mp4", 3600)], [spot("s1.mp4", 30)], day);
  assert.deepEqual(cut.map((s) => s.kind), ["program", "spot", "program", "spot"], "acts ignore everyPrograms");
  assert.equal(S.validateConfig({ channels: [{ number: 2, type: "video", folder: "a", breaks: { folder: "b", everyPrograms: 99 } }] })
    .cfg.channels.find((c) => c.number === 2).breaks.everyPrograms, 50, "clamped to 50");
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

test("the volume key walks the Zenith ring from any level, and a stick moves one cell and stops at the ends", () => {
  // The ring, from the levels the key itself leaves behind.
  let l = 1;
  const ring = [];
  for (let n = 0; n < 5; n++) { l = D.nextVolumeLevel(l); ring.push(l); }
  assert.deepEqual(ring, [0, 0.35, 0.7, 1, 0]);
  // From a level only a stick can leave: up to the next step of the ring.
  assert.equal(D.nextVolumeLevel(0.5), 0.7);
  assert.equal(D.nextVolumeLevel(0.875), 1);
  assert.equal(D.nextVolumeLevel(NaN), 0, "a bad level is loud, and steps to off");
  // One cell of eight at a time.
  assert.equal(D.VOLUME_CELLS, 8);
  assert.equal(D.stepVolumeLevel(1, -1), 0.875);
  assert.equal(D.stepVolumeLevel(1, +1), 1, "loud is the top");
  assert.equal(D.stepVolumeLevel(0, -1), 0, "sound off is the bottom");
  assert.equal(D.stepVolumeLevel(0, +1), 0.125);
  // From the ring's own levels it lands on the cell next to the one drawn:
  // soft is drawn as three cells, so louder is four and softer is two.
  assert.equal(D.stepVolumeLevel(0.35, +1), 0.5);
  assert.equal(D.stepVolumeLevel(0.35, -1), 0.25);
  let walk = 0;
  for (let n = 0; n < 12; n++) walk = D.stepVolumeLevel(walk, +1);
  assert.equal(walk, 1);
});

test("presses of one button in a row are counted, and the count is the meaning", () => {
  const gap = D.PRESS_GAP_MS;
  let run = D.countPress(null, "0:0", 1000);
  assert.deepEqual(run, { button: "0:0", count: 1, at: 1000 });
  run = D.countPress(run, "0:0", 1000 + gap);
  assert.equal(run.count, 2, "a press at the edge of the gap still belongs");
  run = D.countPress(run, "0:0", run.at + gap + 1);
  assert.equal(run.count, 1, "a press after the gap starts over");
  run = D.countPress(run, "0:1", run.at + 10);
  assert.equal(run.count, 1, "another button starts over");
  for (let n = 0; n < 9; n++) run = D.countPress(run, "0:1", run.at + 120);
  assert.equal(run.count, 10);

  assert.equal(D.runMeaning(1, 10), null);
  assert.equal(D.runMeaning(2, 10), "power");
  for (let n = 3; n < 10; n++) assert.equal(D.runMeaning(n, 10), null, n + " presses mean nothing");
  assert.equal(D.runMeaning(10, 10), "shutdown");
  assert.equal(D.runMeaning(11, 10), "shutdown");
  assert.equal(D.runMeaning(10, 0), null, "0 turns the long run off");
  assert.equal(D.runMeaning(2, 0), "power");
  assert.equal(D.runMeaning(5, 5), "shutdown");
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

test("the guide never lists a commercial: a break at the slot names the program it sits inside", () => {
  const ch = { number: 2, type: "video", enabled: true, mode: "continuous", order: "sequence", folder: "movies", breaks: { folder: "spots", everyMinutes: 30, spots: 1 } };
  const films = [film("Long Movie.mp4", 3600), film("Short.mp4", 1800)];
  const spots = [spot("Buy Soap.mp4", 30)];
  const at = new Date(2026, 8, 3, 12, 0, 0);
  const tl = D.channelTimeline(ch, films, spots, at);
  assert.deepEqual(tl.map((s) => s.kind), ["program", "spot", "program", "spot", "program", "spot"]);
  // find a moment the clock lands inside the first spot and ask the guide about it
  let total = 0;
  const starts = tl.map((s) => { const t = total; total += s.duration; return t; });
  const inSpot = D.EPOCH + (starts[1] + 10) * 1000;
  const p = D.programAt(ch, { files: films, spots }, new Date(inSpot), D.EPOCH);
  assert.equal(p.title, "LONG MOVIE");
  assert.equal(p.kind, "program");
  // and a moment inside the second act names the same film
  const inAct2 = D.EPOCH + (starts[2] + 10) * 1000;
  assert.equal(D.programAt(ch, { files: films, spots }, new Date(inAct2), D.EPOCH).title, "LONG MOVIE");
  // the break after Long Movie's last act, before Short, still belongs to Long Movie
  const inLastBreak = D.EPOCH + (starts[3] + 5) * 1000;
  assert.equal(D.programAt(ch, { files: films, spots }, new Date(inLastBreak), D.EPOCH).title, "LONG MOVIE");
});

test("segmentName follows the channel's titles setting", () => {
  const seg = { file: "BBDVD0102.mp4", title: "Give Blood" };
  assert.equal(D.segmentName({ titles: "filename" }, seg), "BBDVD0102");
  assert.equal(D.segmentName({ titles: "metadata" }, seg), "GIVE BLOOD");
  assert.equal(D.segmentName({ titles: "metadata" }, { file: "02 Design for Dreaming.mp4", title: null }), "DESIGN FOR DREAMING", "no title inside: the file name");
  assert.equal(D.segmentName({ titles: "fixed", title: "COMMERCIALS" }, seg), "COMMERCIALS");
  assert.equal(D.segmentName({ titles: "fixed", name: "LATE NIGHT" }, seg), "LATE NIGHT");
  assert.equal(D.segmentName({}, seg), "BBDVD0102", "no setting: the file name, as before");
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

// ---------------------------------------------------------- several folders and the block clock

const cartoon = (show, n, duration) => ({ file: show + " " + n + ".mp4", url: "channels/" + show + "/" + n + ".mp4", duration });
const block = (extra) => Object.assign({
  number: 17, type: "video", enabled: true, folder: "T", folders: ["T", "N"], order: "sequence",
  mode: "schedule", clock: "block", schedule: [{ days: ["sat"], start: "09:00", end: "11:00" }],
}, extra || {});
// Saturday September 5, 2026, midnight: the start of the walk in these tests.
const SAT = new Date(2026, 8, 5, 0, 0, 0).getTime();
const at = (week, h, m, s) => new Date(2026, 8, 5 + 7 * week, h, m || 0, s || 0).getTime();
const libOf = (lists, spots) => ({ files: lists.flatMap((l) => l.files), spots: spots || [], sources: lists });
// What a channel has on the air at `t`: the segment with its offset, or null.
const onAir = (dial, ch, lib, t, epoch) => {
  const { tl, pos } = dial.channelAir(ch, lib, new Date(t), epoch === undefined ? SAT : epoch);
  return pos && Object.assign({}, tl[pos.index], { offset: pos.offset });
};
const playing = (ch, lib, t, epoch) => {
  const s = onAir(D, ch, lib, t, epoch);
  return s && [s.file, s.offset];
};

test("while lengths are unknown, several folders take turns in the day's loop, and an empty folder sits out", () => {
  const T = [cartoon("T", 1, 10), cartoon("T", 2, 10), cartoon("T", 3, 10)];
  const N = [cartoon("N", 1, 10), cartoon("N", 2, 10)];
  const ch = block();
  assert.deepEqual(D.channelPrograms(ch, T.concat(N), day, [T, N]).map((f) => f.file),
    ["T 1.mp4", "N 1.mp4", "T 2.mp4", "N 2.mp4", "T 3.mp4", "N 1.mp4"]);
  assert.deepEqual(D.channelPrograms(ch, T, day, [T]).map((f) => f.file), ["T 1.mp4", "T 2.mp4", "T 3.mp4"], "one folder is just its files");
  assert.deepEqual(D.channelPrograms(ch, T, day).map((f) => f.file), ["T 1.mp4", "T 2.mp4", "T 3.mp4"], "no sources: the files as given");
  assert.deepEqual(D.channelPrograms(ch, T, day, [T, []]).map((f) => f.file), ["T 1.mp4", "T 2.mp4", "T 3.mp4"], "an empty folder sits out");
  assert.deepEqual(D.channelPrograms(ch, [], day, [[], []]), []);
});

test("several folders take turns, and each cycles through its own files with no seam", () => {
  // The Pi's Saturday block in miniature: 16 of one show, 5 of the other.
  const T = Array.from({ length: 16 }, (_, i) => cartoon("T", i + 1, 10));
  const N = Array.from({ length: 5 }, (_, i) => cartoon("N", i + 1, 10));
  const lib = libOf([{ folder: "T", files: T }, { folder: "N", files: N }]);
  for (const ch of [block({ number: 30, mode: "continuous", clock: undefined }), block({ number: 31, schedule: [{ days: ["sat", "sun", "mon", "tue", "wed", "thu", "fri"], start: "00:00", end: "00:00" }] })]) {
    const epoch = ch.clock ? SAT : D.EPOCH;
    const base = ch.clock ? SAT + 5000 : D.EPOCH + 5000;
    const seen = [];
    for (let g = 0; g < 400; g++) seen.push(playing(ch, lib, base + g * 10000, epoch)[0]);
    seen.forEach((f, g) => {
      const folder = g % 2 ? N : T;
      const k = Math.floor(g / 2);
      assert.equal(f, folder[k % folder.length].file, (ch.clock || "station") + " program " + g + ": turn " + k + " of its folder");
    });
    const turtles = seen.filter((f) => f[0] === "N");
    for (let k = 1; k < turtles.length; k++) assert.notEqual(turtles[k], turtles[k - 1], "no episode twice in a row");
  }
});

test("one folder on the station's clock airs exactly as before several folders existed", () => {
  const films = [film("a.mp4", 1200), film("b.mp4", 3000), film("c.mp4", 900)];
  const spots = [spot("s1.mp4", 30), spot("s2.mp4", 15)];
  for (const order of ["sequence", "shuffle-daily"]) {
    const ch = programmed({ folder: "spots", everyMinutes: 15, spots: 2 }, order);
    for (const t of [D.EPOCH + 1000, Date.UTC(2026, 8, 5, 13, 7, 41), Date.UTC(2027, 2, 1, 2, 3, 4)]) {
      const tl = D.channelTimeline(ch, films, spots, new Date(t));
      const air = D.channelAir(ch, { files: films, spots, sources: [{ folder: "movies", files: films }] }, new Date(t), D.EPOCH);
      assert.deepEqual(air.tl, tl);
      assert.deepEqual(air.pos, D.positionAt(tl, t, D.EPOCH));
    }
  }
});

test("shuffled folders still alternate, each shuffled on its own and stable all day", () => {
  const T = [1, 2, 3, 4, 5].map((n) => cartoon("T", n, 10));
  const N = [1, 2, 3, 4, 5].map((n) => cartoon("N", n, 10));
  const ch = block({ order: "shuffle-daily" });
  const a = D.channelPrograms(ch, T.concat(N), day, [T, N]);
  assert.deepEqual(a.map((f) => f.file[0]), ["T", "N", "T", "N", "T", "N", "T", "N", "T", "N"], "the shows alternate");
  assert.deepEqual(a.filter((f) => f.file[0] === "T").map((f) => f.file).sort(), T.map((f) => f.file).sort(), "every episode once");
  assert.deepEqual(D.channelPrograms(ch, T.concat(N), day, [T, N]), a, "the same order all day");
  // Each folder is seeded on its own: the first show's order does not depend on what else is in the block.
  const alone = D.channelPrograms(ch, T.concat(N), day, [T, [cartoon("Z", 1, 10)]]).filter((f) => f.file[0] === "T");
  assert.deepEqual(alone.map((f) => f.file), a.filter((f) => f.file[0] === "T").map((f) => f.file));
});

test("a block's breaks fall between the shows that take turns", () => {
  const T = [cartoon("T", 1, 1320), cartoon("T", 2, 1320)];
  const N = [cartoon("N", 1, 1320)];
  const ch = block({ number: 32, mode: "continuous", clock: undefined, breaks: { folder: "spots", everyMinutes: 0, spots: 2 } });
  const { tl } = D.channelAir(ch, libOf([{ folder: "T", files: T }, { folder: "N", files: N }], [spot("s1.mp4", 30), spot("s2.mp4", 30)]), new Date(D.EPOCH + 1000), D.EPOCH);
  assert.deepEqual(tl.map((s) => s.kind[0] + ":" + s.file),
    ["p:T 1.mp4", "s:s1.mp4", "s:s2.mp4", "p:N 1.mp4", "s:s1.mp4", "s:s2.mp4", "p:T 2.mp4", "s:s1.mp4", "s:s2.mp4"],
    "the program on the air and the two after it, the spots cycling on");
});

test("airSpans reads an overnight window and back-to-back windows as one stretch on the air", () => {
  const night = { schedule: [{ days: ["sat"], start: "20:00", end: "01:00" }] };
  const spans = D.airSpans(night, SAT, SAT + 2 * 86400000);
  assert.equal(spans.length, 1);
  assert.equal(new Date(spans[0].s).getHours(), 20);
  assert.equal((spans[0].e - spans[0].s) / 3600000, 5);
  const twin = { schedule: [{ days: ["sat"], start: "09:00", end: "10:00" }, { days: ["sat"], start: "10:00", end: "11:00" }] };
  const two = D.airSpans(twin, SAT, SAT + 86400000);
  assert.equal(two.length, 1);
  assert.equal((two[0].e - two[0].s) / 3600000, 2);
});

// Six 25-minute programs alternating two shows, in a 2-hour window.
const sixT = [1, 2, 3].map((n) => cartoon("T", n, 1500));
const sixN = [1, 2, 3].map((n) => cartoon("N", n, 1500));
const sixLib = libOf([{ folder: "T", files: sixT }, { folder: "N", files: sixN }]);

test("the block clock opens every window at the top of a program", () => {
  const ch = block({ number: 101 });
  assert.deepEqual(playing(ch, sixLib, at(0, 9)), ["T 1.mp4", 0], "first window, first program");
  assert.deepEqual(playing(ch, sixLib, at(0, 9, 30)), ["N 1.mp4", 300], "mid-window, the channel's own clock");
  assert.equal(playing(ch, sixLib, at(0, 8, 59)), null, "off the air before the window");
  assert.equal(playing(ch, sixLib, at(0, 11)), null, "off the air at the close");
  assert.equal(playing(ch, sixLib, at(0, 14)), null);
});

test("the next window opens at the top of the program the last window cut off", () => {
  const ch = block({ number: 102 });
  // Week 0 runs 7200 s from T 1 and cuts T 3 off 1200 s in, so week 1 opens on T 3 again.
  assert.deepEqual(playing(ch, sixLib, at(1, 9)), ["T 3.mp4", 0]);
  assert.deepEqual(playing(ch, sixLib, at(1, 9, 10)), ["T 3.mp4", 600]);
  // Week 1 runs T 3, N 3, T 1, N 1 and cuts T 2 off, so week 2 opens on T 2.
  assert.deepEqual(playing(ch, sixLib, at(2, 9)), ["T 2.mp4", 0]);
  // The same answers asked in another order, and from a fresh walk, so the memo never changes the picture.
  const fresh = freshDial();
  assert.deepEqual(onAir(fresh, ch, sixLib, at(2, 9)).file, "T 2.mp4");
  assert.deepEqual(onAir(fresh, ch, sixLib, at(1, 9, 10)).offset, 600);
  assert.deepEqual(onAir(fresh, ch, sixLib, at(0, 9, 30)).file, "N 1.mp4");
});

test("a window that closes exactly at a program's top hands the next window that program", () => {
  const T = [1, 2, 3].map((n) => cartoon("T", n, 1800));
  const N = [1, 2].map((n) => cartoon("N", n, 1800));
  const ch = block({ number: 104 });
  const lib = libOf([{ folder: "T", files: T }, { folder: "N", files: N }]);
  // Week 0 plays exactly four half hours, so week 1 opens on the fifth program, T 3.
  assert.deepEqual(playing(ch, lib, at(1, 9)), ["T 3.mp4", 0]);
  // Week 1 plays T 3, N 1, T 1, N 2: the Turtles go on from where they were.
  assert.deepEqual(playing(ch, lib, at(1, 9, 31)), ["N 1.mp4", 60]);
  assert.deepEqual(playing(ch, lib, at(2, 9)), ["T 2.mp4", 0]);
});

test("a window too short to finish the program it opened on moves on next time", () => {
  const ch = block({ number: 105, schedule: [{ days: ["sat"], start: "09:00", end: "09:20" }] });
  assert.deepEqual(playing(ch, sixLib, at(0, 9, 10)), ["T 1.mp4", 600]);
  assert.deepEqual(playing(ch, sixLib, at(1, 9)), ["N 1.mp4", 0], "never T 1 every week");
  assert.deepEqual(playing(ch, sixLib, at(2, 9)), ["T 2.mp4", 0]);
});

test("a block shorter than its window goes on inside it", () => {
  const ch = block({ number: 106 });
  const lib = libOf([{ folder: "T", files: [cartoon("T", 1, 1000)] }, { folder: "N", files: [cartoon("N", 1, 1000)] }]);
  assert.deepEqual(playing(ch, lib, at(0, 9) + 2100 * 1000), ["T 1.mp4", 100]);
});

test("the block clock waits for every duration, like the station clock", () => {
  const ch = block({ number: 107 });
  const lib = libOf([{ folder: "T", files: [cartoon("T", 1, null)] }, { folder: "N", files: [cartoon("N", 1, 600)] }]);
  const air = D.channelAir(ch, lib, new Date(at(0, 9, 5)), SAT);
  assert.equal(air.pos, null);
  assert.deepEqual(air.tl.map((s) => s.file), ["T 1.mp4", "N 1.mp4"], "the loop to play in turn meanwhile");
});

test("a block setting does nothing on a channel without scheduled hours", () => {
  const now = new Date(at(0, 9, 30));
  const station = D.channelAir(block({ number: 108, mode: "continuous", clock: undefined }), sixLib, now, SAT);
  assert.deepEqual(D.channelAir(block({ number: 109, mode: "continuous" }), sixLib, now, SAT), station);
});

test("the guide names what the block is showing, from the same clock as the picture", () => {
  const ch = block({ number: 111 });
  assert.equal(D.programAt(ch, sixLib, new Date(at(0, 9, 1)), SAT).title, "T 1");
  assert.equal(D.programAt(ch, sixLib, new Date(at(1, 9, 1)), SAT).title, "T 3");
  assert.equal(D.programAt(ch, sixLib, new Date(at(1, 12)), SAT).kind, "offair");
});

test("the block clock's memory never changes the answer: a reorder in the middle walks afresh", () => {
  const reorder = (files) => [files[0], files[3], files[1], files[2], files[4]];
  const epoch = Date.UTC(2026, 0, 1);
  const check = (durations, n) => {
    const files = durations.map((d, i) => cartoon("T", i + 1, d));
    const ch = block({ number: 200 + n, folders: ["T"] });
    onAir(D, ch, libOf([{ folder: "T", files }]), at(10, 9, 30), epoch); // the memo is filled from the first order
    const moved = libOf([{ folder: "T", files: reorder(files) }]);
    const remembered = onAir(D, ch, moved, at(11, 9, 30), epoch);
    const walked = onAir(freshDial(), ch, moved, at(11, 9, 30), epoch);
    assert.deepEqual([remembered.key, remembered.offset], [walked.key, walked.offset], "durations " + durations.join(","));
  };
  check([1235, 1038, 1497, 1166, 1028], 0);
  let seed = 7;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
  for (let n = 1; n < 200; n++) check([1, 2, 3, 4, 5].map(() => 900 + Math.floor(rnd() * 900)), n);
});

// A block, worked out the slow way: the whole stream of segments built one
// after another from the epoch (each folder's k-th turn is file k mod n of
// its pass, shuffled per pass when the channel shuffles; acts of about
// everyMinutes, each followed by `spots` spots from a pool that never
// starts over), then every window played segment by segment. A window
// opens at the top of the program the last one cut off, or of the next one
// when the last closed on a top or in the break after a program's last act,
// and moves on when it could not finish the program it opened on. Returns
// what is on the air at `t`, as { file, kind, from, offset }.
function slowBlock(ch, lists, spots, windows, t) {
  const shuffle = ch.order === "shuffle-daily";
  const b = ch.breaks;
  const pool = !b ? [] : shuffle ? D.seededShuffle(spots, ch.number + "#" + b.folder + "#breaks") : spots;
  const stream = []; // { g, kind, file, from, duration }
  let cursor = 0;
  // Each folder's passes in the order they really play, built one after
  // another: a pass that would open on the episode the pass before it
  // closed on swaps its first two.
  const passes = lists.map(() => []);
  const passOf = (li, p) => {
    const l = lists[li];
    while (passes[li].length <= p) {
      const q = passes[li].length;
      const o = shuffle ? D.seededShuffle(l.files, ch.number + "#" + l.folder + "#pass" + q) : l.files.slice();
      const prev = passes[li][q - 1];
      if (shuffle && prev && o.length > 1 && o[0] === prev[prev.length - 1]) [o[0], o[1]] = [o[1], o[0]];
      passes[li].push(o);
    }
    return passes[li][p];
  };
  const grow = (upTo) => {
    for (let g = stream.length ? stream[stream.length - 1].g + 1 : 0; g <= upTo; g++) {
      const l = lists[g % lists.length];
      const k = Math.floor(g / lists.length);
      const n = l.files.length;
      const f = passOf(g % lists.length, Math.floor(k / n))[k % n];
      const acts = b && pool.length && b.everyMinutes > 0 ? Math.max(1, Math.round(f.duration / (b.everyMinutes * 60))) : 1;
      for (let a = 0; a < acts; a++) {
        const from = (f.duration * a) / acts;
        const to = a === acts - 1 ? f.duration : (f.duration * (a + 1)) / acts;
        stream.push({ g, kind: "program", file: f.file, from, duration: to - from });
        if (b && pool.length) for (let s = 0; s < b.spots; s++) { const sp = pool[cursor++ % pool.length]; stream.push({ g, kind: "spot", file: sp.file, from: 0, duration: sp.duration }); }
      }
    }
  };
  const firstOf = (g) => { grow(g + 1); return stream.findIndex((s) => s.g === g); };
  let open = 0;
  for (const [s, e] of windows) {
    if (t < s) return null;
    let j = firstOf(open);
    let clock = s;
    for (;;) {
      grow(stream[j].g + 1);
      const seg = stream[j];
      const end = clock + seg.duration * 1000;
      if (t < e && t < end) return { file: seg.file, kind: seg.kind, from: seg.from, offset: (t - clock) / 1000 };
      if (end > e) {
        // Cut off inside this segment.
        const rest = stream.slice(j + 1).filter((x) => x.g === seg.g);
        const cut = seg.kind === "program" || rest.some((x) => x.kind === "program");
        open = cut && seg.g !== open ? seg.g : seg.g + 1;
        break;
      }
      clock = end;
      j += 1;
      if (clock === e) {
        // Closed exactly between two segments.
        grow(stream[j].g + 1);
        const next = stream[j];
        const cut = next.g === seg.g && stream.slice(j).some((x) => x.g === seg.g && x.kind === "program");
        open = next.g !== seg.g ? next.g : cut && seg.g !== open ? seg.g : seg.g + 1;
        break;
      }
    }
  }
  return null;
}

test("a block keeps the slow model's place, cut programs, breaks, and shuffles included", () => {
  const T = [1, 2, 3, 4, 5].map((n) => cartoon("T", n, 1200 + n * 53));
  const N = [1, 2, 3].map((n) => cartoon("N", n, 1250 + n * 41));
  const spots = [spot("s1.mp4", 30), spot("s2.mp4", 15), spot("s3.mp4", 20), spot("s4.mp4", 25)];
  const cases = [
    [130, "shuffle-daily", [{ folder: "T", files: T }], null],
    [131, "shuffle-daily", [{ folder: "T", files: T }, { folder: "N", files: N }], null],
    [132, "sequence", [{ folder: "T", files: T }, { folder: "N", files: N }], { folder: "spots", everyMinutes: 8, spots: 3 }],
    [133, "shuffle-daily", [{ folder: "T", files: T }, { folder: "N", files: N }], { folder: "spots", everyMinutes: 0, spots: 2 }],
  ];
  for (const [number, order, lists, breaks] of cases) {
    const ch = block({ number, order, folders: lists.map((l) => l.folder), breaks });
    const lib = libOf(lists, breaks ? spots : []);
    const windows = Array.from({ length: 21 }, (_, w) => [at(w, 9), at(w, 11)]);
    for (let w = 0; w < 20; w++) {
      for (const t of [at(w, 9), at(w, 9, 0, 1), at(w, 9, 47, 13), at(w, 10, 59, 59)]) {
        const want = slowBlock(ch, lists, breaks ? spots : [], windows, t);
        const got = onAir(D, ch, lib, t);
        const what = "channel " + number + ", week " + w + ", " + new Date(t).toTimeString().slice(0, 8);
        assert.deepEqual([got.file, got.kind, got.from], [want.file, want.kind, want.from], what);
        assert.ok(Math.abs(got.offset - want.offset) < 1e-6, "offset, " + what);
      }
      const open = onAir(D, ch, lib, at(w, 9));
      assert.deepEqual([open.kind, open.from, open.offset], ["program", 0, 0], "week " + w + " opens at the top of a program");
    }
  }
});

test("a shuffled block plays every episode once a pass, in a new order each pass", () => {
  const T = [1, 2, 3, 4, 5].map((n) => cartoon("T", n, 1200 + n * 53));
  const ch = block({ number: 134, order: "shuffle-daily", folders: ["T"] });
  const lib = libOf([{ folder: "T", files: T }]);
  const seen = [];
  for (let w = 0; w < 6; w++) {
    for (let t = at(w, 9); t < at(w, 11); t += 60000) {
      const s = onAir(D, ch, lib, t);
      if (!seen.length || seen[seen.length - 1].key !== s.key) seen.push(s);
    }
  }
  // Drop the re-aired openings: a program cut off at a close comes back at the top of the next window.
  const order = seen.filter((s, i) => i === 0 || s.key !== seen[i - 1].key).map((s) => Number(s.key.split(":")[0]));
  const distinct = [...new Set(order)];
  const passes = [];
  for (let p = 0; (p + 1) * 5 <= distinct.length; p++) {
    passes.push(distinct.slice(p * 5, p * 5 + 5).map((g) => seen.find((s) => Number(s.key.split(":")[0]) === g).file));
  }
  assert.ok(passes.length >= 2, "enough passes to compare");
  for (const p of passes) assert.deepEqual(p.slice().sort(), T.map((f) => f.file).sort(), "every episode once a pass");
  assert.ok(passes.some((p) => p.join() !== passes[0].join()), "a new order each pass");
});

test("a shuffled block holds its place from a fresh start, and the guide names what the player plays", () => {
  const T = [1, 2, 3, 4].map((n) => cartoon("T", n, 1290 + n * 17));
  const N = [1, 2].map((n) => cartoon("N", n, 1310 + n * 23));
  const spots = [spot("s1.mp4", 30), spot("s2.mp4", 15), spot("s3.mp4", 20)];
  const lib = libOf([{ folder: "T", files: T }, { folder: "N", files: N }], spots);
  const ch = block({ number: 140, order: "shuffle-daily", breaks: { folder: "spots", everyMinutes: 8, spots: 2 } });
  for (let w = 0; w < 12; w++) {
    for (const t of [at(w, 9), at(w, 9, 31, 7), at(w, 10, 58)]) {
      const a = D.channelAir(ch, lib, new Date(t), SAT);
      const f = freshDial().channelAir(ch, lib, new Date(t), SAT);
      assert.equal(a.tl[a.pos.index].key, f.tl[f.pos.index].key, "a fresh walk lands in the same place, week " + w);
      assert.equal(a.pos.offset, f.pos.offset);
      let i = a.pos.index;
      while (a.tl[i].kind === "spot") i--;
      assert.equal(D.programAt(ch, lib, new Date(t), SAT).title, D.segmentName(ch, a.tl[i]), "the guide and the picture agree, week " + w);
    }
  }
});

test("a shuffled overnight block does not jump at midnight", () => {
  const T = [1, 2, 3, 4, 5, 6].map((n) => cartoon("T", n, 1320));
  const ch = block({ number: 150, folders: ["T"], order: "shuffle-daily", schedule: [{ days: ["sat"], start: "22:00", end: "02:00" }] });
  const lib = libOf([{ folder: "T", files: T }]);
  for (let w = 0; w < 30; w++) {
    const a = D.channelAir(ch, lib, new Date(2026, 8, 5 + 7 * w, 23, 59, 59), SAT);
    const b = D.channelAir(ch, lib, new Date(2026, 8, 6 + 7 * w, 0, 0, 1), SAT);
    assert.equal(b.tl[b.pos.index].key, a.tl[a.pos.index].key, "week " + w);
    assert.ok(Math.abs(b.pos.offset - a.pos.offset - 2) < 1e-6, "two seconds on, week " + w);
  }
});

test("folder names come from the server's listing, so a config that drifted cannot split the guide from the player", () => {
  const T = [1, 2, 3, 4, 5].map((n) => cartoon("T", n, 600));
  const N = [1, 2, 3, 4, 5].map((n) => cartoon("N", n, 600));
  const lib = libOf([{ folder: "T", files: T }, { folder: "N", files: N }]);
  const now = new Date(2026, 8, 5, 9, 40);
  for (const extra of [{ mode: "continuous", clock: undefined }, {}]) {
    const ch = block(Object.assign({ number: 160, order: "shuffle-daily" }, extra));
    const drifted = Object.assign({}, ch, { folders: ["Old T", "Old N"] });
    const a = D.channelAir(ch, lib, now, SAT);
    const b = freshDial().channelAir(drifted, lib, now, SAT);
    assert.deepEqual(b.tl.map((s) => s.file), a.tl.map((s) => s.file), "the listing's names seed the shuffle");
    assert.equal(D.programAt(drifted, lib, now, SAT).title, D.programAt(ch, lib, now, SAT).title);
  }
  // The station clock seeds a folder by the day and the listing's name.
  const station = block({ number: 162, order: "shuffle-daily", mode: "continuous", clock: undefined, folders: ["Old T", "Old N"] });
  const want = D.seededShuffle(T, "2026-9-5#162#T").map((f) => f.file);
  // An epoch g programs before 9:00 puts program g on the air.
  const fromEpoch = (g) => D.channelAir(station, lib, new Date(2026, 8, 5, 9), new Date(2026, 8, 5, 9).getTime() - g * 600000 - 1000);
  for (let g = 0; g < 10; g += 2) {
    const air = fromEpoch(g);
    assert.equal(air.tl[air.pos.index].file, want[(g / 2) % 5], "turn " + g / 2 + " of T");
  }
});

// The block clock in the station's time zone on the nights the clocks
// change. TZ is set for the test and put back after.
function inZone(zone, fn) {
  const was = process.env.TZ;
  process.env.TZ = zone;
  try {
    fn();
  } finally {
    if (was === undefined) delete process.env.TZ;
    else process.env.TZ = was;
  }
}

test("when the clocks go back, a window in the repeated hour airs twice and the block clock runs in both", () => {
  inZone("America/New_York", () => {
    // Sunday November 1, 2026: 01:00 to 02:00 happens twice, EDT then EST.
    const T = [1, 2, 3].map((n) => cartoon("T", n, 1000));
    const ch = block({ number: 170, folders: ["T"], schedule: [{ days: ["sun"], start: "01:00", end: "01:30" }] });
    const lib = libOf([{ folder: "T", files: T }]);
    const epoch = new Date(2026, 9, 31, 0, 0, 0).getTime(); // the Saturday before
    const iso = (s) => Date.parse(s);
    const spans = D.airSpans(ch, epoch, iso("2026-11-01T12:00:00Z"));
    assert.deepEqual(spans, [
      { s: iso("2026-11-01T05:00:00Z"), e: iso("2026-11-01T05:30:00Z") },
      { s: iso("2026-11-01T06:00:00Z"), e: iso("2026-11-01T06:30:00Z") },
    ]);
    const first = iso("2026-11-01T05:15:00Z"); // 01:15 EDT
    const second = iso("2026-11-01T06:15:00Z"); // 01:15 EST
    assert.deepEqual(D.airState(ch, new Date(first)), { onAir: true, untilMs: iso("2026-11-01T05:30:00Z"), resumeText: "" });
    assert.deepEqual(D.airState(ch, new Date(second)), { onAir: true, untilMs: iso("2026-11-01T06:30:00Z"), resumeText: "" }, "the until is ahead, not an hour ago");
    const between = D.airState(ch, new Date(iso("2026-11-01T05:45:00Z")));
    assert.equal(between.onAir, false);
    assert.equal(between.untilMs, iso("2026-11-01T06:00:00Z"), "off air until the hour comes round again");
    // Every minute of the night, airState and the spans agree.
    for (let t = iso("2026-11-01T03:00:00Z"); t < iso("2026-11-01T09:00:00Z"); t += 60000) {
      assert.equal(D.airState(ch, new Date(t)).onAir, spans.some((sp) => sp.s <= t && t < sp.e), new Date(t).toISOString());
    }
    // The first pass plays T 1 and cuts T 2 off 800 s in; the second opens on T 2 again.
    assert.deepEqual(playing(ch, lib, first, epoch), ["T 1.mp4", 900]);
    assert.deepEqual(playing(ch, lib, second, epoch), ["T 2.mp4", 900]);
    assert.equal(D.programAt(ch, lib, new Date(second), epoch).title, "T 2", "the guide lists it, not TO BE ANNOUNCED");
  });
});

test("when the clocks go forward, a window counts only the time that aired", () => {
  inZone("America/New_York", () => {
    // Sunday March 8, 2026: 02:00 EST is 03:00 EDT, so 01:30 to 02:30 airs 30 minutes.
    const T = [1, 2, 3].map((n) => cartoon("T", n, 1000));
    const ch = block({ number: 180, folders: ["T"], schedule: [{ days: ["sun"], start: "01:30", end: "02:30" }] });
    const lib = libOf([{ folder: "T", files: T }]);
    const epoch = new Date(2026, 2, 7, 0, 0, 0).getTime();
    const iso = (s) => Date.parse(s);
    const spans = D.airSpans(ch, epoch, iso("2026-03-08T12:00:00Z"));
    assert.deepEqual(spans, [{ s: iso("2026-03-08T06:30:00Z"), e: iso("2026-03-08T07:00:00Z") }]);
    for (let t = iso("2026-03-08T04:00:00Z"); t < iso("2026-03-08T10:00:00Z"); t += 60000) {
      assert.equal(D.airState(ch, new Date(t)).onAir, spans.some((sp) => sp.s <= t && t < sp.e), new Date(t).toISOString());
    }
    // 1800 s aired (T 1, then T 2 cut off 800 s in), so next week opens on T 2.
    // Counting an hour would have cut T 1 off on its second time round instead.
    assert.deepEqual(playing(ch, lib, new Date(2026, 2, 15, 1, 30).getTime(), epoch), ["T 2.mp4", 0]);
    // A window that starts in the skipped hour comes on air when the clock jumps past its start.
    const late = { mode: "schedule", schedule: [{ days: ["sun"], start: "02:30", end: "03:30" }] };
    assert.deepEqual(D.airSpans(late, epoch, iso("2026-03-08T12:00:00Z")), [{ s: iso("2026-03-08T07:00:00Z"), e: iso("2026-03-08T07:30:00Z") }]);
    const before = D.airState(late, new Date(iso("2026-03-08T06:50:00Z")));
    assert.equal(before.onAir, false);
    assert.equal(before.untilMs, iso("2026-03-08T07:00:00Z"));
    assert.equal(D.airState(late, new Date(iso("2026-03-08T07:10:00Z"))).onAir, true);
  });
});

test("a shuffled block never plays an episode twice running, and plays each once a pass", () => {
  const allWeek = [{ days: ["sun", "mon", "tue", "wed", "thu", "fri", "sat"], start: "00:00", end: "00:00" }];
  [[2], [3], [5], [5, 3], [7, 2, 4]].forEach((sizes, c) => {
    const lists = sizes.map((n, i) => ({ folder: "F" + i, files: Array.from({ length: n }, (_, j) => cartoon("F" + i, j + 1, 60)) }));
    const ch = block({ number: 300 + c, order: "shuffle-daily", folders: lists.map((l) => l.folder), schedule: allWeek });
    const lib = libOf(lists);
    const turns = lists.map(() => []);
    const programs = 60 * sizes.length * Math.max(...sizes);
    for (let g = 0; g < programs; g++) turns[g % sizes.length].push(onAir(D, ch, lib, SAT + g * 60000 + 1000).file);
    turns.forEach((seen, i) => {
      const n = sizes[i];
      for (let k = 1; k < seen.length; k++) assert.notEqual(seen[k], seen[k - 1], "sizes " + sizes + ", folder " + i + ", turn " + k + ": twice running");
      for (let p = 0; (p + 1) * n <= seen.length; p++) {
        assert.deepEqual(seen.slice(p * n, p * n + n).sort(), lists[i].files.map((f) => f.file).sort(), "sizes " + sizes + ", folder " + i + ", pass " + p);
      }
      if (n > 2) assert.ok(seen.slice(n, 2 * n).join() !== seen.slice(0, n).join() || seen.slice(2 * n, 3 * n).join() !== seen.slice(0, n).join(), "passes come in new orders");
    });
  });
});

test("airState flips only when the channel really leaves the air", () => {
  const until = (schedule, d) => D.airState({ mode: "schedule", schedule }, d).untilMs;
  const sat = (h, m) => new Date(2026, 7, 29, h, m || 0).getTime();
  assert.equal(until([{ days: ["sat"], start: "08:00", end: "18:00" }, { days: ["sat"], start: "09:00", end: "10:00" }], new Date(sat(9, 30))), sat(18), "overlapping windows: the later end");
  assert.equal(until([{ days: ["sat"], start: "09:00", end: "10:00" }, { days: ["sat"], start: "10:00", end: "11:00" }], new Date(sat(9, 30))), sat(11), "back to back: one stretch");
  assert.equal(until([{ days: ["sat"], start: "20:00", end: "01:00" }], new Date(sat(23, 30))), new Date(2026, 7, 30, 1).getTime(), "overnight: the morning end, not midnight");
  const always = D.airState({ mode: "schedule", schedule: [{ days: ["sun", "mon", "tue", "wed", "thu", "fri", "sat"], start: "00:00", end: "12:00" }, { days: ["sun", "mon", "tue", "wed", "thu", "fri", "sat"], start: "12:00", end: "00:00" }] }, new Date(sat(9)));
  assert.deepEqual([always.onAir, always.untilMs], [true, null], "windows that never stop never flip");
  inZone("America/New_York", () => {
    // Sunday November 1, 2026: 01:00 to 02:00 EDT, then 01:00 to 02:00 EST, one stretch of two hours.
    const ch = { mode: "schedule", schedule: [{ days: ["sun"], start: "01:00", end: "02:00" }] };
    assert.equal(D.airState(ch, new Date(Date.parse("2026-11-01T05:30:00Z"))).untilMs, Date.parse("2026-11-01T07:00:00Z"));
    // Sunday March 8, 2026: a window from 02:30 comes on at 03:00 EDT, and says so.
    const late = { mode: "schedule", schedule: [{ days: ["sun"], start: "02:30", end: "04:00" }] };
    assert.equal(D.airState(late, new Date(Date.parse("2026-03-08T06:50:00Z"))).resumeText, "PROGRAMMING RESUMES TODAY 3:00 AM");
  });
});

test("schema: a hand-edited folder is compared with the first folder that plays", () => {
  const r = S.validateConfig({ channels: [{ number: 2, type: "video", folder: "A", folders: ["../x", "A", "B"] }] });
  assert.deepEqual(r.cfg.channels[0].folders, ["A", "B"]);
  assert.ok(r.errors.some((e) => e.includes("BAD FOLDER")));
  assert.equal(r.errors.some((e) => e.includes("IS NOT THE FIRST OF FOLDERS")), false, "A is what plays first");
});

test("the block clock answers questions in any order as a walk from the epoch would, and fast", (t) => {
  const eps = Array.from({ length: 500 }, (_, i) => cartoon("Big", i + 1, 1300 + ((i * 37) % 120)));
  const spots = Array.from({ length: 40 }, (_, i) => spot("ad" + i + ".mp4", 15 + (i % 4) * 15));
  const ch = block({ number: 400, folders: ["Big"], order: "shuffle-daily", breaks: { folder: "spots", everyMinutes: 8, spots: 3 },
    schedule: [{ days: ["sun", "mon", "tue", "wed", "thu", "fri", "sat"], start: "06:00", end: "05:59" }] });
  const lib = libOf([{ folder: "Big", files: eps }], spots);
  const when = new Date(2046, 10, 24, 9, 10).getTime();
  const ms = (fn) => { const t0 = process.hrtime.bigint(); fn(); return Number(process.hrtime.bigint() - t0) / 1e6; };
  const dial = freshDial();
  const cold = ms(() => dial.channelAir(ch, lib, new Date(when), D.EPOCH));
  const warm = ms(() => { for (let i = 1; i <= 20; i++) dial.channelAir(ch, lib, new Date(when + i * 1000), D.EPOCH); }) / 20;
  const back = ms(() => {
    for (let i = 0; i < 10; i++) {
      dial.channelAir(ch, lib, new Date(when + 3 * 86400000), D.EPOCH); // the guide looking ahead
      dial.channelAir(ch, lib, new Date(when + i * 1000), D.EPOCH); // the player asking about now
    }
  }) / 20;
  t.diagnostic("500-episode shuffled all-day block, 2046: cold " + cold.toFixed(1) + " ms, warm " + warm.toFixed(2) + " ms, backward after forward " + back.toFixed(2) + " ms");
  assert.ok(cold < 3000, "cold " + cold);
  assert.ok(warm < 25, "warm " + warm);
  assert.ok(back < 50, "backward after forward " + back);
  // Every answer, asked in a jumbled order of one remembered walk, is the answer of a walk from the epoch.
  const small = block({ number: 401, order: "shuffle-daily", breaks: { folder: "spots", everyMinutes: 8, spots: 3 },
    schedule: [{ days: ["sat"], start: "08:00", end: "11:30" }, { days: ["sun"], start: "20:00", end: "01:00" }] });
  const lists = [{ folder: "T", files: [1, 2, 3, 4, 5, 6, 7].map((n) => cartoon("T", n, 1290 + n * 13)) }, { folder: "N", files: [1, 2, 3].map((n) => cartoon("N", n, 1310 + n * 7)) }];
  const smallLib = libOf(lists, spots);
  let seed = 11;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
  const remembered = freshDial();
  for (let q = 0; q < 60; q++) {
    const sat = new Date(2026, 8, 5 + 7 * Math.floor(rnd() * 400), 8, 0).getTime();
    const tq = sat + Math.floor(rnd() * 2 * 86400) * 1000;
    const a = onAir(remembered, small, smallLib, tq);
    const b = onAir(freshDial(), small, smallLib, tq);
    assert.deepEqual(a && [a.key, a.offset], b && [b.key, b.offset], new Date(tq).toString());
  }
});

// ---------------------------------------------------------- the schema for both

test("schema: a video channel takes several folders, and one folder saves as just `folder`", () => {
  const r = S.validateConfig({
    channels: [
      { number: 2, type: "video", folder: "One" },
      { number: 3, type: "video", folders: ["Transformers", "Ninja Turtles"] },
      { number: 4, type: "video", folders: ["A", "A", "B"] },
      { number: 5, type: "video", folders: ["A", "../etc", "B"] },
      { number: 6, type: "video", folders: ["../etc", ""] },
      { number: 7, type: "video", folders: ["a1", "a2", "a3", "a4", "a5", "a6", "a7", "a8", "a9"] },
      { number: 8, type: "video", folders: [], folder: "Fallback" },
    ],
  });
  const by = Object.fromEntries(r.cfg.channels.map((c) => [c.number, c]));
  assert.equal(by[2].folder, "One", "the one-folder form still loads");
  assert.equal("folders" in by[2], false, "and saves exactly as before several folders existed");
  assert.deepEqual([by[3].folder, by[3].folders], ["Transformers", ["Transformers", "Ninja Turtles"]], "several keep `folder` as the first");
  assert.deepEqual(by[4].folders, ["A", "B"]);
  assert.ok(r.errors.some((e) => e.includes("CHANNEL 4") && e.includes("LISTED TWICE")));
  assert.deepEqual(by[5].folders, ["A", "B"]);
  assert.ok(r.errors.some((e) => e.includes("CHANNEL 5") && e.includes("BAD FOLDER")));
  assert.equal(by[6], undefined, "nothing usable left: skipped");
  assert.ok(r.errors.some((e) => e.includes("CHANNEL 6") && e.includes("SKIPPED")));
  assert.equal(by[7].folders.length, S.MAX_FOLDERS);
  assert.ok(r.errors.some((e) => e.includes("CHANNEL 7") && e.includes("MORE THAN")));
  assert.equal(by[8].folder, "Fallback", "an empty list falls back to the one folder");
  assert.equal("folders" in by[8], false);
  assert.equal(r.errors.some((e) => e.includes("IS NOT THE FIRST OF FOLDERS")), false, "no mismatch said where there is none");
});

test("schema: a list of one folder saves as `folder`, and a hand edit to `folder` that `folders` overrides is named", () => {
  const r = S.validateConfig({
    channels: [
      { number: 2, type: "video", folder: "One", folders: ["One"] },
      { number: 3, type: "video", folder: "Edited", folders: ["Saved"] },
      { number: 4, type: "video", folder: "Ninja Turtles", folders: ["Transformers", "Ninja Turtles"] },
      { number: 5, type: "video", folder: "Transformers", folders: ["Transformers", "Ninja Turtles"] },
    ],
  });
  const by = Object.fromEntries(r.cfg.channels.map((c) => [c.number, c]));
  assert.deepEqual([by[2].folder, "folders" in by[2]], ["One", false], "a one-folder list saves as the one folder");
  assert.deepEqual([by[3].folder, "folders" in by[3]], ["Saved", false], "the list still plays");
  const w3 = r.errors.find((e) => e.includes("CHANNEL 3"));
  assert.ok(w3 && w3.includes('"Edited"') && w3.includes('"Saved"') && w3.includes("IS NOT THE FIRST OF FOLDERS"), w3);
  assert.deepEqual([by[4].folder, by[4].folders], ["Transformers", ["Transformers", "Ninja Turtles"]]);
  const w4 = r.errors.find((e) => e.includes("CHANNEL 4"));
  assert.ok(w4 && w4.includes('"Ninja Turtles"') && w4.includes('"Transformers"'), w4);
  assert.equal(r.errors.some((e) => e.includes("CHANNEL 2") || e.includes("CHANNEL 5")), false, "agreeing forms say nothing");
  // Saved and loaded again, the file says the same thing and no more.
  const again = S.validateConfig(r.cfg);
  assert.deepEqual(again.cfg.channels, r.cfg.channels);
  assert.equal(again.errors.length, 0, again.errors.join("; "));
});

test("schema: the breaks folder cannot be any of the program folders", () => {
  const r = S.validateConfig({
    channels: [
      { number: 3, type: "video", folders: ["T", "N"], breaks: { folder: "N", everyMinutes: 8, spots: 3 } },
      { number: 4, type: "video", folders: ["T", "N"], breaks: { folder: "80s", everyMinutes: 8, spots: 3 } },
    ],
  });
  const by = Object.fromEntries(r.cfg.channels.map((c) => [c.number, c]));
  assert.equal(by[3].breaks, undefined);
  assert.ok(r.errors.some((e) => e.includes("CHANNEL 3") && e.includes("ONE OF THE PROGRAM FOLDERS")));
  assert.deepEqual(by[4].breaks, { folder: "80s", everyMinutes: 8, spots: 3 });
});

test("schema: clock is the station's unless a channel asks for a block, and only a block is written", () => {
  const r = S.validateConfig({
    channels: [
      { number: 3, type: "video", folder: "a", mode: "schedule", clock: "block", schedule: [{ days: ["sat"], start: "09:00", end: "11:00" }] },
      { number: 4, type: "video", folder: "a", clock: "station" },
      { number: 5, type: "video", folder: "a" },
      { number: 6, type: "video", folder: "a", clock: "sundial" },
      { number: 7, type: "video", folder: "a", mode: "continuous", clock: "block" },
      { number: 8, type: "video", folder: "a", clock: "block" },
    ],
  });
  const by = Object.fromEntries(r.cfg.channels.map((c) => [c.number, c]));
  assert.equal(by[3].clock, "block");
  assert.equal("clock" in by[4], false, "the default is not written");
  assert.equal("clock" in by[5], false);
  assert.equal("clock" in by[6], false);
  assert.equal("clock" in by[7], false, "a channel switched back to always on the air drops its block clock");
  assert.equal("clock" in by[8], false, "and so does one that never had a schedule");
  for (const n of [7, 8]) {
    assert.ok(r.errors.some((e) => e.includes("CHANNEL " + n + ":") && e.includes("NEEDS SCHEDULED HOURS")), "a dropped block clock is named, channel " + n);
  }
  assert.equal(r.errors.some((e) => e.includes("CHANNEL 3:") || e.includes("CHANNEL 4:") || e.includes("CHANNEL 5:")), false, "and nothing is said where nothing was dropped");
  assert.ok(r.errors.some((e) => e.includes("CHANNEL 6") && e.includes("UNKNOWN CLOCK")));
  assert.deepEqual(S.CLOCK_MODES, ["station", "block"]);
});
