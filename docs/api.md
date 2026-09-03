# CABLE 82 API

Everything the display, the control room, and the remote talk to, and everything a tuner source, a dashboard, or a script of your own can talk to.
The server has no authentication: it is built for the LAN a living room sits on, and nothing here should be exposed to the internet.
Anyone on your network who can reach the server can change the channel, save settings, and (on a Pi) restart it, which is also how a living room works.

All answers are JSON unless a row says otherwise.
Paths are relative to the server, `http://<address>:1982` by default.

## The tuner bus

The bus carries events, not state.
Sources send commands; every display applies each one once, tracked by a sequence number; the server never holds a current channel, a volume, or a power state.
That is what lets a phone, a gamepad, and a keyboard share one set without fighting.

### `POST /api/tune`

Send one command.

| Body | What happens on the set |
| --- | --- |
| `{"cmd":"up"}` | The next channel up the dial (wraps at the end if the dial wraps) |
| `{"cmd":"down"}` | The next channel down |
| `{"cmd":"set","channel":N}` | Straight to channel `N`, 0 to 999. A number that is not on the dial shows NO SUCH CHANNEL and stays put |
| `{"cmd":"volume"}` | One step around the volume cycle: loud, sound off, soft, medium, loud. The set draws the level as a meter |
| `{"cmd":"power"}` | Toggle the picture off and on. Every other key is dead while it is off; the broadcast clock keeps running |

Answers `{"ok":true,"seq":N,"listeners":N}`.
`listeners` is how many displays heard it; zero means nobody was watching, which the remote turns into "No set is listening: open the display first."

```
curl -X POST http://localhost:1982/api/tune -H "content-type: application/json" -d "{\"cmd\":\"set\",\"channel\":82}"
```

### `GET /api/tune`

`{"seq":N,"last":{...},"listeners":N}`: the last command and how many displays are listening.
Useful for checking a remote is wired up.
It never reports a current channel, because the server does not hold one.

### `GET /api/events`

The stream the display listens to, as server-sent events.
Plain HTTP, no library, and the browser reconnects by itself.

| Event | Data | Meaning |
| --- | --- | --- |
| `hello` | `{"seq":N,"build":"…","config":"…"}` | Sent on connect and on every reconnect. `build` is a hash of the display files, `config` the version of `config.json`. A display that reconnects and finds either one changed reloads itself: that is how `git pull` and a hand edit during a restart reach the set with nobody touching it |
| `tune` | `{"seq":N,"cmd":"…","channel":N}` | A command from the bus. Apply each `seq` once |
| `config` | `{"version":"…"}` | A control-room save. The display reloads on it |

A comment line (`: ping`) goes out every 25 seconds so middleboxes keep the stream open.

Both tune endpoints answer `403` while HTTP tuning is switched off in the control room's Tuning panel.

## Settings

### `GET /api/config`

