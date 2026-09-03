/* CABLE 82 tuner: the dial, the channel change, and the set's own keys.
   index.html IS the tuner. Chromium launches once, pointed here, and never
   navigates again; a channel change is a DOM operation behind a moment of
   static. The bulletin board is one renderer among several, suspended (not
   torn down) when covered because it is also the chrome. Every source of a
   tune - keyboard, gamepad, and the bus from app.js - lands on the same
   command() entry, so a remote can never fight the buttons.
   Loads as window.Cable82Tuner. */
(() => {
  "use strict";

  const Dial = window.Cable82Dial;
  const { formatClock, airState, nextChannelIndex, VOLUME_STEPS, nextVolumeStep } = Dial;

  // What covers the swap, and for how long: ms of cover before the swap,
  // then ms after it so the new channel has its first frame up.
  const CUT_TIMING = {
    static: { before: 220, after: 120 },
    black: { before: 300, after: 200 },
    none: { before: 0, after: 0 },
  };

  // With tuner.power on "crt" the picture does not just vanish, it dies the
  // way a tube dies. Losing power, a CRT loses vertical deflection first:
  // the raster folds into a single bright line across the middle while the
  // beam still sweeps side to side. Then the high voltage drops, that line
  // pulls in to a dot, and the phosphor glows on for a moment after the
  // beam has gone. Coming back is the same in reverse and quicker, because
  // a picture that blooms open reads as a set warming up. The timings are
  // here, the steps are classes in style.css. snap is a touch longer than
  // its transition so the line has finished pulling in before the phosphor
  // starts to fade.
  const POWER_FX = { collapse: 170, snap: 175, fade: 380, dot: 40, open: 90, bloom: 190 };

  // start(cfg, { soak }) -> { command(cmd, channel), board }
  function start(cfg, opts) {
    const soak = !!(opts && opts.soak);
    const dial = cfg.channels.filter((c) => c.enabled);
    const stage = document.getElementById("stage");
    const L = {
      video: document.getElementById("video-layer"),
      card: document.getElementById("card-layer"),
      cardBars: document.getElementById("card-bars"),
      cardClock: document.getElementById("card-clock"),
      cardName: document.getElementById("card-name"),
      cardMsg: document.getElementById("card-msg"),
      external: document.getElementById("external-layer"),
      snow: document.getElementById("tuner-snow"),
      blank: document.getElementById("tuner-blank"),
      bug: document.getElementById("channel-bug"),
      bugNumber: document.getElementById("bug-number"),
      bugName: document.getElementById("bug-name"),
      bugMeter: document.getElementById("bug-meter"),
      power: document.getElementById("power-off"),
      crtLine: document.getElementById("crt-line"),
    };

    // The set's own state: the volume key's step and whether the picture
    // is on. Both survive a page reload (a config save, the daily reload)
    // and reset when the box is power-cycled, like a TV with a memory.
    let volumeStep = Number(sessionStorage.getItem("cable82.tuner.volume"));
    if (!Number.isInteger(volumeStep) || volumeStep < 0 || volumeStep >= VOLUME_STEPS.length) volumeStep = 0;
    let powered = sessionStorage.getItem("cable82.tuner.power") !== "off";
    const soundLevel = () => VOLUME_STEPS[volumeStep].level;

    // ---------------- the board (channel 82, and the chrome)
    // It is created once and covered while another channel shows. It boots
    // (feeds, music, crawl) at sign-on only if it is on the dial, or if a
    // scheduled channel falls back to it off the air; otherwise the first
    // tune to it boots it, and a dial without a board never polls a feed.
    const board = window.Cable82Board.create(cfg, { soak });
    const boardOnDial = dial.some((c) => c.type === "bulletin" || (c.type === "video" && c.offAir === "bulletin"));
    if (boardOnDial) board.boot();

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
    const CUTS = {
      static: Object.assign({ show: snowShow, hide: snowHide }, CUT_TIMING.static),
      black: Object.assign({ show: () => { L.blank.hidden = false; }, hide: () => { L.blank.hidden = true; } }, CUT_TIMING.black),
      none: Object.assign({ show: () => {}, hide: () => {} }, CUT_TIMING.none),
    };

    // ---------------- the channel bug
    // One on-screen display for everything the set has to say for a moment:
    // the channel on a tune, the digits as they are typed, the volume as a
    // meter. A plate in the upper third of the picture, dark behind light
    // type, so it reads over a bright program, a white web page, and the
    // board's own masthead alike.
    let noticeTimer = null;
    const METER_CELLS = 8;
    for (let i = 0; i < METER_CELLS; i++) L.bugMeter.appendChild(document.createElement("i"));
    function notice({ big, small, meter }) {
      L.bugNumber.textContent = big || "";
      L.bugName.textContent = small || "";
      L.bugName.hidden = !small;
      L.bugMeter.hidden = meter == null;
      if (meter != null) {
        const filled = Math.round(meter * METER_CELLS);
        Array.from(L.bugMeter.children).forEach((cell, i) => cell.classList.toggle("on", i < filled));
      }
      L.bug.hidden = false;
      L.bug.classList.remove("fading");
      clearTimeout(noticeTimer);
      noticeTimer = setTimeout(() => L.bug.classList.add("fading"), 2600);
    }
    const banner = (numberText, nameText) => notice({ big: "CH " + numberText, small: nameText });

    // ---------------- off-air card
    let cardTimer = null;
    const card = {
      start(channel, state, mode) {
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
      },
      stop() {
        clearInterval(cardTimer);
        cardTimer = null;
        L.card.hidden = true;
      },
    };

    // ---------------- the folder listings
    // One fetch of /api/channels gives every video channel its files and
    // spots. The player re-reads it on every tune (the folder is the truth
    // and it changes); the guide reads the same copy.
    let libraries = {}; // channel number -> { files, spots }, each [{file, url, duration}]
    const library = {
      all: () => libraries,
      cached: (number) => libraries[number] || null,
      async fetch() {
        const r = await fetch("api/channels", { cache: "no-store", signal: AbortSignal.timeout(10000) });
        if (!r.ok) throw new Error("HTTP " + r.status);
        const j = await r.json();
        libraries = {};
        for (const c of j.channels || []) {
          libraries[c.number] = { files: c.files || [], spots: (c.breaks && c.breaks.files) || [] };
        }
        return libraries;
      },
    };

    const guide = window.Cable82Guide.create({ cfg, dial, library });
    const video = window.Cable82Video.create({ layer: L.video, library, soundLevel, card });

    // ---------------- the router
    let dialIndex = 0;
    let tuning = false;
    let activeStops = [];

    // Where the set signs on: the channel it was on before a reload, else
    // the board, the one channel every install has of its own and the one
    // with something moving on it. The lowest number only when there is no
    // board on the dial at all.
    // (A missing memory must not read as channel 0: Number(null) is 0, and
    // 0 is the guide, which is how every fresh set used to sign on there.)
    const stored = sessionStorage.getItem("cable82.tuner.channel");
    const ri = stored === null ? -1 : dial.findIndex((c) => c.number === Number(stored));
    const home = dial.findIndex((c) => c.type === "bulletin");
    dialIndex = ri >= 0 ? ri : home >= 0 ? home : 0;

    // Start one channel's view. Non-bulletin views cover the suspended
    // board; bulletin views wake it. Returns the stop functions for leaving.
    function startChannelView(channel) {
      const stops = [];
      if (channel.type === "bulletin") {
        board.resume();
        return stops;
      }
      board.suspend();
      if (channel.type === "guide") {
        guide.start();
        stops.push(guide.stop);
        return stops;
      }
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
        video.start(channel);
        stops.push(video.stop);
      } else if (channel.offAir === "bulletin") {
        board.resume(); // what a real local system did overnight
      } else if (channel.offAir === "snow") {
        snowShow();
        stops.push(snowHide);
      } else {
        card.start(channel, state, channel.offAir);
        stops.push(card.stop);
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
      else notice({ big: "CH " + n, small: "NO SUCH CHANNEL" });
    }

    // ---------------- the volume key
    // One step around VOLUME_STEPS, applied to whatever is making sound
    // (the program on the air, the board's music bed).
    function applySound() {
      video.applySound();
      board.setSoundLevel(soundLevel());
    }
    // The level is drawn, not written: a row of cells that fill as the key
    // steps up, empty at sound off. Words the size of a channel name could
    // not be read across a room; eight boxes can.
    function volumeKey() {
      if (!powered) return;
      volumeStep = nextVolumeStep(volumeStep);
      try { sessionStorage.setItem("cable82.tuner.volume", String(volumeStep)); } catch (e) { /* fine */ }
      applySound();
      notice({ big: "VOLUME", meter: VOLUME_STEPS[volumeStep].level });
    }

    // ---------------- the power key
    // Off is a dark screen and silence: the channel's view is stopped (the
    // board suspended, video unloaded) and a dark layer covers the stage.
    // The broadcast clock keeps running underneath, so on resumes the
    // channel wherever it is now, the way a TV comes back to a program
    // already in progress. The dial is not touched; the set remembers its
    // channel. Every other key is dead while it is off.
    let powerBusy = false; // a tube mid-collapse takes no orders

    function stopChannel() {
      for (const s of activeStops.splice(0)) {
        try { s(); } catch (e) { /* keep stopping */ }
      }
      board.suspend(); // the board has no stop of its own: it is the floor
      clearTimeout(noticeTimer);
      L.bug.hidden = true;
    }

    function setLine(cls) {
      L.crtLine.className = cls;
    }

    function powerKey() {
      if (powerBusy) return;
      const crt = (cfg.tuner.power || "crt") === "crt";
      if (powered) {
        powered = false;
        if (!crt) {
          stopChannel();
          L.power.hidden = false;
        } else {
          powerBusy = true;
          stage.classList.add("tube-off");
          setTimeout(() => {
            // The stage is a sliver by now; the dark screen takes over and
            // carries the line, so the stage can snap back unseen behind it.
            setLine("line");
            L.power.hidden = false;
            stage.classList.remove("tube-off");
            stopChannel();
            // The line was display:none a moment ago. Read its layout once so
            // the browser has a style to transition *from*, or the snap lands
            // in a single frame with nothing to see.
            void L.crtLine.offsetWidth;
            setLine("line snap");
            setTimeout(() => {
              setLine("line snap fade");
              setTimeout(() => { setLine(""); powerBusy = false; }, POWER_FX.fade);
            }, POWER_FX.snap);
          }, POWER_FX.collapse);
        }
      } else {
        powered = true;
        if (!crt) {
          L.power.hidden = true;
          applyChannel(dialIndex);
          banner(dial[dialIndex].number, dial[dialIndex].name);
        } else {
          powerBusy = true;
          setLine("dot");
          applyChannel(dialIndex); // loads behind the dark screen
          setTimeout(() => {
            setLine("dot open");
            setTimeout(() => {
              setLine("");
              L.power.hidden = true;
              stage.classList.add("tube-on");
              setTimeout(() => {
                stage.classList.remove("tube-on");
                powerBusy = false;
                banner(dial[dialIndex].number, dial[dialIndex].name);
              }, POWER_FX.bloom);
            }, POWER_FX.open);
          }, POWER_FX.dot);
        }
      }
      try { sessionStorage.setItem("cable82.tuner.power", powered ? "on" : "off"); } catch (e) { /* fine */ }
    }

    // ---------------- one entry for every source
    // The four keys of a 1960s remote plus a direct dial. The keyboard and
    // the gamepad below call it; app.js calls it for the bus.
    function command(cmd, channel) {
      if (cmd === "up") step(+1);
      else if (cmd === "down") step(-1);
      else if (cmd === "set") setNumber(channel);
      else if (cmd === "volume") volumeKey();
      else if (cmd === "power") powerKey();
    }

    // ---------------- local sources
    // Digit entry like a real cable box: type the number, brief pause tunes.
    let digits = "";
    let digitTimer = null;
    function pushDigit(d) {
      if (!powered) return;
      digits = (digits + d).slice(0, 3);
      notice({ big: "CH " + digits });
      clearTimeout(digitTimer);
      if (digits.length >= 3) commitDigits();
      else digitTimer = setTimeout(commitDigits, 1200);
    }
    function commitDigits() {
      clearTimeout(digitTimer);
      if (!digits) return;
      const n = Number(digits);
      digits = "";
      if (Number.isFinite(n)) setNumber(n); // 0 is a channel: the guide lives there
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
      // The Gamepad API only reports after a button press, which is itself
      // the gesture, and the browser announces it with gamepadconnected.
      // Polling starts then and stops when the last pad leaves, so a set
      // with no controller never spends a frame asking. 20 Hz is plenty
      // for a d-pad; a 60 Hz rAF loop was a tax on a Pi decoding video.
      // Edge state is per pad: a second idle pad sharing one state object
      // would clear it every frame and turn a held button into a repeat.
      const was = {};
      let poll = null;
      const homeIndex = () => {
        const i = dial.findIndex((c) => c.type === "bulletin");
        return i >= 0 ? i : 0;
      };
      const anyPad = () => Array.from(navigator.getGamepads()).some(Boolean);
      const pollPads = () => {
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
      };
      const startPolling = () => { if (!poll) poll = setInterval(pollPads, 50); };
      const stopPolling = () => { if (poll && !anyPad()) { clearInterval(poll); poll = null; } };
      window.addEventListener("gamepadconnected", startPolling);
      window.addEventListener("gamepaddisconnected", stopPolling);
      if (anyPad()) startPolling(); // a pad already known from before a reload
    }

    // ---------------- sign on
    applySound();
    if (powered) {
      applyChannel(dialIndex);
      if (dial.length > 1) banner(dial[dialIndex].number, dial[dialIndex].name);
    } else {
      board.suspend(); // switched off before the reload: stay dark and silent
      L.power.hidden = false;
    }

    return { command, board };
  }

  window.Cable82Tuner = { start };
})();
