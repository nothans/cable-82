// Differential tests: the station's own dial.js and config-schema.js, from
// the top of this repo, run in JavaScriptCore beside the Swift port on
// thousands of generated inputs, and the answers must be identical. Offsets
// are compared bit for bit: an Apple TV and a browser display tuned to the
// same channel have to land on the same frame.
//
// Because they read the live files, a change to the broadcast clock that the
// port doesn't follow fails here instead of quietly desyncing the Apple TV.

#if canImport(JavaScriptCore) && os(macOS)
import Foundation
import JavaScriptCore
import Testing
@testable import CableCore

/// The repo's top level: this file is tvos/CableCore/Tests/CableCoreTests/ReferenceTests.swift.
private let repoRoot = URL(fileURLWithPath: #filePath)
    .deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
    .deletingLastPathComponent().deletingLastPathComponent()

/// dial.js and config-schema.js loaded in a fresh JS context.
private final class ReferenceDial {
    let ctx = JSContext()!

    init() throws {
        ctx.exceptionHandler = { _, e in Issue.record("JS exception: \(e?.toString() ?? "?")") }
        for name in ["config-schema.js", "dial.js"] {
            let url = repoRoot.appending(path: name)
            ctx.evaluateScript(try String(contentsOf: url, encoding: .utf8), withSourceURL: url)
        }
        #expect(ctx.evaluateScript("typeof Cable82Dial.positionAt")?.toString() == "function")
    }

    /// Evaluate `expr` (which may use the given JSON-encoded bindings) and
    /// decode JSON.stringify of the result.
    func call<T: Decodable>(_ expr: String, _ bindings: [String: Any] = [:], as _: T.Type = T.self) throws -> T {
        var prelude = ""
        for (k, v) in bindings {
            let data = try JSONSerialization.data(withJSONObject: v, options: [.fragmentsAllowed])
            prelude += "const \(k) = \(String(decoding: data, as: UTF8.self));\n"
        }
        let src = "(() => { \(prelude) return JSON.stringify(\(expr)); })()"
        let out = try #require(ctx.evaluateScript(src)?.toString())
        return try JSONDecoder().decode(T.self, from: Data(out.utf8))
    }
}

/// SplitMix64, so failures reproduce.
private struct Rng {
    var state: UInt64
    mutating func next() -> UInt64 {
        state &+= 0x9E37_79B9_7F4A_7C15
        var z = state
        z = (z ^ (z >> 30)) &* 0xBF58_476D_1CE4_E5B9
        z = (z ^ (z >> 27)) &* 0x94D0_49BB_1331_11EB
        return z ^ (z >> 31)
    }
    mutating func int(_ r: ClosedRange<Int>) -> Int { r.lowerBound + Int(next() % UInt64(r.count)) }
    mutating func double(_ lo: Double, _ hi: Double) -> Double { lo + (hi - lo) * Double(next() >> 11) / Double(1 << 53) }
    mutating func bool() -> Bool { next() & 1 == 1 }
}

// Plain JSON shapes for handing inputs to JS.
private func js(_ f: MediaFile) -> [String: Any] {
    ["file": f.file, "url": f.url, "duration": f.duration as Any? ?? NSNull(), "title": f.title as Any? ?? NSNull()]
}
private func js(_ c: Channel) -> [String: Any] {
    var o: [String: Any] = [
        "number": c.number, "name": c.name, "type": c.type.rawValue, "enabled": c.enabled,
        "folder": c.folder ?? "", "order": c.order.rawValue, "mode": c.mode.rawValue,
        "titles": c.titles.rawValue,
        "schedule": c.schedule.map { ["days": $0.days, "start": $0.start, "end": $0.end] },
    ]
    if let b = c.breaks { o["breaks"] = ["folder": b.folder, "everyMinutes": b.everyMinutes, "spots": b.spots] }
    if let t = c.title { o["title"] = t }
    return o
}
private func ms(_ d: Date) -> Double { d.timeIntervalSince1970 * 1000 }

private struct JSSegment: Decodable { var kind: String; var file: String; var from: Double; var to: Double?; var duration: Double? }
private struct JSPosition: Decodable { var index: Int; var offset: Double }
private struct JSAir: Decodable { var onAir: Bool; var untilMs: Double?; var resumeText: String }
private struct JSProgram: Decodable { var title: String; var kind: String }
private struct JSCell: Decodable { var title: String; var kind: String; var span: Int; var slot: Int }
private struct JSRow: Decodable { var number: Int; var cells: [JSCell] }
private struct JSGrid: Decodable { var rows: [JSRow] }

private func randomLibrary(_ r: inout Rng, prefix: String, count: ClosedRange<Int>, unknownRate: Int = 0) -> [MediaFile] {
    (0..<r.int(count)).map { i in
        let unknown = unknownRate > 0 && r.int(0...unknownRate) == 0
        return MediaFile(file: "\(prefix)\(i).mp4", url: "channels/\(prefix)/\(i).mp4",
                         duration: unknown ? nil : r.double(5, 7200))
    }
}

private func randomChannel(_ r: inout Rng) -> Channel {
    let days = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"]
    let hm = { (r: inout Rng) in "\(r.int(0...23)):\(Dial.pad2(r.int(0...3) * 15))" }
    var schedule: [ScheduleWindow] = []
    if r.bool() {
        for _ in 0..<r.int(1...3) {
            let ds = days.filter { _ in r.int(0...2) == 0 }
            schedule.append(ScheduleWindow(days: ds.isEmpty ? ["sat"] : ds, start: hm(&r), end: hm(&r)))
        }
    }
    return Channel(number: r.int(1...999), type: .video, folder: "p",
                   order: r.bool() ? .shuffleDaily : .sequence,
                   mode: schedule.isEmpty ? .continuous : .schedule, schedule: schedule,
                   breaks: r.bool() ? Breaks(folder: "s", everyMinutes: Double(r.int(0...60)), spots: r.int(1...4)) : nil)
}

private func randomDate(_ r: inout Rng) -> Date {
    // 2026 through 2030, at any millisecond: across DST changes and many loop wraps.
    Date(timeIntervalSince1970: (Dial.epochMs + r.double(0, 5 * 365.25 * 86_400_000).rounded()) / 1000)
}

@Suite struct ReferenceTests {
    fileprivate let ref: ReferenceDial
    init() throws { ref = try ReferenceDial() }

    @Test func seededShuffleMatchesBitForBit() throws {
        var r = Rng(state: 1)
        let seeds = ["", "x", "2026-8-31#90", "2026-12-31#999#breaks", "émoji 📺 seed"] +
            (0..<500).map { _ in "\(r.int(2026...2030))-\(r.int(1...12))-\(r.int(1...31))#\(r.int(0...999))" }
        for seed in seeds {
            let src = Array(0..<r.int(0...40))
            let expected: [Int] = try ref.call("Cable82Dial.seededShuffle(src, seed)", ["src": src, "seed": seed])
            #expect(Dial.seededShuffle(src, seed: seed) == expected, "seed \(seed)")
        }
    }

    @Test func channelTimelineAndPositionMatch() throws {
        var r = Rng(state: 2)
        for _ in 0..<300 {
            let ch = randomChannel(&r)
            let files = randomLibrary(&r, prefix: "p", count: 1...12, unknownRate: 20)
            let spots = randomLibrary(&r, prefix: "s", count: 0...8, unknownRate: 5)
            let date = randomDate(&r)
            let b: [String: Any] = ["ch": js(ch), "files": files.map(js), "spots": spots.map(js), "t": ms(date)]
            let tlJS: [JSSegment] = try ref.call("Cable82Dial.channelTimeline(ch, files, spots, new Date(t))", b)
            let tl = Dial.channelTimeline(ch, files: files, spots: spots, date: date)
            try #require(tl.count == tlJS.count)
            for (s, j) in zip(tl, tlJS) {
                #expect(s.kind.rawValue == j.kind && s.file == j.file && s.from == j.from && s.to == j.to && s.duration == j.duration)
            }
            // Many instants against the same timeline, including far from the epoch.
            for _ in 0..<20 {
                let now = ms(randomDate(&r))
                let pJS: JSPosition? = try ref.call(
                    "Cable82Dial.positionAt(Cable82Dial.channelTimeline(ch, files, spots, new Date(t)), now, Cable82Dial.EPOCH)",
                    b.merging(["now": now]) { $1 })
                let p = Dial.positionAt(tl, nowMs: now)
                #expect(p?.index == pJS?.index)
                #expect(p?.offset.bitPattern == pJS?.offset.bitPattern, "offset must match bit for bit")
            }
        }
    }

    @Test func airStateMatches() throws {
        var r = Rng(state: 3)
        for _ in 0..<2000 {
            let ch = randomChannel(&r)
            let date = randomDate(&r)
            let a: JSAir = try ref.call("Cable82Dial.airState(ch, new Date(t))", ["ch": js(ch), "t": ms(date)])
            let s = Dial.airState(ch, at: date)
            #expect(s.onAir == a.onAir)
            #expect(s.until.map(ms) == a.untilMs, "\(ch.schedule) at \(date)")
            #expect(s.resumeText == a.resumeText)
        }
    }

    @Test func programTitleMatches() throws {
        let names = [
            "02 Design for Dreaming (1956).mp4", "S01.E13 Duck and Cover.mkv", "s1e2_the_pilot.MOV",
            "100 Things.mp4", "1000 Things.mp4", "  7 - Seven.m4v", "...", ".mp4", "no_extension",
            "Movie.Name.2019.1080p.mp4", "résumé café.webm", "S1 E1.mp4", "01-02-03.mp4",
        ]
        for n in names {
            let expected: String = try ref.call("Cable82Dial.programTitle(n)", ["n": n])
            #expect(Dial.programTitle(n) == expected, "\(n)")
        }
    }

    @Test func guideGridMatches() throws {
        var r = Rng(state: 4)
        for _ in 0..<100 {
            var channels = [Channel(number: 0, name: "CABLEVUE", type: .guide)]
            var libs: [Int: Library] = [:]
            var libsJS: [String: Any] = [:]
            for n in 1...4 {
                var ch = randomChannel(&r)
                ch.number = n
                ch.titles = [.filename, .fixed][r.int(0...1)]
                ch.enabled = r.int(0...5) > 0
                let lib = Library(files: randomLibrary(&r, prefix: "p", count: 0...6),
                                  spots: randomLibrary(&r, prefix: "s", count: 0...4))
                channels.append(ch)
                libs[n] = lib
                libsJS[String(n)] = ["files": lib.files.map(js), "spots": lib.spots.map(js)]
            }
            let date = randomDate(&r)
            let count = r.int(2...4)
            let g: JSGrid = try ref.call("Cable82Dial.guideGrid(chs, libs, new Date(t), count, Cable82Dial.EPOCH)",
                                         ["chs": channels.map(js), "libs": libsJS, "t": ms(date), "count": count])
            let s = Dial.guideGrid(channels, libraries: libs, at: date, count: count)
            #expect(s.rows.map(\.number) == g.rows.map(\.number))
            for (row, rowJS) in zip(s.rows, g.rows) {
                #expect(row.cells.map { "\($0.title)|\($0.kind.rawValue)|\($0.span)|\($0.slot)" } ==
                        rowJS.cells.map { "\($0.title)|\($0.kind)|\($0.span)|\($0.slot)" })
            }
        }
    }
}
#endif
