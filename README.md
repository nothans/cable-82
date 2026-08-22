# CABLE 82

Your own 1982 cable community bulletin board channel.

Before feeds, your town had a channel: blue screens, chunky text, the time and temperature, the church bake sale, headlines crawling along the bottom.
CABLE 82 recreates that channel and points it at your life.
It turns any screen - ideally an old 4:3 CRT fed by a Raspberry Pi - into a scrolling rotation of the date and time, your community messages, fun facts, dad jokes, and live headlines from feeds you choose.

You make the channel yours in a control room at `/config` - or by editing one plain `config.json` file.

Read the [build story on nothans.com](https://nothans.com/cable-82-turn-a-raspberry-pi-and-an-old-crt-into-a-1982-cable-bulletin-board-channel), watch the [one-minute video of it on the air](https://www.youtube.com/watch?v=d5Jcfx5oN0A), or leave the [full six-minute demo](https://www.youtube.com/watch?v=0YEvI_oFfqY) playing.

Weather is one optional strip - current conditions, hi/lo, and sunrise/sunset - fed by Open-Meteo (free, no account). For a full retro weather *channel*, [ws4kp](https://github.com/netbymatt/ws4kp) does that beautifully.

| The time | The weather | A dad joke |
| :---: | :---: | :---: |
| ![The clock page: big time and date on a blue screen](images/clock.png) | ![The weather page: current conditions, hi/lo, and sunrise/sunset](images/weather.png) | ![A dad joke page](images/dad-joke.png) |

## Quick start

You need Node.js 18 or newer: `node -v` should print `v18` or higher.
(No `node` at all, or an older one?
See [Node.js on a Raspberry Pi](#nodejs-on-a-raspberry-pi) below; the same commands work on any Debian or Ubuntu machine.)

```
git clone https://github.com/nothans/cable-82
cd cable-82
node server.js
```

The server prints every address it answers on:

```
CABLE 82 broadcasting
  http://localhost:1982   (a browser on this machine)
  http://192.168.1.42:1982   (a browser on another device on your network)
Control room: http://localhost:1982/config
```

Open the first one in a browser on the same machine, or the second one from a laptop or phone on the same Wi-Fi.
You are on the air.
(If it prints something else instead, it is telling you why it could not start; see [Troubleshooting](#troubleshooting).)

Then open the control room at `http://localhost:1982/config`: your name, your messages, your feeds, your colors, your page lineup.
Hit Save and the channel picks it up within about twenty seconds, no reload.
(Prefer a text editor? Everything lives in `config.json`; edit it directly and the channel still updates.)

## The screen

1. **Header band** - channel name and the live time and date, always visible.
2. **Pages** - full-screen colored pages that hard-cut every 12 seconds: a big clock, your community messages, DID YOU KNOW facts, DAD JOKE groaners, a WEATHER card, and headlines.
3. **The crawl** - a continuous ticker of headlines along the bottom, fed by RSS.

## Configuration (control room or `config.json`)

The control room at `/config` is the friendly way in: one screen with the whole channel - identity, timing, feeds, the page rotation, community messages, the crawl, and colors.
Every change is validated on the server, written to `config.json`, and picked up on air.
The two ways in stay honest with each other: if `config.json` changes while a control room is open (a hand edit, or a save from another tab), the open screen warns you, and a stale Save is refused instead of overwriting the newer file.

![The CABLE 82 control room at /config: the whole channel on one screen](images/config.png)

`config.json` is the file underneath, and you can hand-edit it just as happily.
The keys:

| Key | What it does | Default |
| --- | --- | --- |
| `channelName`, `tagline` | Header identity and crawl fallback text | `CABLE 82` |
| `timeFormat` | `"12h"` or `"24h"` | `12h` |
| `port` | Server port | `1982` |
| `rotation` | The page lineup, in order (`clock`, `messages`, `facts`, `dadjokes`, `weather`, `headlines`) | see file |
| `pageSeconds` | Seconds per page | `12` |
| `feeds` | RSS/Atom feeds: `{ id, label, url }`. The server only ever fetches these URLs | WBUR, Hacker News, nothans.com |
| `refreshMinutes` | Feed re-fetch interval | `10` |
| `maxItemsPerFeed` | Items kept per feed | `20` |
| `crawl` | Which feeds ride the ticker, speed, separator, and the fixed `flag` label pinned to its left | all feeds, `LATEST` |
| `messages` | Your community messages: `{ text, color? }` | examples |
| `facts` | Fun facts shown under a DID YOU KNOW card, one string each | 30-plus samples |
| `dadJokes` | Dad jokes shown under a DAD JOKE card, one string each | 15 samples |
| `weather` | One weather strip via Open-Meteo: `location` (geocoded, with `timezone`), `tempUnit` (`F`/`C`), `windUnit` (`mph`/`kmh`). Set it in the control room | Boston, `F`, `mph` |
| `music` | Background music from the `music/` folder: `enabled`, `shuffle`, `volume` (0-100) | on, shuffled, 60 |
| `cheerlights` | The latest [CheerLights](https://cheerlights.com) color as a crawl item: `enabled`, `template` (`{color}` becomes the color name) | on, `THE WORLD IS SET TO {COLOR}` |
| `colors` | `pageCycle`, `headerBg`, `crawlBg` | period palette |
| `overscanPercent` | Safe margin for CRT overscan, 0-15 | `7` |
| `crtMode` | Softer NTSC-safe palette and no drop shadow, for composite or RF | `false` |
| `textScale` | Enlarges body, kicker, crawl, and small header text, 1-1.5 | `1` |
| `dailyReloadHour` | Daily kiosk self-reload hour, or `false` | `4` |

Colors are palette names: `blue`, `cyan`, `green`, `yellow`, `red`, `magenta`.
The palette is broadcast-safe on purpose; raw hex works too if you must.

Feeds are fetched by the server, never by the browser, and only URLs listed in `config.json` can be fetched at all.
If a feed goes down, the channel keeps running on the last good copy.
If the network dies entirely, the clock, messages, and facts keep going forever.

## Running it on a real CRT (Raspberry Pi)

Everything below was run end to end on a Raspberry Pi 3 Model B+ with Raspberry Pi OS (64-bit) "Trixie" and a 1987 Magnavox portable over an HDMI-to-RF modulator on channel 3.
Newer Pis are easier; the notes say where an older one differs.

### Node.js on a Raspberry Pi

Raspberry Pi OS does not ship with Node.js, and the version its own `apt` offers depends on the OS release: Bookworm (2023) and Trixie (2025) give Node 18 or 20, which work; Bullseye (2021) and older give Node 12, which does not.
The sure way on a 64-bit image, any Pi from the 3 onward:

```
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt-get install -y nodejs
node -v
```

`node -v` should now print `v22`.
NodeSource builds for 64-bit only these days; on a 32-bit image use `sudo apt install nodejs` and take the distro's Node 20.
A Pi 1, Pi Zero, or Zero W is ARMv6: Node 20 installs from `apt` and the server runs, but no current browser runs on that chip (Chromium refuses it outright), so it can be the server and never the TV.
Start at a Pi 2; a Pi 3 B+ or 4 runs the channel comfortably.

Then clone and start the channel exactly as in Quick start, and read the addresses it prints.

### 1. Feed it properly

A Pi 3 wants a 5V 2.5A supply and a short, thick micro-USB cable; a phone charger will boot it and then quietly run it at less than half speed.
Check:

```
vcgencmd get_throttled
```

`throttled=0x0` is the answer you want.
Anything else is a complaint: `0xd0005` means under-voltage and throttling right now (and that both have happened since boot), and `vcgencmd measure_clock arm` will show a 1.4GHz Pi idling at 600MHz.
(`0x80008` on a 3 B+ is its own soft temperature limit at 60C, normal with Chromium running, and not a power problem.)

### 2. Run the server on boot

`/etc/systemd/system/cable82.service`:

```
[Unit]
Description=CABLE 82
After=network-online.target

[Service]
ExecStart=/usr/bin/node /home/pi/cable-82/server.js
Restart=always
User=pi

[Install]
WantedBy=multi-user.target
```

Replace `pi` (both places) with your own username if it differs: `whoami` tells you, and newer Raspberry Pi OS images let you pick any name at setup.
`which node` confirms the path on the `ExecStart` line.
Then `sudo systemctl enable --now cable82`, and `systemctl status cable82` should say `active (running)` with the broadcasting lines in its log.

### 3. Chromium in kiosk mode

The Raspberry Pi OS desktop logs in by itself and runs a Wayland session (the compositor is labwc).
Put this in `~/.config/labwc/autostart` and it opens Chromium full screen on the channel at every login:

```
# CABLE 82 kiosk: wait for the channel server, then put Chromium on it full screen.
until curl -s -o /dev/null http://localhost:1982; do sleep 1; done
/usr/bin/lwrespawn /usr/bin/chromium http://localhost:1982 \
  --kiosk --noerrdialogs --disable-infobars --no-first-run --no-memcheck \
  --disable-lcd-text --autoplay-policy=no-user-gesture-required \
  --enable-features=OverlayScrollbar --password-store=basic --start-maximized &
```

The `until curl` loop keeps Chromium from winning the race at boot and showing "localhost refused to connect" forever.
`lwrespawn` restarts the browser if it ever dies.
`--no-memcheck` silences Chromium's low-memory warning on a 1GB Pi, `--disable-lcd-text` keeps the chunky text from going pink at the edges, `--autoplay-policy=no-user-gesture-required` lets the music start without a click, and `--password-store=basic` stops the keyring prompt.
(On Bookworm and earlier the binary was `chromium-browser` and the autostart file was `/etc/xdg/lxsession/LXDE-pi/autostart`; Trixie has neither.)

Then stop the screen from blanking:

```
sudo raspi-config nonint do_blanking 1
```

If a pointer shows up on the TV with no mouse attached (the HDMI CEC input counts as one), give labwc a key that hides it and press it from the autostart.
Copy `/etc/xdg/labwc/rc.xml` to `~/.config/labwc/rc.xml`, add inside `<keyboard>`:

```
<keybind key="A-W-h"><action name="HideCursor"/></keybind>
```

then `sudo apt install wtype` and append to the autostart:

```
(sleep 10; wtype -M alt -M logo -P h -p h -m logo -m alt) &
```

### 4. Get the picture onto the TV

Two ways in, depending on your TV.

**Coax / antenna input (works on any Pi and any TV):** run HDMI from the Pi into an [HDMI-to-RF modulator](https://www.amazon.com/dp/B0DRCZKLBQ?tag=nothans), coax from the modulator into the TV's antenna terminal, and tune the TV to **channel 3 or 4** to match the switch on the box.
Two things the box will not tell you:

- It scales whatever comes in to fill the 4:3 tube, so the Pi has to send a 4:3 picture or the channel arrives squashed.
- Cheap ones send no EDID at all, so the Pi sees no screen, guesses a mode, and refuses to send HDMI audio.

Fix both.
Append to the single line in `/boot/firmware/cmdline.txt`:

```
video=HDMI-A-1:640x480@60D vc4.force_hotplug=1 drm.edid_firmware=HDMI-A-1:edid/cable82.bin
```

and give the Pi the EDID that file names, a 256-byte description of a 640x480 screen with stereo audio that ships in this repo:

```
sudo mkdir -p /lib/firmware/edid
sudo cp edid/cable82-640x480-audio.bin /lib/firmware/edid/cable82.bin
```

The desktop picks its own resolution on top of the kernel's, so pin it in `~/.config/kanshi/config`:

```
profile crt {
  output HDMI-A-1 mode 640x480 position 0,0
}
```

Reboot, and `wpctl status` should now list an HDMI sink next to the headphone jack.
Make it the default and give it some level; WirePlumber remembers:

```
wpctl status                       # find the "(HDMI)" sink's number
wpctl set-default <number>
wpctl set-volume <number> 0.8
```

The modulator puts the sound on the channel's audio carrier, mono, the way 1982 did.

**Composite (Pi Zero, 1, 2, 3 via the yellow jack or the 3.5mm AV jack, Pi 4 via the AV jack; TV with an RCA input):**

```
sudo raspi-config nonint do_composite 0
```

writes `dtoverlay=vc4-kms-v3d,composite` to `config.txt`, and on every Pi before the 5 that also turns HDMI off: it is one or the other.
The Wayland desktop does not trust the composite connector until it is told the mode, so append to `cmdline.txt`:

```
video=Composite-1:720x480@60ie,tv_mode=NTSC
```

(PAL: `720x576@50ie,tv_mode=PAL`.)
Audio routes itself to the analog jack when HDMI is off.
If the picture is wavy or rolling and the sound is fine, the 4-pole AV cable is wired the camcorder way: move the **red** plug to the TV's video input.
The old `enable_tvout` / `sdtv_mode` / `sdtv_aspect` lines you will find in older guides do nothing on Bookworm or later.

### 5. Tune it in the control room

Open the **CRT** panel in the control room:

- **CRT mode** swaps in a softer palette and drops the drop shadow.
  Composite and RF smear saturated red and blue and clip pure white; this calms both.
- **Text size** enlarges the body text, kicker, crawl, and the small header lines, 1 to 1.5.
  1.25 is a good start on a small tube; the big clock stays as it is.
- **Overscan safe margin**: raise it if the TV crops the edges.

Pages fit themselves to whatever is left: a long fact or the weather card shrinks just enough, and the weather card gives up its sunrise line first.
There are no fake scanline filters in CABLE 82: the CRT is the filter.

## Troubleshooting

**"localhost refused to connect"** means nothing is listening on that port, so the server is not running.
Open a terminal on the Pi, `cd cable-82`, run `node server.js`, and read what it prints.
It either says `CABLE 82 broadcasting` with a list of addresses, or it tells you why it could not start:

- `node: command not found`: Node.js is not installed. See [Node.js on a Raspberry Pi](#nodejs-on-a-raspberry-pi).
- `CABLE 82 needs Node.js 18 or newer`: the Node.js you have is too old (Raspberry Pi OS Bullseye's `apt` gives Node 12). Same fix.
- `PORT 1982 IS ALREADY IN USE`: a copy is already running, probably the systemd service. That copy is the channel; open the browser at it, or stop it with `sudo systemctl stop cable82` while you test by hand.
- Anything else: the message is the clue. Paste it into an issue and it will get answered.

While the server is running, prove it from the Pi itself, no browser involved: `curl -s http://localhost:1982 | head -3` should print the start of a web page.

**The browser is on a different device than the server.**
`localhost` always means "this device", so `http://localhost:1982` on a laptop looks for a server on the laptop.
Use one of the other addresses the server printed, the ones with a `192.168.x.x`-style IP; `hostname -I` on the Pi prints the same IPs.
The `192.168.1.42` in these docs is an example, not your Pi's address.

**"Address unreachable"** means that IP is not on your network or is not the Pi: use the address the server printed, and make sure the Pi and the browsing device are on the same Wi-Fi or LAN.

**"raspberrypi.local" does not resolve** when the Pi's hostname is not `raspberrypi` (newer images let you choose), or when the browsing device lacks mDNS (older Windows, some Android).
`hostname` on the Pi shows its name; the IP address works regardless.

**The picture is there but the text is smeared or the colors bleed.**
That is NTSC doing what it does to saturated color and small type.
Turn on CRT mode and raise Text size in the control room's CRT panel, then fine-tune the TV; a 1980s tuner drifts, and cheap modulators sit slightly off the carrier.

**No sound through the HDMI modulator.**
The Pi refuses HDMI audio unless the screen's EDID says it can hear, and cheap modulators send no EDID.
Step 4 above supplies one (`drm.edid_firmware=` plus the shipped `edid/cable82-640x480-audio.bin`); after a reboot `wpctl status` lists an HDMI sink.

**It runs, slowly, and `vcgencmd get_throttled` is not `0x0`.**
The power supply.
A Pi 3 on a phone charger runs at 600MHz with under-voltage flags set; a 5V 2.5A supply and a short cable fix it.

**The channel is up but feeds, weather, or CheerLights are blank.**
The clock, messages, facts, and jokes never need the network; the rest is fetched by the server.
`journalctl -u cable82 -f` (or the terminal) logs each fetch failure with the reason.

**The systemd service will not start**: `systemctl status cable82` shows why.
The usual suspects are `User=` naming an account that does not exist, `ExecStart=` pointing at a `node` that is not at `/usr/bin/node` (`which node`), or the repo living somewhere other than `/home/pi/cable-82`.

## Music

The real channels were never silent, and neither is CABLE 82.
Drop audio files into the [`music/`](music/) folder and the channel plays them as a continuous background bed behind the pages, looping the whole set (shuffle optional).
Two tracks ship with the channel, a 1980s one and a 1990s one; the rest is up to you.
Turn music on or off, shuffle, and set the volume in the control room.

Browsers block autoplay until a user gesture, so on a desktop the music starts on your first click; on the Pi kiosk the `--autoplay-policy=no-user-gesture-required` flag above starts it from boot.

## CheerLights

The crawl carries one extra item: the latest [CheerLights](https://cheerlights.com) color. CheerLights is a single global color that anyone in the world can set, and every connected light on the planet follows along. CABLE 82 checks it about once a minute (server-side, like every other fetch) and scrolls your message with the color name filled in: `THE WORLD IS SET TO {COLOR}` comes out as `THE WORLD IS SET TO PURPLE`.

![The CheerLights color riding the CABLE 82 crawl on a CRT](images/cheerlights-crawl-crt.png)

Turn it off, or make the message yours, in the control room. Or, by editing the  `config.json`:

```json
"cheerlights": {
  "enabled": true,
  "template": "THE WORLD IS SET TO {COLOR}"
}
```

## Testing

- Server: `node --test test/server.test.mjs`
- Client pure functions: start the server and open `http://localhost:1982/test/harness.html`
- Failure drill: `node server.js --chaos` serves mock feeds that randomly hang and fail, so you can watch the channel shrug it off
- Soak: open `http://localhost:1982/?soak=1` for accelerated page flips and refreshes with stats logged to the console

## Credits

- Typeface: [The Ultimate Oldschool PC Font Pack](https://int10h.org/oldschool-pc-fonts/) by VileR (CC BY-SA 4.0), the IBM VGA 8x16 face. See `fonts/LICENSE.txt`.
- Weather data from [Open-Meteo](https://open-meteo.com/) (free, no API key; CC BY 4.0).
- Spiritual ancestors: every local cable text channel that ever scrolled a bake sale, and [ws4kp](https://github.com/netbymatt/ws4kp) for proving retro TV nostalgia belongs on the web.

## License

MIT for the code (see `LICENSE`).
The bundled font remains CC BY-SA 4.0.
