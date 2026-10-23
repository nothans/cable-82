# How CABLE 82 is put together

No build step, no dependencies: the files are what the browser runs.

| File | What it is |
| --- | --- |
| `server.js` | The station: static files with Range serving, the feed and weather proxies, the config API, the channels inventory across drives, the tuner bus, the machine's vitals, restart and shutdown |
| `config-schema.js` | The one validation authority, shared by the server, the display, the control room, and the tests. The palette, the sanitizer, and the natural sort live here so nothing has two copies |
| `media-meta.js` | The title inside an MP4, read from its atoms without decoding a frame, for channels that show titles from their files |
| `dial.js` | The broadcast clock, pure: where a channel is at a given moment, the schedule windows, the timeline of a channel with breaks, what the guide calls a segment, the volume steps. Loads in Node and in the browser |
| `board.js` | Channel 82: the header, the pages, the crawl, the feeds, the weather card, CheerLights, the music bed, and its own watchdog |
| `guide.js` | Channel 0: the CABLEVUE masthead and grid, crawling when the lineup is tall |
| `video.js` | The player: two buffers, the cut at a boundary, the end-of-program watch, the duration probe |
| `set.js` | Faux CRT: the drawn console and its live dial, the glass cut to the picture's own curve, the tube's tells as one filter and a few overlays. Nothing runs on a real tube |
| `tuner.js` | The dial: channel changes and what covers them, the on-screen display, the off-air cards, the volume and power keys, the keyboard and gamepad, and one `command()` every source lands on |
| `app.js` | Boot: load the config, paint the stage, start the tuner, listen to the bus, reload daily |
| `index.html`, `style.css` | The set. Everything is sized off a virtual 640x480 screen so it scales to any tube |
| `config.html`, `config-page.js` | The control room |
| `remote-control.html`, `remote-control.js`, `remote-control.css` | The remote |
| `remote-control.webmanifest`, `remote-sw.js`, `favicon.svg`, `icon-*.png`, `icon-maskable.svg` | What lets a phone install the remote: the manifest, a service worker scoped to the remote alone, and the 82 icon (the PNGs rasterized from the SVG at whole pixels) |
| `docs/` | [The API](api.md) and [the configuration file](config.md) |
