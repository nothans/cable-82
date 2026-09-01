#!/usr/bin/env node
/* Fetch the demo channel: RETRO TV.

   Eight films from the Internet Archive's Prelinger collection, every one
   explicitly marked public domain in the Archive's own metadata
   (licenseurl: creativecommons.org/licenses/publicdomain). 1950s civil-defense
   drills, GM's dancing-housewife Motorama musical, a bicycle-safety fever
   dream with monkey masks - the channel-flipping filler a UHF dial was made
   of, at 320x240, which is exactly what a CRT over RF wants.

   Usage:  node channels/fetch-demo-channel.js
   Result: channels/retro-tv/ with numbered files in airing order (~390 MB).
   Then add a video channel in the control room pointing at "retro-tv".

   Dependency-free, Node 18+. Re-running skips files already downloaded. */

"use strict";

const fs = require("fs");
const path = require("path");
const { Readable } = require("stream");
const { pipeline } = require("stream/promises");

// item = archive.org identifier; file = the 320x240 derivative in that item.
// Verify any addition at https://archive.org/metadata/<item> (look for
// licenseurl) - only explicitly public-domain items belong in this list.
const LINEUP = [
  { n: "01", title: "Duck and Cover (1951)", item: "DuckandC1951", file: "DuckandC1951_512kb.mp4", mb: 39 },
  { n: "02", title: "Design for Dreaming (1956)", item: "Designfo1956", file: "Designfo1956_512kb.mp4", mb: 40 },
  { n: "03", title: "A Date With Your Family (1950)", item: "DateWith1950", file: "DateWith1950_512kb.mp4", mb: 43 },
  { n: "04", title: "One Got Fat (1963)", item: "OneGotFa1963", file: "OneGotFa1963_512kb.mp4", mb: 63 },
  { n: "05", title: "American Look (1958)", item: "American1958", file: "American1958_512kb.mp4", mb: 35 },
  { n: "06", title: "A Young Mans Fancy (1952)", item: "YoungMan1952", file: "YoungMan1952_512kb.mp4", mb: 62 },
  { n: "07", title: "Habit Patterns (1954)", item: "HabitPat1954", file: "HabitPat1954_512kb.mp4", mb: 61 },
  { n: "08", title: "Cheating (1952)", item: "Cheating1952", file: "Cheating1952_512kb.mp4", mb: 49 },
];

const DEST = path.join(__dirname, "retro-tv");

async function fetchFilm(entry) {
  const out = path.join(DEST, entry.n + " " + entry.title + ".mp4");
  if (fs.existsSync(out) && fs.statSync(out).size > 1024 * 1024) {
    console.log("  have  " + path.basename(out));
    return;
  }
  const url = "https://archive.org/download/" + entry.item + "/" + entry.file;
  console.log("  get   " + path.basename(out) + "  (~" + entry.mb + " MB)");
  const res = await fetch(url, { redirect: "follow" });
  if (!res.ok || !res.body) throw new Error("HTTP " + res.status + " for " + url);
  const tmp = out + ".part";
  await pipeline(Readable.fromWeb(res.body), fs.createWriteStream(tmp));
  const size = fs.statSync(tmp).size;
  if (size < 1024 * 1024) {
    fs.unlinkSync(tmp);
    throw new Error("suspiciously small download (" + size + " bytes) for " + url);
  }
  fs.renameSync(tmp, out);
}

(async () => {
  fs.mkdirSync(DEST, { recursive: true });
  console.log("RETRO TV: fetching " + LINEUP.length + " public-domain films into " + DEST);
  let failed = 0;
  for (const entry of LINEUP) {
    try {
      await fetchFilm(entry);
    } catch (e) {
      failed++;
      console.error("  FAIL  " + entry.title + ": " + e.message);
    }
  }
  const have = fs.readdirSync(DEST).filter((f) => f.endsWith(".mp4")).length;
  console.log(have + " films on the shelf" + (failed ? ", " + failed + " failed (re-run to retry)" : "."));
  if (have) {
    console.log("Now open the control room (/config), add a Video channel, and pick the retro-tv folder.");
    process.exitCode = failed ? 1 : 0;
  } else {
    process.exitCode = 1;
  }
})();
