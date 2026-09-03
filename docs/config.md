# CABLE 82 configuration reference

Everything the control room edits lives in one file, `config.json`, next to the server.
The control room is the safe way to change it: every save is validated and written whole.
The file can be hand-edited too, and the server picks up the change without a restart; if an edit leaves the file unreadable, the last good settings stay on the air, the control room says which line broke, and a Save from there writes a good file over it.

Every key is optional.
A missing key takes its default; a value out of range is clamped; a value that makes no sense is dropped with a warning the control room shows after a save.
The server seeds the file from these defaults on first run.

## Station

| Key | What it does | Default |
| --- | --- | --- |
| `channelName` | The station's name: the bug on the board's header, the crawl's fallback, the bulletin channel's name on the dial | `CABLE 82` |
| `tagline` | The line under the name on the board, and the crawl's fallback after the name | `COMMUNITY BULLETIN BOARD` |
| `timeFormat` | `"12h"` or `"24h"`, everywhere a clock is shown | `12h` |
| `port` | The port the server listens on. Read at startup | `1982` |

## The dial

`channels` is an array; the number is the order.
Empty means the guide on 0 and the board on 82, which is what a fresh install has.

Every channel has:

| Key | What it does |
| --- | --- |
| `number` | 0 to 999, unique. 0 is a real channel (the guide lives there out of the box) |
| `name` | Up to 40 characters. Empty means the station name for a bulletin channel, the preview name for a guide, `CHANNEL N` otherwise |
| `type` | `bulletin`, `video`, `guide`, or `external` |
| `enabled` | `false` takes it off the dial without deleting it |

A `video` channel adds:

| Key | What it does | Default |
| --- | --- | --- |
| `folder` | One folder name (no path) under `channels/` on the card, or under a `channels` folder on any drive. If the same name exists in two places, the built-in one wins | required |
| `order` | `sequence` (file names, naturally sorted, so E2 airs before E10) or `shuffle-daily` (a fresh order each day, stable all day) | `sequence` |
| `mode` | `continuous` (always on the air) or `schedule` | `continuous` |
| `schedule` | Windows `{ "days": ["sat","sun"], "start": "08:00", "end": "11:30" }`. An end at or before the start runs overnight into the next morning | `[]` |
| `offAir` | What shows outside the windows: `testcard`, `bars`, `snow`, or `bulletin` (fall back to the board) | `testcard` |
| `breaks` | Commercial breaks: `{ "folder": "spots", "everyMinutes": 15, "spots": 3 }`. Each program is cut into even acts of about `everyMinutes` (0 to 240; 0 means breaks only between programs) and a break of `spots` spots (1 to 20) follows every act. The spots folder must be a different folder | none |
| `titles` | What the guide calls this channel's programs: `filename` (the cleaned file name), `metadata` (the title written inside each file, read once and cached in `.titles.json` beside the videos; the file name when a file has none), or `fixed` (one name for the whole channel) | `filename` |
| `title` | The one name, when `titles` is `fixed`. Empty means the channel's own name | the channel name |

An `external` channel adds `url`, an `http` or `https` address framed full screen.
A `guide` channel takes its settings from `preview` below.

## The tuner

`tuner`:

| Key | What it does | Default |
| --- | --- | --- |
| `sources.keyboard` | Arrow keys and digits on the display's keyboard | `true` |
| `sources.gamepad` | A USB gamepad's d-pad; Select jumps home to the board | `true` |
| `sources.http` | `POST /api/tune`, which the remote uses. Off, the remote says so | `true` |
| `wrap` | Whether the dial wraps at the ends | `true` |
| `cut` | What covers a channel change: `static`, `black`, or `none` | `static` |
| `power` | How the picture goes out: `crt` (folds to a line and fades) or `black` | `crt` |

## Channel 0, the guide

`preview`:

