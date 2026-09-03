/* CABLE 82 dial math: the broadcast clock and everything derived from it.
   Pure functions, no DOM, no fetch. The load-bearing idea of the whole
   network lives here: position on a channel is a function of the wall
   clock, never a play cursor, which is what lets a stopped channel resume at
   exactly the moment it would have reached, two sets agree to the frame, and
   the guide never disagree with the picture.
   UMD, so test/harness.html and a node test can both exercise it; the
   display loads it as window.Cable82Dial. */
(function (root, factory) {
  const isNode = typeof module !== "undefined" && module.exports;
  const schema = isNode ? require("./config-schema.js") : root.Cable82Schema;
  const api = factory(schema);
  if (isNode) module.exports = api;
  else root.Cable82Dial = api;
})(typeof self !== "undefined" ? self : this, function (S) {
  "use strict";

  // ---------------------------------------------------------- the clock face

  const DAYS3 = ["SUN", "MON", "TUE", "WED", "THU", "FRI", "SAT"];
  const DAYS = ["SUNDAY", "MONDAY", "TUESDAY", "WEDNESDAY", "THURSDAY", "FRIDAY", "SATURDAY"];
  const MONTHS3 = ["JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEP", "OCT", "NOV", "DEC"];
  const MONTHS = ["JANUARY", "FEBRUARY", "MARCH", "APRIL", "MAY", "JUNE", "JULY", "AUGUST", "SEPTEMBER", "OCTOBER", "NOVEMBER", "DECEMBER"];

  // The broadcast clock's origin: an arbitrary fixed point every channel's
  // playlist position is measured from, so two sets agree to the frame.
  const EPOCH = Date.UTC(2026, 0, 1);

  function formatClock(d, mode, opts) {
    const mm = String(d.getMinutes()).padStart(2, "0");
    const ss = opts && opts.seconds ? ":" + String(d.getSeconds()).padStart(2, "0") : "";
    if (mode === "24h") return String(d.getHours()).padStart(2, "0") + ":" + mm + ss;
    const h = d.getHours() % 12 || 12;
    return h + ":" + mm + ss + " " + (d.getHours() < 12 ? "AM" : "PM");
  }

  function formatHeaderDate(d) {
    return DAYS3[d.getDay()] + " " + MONTHS3[d.getMonth()] + " " + d.getDate();
  }

  function formatLongDate(d) {
    return DAYS[d.getDay()] + ", " + MONTHS[d.getMonth()] + " " + d.getDate() + ", " + d.getFullYear();
  }

  // ---------------------------------------------------------- the running order

  // (playlist, nowMs, epochMs) -> { index, offset } | null.
  // playlist: [{ duration }] with every duration known and positive.
  function positionAt(playlist, nowMs, epochMs) {
    if (!Array.isArray(playlist) || !playlist.length) return null;
    let total = 0;
    for (const item of playlist) {
      if (!item || !Number.isFinite(item.duration) || item.duration <= 0) return null;
      total += item.duration;
    }
    let t = ((((nowMs - epochMs) / 1000) % total) + total) % total;
    for (let i = 0; i < playlist.length; i++) {
      if (t < playlist[i].duration) return { index: i, offset: t };
      t -= playlist[i].duration;
    }
    return { index: 0, offset: 0 };
  }

  // Deterministic shuffle, seeded. shuffle-daily seeds with the date + the
  // channel number, so the running order is stable all day (tune away and
  // back and nothing reshuffles) and different tomorrow.
  function seededShuffle(arr, seedStr) {
    let h = 2166136261;
    const s = String(seedStr);
    for (let i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i);
      h = Math.imul(h, 16777619);
    }
    const rand = () => {
      h ^= h << 13; h ^= h >>> 17; h ^= h << 5;
      return ((h >>> 0) % 1e6) / 1e6;
    };
    const a = arr.slice();
    for (let i = a.length - 1; i > 0; i--) {
      const j = Math.floor(rand() * (i + 1));
      const t = a[i]; a[i] = a[j]; a[j] = t;
    }
    return a;
  }

  // A folder's running order for the day: the server's natural sort, or a
  // shuffle seeded by the date so it holds all day and reshuffles tomorrow.
  function orderFiles(files, order, seed) {
    return order === "shuffle-daily" ? seededShuffle(files, seed) : files;
  }

  // A video channel's air as segments [{ file, url, from, to, duration }],
  // each a slice of one file, walked by positionAt like any playlist.
  // Without breaks it is one segment per file, played whole (`to` null
  // while a duration is unknown: play to the end). With breaks, each
  // program is cut into acts of about everyMinutes (a 63-minute film at 15
  // becomes four acts of 15:45), a break of `spots` spots follows every act
  // - the last one included, so a break separates programs - and the spot
  // pool cycles across the whole loop so each spot airs as often as the
  // next. The movie resumes exactly where the break cut it.
  // Acts need every program duration up front; a spot whose length is not
  // known yet sits out until the probe learns it. No usable spots (an empty
  // or unprobed folder) means the program folder plays whole.
  // Every segment carries `kind` ("program" or "spot") and the file's
  // `title` (from its metadata, when the server read one), so the guide can
  // name what is on without guessing from the URL.
  function channelTimeline(channel, files, spots, date) {
    const day = date.getFullYear() + "-" + (date.getMonth() + 1) + "-" + date.getDate();
    const program = orderFiles(files || [], channel.order, day + "#" + channel.number);
    const b = channel.breaks;
    const pool = b
      ? orderFiles((spots || []).filter((f) => f.duration > 0), channel.order, day + "#" + channel.number + "#breaks")
      : [];
    const whole = (f, kind) => ({ kind, file: f.file, title: f.title || null, url: f.url, from: 0, to: f.duration, duration: f.duration });
    if (!b || !pool.length || program.some((f) => !(f.duration > 0))) return program.map((f) => whole(f, "program"));
    const actLen = b.everyMinutes * 60;
    const out = [];
    let cursor = 0;
    for (const p of program) {
      const acts = actLen > 0 ? Math.max(1, Math.round(p.duration / actLen)) : 1;
      for (let a = 0; a < acts; a++) {
        const from = (p.duration * a) / acts;
        const to = a === acts - 1 ? p.duration : (p.duration * (a + 1)) / acts;
        out.push({ kind: "program", file: p.file, title: p.title || null, url: p.url, from, to, duration: to - from });
        for (let k = 0; k < b.spots; k++) out.push(whole(pool[cursor++ % pool.length], "spot"));
      }
    }
    return out;
  }

  // ---------------------------------------------------------- the schedule

  // Is a scheduled channel on the air at `date`, and when does that change?
  // Returns { onAir, untilMs, resumeText }. untilMs is when the state next
  // flips (so the tuner can set one exact timer instead of polling); for a
  // channel with no windows it is null and the state never changes.
  function airState(channel, date) {
    if (!channel || channel.mode !== "schedule") return { onAir: true, untilMs: null, resumeText: "" };
    const windows = Array.isArray(channel.schedule) ? channel.schedule : [];
    if (!windows.length) return { onAir: false, untilMs: null, resumeText: "NO PROGRAMMING SCHEDULED" };
    // The schema expands each window (overnight ones included) into
    // non-wrapping { day, start, end } minute segments, so all the math
    // below can rely on start < end.
    const segs = windows.flatMap((w) => S.windowSegments(w));
    if (!segs.length) return { onAir: false, untilMs: null, resumeText: "NO PROGRAMMING SCHEDULED" };
    const nowMin = date.getHours() * 60 + date.getMinutes() + date.getSeconds() / 60;
    const today = date.getDay();
    // On air now?
    for (const g of segs) {
      if (g.day === today && nowMin >= g.start && nowMin < g.end) {
        const until = new Date(date);
        until.setHours(Math.floor(g.end / 60), g.end % 60, 0, 0);
        return { onAir: true, untilMs: until.getTime(), resumeText: "" };
      }
    }
    // Off air: find the next segment start within the coming week. A cont
    // segment (the morning half of an overnight window) can never win
    // wrongly: being off air before it means its evening half is in the
    // future too, and the evening half sorts earlier.
    let best = null;
    for (let d = 0; d < 8; d++) {
      const day = (today + d) % 7;
      for (const g of segs) {
        if (g.day !== day) continue;
        if (d === 0 && g.start <= nowMin) continue;
        const at = new Date(date);
        at.setDate(at.getDate() + d);
        at.setHours(Math.floor(g.start / 60), g.start % 60, 0, 0);
        if (!best || at.getTime() < best.at) best = { at: at.getTime(), day, startMin: g.start };
      }
      if (best) break;
    }
    if (!best) return { onAir: false, untilMs: null, resumeText: "NO PROGRAMMING SCHEDULED" };
    const startMin = best.startMin;
    const h12 = Math.floor(startMin / 60) % 12 || 12;
    const ampm = startMin < 720 ? "AM" : "PM";
    const mm = String(startMin % 60).padStart(2, "0");
    const dayWord = best.day === date.getDay() && best.at - date.getTime() < 12 * 3600 * 1000 ? "TODAY" : DAYS[best.day];
    return {
      onAir: false,
      untilMs: best.at,
      resumeText: "PROGRAMMING RESUMES " + dayWord + " " + h12 + ":" + mm + " " + ampm,
    };
  }

  // ---------------------------------------------------------- the dial itself

  // Which dial position a tune command lands on. channels is the enabled,
  // number-sorted dial; dir is +1/-1; wrap comes from config.
  function nextChannelIndex(channels, idx, dir, wrap) {
    if (!Array.isArray(channels) || channels.length < 2) return idx;
    const next = idx + dir;
    if (next < 0) return wrap ? channels.length - 1 : 0;
    if (next >= channels.length) return wrap ? 0 : channels.length - 1;
    return next;
  }

  // The sound levels a volume key steps through, in the order the Zenith
  // Space Command stepped its motorized control: loud, off, soft, medium,
  // back to loud. One key, no state on the remote: the set remembers.
  const VOLUME_STEPS = [
    { level: 1, name: "LOUD" },
    { level: 0, name: "SOUND OFF" },
    { level: 0.35, name: "SOFT" },
    { level: 0.7, name: "MEDIUM" },
  ];
  function nextVolumeStep(i) {
    return (Number.isInteger(i) && i >= 0 && i < VOLUME_STEPS.length ? i + 1 : 1) % VOLUME_STEPS.length;
  }

  // ---------------------------------------------------------- the guide

  // A program's on-screen name, from its filename. Strips the extension, a
  // leading track number ("02 "), and an episode tag ("S01.E03."), then puts
  // the separators back to spaces: "02 Design for Dreaming (1956).mp4"
  // becomes "DESIGN FOR DREAMING (1956)".
  function programTitle(file) {
    let t = String(file || "").replace(/\.[a-z0-9]+$/i, "");
    t = t.replace(/^\s*\d{1,3}[\s._-]+/, "");
    t = t.replace(/^s\d{1,2}[\s._-]*e\d{1,3}[\s._-]*/i, "");
    t = t.replace(/[._]+/g, " ").replace(/\s+/g, " ").trim();
    return t.toUpperCase() || "PROGRAM";
  }

  // The half-hour slots a guide page shows: the one we are in now, then the
  // ones after it. A guide always starts its grid on the half hour, which is
  // why a listing that began at 8:12 still reads as the 8:00 column.
  function guideSlots(date, count) {
    const first = new Date(date.getTime());
    first.setMinutes(first.getMinutes() < 30 ? 0 : 30, 0, 0);
    const out = [];
    for (let i = 0; i < (count || 3); i++) out.push(new Date(first.getTime() + i * 30 * 60000));
    return out;
  }

  // What the guide calls one segment of a channel, by the channel's titles
  // setting: the cleaned file name, the title written inside the file (the
  // file name when it has none), or one fixed name for the whole channel.
  function segmentName(channel, seg) {
    if (channel.titles === "fixed") return channel.title || channel.name || programTitle(seg.file);
    if (channel.titles === "metadata" && seg.title) return String(seg.title).toUpperCase();
    return programTitle(seg.file);
  }

  // What one channel is showing at a moment. Video channels answer from the
  // same broadcast clock the player runs on, so the guide can never disagree
  // with the picture; everything else answers for what it is. A commercial
  // break is never the answer: the guide names the program the break sits
  // inside (the act before it), the way a printed grid would.
  function programAt(channel, lib, date, epochMs) {
    if (!channel || channel.enabled === false) return null;
    if (channel.type === "guide") return { title: "PROGRAM GUIDE", kind: "guide" };
    if (channel.type === "bulletin") return { title: "COMMUNITY BULLETIN BOARD", kind: "bulletin" };
    if (channel.type === "external") return { title: "LIVE", kind: "external" };
    const state = airState(channel, date);
    if (!state.onAir) return { title: "OFF AIR", kind: "offair" };
    const files = (lib && lib.files) || [];
    if (!files.length) return { title: "NO PROGRAMS", kind: "empty" };
    const tl = channelTimeline(channel, files, (lib && lib.spots) || [], date);
    const pos = positionAt(tl, date.getTime(), epochMs);
    if (!pos) return { title: "TO BE ANNOUNCED", kind: "unknown" };
    let i = pos.index;
    if (tl[i].kind === "spot") {
      let j = i;
      while (j >= 0 && tl[j].kind === "spot") j--;
      if (j < 0) { j = i; while (j < tl.length && tl[j].kind === "spot") j++; }
      if (j >= 0 && j < tl.length) i = j;
    }
    const seg = tl[i];
    return { title: segmentName(channel, seg), kind: "program", file: seg.file };
  }

  // The grid: a row per channel, and within a row the cells merged wherever
  // the same program runs across more than one slot.
  function guideGrid(channels, libs, date, count, epochMs) {
    const slots = guideSlots(date, count);
    const rows = [];
    for (const ch of channels) {
      if (!ch || ch.enabled === false) continue;
      const cells = [];
      slots.forEach((slot, i) => {
        const p = programAt(ch, libs && libs[ch.number], slot, epochMs) || { title: "", kind: "empty" };
        const last = cells[cells.length - 1];
        if (last && last.title === p.title && last.kind === p.kind) last.span += 1;
        else cells.push({ title: p.title, kind: p.kind, span: 1, slot: i });
      });
      rows.push({ number: ch.number, name: ch.name, type: ch.type, cells });
    }
    return { slots, rows };
  }

  return {
    EPOCH,
    formatClock,
    formatHeaderDate,
    formatLongDate,
    positionAt,
    seededShuffle,
    orderFiles,
    channelTimeline,
    airState,
    nextChannelIndex,
    VOLUME_STEPS,
    nextVolumeStep,
    programTitle,
    segmentName,
    guideSlots,
    programAt,
    guideGrid,
  };
});
