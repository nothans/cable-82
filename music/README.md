# music

Drop audio files in here and CABLE 82 plays them as continuous background music behind the channel, the way the old bulletin board channels piped in beautiful music behind the scrolling listings.

- Any common format works: `.mp3`, `.m4a`, `.aac`, `.ogg`, `.opus`, `.wav`, `.flac`.
- Every track in this folder is part of the rotation. The channel loops the whole set, and can shuffle it.
- Turn music on or off, shuffle, and set the volume in the control room at `/config`.

Two tracks ship with the channel, `cable-82-1980s.mp3` and `cable-82-1990s.mp3`. Anything else you add stays local: the two bundled tracks are committed, the rest are gitignored, so your own music never lands in a git commit.

## A note on autoplay

Browsers block audio from starting on its own until someone interacts with the page. On a desktop browser the music kicks in on your first click. On the Raspberry Pi kiosk, launch Chromium with:

```
--autoplay-policy=no-user-gesture-required
```

and it plays from boot with no one touching anything.
