/* CABLE 82 video channels: the player.
   Two <video> buffers inside the layer: one on the air, one cueing the next
   segment while the current one plays, so a boundary is a cut - the way a
   station does it - not a load. Where the channel is right now comes from
   the broadcast clock (Cable82Dial.positionAt over the channel's timeline),
   never from a play cursor; the player only ever chases that position.
   Loads as window.Cable82Video. */
(() => {
  "use strict";

  const Dial = window.Cable82Dial;
  const { channelTimeline, positionAt, EPOCH } = Dial;

  // create({ layer, library, soundLevel, card }) -> { start(channel), stop(), applySound() }
  //   layer      the #video-layer element holding the two buffers
  //   library    the tuner's folder listings: fetch() -> Promise of
  //              { number: { files, spots } }, cached(number) -> the last one
  //   soundLevel () -> 0..1, the tuner's volume key
  //   card       the off-air card: start(channel, state, mode), stop()
  function create({ layer, library, soundLevel, card }) {
    const bufs = layer.querySelectorAll("video");
    let vid = bufs[0];
    let standby = bufs[1];
    let channel = null; // the channel on the air, or null between tunes
    let stops = [];
    let currentUrl = "";
    let curTl = []; // the timeline the air was last driven from
    let curIndex = -1; // its segment on the air
    let degIndex = -1; // sequential fallback while durations are unknown

    // The channel's air for today: its files (and spots) as a timeline.
    function timelineFor(ch, lib) {
      return channelTimeline(ch, lib.files, lib.spots, new Date());
    }

    // Which pool a file on the air came from, for the duration cache.
    function poolOf(ch, lib, url) {
      if (lib.files.some((f) => f.url === url)) return { folder: ch.folder, files: lib.files };
      if (ch.breaks && lib.spots.some((f) => f.url === url)) return { folder: ch.breaks.folder, files: lib.spots };
      return null;
    }

    function postDurations(folder, durations) {
      fetch("api/channels/durations", {
        method: "POST",
        headers: { "content-type": "application/json", "x-cable82-config": "1" },
        body: JSON.stringify({ folder, durations }),
      }).catch(() => { /* cache miss next boot; the probe will run again */ });
    }

    // Learn missing durations from <video> metadata, one file at a time,
    // and post each folder's batch back so the server's cache fills
    // itself. The clock can only run when every duration is known; until
    // then playback is honest sequential. A programmed channel probes its
    // spots folder too, so the breaks can be cut in.
    async function probeMissing(ch, lib) {
      const pools = [{ folder: ch.folder, files: lib.files }];
      if (ch.breaks) pools.push({ folder: ch.breaks.folder, files: lib.spots });
      let probed = false;
      for (const pool of pools) {
        const missing = pool.files.filter((f) => f.duration == null);
        if (!missing.length) continue;
        probed = true;
        const learned = {};
        for (const f of missing) {
          if (channel !== ch) break; // tuned away: stop politely
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
        if (Object.keys(learned).length) postDurations(pool.folder, learned);
      }
      return probed;
    }

    // Park a buffer at a time once it knows its length. The url check
    // keeps a stale listener from moving a later load.
    function cueAt(v, url, t) {
      const go = () => {
        if (v.getAttribute("src") !== url) return;
        if (Math.abs(v.currentTime - t) > 0.5) v.currentTime = t;
      };
      if (v.readyState >= 1) go();
      else v.addEventListener("loadedmetadata", go, { once: true });
    }

    function preloadNext(tl, index) {
      if (!tl.length) return;
      const next = tl[(index + 1) % tl.length];
      if (standby.getAttribute("src") !== next.url) {
        standby.preload = "auto";
        standby.src = next.url;
        standby.load();
      }
      // An act that picks the movie back up is cued at its resume point,
      // so the cut out of the break lands on the right frame, not frame zero.
      if (next.from > 0) cueAt(standby, next.url, next.from);
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

    // Put a segment's file on the air: the cued standby if it holds it, a
    // cold load otherwise. The same file already up is left alone; the
    // seek that follows moves within it.
    function cutTo(seg) {
      if (currentUrl === seg.url) return;
      currentUrl = seg.url;
      if (standby.getAttribute("src") === seg.url && standby.readyState >= 2) {
        swapBuffers(); // the next program is already cued: cut, don't load
      } else {
        vid.src = seg.url;
        vid.load();
      }
    }

    // The segment on the air, if the timeline still agrees with it.
    function segOnAir(tl) {
      if (curIndex >= 0 && curIndex < tl.length && tl[curIndex].url === currentUrl) return curIndex;
      return tl.findIndex((s) => s.url === currentUrl);
    }

    function drive(ch, lib) {
      if (channel !== ch) return;
      const tl = timelineFor(ch, lib);
      if (!tl.length) return;
      const pos = positionAt(tl, Date.now(), EPOCH);
      let target;
      let offset = null;
      if (pos) {
        target = pos.index;
        offset = pos.offset;
      } else if (currentUrl && !vid.ended && !vid.error) {
        target = segOnAir(tl); // degraded: let it play out
      } else {
        degIndex = (degIndex + 1) % tl.length;
        target = degIndex;
      }
      if (target < 0 || target >= tl.length) target = 0;
      const seg = tl[target];
      cutTo(seg);
      curTl = tl;
      curIndex = target;
      const v = vid; // the deferred seek must land on this buffer, not a later swap's
      const want = seg.from + (offset != null ? offset : 0);
      const seek = () => {
        if ((offset != null || seg.from > 0) && Math.abs(v.currentTime - want) > 1.5) {
          v.currentTime = want;
        }
        v.play().catch(() => { /* kiosk runs with autoplay allowed */ });
      };
      if (v.readyState >= 1) seek();
      else v.addEventListener("loadedmetadata", seek, { once: true });
      preloadNext(tl, target);
    }

    async function start(ch) {
      channel = ch;
      currentUrl = "";
      curTl = [];
      curIndex = -1;
      degIndex = -1;
      vid.muted = false;
      vid.volume = soundLevel();
      vid.hidden = false;
      standby.muted = true;
      standby.hidden = true;
      standby.removeAttribute("src");
      layer.hidden = false;
      // The folder is the truth and it changes (episodes added over the
      // share, a file deleted mid-week), so every tune re-reads it. The
      // cached list only covers a blip while the server restarts.
      const readLibrary = async () => (await library.fetch())[ch.number] || null;
      let lib = null;
      try {
        lib = await readLibrary();
      } catch (e) {
        lib = library.cached(ch.number);
      }
      if (channel !== ch) return; // tuned away while fetching
      if (!lib || !lib.files.length) {
        layer.hidden = true;
        card.start(ch, { resumeText: "NO PROGRAMMING AVAILABLE" }, "testcard");
        stops.push(card.stop);
        // A server blip at tune time must not kill the channel until the
        // daily reload: keep asking, and go on air when the folder answers.
        const retry = setInterval(async () => {
          let again = null;
          try {
            again = await readLibrary();
          } catch (e) { /* still down */ }
          if (channel !== ch || !again || !again.files.length) return;
          clearInterval(retry);
          card.stop();
          layer.hidden = false;
          lib = again;
          wire();
        }, 30000);
        stops.push(() => clearInterval(retry));
        return;
      }
      wire();

      function wire() {
        // A file can play shorter than its cached duration says. What
        // just ended is ground truth: correct the cache so the clock
        // converges instead of freeze-looping a phantom tail.
        const correctDuration = (url) => {
          const pool = poolOf(ch, lib, url);
          const f = pool && pool.files.find((x) => x.url === url);
          const actual = vid.currentTime;
          if (f && Number.isFinite(actual) && actual > 1 && f.duration != null && Math.abs(f.duration - actual) > 0.5) {
            f.duration = actual;
            postDurations(pool.folder, { [f.file]: actual });
          }
        };
        // `why` is "file" when the file itself ran out, "act" when a
        // break is due mid-file; only a real ending says anything about
        // the file's length.
        const onEnded = (e, why) => {
          if (e.target !== vid) return; // only the on-air buffer airs an ending
          if (why !== "act") correctDuration(currentUrl);
          // Roll straight into the next segment - the cued standby makes
          // this a cut. Small clock disagreements settle at the next
          // resync (1.5s drift tolerance) and vanish once durations are true.
          const tl = timelineFor(ch, lib);
          if (!tl.length) return;
          let i = segOnAir(tl);
          if (i < 0) i = 0;
          degIndex = (i + 1) % tl.length; // keep the degraded counter in step
          const next = tl[degIndex];
          curTl = tl;
          curIndex = degIndex;
          if (currentUrl === next.url) {
            vid.currentTime = next.from; // the same file again: rewind, no reload
          } else {
            cutTo(next);
            if (next.from > 0) cueAt(vid, next.url, next.from); // a cold load starts at the act, not at 0
          }
          vid.play().catch(() => { /* kiosk allows autoplay */ });
          preloadNext(tl, degIndex);
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
            if (channel !== ch) return;
            try {
              const fresh = await readLibrary();
              if (fresh && fresh.files.length) lib = fresh;
            } catch (e2) { /* keep the list we have */ }
            if (channel !== ch) return;
            currentUrl = "";
            curIndex = -1;
            drive(ch, lib);
          }, 1500);
        };
        const onFileEnded = (e) => onEnded(e, "file");
        for (const b of bufs) {
          b.addEventListener("ended", onFileEnded);
          b.addEventListener("error", onError);
        }
        // The end of a program is not taken on trust. The Pi's kiosk
        // Chromium holds the last frame of a commercial and never delivers
        // `ended`, so nothing rolled until the next resync - a dead screen
        // for up to 30 s, long enough to swallow a 15 s spot whole. This
        // watch sees the end for itself: a buffer sitting in the ended
        // state, or a clock stopped inside the last second of the file, is
        // the ending; a clock stopped anywhere else (IO stall, decoder
        // wedge) is a reason to drop the source and let drive() reload it
        // at the broadcast clock. It also calls the breaks: an act ends at
        // its mark inside the file, and the movie waits there.
        let watchT = -1;
        let watchSince = 0;
        const endWatch = setInterval(() => {
          if (vid.hidden || vid.error || !currentUrl) {
            watchT = -1;
            return;
          }
          if (vid.ended) {
            onEnded({ target: vid }, "file");
            return;
          }
          const t = vid.currentTime;
          const now = Date.now();
          const d = vid.duration;
          const seg = curIndex >= 0 && curTl[curIndex] && curTl[curIndex].url === currentUrl ? curTl[curIndex] : null;
          const midFile = seg && seg.to != null && !(Number.isFinite(d) && seg.to >= d - 0.5);
          if (midFile && t >= seg.to) {
            onEnded({ target: vid }, "act");
            return;
          }
          if (t !== watchT) {
            watchT = t;
            watchSince = now;
            return;
          }
          const stalled = now - watchSince;
          if (Number.isFinite(d) && d > 0 && t >= d - 1 && stalled >= 300) {
            onEnded({ target: vid }, "file");
          } else if (stalled >= 4000) {
            currentUrl = "";
            curIndex = -1;
            drive(ch, lib);
          }
        }, 250);
        const resync = setInterval(() => drive(ch, lib), 30000);
        stops.push(() => {
          for (const b of bufs) {
            b.removeEventListener("ended", onFileEnded);
            b.removeEventListener("error", onError);
          }
          clearInterval(endWatch);
          clearInterval(resync);
        });
        drive(ch, lib);
        probeMissing(ch, lib).then((probed) => {
          if (probed && channel === ch) drive(ch, lib);
        });
      }
    }

    function stop() {
      channel = null;
      for (const s of stops.splice(0)) {
        try { s(); } catch (e) { /* keep stopping */ }
      }
      for (const b of bufs) {
        try { b.pause(); } catch (e) { /* fine */ }
        b.muted = true;
        b.removeAttribute("src");
      }
      layer.hidden = true;
      currentUrl = "";
      curTl = [];
      curIndex = -1;
    }

    // The volume key applied to both buffers, so a swap never changes the level.
    function applySound() {
      for (const b of bufs) b.volume = soundLevel();
    }

    return { start, stop, applySound };
  }

  window.Cable82Video = { create };
})();
