/* CABLE 82 - Jarvis, the on-screen host.
 *
 * POST /api/jarvis puts a `jarvis` event on the bus: { seq, text, audio }.
 * Jarvis pops up over whatever is on, says the line, and goes. He is drawn
 * the way a 1980s station would have faked a computer host: a low-poly head
 * on a canvas of 320x240 shown with hard pixels, a backdrop of rotating
 * neon lines, a head that jerks between poses and sometimes sticks on a
 * frame, and tearing across the picture. His mouth is an oscilloscope: when
 * the line has a voice (audio, a WAV the server made with espeak-ng) the
 * trace is the speech itself, so it moves exactly with the words; without
 * one it is a sine wave that swells for each word of the caption.
 *
 * Everything here is drawn from the clock and a seeded random, nothing
 * from outside, so it runs offline and costs one canvas.
 */
(function () {
  "use strict";

  const W = 320;
  const H = 240;
  const HOLD_AFTER = 1.2; // seconds on screen after the last word
  const VOICE_WAIT = 4; // seconds to wait for a voice before speaking without one
  const QUEUE_MAX = 3;

  let root = null;
  let canvas = null;
  let ctx = null;
  let caption = null;
  let audioCtx = null;
  let analyser = null;
  let wave = null;
  let queue = [];
  let current = null;
  let raf = 0;

  // A small seeded random, so a glitch pattern is stable within one line.
  function rng(seed) {
    let s = seed >>> 0 || 1;
    return () => {
      s ^= s << 13;
      s ^= s >>> 17;
      s ^= s << 5;
      return ((s >>> 0) % 100000) / 100000;
    };
  }

  function build() {
    if (root) return true;
    const stage = document.getElementById("stage");
    if (!stage) return false;
    root = document.createElement("div");
    root.id = "jarvis";
    root.hidden = true;
    root.innerHTML =
      '<div class="jv-frame"><canvas width="' + W + '" height="' + H + '"></canvas>' +
      '<div class="jv-caption"><span class="jv-flag">JARVIS</span><span class="jv-text"></span></div></div>';
    stage.appendChild(root);
    canvas = root.querySelector("canvas");
    ctx = canvas.getContext("2d");
    caption = root.querySelector(".jv-text");
    return true;
  }

  // ---------------------------------------------------------------- sound

  // One audio graph for the life of the page: the clip's element feeds an
  // analyser, and the analyser's time-domain samples are the mouth.
  function connect(audio) {
    try {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return false;
      if (!audioCtx) {
        audioCtx = new AC();
        analyser = audioCtx.createAnalyser();
        analyser.fftSize = 512;
        wave = new Uint8Array(analyser.fftSize);
        analyser.connect(audioCtx.destination);
      }
      audioCtx.createMediaElementSource(audio).connect(analyser);
      if (audioCtx.state === "suspended") audioCtx.resume().catch(() => {});
      return true;
    } catch (e) {
      return false;
    }
  }

  // The channel and the music step back while Jarvis talks.
  function duck(on) {
    const players = document.querySelectorAll("video, audio");
    for (const p of players) {
      if (p.dataset.jarvis) continue;
      if (on) {
        if (p.dataset.jvVolume === undefined) p.dataset.jvVolume = String(p.volume);
        p.volume = Math.min(p.volume, Number(p.dataset.jvVolume) * 0.2);
      } else if (p.dataset.jvVolume !== undefined) {
        p.volume = Number(p.dataset.jvVolume);
        delete p.dataset.jvVolume;
      }
    }
  }

  // ---------------------------------------------------------------- drawing

  const NEON = ["#ff3fd8", "#33f0ff", "#ffe23a", "#7dff4f"];

  function backdrop(t) {
    ctx.fillStyle = "#0a0630";
    ctx.fillRect(0, 0, W, H);
    // Nested squares turning at different speeds, the way a host's set was
    // faked with a few rotating lines.
    ctx.save();
    ctx.translate(W / 2, H / 2);
    ctx.lineWidth = 6;
    for (let i = 0; i < 5; i++) {
      ctx.save();
      ctx.rotate(t * (0.25 + i * 0.11) * (i % 2 ? -1 : 1));
      ctx.strokeStyle = NEON[(i + Math.floor(t * 0.8)) % NEON.length];
      const s = 40 + i * 42;
      ctx.strokeRect(-s, -s, 2 * s, 2 * s);
      ctx.restore();
    }
    // Spokes from the middle, slower.
    ctx.lineWidth = 2;
    ctx.strokeStyle = "rgba(51, 240, 255, 0.35)";
    for (let i = 0; i < 12; i++) {
      const a = t * 0.15 + (i * Math.PI) / 6;
      ctx.beginPath();
      ctx.moveTo(0, 0);
      ctx.lineTo(Math.cos(a) * 260, Math.sin(a) * 260);
      ctx.stroke();
    }
    ctx.restore();
  }

  function poly(points, fill) {
    ctx.beginPath();
    ctx.moveTo(points[0][0], points[0][1]);
    for (let i = 1; i < points.length; i++) ctx.lineTo(points[i][0], points[i][1]);
    ctx.closePath();
    ctx.fillStyle = fill;
    ctx.fill();
  }

  // The head, built from flat polygons around (0, 0), about 150 tall. `turn`
  // (-1 to 1) squeezes one side to fake a turn; the mouth is drawn after.
  function head(turn) {
    const L = 1 - Math.max(0, turn) * 0.35;
    const R = 1 + Math.min(0, turn) * 0.35;
    const x = (v) => (v < 0 ? v * L : v * R);
    // neck and collar
    poly([[x(-26), 52], [x(26), 52], [x(34), 80], [x(-34), 80]], "#c9a487");
    poly([[x(-70), 82], [x(-30), 70], [x(0), 96], [x(30), 70], [x(70), 82], [x(80), 120], [x(-80), 120]], "#1d1f2b");
    poly([[x(-30), 70], [x(0), 96], [x(-10), 120], [x(-22), 120]], "#e9e9f2");
    poly([[x(30), 70], [x(0), 96], [x(10), 120], [x(22), 120]], "#d5d5e0");
    // face: a lit side and a shade side
    poly([[x(-46), -40], [x(0), -52], [x(0), 62], [x(-30), 50], [x(-50), 10]], "#f1cdb0");
    poly([[x(0), -52], [x(46), -40], [x(50), 10], [x(30), 50], [x(0), 62]], "#d8ab8c");
    // jaw line
    poly([[x(-30), 50], [x(0), 62], [x(30), 50], [x(0), 70]], "#c39678");
    // slicked hair, swept back
    poly([[x(-50), -30], [x(-40), -70], [x(-6), -86], [x(36), -78], [x(54), -48], [x(46), -40], [x(0), -56], [x(-46), -40]], "#c8cdd8");
    poly([[x(-40), -70], [x(-6), -86], [x(0), -62], [x(-30), -50]], "#eef1f7");
    // wraparound shades with one hard highlight
    poly([[x(-52), -16], [x(52), -16], [x(48), 4], [x(8), 6], [x(0), 0], [x(-8), 6], [x(-48), 4]], "#08080e");
    poly([[x(-40), -12], [x(-18), -12], [x(-24), -7], [x(-42), -7]], "#33f0ff");
    // nose shadow
    poly([[x(0), 6], [x(8), 24], [x(0), 28]], "#bf8f72");
  }

  // The mouth: a dark slot with a trace across it. `samples` is the speech
  // (0-255 around 128) or null for the drawn sine.
  function mouth(turn, t, level, samples) {
    const L = 1 - Math.max(0, turn) * 0.35;
    const R = 1 + Math.min(0, turn) * 0.35;
    const left = -24 * L;
    const right = 24 * R;
    const open = 3 + level * 10;
    ctx.fillStyle = "#1a0c10";
    ctx.fillRect(left, 38 - open, right - left, open * 2);
    ctx.strokeStyle = "#7dff4f";
    ctx.lineWidth = 2;
    ctx.beginPath();
    const steps = 40;
    for (let i = 0; i <= steps; i++) {
      const u = i / steps;
      let v;
      if (samples) v = (samples[Math.floor(u * (samples.length - 1))] - 128) / 128;
      else v = Math.sin(u * Math.PI * 6 + t * 18) * level;
      const px = left + u * (right - left);
      const py = 38 + Math.max(-1, Math.min(1, v * 1.6)) * open;
      if (i) ctx.lineTo(px, py);
      else ctx.moveTo(px, py);
    }
    ctx.stroke();
  }

  // Horizontal tearing and scanlines, applied to the finished frame.
  function damage(r, strength) {
    const bands = Math.floor(r() * 3 * strength);
    for (let i = 0; i < bands; i++) {
      const y = Math.floor(r() * H);
      const h = 2 + Math.floor(r() * 10);
      const dx = Math.floor((r() - 0.5) * 30 * strength);
      ctx.drawImage(canvas, 0, y, W, h, dx, y, W, h);
    }
    ctx.fillStyle = "rgba(0, 0, 0, 0.28)";
    for (let y = 0; y < H; y += 2) ctx.fillRect(0, y, W, 1);
  }

  // ---------------------------------------------------------------- one line

  // How loud the speech is right now (0-1), and its samples for the mouth.
  function speechNow(job) {
    if (job.analysed && analyser && !job.audio.paused) {
      analyser.getByteTimeDomainData(wave);
      let sum = 0;
      for (let i = 0; i < wave.length; i++) sum += (wave[i] - 128) * (wave[i] - 128);
      return { level: Math.min(1, Math.sqrt(sum / wave.length) / 40), samples: wave };
    }
    // No voice: a syllable rhythm from the caption, one swell per word.
    const words = job.text.split(/\s+/).length;
    const talk = job.talkSeconds;
    const e = job.elapsed - job.talkStart;
    if (job.talkStart === null || e < 0 || e > talk) return { level: 0, samples: null };
    const phase = (e / talk) * words;
    return { level: 0.25 + 0.75 * Math.abs(Math.sin(phase * Math.PI)), samples: null };
  }

  function frame(now) {
    raf = requestAnimationFrame(frame);
    const job = current;
    if (!job) return;
    const t = (now - job.start) / 1000;
    job.elapsed = t;
    const r = rng(job.seq * 7919 + Math.floor(t * 12));

    // A voice that never turns up: speak with the drawn mouth instead.
    if (job.talkStart === null && t > VOICE_WAIT) unvoice(job);
    // The caption types out over the talking time, from the first word.
    const talked = job.talkStart === null ? 0 : t - job.talkStart;
    const shown = Math.min(job.text.length, Math.max(0, Math.ceil((talked / Math.max(0.6, job.talkSeconds)) * job.text.length)));
    if (caption.textContent.length !== shown) caption.textContent = job.text.slice(0, shown);

    // A stuck frame now and then: the last picture holds.
    if (job.stuckUntil > t) return finish(job, t);
    if (r() < 0.03) job.stuckUntil = t + 0.12 + r() * 0.18;

    // Jerky poses: the head holds a turn and tilt, then snaps to the next.
    if (t >= job.nextPose) {
      job.turn = (r() - 0.5) * 1.2;
      job.tilt = (r() - 0.5) * 0.16;
      job.nod = (r() - 0.5) * 8;
      job.nextPose = t + 0.35 + r() * 0.6;
    }
    const { level, samples } = speechNow(job);
    backdrop(t);
    ctx.save();
    ctx.translate(W / 2, H / 2 + 14 + job.nod);
    ctx.rotate(job.tilt);
    ctx.scale(1.22, 1.22);
    head(job.turn);
    mouth(job.turn, t, level, samples);
    ctx.restore();
    damage(r, 0.6 + level);
    finish(job, t);
  }

  function finish(job, t) {
    if (job.talkStart === null) return;
    const done = job.voiceEnded !== null ? job.voiceEnded + HOLD_AFTER : job.talkStart + job.talkSeconds + HOLD_AFTER;
    if (t >= done) close(job);
  }

  // Drop the voice and talk with the drawn mouth from now, at reading pace.
  function unvoice(job) {
    if (job.audio) {
      job.audio.pause();
      job.audio = null;
    }
    job.analysed = false;
    job.voiceEnded = null;
    job.talkSeconds = Math.max(1.6, job.text.length * 0.065);
    if (job.talkStart === null) job.talkStart = job.elapsed;
  }

  function open(job) {
    current = job;
    job.start = performance.now();
    root.querySelector(".jv-flag").textContent = job.name;
    caption.textContent = "";
    root.hidden = false;
    root.classList.remove("jv-out");
    root.classList.add("jv-in");
    duck(true);
    if (!raf) raf = requestAnimationFrame(frame);
    if (job.audio) {
      const audio = job.audio;
      // The words start with the voice, which may still be rendering.
      audio.addEventListener("playing", () => { if (job.talkStart === null) job.talkStart = job.elapsed; });
      audio.addEventListener("ended", () => { job.voiceEnded = job.elapsed; });
      // No clip (the server could not make one) or autoplay refused (a
      // desktop tab nobody clicked): the drawn mouth says it instead.
      audio.addEventListener("error", () => unvoice(job));
      audio.play().catch(() => unvoice(job));
    } else {
      job.talkStart = 0;
    }
  }

  function close(job) {
    if (current !== job) return;
    current = null;
    root.classList.remove("jv-in");
    root.classList.add("jv-out");
    setTimeout(() => {
      if (current) return;
      root.hidden = true;
      cancelAnimationFrame(raf);
      raf = 0;
      duck(false);
      next();
    }, 260);
  }

  function next() {
    const job = queue.shift();
    if (job) open(job);
  }

  function say(evt) {
    if (!evt || typeof evt.text !== "string" || !evt.text.trim()) return;
    if (!build()) return;
    const text = evt.text.trim().toUpperCase();
    const job = {
      seq: Number(evt.seq) || 1,
      name: String(evt.name || "JARVIS").slice(0, 16),
      text,
      // Reading pace for the caption and the drawn mouth when there is no voice.
      talkSeconds: Math.max(1.6, text.length * 0.065),
      elapsed: 0,
      start: performance.now(),
      nextPose: 0,
      turn: 0,
      tilt: 0,
      nod: 0,
      stuckUntil: 0,
      voiceEnded: null,
      talkStart: null,
      audio: null,
      analysed: false,
    };
    if (evt.audio) {
      const audio = new Audio();
      audio.dataset.jarvis = "1";
      audio.preload = "auto";
      audio.src = evt.audio;
      job.audio = audio;
      job.analysed = connect(audio);
      // With a voice, the caption keeps pace with the clip's own length.
      audio.addEventListener("loadedmetadata", () => {
        if (Number.isFinite(audio.duration) && audio.duration > 0) job.talkSeconds = audio.duration;
      });
    }
    if (current) {
      if (queue.length < QUEUE_MAX) queue.push(job);
      return;
    }
    open(job);
  }

  window.Cable82Jarvis = { say };
})();
