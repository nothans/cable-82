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

  // Text color paired with each background so contrast never dies.
  const TEXT_ON = {
    blue: "white", green: "white", red: "white", magenta: "white",
    cyan: "ink", yellow: "ink", white: "ink", ink: "white",
  };

  const TYPES = new Set(["clock", "messages", "facts", "dadjokes", "weather", "headlines"]);
  const DEFAULT_ROTATION = [{ type: "clock" }, { type: "messages" }, { type: "facts" }];

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
        country: "United States",
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
    overscanPercent: 7,
    dailyReloadHour: 4,
  };

  // ---------------------------------------------------------- helpers

  function clampNum(v, min, max, dflt) {
    // Only real numbers and numeric strings count; null/false/"" fall back.
    if (typeof v !== "number" && (typeof v !== "string" || !v.trim())) return dflt;
    const n = Number(v);
    return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : dflt;
  }

  function resolveColor(name, fallbackName) {
    if (typeof name === "string") {
      if (PALETTE[name]) return PALETTE[name];
      if (/^#([0-9a-f]{3}|[0-9a-f]{6})$/i.test(name)) return name;
    }
    return PALETTE[fallbackName] || PALETTE.blue;
  }

  function textColorFor(bgName) {
    if (TEXT_ON[bgName]) return PALETTE[TEXT_ON[bgName]];
    // Raw hex backgrounds: pick text by luminance so contrast never dies.
    const m = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(typeof bgName === "string" ? bgName : "");
    if (m) {
      let h = m[1];
      if (h.length === 3) h = h.replace(/./g, (c) => c + c);
      const lum =
        0.2126 * parseInt(h.slice(0, 2), 16) +
        0.7152 * parseInt(h.slice(2, 4), 16) +
        0.0722 * parseInt(h.slice(4, 6), 16);
      return lum > 145 ? PALETTE.ink : PALETTE.white;
    }
    return PALETTE.white;
  }

  // Normalize text to what an 8x16 character generator can show: map
  // typographic punctuation to ASCII, drop everything outside printable
  // Latin-1 (emoji included), collapse whitespace, cap length.
  function sanitize(text, max = 160) {
    if (typeof text !== "string") return "";
    let t = text
      .replace(/[‘’‚′]/g, "'")
      .replace(/[“”„″]/g, '"')
      .replace(/[–—―−]/g, "-")
      .replace(/…/g, "...")
      .replace(/[  -​ 　]/g, " ");
    t = t.replace(/\s+/g, " "); // newlines/tabs become spaces before the strip
    t = t.replace(/[^\x20-\x7E¡-ÿ•■▪]/g, "");
    t = t.replace(/\s+/g, " ").trim(); // stripping can merge two spaces
    if (max >= 4 && t.length > max) t = t.slice(0, max - 3).trimEnd() + "...";
    return t;
  }

  // A location is only usable if it has real coordinates. Everything else
  // (name, timezone, country) is cosmetic and defaults to empty.
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
            country: typeof loc.country === "string" ? sanitize(loc.country, 60) : "",
          }
        : null,
      tempUnit: w.tempUnit === "C" ? "C" : "F",
      windUnit: w.windUnit === "kmh" ? "kmh" : "mph",
    };
  }

  // ---------------------------------------------------------- validateConfig

  // Takes the raw editable config (parsed JSON, or the config.js global for
  // back-compat) and returns { ok, cfg, errors }. cfg is the clamped,
  // sanitized runtime shape - also exactly what gets written back to
  // config.json, so validation and persistence never drift.
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
    cfg.overscanPercent = clampNum(raw.overscanPercent, 0, 15, 7);
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
    TEXT_ON,
    TYPES,
    DEFAULT_CONFIG,
    clampNum,
    resolveColor,
    textColorFor,
    sanitize,
    weatherText,
    validateConfig,
  };
});
