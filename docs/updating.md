# Updating

An update is a `git pull` and a restart.
Your settings, schedules, videos, and music are yours and stay put.

```
cd cable-82
git pull
node server.js
```

On a Pi running the service, restart the service instead of starting the server by hand:

```
cd ~/cable-82 && git pull && sudo systemctl restart cable82
```

The display updates itself.
When the server comes back, the set reconnects to the tuner bus, sees a new build, and reloads onto the new files within a few seconds; the broadcast clock puts the program back where it belongs, on the same channel, at the same volume.
Nobody touches the TV or the kiosk.

`config.json`, your folders under `channels/`, and your own tracks in `music/` are not tracked by git, so an update never changes a setting, a schedule, a video, or a song.
Releases and what changed in each are at [github.com/nothans/cable-82/releases](https://github.com/nothans/cable-82/releases); `git describe --tags` names the one you are on, and so does the control room's masthead.
