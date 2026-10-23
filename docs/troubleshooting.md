# Troubleshooting

**"localhost refused to connect"** means nothing is listening on that port, so the server is not running.
Open a terminal on the Pi, `cd cable-82`, run `node server.js`, and read what it prints.
It either says `CABLE 82 broadcasting` with a list of addresses, or it tells you why it could not start:

- `node: command not found`: Node.js is not installed. See [Node.js on a Raspberry Pi](raspberry-pi.md#nodejs-on-a-raspberry-pi).
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

**The set says PLEASE STAND BY and names config.json.**
A hand edit left the file unreadable, and the message says which line.
Fix the line, or open the control room and press Save: it writes a good file over the broken one and the set comes back on its own.

**The picture is there but the text is smeared or the colors bleed.**
That is NTSC doing what it does to saturated color and small type.
Turn on CRT mode and raise Text size in the control room's Picture panel, then fine-tune the TV; a 1980s tuner drifts, and cheap modulators sit slightly off the carrier.

**No sound through the HDMI modulator.**
The Pi refuses HDMI audio unless the screen's EDID says it can hear, and cheap modulators send no EDID.
[Step 4 of the Pi guide](raspberry-pi.md#4-get-the-picture-onto-the-tv) supplies one (`drm.edid_firmware=` plus the shipped `edid/cable82-640x480-audio.bin`); after a reboot `wpctl status` lists an HDMI sink.

**It runs, slowly, and `vcgencmd get_throttled` is not `0x0`.**
The power supply.
A Pi 3 on a phone charger runs at 600MHz with under-voltage flags set; a 5V 2.5A supply and a short cable fix it.
The control room's Vitals panel shows the same flags in words.

**The board is up but feeds, weather, or CheerLights are blank.**
The clock, messages, facts, and jokes never need the network; the rest is fetched by the server.
`journalctl -u cable82 -f` (or the terminal) logs each fetch failure with the reason.

**The systemd service will not start**: `systemctl status cable82` shows why.
The usual suspects are `User=` naming an account that does not exist, `ExecStart=` pointing at a `node` that is not at `/usr/bin/node` (`which node`), or the repo living somewhere other than `/home/pi/cable-82`.

## What a first-time user will ask

The questions that come up in the first ten minutes, in the order they come up.

**"It's running. Now what?"**
Open the control room at the address the server printed, and add a channel: the Channels group, "+ Add channel", pick a folder.
Until you do, the set is a bulletin board with the sample messages and a guide with two entries.
The fastest way to a real channel is `node channels/fetch-demo-channel.js`, which downloads eight public-domain films into `channels/retro-tv/`; then pick `retro-tv` in the folder picker.

**"Where do my videos go?"**
In a folder under `channels/`, one folder per channel, any name (`saturday-cartoons`, `Late Night`).
The control room's folder picker lists what is there; you never type a path.
A library that will not fit on the card goes in a `channels` folder at the top of a USB stick or a network share, and the picker lists that too, with the drive's name.

**"Why is there no sound?"**
On a desktop browser, because you have not clicked yet: browsers do not play audio until the first gesture on the page.
Click anywhere on the display and the music starts.
On the Pi kiosk the `--autoplay-policy=no-user-gesture-required` flag in the launch line starts it from boot.
Check too that Music is switched on in the control room's Quick settings, and that there are files in `music/` (two ship with it).

**"Is it actually playing what the guide says?"**
Yes.
The guide and the player read the same clock, so what the grid names for this half hour is what is on the air, and a commercial break is never listed as the program.
What a program is called is the channel's choice on its row in the dial: the file name, the title inside the file, or one name for the whole channel.

**"I edited config.json and my changes disappeared."**
Either the file is not valid JSON any more, or the control room saved over it.
If the file broke, the set says PLEASE STAND BY with the line number, the control room says the same in its status line, and the last good settings stay on the air; fix the line, or press Save in the control room to write a good file.
If a control room was open while you edited, it warned that the file had changed and refused a stale save; reload it and it shows what is on disk.

**"Which address do I give my phone?"**
The one the server printed under "a browser on another device on your network", usually the `192.168.x.x` one.
A machine with Docker, WSL, or a VPN prints extra addresses for those adapters; the one that starts like your router's is the Wi-Fi.
`/remote-control` on that address is the remote; `/config` is the control room.
