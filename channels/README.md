# channels/

Video channels live here: one folder of video files per channel, aired on a broadcast clock.

## A working channel in one command

```
node channels/fetch-demo-channel.js
```

That downloads **RETRO TV**: eight films from the Internet Archive's Prelinger collection, each explicitly marked public domain in the Archive's own metadata - Duck and Cover, GM's Design for Dreaming, the monkey-mask bicycle-safety classic One Got Fat, and five more (~390 MB, just under two hours).
Then open the control room, add a Video channel, and pick the `retro-tv` folder.

## Your own channels

Each subfolder is one channel's library: drop video files in, point a channel at the folder from the control room's Channels group, and it's on the dial.

```
channels/
  90s-commercials/
    S01.E01.mp4
    S01.E02.mp4
    ...
```

Schedules, off-air cards, and the tuner are covered in the main README's [Channels](../README.md#channels) section.

## How it works

- **Folder = channel.** The dial lists these folders in a picker; you never type a path.
- **Any drive will do.** This folder is the built-in one, not the only one. A `channels` folder at the top of a USB drive or a mounted share contributes its folders to the same picker, which is how a library bigger than the boot card gets on the air. Same names, same rules; the control room says which drive each one came from. Drives are found under `/media`, `/mnt`, and `/Volumes`; `node server.js --media /path/to/library` names one anywhere else.
- **Order.** Files sort naturally (digit runs compare as numbers, so `E2` comes before `E10`); name files in airing order, e.g. `S01.E01.mp4`. Or set the channel to *Shuffled daily*: a fresh order each day, seeded by the date, so it holds all day and reshuffles tomorrow.
- **Broadcast, not playback.** The channel's position is computed from the wall clock, so tuning away and back lands you mid-program. Nothing ever "resumes where you left off" - that's a VCR, not a channel.
- **Formats.** `.mp4`, `.m4v`, `.webm`, `.ogv`, `.mov`. On a Pi 3 B+, H.264 up to ~480p plays comfortably in software; test anything bigger.
- **`.durations.json`.** The display probes each file's duration once and posts it back; the server caches it in a `.durations.json` inside the folder. Delete the file to force a re-probe. Until every duration is known, the channel plays files sequentially instead of clock-mapped.
- **Commercial breaks.** A channel can take its spots from a second folder here (set *Breaks from* on the channel in the control room, plus the minutes of program between breaks and the spots per break). Each program is cut into even acts of about that length, a break follows every act, the last one included, so one also separates the programs. Breaks need every duration up front: a spot sits out of the rotation until the display has probed it once, and while any program's length is still unknown the channel plays its programs whole, no breaks.

## What gets committed

Everything in this folder except this README and `fetch-demo-channel.js` is ignored.
Video libraries are personal (and often not redistributable); they stay on your machine.
