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
      startChannel(cfg, version);
    });

    function startChannel(cfg, bootVersion) {
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
          audio.volume = Math.min(1, Math.max(0, cfg.music.volume / 100));
          audio.preload = "auto";
          function playNext() {
            if (idx >= order.length) {
              idx = 0;
              if (cfg.music.shuffle) order = shuffled(order);
            }
            audio.src = order[idx++];
            audio.play().catch(() => { /* autoplay blocked: a gesture will start it */ });
          }
          audio.addEventListener("playing", () => { consecErrors = 0; });
          audio.addEventListener("ended", playNext);
          audio.addEventListener("error", () => {
            // Skip a bad track, but give up if the whole set is failing so we
            // never spin forever.
            consecErrors++;
            if (consecErrors <= order.length) setTimeout(playNext, 400);
          });
          playNext();
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
        advancePage();
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
          if (!crawlAnim || t === lastCrawlTime) {
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
    } // startChannel
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
