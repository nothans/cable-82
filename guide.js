/* CABLE 82 channel 0: the guide. Built after the cable preview channels that
   ran on an Amiga in a headend closet: a masthead with the clock, a grid of
   what is on every channel now and next, and the lineup crawling up the
   screen when it is taller than the tube. It draws from the same dial and
   the same broadcast clock the tuner runs on (Cable82Dial.guideGrid), so it
   cannot disagree with the picture. Loads as window.Cable82Guide. */
(() => {
  "use strict";

  const S = window.Cable82Schema;
  const Dial = window.Cable82Dial;
  const { PALETTE, PALETTE_CRT, PREVIEW_DEFAULTS, GUIDE, resolveColor } = S;
  const { guideGrid, formatClock, EPOCH } = Dial;

  // create({ cfg, dial, library }) -> { start(), stop() }
  //   dial     the enabled, number-sorted channels
  //   library  the tuner's folder listings: all() -> { number: { files, spots } },
  //            fetch() -> Promise of the same after asking the server again
  function create({ cfg, dial, library }) {
    const L = {
      layer: document.getElementById("guide-layer"),
      clock: document.getElementById("guide-clock"),
      name: document.getElementById("guide-name"),
      tagline: document.getElementById("guide-tagline"),
      cols: document.getElementById("guide-cols"),
      view: document.getElementById("guide-view"),
      rows: document.getElementById("guide-rows"),
    };

    let timers = [];
    let raf = 0;
    let scroll = null;
    let lineup = [];
    let observer = null;

    // The preview channel's own settings live with the station's, so one
    // guide channel or two both read the same lineup.
    function options() {
      const p = cfg.preview || {};
      return {
        name: p.name || PREVIEW_DEFAULTS.name,
        tagline: p.tagline === undefined ? "" : p.tagline,
        slots: p.slots || GUIDE.slots.dflt,
        scrollSeconds: p.scrollSeconds || GUIDE.scrollSeconds.dflt,
        seconds: p.seconds !== false,
        background: p.background || "blue",
      };
    }

    function rowElement(row) {
      const el = document.createElement("div");
      el.className = "guide-row";
      const ch = document.createElement("div");
      ch.className = "g-ch";
      const num = document.createElement("span");
      num.className = "g-num";
      num.textContent = row.number;
      const name = document.createElement("span");
      name.className = "g-name";
      name.textContent = row.name;
      ch.append(num, name);
      el.appendChild(ch);
      for (const cell of row.cells) {
        const c = document.createElement("div");
        c.className = "g-cell is-" + cell.kind;
        c.style.gridColumn = "span " + cell.span;
        // The title lives in its own span so it can be clamped to two lines
        // no matter how tall the row grows around it.
        const t = document.createElement("span");
        t.className = "g-title";
        t.textContent = cell.title;
        c.appendChild(t);
        el.appendChild(c);
      }
      return el;
    }

    function draw() {
      const now = new Date();
      const opts = options();
      L.name.textContent = opts.name;
      L.tagline.textContent = opts.tagline;
      L.tagline.hidden = !opts.tagline;
      L.layer.style.background = resolveColor(opts.background, "blue", cfg.crtMode ? PALETTE_CRT : PALETTE);
      const grid = guideGrid(dial, library.all(), now, opts.slots, EPOCH);
      // the rows live in a different subtree, so the count goes on the layer
      L.layer.style.setProperty("--slots", opts.slots);
      L.cols.textContent = "";
      const chHead = document.createElement("div");
      chHead.className = "gc-ch";
      L.cols.appendChild(chHead);
      for (const slot of grid.slots) {
        const h = document.createElement("div");
        h.className = "gc-slot";
        h.textContent = formatClock(slot, cfg.timeFormat);
        L.cols.appendChild(h);
      }
      L.rows.textContent = "";
      for (const row of grid.rows) L.rows.appendChild(rowElement(row));
      lineup = grid.rows;
      fit();
    }

    // Does the lineup fit, and if not how fast does it crawl? Kept separate
    // from drawing because the answer changes after the first paint: the
    // bitmap face lands late and every row and the masthead grow with it.
    // Idempotent on purpose, so it can run as often as it likes.
    function fit() {
      if (!lineup.length) return;
      const n = lineup.length;
      while (L.rows.childElementCount > n) L.rows.lastElementChild.remove();
      const height = L.rows.scrollHeight;
      const view = L.view.clientHeight;
      L.rows.style.transform = "translateY(0)";
      if (height <= view || !view) {
        scroll = null;
        return;
      }
      // Drawn twice so the loop has no seam: the second copy is what scrolls
      // up into the gap the first one leaves.
      for (const row of lineup) L.rows.appendChild(rowElement(row));
      scroll = { y: 0, loop: height, speed: view / options().scrollSeconds };
    }

    function start() {
      L.layer.hidden = false; // measured below: a hidden layer has no height
      draw();
      // The folder listings are normally fetched by the video player. The
      // guide needs them too, and it may well be the first channel anyone
      // tunes to, so ask and redraw.
      library.fetch()
        .then(() => { if (!L.layer.hidden) draw(); })
        .catch(() => { /* the grid still lists the dial, just without titles */ });
      // The bitmap face lands after the first paint and everything grows with
      // it, so watch the boxes instead of guessing when layout has settled.
      if (typeof ResizeObserver === "function") {
        observer = new ResizeObserver(() => fit());
        observer.observe(L.view);
      }
      const withSeconds = options().seconds;
      const tick = () => {
        L.clock.textContent = formatClock(new Date(), cfg.timeFormat, { seconds: withSeconds });
      };
      tick();
      timers.push(setInterval(tick, 1000));
      // Redraw when the half hour turns over, then every half hour after.
      const now = new Date();
      const msToSlot = (30 - (now.getMinutes() % 30)) * 60000 - now.getSeconds() * 1000 - now.getMilliseconds();
      timers.push(setTimeout(() => {
        draw();
        timers.push(setInterval(draw, 30 * 60000));
      }, msToSlot + 500));
      let last = performance.now();
      const step = (t) => {
        if (scroll) {
          scroll.y += ((t - last) / 1000) * scroll.speed;
          if (scroll.y >= scroll.loop) scroll.y -= scroll.loop;
          // Whole pixels only: a fractional offset makes the browser
          // subpixel-antialias every line, which fringes the text in color.
          L.rows.style.transform = "translateY(" + -Math.round(scroll.y) + "px)";
        }
        last = t;
        raf = requestAnimationFrame(step);
      };
      raf = requestAnimationFrame(step);
    }

    function stop() {
      if (observer) observer.disconnect();
      observer = null;
      lineup = [];
      for (const t of timers) { clearInterval(t); clearTimeout(t); }
      timers = [];
      cancelAnimationFrame(raf);
      raf = 0;
      scroll = null;
      L.layer.hidden = true;
      L.rows.textContent = "";
    }

    return { start, stop };
  }

  window.Cable82Guide = { create };
})();
