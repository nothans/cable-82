/* cable-82 client. One file, no dependencies.
   Pure helpers are exposed on window.Cable82 for test/harness.html;
   the app only boots when the page has a #stage element. */
(() => {
  "use strict";

  // ---------------------------------------------------------- shared schema

  // The palette, validation, and text helpers live in config-schema.js so the
  // server, the control room, and this display all agree. Alias them so the
  // rest of the file reads unchanged.
  const S = (typeof window !== "undefined" && window.Cable82Schema) || {};
  const PALETTE = S.PALETTE || {};
  const PALETTE_CRT = S.PALETTE_CRT || PALETTE;
  const clampNum = S.clampNum;
  const resolveColor = S.resolveColor;
  const textColorFor = S.textColorFor;
  const sanitize = S.sanitize;
  const validateConfig = S.validateConfig;

  const DAYS3 = ["SUN", "MON", "TUE", "WED", "THU", "FRI", "SAT"];
  const DAYS = ["SUNDAY", "MONDAY", "TUESDAY", "WEDNESDAY", "THURSDAY", "FRIDAY", "SATURDAY"];
  const MONTHS3 = ["JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEP", "OCT", "NOV", "DEC"];
  const MONTHS = ["JANUARY", "FEBRUARY", "MARCH", "APRIL", "MAY", "JUNE", "JULY", "AUGUST", "SEPTEMBER", "OCTOBER", "NOVEMBER", "DECEMBER"];

  const FALLBACK_FACTS = [
    "The Weather Channel debuted on May 2, 1982",
    "The first smiley emoticon was posted in September 1982",
    "Honey never spoils",
    "A day on Venus is longer than its year",
    "A group of flamingos is called a flamboyance",
  ];

  const FALLBACK_JOKES = [
    "Why did the scarecrow win an award? He was outstanding in his field.",
    "I'm reading a book about anti-gravity. It's impossible to put down.",
    "What do you call a fake noodle? An impasta.",
  ];

  // ---------------------------------------------------------- display helpers

  // RSS 2.0 and Atom. Returns raw title strings; caller sanitizes.
  function parseFeed(xmlText) {
    if (typeof xmlText !== "string" || !xmlText.trim()) return [];
    let doc;
    try {
      doc = new DOMParser().parseFromString(xmlText, "application/xml");
    } catch (e) {
      return [];
    }
    if (doc.querySelector("parsererror")) return [];
    const out = [];
    for (const node of doc.querySelectorAll("item, entry")) {
      // Direct child <title> in the item's own namespace, so a preceding
      // <media:title> or similar never shadows the real one.
      let title = null;
      for (const child of node.children) {
        if (child.localName === "title" && child.namespaceURI === node.namespaceURI) {
          title = child;
          break;
        }
      }
      if (title && title.textContent) out.push(title.textContent);
    }
    return out;
  }

  // Fisher-Yates shuffle, non-mutating. Used to shuffle the music playlist.
  function shuffled(arr) {
    const a = arr.slice();
    for (let i = a.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      const t = a[i];
      a[i] = a[j];
      a[j] = t;
    }
    return a;
  }

  // Round-robin over a list whose length may change between calls.
  function makeRR() {
    let i = -1;
    return {
      next(len) {
        if (!len || len < 1) return -1;
        i = (i + 1) % len;
        return i;
      },
    };
  }

  // ------------------------------------------------------------ the dial math
  // All pure, all tested in the harness. The broadcast clock is the load-
  // bearing idea: position on a channel is a function of the wall clock,
  // never a play cursor, which is what lets a stopped channel resume at
  // exactly the moment it would have reached, and makes cheap teardown free.

  // Natural sort: digit runs compare numerically, so "S01.E2" airs before
  // "S01.E10". Mirrors the server's sort so both sides agree on the order.
  function naturalCompare(a, b) {
    const ax = String(a).toLowerCase().split(/(\d+)/);
    const bx = String(b).toLowerCase().split(/(\d+)/);
    for (let i = 0; i < Math.max(ax.length, bx.length); i++) {
      const as = ax[i] || "";
      const bs = bx[i] || "";
      if (as === bs) continue;
      const an = /^\d+$/.test(as) ? Number(as) : NaN;
      const bn = /^\d+$/.test(bs) ? Number(bs) : NaN;
      if (Number.isFinite(an) && Number.isFinite(bn)) {
        if (an !== bn) return an - bn;
        continue; // "1" vs "01": same episode number, keep comparing
      }
      return as < bs ? -1 : 1;
    }
    // Segments all tie (maybe only padding differs): raw string settles it.
    return String(a) < String(b) ? -1 : String(a) > String(b) ? 1 : 0;
  }

  // (playlist, nowMs, epochMs) -> { index, offset } | null.
  // playlist: [{ duration }] with every duration known and positive.
  function positionAt(playlist, nowMs, epochMs) {
    if (!Array.isArray(playlist) || !playlist.length) return null;
    let total = 0;
    for (const item of playlist) {
      if (!item || !Number.isFinite(item.duration) || item.duration <= 0) return null;
      total += item.duration;
    }
    let t = (((nowMs - epochMs) / 1000) % total + total) % total;
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
    const segs = windows.flatMap((w) => (S.windowSegments ? S.windowSegments(w) : []));
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
    const DAY_FULL = ["SUNDAY", "MONDAY", "TUESDAY", "WEDNESDAY", "THURSDAY", "FRIDAY", "SATURDAY"];
    const startMin = best.startMin;
    const h12 = Math.floor(startMin / 60) % 12 || 12;
    const ampm = startMin < 720 ? "AM" : "PM";
    const mm = String(startMin % 60).padStart(2, "0");
    const dayWord = best.day === date.getDay() && best.at - date.getTime() < 12 * 3600 * 1000 ? "TODAY" : DAY_FULL[best.day];
    return {
      onAir: false,
      untilMs: best.at,
      resumeText: "PROGRAMMING RESUMES " + dayWord + " " + h12 + ":" + mm + " " + ampm,
    };
  }

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

  // Interleave items across feeds: news1, tech1, blog1, news2, ...
  // extras ride at the front of each pass (the CheerLights color, say).
  function buildCrawlText(opts) {
    const { feedIds = [], labels = {}, items = {}, separator = "  ■  ", fallback = "", extras = [] } = opts || {};
    const parts = extras.filter((t) => typeof t === "string" && t);
    const max = Math.max(0, ...feedIds.map((id) => (items[id] || []).length));
    for (let k = 0; k < max; k++) {
      for (const id of feedIds) {
        const list = items[id] || [];
        if (k < list.length) parts.push((labels[id] || id.toUpperCase()) + ": " + list[k]);
      }
    }
    return parts.length ? parts.join(separator) : fallback;
  }

  function formatClock(d, mode) {
    const mm = String(d.getMinutes()).padStart(2, "0");
    if (mode === "24h") return String(d.getHours()).padStart(2, "0") + ":" + mm;
    const h = d.getHours() % 12 || 12;
    return h + ":" + mm + " " + (d.getHours() < 12 ? "AM" : "PM");
  }

  // Format a sunrise/sunset string. Open-Meteo returns it already in the
  // location's timezone ("2026-07-22T05:27"), so parse the clock digits
  // directly - never through Date, which would re-apply the browser's tz.
  function formatWxTime(iso, mode) {
    const m = /T(\d{2}):(\d{2})/.exec(typeof iso === "string" ? iso : "");
    if (!m) return "";
    const hh = Number(m[1]);
    const mm = m[2];
    if (mode === "24h") return String(hh).padStart(2, "0") + ":" + mm;
    return (hh % 12 || 12) + ":" + mm + " " + (hh < 12 ? "AM" : "PM");
  }

  // "THE WORLD IS SET TO {COLOR}" + "purple" -> "THE WORLD IS SET TO PURPLE"
  function cheerlightsLine(template, color) {
    if (typeof color !== "string" || !color) return "";
    return String(template || "").replace(/\{color\}/gi, color.toUpperCase());
  }

  function formatHeaderDate(d) {
    return DAYS3[d.getDay()] + " " + MONTHS3[d.getMonth()] + " " + d.getDate();
  }

  function formatLongDate(d) {
    return DAYS[d.getDay()] + ", " + MONTHS[d.getMonth()] + " " + d.getDate() + ", " + d.getFullYear();
  }

  // ---------------------------------------------------------- app state

  const stats = {
    bootAt: Date.now(),
    pageFlips: 0,
    crawlCycles: 0,
    crawlRestarts: 0,
    schedulerRestarts: 0,
    feedOk: 0,
    feedErr: 0,
  };

  function statsSnapshot() {
    return {
      uptimeSec: Math.round((Date.now() - stats.bootAt) / 1000),
      pageFlips: stats.pageFlips,
      crawlCycles: stats.crawlCycles,
      crawlRestarts: stats.crawlRestarts,
      schedulerRestarts: stats.schedulerRestarts,
      feedOk: stats.feedOk,
      feedErr: stats.feedErr,
      domNodes: document.getElementsByTagName("*").length,
      heapBytes: (performance.memory && performance.memory.usedJSHeapSize) || null,
    };
  }

  window.Cable82 = {
    PALETTE,
    PALETTE_CRT,
    clampNum,
    resolveColor,
    textColorFor,
    sanitize,
    parseFeed,
    makeRR,
    buildCrawlText,
    cheerlightsLine,
    shuffled,
    formatClock,
    formatHeaderDate,
    formatLongDate,
    formatWxTime,
    validateConfig,
    naturalCompare,
    positionAt,
    seededShuffle,
    airState,
    nextChannelIndex,
    VOLUME_STEPS,
    nextVolumeStep,
    stats: statsSnapshot,
  };

  // ---------------------------------------------------------- boot

  document.addEventListener("DOMContentLoaded", () => {
    const stage = document.getElementById("stage");
    if (!stage) return; // test harness page: helpers only

    const el = {
      stage,
      chName: document.getElementById("ch-name"),
      chTagline: document.getElementById("ch-tagline"),
      chClock: document.getElementById("ch-clock"),
      chDate: document.getElementById("ch-date"),
      page: document.getElementById("page"),
      kicker: document.getElementById("page-kicker"),
      body: document.getElementById("page-body"),
      pageTime: document.getElementById("page-time"),
      pageDate: document.getElementById("page-date"),
      wxLocation: document.getElementById("wx-location"),
      wxTemp: document.getElementById("wx-temp"),
      wxCond: document.getElementById("wx-cond"),
      wxHilo: document.getElementById("wx-hilo"),
      wxSun: document.getElementById("wx-sun"),
      header: document.getElementById("band-header"),
      crawlBand: document.getElementById("band-crawl"),
      crawlFlag: document.getElementById("crawl-flag"),
      crawlWindow: document.getElementById("crawl-window"),
      track: document.getElementById("crawl-track"),
      errorCard: document.getElementById("error-card"),
      errorDetail: document.getElementById("error-detail"),
    };

    function showErrorCard(detail) {
      el.errorCard.hidden = false;
      el.errorDetail.textContent = detail;
    }

    loadRuntimeConfig().then(({ raw, version }) => {
      const result = validateConfig(raw);
      if (!result.ok) {
        showErrorCard(result.errors.join(" / ") + " - CHECK config.json OR THE CONTROL ROOM AT /config, THEN RELOAD");
        return;
      }
      const cfg = result.cfg;
      result.errors.forEach((e) => console.warn("[cable-82] " + e));
      startTuner(cfg, version);
    });

    function startChannel(cfg, bootVersion) {
    // Suspension: when another channel covers the board, the expensive work
    // (page renders, the crawl animation, music) stops. Timers keep ticking
    // cheaply and feeds keep refreshing quietly, so coming home is instant
    // and the content is current. The tuner owns this via the returned handle.
    let suspended = false;
    let musicAudio = null;
    let musicBegin = null; // starts playback; a no-op after the first call
    let soundLevel = 1; // the tuner's volume key, 0..1, over the configured music volume
    const musicVolume = () => Math.min(1, Math.max(0, cfg.music.volume / 100)) * soundLevel;
    const soak = new URLSearchParams(location.search).has("soak");
    if (soak) {
      cfg.pageSeconds = 0.2;
      cfg.refreshMinutes = 5 / 60; // 5 seconds
      console.log("[cable-82] soak mode on");
    }

    // static chrome
    // CRT mode swaps the palette and drops the drop shadow (style.css does the
    // rest off the class); textScale enlarges the small text.
    const pal = cfg.crtMode ? PALETTE_CRT : PALETTE;
    stage.classList.toggle("crt", cfg.crtMode);
    stage.style.setProperty("--ts", String(cfg.textScale));
    stage.style.setProperty("--ovp", String(cfg.overscanPercent));
    stage.style.setProperty("--ovpx", String(cfg.overscanX));
    stage.style.setProperty("--ovpy", String(cfg.overscanY));
    stage.style.setProperty("--header-bg", resolveColor(cfg.colors.headerBg, "blue", pal));
    // CRT mode pins the crawl to a dark blue band with light text no matter
    // what the config says. Dark blue, not neutral ink: on a real tube any
    // chroma bleed from the red flag lands on a neutral band as a green cast,
    // while on a blue band it just reads as more blue. 1982 knew this too.
    const crawlBg = cfg.crtMode ? "#182858" : cfg.colors.crawlBg;
    stage.style.setProperty("--crawl-bg", resolveColor(crawlBg, "ink", pal));
    el.header.style.color = textColorFor(cfg.colors.headerBg, pal);
    el.crawlBand.style.color = textColorFor(crawlBg, pal);
    // The station bug inverts against the header band.
    stage.style.setProperty("--bug-bg", textColorFor(cfg.colors.headerBg, pal));
    stage.style.setProperty("--bug-fg", resolveColor(cfg.colors.headerBg, "blue", pal));
    el.chName.textContent = cfg.channelName;
    el.chTagline.textContent = cfg.tagline;
    el.crawlFlag.textContent = cfg.crawl.flag;

    // Facts and dad jokes now travel in the config itself; fall back to the
    // bundled samples only if a channel ships with an empty list.
    const store = {
      feeds: Object.fromEntries(cfg.feeds.map((f) => [f.id, []])),
      facts: cfg.facts && cfg.facts.length ? cfg.facts : FALLBACK_FACTS,
      dadJokes: cfg.dadJokes && cfg.dadJokes.length ? cfg.dadJokes : FALLBACK_JOKES,
      messages: cfg.messages,
      weather: null, // filled by the weather loop when a weather slot exists
      cheerlights: null, // filled by the CheerLights loop when enabled
    };
    const labels = Object.fromEntries(cfg.feeds.map((f) => [f.id, f.label]));

    // ---------------- clock

    let clockTimer = null;
    let lastClockTick = 0;
    function tickClock() {
      const now = new Date();
      lastClockTick = now.getTime();
      el.chClock.textContent = formatClock(now, cfg.timeFormat);
      el.chDate.textContent = formatHeaderDate(now);
      if (el.page.classList.contains("mode-clock")) {
        el.pageTime.textContent = formatClock(now, cfg.timeFormat);
        el.pageDate.textContent = formatLongDate(now);
      }
      clockTimer = setTimeout(tickClock, 1000 - now.getMilliseconds() + 5);
    }
    function restartClock() {
      clearTimeout(clockTimer);
      tickClock();
    }

    // ---------------- feeds

    const failures = {};
    const feedTimers = {};

    function scheduleFeed(feed, delayMs) {
      clearTimeout(feedTimers[feed.id]);
      feedTimers[feed.id] = setTimeout(() => refreshFeed(feed), delayMs);
    }

    async function refreshFeed(feed) {
      let ok = false;
      try {
        const r = await fetch("api/feed/" + encodeURIComponent(feed.id), {
          cache: "no-store",
          signal: AbortSignal.timeout(12000),
        });
        if (!r.ok) throw new Error("HTTP " + r.status);
        const items = parseFeed(await r.text())
          .map((t) => sanitize(t))
          .filter(Boolean)
          .slice(0, cfg.maxItemsPerFeed);
        if (!items.length) throw new Error("no items");
        store.feeds[feed.id] = items; // wholesale replacement, capped
        failures[feed.id] = 0;
        stats.feedOk++;
        ok = true;
      } catch (e) {
        failures[feed.id] = (failures[feed.id] || 0) + 1;
        stats.feedErr++;
      }
      const backoffMinutes = Math.min(cfg.refreshMinutes, Math.pow(2, (failures[feed.id] || 1) - 1));
      scheduleFeed(feed, (ok ? cfg.refreshMinutes : backoffMinutes) * 60000);
    }

    // ---------------- weather

    // Only poll weather when a weather slot is actually in the rotation, so a
    // channel that never shows weather never calls out. Weather changes slowly:
    // every 15 minutes (5s under soak) is plenty.
    const usesWeather = cfg.rotation.some((s) => s.type === "weather");
    let weatherTimer = null;
    async function refreshWeather() {
      try {
        const r = await fetch("api/weather", { cache: "no-store", signal: AbortSignal.timeout(12000) });
        if (r.ok) store.weather = await r.json();
      } catch (e) {
        /* keep the last good weather; try again next tick */
      }
      const everyMs = soak ? 5000 : 15 * 60000;
      weatherTimer = setTimeout(refreshWeather, everyMs);
    }

    // ---------------- cheerlights

    // One global color the whole internet shares (cheerlights.com). It rides
    // the crawl, so poll only when enabled. Colors change on people's whims:
    // once a minute keeps the ticker honest without hammering anything.
    const usesCheerlights = cfg.cheerlights && cfg.cheerlights.enabled;
    let cheerTimer = null;
    async function refreshCheerlights() {
      try {
        const r = await fetch("api/cheerlights", { cache: "no-store", signal: AbortSignal.timeout(12000) });
        if (r.ok) store.cheerlights = await r.json();
      } catch (e) {
        /* keep the last color; try again next tick */
      }
      cheerTimer = setTimeout(refreshCheerlights, soak ? 5000 : 60000);
    }

    // ---------------- music (continuous background audio)

    // Play the tracks in the music/ folder as a looping background bed behind
    // every page. Browsers block autoplay until a gesture, so a kiosk needs
    // Chromium's --autoplay-policy=no-user-gesture-required; on a desktop the
    // first click or key press starts it.
    function setupMusic() {
      fetch("api/music", { cache: "no-store" })
        .then((r) => r.json())
        .then(({ tracks }) => {
          if (!tracks || !tracks.length) return;
          let order = tracks.map((t) => t.url);
          if (cfg.music.shuffle) order = shuffled(order);
          let idx = 0;
          let consecErrors = 0;
          const audio = new Audio();
          musicAudio = audio;
          if (suspended) audio.muted = true; // born while another channel shows
          audio.volume = musicVolume();
          audio.preload = "auto";
          function playNext() {
            if (idx >= order.length) {
              idx = 0;
              if (cfg.music.shuffle) order = shuffled(order);
            }
            audio.src = order[idx++];
            audio.play().catch(() => { /* autoplay blocked: a gesture will start it */ });
          }
          let begun = false;
          musicBegin = () => {
            if (begun) return;
            begun = true;
            playNext();
          };
          audio.addEventListener("playing", () => { consecErrors = 0; });
          audio.addEventListener("ended", playNext);
          audio.addEventListener("error", () => {
            // Skip a bad track, but give up if the whole set is failing so we
            // never spin forever.
            consecErrors++;
            if (consecErrors <= order.length) setTimeout(playNext, 400);
          });
          // Born behind a video channel, the bed stays silent AND idle -
          // muting alone would still decode MP3s all week. resume() begins it.
          if (!suspended) musicBegin();
          const kick = () => { audio.play().catch(() => {}); };
          document.addEventListener("click", kick, { once: true });
          document.addEventListener("keydown", kick, { once: true });
        })
        .catch(() => { /* no music endpoint: silence is fine */ });
    }

    // ---------------- pages

    const rrMessages = makeRR();
    const rrFacts = makeRR();
    const rrDadJokes = makeRR();
    const rrCycle = makeRR();
    const headlineRRs = {};
    let rotIndex = -1;
    let pageTimer = null;
    let lastPageAdvance = Date.now();

    function nextCycleColor() {
      const i = rrCycle.next(cfg.colors.pageCycle.length);
      return i < 0 ? "blue" : cfg.colors.pageCycle[i];
    }

    function paintPage(colorName) {
      const bgName = colorName && (PALETTE[colorName] || /^#/.test(colorName)) ? colorName : nextCycleColor();
      el.page.style.background = resolveColor(bgName, "blue", pal);
      // On some tubes white page text smears; crtInkText trades it for ink.
      // Only swap where the pairing was white-on-color, so ink never lands
      // on an ink or otherwise dark background.
      let pageText = textColorFor(bgName, pal);
      if (cfg.crtMode && cfg.crtInkText && pageText === pal.white) pageText = pal.ink;
      el.page.style.color = pageText;
    }

    // Shrink the page content (never the kicker) just enough to fit the page
    // area. A long fact, the weather card on a 480-line screen, or a big
    // textScale would otherwise slide under the crawl. style.css multiplies
    // the page font sizes by --fit.
    function fitPage() {
      const pg = el.page;
      pg.style.setProperty("--fit", "1");
      pg.classList.remove("tight");
      if (pg.scrollHeight <= pg.clientHeight) return;
      // First give up the least important line (sunrise/sunset on the weather
      // card), then shrink whatever is left.
      pg.classList.add("tight");
      let k = 1;
      for (let i = 0; i < 6; i++) {
        const over = pg.scrollHeight - pg.clientHeight;
        if (over <= 0) break;
        k = Math.max(0.5, k * (pg.clientHeight / pg.scrollHeight) * 0.97);
        pg.style.setProperty("--fit", k.toFixed(3));
      }
    }

    function renderTextPage(kicker, text, colorName) {
      el.page.classList.remove("mode-clock", "mode-weather");
      paintPage(colorName);
      el.kicker.textContent = kicker;
      el.body.textContent = text;
      el.body.classList.toggle("big", text.length <= 34);
      fitPage();
    }

    function renderClockPage() {
      el.page.classList.remove("mode-weather");
      el.page.classList.add("mode-clock");
      paintPage(null);
      const now = new Date();
      el.pageTime.textContent = formatClock(now, cfg.timeFormat);
      el.pageDate.textContent = formatLongDate(now);
      fitPage();
    }

    function renderWeatherPage(w) {
      el.page.classList.remove("mode-clock");
      el.page.classList.add("mode-weather");
      paintPage(null);
      el.kicker.textContent = "WEATHER";
      el.wxLocation.textContent = w.name || "";
      el.wxTemp.textContent = (w.tempNow != null ? w.tempNow : "--") + "°" + (w.tempUnit || "");
      el.wxCond.textContent = w.condition || "";
      const hi = w.tempHi != null ? "HI " + w.tempHi + "°" : "";
      const lo = w.tempLo != null ? "LO " + w.tempLo + "°" : "";
      el.wxHilo.textContent = [hi, lo].filter(Boolean).join("   ");
      const sr = formatWxTime(w.sunrise, cfg.timeFormat);
      const ss = formatWxTime(w.sunset, cfg.timeFormat);
      el.wxSun.textContent = sr && ss ? "SUNRISE " + sr + "   SUNSET " + ss : "";
      fitPage();
    }

    function renderSlot(slot) {
      if (slot.type === "clock") {
        renderClockPage();
        return true;
      }
      if (slot.type === "messages") {
        const i = rrMessages.next(store.messages.length);
        if (i < 0) return false;
        const m = store.messages[i];
        renderTextPage("COMMUNITY BULLETIN", m.text, m.color);
        return true;
      }
      if (slot.type === "facts") {
        const i = rrFacts.next(store.facts.length);
        if (i < 0) return false;
        renderTextPage("DID YOU KNOW", store.facts[i], null);
        return true;
      }
      if (slot.type === "dadjokes") {
        const i = rrDadJokes.next(store.dadJokes.length);
        if (i < 0) return false;
        renderTextPage("DAD JOKE", store.dadJokes[i], null);
        return true;
      }
      if (slot.type === "weather") {
        if (!store.weather || store.weather.tempNow == null) return false; // not loaded yet: skip
        renderWeatherPage(store.weather);
        return true;
      }
      if (slot.type === "headlines") {
        const items = store.feeds[slot.feed] || [];
        const rr = headlineRRs[slot.feed] || (headlineRRs[slot.feed] = makeRR());
        const i = rr.next(items.length);
        if (i < 0) return false;
        renderTextPage(labels[slot.feed] || slot.feed.toUpperCase(), items[i], null);
        return true;
      }
      return false;
    }

    function advancePage() {
      for (let tries = 0; tries < cfg.rotation.length; tries++) {
        rotIndex = (rotIndex + 1) % cfg.rotation.length;
        if (renderSlot(cfg.rotation[rotIndex])) {
          stats.pageFlips++;
          lastPageAdvance = Date.now();
          return;
        }
      }
      renderClockPage(); // nothing renderable: the clock always is
      stats.pageFlips++;
      lastPageAdvance = Date.now();
    }

    function startScheduler() {
      clearTimeout(pageTimer);
      const loop = () => {
        if (!suspended) advancePage();
        else lastPageAdvance = Date.now(); // keep the watchdog honest while covered
        pageTimer = setTimeout(loop, cfg.pageSeconds * 1000);
      };
      loop();
    }

    // ---------------- crawl

    let crawlAnim = null;
    let lastCrawlTime = -1;

    function startCrawl() {
      if (suspended) {
        // Another channel is on: stay dark instead of animating behind it.
        // resume() calls safeStartCrawl, so a null anim comes back on air.
        if (crawlAnim) {
          crawlAnim.onfinish = null;
          try { crawlAnim.cancel(); } catch (e) { /* already dead */ }
        }
        crawlAnim = null;
        return;
      }
      if (crawlAnim) {
        crawlAnim.onfinish = null;
        try { crawlAnim.cancel(); } catch (e) { /* already dead */ }
      }
      const cheerText =
        usesCheerlights && store.cheerlights
          ? cheerlightsLine(cfg.cheerlights.template, store.cheerlights.color)
          : "";
      const text = buildCrawlText({
        feedIds: cfg.crawl.feeds,
        labels,
        items: store.feeds,
        separator: cfg.crawl.separator,
        fallback: cfg.channelName + (cfg.tagline ? " " + cfg.crawl.separator + " " + cfg.tagline : ""),
        extras: cheerText ? ["CHEERLIGHTS: " + cheerText] : [],
      });
      el.track.textContent = text;
      // Measure the scrolling window (the space to the right of the fixed
      // flag), not the whole stage, so the ticker clips correctly.
      const winW = el.crawlWindow.clientWidth || el.stage.clientWidth || 640;
      const trackW = el.track.scrollWidth || winW;
      el.track.style.transform = "translateX(" + winW + "px)";
      const duration = Math.max(1000, ((winW + trackW) / winW) * cfg.crawl.secondsPerScreen * 1000);
      crawlAnim = el.track.animate(
        [{ transform: "translateX(" + winW + "px)" }, { transform: "translateX(" + -trackW + "px)" }],
        { duration, easing: "linear" }
      );
      crawlAnim.onfinish = () => {
        stats.crawlCycles++;
        safeStartCrawl(); // rebuild from the latest store: fresh content each pass
      };
    }

    // If starting the crawl ever throws, leave crawlAnim null so the
    // watchdog keeps retrying instead of freezing the band forever.
    function safeStartCrawl() {
      try {
        startCrawl();
      } catch (e) {
        crawlAnim = null;
        console.warn("[cable-82] crawl start failed: " + e.message);
      }
    }

    let resizeTimer = null;
    window.addEventListener("resize", () => {
      clearTimeout(resizeTimer);
      resizeTimer = setTimeout(safeStartCrawl, 250);
    });

    // ---------------- watchdog

    function startWatchdog() {
      setInterval(() => {
        try {
          const now = Date.now();
          if (now - lastPageAdvance > cfg.pageSeconds * 3000 + 5000) {
            stats.schedulerRestarts++;
            startScheduler();
          }
          if (now - lastClockTick > 5000) {
            restartClock();
          }
          // Crawl health: no animation at all (a failed start), a cancelled
          // animation (currentTime pinned at null), or a currentTime that
          // has not moved between two ticks all mean the band is frozen.
          const t = crawlAnim ? crawlAnim.currentTime : null;
          if (!suspended && (!crawlAnim || t === lastCrawlTime)) {
            stats.crawlRestarts++;
            safeStartCrawl();
          }
          lastCrawlTime = crawlAnim ? crawlAnim.currentTime : null;
          const d = new Date();
          if (
            cfg.dailyReloadHour !== false &&
            now - stats.bootAt > 2 * 3600 * 1000 &&
            d.getHours() === cfg.dailyReloadHour
          ) {
            location.reload();
          }
        } catch (e) {
          console.warn("[cable-82] watchdog tick failed: " + e.message);
        }
      }, soak ? 5000 : 60000);
    }

    // ---------------- go

    tickClock();
    cfg.feeds.forEach((f, i) => scheduleFeed(f, 500 + i * 2000)); // staggered first fetch
    if (usesWeather) refreshWeather();
    if (usesCheerlights) refreshCheerlights();
    if (cfg.music.enabled) setupMusic();
    startScheduler();
    document.fonts.ready.then(safeStartCrawl).catch(safeStartCrawl); // measure with the real font
    startWatchdog();
    startConfigWatch(bootVersion, soak);

    if (soak) {
      setInterval(() => console.log("[soak] " + JSON.stringify(statsSnapshot())), 10000);
    }

    return {
      suspend() {
        if (suspended) return;
        suspended = true;
        if (crawlAnim) { try { crawlAnim.pause(); } catch (e) { /* already dead */ } }
        if (musicAudio) { musicAudio.muted = true; try { musicAudio.pause(); } catch (e) { /* fine */ } }
      },
      resume() {
        if (!suspended) return;
        suspended = false;
        if (crawlAnim) {
          try { crawlAnim.play(); } catch (e) { safeStartCrawl(); }
        } else {
          safeStartCrawl();
        }
        if (musicAudio && cfg.music.enabled) {
          musicAudio.muted = false;
          if (musicBegin) musicBegin();
          musicAudio.play().catch(() => { /* a gesture will start it */ });
        }
        advancePage(); // fresh page the moment the board is back
      },
      setSoundLevel(level) {
        soundLevel = level;
        if (musicAudio) musicAudio.volume = musicVolume();
      },
    };
    } // startChannel

    // ------------------------------------------------------------- the tuner
    // index.html IS the tuner. Chromium launches once, pointed here, and
    // never navigates again; a channel change is a DOM operation behind a
    // moment of static. The bulletin board is one renderer among several,
    // suspended (not torn down) when covered because it is also the chrome.
    function startTuner(cfg, bootVersion) {
      const dial = cfg.channels.filter((c) => c.enabled);
      const L = {
        video: document.getElementById("video-layer"),
        card: document.getElementById("card-layer"),
        cardBars: document.getElementById("card-bars"),
        cardClock: document.getElementById("card-clock"),
        cardName: document.getElementById("card-name"),
        cardMsg: document.getElementById("card-msg"),
        external: document.getElementById("external-layer"),
        snow: document.getElementById("tuner-snow"),
        bug: document.getElementById("channel-bug"),
        blank: document.getElementById("tuner-blank"),
        power: document.getElementById("power-off"),
        bugNumber: document.getElementById("bug-number"),
        bugName: document.getElementById("bug-name"),
      };

      // The set's own state: the volume key's step and whether the picture
      // is on. Both survive a page reload (a config save, the daily reload)
      // and reset when the box is power-cycled, like a TV with a memory.
      let volumeStep = Number(sessionStorage.getItem("cable82.tuner.volume"));
      if (!Number.isInteger(volumeStep) || volumeStep < 0 || volumeStep >= VOLUME_STEPS.length) volumeStep = 0;
      let powered = sessionStorage.getItem("cable82.tuner.power") !== "off";
      const soundLevel = () => VOLUME_STEPS[volumeStep].level;

      // The board always boots: it is the home channel and it owns the
      // header, crawl, feeds and music. Other channels cover it, suspended.
      const bulletin = startChannel(cfg, bootVersion);

      // ---------------- static (shared by transitions and off-air snow)
      // and the blank raster, for the cable boxes that went black instead.
      const sctx = L.snow.getContext("2d");
      let snowLoop = null;
      let snowHold = 0;
      function snowShow() {
        snowHold++;
        L.snow.hidden = false;
        if (!snowLoop) {
          const img = sctx.createImageData(L.snow.width, L.snow.height);
          snowLoop = setInterval(() => {
            const d = img.data;
            for (let i = 0; i < d.length; i += 4) {
              const v = (Math.random() * 255) | 0;
              d[i] = d[i + 1] = d[i + 2] = v;
              d[i + 3] = 255;
            }
            sctx.putImageData(img, 0, 0);
          }, 80);
        }
      }
      function snowHide() {
        snowHold = Math.max(0, snowHold - 1);
        if (!snowHold) {
          clearInterval(snowLoop);
          snowLoop = null;
          L.snow.hidden = true;
        }
      }
      function blankShow() { L.blank.hidden = false; }
      function blankHide() { L.blank.hidden = true; }

      // What covers the swap, and for how long: ms of cover before the
      // swap, then ms after it so the new channel has its first frame up.
      const CUTS = {
        static: { show: snowShow, hide: snowHide, before: 220, after: 120 },
        black: { show: blankShow, hide: blankHide, before: 300, after: 200 },
        none: { show: () => {}, hide: () => {}, before: 0, after: 0 },
      };

      // ---------------- the channel bug
      function notice(bigText, smallText) {
        L.bugNumber.textContent = bigText;
        L.bugName.textContent = smallText || "";
        L.bug.hidden = false;
        L.bug.classList.remove("fading");
        clearTimeout(notice._t);
        notice._t = setTimeout(() => L.bug.classList.add("fading"), 2600);
      }
      const banner = (numberText, nameText) => notice("CH " + numberText, nameText);

      // ---------------- off-air card
      let cardTimer = null;
      function cardStart(channel, state, mode) {
        if (!L.cardBars.childElementCount) {
          for (const c of ["#c0c0c0", "#c0c000", "#00c0c0", "#00c000", "#c000c0", "#c00000", "#0000c0"]) {
            const bar = document.createElement("i");
            bar.style.background = c;
            L.cardBars.appendChild(bar);
          }
        }
        const testcard = mode !== "bars";
        L.cardClock.hidden = !testcard;
        L.cardName.hidden = !testcard;
        L.cardMsg.hidden = !testcard;
        if (testcard) {
          L.cardName.textContent = "CH " + channel.number + "  " + channel.name;
          L.cardMsg.textContent = (state && state.resumeText) || "";
          const tick = () => {
            L.cardClock.textContent = formatClock(new Date(), cfg.timeFormat);
          };
          tick();
          cardTimer = setInterval(tick, 1000);
        }
        L.card.hidden = false;
      }
      function cardStop() {
        clearInterval(cardTimer);
        cardTimer = null;
        L.card.hidden = true;
      }

      // ---------------- video renderer
      const EPOCH = Date.UTC(2026, 0, 1); // arbitrary fixed origin for the loop
      // Two <video> buffers inside the layer: `vid` is on the air, `standby`
      // cues the next program while the current one plays, so a boundary is
      // a cut - the way a station does it - not a load.
      const videoLayer = L.video;
      const vidBufs = videoLayer.querySelectorAll("video");
      let vid = vidBufs[0];
      let standby = vidBufs[1];
      let playlists = {}; // channel number -> files [{file, url, duration}]
      let vidChannel = null;
      let vidStops = [];
      let currentUrl = "";
      let degIndex = -1; // sequential fallback while durations are unknown

      async function fetchChannels() {
        const r = await fetch("api/channels", { cache: "no-store", signal: AbortSignal.timeout(10000) });
        if (!r.ok) throw new Error("HTTP " + r.status);
        const j = await r.json();
        playlists = {};
        for (const c of j.channels || []) playlists[c.number] = c.files || [];
        return playlists;
      }

      function orderedPlaylist(channel, files) {
        if (channel.order === "shuffle-daily") {
          const d = new Date();
          const seed = d.getFullYear() + "-" + (d.getMonth() + 1) + "-" + d.getDate() + "#" + channel.number;
          return seededShuffle(files, seed);
        }
        return files; // the server already natural-sorts
      }

      // Learn missing durations from <video> metadata, one file at a time,
      // and post the batch back so the server's cache fills itself. The clock
      // can only run when every duration is known; until then playback is
      // honest sequential.
      async function probeMissing(channel, files) {
        const missing = files.filter((f) => f.duration == null);
        if (!missing.length) return false;
        const learned = {};
        for (const f of missing) {
          if (vidChannel !== channel) break; // tuned away: stop politely
          const d = await new Promise((resolve) => {
            const probe = document.createElement("video");
            const bail = setTimeout(() => {
              // A hung file must not stall the pass; the clock just waits
              // for this duration until a later probe learns it.
              probe.src = "";
              resolve(null);
            }, 15000);
            probe.preload = "metadata";
            probe.onloadedmetadata = () => { clearTimeout(bail); resolve(probe.duration); };
            probe.onerror = () => { clearTimeout(bail); resolve(null); };
            probe.src = f.url;
          });
          if (Number.isFinite(d) && d > 0) {
            f.duration = d;
            learned[f.file] = d;
          }
        }
        if (Object.keys(learned).length) {
          fetch("api/channels/durations", {
            method: "POST",
            headers: { "content-type": "application/json", "x-cable82-config": "1" },
            body: JSON.stringify({ folder: channel.folder, durations: learned }),
          }).catch(() => { /* cache miss next boot; the probe will run again */ });
        }
        return true;
      }

      function preloadNext(pl, index) {
        if (!pl.length) return;
        const next = pl[(index + 1) % pl.length];
        if (standby.getAttribute("src") !== next.url) {
          standby.preload = "auto";
          standby.src = next.url;
          standby.load();
        }
      }

      function swapBuffers() {
        const old = vid;
        vid = standby;
        standby = old;
        try { standby.pause(); } catch (e) { /* fine */ }
        standby.muted = true;
        standby.hidden = true;
        vid.muted = false;
        vid.volume = soundLevel();
        vid.hidden = false;
      }

      function videoDrive(channel, files) {
        if (vidChannel !== channel) return;
        const pl = orderedPlaylist(channel, files);
        const pos = positionAt(pl, Date.now(), EPOCH);
        let targetIndex;
        let targetOffset = null;
        if (pos) {
          targetIndex = pos.index;
          targetOffset = pos.offset;
        } else if (currentUrl && !vid.ended && !vid.error) {
          targetIndex = pl.findIndex((f) => f.url === currentUrl); // degraded: let it play out
        } else {
          degIndex = (degIndex + 1) % pl.length;
          targetIndex = degIndex;
        }
        if (targetIndex < 0 || targetIndex >= pl.length) targetIndex = 0;
        const targetUrl = pl[targetIndex].url;
        if (currentUrl !== targetUrl) {
          currentUrl = targetUrl;
          if (standby.getAttribute("src") === targetUrl && standby.readyState >= 2) {
            swapBuffers(); // the next program is already cued: cut, don't load
          } else {
            vid.src = targetUrl;
            vid.load();
          }
        }
        const v = vid; // the deferred seek must land on this buffer, not a later swap's
        const seek = () => {
          if (targetOffset != null && Math.abs(v.currentTime - targetOffset) > 1.5) {
            v.currentTime = targetOffset;
          }
          v.play().catch(() => { /* kiosk runs with autoplay allowed */ });
        };
        if (v.readyState >= 1) seek();
        else v.addEventListener("loadedmetadata", seek, { once: true });
        preloadNext(pl, targetIndex);
      }

      async function videoStart(channel) {
        vidChannel = channel;
        currentUrl = "";
        degIndex = -1;
        vid.muted = false;
        vid.volume = soundLevel();
        vid.hidden = false;
        standby.muted = true;
        standby.hidden = true;
        standby.removeAttribute("src");
        videoLayer.hidden = false;
        // The folder is the truth and it changes (episodes added over the
        // share, a file deleted mid-week), so every tune re-reads it. The
        // cached list only covers a blip while the server restarts.
        const readFolder = async () => (await fetchChannels())[channel.number] || null;
        let files = null;
        try {
          files = await readFolder();
        } catch (e) {
          files = playlists[channel.number] || null;
        }
        if (vidChannel !== channel) return; // tuned away while fetching
        if (!files || !files.length) {
          videoLayer.hidden = true;
          cardStart(channel, { resumeText: "NO PROGRAMMING AVAILABLE" }, "testcard");
          vidStops.push(cardStop);
          // A server blip at tune time must not kill the channel until the
          // daily reload: keep asking, and go on air when the folder answers.
          const retry = setInterval(async () => {
            let again = null;
            try {
              again = await readFolder();
            } catch (e) { /* still down */ }
            if (vidChannel !== channel || !again || !again.length) return;
            clearInterval(retry);
            cardStop();
            videoLayer.hidden = false;
            files = again;
            wire();
          }, 30000);
          vidStops.push(() => clearInterval(retry));
          return;
        }
        wire();

        function wire() {
          const onEnded = (e) => {
            if (e.target !== vid) return; // only the on-air buffer airs an ending
            // A file can play shorter than its cached duration says. What
            // just ended is ground truth: correct the cache so the clock
            // converges instead of freeze-looping a phantom tail.
            const f = files.find((x) => x.url === currentUrl);
            const actual = vid.currentTime;
            if (f && Number.isFinite(actual) && actual > 1 && f.duration != null && Math.abs(f.duration - actual) > 0.5) {
              f.duration = actual;
              fetch("api/channels/durations", {
                method: "POST",
                headers: { "content-type": "application/json", "x-cable82-config": "1" },
                body: JSON.stringify({ folder: channel.folder, durations: { [f.file]: actual } }),
              }).catch(() => { /* corrected next boot instead */ });
            }
            // Roll straight into the next program - the cued standby makes
            // this a cut. Small clock disagreements settle at the next
            // resync (1.5s drift tolerance) and vanish once durations are true.
            const pl = orderedPlaylist(channel, files);
            let i = pl.findIndex((x) => x.url === currentUrl);
            if (i < 0) i = 0;
            degIndex = (i + 1) % pl.length; // keep the degraded counter in step
            const next = pl[degIndex];
            currentUrl = next.url;
            if (standby.getAttribute("src") === next.url && standby.readyState >= 2) {
              swapBuffers();
            } else {
              vid.src = next.url;
              vid.load();
            }
            vid.play().catch(() => { /* kiosk allows autoplay */ });
            preloadNext(pl, degIndex);
          };
          const onError = (e) => {
            if (e.target === standby) {
              // A cue-up failed: forget it and leave the air alone; the
              // boundary just cold-loads like before.
              standby.removeAttribute("src");
              return;
            }
            // A bad file must not freeze the channel - and it may be gone,
            // not just bad, so re-read the folder before driving on. That
            // heals a delete instead of looping on a dead URL.
            setTimeout(async () => {
              if (vidChannel !== channel) return;
              try {
                const fresh = await readFolder();
                if (fresh && fresh.length) files = fresh;
              } catch (e2) { /* keep the list we have */ }
              if (vidChannel !== channel) return;
              currentUrl = "";
              videoDrive(channel, files);
            }, 1500);
          };
          for (const b of vidBufs) {
            b.addEventListener("ended", onEnded);
            b.addEventListener("error", onError);
          }
          // The end of a program is not taken on trust. The Pi's kiosk
          // Chromium holds the last frame of a commercial and never delivers
          // `ended`, so nothing rolled until the next resync - a dead screen
          // for up to 30 s, long enough to swallow a 15 s spot whole. This
          // watch sees the end for itself: a buffer sitting in the ended
          // state, or a clock stopped inside the last second of the file, is
          // the ending; a clock stopped anywhere else (IO stall, decoder
          // wedge) is a reason to drop the source and let videoDrive reload
          // it at the broadcast clock.
          let watchT = -1;
          let watchSince = 0;
          const endWatch = setInterval(() => {
            if (vid.hidden || vid.error || !currentUrl) {
              watchT = -1;
              return;
            }
            if (vid.ended) {
              onEnded({ target: vid });
              return;
            }
            const t = vid.currentTime;
            const now = Date.now();
            if (t !== watchT) {
              watchT = t;
              watchSince = now;
              return;
            }
            const stalled = now - watchSince;
            const d = vid.duration;
            if (Number.isFinite(d) && d > 0 && t >= d - 1 && stalled >= 300) {
              onEnded({ target: vid });
            } else if (stalled >= 4000) {
              currentUrl = "";
              videoDrive(channel, files);
            }
          }, 250);
          const resync = setInterval(() => videoDrive(channel, files), 30000);
          vidStops.push(() => {
            for (const b of vidBufs) {
              b.removeEventListener("ended", onEnded);
              b.removeEventListener("error", onError);
            }
            clearInterval(endWatch);
            clearInterval(resync);
          });
          videoDrive(channel, files);
          probeMissing(channel, files).then((probed) => {
            if (probed && vidChannel === channel) videoDrive(channel, files);
          });
        }
      }

      function videoStop() {
        vidChannel = null;
        for (const s of vidStops.splice(0)) {
          try { s(); } catch (e) { /* keep stopping */ }
        }
        for (const b of vidBufs) {
          try { b.pause(); } catch (e) { /* fine */ }
          b.muted = true;
          b.removeAttribute("src");
        }
        videoLayer.hidden = true;
        currentUrl = "";
      }

      // ---------------- the router
      let dialIndex = 0;
      let tuning = false;
      let activeStops = [];

      const remembered = Number(sessionStorage.getItem("cable82.tuner.channel"));
      const ri = dial.findIndex((c) => c.number === remembered);
      if (ri >= 0) dialIndex = ri;

      // Start one channel's view. Non-bulletin views cover the suspended
      // board; bulletin views wake it. Returns the stop functions for leaving.
      function startChannelView(channel) {
        const stops = [];
        if (channel.type === "bulletin") {
          bulletin.resume();
          return stops;
        }
        bulletin.suspend();
        if (channel.type === "external") {
          const iframe = document.createElement("iframe");
          // The sandbox keeps a framed page (ws4kp, anything) from
          // navigating top - this page must never navigate.
          iframe.setAttribute("sandbox", "allow-scripts allow-same-origin");
          iframe.src = channel.url;
          L.external.appendChild(iframe);
          L.external.hidden = false;
          stops.push(() => {
            L.external.hidden = true;
            L.external.textContent = "";
          });
          return stops;
        }
        // video: the tuner owns air state; the renderer just plays.
        const state = airState(channel, new Date());
        if (state.untilMs) {
          const delay = Math.min(Math.max(state.untilMs - Date.now(), 1000) + 500, 2147000000);
          const boundary = setTimeout(() => {
            if (dial[dialIndex] === channel) tuneToIndex(dialIndex, { force: true });
          }, delay);
          stops.push(() => clearTimeout(boundary));
        }
        if (state.onAir) {
          videoStart(channel);
          stops.push(videoStop);
        } else if (channel.offAir === "bulletin") {
          bulletin.resume(); // what a real local system did overnight
        } else if (channel.offAir === "snow") {
          snowShow();
          stops.push(snowHide);
        } else {
          cardStart(channel, state, channel.offAir);
          stops.push(cardStop);
        }
        return stops;
      }

      function applyChannel(i) {
        for (const s of activeStops.splice(0)) {
          try { s(); } catch (e) { /* keep stopping */ }
        }
        dialIndex = i;
        try { sessionStorage.setItem("cable82.tuner.channel", String(dial[i].number)); } catch (e) { /* fine */ }
        activeStops = startChannelView(dial[i]);
      }

      function tuneToIndex(i, opts) {
        if (!powered || tuning || i < 0 || i >= dial.length) return;
        if (i === dialIndex && !(opts && opts.force)) {
          banner(dial[i].number, dial[i].name);
          return;
        }
        tuning = true;
        const cut = CUTS[cfg.tuner.cut] || CUTS.static;
        cut.show(); // the cover stays up across the whole swap
        setTimeout(() => {
          // A throw in the swap must never strand the tuner: cover down and
          // tuning cleared no matter what, or no key would ever work again.
          try {
            if (powered) {
              applyChannel(i);
              banner(dial[i].number, dial[i].name);
            }
          } finally {
            setTimeout(() => {
              cut.hide();
              tuning = false;
            }, cut.after);
          }
        }, cut.before);
      }

      const step = (dir) => tuneToIndex(nextChannelIndex(dial, dialIndex, dir, cfg.tuner.wrap));
      function setNumber(n) {
        if (!powered) return;
        const i = dial.findIndex((c) => c.number === n);
        if (i >= 0) tuneToIndex(i);
        else banner(n, "NO SUCH CHANNEL");
      }

      // The volume key: one step around VOLUME_STEPS, applied to whatever is
      // making sound (the program on the air, the board's music bed).
      function applySound() {
        for (const b of vidBufs) b.volume = soundLevel();
        bulletin.setSoundLevel(soundLevel());
      }
      function volumeKey() {
        if (!powered) return;
        volumeStep = nextVolumeStep(volumeStep);
        try { sessionStorage.setItem("cable82.tuner.volume", String(volumeStep)); } catch (e) { /* fine */ }
        applySound();
        notice("VOLUME", VOLUME_STEPS[volumeStep].name);
      }

      // The power key. Off is a dark screen and silence: the channel's view
      // is stopped (the board suspended, video unloaded) and a dark layer
      // covers the stage. The broadcast clock keeps running underneath, so
      // on resumes the channel wherever it is now, the way a TV comes back
      // to a program already in progress. The dial is not touched; the set
      // remembers its channel. Every other key is dead while it is off.
      function powerKey() {
        if (powered) {
          powered = false;
          for (const s of activeStops.splice(0)) {
            try { s(); } catch (e) { /* keep stopping */ }
          }
          bulletin.suspend(); // the board has no stop of its own: it is the floor
          clearTimeout(notice._t);
          L.bug.hidden = true;
          L.power.hidden = false;
        } else {
          powered = true;
          L.power.hidden = true;
          applyChannel(dialIndex);
          banner(dial[dialIndex].number, dial[dialIndex].name);
        }
        try { sessionStorage.setItem("cable82.tuner.power", powered ? "on" : "off"); } catch (e) { /* fine */ }
      }

      // ---------------- tuner sources (events, not state)
      // Digit entry like a real cable box: type the number, brief pause tunes.
      let digits = "";
      let digitTimer = null;
      function pushDigit(d) {
        if (!powered) return;
        digits = (digits + d).slice(0, 3);
        banner(digits, "");
        clearTimeout(digitTimer);
        if (digits.length >= 3) commitDigits();
        else digitTimer = setTimeout(commitDigits, 1200);
      }
      function commitDigits() {
        clearTimeout(digitTimer);
        const n = Number(digits);
        digits = "";
        if (Number.isFinite(n) && n > 0) setNumber(n);
      }

      if (cfg.tuner.sources.keyboard) {
        window.addEventListener("keydown", (e) => {
          if (e.key === "ArrowUp" || e.key === "PageUp") step(+1);
          else if (e.key === "ArrowDown" || e.key === "PageDown") step(-1);
          else if (/^\d$/.test(e.key)) pushDigit(e.key);
          else if (e.key === "Enter" && digits) commitDigits();
        });
      }

      if (cfg.tuner.sources.gamepad && navigator.getGamepads) {
        // D-pad up/down steps the dial; Select jumps home to the board.
        // The Gamepad API only reports after a button press, which is
        // itself the gesture. Edge state is per pad: a second idle pad
        // sharing one state object would clear it every frame and turn a
        // held button into a 60Hz repeat.
        const was = {};
        const homeIndex = () => {
          const i = dial.findIndex((c) => c.type === "bulletin");
          return i >= 0 ? i : 0;
        };
        (function pollPad() {
          for (const p of navigator.getGamepads()) {
            if (!p) continue;
            const w = was[p.index] || (was[p.index] = { up: false, dn: false, sel: false });
            const up = (p.buttons[12] && p.buttons[12].pressed) || p.axes[1] < -0.5;
            const dn = (p.buttons[13] && p.buttons[13].pressed) || p.axes[1] > 0.5;
            const sel = !!(p.buttons[8] && p.buttons[8].pressed);
            if (up && !w.up) step(+1);
            if (dn && !w.dn) step(-1);
            if (sel && !w.sel) tuneToIndex(homeIndex());
            w.up = up; w.dn = dn; w.sel = sel;
          }
          requestAnimationFrame(pollPad);
        })();
      }

      // The server's tuner bus over SSE. Each event carries a sequence number
      // and is applied exactly once; the server never asserts a current
      // channel, so a remote source can never fight a local one.
      let lastSeq = 0;
      let bootBuild = null;
      try {
        const es = new EventSource("api/events");
        es.addEventListener("hello", (ev) => {
          let hello;
          try { hello = JSON.parse(ev.data); } catch (e) { return; }
          lastSeq = hello.seq || 0;
          // The first hello names the build this page came from. The browser
          // reconnects on its own after a server restart, and a hello naming a
          // different build means the files changed under us (git pull +
          // restart): reload onto them. The clock puts the program back.
          if (!hello.build) return;
          if (bootBuild == null) bootBuild = hello.build;
          else if (hello.build !== bootBuild) location.reload();
        });
        es.addEventListener("tune", (ev) => {
          let evt;
          try { evt = JSON.parse(ev.data); } catch (e) { return; }
          if (!evt || !(evt.seq > lastSeq)) return;
          lastSeq = evt.seq;
          if (evt.cmd === "up") step(+1);
          else if (evt.cmd === "down") step(-1);
          else if (evt.cmd === "set") setNumber(evt.channel);
          else if (evt.cmd === "volume") volumeKey();
          else if (evt.cmd === "power") powerKey();
        });
        es.addEventListener("config", () => location.reload());
      } catch (e) {
        /* no EventSource: the config poll still covers reloads */
      }

      // ---------------- sign on
      applySound();
      if (powered) {
        applyChannel(dialIndex);
        if (dial.length > 1) banner(dial[dialIndex].number, dial[dialIndex].name);
      } else {
        bulletin.suspend(); // switched off before the reload: stay dark and silent
        L.power.hidden = false;
      }
    } // startTuner
  });

  // Load the runtime config: the server's config.json via /api/config, with
  // a global (back-compat) and the bundled defaults as offline fallbacks.
  async function loadRuntimeConfig() {
    try {
      const r = await fetch("api/config", { cache: "no-store" });
      if (r.ok) {
        const j = await r.json();
        return { raw: j.config, version: j.version };
      }
    } catch (e) {
      /* endpoint unreachable (static hosting / server down): fall through */
    }
    if (typeof window !== "undefined" && window.CABLE82) return { raw: window.CABLE82, version: null };
    return { raw: S.DEFAULT_CONFIG || null, version: null };
  }

  // Poll the config version token; when a control-room save moves it, reload
  // so the change goes live without anyone touching the kiosk.
  function startConfigWatch(bootVersion, soak) {
    if (bootVersion == null) return; // no server version to compare against
    setInterval(async () => {
      try {
        const r = await fetch("api/config", { cache: "no-store" });
        if (!r.ok) return;
        const j = await r.json();
        if (j.version && j.version !== bootVersion) location.reload();
      } catch (e) {
        /* offline: check again next tick */
      }
    }, soak ? 4000 : 20000);
  }
})();
