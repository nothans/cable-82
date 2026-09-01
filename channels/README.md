# channels/

Video channels live here.

## A working channel in one command

```
node channels/fetch-demo-channel.js
```

That downloads **RETRO TV**: eight films from the Internet Archive's Prelinger collection, each explicitly marked public domain in the Archive's own metadata - Duck and Cover, GM's Design for Dreaming, the monkey-mask bicycle-safety classic One Got Fat, and five more (~390 MB, just under two hours).
Then open the control room, add a Video channel, and pick the `retro-tv` folder.

## Your own channels

Each subfolder is one channel's library: drop video files in, point a channel at the folder from the control room, and the files play in order on a broadcast clock.

```
channels/
  90s-commercials/
    S01.E01.mp4
    S01.E02.mp4
    ...
```

## How it works

- **Folder = channel.** The control room's channel editor lists these folders in a picker; you never type a path.
- **Order.** Files sort naturally (digit runs compare as numbers, so `E2` comes before `E10`). Name files so the sort is the airing order, e.g. `S01.E01.mp4`.
- **Broadcast, not playback.** The channel's position is computed from the wall clock, so tuning away and back lands you mid-program. Nothing ever "resumes where you left off" - that's a VCR, not a channel.
- **Formats.** `.mp4`, `.m4v`, `.webm`, `.ogv`, `.mov`. On the Pi, H.264 up to ~480p plays comfortably in software; test anything bigger.
- **`.durations.json`.** The display probes each file's duration once and posts it back; the server caches it in a `.durations.json` inside the folder. Delete the file to force a re-probe. Until every duration is known, the channel plays files sequentially instead of clock-mapped.

## Git

Everything in this folder except this README and `fetch-demo-channel.js` is ignored.
Video libraries are personal (and often not redistributable); they stay on your machine.
