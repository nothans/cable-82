# music/

Drop audio files in here and channel 82, the Community Bulletin Board, plays them as continuous background music behind its pages, the way the old bulletin board channels piped in beautiful music behind the scrolling listings.

- Any common format works: `.mp3`, `.m4a`, `.aac`, `.ogg`, `.oga`, `.opus`, `.wav`, `.flac`.
- Every track in this folder is part of the rotation. The channel loops the whole set, and can shuffle it.
- The music belongs to channel 82. Tune to a video or external channel and it pauses with the board; tune back and it picks up where it left off.
- Turn music on or off, shuffle, and set the volume in the control room's Music panel.

Two tracks ship with the channel, `cable-82-1980s.mp3` and `cable-82-1990s.mp3`.
Anything else you add stays local: the two bundled tracks are committed, the rest are gitignored.

## A note on autoplay

Browsers block audio from starting on its own until someone interacts with the page.
On a desktop browser the music kicks in on your first click.
On the Raspberry Pi kiosk, launch Chromium with:

```
--autoplay-policy=no-user-gesture-required
```

and it plays from boot with no one touching anything.
The kiosk script in the main README's [Chromium in kiosk mode](../README.md#3-chromium-in-kiosk-mode) step already includes it.
