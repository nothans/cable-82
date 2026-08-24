/* cable-82 control room. Reads and writes config.json through /api/config.
   Validation is the server's job (shared config-schema.js); this page just
   gathers a clean config object and shows what came back. No dependencies. */
(() => {
  "use strict";

  const S = window.Cable82Schema || {};
  const PALETTE = S.PALETTE || {};
  // The names offered in color pickers and the page cycle, in display order.
  const COLOR_NAMES = ["blue", "cyan", "green", "yellow", "red", "magenta", "white", "ink"];
  const ROTATION_TYPES = [
    ["clock", "Clock"],
    ["messages", "Messages"],
    ["facts", "Facts"],
    ["dadjokes", "Dad jokes"],
    ["weather", "Weather"],
    ["headlines", "Headlines"],
  ];

  // Working copy of the arrays the user edits row by row. Scalars are read
  // straight from their inputs at save time; these three need their own state.
  let feeds = [];
  let rotation = [];
  let messages = [];
  let crawlFeeds = [];
  let pageCycle = [];
  let wxLocation = null; // { name, latitude, longitude, timezone, country } or null
  let bootVersion = null;

  // Textareas hold one item per line; split/join at the config boundary.
  const linesToArray = (text) => text.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);

  // ---------------------------------------------------------- tiny DOM helpers

  const $ = (id) => document.getElementById(id);

  function el(tag, props, children) {
    const n = document.createElement(tag);
    if (props) {
      for (const k in props) {
        if (k === "class") n.className = props[k];
        else if (k === "text") n.textContent = props[k];
        else if (k === "html") n.innerHTML = props[k];
        else if (k.startsWith("on") && typeof props[k] === "function") n.addEventListener(k.slice(2), props[k]);
        else if (props[k] != null) n.setAttribute(k, props[k]);
      }
    }
    for (const c of [].concat(children || [])) {
      if (c == null) continue;
      n.appendChild(typeof c === "string" ? document.createTextNode(c) : c);
    }
    return n;
  }

  function option(value, label, selected) {
    const o = el("option", { value }, label);
    if (selected) o.selected = true;
    return o;
  }

  // ---------------------------------------------------------- render: feeds

  function renderFeeds() {
    const host = $("feeds");
    host.innerHTML = "";
    if (!feeds.length) {
      host.appendChild(el("div", { class: "empty" }, "No feeds yet. Add one to put headlines on the air."));
    }
    feeds.forEach((f, i) => {
      host.appendChild(
        el("div", { class: "item feed-item" }, [
          el("input", {
            type: "text", class: "mono", value: f.id, placeholder: "id",
            "aria-label": "Feed id",
            oninput: (e) => { f.id = e.target.value; },
            onchange: () => { syncFeedDependents(); },
          }),
          el("input", {
            type: "text", value: f.label, placeholder: "LABEL",
            "aria-label": "Feed label",
            oninput: (e) => { f.label = e.target.value; },
          }),
          el("input", {
            type: "url", class: "mono", value: f.url, placeholder: "https://example.com/feed",
            "aria-label": "Feed URL",
            oninput: (e) => { f.url = e.target.value; },
          }),
          el("div", { class: "row-actions" }, [
            el("button", {
              type: "button", class: "icon danger", title: "Remove feed", "aria-label": "Remove feed",
              onclick: () => { feeds.splice(i, 1); renderFeeds(); syncFeedDependents(); },
            }, "✕"),
          ]),
        ])
      );
    });
  }

  // Rotation feed selects and crawl-feed chips reference feed ids, so rebuild
  // them whenever the feed list or an id changes.
  function syncFeedDependents() {
    const ids = new Set(feeds.map((f) => f.id).filter(Boolean));
    rotation.forEach((slot) => {
      if (slot.type === "headlines" && !ids.has(slot.feed)) slot.feed = feeds[0] ? feeds[0].id : "";
    });
    crawlFeeds = crawlFeeds.filter((id) => ids.has(id));
    renderRotation();
    renderCrawlFeeds();
  }

  // ---------------------------------------------------------- render: rotation

  function renderRotation() {
    const host = $("rotation");
    host.innerHTML = "";
    if (!rotation.length) {
      host.appendChild(el("div", { class: "empty" }, "No pages yet. Add at least one."));
    }
    rotation.forEach((slot, i) => {
      const typeSel = el("select", {
        "aria-label": "Page type",
        onchange: (e) => {
          slot.type = e.target.value;
          if (slot.type === "headlines" && !slot.feed) slot.feed = feeds[0] ? feeds[0].id : "";
          renderRotation();
        },
      }, ROTATION_TYPES.map(([v, label]) => option(v, label, v === slot.type)));

      let feedSel;
      if (slot.type === "headlines") {
        feedSel = el("select", {
          "aria-label": "Feed for this slot",
          onchange: (e) => { slot.feed = e.target.value; },
        }, feeds.length
          ? feeds.map((f) => option(f.id, f.label || f.id, f.id === slot.feed))
          : [option("", "(add a feed first)", true)]);
      } else {
        feedSel = el("span", { class: "note" }, "");
      }

      host.appendChild(
        el("div", { class: "item rot-item" }, [
          el("span", { class: "grip" }, String(i + 1)),
          typeSel,
          feedSel,
          el("div", { class: "row-actions" }, [
            el("button", { type: "button", class: "icon", title: "Move up", "aria-label": "Move up", disabled: i === 0 ? "" : null,
              onclick: () => { if (i > 0) { [rotation[i - 1], rotation[i]] = [rotation[i], rotation[i - 1]]; renderRotation(); } } }, "↑"),
            el("button", { type: "button", class: "icon", title: "Move down", "aria-label": "Move down", disabled: i === rotation.length - 1 ? "" : null,
              onclick: () => { if (i < rotation.length - 1) { [rotation[i + 1], rotation[i]] = [rotation[i], rotation[i + 1]]; renderRotation(); } } }, "↓"),
            el("button", { type: "button", class: "icon danger", title: "Remove page", "aria-label": "Remove page",
              onclick: () => { rotation.splice(i, 1); renderRotation(); } }, "✕"),
          ]),
        ])
      );
    });
  }

  // ---------------------------------------------------------- render: messages

  function renderMessages() {
    const host = $("messages");
    host.innerHTML = "";
    if (!messages.length) {
      host.appendChild(el("div", { class: "empty" }, "No messages yet. Add a welcome, a bake sale, a lost dog."));
    }
    messages.forEach((m, i) => {
      const colorSel = el("select", {
        "aria-label": "Message color",
        onchange: (e) => { m.color = e.target.value || null; },
      }, [option("", "Auto (cycle)", !m.color)].concat(
        COLOR_NAMES.map((c) => option(c, c.toUpperCase(), m.color === c))
      ));
      host.appendChild(
        el("div", { class: "item msg-item" }, [
          el("input", {
            type: "text", value: m.text, placeholder: "HAPPY BIRTHDAY, RIVER",
            "aria-label": "Message text", maxlength: "200",
            oninput: (e) => { m.text = e.target.value; },
          }),
          colorSel,
          el("div", { class: "row-actions" }, [
            el("button", { type: "button", class: "icon danger", title: "Remove message", "aria-label": "Remove message",
              onclick: () => { messages.splice(i, 1); renderMessages(); } }, "✕"),
          ]),
        ])
      );
    });
  }

  // ---------------------------------------------------------- render: chips

  function colorChip(name, pressed, onToggle) {
    const sw = el("span", { class: "sw" });
    sw.style.background = PALETTE[name] || "#888";
    const chip = el("button", {
      type: "button", class: "chip", "aria-pressed": pressed ? "true" : "false",
      onclick: () => onToggle(chip),
    }, [sw, name.toUpperCase()]);
    return chip;
  }

  function plainChip(label, pressed, onToggle) {
    const chip = el("button", {
      type: "button", class: "chip", "aria-pressed": pressed ? "true" : "false",
      onclick: () => onToggle(chip),
    }, label);
    return chip;
  }

  function renderPageCycle() {
    const host = $("pageCycle");
    host.innerHTML = "";
    COLOR_NAMES.forEach((name) => {
      const on = pageCycle.includes(name);
      host.appendChild(colorChip(name, on, (chip) => {
        if (pageCycle.includes(name)) pageCycle = pageCycle.filter((c) => c !== name);
        else pageCycle.push(name);
        chip.setAttribute("aria-pressed", pageCycle.includes(name) ? "true" : "false");
      }));
    });
  }

  function renderCrawlFeeds() {
    const host = $("crawlFeeds");
    host.innerHTML = "";
    if (!feeds.length) {
      host.appendChild(el("span", { class: "note" }, "Add a feed to give the ticker something to scroll."));
      return;
    }
    feeds.forEach((f) => {
      if (!f.id) return;
      const on = crawlFeeds.includes(f.id);
      host.appendChild(plainChip(f.label || f.id, on, (chip) => {
        if (crawlFeeds.includes(f.id)) crawlFeeds = crawlFeeds.filter((id) => id !== f.id);
        else crawlFeeds.push(f.id);
        chip.setAttribute("aria-pressed", crawlFeeds.includes(f.id) ? "true" : "false");
      }));
    });
  }

  // ---------------------------------------------------------- load & fill

  function fillColorSelect(id, value) {
    const sel = $(id);
    sel.innerHTML = "";
    COLOR_NAMES.forEach((c) => sel.appendChild(option(c, c.toUpperCase(), c === value)));
  }

  function fillReloadSelect(value) {
    const sel = $("f-dailyReloadHour");
    sel.innerHTML = "";
    sel.appendChild(option("off", "Off", value === false));
    for (let h = 0; h < 24; h++) {
      const label = (h === 0 ? "12 AM" : h < 12 ? h + " AM" : h === 12 ? "12 PM" : (h - 12) + " PM");
      sel.appendChild(option(String(h), label, value === h));
    }
  }

  function fill(cfg) {
    $("f-channelName").value = cfg.channelName || "";
    $("f-tagline").value = cfg.tagline || "";
    $("f-timeFormat").value = cfg.timeFormat === "24h" ? "24h" : "12h";
    $("f-port").value = cfg.port != null ? cfg.port : 1982;
    $("f-pageSeconds").value = cfg.pageSeconds;
    $("f-refreshMinutes").value = cfg.refreshMinutes;
    $("f-maxItemsPerFeed").value = cfg.maxItemsPerFeed;
    $("f-overscanX").value = cfg.overscanX != null ? cfg.overscanX : cfg.overscanPercent;
    $("f-overscanY").value = cfg.overscanY != null ? cfg.overscanY : cfg.overscanPercent;
    $("f-crtMode").checked = cfg.crtMode === true;
    $("f-crtInkText").checked = cfg.crtInkText === true;
    $("f-textScale").value = cfg.textScale != null ? cfg.textScale : 1;
    fillReloadSelect(cfg.dailyReloadHour);

    const crawl = cfg.crawl || {};
    $("f-crawlFlag").value = crawl.flag != null ? crawl.flag : "";
    $("f-crawlSeconds").value = crawl.secondsPerScreen != null ? crawl.secondsPerScreen : 9;
    $("f-crawlSeparator").value = crawl.separator != null ? crawl.separator : "  ■  ";

    const colors = cfg.colors || {};
    fillColorSelect("f-headerBg", colors.headerBg || "blue");
    fillColorSelect("f-crawlBg", colors.crawlBg || "ink");

    $("f-facts").value = (cfg.facts || []).join("\n");
    $("f-dadJokes").value = (cfg.dadJokes || []).join("\n");
    updateCounts();

    const weather = cfg.weather || {};
    const wloc = weather.location;
    wxLocation = wloc && Number.isFinite(wloc.latitude)
      ? { name: wloc.name || "", latitude: wloc.latitude, longitude: wloc.longitude, timezone: wloc.timezone || "auto", country: wloc.country || "" }
      : null;
    $("f-tempUnit").value = weather.tempUnit === "C" ? "C" : "F";
    $("f-windUnit").value = weather.windUnit === "kmh" ? "kmh" : "mph";
    $("f-wxTimezone").value = wxLocation ? wxLocation.timezone : "";
    renderWxCurrent();

    const music = cfg.music || {};
    $("f-musicEnabled").checked = music.enabled !== false;
    $("f-musicShuffle").checked = music.shuffle !== false;
    $("f-musicVolume").value = music.volume != null ? music.volume : 60;
    updateVolumeOut();
    renderTrackList();

    const cheer = cfg.cheerlights || {};
    $("f-cheerEnabled").checked = cheer.enabled !== false;
    $("f-cheerTemplate").value = cheer.template || "THE WORLD IS SET TO {COLOR}";

    feeds = (cfg.feeds || []).map((f) => ({ id: f.id, label: f.label, url: f.url }));
    rotation = (cfg.rotation || []).map((s) => (s.type === "headlines" ? { type: "headlines", feed: s.feed } : { type: s.type }));
    messages = (cfg.messages || []).map((m) => ({ text: m.text, color: m.color || null }));
    crawlFeeds = (crawl.feeds || []).slice();
    pageCycle = (colors.pageCycle && colors.pageCycle.length ? colors.pageCycle : ["blue", "green", "red", "cyan"]).slice();

    renderFeeds();
    renderRotation();
    renderMessages();
    renderCrawlFeeds();
    renderPageCycle();
  }

  // ---------------------------------------------------------- weather

  function renderWxCurrent() {
    const host = $("wxCurrent");
    host.innerHTML = "";
    if (wxLocation && Number.isFinite(wxLocation.latitude)) {
      host.appendChild(el("span", null, wxLocation.name || "Selected location"));
      host.appendChild(el("span", { class: "muted" },
        "  (" + wxLocation.latitude.toFixed(2) + ", " + wxLocation.longitude.toFixed(2) + ")"));
    } else {
      host.appendChild(el("span", { class: "muted" }, "No location set - search for your town below."));
    }
  }

  function chooseWxLocation(r) {
    wxLocation = {
      name: [r.name, r.admin1, r.country].filter(Boolean).join(", "),
      latitude: r.latitude,
      longitude: r.longitude,
      timezone: r.timezone || "auto",
      country: r.country || "",
    };
    $("f-wxTimezone").value = wxLocation.timezone;
    $("wxResults").innerHTML = "";
    $("wxSearch").value = "";
    renderWxCurrent();
  }

  async function lookupWx() {
    const q = $("wxSearch").value.trim();
    const host = $("wxResults");
    if (!q) return;
    host.innerHTML = "";
    host.appendChild(el("div", { class: "note" }, "Searching…"));
    try {
      const r = await fetch("api/geocode?q=" + encodeURIComponent(q), { cache: "no-store" });
      const j = await r.json().catch(() => ({}));
      host.innerHTML = "";
      const results = (j.results || []);
      if (!results.length) {
        host.appendChild(el("div", { class: "note" }, "No matches for “" + q + "”."));
        return;
      }
      results.forEach((res) => {
        const label = [res.name, res.admin1, res.country].filter(Boolean).join(", ");
        host.appendChild(el("button", {
          type: "button", class: "small wx-result",
          onclick: () => chooseWxLocation(res),
        }, label));
      });
    } catch (e) {
      host.innerHTML = "";
      host.appendChild(el("div", { class: "note" }, "Lookup failed. Is the channel online?"));
    }
  }

  function updateCounts() {
    const nf = linesToArray($("f-facts").value).length;
    const nj = linesToArray($("f-dadJokes").value).length;
    $("factsCount").textContent = nf ? "(" + nf + ")" : "";
    $("jokesCount").textContent = nj ? "(" + nj + ")" : "";
  }

  function updateVolumeOut() {
    $("musicVolumeOut").textContent = $("f-musicVolume").value + "%";
  }

  async function renderTrackList() {
    const host = $("trackList");
    const count = $("trackCount");
    host.innerHTML = "";
    try {
      const r = await fetch("api/music", { cache: "no-store" });
      const j = await r.json();
      const tracks = j.tracks || [];
      count.textContent = tracks.length ? "(" + tracks.length + ")" : "";
      if (!tracks.length) {
        host.appendChild(el("div", { class: "empty" }, "No tracks yet - drop audio files into the music/ folder, then reload."));
        return;
      }
      tracks.forEach((t, i) => {
        host.appendChild(el("div", null, [
          el("span", { class: "num" }, String(i + 1).padStart(2, "0")),
          t.file,
        ]));
      });
    } catch (e) {
      count.textContent = "";
      host.appendChild(el("div", { class: "empty" }, "Could not read the music folder."));
    }
  }

  function setStatus(text, kind) {
    const s = $("status");
    s.textContent = text;
    s.className = "status" + (kind ? " " + kind : "");
    // Clear any prior warnings list.
    const old = document.querySelector(".savebar .warnings");
    if (old) old.remove();
  }

  async function load() {
    setStatus("Loading current channel…");
    try {
      const r = await fetch("api/config", { cache: "no-store" });
      if (!r.ok) throw new Error("HTTP " + r.status);
      const j = await r.json();
      bootVersion = j.version;
      fill(j.config);
      $("app").setAttribute("aria-busy", "false");
      $("save").disabled = false;
      setStatus("Loaded. Edit anything, then Save.");
      startDriftWatch();
    } catch (e) {
      setStatus("Could not reach the server (" + e.message + "). Is CABLE 82 running?", "err");
    }
  }

  // Warn if config.json moves while this screen is open (a hand edit, or a
  // save from another tab). The form keeps your edits either way; a stale
  // Save is refused by the server, so this is the early heads-up.
  let driftTimer = null;
  function startDriftWatch() {
    if (driftTimer) return;
    driftTimer = setInterval(async () => {
      try {
        const r = await fetch("api/config", { cache: "no-store" });
        if (!r.ok) return;
        const j = await r.json();
        if (bootVersion && j.version && j.version !== bootVersion) {
          setStatus("config.json changed outside this screen. Reload the page to load it; a stale Save will be refused.", "warn");
        }
      } catch (e) {
        /* offline: the save path reports it */
      }
    }, 20000);
  }

  // ---------------------------------------------------------- gather & save

  function numVal(id) {
    const v = $(id).value.trim();
    return v === "" ? undefined : Number(v);
  }

  function gather() {
    const reload = $("f-dailyReloadHour").value;
    return {
      channelName: $("f-channelName").value,
      tagline: $("f-tagline").value,
      timeFormat: $("f-timeFormat").value,
      port: numVal("f-port"),
      pageSeconds: numVal("f-pageSeconds"),
      refreshMinutes: numVal("f-refreshMinutes"),
      maxItemsPerFeed: numVal("f-maxItemsPerFeed"),
      overscanX: numVal("f-overscanX"),
      overscanY: numVal("f-overscanY"),
      crtMode: $("f-crtMode").checked,
      crtInkText: $("f-crtInkText").checked,
      textScale: numVal("f-textScale"),
      dailyReloadHour: reload === "off" ? false : Number(reload),
      facts: linesToArray($("f-facts").value),
      dadJokes: linesToArray($("f-dadJokes").value),
      weather: {
        location: wxLocation
          ? {
              name: wxLocation.name,
              latitude: wxLocation.latitude,
              longitude: wxLocation.longitude,
              timezone: $("f-wxTimezone").value.trim() || "auto",
              country: wxLocation.country,
            }
          : null,
        tempUnit: $("f-tempUnit").value,
        windUnit: $("f-windUnit").value,
      },
      music: {
        enabled: $("f-musicEnabled").checked,
        shuffle: $("f-musicShuffle").checked,
        volume: Number($("f-musicVolume").value),
      },
      cheerlights: {
        enabled: $("f-cheerEnabled").checked,
        template: $("f-cheerTemplate").value,
      },
      feeds: feeds.map((f) => ({ id: f.id, label: f.label, url: f.url })),
      rotation: rotation.map((s) => (s.type === "headlines" ? { type: "headlines", feed: s.feed } : { type: s.type })),
      messages: messages.map((m) => ({ text: m.text, color: m.color })),
      crawl: {
        feeds: crawlFeeds.slice(),
        secondsPerScreen: numVal("f-crawlSeconds"),
        separator: $("f-crawlSeparator").value,
        flag: $("f-crawlFlag").value,
      },
      colors: {
        pageCycle: pageCycle.slice(),
        headerBg: $("f-headerBg").value,
        crawlBg: $("f-crawlBg").value,
      },
    };
  }

  function showWarnings(list) {
    if (!list || !list.length) return;
    const ul = el("ul", { class: "warnings" }, list.map((w) => el("li", null, w)));
    $("status").after(ul);
  }

  async function save() {
    const btn = $("save");
    btn.disabled = true;
    setStatus("Saving…");
    try {
      const headers = { "content-type": "application/json", "x-cable82-config": "1" };
      if (bootVersion) headers["x-cable82-config-version"] = bootVersion;
      const r = await fetch("api/config", {
        method: "POST",
        headers,
        body: JSON.stringify(gather()),
      });
      const j = await r.json().catch(() => ({}));
      if (r.status === 409 || j.conflict) {
        setStatus("config.json changed outside this screen (a hand edit or another tab). Reload the page to load it, then redo your change.", "err");
        btn.disabled = false;
        return;
      }
      if (!r.ok || j.ok === false) {
        setStatus("Save rejected.", "err");
        showWarnings(j.errors || ["The server refused the change."]);
        btn.disabled = false;
        return;
      }
      bootVersion = j.version;
      fill(j.config); // reflect the canonical, cleaned-up config
      const cleaned = [];
      if (j.warnings && j.warnings.length) cleaned.push.apply(cleaned, j.warnings);
      setStatus("Saved. The channel updates within about 20 seconds.", cleaned.length ? "warn" : "ok");
      showWarnings(cleaned);
      btn.disabled = false;
    } catch (e) {
      setStatus("Save failed (" + e.message + ").", "err");
      btn.disabled = false;
    }
  }

  // ---------------------------------------------------------- wire up

  document.addEventListener("DOMContentLoaded", () => {
    $("addFeed").addEventListener("click", () => { feeds.push({ id: "", label: "", url: "" }); renderFeeds(); });
    $("addSlot").addEventListener("click", () => {
      rotation.push(feeds.length ? { type: "headlines", feed: feeds[0].id } : { type: "clock" });
      renderRotation();
    });
    $("addMessage").addEventListener("click", () => { messages.push({ text: "", color: null }); renderMessages(); });
    $("f-facts").addEventListener("input", updateCounts);
    $("f-dadJokes").addEventListener("input", updateCounts);
    $("wxLookup").addEventListener("click", lookupWx);
    $("wxSearch").addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); lookupWx(); } });
    $("f-musicVolume").addEventListener("input", updateVolumeOut);
    $("save").addEventListener("click", save);
    $("revert").addEventListener("click", load);
    load();
  });
})();
