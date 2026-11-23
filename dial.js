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
  // next. The movie resumes exactly where the break cut it. At 0 minutes
  // (breaks only between programs) everyPrograms spaces the breaks out: a
  // break after every Nth program, and always one at the end of the loop,
  // so the loop's seam is a break too.
  // Acts need every program duration up front; a spot whose length is not
  // known yet sits out until the probe learns it. No usable spots (an empty
  // or unprobed folder) means the program folder plays whole.
  // Every segment carries `kind` ("program" or "spot") and the file's
  // `title` (from its metadata, when the server read one), so the guide can
  // name what is on without guessing from the URL.
  function dayKey(date) {
    return date.getFullYear() + "-" + (date.getMonth() + 1) + "-" + date.getDate();
  }

  // A channel's program folders as [{ folder, files }], in the channel's
  // order. `sources` is what the server lists ([{ folder, files }]), so a
  // folder's name, and with it its shuffle, comes from the same place for
  // the guide and the player. A bare list of files per folder is accepted
  // too and named from the channel's config. Without sources, `files` is
  // the one folder.
  function sourceLists(channel, files, sources) {
    const names = Array.isArray(channel.folders) && channel.folders.length ? channel.folders : [channel.folder];
    if (!Array.isArray(sources) || !sources.length) return [{ folder: names[0], files: files || [] }];
    return sources.map((src, i) => (Array.isArray(src)
      ? { folder: names[i] != null ? names[i] : String(i), files: src }
      : { folder: src && src.folder != null ? src.folder : names[i], files: (src && src.files) || [] }));
  }

  // A channel's programs in airing order for the day. One folder is its
  // files in the channel's order. Several folders take turns: each is put
  // in order on its own (a shuffle seeded per folder, so adding a show
  // leaves the others' order alone), then one program from each in turn,
  // the way a block alternates its shows. An empty folder sits out.
  // Several folders only air from this loop (the longest folder's length
  // times the number of folders, folder i's j-th turn its file j mod n)
  // while a length is still unknown; once every length is known they run
  // on the endless order (runningOrder), where no folder starts over
  // because another one did. `sources` is the per-folder lists, in the
  // channel's folder order (see sourceLists); without it (or with one)
  // `files` is the list.
  function channelPrograms(channel, files, date, sources) {
    const day = dayKey(date);
    if (!Array.isArray(sources) || sources.length < 2) return orderFiles(files || [], channel.order, day + "#" + channel.number);
    const lists = sourceLists(channel, files, sources)
      .map((src) => orderFiles(src.files, channel.order, day + "#" + channel.number + "#" + src.folder))
      .filter((list) => list.length);
    if (!lists.length) return [];
    const longest = Math.max(...lists.map((l) => l.length));
    const out = [];
    for (let j = 0; j < longest; j++) for (const list of lists) out.push(list[j % list.length]);
    return out;
  }

  // Programs cut into acts with the breaks between them (see above).
  // `pool` is the spots in airing order, unprobed ones already left out.
  function withBreaks(channel, program, pool) {
    const b = channel.breaks;
    const whole = (f, kind) => ({ kind, file: f.file, title: f.title || null, url: f.url, from: 0, to: f.duration, duration: f.duration });
    if (!b || !pool.length || program.some((f) => !(f.duration > 0))) return program.map((f) => whole(f, "program"));
    const actLen = b.everyMinutes * 60;
    const every = actLen > 0 ? 1 : Math.max(1, Math.round(b.everyPrograms || 1));
    const out = [];
    let cursor = 0;
    program.forEach((p, pi) => {
      const acts = actLen > 0 ? Math.max(1, Math.round(p.duration / actLen)) : 1;
      for (let a = 0; a < acts; a++) {
        const from = (p.duration * a) / acts;
        const to = a === acts - 1 ? p.duration : (p.duration * (a + 1)) / acts;
        out.push({ kind: "program", file: p.file, title: p.title || null, url: p.url, from, to, duration: to - from });
        if ((pi + 1) % every !== 0 && pi !== program.length - 1) continue;
        for (let k = 0; k < b.spots; k++) out.push(whole(pool[cursor++ % pool.length], "spot"));
      }
    });
    return out;
  }

  function channelTimeline(channel, files, spots, date, sources) {
    const day = dayKey(date);
    const program = channelPrograms(channel, files, date, sources);
    const pool = channel.breaks
      ? orderFiles((spots || []).filter((f) => f.duration > 0), channel.order, day + "#" + channel.number + "#breaks")
      : [];
    return withBreaks(channel, program, pool);
  }

  // ---------------------------------------------------------- the schedule

  // A day's stretches of constant UTC offset: [{ a, b, off }] in ms, off in
  // minutes as getTimezoneOffset gives it. One stretch on most days, two on
  // the day the clocks change (found to the millisecond).
  function offsetPieces(a, b) {
    const offAt = (t) => new Date(t).getTimezoneOffset();
    const o1 = offAt(a);
    const o2 = offAt(b - 1);
    if (o1 === o2) return [{ a, b, off: o1 }];
    let lo = a;
    let hi = b - 1;
    while (hi - lo > 1) {
      const mid = Math.floor((lo + hi) / 2);
      if (offAt(mid) === o1) lo = mid;
      else hi = mid;
    }
    return [{ a, b: hi, off: o1 }, { a: hi, b, off: o2 }];
  }

  // Every schedule segment's time on the air, in real time: [{ s, e, g }]
  // in ms, sorted, local day by local day from the day of fromMs through
  // the day of toMs. A segment is on the air while the local clock reads
  // between its start and end on its day, so on the night the clocks go
  // back a repeated hour airs twice, and on the night they go forward a
  // skipped hour does not air at all. airState and the block clock both
  // read this, so they always agree.
  function segmentSpans(segs, fromMs, toMs) {
    const out = [];
    if (!segs.length) return out;
    const first = new Date(fromMs);
    const y = first.getFullYear();
    const m = first.getMonth();
    for (let d = first.getDate(); ; d++) {
      const dayStart = new Date(y, m, d);
      const a = dayStart.getTime();
      if (a > toMs) break;
      const weekday = dayStart.getDay();
      const day = segs.filter((g) => g.day === weekday);
      if (!day.length) continue;
      // The local midnight that starts the day, as if in UTC: local minute
      // M under offset `off` is base + (M + off) minutes.
      const base = Date.UTC(dayStart.getFullYear(), dayStart.getMonth(), dayStart.getDate());
      const pieces = offsetPieces(a, new Date(y, m, d + 1).getTime());
      for (const g of day) {
        for (const p of pieces) {
          const s = Math.max(p.a, base + (g.start + p.off) * 60000);
          const e = Math.min(p.b, base + (g.end + p.off) * 60000);
          if (s < e) out.push({ s, e, g });
        }
      }
    }
    return out.sort((x, z) => x.s - z.s || x.e - z.e);
  }

  function scheduleSegments(channel) {
    return (Array.isArray(channel.schedule) ? channel.schedule : []).flatMap((w) => S.windowSegments(w));
  }

  // Spans that touch or overlap are one span: an overnight window (two
  // segments either side of midnight), two windows back to back, and both
  // sides of the hour repeated when the clocks go back each read as one
  // stretch on the air. `into` is extended in place and returned.
  function mergeSpans(spans, into) {
    const out = into || [];
    for (const sp of spans) {
      const last = out[out.length - 1];
      if (last && sp.s <= last.e) last.e = Math.max(last.e, sp.e);
      else out.push({ s: sp.s, e: sp.e });
    }
    return out;
  }

  // Is a scheduled channel on the air at `date`, and when does that change?
  // Returns { onAir, untilMs, resumeText }. untilMs is when the state next
  // flips (so the tuner can set one exact timer instead of polling, and
  // never retunes a channel that is still on the air); it is null when the
  // state never changes.
  function airState(channel, date) {
    if (!channel || channel.mode !== "schedule") return { onAir: true, untilMs: null, resumeText: "" };
    const windows = Array.isArray(channel.schedule) ? channel.schedule : [];
    if (!windows.length) return { onAir: false, untilMs: null, resumeText: "NO PROGRAMMING SCHEDULED" };
    // The schema expands each window (overnight ones included) into
    // non-wrapping { day, start, end } minute segments, so all the math
    // below can rely on start < end.
    const segs = scheduleSegments(channel);
    if (!segs.length) return { onAir: false, untilMs: null, resumeText: "NO PROGRAMMING SCHEDULED" };
    const now = date.getTime();
    // Yesterday through a week ahead: the stretch on the air now, or the
    // next one to start. A stretch that runs to the end of what was looked
    // at is looked at further, and one that never ends never flips.
    for (const days of [8, 400]) {
      const end = now + days * 86400000;
      const spans = mergeSpans(segmentSpans(segs, now - 86400000, end));
      const on = spans.find((sp) => sp.s <= now && now < sp.e);
      if (on) {
        if (on.e < end - 86400000) return { onAir: true, untilMs: on.e, resumeText: "" };
        continue;
      }
      const next = spans.find((sp) => sp.s > now);
      if (!next) return { onAir: false, untilMs: null, resumeText: "NO PROGRAMMING SCHEDULED" };
      // The time it really comes on: on the night the clocks go forward a
      // window that starts in the skipped hour comes on when they land.
      const at = new Date(next.s);
      const h = at.getHours();
      const h12 = h % 12 || 12;
      const ampm = h < 12 ? "AM" : "PM";
      const mm = String(at.getMinutes()).padStart(2, "0");
      const dayWord = at.getDay() === date.getDay() && next.s - now < 12 * 3600 * 1000 ? "TODAY" : DAYS[at.getDay()];
      return {
        onAir: false,
        untilMs: next.s,
        resumeText: "PROGRAMMING RESUMES " + dayWord + " " + h12 + ":" + mm + " " + ampm,
      };
    }
    return { onAir: true, untilMs: null, resumeText: "" }; // on the air for more than a year ahead: always
  }

  // The on-air spans of a scheduled channel's windows, in order, from the
  // local day of `fromMs` through the day of `toMs`: [{ s, e }] in ms of
  // real time (see segmentSpans), merged as mergeSpans says.
  function airSpans(channel, fromMs, toMs) {
    return mergeSpans(segmentSpans(scheduleSegments(channel), fromMs, toMs));
  }

  // The block clock reads a schedule's spans from the epoch on, again and
  // again, and they depend only on the schedule and the time zone, not on
  // the files. So they are worked out once and kept, extended forward in
  // whole local days as later times are asked about.
  const spanCache = new Map();
  function spansSince(channel, epochMs, toMs) {
    const zone = typeof Intl !== "undefined" ? Intl.DateTimeFormat().resolvedOptions().timeZone : "";
    const key = zone + "|" + epochMs + "|" + JSON.stringify(channel.schedule || []);
    let c = spanCache.get(key);
    if (!c) {
      const first = new Date(epochMs);
      c = { to: new Date(first.getFullYear(), first.getMonth(), first.getDate()).getTime(), spans: [] };
      if (spanCache.size > 32) spanCache.clear();
      spanCache.set(key, c);
    }
    if (c.to <= toMs) {
      const segs = scheduleSegments(channel);
      // Through a few days past toMs, ending on a local midnight, so the
      // next extension starts where this one stopped.
      const stop = new Date(toMs + 3 * 86400000);
      const to = new Date(stop.getFullYear(), stop.getMonth(), stop.getDate()).getTime();
      mergeSpans(segmentSpans(segs, c.to, to - 1), c.spans);
      c.to = to;
    }
    return c.spans;
  }

  // ---------------------------------------------------------- several folders, endlessly

  // The running order of a channel of several folders, or of a block: an
  // endless list of programs numbered from 0, never a loop. Program g is
  // folder (g mod F)'s turn floor(g / F), and a folder's k-th turn plays
  // file k mod n of its pass floor(k / n). So every folder cycles through
  // its own files on its own: a shorter folder starts over when it runs
  // out, never because another one did, and no episode airs twice in a row.
  // Nothing is built ahead: when program g starts is arithmetic (whole
  // passes times a pass's length, plus the part of the pass in progress,
  // plus the spots so far), so finding the place is a binary search,
  // however long the clock has run and however the folder lengths divide.
  //
  // Breaks work as in channelTimeline: each program is cut into acts with
  // a break after every act, or at 0 minutes a break after every Nth
  // program. The spots cycle through the pool without starting over.
  //
  // lists: [{ folder, files }], none empty, every length known.
  // orderFor(i, pass): folder i's files in airing order for that pass.
  // pool: the spots in airing order, every length known.
  function runningOrder(channel, lists, orderFor, pool) {
    const F = lists.length;
    const b = channel.breaks && pool.length ? channel.breaks : null;
    const actLen = b ? b.everyMinutes * 60 : 0;
    const every = b && actLen <= 0 ? Math.max(1, Math.round(b.everyPrograms || 1)) : 1;
    const actsOf = (f) => (actLen > 0 ? Math.max(1, Math.round(f.duration / actLen)) : 1);
    const passLen = lists.map((l) => l.files.reduce((a, f) => a + f.duration, 0));
    const passActs = lists.map((l) => l.files.reduce((a, f) => a + actsOf(f), 0));
    const spotPre = [0];
    for (const s of pool) spotPre.push(spotPre[spotPre.length - 1] + s.duration);
    const shortest = Math.min(...lists.map((l) => Math.min(...l.files.map((f) => f.duration))));
    const cache = lists.map(() => new Map());

    // Folder i's pass p in airing order, with running totals of length and acts.
    function pass(i, p) {
      let got = cache[i].get(p);
      if (got) return got;
      const files = orderFor(i, p);
      const dur = [0];
      const acts = [0];
      for (const f of files) {
        dur.push(dur[dur.length - 1] + f.duration);
        acts.push(acts[acts.length - 1] + actsOf(f));
      }
      got = { files, dur, acts };
      if (cache[i].size > 64) cache[i].clear();
      cache[i].set(p, got);
      return got;
    }

    // The program time and the acts that come before program g.
    function before(g) {
      let dur = 0;
      let acts = 0;
      const round = Math.floor(g / F);
      for (let i = 0; i < F; i++) {
        const k = round + (i < g % F ? 1 : 0);
        const n = lists[i].files.length;
        const p = Math.floor(k / n);
        const ps = pass(i, p);
        dur += p * passLen[i] + ps.dur[k % n];
        acts += p * passActs[i] + ps.acts[k % n];
      }
      return { dur, acts };
    }
    const spotsBefore = (g, acts) => (!b ? 0 : actLen > 0 ? acts * b.spots : Math.floor(g / every) * b.spots);
    const spotTime = (c) => (c <= 0 ? 0 : Math.floor(c / pool.length) * spotPre[pool.length] + spotPre[c % pool.length]);

    // When program g starts, in seconds from the start of the order.
    function start(g) {
      const x = before(g);
      return x.dur + spotTime(spotsBefore(g, x.acts));
    }

    // Program g's segments: its acts, each followed by its break.
    function segments(g) {
      const i = g % F;
      const k = Math.floor(g / F);
      const n = lists[i].files.length;
      const f = pass(i, Math.floor(k / n)).files[k % n];
      const acts = actsOf(f);
      let c = spotsBefore(g, before(g).acts);
      const out = [];
      for (let a = 0; a < acts; a++) {
        const from = (f.duration * a) / acts;
        const to = a === acts - 1 ? f.duration : (f.duration * (a + 1)) / acts;
        out.push({ kind: "program", file: f.file, title: f.title || null, url: f.url, from, to, duration: to - from });
        if (!b || (actLen <= 0 && (g + 1) % every !== 0)) continue;
        for (let s = 0; s < b.spots; s++) {
          const spot = pool[c++ % pool.length];
          out.push({ kind: "spot", file: spot.file, title: spot.title || null, url: spot.url, from: 0, to: spot.duration, duration: spot.duration });
        }
      }
      return out;
    }

    // Where the order is `t` seconds in: { g, i, offset }, the program,
    // the segment of it, and the seconds into that segment. A moment within
    // a microsecond of a segment's end is the next segment's start. `from`
    // is a program known to start at or before t, to search from there.
    function at(t, from) {
      const want = Math.max(0, t);
      let lo = from > 0 ? from : 0;
      // start(hi) > want: every program is at least `shortest` long.
      let hi = lo + Math.floor((want - (lo ? start(lo) : 0)) / shortest) + 1;
      while (lo < hi) {
        const mid = Math.floor((lo + hi + 1) / 2);
        if (start(mid) <= want + 1e-6) lo = mid;
        else hi = mid - 1;
      }
      let g = lo;
      let rest = want - start(g);
      for (;;) {
        const segs = segments(g);
        for (let i = 0; i < segs.length; i++) {
          if (rest < segs[i].duration - 1e-6) return { g, i, offset: Math.max(0, rest) };
          rest -= segs[i].duration;
        }
        g += 1;
      }
    }

    return { start, segments, at };
  }

  // ---------------------------------------------------------- the block clock

  // One remembered walk per channel: how far the block clock has been
  // worked out, so the guide and the player do not walk every window since
  // the epoch on every call. Keyed by everything the walk depends on: the
  // schedule, the epoch, the order and breaks, and every folder's files and
  // lengths, so any change to the running order starts a fresh walk.
  const blockMemo = new Map();
  const fileKey = (f) => f.url + "@" + f.duration;

  // Which program the next window opens on, after a window that opened on
  // program `opened` closed at `pos`. A window that closed on a program's
  // top hands on that program. One that cut a program off, mid-act or in a
  // break between its acts, hands on the top of that program, so the
  // episode is seen in full next time; the spots it cut are not picked up.
  // One that closed in the break after a program's last act hands on the
  // next program. A window too short to finish the program it opened on
  // moves on all the same, so a block never replays one opening forever.
  function nextOpening(seq, opened, pos) {
    const segs = seq.segments(pos.g);
    const seg = segs[pos.i];
    if (seg.kind === "program" && !(seg.from > 0) && pos.offset < 1e-6) return pos.g;
    const cut = seg.kind === "program" || segs.slice(pos.i + 1).some((s) => s.kind === "program");
    return cut && pos.g !== opened ? pos.g : pos.g + 1;
  }

  // The block clock: { g, i, offset } (program, segment of it, seconds
  // in), or null off the air. The channel's own clock runs only inside its
  // windows, and every window opens at the top of a program (see
  // nextOpening for which). The walk starts at the epoch with the first
  // program and replays every window since, so it is the same answer on
  // every set; adding or removing an episode changes where that walk lands.
  //
  // What a walk has learned is kept: where it stopped, and a checkpoint at
  // every so many window ends (the program the next window opens on), so a
  // question about an earlier time (the guide looks ahead, the player asks
  // about now) starts from the nearest checkpoint before it instead of
  // from the epoch. The checkpoints thin out by half when there are too
  // many, so they stay few however long the set runs. Every answer is the
  // one a walk from the epoch gives, because a checkpoint is a point that
  // walk passed through.
  const MAX_MARKS = 512;
  function blockWalk(channel, key, makeSeq, nowMs, epochMs) {
    let memo = blockMemo.get(channel.number);
    if (!memo || memo.key !== key) {
      const origin = { untilMs: epochMs, g: 0, n: 0 };
      memo = { key, seq: makeSeq(), at: origin, marks: [origin], every: 16 };
    }
    // The latest known state at or before now: where the last walk
    // stopped, or the checkpoint nearest before now.
    let from = memo.at.untilMs <= nowMs ? memo.at : null;
    let lo = 0;
    let hi = memo.marks.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (memo.marks[mid].untilMs <= nowMs) lo = mid;
      else hi = mid - 1;
    }
    if (!from || memo.marks[lo].untilMs > from.untilMs) from = memo.marks[lo];
    const seq = memo.seq;
    let { g, untilMs, n } = from;
    let result = null;
    const spans = spansSince(channel, epochMs, nowMs);
    // The first span not walked yet.
    let k = 0;
    let top = spans.length;
    while (k < top) {
      const mid = (k + top) >> 1;
      if (spans[mid].e <= untilMs) k = mid + 1;
      else top = mid;
    }
    for (; k < spans.length; k++) {
      const span = spans[k];
      if (span.s > nowMs) break;
      const s = Math.max(span.s, epochMs);
      const base = seq.start(g);
      if (nowMs < span.e) {
        result = seq.at(base + (nowMs - s) / 1000, g);
        break;
      }
      g = nextOpening(seq, g, seq.at(base + (span.e - s) / 1000, g));
      untilMs = span.e;
      n += 1;
      const last = memo.marks[memo.marks.length - 1];
      if (n % memo.every === 0 && untilMs > last.untilMs) {
        memo.marks.push({ untilMs, g, n });
        if (memo.marks.length > MAX_MARKS) {
          memo.every *= 2;
          memo.marks = memo.marks.filter((m) => m.n % memo.every === 0);
        }
      }
    }
    memo.at = { untilMs, g, n };
    blockMemo.set(channel.number, memo);
    return result;
  }

  const isBlock = (channel) => !!channel && channel.mode === "schedule" && channel.clock === "block";

  // What a video channel airs at `date`: { tl, pos }, the timeline to play
  // from and the position in it (null while the clock cannot run, or off
  // the air on a block). lib is the tuner's listing for the channel,
  // { files, spots, sources }. The player and the guide both read this, so
  // they always agree.
  // One folder on the station's clock is the loop channelTimeline builds,
  // placed by positionAt, exactly as before several folders existed.
  // Several folders, or a block, run on the endless order above: tl is the
  // program on the air with one before it and two after, each segment
  // carrying a `key` (program number and segment) that names it across
  // calls. On the station's clock the folders keep the day's order (a
  // daily shuffle, seeded per folder) and the place is counted from the
  // epoch. On a block a daily shuffle would replay every window since the
  // epoch in today's order and lose the block's place, so a shuffled block
  // shuffles each folder once per pass instead, seeded by the channel, the
  // folder, and the pass, and its spots keep one shuffled order.
  function channelAir(channel, lib, date, epochMs) {
    const files = (lib && lib.files) || [];
    const spots = (lib && lib.spots) || [];
    const sources = lib && Array.isArray(lib.sources) ? lib.sources : null;
    const nowMs = date.getTime();
    const block = isBlock(channel);
    const lists = sourceLists(channel, files, sources).filter((l) => l.files.length);
    if (!block && lists.length < 2) {
      const tl = channelTimeline(channel, files, spots, date, sources);
      return { tl, pos: positionAt(tl, nowMs, epochMs) };
    }
    if (!lists.length || lists.some((l) => l.files.some((f) => !(f && f.duration > 0)))) {
      // A length still unknown: play the day's loop in turn while the
      // probe learns it, the way the station clock waits.
      return { tl: channelTimeline(channel, files, spots, date, sources), pos: null };
    }
    const known = spots.filter((f) => f && f.duration > 0);
    let seq;
    let pos;
    if (!block) {
      const day = dayKey(date);
      const orders = lists.map((l) => orderFiles(l.files, channel.order, day + "#" + channel.number + "#" + l.folder));
      const pool = channel.breaks ? orderFiles(known, channel.order, day + "#" + channel.number + "#breaks") : [];
      seq = runningOrder(channel, lists, (i) => orders[i], pool);
      pos = seq.at((nowMs - epochMs) / 1000);
    } else {
      const shuffle = channel.order === "shuffle-daily";
      const key = [
        channel.number, channel.order, JSON.stringify(channel.schedule || []), epochMs, JSON.stringify(channel.breaks || null),
        lists.map((l) => l.folder + ":" + l.files.map(fileKey).join(",")).join("|"),
        known.map(fileKey).join(","),
      ].join("#");
      const make = () => {
        const pool = !channel.breaks ? [] : shuffle ? seededShuffle(known, channel.number + "#" + channel.breaks.folder + "#breaks") : known;
        // A pass that would open on the episode the last pass closed on
        // swaps its first two, so no episode airs twice running. Swapping
        // the first two leaves a pass's last episode where it was (for
        // three or more), so each pass needs only the one before it. Two
        // episodes can only alternate, so they keep the first pass's order.
        const shuffled = (i, p) => seededShuffle(lists[i].files, channel.number + "#" + lists[i].folder + "#pass" + p);
        const orderFor = (i, p) => {
          const n = lists[i].files.length;
          if (!shuffle || n < 2) return lists[i].files;
          if (n === 2) return shuffled(i, 0);
          const o = shuffled(i, p);
          if (p > 0 && o[0] === shuffled(i, p - 1)[n - 1]) {
            const t = o[0];
            o[0] = o[1];
            o[1] = t;
          }
          return o;
        };
        return runningOrder(channel, lists, orderFor, pool);
      };
      pos = blockWalk(channel, key, make, nowMs, epochMs);
      // The remembered order, not a new one: it holds the passes already worked out.
      seq = blockMemo.get(channel.number).seq;
    }
    const around = pos ? pos.g : 0;
    const tl = [];
    let index = 0;
    for (let g = Math.max(0, around - 1); g <= around + 2; g++) {
      if (pos && g === pos.g) index = tl.length + pos.i;
      seq.segments(g).forEach((seg, i) => tl.push(Object.assign(seg, { key: g + ":" + i })));
    }
    return { tl, pos: pos && { index, offset: pos.offset } };
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

  // The set holds its sound as a level, 0 to 1, because two kinds of key
  // move it. The volume key walks the Zenith ring from wherever the level
  // is: up to the next of its steps, and from loud around to sound off. A
  // stick pushed left or right moves one cell of the on-screen meter at a
  // time and stops at the ends.
  const VOLUME_CELLS = 8;
  const clampLevel = (l) => (Number.isFinite(l) ? Math.min(1, Math.max(0, l)) : 1);
  function nextVolumeLevel(level) {
    const l = clampLevel(level);
    const above = VOLUME_STEPS.map((s) => s.level).filter((s) => s > l + 1e-9).sort((a, b) => a - b);
    return above.length ? above[0] : 0;
  }
  function stepVolumeLevel(level, dir) {
    const cell = Math.round(clampLevel(level) * VOLUME_CELLS) + (dir < 0 ? -1 : 1);
    return Math.min(VOLUME_CELLS, Math.max(0, cell)) / VOLUME_CELLS;
  }

  // A button pressed more than once. Presses of the same button that follow
  // each other within PRESS_GAP_MS are one run, and the count of a run is
  // what it means: two is the power key. A long run switches the machine
  // off, the moment the count is reached (shutdownPresses, 0 for never).
  // Every other count means nothing, so a single press and a miscount do no
  // harm.
  const PRESS_GAP_MS = 500;
  function countPress(run, button, nowMs) {
    const same = run && run.button === button && nowMs - run.at <= PRESS_GAP_MS;
    return { button, count: same ? run.count + 1 : 1, at: nowMs };
  }
  function runMeaning(count, shutdownPresses) {
    if (shutdownPresses > 0 && count >= shutdownPresses) return "shutdown";
    if (count === 2) return "power";
    return null;
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
    const { tl, pos } = channelAir(channel, lib, date, epochMs);
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
    channelPrograms,
    channelTimeline,
    airState,
    airSpans,
    channelAir,
    nextChannelIndex,
    VOLUME_STEPS,
    nextVolumeStep,
    VOLUME_CELLS,
    nextVolumeLevel,
    stepVolumeLevel,
    PRESS_GAP_MS,
    countPress,
    runMeaning,
    programTitle,
    segmentName,
    guideSlots,
    programAt,
    guideGrid,
  };
});
