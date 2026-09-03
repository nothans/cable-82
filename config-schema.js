/* cable-82 config schema - the single validation authority.
   Pure, dependency-free, and UMD so the same code validates config on the
   server (before it writes config.json), in the display (app.js), in the
   control room (config-page.js), and in the tests. No DOM, no fetch. */
(function (root, factory) {
  const api = factory();
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.Cable82Schema = api;
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  // Broadcast-safe saturated primaries. Names are the config vocabulary.
  const PALETTE = {
    blue: "#2038C8",
    cyan: "#20A8B8",
    green: "#18A038",
    yellow: "#C8A020",
    red: "#C03028",
    magenta: "#B03898",
    white: "#F0F0EC",
    ink: "#101018",
  };

  // CRT mode palette. Composite and RF paths smear saturated color and clip
  // pure white (it can even buzz the audio), so these sit lower in chroma,
  // closer in luma, and the white is the broadcast 90%. Same names, same
  // pairings; only the hex changes.
  const PALETTE_CRT = {
    blue: "#2C48A0",
    cyan: "#3098A4",
    green: "#2C8C48",
    yellow: "#B09030",
    red: "#A84038",
    magenta: "#9C4890",
    white: "#E4E4E0",
    ink: "#181820",
  };

  // Text color paired with each background so contrast never dies.
  const TEXT_ON = {
    blue: "white", green: "white", red: "white", magenta: "white",
    cyan: "ink", yellow: "ink", white: "ink", ink: "white",
  };

  const TYPES = new Set(["clock", "messages", "facts", "dadjokes", "weather", "headlines"]);
  const DEFAULT_ROTATION = [{ type: "clock" }, { type: "messages" }, { type: "facts" }];

  // Channels: the dial. bulletin is the classic CABLE 82 board, video is a
  // folder of files played on the broadcast clock, external is a URL in a
  // frame (how ws4kp joins the dial without being absorbed).
  const CHANNEL_TYPES = new Set(["bulletin", "video", "guide", "external"]);
  const OFFAIR_MODES = new Set(["testcard", "bars", "snow", "bulletin"]);
  // What an unnamed channel is called: the station for the board, the
  // preview name for the guide, its number for anything else.
  function defaultChannelName(type, number, stationName, previewName) {
    if (type === "bulletin") return stationName;
    if (type === "guide") return previewName || PREVIEW_DEFAULTS.name;
    return "CHANNEL " + number;
  }
  const CHANNEL_ORDERS = new Set(["sequence", "shuffle-daily"]);
  // What the guide calls a video channel's programs: the file names, the
  // title written inside each file, or one fixed name for the whole channel
  // (a folder of commercials is "COMMERCIALS", whatever the files are called).
  const TITLE_MODES = new Set(["filename", "metadata", "fixed"]);
  const DAY_KEYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];
  // A channel folder is one plain path segment under channels/ - no
  // separators, no traversal, no leading dot. The server enforces it again.
  const FOLDER_RE = /^[A-Za-z0-9][A-Za-z0-9 ._-]{0,63}$/;
  // Commercial breaks on a video channel: spots from a second folder, cut
  // into the program every so many minutes. everyMinutes 0 means breaks
  // only between programs; the range tops out at a movie-length act.
  const BREAKS = { everyMinutes: { min: 0, max: 240, dflt: 15 }, spots: { min: 1, max: 20, dflt: 3 } };
  // The guide channel: how many half-hour columns fit across, how long a
  // screenful takes to crawl past, and whether the clock counts seconds the
  // way a headend guide's did.
  const GUIDE = { slots: { min: 2, max: 4, dflt: 3 }, scrollSeconds: { min: 4, max: 120, dflt: 14 } };
  const PREVIEW_DEFAULTS = { name: "CABLEVUE", tagline: "WHAT'S ON, AND WHAT'S NEXT" };

  // Natural sort: digit runs compare numerically, so "S01.E2" sorts before
  // "S01.E10" and seasons order before episodes. Case-insensitive. One
  // implementation for the server's folder listing and the display's
  // running order, so the two can never disagree about what airs first.
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

  // "HH:MM" -> minutes since midnight, or null. Shared by validation here
  // and the air-state math in the display.
  function parseHM(s) {
    const m = /^(\d{1,2}):(\d{2})$/.exec(typeof s === "string" ? s.trim() : "");
    if (!m) return null;
    const h = Number(m[1]);
    const min = Number(m[2]);
    if (h === 24 && min === 0) return 1440; // "until midnight", hand-edit friendly
    if (h > 23 || min > 59) return null;
    return h * 60 + min;
  }

  // WMO weather codes -> short broadcast-safe condition text. Open-Meteo
  // returns these codes; the card shows the word.
  const WMO = {
    0: "CLEAR", 1: "MAINLY CLEAR", 2: "PARTLY CLOUDY", 3: "OVERCAST",
    45: "FOG", 48: "FREEZING FOG",
    51: "LIGHT DRIZZLE", 53: "DRIZZLE", 55: "HEAVY DRIZZLE",
    56: "FREEZING DRIZZLE", 57: "FREEZING DRIZZLE",
    61: "LIGHT RAIN", 63: "RAIN", 65: "HEAVY RAIN",
    66: "FREEZING RAIN", 67: "FREEZING RAIN",
    71: "LIGHT SNOW", 73: "SNOW", 75: "HEAVY SNOW", 77: "SNOW GRAINS",
    80: "RAIN SHOWERS", 81: "RAIN SHOWERS", 82: "HEAVY SHOWERS",
    85: "SNOW SHOWERS", 86: "SNOW SHOWERS",
    95: "THUNDERSTORM", 96: "THUNDERSTORM", 99: "THUNDERSTORM",
  };
  function weatherText(code) {
    return WMO[code] || "";
  }

  // The seed written to config.json on first run, and the ultimate fallback
  // the display uses if it can reach neither the server nor a config file.
  const DEFAULT_CONFIG = {
    channelName: "CABLE 82",
    tagline: "COMMUNITY BULLETIN BOARD",
    timeFormat: "12h",
    port: 1982,
    rotation: [
      { type: "clock" },
      { type: "messages" },
      { type: "weather" },
      { type: "facts" },
      { type: "headlines", feed: "news" },
      { type: "messages" },
      { type: "dadjokes" },
      { type: "headlines", feed: "tech" },
      { type: "messages" },
      { type: "facts" },
      { type: "headlines", feed: "blog" },
    ],
    pageSeconds: 12,
    feeds: [
      { id: "news", label: "NEWS", url: "https://www.wbur.org/feed" },
      { id: "tech", label: "TECH", url: "https://hnrss.org/frontpage" },
      { id: "blog", label: "NOTHANS", url: "https://nothans.com/feed" },
    ],
    refreshMinutes: 10,
    maxItemsPerFeed: 20,
    crawl: {
      feeds: ["news", "tech", "blog"],
      secondsPerScreen: 9,
      separator: "  ■  ",
      flag: "LATEST",
    },
    messages: [
      { text: "WELCOME TO CABLE 82", color: "blue" },
      { text: "GARAGE SALE SATURDAY 9AM - 12 ELM ST", color: "green" },
      { text: "LITTLE LEAGUE SIGNUPS AT THE REC CENTER", color: null },
      { text: "LOST DOG - ANSWERS TO BANJO", color: "magenta" },
    ],
    facts: [
      "The Weather Channel debuted on May 2, 1982",
      "The first smiley emoticon :-) was posted to a message board in September 1982",
      "MTV launched in 1981 playing \"Video Killed the Radio Star\"",
      "The compact disc went on sale in 1982",
      "The Commodore 64 debuted in 1982 and became the best selling computer model ever",
      "Time magazine named the computer \"Machine of the Year\" for 1982",
      "EPCOT opened at Walt Disney World on October 1, 1982",
      "USA Today began publishing in September 1982",
      "Cheers, set in Boston, premiered on September 30, 1982",
      "\"Pac-Man Fever\" hit the Billboard top ten in 1982",
      "E.T. was the top grossing movie of 1982",
      "The Sony Walkman debuted in 1979",
      "Honey never spoils",
      "A group of flamingos is called a flamboyance",
      "Octopuses have three hearts",
      "A day on Venus is longer than its year",
      "Bananas are berries but strawberries are not",
      "The Eiffel Tower grows about six inches taller in summer heat",
      "Lightning strikes the earth about 100 times every second",
      "A bolt of lightning is about five times hotter than the surface of the sun",
      "Sharks existed before trees",
      "The moon drifts about an inch and a half away from Earth every year",
      "Wombat droppings are cube shaped",
      "Scotland's national animal is the unicorn",
      "Crows can recognize human faces",
      "There are more possible chess games than atoms in the observable universe",
      "The Boston Marathon is the world's oldest annual marathon, first run in 1897",
      "The Fig Newton is named after Newton, Massachusetts",
      "Basketball was invented in Springfield, Massachusetts in 1891",
      "Volleyball was invented in Holyoke, Massachusetts in 1895",
      "The first telephone call was made in Boston in 1876",
      "Dunkin' Donuts was founded in Quincy, Massachusetts in 1950",
    ],
    dadJokes: [
      "I only know 25 letters of the alphabet. I don't know Y.",
      "Why did the scarecrow win an award? He was outstanding in his field.",
      "I'm reading a book about anti-gravity. It's impossible to put down.",
      "What do you call a fake noodle? An impasta.",
      "I used to hate facial hair, but then it grew on me.",
      "Why don't eggs tell jokes? They'd crack each other up.",
      "What do you call cheese that isn't yours? Nacho cheese.",
      "I made a pencil with two erasers. It was pointless.",
      "How do you organize a space party? You planet.",
      "Why can't your nose be 12 inches long? Because then it would be a foot.",
      "I don't trust stairs. They're always up to something.",
      "What did the ocean say to the beach? Nothing, it just waved.",
      "Did you hear about the restaurant on the moon? Great food, no atmosphere.",
      "Why did the bicycle fall over? It was two tired.",
      "I'd tell you a chemistry joke but I know I wouldn't get a reaction.",
    ],
    // Weather is one strip, never the show (ws4kp owns full retro weather).
    // Data comes from Open-Meteo: free, no key, no account. The location is
    // geocoded in the control room, which stores lat/lon + timezone.
    weather: {
      location: {
        name: "Boston, Massachusetts",
        latitude: 42.3584,
        longitude: -71.0598,
        timezone: "America/New_York",
      },
      tempUnit: "F",
      windUnit: "mph",
    },
    // Continuous background music behind the channel. Tracks live in the
    // music/ folder and are auto-discovered; this just controls playback.
    music: {
      enabled: true,
      shuffle: true,
      volume: 60,
    },
    // The latest CheerLights color (cheerlights.com) rides the crawl as one
    // ticker item. One global color anyone in the world can set; {color} in
    // the template becomes the color name.
    cheerlights: {
      enabled: true,
      template: "THE WORLD IS SET TO {COLOR}",
    },
    colors: {
      pageCycle: ["blue", "green", "red", "cyan"],
      headerBg: "blue",
      crawlBg: "ink",
    },
    // Channel Preview: the guide channel's own name, tagline, grid, and look.
    preview: {
      name: PREVIEW_DEFAULTS.name,
      tagline: PREVIEW_DEFAULTS.tagline,
      slots: 3,
      scrollSeconds: 14,
      seconds: true,
      background: "blue",
    },
    // Overscan margins, one per axis, because real tubes rarely crop the
    // same amount on every edge.
    overscanX: 7,
    overscanY: 7,
    // CRT mode: softer palette, no drop shadow. textScale enlarges the body,
    // kicker, crawl, and small header lines (1 = the original layout).
    // crtInkText swaps white page text for ink; white smears on some tubes.
    crtMode: false,
    crtInkText: false,
    textScale: 1,
    dailyReloadHour: 4,
  };

  // ---------------------------------------------------------- helpers

  function clampNum(v, min, max, dflt) {
    // Only real numbers and numeric strings count; null/false/"" fall back.
    if (typeof v !== "number" && (typeof v !== "string" || !v.trim())) return dflt;
    const n = Number(v);
    return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : dflt;
  }

  // `palette` lets the display swap in PALETTE_CRT; names stay the same.
  function resolveColor(name, fallbackName, palette) {
    const pal = palette || PALETTE;
    if (typeof name === "string") {
      if (pal[name]) return pal[name];
      if (/^#([0-9a-f]{3}|[0-9a-f]{6})$/i.test(name)) return name;
    }
    return pal[fallbackName] || pal.blue;
  }

  function textColorFor(bgName, palette) {
    const pal = palette || PALETTE;
    if (TEXT_ON[bgName]) return pal[TEXT_ON[bgName]];
    // Raw hex backgrounds: pick text by luminance so contrast never dies.
    const m = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(typeof bgName === "string" ? bgName : "");
    if (m) {
      let h = m[1];
      if (h.length === 3) h = h.replace(/./g, (c) => c + c);
      const lum =
        0.2126 * parseInt(h.slice(0, 2), 16) +
        0.7152 * parseInt(h.slice(2, 4), 16) +
        0.0722 * parseInt(h.slice(4, 6), 16);
      return lum > 145 ? pal.ink : pal.white;
    }
    return pal.white;
  }

  // Normalize text to what an 8x16 character generator can show: map
  // typographic punctuation to ASCII, drop everything outside printable
  // Latin-1 (emoji included), collapse whitespace, cap length. Every
  // exotic character is written as an escape: a literal one survives only
  // until somebody's editor normalizes it.
  function sanitize(text, max = 160) {
    if (typeof text !== "string") return "";
    let t = text
      .replace(/[\u2018\u2019\u201A\u2032]/g, "'") // curly single quotes, prime
      .replace(/[\u201C\u201D\u201E\u2033]/g, '"') // curly double quotes, double prime
      .replace(/[\u2013\u2014\u2015\u2212]/g, "-") // en dash, em dash, horizontal bar, minus
      .replace(/\u2026/g, "...") // ellipsis
      .replace(/[\u00A0\u2000-\u200B\u202F\u3000]/g, " "); // nbsp, en/em spaces, zero-width, ideographic space
    t = t.replace(/\s+/g, " "); // newlines/tabs become spaces before the strip
    t = t.replace(/[^\x20-\x7E\u00A1-\u00FF\u2022\u25A0\u25AA]/g, ""); // printable ASCII, Latin-1, bullet, black square, small square
    t = t.replace(/\s+/g, " ").trim(); // stripping can merge two spaces
    if (max >= 4 && t.length > max) t = t.slice(0, max - 3).trimEnd() + "...";
    return t;
  }

  // A location is only usable if it has real coordinates. The name and
  // timezone are cosmetic and default to empty.
  function validateWeather(raw) {
    const w = raw && typeof raw === "object" ? raw : {};
    const loc = w.location && typeof w.location === "object" ? w.location : {};
    const lat = Number(loc.latitude);
    const lon = Number(loc.longitude);
    const hasCoords = Number.isFinite(lat) && lat >= -90 && lat <= 90 && Number.isFinite(lon) && lon >= -180 && lon <= 180;
    return {
      location: hasCoords
        ? {
            name: typeof loc.name === "string" ? sanitize(loc.name, 60) : "",
            latitude: lat,
            longitude: lon,
            timezone: typeof loc.timezone === "string" ? loc.timezone.slice(0, 60) : "auto",
          }
        : null,
      tempUnit: w.tempUnit === "C" ? "C" : "F",
      windUnit: w.windUnit === "kmh" ? "kmh" : "mph",
    };
  }

  // A schedule window: which days, from when to when, as canonical "HH:MM"
  // strings. end at or before start means the window runs overnight into the
  // next morning ("SAT 20:00-01:00"); windowSegments() below expands any
  // window into non-wrapping per-day segments, so downstream air-state math
  // keeps its start < end invariant.
  function validateWindow(raw, errors, chNumber) {
    if (!raw || typeof raw !== "object") return null;
    const days = (Array.isArray(raw.days) ? raw.days : [])
      .map((d) => String(d).slice(0, 3).toLowerCase())
      .filter((d, i, a) => DAY_KEYS.includes(d) && a.indexOf(d) === i);
    const start = parseHM(raw.start);
    const end = parseHM(raw.end);
    if (!days.length || start == null || end == null || start === end) {
      errors.push("CHANNEL " + chNumber + ": INVALID SCHEDULE WINDOW SKIPPED");
      return null;
    }
    return { days, start: String(raw.start).trim(), end: String(raw.end).trim() };
  }

  // Expand one window into non-wrapping segments: [{ day, start, end }] with
  // day a DAY_KEYS index and minutes satisfying start < end. A normal window
  // yields one segment per day; an overnight window yields an evening
  // segment plus a next-morning segment (dropped when empty, so
  // "20:00-00:00" reads as "until midnight").
  function windowSegments(w) {
    const start = parseHM(w && w.start);
    const end = parseHM(w && w.end);
    const segs = [];
    if (start == null || end == null || !w || !Array.isArray(w.days)) return segs;
    for (const key of w.days) {
      const day = DAY_KEYS.indexOf(key);
      if (day < 0) continue;
      if (start < end) {
        segs.push({ day, start, end });
      } else {
        segs.push({ day, start, end: 1440 });
        if (end > 0) segs.push({ day: (day + 1) % 7, start: 0, end, cont: true });
      }
    }
    return segs;
  }

  // Commercial breaks: { folder, everyMinutes, spots } or null for a channel
  // that plays its folder whole. The spots folder follows the program
  // folder's rule and must be a different folder - a channel interrupting
  // itself with itself is a misclick, not a format.
  function validateBreaks(raw, programFolder, errors, chNumber) {
    if (!raw || typeof raw !== "object") return null;
    const folder = typeof raw.folder === "string" ? raw.folder.trim() : "";
    if (!folder) return null; // the picker's "(none)"
    if (!FOLDER_RE.test(folder) || folder.includes("..")) {
      errors.push("CHANNEL " + chNumber + ": BAD BREAKS FOLDER, BREAKS DROPPED");
      return null;
    }
    if (folder === programFolder) {
      errors.push("CHANNEL " + chNumber + ": BREAKS FOLDER IS THE PROGRAM FOLDER, BREAKS DROPPED");
      return null;
    }
    const e = BREAKS.everyMinutes;
    const k = BREAKS.spots;
    return {
      folder,
      everyMinutes: Math.round(clampNum(raw.everyMinutes, e.min, e.max, e.dflt)),
      spots: Math.round(clampNum(raw.spots, k.min, k.max, k.dflt)),
    };
  }

  // The dial. Absent or empty -> a one-channel system: the classic board as
  // channel 82, so every existing config upgrades without being edited.
  function validateChannels(raw, cfg, errors) {
    const list = Array.isArray(raw.channels) ? raw.channels : [];
    const out = [];
    const seen = new Set();
    for (const c of list) {
      if (!c || typeof c !== "object" || !CHANNEL_TYPES.has(c.type)) {
        errors.push("CHANNEL WITH UNKNOWN TYPE SKIPPED: " + String(c && c.type));
        continue;
      }
      // 0 is a real channel (the guide lives there), so a cleared number
      // input has to arrive as null or "" rather than 0, or an empty field
      // would silently claim channel 0. The control room sends null.
      const rawNumber = c.number === null || c.number === "" ? NaN : Number(c.number);
      const number = Number.isFinite(rawNumber) && rawNumber >= 0 && rawNumber <= 999 ? Math.round(rawNumber) : NaN;
      if (!Number.isFinite(number)) {
        errors.push("CHANNEL WITHOUT A VALID NUMBER (0-999) SKIPPED");
        continue;
      }
      if (seen.has(number)) {
        errors.push("DUPLICATE CHANNEL NUMBER SKIPPED: " + number);
        continue;
      }
      const ch = {
        number,
        type: c.type,
        name: sanitize(c.name, 40) || defaultChannelName(c.type, number, cfg.channelName, cfg.preview && cfg.preview.name),
        enabled: c.enabled !== false,
      };
      if (c.type === "video") {
        const folder = typeof c.folder === "string" ? c.folder.trim() : "";
        if (!FOLDER_RE.test(folder) || folder.includes("..")) {
          errors.push("CHANNEL " + number + ": BAD OR MISSING FOLDER, SKIPPED");
          continue;
        }
        ch.folder = folder;
        const breaks = validateBreaks(c.breaks, folder, errors, number);
        if (breaks) ch.breaks = breaks;
        ch.mode = c.mode === "schedule" ? "schedule" : "continuous";
        ch.order = CHANNEL_ORDERS.has(c.order) ? c.order : "sequence";
        ch.offAir = OFFAIR_MODES.has(c.offAir) ? c.offAir : "testcard";
        ch.titles = TITLE_MODES.has(c.titles) ? c.titles : "filename";
        // The fixed name falls back to the channel's own name, which is
        // usually what a one-subject channel wants the guide to say anyway.
        if (ch.titles === "fixed") ch.title = sanitize(c.title, 40) || ch.name;
        ch.schedule = (Array.isArray(c.schedule) ? c.schedule : [])
          .map((w) => validateWindow(w, errors, number))
          .filter(Boolean);
        if (ch.mode === "schedule" && !ch.schedule.length) {
          errors.push("CHANNEL " + number + ": SCHEDULE MODE WITH NO VALID WINDOWS - ALWAYS OFF AIR");
        }
      }
      if (c.type === "external") {
        const url = typeof c.url === "string" ? c.url.trim() : "";
        if (!/^https?:\/\//i.test(url)) {
          errors.push("CHANNEL " + number + ": EXTERNAL WITHOUT AN HTTP(S) URL, SKIPPED");
          continue;
        }
        ch.url = url.slice(0, 300);
      }
      seen.add(number);
      out.push(ch);
    }
    if (!out.length) {
      // Out of the box: the guide on 0 and the board on 82, the two channels
      // a small cable system always had of its own.
      out.push({ number: 0, name: (cfg.preview && cfg.preview.name) || PREVIEW_DEFAULTS.name, type: "guide", enabled: true });
      out.push({ number: 82, name: cfg.channelName, type: "bulletin", enabled: true });
    }
    // The dial is ordered by number; the number IS the order. Sort before
    // the force-enable below so the enabled fallback is the lowest number,
    // not whichever was listed first.
    out.sort((a, b) => a.number - b.number);
    if (!out.some((c) => c.enabled)) {
      errors.push("NO ENABLED CHANNELS - ENABLING CHANNEL " + out[0].number);
      out[0].enabled = true;
    }
    return out;
  }

  // The tuner: which input sources are live, whether the dial wraps, and
  // what covers a channel change. "static" is an RF tuner slewing between
  // carriers; "black" is the blanked raster of a later cable box; "none" is
  // a hard cut.
  const CUT_STYLES = ["static", "black", "none"];
  // And what switching off looks like. "crt" collapses the picture the way a
  // tube does when it loses power: the vertical deflection dies first, so the
  // raster folds into one bright line while the beam still sweeps, then the
  // high voltage drops, the line pulls in to a dot, and the phosphor fades.
  // "black" is a flat panel: gone the moment you press it.
  const POWER_STYLES = ["crt", "black"];
  function validateTuner(raw) {
    const t = raw && typeof raw === "object" ? raw : {};
    const src = t.sources && typeof t.sources === "object" ? t.sources : {};
    const on = (v, dflt) => (typeof v === "boolean" ? v : dflt);
    return {
      sources: {
        keyboard: on(src.keyboard, true),
        gamepad: on(src.gamepad, true),
        http: on(src.http, true),
      },
      wrap: on(t.wrap, true),
      cut: CUT_STYLES.includes(t.cut) ? t.cut : "static",
      power: POWER_STYLES.includes(t.power) ? t.power : "crt",
    };
  }

  // ---------------------------------------------------------- validateConfig

  // Takes the raw editable config (parsed config.json) and returns
  // { ok, cfg, errors }. cfg is the clamped, sanitized runtime shape - also
  // exactly what gets written back to config.json, so validation and
  // persistence never drift.
  function validateConfig(raw) {
    if (!raw || typeof raw !== "object") {
      return { ok: false, errors: ["CONFIG IS MISSING OR DID NOT LOAD"] };
    }
    const errors = [];
    const cfg = {};

    cfg.channelName = typeof raw.channelName === "string" && raw.channelName.trim() ? raw.channelName.trim() : "CABLE 82";
    cfg.tagline = typeof raw.tagline === "string" ? raw.tagline.trim() : "";
    cfg.timeFormat = raw.timeFormat === "24h" ? "24h" : "12h";
    cfg.port = Math.round(clampNum(raw.port, 1, 65535, 1982));
    cfg.pageSeconds = clampNum(raw.pageSeconds, 3, 120, 12);
    cfg.refreshMinutes = clampNum(raw.refreshMinutes, 1, 1440, 10);
    cfg.maxItemsPerFeed = Math.round(clampNum(raw.maxItemsPerFeed, 1, 100, 20));
    // Overscan is per axis. A file from before the split carried one
    // overscanPercent; it seeds both axes and is not written back.
    const legacyOverscan = clampNum(raw.overscanPercent, 0, 15, 7);
    cfg.overscanX = clampNum(raw.overscanX, 0, 15, legacyOverscan);
    cfg.overscanY = clampNum(raw.overscanY, 0, 15, legacyOverscan);
    cfg.crtMode = raw.crtMode === true;
    cfg.crtInkText = raw.crtInkText === true;
    cfg.textScale = clampNum(raw.textScale, 1, 1.5, 1);
    cfg.dailyReloadHour =
      raw.dailyReloadHour === false || raw.dailyReloadHour === null
        ? false
        : Math.round(clampNum(raw.dailyReloadHour, 0, 23, 4));
    cfg.facts = (Array.isArray(raw.facts) ? raw.facts : []).map((t) => sanitize(t, 200)).filter(Boolean);
    cfg.dadJokes = (Array.isArray(raw.dadJokes) ? raw.dadJokes : []).map((t) => sanitize(t, 200)).filter(Boolean);
    cfg.weather = validateWeather(raw.weather);

    const rawMusic = raw.music && typeof raw.music === "object" ? raw.music : {};
    cfg.music = {
      enabled: typeof rawMusic.enabled === "boolean" ? rawMusic.enabled : true,
      shuffle: typeof rawMusic.shuffle === "boolean" ? rawMusic.shuffle : true,
      volume: Math.round(clampNum(rawMusic.volume, 0, 100, 60)),
    };

    const rawCheer = raw.cheerlights && typeof raw.cheerlights === "object" ? raw.cheerlights : {};
    cfg.cheerlights = {
      enabled: typeof rawCheer.enabled === "boolean" ? rawCheer.enabled : true,
      template:
        typeof rawCheer.template === "string" && rawCheer.template.trim()
          ? sanitize(rawCheer.template, 120)
          : "THE WORLD IS SET TO {COLOR}",
    };

    cfg.feeds = (Array.isArray(raw.feeds) ? raw.feeds : [])
      .filter((f) => f && typeof f.id === "string" && f.id.trim() && typeof f.url === "string" && f.url.trim())
      .map((f) => ({
        id: f.id.trim(),
        label: typeof f.label === "string" && f.label.trim() ? f.label.trim() : f.id.trim().toUpperCase(),
        url: f.url.trim(),
      }));
    const feedIds = new Set(cfg.feeds.map((f) => f.id));

    const rawRotation = Array.isArray(raw.rotation) && raw.rotation.length ? raw.rotation : DEFAULT_ROTATION;
    cfg.rotation = rawRotation.filter((slot) => {
      if (!slot || !TYPES.has(slot.type)) {
        errors.push("UNKNOWN ROTATION TYPE SKIPPED");
        return false;
      }
      if (slot.type === "headlines" && !feedIds.has(slot.feed)) {
        errors.push("HEADLINES SLOT WITH UNKNOWN FEED SKIPPED: " + String(slot.feed));
        return false;
      }
      return true;
    }).map((slot) => (slot.type === "headlines" ? { type: "headlines", feed: slot.feed } : { type: slot.type }));
    if (!cfg.rotation.length) cfg.rotation = [{ type: "clock" }];

    const rawCrawl = raw.crawl && typeof raw.crawl === "object" ? raw.crawl : {};
    const crawlFeeds = (Array.isArray(rawCrawl.feeds) ? rawCrawl.feeds : [...feedIds]).filter((id) => {
      if (feedIds.has(id)) return true;
      errors.push("CRAWL FEED UNKNOWN, SKIPPED: " + String(id));
      return false;
    });
    cfg.crawl = {
      feeds: crawlFeeds,
      secondsPerScreen: clampNum(rawCrawl.secondsPerScreen, 2, 60, 9),
      separator: typeof rawCrawl.separator === "string" ? rawCrawl.separator.slice(0, 16) : "  ■  ",
      // Fixed label pinned to the left of the ticker. "" hides the flag.
      flag: typeof rawCrawl.flag === "string" ? sanitize(rawCrawl.flag, 16) : "LATEST",
    };

    cfg.messages = (Array.isArray(raw.messages) ? raw.messages : [])
      .filter((m) => m && typeof m.text === "string" && m.text.trim())
      .map((m) => ({ text: sanitize(m.text, 200), color: typeof m.color === "string" ? m.color : null }))
      .filter((m) => m.text);

    const rawPrev = raw.preview && typeof raw.preview === "object" ? raw.preview : {};
    cfg.preview = {
      name: sanitize(rawPrev.name, 40) || PREVIEW_DEFAULTS.name,
      // A cleared tagline is a choice: the wordmark stands alone. Only an
      // absent one falls back to the default.
      tagline: rawPrev.tagline === undefined ? PREVIEW_DEFAULTS.tagline : sanitize(rawPrev.tagline, 60),
      slots: Math.round(clampNum(rawPrev.slots, GUIDE.slots.min, GUIDE.slots.max, GUIDE.slots.dflt)),
      scrollSeconds: Math.round(
        clampNum(rawPrev.scrollSeconds, GUIDE.scrollSeconds.min, GUIDE.scrollSeconds.max, GUIDE.scrollSeconds.dflt)
      ),
      seconds: rawPrev.seconds !== false,
      background: typeof rawPrev.background === "string" && PALETTE[rawPrev.background] ? rawPrev.background : "blue",
    };

    cfg.channels = validateChannels(raw, cfg, errors);
    cfg.tuner = validateTuner(raw.tuner);

    const rawColors = raw.colors && typeof raw.colors === "object" ? raw.colors : {};
    let cycle = Array.isArray(rawColors.pageCycle) ? rawColors.pageCycle.filter((c) => typeof c === "string") : [];
    if (!cycle.length) cycle = ["blue", "green", "red", "cyan"];
    cfg.colors = {
      pageCycle: cycle,
      headerBg: typeof rawColors.headerBg === "string" ? rawColors.headerBg : "blue",
      crawlBg: typeof rawColors.crawlBg === "string" ? rawColors.crawlBg : "ink",
    };

    return { ok: true, cfg, errors };
  }

  return {
    PALETTE,
    PALETTE_CRT,
    DAY_KEYS,
    DEFAULT_CONFIG,
    PREVIEW_DEFAULTS,
    clampNum,
    resolveColor,
    textColorFor,
    sanitize,
    naturalCompare,
    weatherText,
    parseHM,
    FOLDER_RE,
    BREAKS,
    GUIDE,
    windowSegments,
    validateConfig,
  };
});
