# cable-82-tv

A native Apple TV client for [CABLE 82](https://github.com/nothans/cable-82). The Node server runs on the LAN
and serves the channels, the config, and the video. This app replaces the browser display.

## Layout

| Path | What it is |
| --- | --- |
| `CableCore/` | Swift package with no UI: the broadcast clock (a port of `dial.js`), the channel models, and the server API types. Builds and tests on macOS. |
| `CableCore/Tests/CableCoreTests/DialTests.swift` | `test/dial.test.mjs`, ported case for case. |
| `CableCore/Tests/CableCoreTests/ReferenceTests.swift` | Differential tests: the original `dial.js` runs in JavaScriptCore on generated inputs, and the Swift answers must be identical (offsets bit for bit). |
| `CableTV/` | The tvOS app (SwiftUI + AVFoundation), linking `CableCore` as a local package. Deployment target tvOS 26 (the Apple TV HD's last). |
| `CableTV/CableTV/ChannelEngine.swift` | The player (video.js): two AVPlayers, the next segment cued and started on the host clock at its exact boundary, assets preloaded ahead. |
| `CableTV/CableTV/Tuner.swift` | The dial (tuner.js): channel changes under static, the on-screen display, off-air cards, power, measuring missing durations and posting them back. |
| `CableTV/Info.plist` | Partial Info.plist merged into the generated one: plain HTTP on the LAN (`NSAllowsLocalNetworking`) and the local-network prompt. |

## The remote

| Siri Remote | Does |
| --- | --- |
| Swipe or click up / down | Channel up / down (wraps per the station's `tuner.wrap`) |
| Select | Shows the channel and what's on |
| Hold Select | Settings: change station, reconnect |
| Play/Pause | Power, with the CRT switch-off |
| Menu | Leaves the app (tvOS convention) |

## Testing

```
cd CableCore && swift test
```

When upstream `dial.js` or `config-schema.js` changes, copy them into `CableCore/Tests/CableCoreTests/Reference/`
and run the tests. Any difference between the port and the new reference shows up as a failure.

## License

See `THIRD_PARTY_NOTICES.md` for CABLE 82's MIT notice, which must ship with the app.
