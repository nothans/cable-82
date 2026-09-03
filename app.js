/* CABLE 82 display: boot.
   Loads the config, paints the stage, starts the tuner, and keeps the kiosk
   healthy: the tuner bus (server-sent events) that carries channel changes,
   config saves, and new builds, and the daily reload. Everything else lives
   in the file named for it: config-schema.js (validation), dial.js (the
   broadcast clock), board.js (channel 82), guide.js (channel 0), video.js
   (the player), tuner.js (the dial). No dependencies, no build step.
   The pure helpers are gathered on window.Cable82 for test/harness.html;
   the app only boots when the page has a #stage element. */
(() => {
  "use strict";

  const S = window.Cable82Schema;
  const Dial = window.Cable82Dial;
  const Board = window.Cable82Board;

  window.Cable82 = Object.assign(
    {
      PALETTE: S.PALETTE,
      PALETTE_CRT: S.PALETTE_CRT,
      clampNum: S.clampNum,
      resolveColor: S.resolveColor,
      textColorFor: S.textColorFor,
      sanitize: S.sanitize,
      naturalCompare: S.naturalCompare,
      validateConfig: S.validateConfig,
      stats: Board.stats,
    },
    Dial,
    Board.helpers
  );

  // The stage palette. One source, the schema; style.css reads --c-<name>
  // and never carries a copy of the hex values. CRT mode swaps the whole
  // set, and style.css drops the drop shadow off the class.
  function paintStage(stage, cfg) {
    const pal = cfg && cfg.crtMode ? S.PALETTE_CRT : S.PALETTE;
    for (const name of Object.keys(pal)) stage.style.setProperty("--c-" + name, pal[name]);
    if (!cfg) return;
    stage.classList.toggle("crt", cfg.crtMode);
    stage.style.setProperty("--ts", String(cfg.textScale));
    stage.style.setProperty("--ovpx", String(cfg.overscanX));
    stage.style.setProperty("--ovpy", String(cfg.overscanY));
  }

  // Load the runtime config: the server's config.json via /api/config, with
  // the bundled defaults as the offline fallback (static hosting, a server
  // that is down). A server that answers but cannot read its config.json
  // says so, and that is not a case for the defaults: the person who broke
  // the file needs to be told, not shown a factory board.
  async function loadRuntimeConfig() {
    try {
      const r = await fetch("api/config", { cache: "no-store" });
      const j = await r.json().catch(() => null);
      if (r.ok && j && j.config) return { raw: j.config, version: j.version };
      if (j && j.error) return { error: j.error };
    } catch (e) {
      /* endpoint unreachable: fall through */
    }
    return { raw: S.DEFAULT_CONFIG, version: null };
  }

  // The tuner bus over server-sent events. Each tune event carries a
  // sequence number and is applied exactly once; the server never asserts
  // a current channel, so a remote source can never fight a local one. The
  // hello names the build and the config version the server is serving:
  // the browser reconnects on its own after a restart, and a hello that
  // names a different build (git pull) or config (a hand edit while the
  // stream was down) means this page is stale, so it reloads. The clock
  // puts the program back. A save while connected arrives as `config`.
  function startBus(tuner, bootVersion) {
    let lastSeq = 0;
    let bootBuild = null;
    let es;
    try {
      es = new EventSource("api/events");
    } catch (e) {
      return; // no EventSource: a static host, nothing to listen to
    }
    es.addEventListener("hello", (ev) => {
      let hello;
      try { hello = JSON.parse(ev.data); } catch (e) { return; }
      lastSeq = hello.seq || 0;
      if (hello.build) {
        if (bootBuild == null) bootBuild = hello.build;
        else if (hello.build !== bootBuild) location.reload();
      }
      if (bootVersion != null && hello.config && hello.config !== bootVersion) location.reload();
    });
    es.addEventListener("tune", (ev) => {
      let evt;
      try { evt = JSON.parse(ev.data); } catch (e) { return; }
      if (!evt || !(evt.seq > lastSeq)) return;
      lastSeq = evt.seq;
      tuner.command(evt.cmd, evt.channel);
    });
    es.addEventListener("config", () => location.reload());
  }

  // The daily reload: belt and braces for a browser that runs for months.
  // Never within two hours of boot, so a set switched on at the reload hour
  // does not reload itself in a loop.
  function startKioskWatch(cfg, soak) {
    if (cfg.dailyReloadHour === false) return;
    const bootAt = Date.now();
    setInterval(() => {
      if (Date.now() - bootAt > 2 * 3600 * 1000 && new Date().getHours() === cfg.dailyReloadHour) location.reload();
    }, soak ? 5000 : 60000);
  }

  document.addEventListener("DOMContentLoaded", () => {
    const stage = document.getElementById("stage");
    if (!stage) return; // test harness page: helpers only
    paintStage(stage, null); // the palette before anything, error card included

    const errorCard = document.getElementById("error-card");
    const errorDetail = document.getElementById("error-detail");
    const soak = new URLSearchParams(location.search).has("soak");
    if (soak) console.log("[cable-82] soak mode on");

    loadRuntimeConfig().then(({ raw, version, error }) => {
      const result = error ? { ok: false, errors: [error] } : S.validateConfig(raw);
      if (!result.ok) {
        errorCard.hidden = false;
        errorDetail.textContent = result.errors.join(" / ").toUpperCase() + " - FIX THE FILE, OR SAVE FROM THE CONTROL ROOM AT /config TO WRITE A GOOD ONE";
        // The bus still runs, so a save from the room brings the set back
        // without anyone touching it.
        startBus({ command() {} }, null);
        return;
      }
      const cfg = result.cfg;
      result.errors.forEach((e) => console.warn("[cable-82] " + e));
      paintStage(stage, cfg);
      const tuner = window.Cable82Tuner.start(cfg, { soak });
      startBus(tuner, version);
      startKioskWatch(cfg, soak);
      if (soak) setInterval(() => console.log("[soak] " + JSON.stringify(Board.stats())), 10000);
    });
  });
})();
