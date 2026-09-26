// A port of cable-82's test/dial.test.mjs, one test per test, same cases.
// JS months are 0-based; local() takes real months, so JS `new Date(2026, 8, 2)`
// is `local(2026, 9, 2)` here.

import Foundation
import Testing
@testable import CableCore

func local(_ y: Int, _ mo: Int, _ d: Int, _ h: Int = 0, _ mi: Int = 0, _ s: Int = 0) -> Date {
    Calendar.current.date(from: DateComponents(year: y, month: mo, day: d, hour: h, minute: mi, second: s))!
}

private struct Item: Timed { var duration: Double? }
private func pl(_ ds: Double?...) -> [Item] { ds.map(Item.init) }

private let day = local(2026, 9, 2, 12)
private func film(_ f: String, _ d: Double?) -> MediaFile { MediaFile(file: f, url: "channels/movies/" + f, duration: d) }
private func spot(_ f: String, _ d: Double?) -> MediaFile { MediaFile(file: f, url: "channels/spots/" + f, duration: d) }
private func programmed(_ b: Breaks?, _ order: Channel.Order = .sequence) -> Channel {
    Channel(number: 3, type: .video, folder: "movies", order: order, breaks: b)
}

@Test func positionAtJoinsMidProgramFromTheWallClock() {
    let p = pl(30, 60, 10)
    #expect(Dial.positionAt(p, nowMs: 0, epochMs: 0) == Position(index: 0, offset: 0))
    #expect(Dial.positionAt(p, nowMs: 45_000, epochMs: 0) == Position(index: 1, offset: 15))
    #expect(Dial.positionAt(p, nowMs: 95_000, epochMs: 0) == Position(index: 2, offset: 5))
    #expect(Dial.positionAt(p, nowMs: 130_000, epochMs: 0) == Position(index: 1, offset: 0), "the loop wraps")
    let week = 7.0 * 24 * 3600 * 1000
    let w = Dial.positionAt(p, nowMs: week + 45_000, epochMs: 0)!
    #expect(w.index == 1)
    #expect(abs(w.offset - 15) < 0.001, "no drift across a week")
    #expect(Dial.positionAt(pl(30, nil), nowMs: 1000, epochMs: 0) == nil, "an unknown duration stops the clock")
    #expect(Dial.positionAt([Item](), nowMs: 1000, epochMs: 0) == nil)
}

@Test func twoSetsAgreeToTheFrame() {
    let p = pl(1800, 3600)
    let now = 1_788_379_953_000.0 // Date.UTC(2026, 8, 2, 20, 12, 33)
    #expect(Dial.positionAt(p, nowMs: now) == Dial.positionAt(p, nowMs: now))
    #expect(Dial.epochMs == 1_767_225_600_000)
}

@Test func seededShuffleIsStableForASeedAndDifferentAcrossSeeds() {
    let src = ["a", "b", "c", "d", "e", "f", "g"]
    #expect(Dial.seededShuffle(src, seed: "2026-8-31#90") == Dial.seededShuffle(src, seed: "2026-8-31#90"))
    #expect(Dial.seededShuffle(src, seed: "2026-8-31#90") != Dial.seededShuffle(src, seed: "2026-9-1#90"))
    #expect(Dial.seededShuffle(src, seed: "x").sorted() == src)
}

@Test func channelTimelineCutsAMovieIntoEvenActsWithABreakAfterEveryAct() {
    let ch = programmed(Breaks(folder: "spots", everyMinutes: 30, spots: 2))
    let tl = Dial.channelTimeline(ch, files: [film("movie.mp4", 6000)],
                                  spots: [spot("s1.mp4", 30), spot("s2.mp4", 15), spot("s3.mp4", 20)], date: day)
    #expect(tl.map(\.file) == ["movie.mp4", "s1.mp4", "s2.mp4", "movie.mp4", "s3.mp4", "s1.mp4", "movie.mp4", "s2.mp4", "s3.mp4"])
    #expect([tl[0].from, tl[0].to, tl[3].from, tl[3].to, tl[6].from, tl[6].to] == [0, 2000, 2000, 4000, 4000, 6000])
    let total = tl.reduce(0) { $0 + $1.duration! }
    #expect(abs(total - (6000 + 30 + 15 + 20 + 30 + 15 + 20)) < 1e-9, "the loop is the film plus its spots")
}

@Test func channelTimelinePlaysWholeWhileAnyDurationIsUnknownAndWithoutUsableSpots() {
    let ch = programmed(Breaks(folder: "spots", everyMinutes: 15, spots: 1))
    #expect(Dial.channelTimeline(ch, files: [film("a.mp4", 1200), film("b.mp4", nil)], spots: [spot("s1.mp4", 30)], date: day)
        .map(\.file) == ["a.mp4", "b.mp4"])
    #expect(Dial.channelTimeline(ch, files: [film("a.mp4", 600)], spots: [spot("s2.mp4", nil)], date: day)
        .map(\.file) == ["a.mp4"])
}