`{"version":"…","config":{…}}`: the current settings, cleaned and clamped by the schema, and a version token (the file's modification time).

If `config.json` on disk is broken but the last good settings are still on the air, the answer carries a `warning` naming the file, the line and column, and the way out (a Save from the control room writes a good file over it).
If there is nothing good to serve, the answer is `500` with `{"ok":false,"error":"config.json could not be read: … at line 1, column 3"}`, and the display shows that message instead of pretending.

### `POST /api/config`

Validate and write `config.json`.
The body is the whole config; every key is optional and the schema fills, clamps, and sanitizes.
Answers `{"ok":true,"version":"…","config":{…},"warnings":[…]}` with the cleaned config and any values it had to drop or change, or `400` with `{"ok":false,"errors":[…]}`.

Two headers:

- `x-cable82-config: 1` is required. A browser will not attach a custom header to a cross-site request without a preflight the server never grants, so a page you happen to be visiting cannot rewrite the channel.
- `x-cable82-config-version` is optional. Send the `version` you loaded and a save against a file that has moved since (a hand edit, another tab) is refused with `409` instead of overwriting it.

Every display reloads itself after a successful save.

## Channels

### `GET /api/channels`

One answer for two readers.

`folders` is the picker's inventory: every channel folder on every drive, with `files` (count), `seconds` (the running time of the files whose durations are known), `probed` (how many are), and `volume` (the drive it sits on, empty for the built-in folder).

`channels` is the display's: every configured video channel with its `files` in airing order, each with `file`, `url`, and `duration` (null until the display has played it once), plus `title` when the channel is set to show the titles inside its files, and `breaks` (the spots folder and its files) for a channel with commercial breaks.

### `POST /api/channels/durations`

Internal: the display reporting a file's length after playing it, `{"folder":"…","durations":{"file.mp4":123.4}}`, so the server's `.durations.json` cache fills itself.
Needs the same `x-cable82-config: 1` header a save does.
Only files that exist in the folder are recorded.

### Video files

`channels/<folder>/<file>` serves a program with HTTP Range support, which is how `<video>` seeks and how the broadcast clock joins a file mid-program.
The folder name resolves through every drive that carries a `channels` folder, built-in first.
Dotfiles (the caches) and anything above the checkout are never served.

## Feeds, weather, and the color

| Endpoint | What it does |
| --- | --- |
| `GET /api/feed/<id>` | A configured RSS or Atom feed, fetched server-side. Only ids in `config.json` exist; the URL never crosses the wire, so the proxy cannot be pointed anywhere else. The last good copy is served (with `x-cable82-stale: 1`) when the source is down; `502` when there is none |
| `GET /api/weather` | Current conditions for the configured location from Open-Meteo: `tempNow`, `condition`, `tempHi`, `tempLo`, `wind`, `sunrise`, `sunset`, in the configured units (`tempUnit`, `windUnit`). Last good copy on a blip; `503` until a location is set |
| `GET /api/geocode?q=<place>` | Up to five matches for a place name, each with `name`, `admin1`, `country`, `latitude`, `longitude`, `timezone`, for the control room's location search |
| `GET /api/cheerlights` | `{"color":"purple"}`, the latest [CheerLights](https://cheerlights.com) color name; `503` while CheerLights is switched off |
| `GET /api/music` | `{"tracks":[{"file":"…","url":"music/…"}]}`: the audio files in `music/`, in order |

## The machine

### `GET /api/vitals`

How the host is doing, for a person checking on a Pi in a closet without a shell.
Fields a machine cannot answer are `null`.

```json
{
  "host": { "name": "cable82", "model": "Raspberry Pi 3 Model B Plus Rev 1.3", "pi": true, "platform": "linux", "arch": "arm64", "node": "22.12.0" },
  "uptimeSec": 412034,
  "station": { "uptimeSec": 8123, "version": "v1.0.0", "build": "877492cab439", "pid": 812 },
  "load": [0.42, 0.38, 0.35],
  "cpu": { "count": 4, "temperatureC": 58.5, "throttled": { "raw": "0x0", "underVoltageNow": false, "throttledNow": false, "frequencyCappedNow": false, "softTempLimitNow": false, "underVoltageSinceBoot": false, "throttledSinceBoot": false, "frequencyCappedSinceBoot": false, "softTempLimitSinceBoot": false } },
  "memory": { "totalBytes": 1005940736, "freeBytes": 412000000, "usedPercent": 59 },
  "swap": { "totalBytes": 209715200, "freeBytes": 209715200 },
  "disks": [ { "label": "the card", "path": "/home/pi/cable-82", "totalBytes": 15500000000, "freeBytes": 5500000000 }, { "label": "USB DISK", "path": "/media/pi/USB DISK/channels", "totalBytes": 62000000000, "freeBytes": 49000000000 } ],
  "listeners": 1,
  "at": "2026-09-03T14:02:11.000Z"
}
```

`cpu.throttled` is `vcgencmd get_throttled` decoded, and only on a Pi: the `Now` flags say what is happening this second, the `SinceBoot` flags what has happened since power-on.
Under-voltage since boot is the sign of a phone charger standing in for a power supply.
`disks` lists the checkout's volume and every drive that carries a channels folder.
The control room's Server group shows all of this and refreshes it every ten seconds.

### `GET /api/version`

`{"version":"v1.0.0","release":"v1.0.0","build":"…","repo":"…"}`: what release this install is running, read from the checkout once at startup.
`release` is set only when the checkout sits exactly on a tag; both are `null` for a zip download or a copy vendored inside another repo, rather than a guessed version.

### `GET /api/system`

`{"model":"Raspberry Pi 3 Model B Plus Rev 1.3","pi":true,"power":true}`: what the machine is and whether it can be powered from the control room.

### `POST /api/system`

`{"cmd":"restart"}` or `{"cmd":"shutdown"}`: stop the station, flush the disks, hand over to systemd.
Needs the `x-cable82-config: 1` header; answers `403` unless the machine is a Pi whose user can run `sudo` without a password.
Answers before it acts, since the machine is about to stop being able to answer.

## Command line

| Flag | What it does |
| --- | --- |
| `--port <n>` | Listen on port `n` instead of the `port` in `config.json` |
| `--media <path>` | Also look for channel folders under `<path>/channels` (or `<path>` itself). Repeatable. On a Pi running the service, put it on the unit's `ExecStart` line |
| `--mock` | Serve the canned feeds in `test/mock-feeds/` instead of fetching anything |
| `--chaos` | Mock feeds that randomly hang and fail, for watching the board shrug it off. Implies `--mock` |
| `--help` | The same list, from the server itself |

A flag that needs a value and does not get one is an error at start, with this list.
