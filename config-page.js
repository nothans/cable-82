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
  let channels = []; // the dial, edited row by row like the lists above
  let channelFolders = []; // [{folder, files, seconds, probed}] from /api/channels
  let wxLocation = null; // { name, latitude, longitude, timezone, country } or null
  let bootVersion = null;

  const DAY_KEYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];
  const DAY_LABELS = ["Su", "Mo", "Tu", "We", "Th", "Fr", "Sa"];
  const CHANNEL_TYPE_OPTIONS = [
    ["bulletin", "Bulletin board"],
    ["video", "Video folder"],
    ["external", "External page"],
  ];
  const OFFAIR_OPTIONS = [
    ["testcard", "Test card"],
    ["bars", "Color bars"],
    ["snow", "Static"],
    ["bulletin", "Bulletin board"],
  ];

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

  // ---------------------------------------------------------- render: channels

  function folderLabel(f) {
    const mins = Math.round(f.seconds / 60);
    const dur = f.probed < f.files ? f.files + " files" : f.files + " files, " + (mins >= 60 ? Math.floor(mins / 60) + "h " + (mins % 60) + "m" : mins + "m");
    return f.folder + "  (" + dur + ")";
  }

  function renderChannels() {
    const host = $("channelList");
    host.innerHTML = "";
    if (!channels.length) {
      host.appendChild(el("div", { class: "empty" }, "No channels: the board runs alone as channel 82. Add one to grow the dial."));
    }
    // The number IS the order, so rows sort themselves and need no arrows.
    channels.sort((a, b) => (a.number || 0) - (b.number || 0));
    channels.forEach((ch, i) => {
      const head = el("div", { class: "ch-head" }, [
        el("input", {
          class: "ch-number", type: "number", min: 1, max: 999, value: ch.number != null ? ch.number : "",
          "aria-label": "Channel number", placeholder: "82",
          onchange: (e) => { ch.number = Number(e.target.value); renderChannels(); },
        }),
        el("input", {
          class: "ch-name", type: "text", maxlength: 40, value: ch.name || "",
          "aria-label": "Channel name", placeholder: ch.type === "bulletin" ? "CABLE 82" : "CHANNEL NAME",
          onchange: (e) => { ch.name = e.target.value; },
        }),
        el("select", {
          "aria-label": "Channel type",
          onchange: (e) => { ch.type = e.target.value; renderChannels(); },
        }, CHANNEL_TYPE_OPTIONS.map(([v, label]) => option(v, label, v === ch.type))),
        el("label", { class: "toggle" }, [
          (() => { const c = el("input", { type: "checkbox", "aria-label": "Channel enabled" }); c.checked = ch.enabled !== false; c.addEventListener("change", () => { ch.enabled = c.checked; }); return c; })(),
          " on the dial",
        ]),
        el("div", { class: "row-actions" }, [
          el("button", { type: "button", class: "icon danger", title: "Remove channel", "aria-label": "Remove channel",
            onclick: () => { channels.splice(i, 1); renderChannels(); } }, "✕"),
        ]),
      ]);

      const body = el("div", { class: "ch-body" });
      if (ch.type === "bulletin") {
        body.appendChild(el("span", { class: "note" }, "Shows the board: the page rotation below is this channel's lineup."));
      } else if (ch.type === "external") {
        body.appendChild(el("input", {
          type: "url", style: "flex:1;min-width:14em", value: ch.url || "", placeholder: "http://localhost:8080/  (ws4kp, say)",
          "aria-label": "External URL",
          onchange: (e) => { ch.url = e.target.value; },
        }));
      } else {
        // video: folder picker (never a typed path), mode, order, off-air look
        const known = channelFolders.some((f) => f.folder === ch.folder);
        body.appendChild(el("select", {
          "aria-label": "Video folder",
          onchange: (e) => { ch.folder = e.target.value; renderChannels(); },
        }, [
          ...(!ch.folder ? [option("", "(pick a folder under channels/)", true)] : []),
          ...(ch.folder && !known ? [option(ch.folder, ch.folder + "  (folder missing!)", true)] : []),
          ...channelFolders.map((f) => option(f.folder, folderLabel(f), f.folder === ch.folder)),
        ]));
        body.appendChild(el("select", {
          "aria-label": "Playback order",
          onchange: (e) => { ch.order = e.target.value; },
        }, [option("sequence", "In order", ch.order !== "shuffle-daily"), option("shuffle-daily", "Shuffled daily", ch.order === "shuffle-daily")]));
        body.appendChild(el("select", {
          "aria-label": "Scheduling",
          onchange: (e) => { ch.mode = e.target.value; renderChannels(); },
        }, [option("continuous", "Always on the air", ch.mode !== "schedule"), option("schedule", "Scheduled hours", ch.mode === "schedule")]));
        if (ch.mode === "schedule") {
          body.appendChild(el("select", {
            "aria-label": "Off-air look",
            onchange: (e) => { ch.offAir = e.target.value; },
          }, OFFAIR_OPTIONS.map(([v, label]) => option(v, "Off air: " + label, v === (ch.offAir || "testcard")))));
        }
      }

      const rows = [head, body];
      if (ch.type === "video") {
        // Commercial breaks: spots from a second folder, cut into the program
        // every so many minutes. "(none)" is the plain channel.
        const b = ch.breaks;
        const B = S.BREAKS;
        const numberInput = (key, label, title) => el("input", {
          type: "number", min: B[key].min, max: B[key].max, step: 1, value: b[key],
          "aria-label": label, title,
          onchange: (e) => {
            b[key] = Math.round(S.clampNum(e.target.value, B[key].min, B[key].max, B[key].dflt));
            e.target.value = b[key];
          },
        });
        const breaksKnown = !b || channelFolders.some((f) => f.folder === b.folder);
        const breaksRow = el("div", { class: "ch-body ch-breaks" }, [
          el("span", { class: "note" }, "Breaks from"),
          el("select", {
            "aria-label": "Breaks folder",
            onchange: (e) => {
              const folder = e.target.value;
              if (!folder) delete ch.breaks;
              else ch.breaks = { folder, everyMinutes: b ? b.everyMinutes : B.everyMinutes.dflt, spots: b ? b.spots : B.spots.dflt };
              renderChannels();
            },
          }, [
            option("", "(none)", !b),
            ...(b && !breaksKnown ? [option(b.folder, b.folder + "  (folder missing!)", true)] : []),
            ...channelFolders.filter((f) => f.folder !== ch.folder).map((f) => option(f.folder, folderLabel(f), !!b && f.folder === b.folder)),
          ]),
        ]);
        if (b) {
          // Each phrase wraps as a unit, so a narrow screen never splits a
          // number from its words.
          breaksRow.appendChild(el("span", { class: "ch-phrase" }, [
            el("span", { class: "note" }, "every"),
            numberInput("everyMinutes", "Minutes of program between breaks", "0 = breaks only between programs"),
            el("span", { class: "note" }, "min of program,"),
          ]));
          breaksRow.appendChild(el("span", { class: "ch-phrase" }, [
            numberInput("spots", "Spots per break", "How many spots run in each break"),
            el("span", { class: "note" }, "spots per break"),
          ]));
        }
        rows.push(breaksRow);
      }
      if (ch.type === "video" && ch.mode === "schedule") {
        const windowsHost = el("div", { class: "ch-windows" });
        const windows = ch.schedule || (ch.schedule = []);
        windows.forEach((w, wi) => {
          windowsHost.appendChild(el("div", { class: "ch-window" }, [
            ...DAY_KEYS.map((day, di) =>
              el("button", {
                type: "button", class: "day-chip", "aria-pressed": w.days.includes(day) ? "true" : "false",
                onclick: (e) => {
                  const on = w.days.includes(day);
                  w.days = on ? w.days.filter((d) => d !== day) : [...w.days, day];
                  e.target.setAttribute("aria-pressed", on ? "false" : "true");
                  renderWeekGrid();
                },
              }, DAY_LABELS[di])),
            el("input", { type: "time", value: w.start || "08:00", "aria-label": "Window start",
              onchange: (e) => { w.start = e.target.value; renderWeekGrid(); } }),
            "to",
            el("input", { type: "time", value: w.end || "11:30", "aria-label": "Window end",
              onchange: (e) => { w.end = e.target.value; renderWeekGrid(); } }),
            el("button", { type: "button", class: "icon danger", title: "Remove window", "aria-label": "Remove window",
              onclick: () => { windows.splice(wi, 1); renderChannels(); } }, "✕"),
          ]));
        });
        windowsHost.appendChild(el("button", {
          type: "button", class: "small add-row",
          onclick: () => { windows.push({ days: ["sat"], start: "08:00", end: "11:30" }); renderChannels(); },
        }, "+ Add window"));
        rows.push(windowsHost);
      }

      host.appendChild(el("div", { class: "item ch-item" }, rows));
    });
    renderWeekGrid();
  }

  // The week as the schedule reads: seven day columns, on-air windows drawn
  // as blocks. The way to catch "the cartoons window is on the wrong day"
  // without waiting for Saturday.
  function renderWeekGrid() {
    const wrap = $("week-grid-wrap");
    const grid = $("week-grid");
    const scheduled = channels.filter((c) => c.type === "video" && c.mode === "schedule" && (c.schedule || []).length);
    if (!scheduled.length) {
      wrap.hidden = true;
      return;
    }
    wrap.hidden = false;
    grid.innerHTML = "";
    grid.appendChild(el("div", null, ""));
    for (const label of ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"]) {
      grid.appendChild(el("div", { class: "wg-head" }, label));
    }
    const hours = el("div", { class: "wg-hours", style: "height:192px" });
    for (const h of [0, 6, 12, 18, 24]) {
      hours.appendChild(el("span", { class: "wg-hour", style: "top:" + (h / 24) * 100 + "%" }, String(h)));
    }
    grid.appendChild(hours);
    // The schema expands overnight windows ("SAT 20:00-01:00") into an
    // evening segment plus a next-morning segment, so they draw as two
    // blocks the way a printed grid would show them.
    const segsByDay = [[], [], [], [], [], [], []];
    for (const ch of scheduled) {
      for (const w of ch.schedule) {
        for (const g of (S.windowSegments ? S.windowSegments(w) : [])) {
          segsByDay[g.day].push({ ch, w, start: g.start, end: g.end });
        }
      }
    }
    for (let d = 0; d < 7; d++) {
      const day = el("div", { class: "wg-day" });
      for (const g of segsByDay[d]) {
        day.appendChild(el("div", {
          class: "wg-block",
          style: "top:" + (g.start / 1440) * 100 + "%;height:" + Math.max(((g.end - g.start) / 1440) * 100, 4) + "%",
          title: "CH " + g.ch.number + " " + (g.ch.name || "") + "  " + g.w.start + "-" + g.w.end,
        }, String(g.ch.number)));
      }
      grid.appendChild(day);
    }
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

    channels = (cfg.channels || []).map((c) => JSON.parse(JSON.stringify(c)));
    const tuner = cfg.tuner || {};
    const src = tuner.sources || {};
    $("f-tunerKeyboard").checked = src.keyboard !== false;
    $("f-tunerGamepad").checked = src.gamepad !== false;
    $("f-tunerHttp").checked = src.http !== false;
    $("f-tunerWrap").checked = tuner.wrap !== false;
    $("f-tunerCut").value = tuner.cut || "static";
    $("f-tunerPower").value = tuner.power || "crt";

    renderFeeds();
    renderRotation();
    renderMessages();
    renderCrawlFeeds();
    renderPageCycle();
    renderChannels();
    refreshChannelFolders();
  }

  // The folder picker's inventory: what actually sits under channels/, with
  // file counts and (once probed) total run time. Never a typed path.
  async function refreshChannelFolders() {
    try {
      const r = await fetch("api/channels", { cache: "no-store" });
      if (!r.ok) return;
      channelFolders = (await r.json()).folders || [];
      renderChannels();
    } catch (e) {
      /* server-less preview: the picker just shows the configured folder */
    }
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
      channels: channels.map((c) => JSON.parse(JSON.stringify(c))),
      tuner: {
        sources: {
          keyboard: $("f-tunerKeyboard").checked,
          gamepad: $("f-tunerGamepad").checked,
          http: $("f-tunerHttp").checked,
        },
        wrap: $("f-tunerWrap").checked,
        cut: $("f-tunerCut").value,
        power: $("f-tunerPower").value,
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

  // ------------------------------------------------- version + navigation

  // What release is this? The server reads it from the checkout at startup.
  // A zip download or a folder vendored inside another repo has no answer,
  // and says so rather than guessing.
  async function loadVersion() {
    const chip = $("version");
    const line = $("releaseVersion");
    const note = $("releaseNote");
    let v = null;
    try {
      const r = await fetch("api/version", { cache: "no-store" });
      if (r.ok) v = await r.json();
    } catch (e) {
      /* offline or an older server: say unknown rather than guess */
    }
    const repo = (v && v.repo) || "https://github.com/nothans/cable-82";
    $("releaseRepo").href = repo;
    if (!v || !v.version) {
      chip.textContent = "version unknown";
      chip.href = repo;
      chip.title = "This install is not a checkout of a release, so it cannot name a version.";
      line.textContent = "unknown";
      note.textContent = v
        ? "No release to read: this is a copy of the files, not a checkout. Build " + v.build + "."
        : "The server did not answer.";
      return;
    }
    chip.textContent = v.version;
    chip.href = v.release ? repo + "/releases/tag/" + v.release : repo;
    chip.title = v.release ? "Release " + v.release : "Ahead of the last release";
    line.textContent = v.version;
    note.textContent = v.release
      ? "Build " + v.build + ". A clean checkout of this release."
      : "Build " + v.build + ". Past the last tag, or with local edits.";
  }

  // The group nav follows the scroll, so the progression is always placed.
  function wireGroupNav() {
    const head = document.querySelector("header.masthead");
    const links = Array.from(document.querySelectorAll(".groupnav a"));
    const groups = links
      .map((a) => document.getElementById(a.getAttribute("href").slice(1)))
      .filter(Boolean);
    if (!groups.length) return;
    const setHeadHeight = () =>
      document.documentElement.style.setProperty("--head-h", head.offsetHeight + 16 + "px");
    setHeadHeight();
    addEventListener("resize", setHeadHeight);
    const mark = (id) => links.forEach((a) => a.classList.toggle("on", a.getAttribute("href") === "#" + id));
    // Whichever group covers the top of the reading area wins; at the very
    // bottom of the page the last one does, since it may be too short to reach.
    const spy = () => {
      const top = head.offsetHeight + 24;
      let current = groups[0].id;
      for (const g of groups) if (g.getBoundingClientRect().top <= top) current = g.id;
      if (innerHeight + scrollY >= document.body.scrollHeight - 4) current = groups[groups.length - 1].id;
      mark(current);
    };
    spy();
    addEventListener("scroll", spy, { passive: true });
    mark((location.hash || "#" + groups[0].id).slice(1));
  }

  // ---------------------------------------------------------- wire up

  document.addEventListener("DOMContentLoaded", () => {
    $("addFeed").addEventListener("click", () => { feeds.push({ id: "", label: "", url: "" }); renderFeeds(); });
    $("addSlot").addEventListener("click", () => {
      rotation.push(feeds.length ? { type: "headlines", feed: feeds[0].id } : { type: "clock" });
      renderRotation();
    });
    $("addMessage").addEventListener("click", () => { messages.push({ text: "", color: null }); renderMessages(); });
    $("addChannel").addEventListener("click", () => {
      // Next free number up the dial, starting where cable channels lived.
      let n = 2;
      while (channels.some((c) => c.number === n)) n++;
      if (!channels.length) channels.push({ number: 82, name: "", type: "bulletin", enabled: true });
      else channels.push({ number: n, name: "", type: "video", enabled: true, folder: "", mode: "continuous", order: "sequence", offAir: "testcard" });
      renderChannels();
    });
    $("f-facts").addEventListener("input", updateCounts);
    $("f-dadJokes").addEventListener("input", updateCounts);
    $("wxLookup").addEventListener("click", lookupWx);
    $("wxSearch").addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); lookupWx(); } });
    $("f-musicVolume").addEventListener("input", updateVolumeOut);
    wireGroupNav();
    loadVersion();
    $("save").addEventListener("click", save);
    $("revert").addEventListener("click", load);
    load();
  });
})();