@Test func airStateSaturdayMorningCartoons() {
    let ch = Channel(number: 1, type: .video, mode: .schedule,
                     schedule: [ScheduleWindow(days: ["sat"], start: "08:00", end: "11:30")])
    let on = Dial.airState(ch, at: local(2026, 8, 29, 9)) // Sat Aug 29 2026
    #expect(on.onAir)
    #expect(Calendar.current.component(.hour, from: on.until!) == 11)
    #expect(!Dial.airState(ch, at: local(2026, 8, 29, 11, 30)).onAir, "half-open end")
    let tue = Dial.airState(ch, at: local(2026, 9, 1, 14))
    #expect(!tue.onAir)
    #expect(tue.resumeText == "PROGRAMMING RESUMES SATURDAY 8:00 AM")
    #expect(Dial.airState(ch, at: local(2026, 8, 29, 6)).resumeText == "PROGRAMMING RESUMES TODAY 8:00 AM")
    #expect(Dial.airState(Channel(number: 1, type: .video, mode: .continuous), at: Date()).onAir)
}

@Test func airStateAnOvernightWindowIsOneWindowAcrossMidnight() {
    let w = ScheduleWindow(days: ["sat"], start: "20:00", end: "01:00")
    let ch = Channel(number: 1, type: .video, mode: .schedule, schedule: [w])
    #expect(Dial.airState(ch, at: local(2026, 8, 29, 23, 30)).onAir)
    #expect(Dial.airState(ch, at: local(2026, 8, 30, 0, 30)).onAir)
    #expect(!Dial.airState(ch, at: local(2026, 8, 30, 1, 0)).onAir)
    #expect(Dial.airState(ch, at: local(2026, 8, 30, 2, 0)).resumeText == "PROGRAMMING RESUMES SATURDAY 8:00 PM")
    #expect(Dial.windowSegments(w) == [
        WindowSegment(day: 6, start: 1200, end: 1440),
        WindowSegment(day: 0, start: 0, end: 60, cont: true),
    ])
}

@Test func theDialWrapsOrClampsAndTheVolumeKeyWalksTheZenithOrder() {
    #expect(Dial.nextChannelIndex(count: 3, from: 2, dir: +1, wrap: true) == 0)
    #expect(Dial.nextChannelIndex(count: 3, from: 2, dir: +1, wrap: false) == 2)
    #expect(Dial.nextChannelIndex(count: 3, from: 0, dir: -1, wrap: true) == 2)
    #expect(Dial.nextChannelIndex(count: 1, from: 0, dir: +1, wrap: true) == 0)
    #expect(Dial.volumeSteps.map(\.name) == ["LOUD", "SOUND OFF", "SOFT", "MEDIUM"])
    var i = 0
    var seen: [Int] = []
    for _ in 0..<5 { i = Dial.nextVolumeStep(i); seen.append(i) }
    #expect(seen == [1, 2, 3, 0, 1])
    #expect(Dial.nextVolumeStep(nil) == 1, "a bad step is loud, and steps to off")
}

@Test func theGuideReadsTheSameClockAsThePlayerAndMergesALongProgram() {
    #expect(Dial.programTitle("02 Design for Dreaming (1956).mp4") == "DESIGN FOR DREAMING (1956)")
    #expect(Dial.programTitle("S01.E13 Duck and Cover.mkv") == "DUCK AND COVER")
    let at = local(2026, 9, 2, 20, 12)
    let hm = Dial.guideSlots(at, count: 3).map { Dial.formatClock($0, .twentyFourHour) }
    #expect(hm == ["20:00", "20:30", "21:00"])
    let films = [
        MediaFile(file: "Long Movie.mp4", url: "channels/r/a.mp4", duration: 5400),
        MediaFile(file: "Short.mp4", url: "channels/r/b.mp4", duration: 1800),
    ]
    let ch = Channel(number: 2, type: .video, folder: "r")
    let tl = Dial.channelTimeline(ch, files: films, spots: [], date: at)
    let pos = Dial.positionAt(tl, at: at)!
    #expect(Dial.programAt(ch, library: Library(files: films), at: at)?.title == Dial.programTitle(tl[pos.index].file))
    let dial = [Channel(number: 0, name: "CABLEVUE", type: .guide), ch, Channel(number: 7, type: .video, enabled: false)]
    let g = Dial.guideGrid(dial, libraries: [2: Library(files: films)], at: at, count: 3)
    #expect(g.rows.count == 2, "a channel off the dial is not listed")
    #expect(g.rows[0].cells[0].span == 3, "the guide's own row is one cell across")
    #expect(g.rows[1].cells.reduce(0) { $0 + $1.span } == 3, "every slot is covered")
}