| Key | What it does | Default |
| --- | --- | --- |
| `name` | The wordmark, and channel 0's name on the dial | `CABLEVUE` |
| `tagline` | Under the wordmark. An empty string is a choice; only an absent key takes the default | `WHAT'S ON, AND WHAT'S NEXT` |
| `slots` | Half-hour columns across, 2 to 4 | `3` |
| `scrollSeconds` | Seconds a screenful of lineup takes to crawl by, 4 to 120; the lineup only crawls when it is taller than the screen | `14` |
| `seconds` | Whether the corner clock counts seconds | `true` |
| `background` | A palette color name | `blue` |

## Channel 82, the board

| Key | What it does | Default |
| --- | --- | --- |
| `rotation` | The page lineup, in order: `{ "type": "clock" }`, `messages`, `facts`, `dadjokes`, `weather`, or `{ "type": "headlines", "feed": "news" }` | clock, messages, weather, facts, headlines, … |
| `pageSeconds` | Seconds each page holds, 3 to 120 | `12` |
| `messages` | `{ "text": "…", "color": "green" }`; `color` null cycles the palette. Up to 200 characters, plain Latin text (the bitmap font has no emoji) | four samples |
| `facts`, `dadJokes` | One string each, up to 200 characters | samples |
| `feeds` | `{ "id": "news", "label": "NEWS", "url": "https://…" }`. The server only ever fetches these URLs | WBUR, Hacker News, nothans.com |
| `refreshMinutes` | Feed re-fetch interval, 1 to 1440 | `10` |
| `maxItemsPerFeed` | Items kept per feed, 1 to 100 | `20` |
| `crawl.feeds` | Which feed ids ride the ticker | all feeds |
| `crawl.secondsPerScreen` | Ticker speed: seconds to cross the screen once, 2 to 60 | `9` |
| `crawl.separator` | Between items, up to 16 characters | `  ■  ` |
| `crawl.flag` | The label pinned to the ticker's left, up to 16 characters; empty hides it | `LATEST` |
| `weather.location` | `{ "name", "latitude", "longitude", "timezone" }`, geocoded in the control room. Null means no weather | Boston |
| `weather.tempUnit` | `F` or `C` | `F` |
| `weather.windUnit` | `mph` or `kmh` | `mph` |
| `music.enabled` | Background music from `music/` behind the board | `true` |
| `music.shuffle` | Shuffle the tracks | `true` |
| `music.volume` | 0 to 100 | `60` |
| `cheerlights.enabled` | The latest CheerLights color as a crawl item | `true` |
| `cheerlights.template` | `{color}` becomes the color name | `THE WORLD IS SET TO {COLOR}` |
| `colors.pageCycle` | The palette pages cycle through when a message has no color | blue, green, red, cyan |
| `colors.headerBg`, `colors.crawlBg` | The header and crawl bands | `blue`, `ink` |

Colors are palette names: `blue`, `cyan`, `green`, `yellow`, `red`, `magenta`, `white`, `ink`.
The palette is broadcast-safe on purpose; raw hex works too if you must.
In CRT mode the whole palette is swapped for a softer one and the crawl is pinned to a dark blue band.

## The set

| Key | What it does | Default |
| --- | --- | --- |
| `overscanX`, `overscanY` | Overscan safe margins in percent, sides and top/bottom, 0 to 15. (A file from an earlier release with one `overscanPercent` seeds both) | `7`, `7` |
| `crtMode` | The softer palette and no drop shadow, for composite or RF | `false` |
| `crtInkText` | Dark text on color pages while CRT mode is on; white smears on some tubes | `false` |
| `textScale` | Enlarges body, kicker, crawl, guide, and small header text, 1 to 1.5 | `1` |
| `dailyReloadHour` | The hour (0 to 23) the display reloads itself, or `false` | `4` |

## Files the server keeps beside your videos

- `.durations.json` in a channel folder: each file's length, learned the first time the display plays it. Delete it to force a re-probe.
- `.titles.json` in a channel folder: the title inside each file, read once when the channel is set to `metadata` titles. Delete it to re-read.

Neither is served, and neither is tracked by git.
