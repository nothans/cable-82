# CABLE 82 on an Apple TV

A native tvOS display for the station.
It is another set on the same network, beside the browser display, not a replacement for it: the server, the control room, and the remote stay exactly as they are, and the Apple TV tunes in like any other set.

It plays the video channels on the same broadcast clock, so an Apple TV and a browser on the same channel show the same frame, and it carries CABLEVUE on channel 0 and the Community Bulletin Board on 82: the pages, the weather card, the crawl with its headlines and the CheerLights color, and the music bed.
Channel changes go under tuner static with the on-screen display, a scheduled channel off the air shows its test card and when it comes back, and Play/Pause switches the set off the way a tube does.

Not yet: the tuner bus, so the phone remote does not change an Apple TV's channel yet.
External channels cannot come: tvOS has no web view.
The guide still lists every channel, including the ones this set cannot tune.

## What you need

- A Mac with Xcode 26 or newer.
- An Apple TV HD (2015) or any Apple TV 4K, on tvOS 26 or newer, on the same network as the station.
- An Apple account signed in to Xcode. A free account is enough for your own Apple TV; builds made with it stop launching after seven days, and running from Xcode again renews them.

## Build and run

1. Copy `CableTV/Config/Local.xcconfig.example` to `CableTV/Config/Local.xcconfig` and fill in your team ID (Xcode, Settings, Accounts) and a bundle prefix of your own, like `com.yourname`. Git ignores the file. Without it the project still builds and runs in the simulator.
2. Pair the Apple TV with Xcode: on the Apple TV, Settings, Remotes and Devices, Remote App and Devices; in Xcode, open Devices and Simulators (⇧⌘2) and pair it when it appears.
3. Open `CableTV/CableTV.xcodeproj`, pick the Apple TV as the run destination, and press ⌘R.
4. On the Apple TV, enter the station's address, the one `node server.js` prints: `192.168.1.42`, or a name like `raspberrypi.local`. The port defaults to 1982. Allow the local network access tvOS asks for; if the first try says no answer, try again.

| Siri Remote | Does |
| --- | --- |
| Up / down (swipe or click) | Channel up / down, wrapping if `tuner.wrap` says so |
| Select | The channel and what is on |
| Hold Select | Settings: another station, reconnect |
| Play/Pause | Power |
| Menu / Back | Leaves the app, as tvOS expects |

## Video that plays

The Apple TV plays what AVFoundation plays, which is narrower than what a browser does:

- MP4, M4V, or MOV holding H.264 (HEVC on the Apple TV 4K models), up to 1080p on an Apple TV HD.
- AAC, AC-3, or MP3 audio. Multichannel AAC has to declare its channel layout; recordings that do not (some DVR exports) play silent. Stereo AAC always works.
- The index at the front of the file (`-movflags +faststart`), so tuning in mid-program does not wait for a fetch from the end of a big file.

One ffmpeg line makes a problem file right without touching the picture:

```
ffmpeg -i in.mp4 -map 0:v:0 -map 0:a:0 -c:v copy -c:a aac -ac 2 -b:a 192k -movflags +faststart out.mp4
```

A file the set cannot read is left out of its timeline and named in the Xcode console.

The first time an Apple TV tunes a channel whose files have never played anywhere, it measures them before the clock can run and posts the lengths back to the server, the way the browser display does; it shows PLEASE STAND BY while it works.
For a big folder that is worth doing ahead of time by playing the channel once in a browser.

## How it is put together

| Path | What it is |
| --- | --- |
| `CableCore/` | A Swift package with no UI: `dial.js` and the schema's window math ported line for line (`Dial.swift`, `Schedule.swift`, `Guide.swift`), the config and listing types, and the API client. Builds and tests on the Mac. |
| `CableCore/Tests/` | `test/dial.test.mjs` ported case for case, and `ReferenceTests.swift`, which runs this repo's own `dial.js` and `config-schema.js` in JavaScriptCore on thousands of generated inputs and requires the Swift answers to match, offsets bit for bit. |
| `CableTV/CableTV/ChannelEngine.swift` | The player (`video.js`): two AVPlayers, the next segment cued and started on the host clock at its exact boundary, files loaded a few segments ahead. |
| `CableTV/CableTV/Tuner.swift` | The dial (`tuner.js`): tuning under static, the on-screen display, off-air cards, power, measuring and posting durations. |
| `CableTV/CableTV/GuideView.swift` | Channel 0 (`guide.js`). |
| `CableCore/Sources/CableCore/Board.swift` | Channel 82's logic from `board.js` and the schema: the settings, the page rotation, the colors, feed parsing, the crawl text, `sanitize`. The helpers and color rules are tested against the JavaScript itself. |
| `CableTV/CableTV/BulletinBoard.swift`, `BoardView.swift` | Channel 82 on screen: the refresh loops, the music bed, the header, the pages, and the crawl. |
| `CableTV/Info.plist` | Plain HTTP on the local network (`NSAllowsLocalNetworking`) and the local-network prompt. |

## Testing

```
cd tvos/CableCore && swift test
```

Because the reference tests read the live `dial.js`, a change to the broadcast clock shows up here as a failure until the Swift port follows it.
