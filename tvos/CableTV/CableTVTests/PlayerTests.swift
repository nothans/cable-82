// The player and the tuner on a simulator, against a station made of files
// (FakeStation). These run the real AVPlayers, so they take a few seconds
// each; they run one at a time because they share the audio session and
// the set's remembered channel.

import AVFoundation
import CableCore
import Foundation
import Testing
@testable import CableTV

@Suite(.serialized) struct PlayerTests {
    /// How far a cut may land from the clock's boundary. The engine starts
    /// the next segment on the host clock, so on time is well inside this.
    let cutTolerance = 0.15

    @Test func theEngineCutsOnTheBroadcastClock() async throws {
        let station = try FakeStation()
        let files = try await station.clips("movies", count: 4, seconds: 1.5)
        let engine = ChannelEngine(client: station.client)
        engine.start(Channel(number: 2, type: .video, folder: "movies"), library: Library(files: files))
        defer { engine.stop() }
        let timeline = engine.segments
        try #require(timeline.count == 4)

        // Watch for three cuts after the cold load.
        var cuts: [(index: Int, at: Date, url: URL?)] = []
        var last = engine.index
        let deadline = Date().addingTimeInterval(12)
        while cuts.count < 3, Date() < deadline {
            try await Task.sleep(for: .milliseconds(5))
            if engine.index != last {
                last = engine.index
                cuts.append((last, Date(), engine.airURL))
            }
        }
        try #require(cuts.count == 3, "three cuts in 12 seconds of 1.5-second programs")

        for cut in cuts {
            // How late (+) or early (-) the cut was against the clock's boundary.
            let pos = try #require(Dial.positionAt(timeline, at: cut.at))
            let error = pos.index == cut.index ? pos.offset
                : pos.index == (cut.index + timeline.count - 1) % timeline.count ? -(timeline[pos.index].duration! - pos.offset)
                : .infinity
            #expect(abs(error) < cutTolerance, "cut to \(cut.index) was \(Int(error * 1000)) ms off the clock")
            #expect(cut.url == station.client.mediaURL(timeline[cut.index].url), "the right file is on the air")
        }

        // Mid-segment, the picture is where the clock says.
        #expect(await eventually(within: 2) {
            guard let pos = Dial.positionAt(timeline, at: Date()), pos.offset > 0.3, pos.offset < 1.1,
                  pos.index == engine.index, engine.airIsPlaying else { return false }
            return abs(engine.airSeconds - (timeline[pos.index].from + pos.offset)) < 0.2
        }, "the air runs in step with the clock")
    }

    @Test func aFileThatWontPlaySitsOutBehindACardAndTheAirComesBack() async throws {
        let station = try FakeStation()
        var files = try await station.clips("movies", count: 3, seconds: 1.5)
        files.insert(try station.brokenClip("movies", "clip-broken.mp4", listedAs: 1.5), at: 1)
        let engine = ChannelEngine(client: station.client)
        engine.start(Channel(number: 2, type: .video, folder: "movies"), library: Library(files: files))
        defer { engine.stop() }
        let broken = try #require(engine.segments.firstIndex { $0.file == "clip-broken.mp4" })
        let after = (broken + 1) % engine.segments.count

        #expect(await eventually(within: 12) { engine.index == broken && engine.trouble != nil },
                "the broken file's turn shows the card")
        #expect(await eventually(within: 4) { engine.index == after && engine.trouble == nil && engine.airIsPlaying },
                "and the next program comes up on time")
    }

    // MARK: - The tuner

    private func writeConfig(_ station: FakeStation, music: Bool = false, extras: String = "") throws {
        try station.write("api/config", """
        {"config":{"channelName":"TEST 82","timeFormat":"12h",
          "channels":[{"number":2,"type":"video","name":"MOVIES","folder":"movies"},
                      {"number":82,"type":"bulletin","name":"BOARD"}],
          "rotation":[{"type":"clock"}],"pageSeconds":30,
          "music":{"enabled":\(music),"shuffle":false,"volume":0},
          "cheerlights":{"enabled":true} \(extras)}}
        """)
        try station.write("api/cheerlights", #"{"color":"red"}"#)
    }

    @Test func aReconnectToAStationThatsGoneTakesTheOldChannelOffTheAir() async throws {
        let station = try FakeStation()
        let files = try await station.clips("movies", count: 2, seconds: 3)
        try station.list([(2, "movies", files)])
        try writeConfig(station)
        UserDefaults.standard.set(2, forKey: "lastChannel")

        let tuner = Tuner(client: station.client)
        await tuner.boot()
        #expect(await eventually(within: 6) { tuner.screen == .onAir && tuner.engine.airIsPlaying })

        try station.remove("api/config") // the station stops answering
        await tuner.boot()
        guard case .trouble = tuner.screen else {
            Issue.record("expected the trouble card, got \(tuner.screen)")
            return
        }
        #expect(!tuner.engine.airIsPlaying && tuner.engine.airURL == nil, "nothing plays on behind the card")
        #expect(tuner.board == nil)
    }

    @Test func aReconnectLetsTheOldBoardGoWithItsMusic() async throws {
        let station = try FakeStation()
        let tracks = try await station.clips("music", count: 1, seconds: 3)
        try station.write("api/music", #"{"tracks":[{"url":"\#(tracks[0].url)"}]}"#)
        try station.write("api/feed/news", "<rss><channel><item><title>HELLO</title></item></channel></rss>")
        try writeConfig(station, music: true, extras: #","feeds":[{"id":"news","label":"NEWS","url":"https://example.com/"}]"#)
        try station.list([])
        UserDefaults.standard.set(82, forKey: "lastChannel")

        let tuner = Tuner(client: station.client)
        await tuner.boot()
        #expect(await eventually(within: 6) { tuner.screen == .board && tuner.board?.musicIsPlaying == true },
                "the board is on with its music")
        weak let old = tuner.board
        try await Task.sleep(for: .seconds(1)) // let the feed and CheerLights loops run and settle into their sleeps

        await tuner.boot()
        #expect(await eventually(within: 6) { tuner.screen == .board && tuner.board?.musicIsPlaying == true })
        #expect(await eventually(within: 3) { old == nil }, "the old board, its loops, and its music are gone")
        #expect(tuner.board !== old)
        tuner.suspend()
    }
}
