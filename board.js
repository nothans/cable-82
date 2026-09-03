/* CABLE 82 channel 82: the Community Bulletin Board.
   The board is one renderer among several on the dial, but it is also the
   chrome: the header band, the crawl, the feeds, and the music bed belong to
   it. The tuner creates it once, and covers it (suspended, never torn down)
   while another channel is showing. Loads as window.Cable82Board. */
(() => {
  "use strict";

  const S = window.Cable82Schema;
  const Dial = window.Cable82Dial;
  const { PALETTE, PALETTE_CRT, resolveColor, textColorFor, sanitize } = S;
  const { formatClock, formatHeaderDate, formatLongDate } = Dial;

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

  // ---------------------------------------------------------- pure helpers

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

  // ---------------------------------------------------------- stats (soak)

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

  // ---------------------------------------------------------- the board

  // create(cfg, { soak }) paints the chrome at once and returns a handle:
  //   boot()            start the loops (feeds, pages, crawl, music, watchdog);
  //                     idempotent, and resume() calls it if nobody has
  //   suspend()/resume() cover and uncover the board
  //   setSoundLevel(l)  the tuner's volume key, 0..1
  // Suspension is the deal with the tuner: when another channel covers the
  // board, the expensive work (page renders, the crawl animation, music)
  // stops. Timers keep ticking cheaply and feeds keep refreshing quietly, so
  // coming home is instant and the content is current. A board that is not
  // on the dial at all is never booted, and never polls a thing.
  function create(cfg, opts) {
    const soak = !!(opts && opts.soak);
    if (soak) {
      cfg.pageSeconds = 0.2;
      cfg.refreshMinutes = 5 / 60; // 5 seconds
    }

    const el = {
      stage: document.getElementById("stage"),
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
    };
    const stage = el.stage;

    let booted = false;
    let suspended = false;
    let musicAudio = null;
    let musicBegin = null; // starts playback; a no-op after the first call
    let soundLevel = 1; // the tuner's volume key, 0..1, over the configured music volume
    const musicVolume = () => Math.min(1, Math.max(0, cfg.music.volume / 100)) * soundLevel;

    // ---------------- static chrome
    // The stage palette (--c-*) is the tuner's; the board paints its own
    // bands off it. CRT mode pins the crawl to a dark blue band with light
    // text no matter what the config says. Dark blue, not neutral ink: on a
    // real tube any chroma bleed from the red flag lands on a neutral band
    // as a green cast, while on a blue band it just reads as more blue.
    // 1982 knew this too.
    const pal = cfg.crtMode ? PALETTE_CRT : PALETTE;
    const crawlBg = cfg.crtMode ? "#182858" : cfg.colors.crawlBg;
    stage.style.setProperty("--header-bg", resolveColor(cfg.colors.headerBg, "blue", pal));
    stage.style.setProperty("--crawl-bg", resolveColor(crawlBg, "ink", pal));
    el.header.style.color = textColorFor(cfg.colors.headerBg, pal);
    el.crawlBand.style.color = textColorFor(crawlBg, pal);
    // The station bug inverts against the header band.
    stage.style.setProperty("--bug-bg", textColorFor(cfg.colors.headerBg, pal));
    stage.style.setProperty("--bug-fg", resolveColor(cfg.colors.headerBg, "blue", pal));
    el.chName.textContent = cfg.channelName;
    el.chTagline.textContent = cfg.tagline;
    el.crawlFlag.textContent = cfg.crawl.flag;

    // Facts and dad jokes travel in the config itself; fall back to the
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
    async function refreshWeather() {
      try {
        const r = await fetch("api/weather", { cache: "no-store", signal: AbortSignal.timeout(12000) });
        if (r.ok) store.weather = await r.json();
      } catch (e) {
        /* keep the last good weather; try again next tick */
      }
      setTimeout(refreshWeather, soak ? 5000 : 15 * 60000);
    }

    // ---------------- cheerlights

    // One global color the whole internet shares (cheerlights.com). It rides
    // the crawl, so poll only when enabled. Colors change on people's whims:
    // once a minute keeps the ticker honest without hammering anything.
    const usesCheerlights = cfg.cheerlights && cfg.cheerlights.enabled;
    async function refreshCheerlights() {
      try {
        const r = await fetch("api/cheerlights", { cache: "no-store", signal: AbortSignal.timeout(12000) });
        if (r.ok) store.cheerlights = await r.json();
      } catch (e) {
        /* keep the last color; try again next tick */
      }
      setTimeout(refreshCheerlights, soak ? 5000 : 60000);
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
      const fits = () => pg.scrollHeight <= pg.clientHeight;
      let k = 1;
      const shrinkTo = (floor) => {
        for (let i = 0; i < 6 && !fits(); i++) {
          k = Math.max(floor, k * (pg.clientHeight / pg.scrollHeight) * 0.97);
          pg.style.setProperty("--fit", k.toFixed(3));
        }
      };
      pg.style.setProperty("--fit", "1");
      pg.classList.remove("tight");
      if (fits()) return;
      // Shrink a little first. Only if that is not enough does the least
      // important line go (sunrise/sunset on the weather card), and then
      // whatever is left shrinks as far as it must.
      shrinkTo(0.85);
      if (fits()) return;
      pg.classList.add("tight");
      shrinkTo(0.5);
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
      // High, low, and the wind in the unit the control room picked, on one
      // line, so the card stays the height it was and the sun line keeps its
      // place on a 480-line screen.
      const hi = w.tempHi != null ? "HI " + w.tempHi + "°" : "";
      const lo = w.tempLo != null ? "LO " + w.tempLo + "°" : "";
      const wind = w.wind != null ? "WIND " + w.wind + " " + (w.windUnit || "") : "";
      el.wxHilo.textContent = [hi, lo, wind].filter(Boolean).join("   ");
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
      if (crawlAnim) {
        crawlAnim.onfinish = null;
        try { crawlAnim.cancel(); } catch (e) { /* already dead */ }
        crawlAnim = null;
      }
      // Another channel is on: stay dark instead of animating behind it.
      // resume() calls safeStartCrawl, so a null anim comes back on air.
      if (suspended) return;
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
      const winW = el.crawlWindow.clientWidth || stage.clientWidth || 640;
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

    // ---------------- watchdog

    // The board's own health: the page scheduler, the clock, and the crawl
    // each get restarted if they stop. The kiosk-level reload lives in
    // app.js, since it is about the browser, not the board.
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
        } catch (e) {
          console.warn("[cable-82] watchdog tick failed: " + e.message);
        }
      }, soak ? 5000 : 60000);
    }

    // ---------------- boot

    let resizeTimer = null;
    function boot() {
      if (booted) return;
      booted = true;
      tickClock();
      cfg.feeds.forEach((f, i) => scheduleFeed(f, 500 + i * 2000)); // staggered first fetch
      if (usesWeather) refreshWeather();
      if (usesCheerlights) refreshCheerlights();
      if (cfg.music.enabled) setupMusic();
      startScheduler();
      document.fonts.ready.then(safeStartCrawl).catch(safeStartCrawl); // measure with the real font
      startWatchdog();
      window.addEventListener("resize", () => {
        clearTimeout(resizeTimer);
        resizeTimer = setTimeout(safeStartCrawl, 250);
      });
    }

    return {
      boot,
      suspend() {
        if (suspended) return;
        suspended = true;
        if (!booted) return;
        if (crawlAnim) { try { crawlAnim.pause(); } catch (e) { /* already dead */ } }
        if (musicAudio) { musicAudio.muted = true; try { musicAudio.pause(); } catch (e) { /* fine */ } }
      },
      resume() {
        if (!booted) {
          suspended = false;
          boot(); // first time on the air: everything starts uncovered
          return;
        }
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
  }

  window.Cable82Board = {
    create,
    stats: statsSnapshot,
    helpers: { parseFeed, shuffled, makeRR, buildCrawlText, formatWxTime, cheerlightsLine },
  };
})();