@Test func theGuideNeverListsACommercial() {
    let ch = Channel(number: 2, type: .video, folder: "movies", breaks: Breaks(folder: "spots", everyMinutes: 30, spots: 1))
    let films = [film("Long Movie.mp4", 3600), film("Short.mp4", 1800)]
    let spots = [spot("Buy Soap.mp4", 30)]
    let lib = Library(files: films, spots: spots)
    let at = local(2026, 9, 3, 12)
    let tl = Dial.channelTimeline(ch, files: films, spots: spots, date: at)
    #expect(tl.map(\.kind) == [.program, .spot, .program, .spot, .program, .spot])
    var total = 0.0
    let starts = tl.map { s -> Double in defer { total += s.duration! }; return total }
    let when = { (s: Double) in Date(timeIntervalSince1970: (Dial.epochMs + s * 1000) / 1000) }
    let inSpot = Dial.programAt(ch, library: lib, at: when(starts[1] + 10))!
    #expect(inSpot.title == "LONG MOVIE")
    #expect(inSpot.kind == .program)
    #expect(Dial.programAt(ch, library: lib, at: when(starts[2] + 10))?.title == "LONG MOVIE")
    #expect(Dial.programAt(ch, library: lib, at: when(starts[3] + 5))?.title == "LONG MOVIE",
            "the break after the last act still belongs to the film")
}

@Test func segmentNameFollowsTheChannelsTitlesSetting() {
    let seg = Segment(kind: .program, file: "BBDVD0102.mp4", title: "Give Blood", url: "", from: 0, to: nil, duration: nil)
    let bare = Segment(kind: .program, file: "02 Design for Dreaming.mp4", title: nil, url: "", from: 0, to: nil, duration: nil)
    #expect(Dial.segmentName(Channel(number: 1, type: .video, titles: .filename), seg) == "BBDVD0102")
    #expect(Dial.segmentName(Channel(number: 1, type: .video, titles: .metadata), seg) == "GIVE BLOOD")
    #expect(Dial.segmentName(Channel(number: 1, type: .video, titles: .metadata), bare) == "DESIGN FOR DREAMING")
    #expect(Dial.segmentName(Channel(number: 1, type: .video, titles: .fixed, title: "COMMERCIALS"), seg) == "COMMERCIALS")
    #expect(Dial.segmentName(Channel(number: 1, name: "LATE NIGHT", type: .video, titles: .fixed), seg) == "LATE NIGHT")
    #expect(Dial.segmentName(Channel(number: 1, type: .video), seg) == "BBDVD0102")
}

@Test func theClockFaceWrites12h24hAndSeconds() {
    let d = local(2026, 9, 2, 20, 4, 7)
    #expect(Dial.formatClock(d, .twelveHour) == "8:04 PM")
    #expect(Dial.formatClock(d, .twentyFourHour) == "20:04")
    #expect(Dial.formatClock(d, .twelveHour, seconds: true) == "8:04:07 PM")
    #expect(Dial.formatClock(local(2026, 7, 21, 0, 30), .twelveHour) == "12:30 AM")
    #expect(Dial.formatHeaderDate(local(2026, 7, 21)) == "TUE JUL 21")
    #expect(Dial.formatLongDate(local(2026, 7, 21)) == "TUESDAY, JULY 21, 2026")
}

@Test func configDecodesLenientlyWithSchemaDefaults() throws {
    let json = """
    {"version":"1","config":{"channels":[
      {"number":2,"type":"video","folder":"retro-tv","order":"shuffle-daily","breaks":{"folder":"spots","everyMinutes":15,"spots":3}},
      {"number":82,"type":"bulletin","name":"CABLE 82"},
      {"number":5,"type":"video","folder":"x","enabled":false,"titles":"something-new"}
    ],"tuner":{"wrap":false}}}
    """
    let r = try JSONDecoder().decode(ConfigResponse.self, from: Data(json.utf8))
    #expect(r.config.channels.count == 3)
    #expect(r.config.channels[0].order == .shuffleDaily)
    #expect(r.config.channels[0].breaks == Breaks(folder: "spots", everyMinutes: 15, spots: 3))
    #expect(r.config.channels[2].titles == .filename, "an unknown value falls back")
    #expect(r.config.dial.map(\.number) == [2, 82])
    #expect(r.config.tuner.wrap == false)
    #expect(r.config.tuner.cut == .static)
}
