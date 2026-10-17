// The decisions ChannelEngine and Tuner make, tested without a player.

import Foundation
import Testing
@testable import CableCore

private func film(_ f: String, _ d: Double?) -> MediaFile { MediaFile(file: f, url: "channels/movies/" + f, duration: d) }

// MARK: - Against the clock

@Test func driftIsTheShortWayRoundTheLoop() {
    #expect(Playout.drift(onAir: 12, clock: 10, loopLength: 100) == 2)
    #expect(Playout.drift(onAir: 10, clock: 12, loopLength: 100) == -2)
    #expect(Playout.drift(onAir: 1, clock: 99, loopLength: 100) == 2, "just past the seam is ahead, not 98 behind")
    #expect(Playout.drift(onAir: 99, clock: 1, loopLength: 100) == -2)
    #expect(Playout.drift(onAir: 250, clock: 50, loopLength: 100) == 0, "whole loops apart is in step")
    #expect(Playout.drift(onAir: 5, clock: 1, loopLength: 0) == 0, "no loop, no drift")
}

@Test func startDelayWaitsForTheSegmentOrJoinsOneThatJustStarted() {
    // A segment ahead: wait for it.
    #expect(Playout.startDelay(segmentStart: 60, clock: 50, loopLength: 100, tolerance: 1.5) == 10)
    // One the clock just passed: start it that far in, don't wait a whole loop.
    #expect(Playout.startDelay(segmentStart: 60, clock: 60.5, loopLength: 100, tolerance: 1.5) == -0.5)
    // Past the tolerance: its turn is next time round.
    #expect(Playout.startDelay(segmentStart: 60, clock: 62, loopLength: 100, tolerance: 1.5) == 98)
    // Across the seam: the loop's first segment, cued near the end of the loop.
    #expect(Playout.startDelay(segmentStart: 0, clock: 97, loopLength: 100, tolerance: 1.5) == 3)
    // A one-segment loop cues itself: next time round, or now if it just began.
    #expect(Playout.startDelay(segmentStart: 0, clock: 10, loopLength: 60, tolerance: 1.5) == 50)
    #expect(Playout.startDelay(segmentStart: 0, clock: 0.5, loopLength: 60, tolerance: 1.5) == -0.5)
}

@Test func startDelayOnALoopShorterThanTheToleranceStillWaitsItsTurn() {
    // A one-second loop with a 1.5 s tolerance: without a cap every answer
    // would be "already started", up to a whole loop ago.
    #expect(abs(Playout.startDelay(segmentStart: 0, clock: 0.2, loopLength: 1, tolerance: 1.5) - -0.2) < 1e-9)
    #expect(abs(Playout.startDelay(segmentStart: 0, clock: 0.75, loopLength: 1, tolerance: 1.5) - 0.25) < 1e-9)
    #expect(Playout.startDelay(segmentStart: 0, clock: 0, loopLength: 0, tolerance: 1.5) == 0)
}

// MARK: - The end watch

@Test func theEndWatchCallsAClockStoppedAtTheEndTheEnding() {
    var w = EndWatch()
    #expect(w.look(time: 598.0, end: 600, now: 0) == .fine)
    #expect(w.look(time: 599.9, end: 600, now: 0.25) == .fine, "still moving")
    #expect(w.look(time: 599.9, end: 600, now: 0.5) == .fine, "stopped, but not for long")
    #expect(w.look(time: 599.9, end: 600, now: 0.6) == .ended)
}

@Test func theEndWatchCallsAClockStoppedMidProgramAStall() {
    var w = EndWatch()
    #expect(w.look(time: 120, end: 600, now: 10) == .fine)
    #expect(w.look(time: 120, end: 600, now: 13.9) == .fine)
    #expect(w.look(time: 120, end: 600, now: 14) == .stalled)
    w.reset()
    #expect(w.look(time: 120, end: 600, now: 20) == .fine, "a reset starts the watch over")
    #expect(w.look(time: 121, end: 600, now: 30) == .fine, "moving again is fine however long it took")
}

@Test func theEndWatchSeesAnActsMarkInsideTheFile() {
    // An act ends at its break, mid-file: the end mark, not the file's end.
    var w = EndWatch()
    _ = w.look(time: 1999.5, end: 2000, now: 0)
    #expect(w.look(time: 1999.5, end: 2000, now: 0.3) == .ended)
    var nan = EndWatch()
    #expect(nan.look(time: .nan, end: 2000, now: 0) == .fine)
    #expect(nan.look(time: .nan, end: 2000, now: 10) == .fine, "no time yet is not a stall")
}

// MARK: - A new day's running order

@Test func aShuffledChannelTakesTheNewDaysOrderAtMidnight() throws {
    var cal = Calendar(identifier: .gregorian)
    cal.timeZone = try #require(TimeZone(identifier: "America/New_York"))
    let at = { (d: Int, h: Int, m: Int, s: Int) in
        cal.date(from: DateComponents(year: 2026, month: 9, day: d, hour: h, minute: m, second: s))!
    }
    let lib = Library(files: (1...8).map { film("p\($0).mp4", Double(600 + $0)) })
    let shuffled = Channel(number: 5, type: .video, folder: "movies", order: .shuffleDaily)
    let tonight = Dial.channelTimeline(shuffled, files: lib.files, spots: [], date: at(28, 23, 59, 59), calendar: cal)

    #expect(Playout.timelineChange(shuffled, library: lib, current: tonight, at: at(28, 12, 0, 0), calendar: cal) == nil,
            "the same day keeps its order")
    let tomorrow = try #require(Playout.timelineChange(shuffled, library: lib, current: tonight, at: at(29, 0, 0, 1), calendar: cal),
                                "after midnight the order is the new day's")
    #expect(tomorrow == Dial.channelTimeline(shuffled, files: lib.files, spots: [], date: at(29, 0, 0, 1), calendar: cal))
    #expect(Set(tomorrow.map(\.file)) == Set(tonight.map(\.file)))

    let inOrder = Channel(number: 6, type: .video, folder: "movies", order: .sequence)
    let seq = Dial.channelTimeline(inOrder, files: lib.files, spots: [], date: at(28, 23, 59, 59), calendar: cal)
    #expect(Playout.timelineChange(inOrder, library: lib, current: seq, at: at(29, 0, 0, 1), calendar: cal) == nil,
            "a channel in sequence plays on through midnight")
}

// MARK: - What a tune shows

@Test func aTuneLandsOnTheGuideTheBoardOrTheAir() throws {
    var cal = Calendar(identifier: .gregorian)
    cal.timeZone = try #require(TimeZone(identifier: "America/New_York"))
    let sat9 = cal.date(from: DateComponents(year: 2026, month: 8, day: 29, hour: 9))!
    let tue2 = cal.date(from: DateComponents(year: 2026, month: 9, day: 1, hour: 14))!
    let cartoons = [ScheduleWindow(days: ["sat"], start: "08:00", end: "11:30")]

    #expect(Playout.plan(Channel(number: 0, type: .guide), at: tue2, hasBoard: true, calendar: cal) == (.guide, nil))
    #expect(Playout.plan(Channel(number: 82, type: .bulletin), at: tue2, hasBoard: true, calendar: cal) == (.board, nil))
    #expect(Playout.plan(Channel(number: 2, type: .video), at: tue2, hasBoard: true, calendar: cal) == (.video, nil),
            "a continuous channel never flips")

    let onAir = Playout.plan(Channel(number: 3, type: .video, mode: .schedule, schedule: cartoons), at: sat9, hasBoard: true, calendar: cal)
    #expect(onAir.plan == .video)
    #expect(onAir.flipAt == cal.date(from: DateComponents(year: 2026, month: 8, day: 29, hour: 11, minute: 30)))

    let offAir = Playout.plan(Channel(number: 3, type: .video, mode: .schedule, schedule: cartoons, offAir: .bars),
                              at: tue2, hasBoard: true, calendar: cal)
    #expect(offAir.plan == .offAir(.bars, "PROGRAMMING RESUMES SATURDAY 8:00 AM"))
    #expect(offAir.flipAt == cal.date(from: DateComponents(year: 2026, month: 9, day: 5, hour: 8)))
}

@Test func anOffAirChannelFallsBackToTheBoardOnlyWhenThereIsOne() {
    let ch = Channel(number: 3, type: .video, mode: .schedule,
                     schedule: [ScheduleWindow(days: ["sat"], start: "08:00", end: "11:30")], offAir: .bulletin)
    let tue = local(2026, 9, 1, 14)
    #expect(Playout.plan(ch, at: tue, hasBoard: true).plan == .board)
    #expect(Playout.plan(ch, at: tue, hasBoard: true).flipAt != nil, "and it still comes back on at its time")
    #expect(Playout.plan(ch, at: tue, hasBoard: false).plan == .offAir(.bulletin, "PROGRAMMING RESUMES SATURDAY 8:00 AM"))
}

// MARK: - Lengths measured here

@Test func measuredLengthsFillInAndWhatCantBeReadSitsOut() {
    let files = [film("known.mp4", 100), film("new.mp4", nil), film("broken.mkv", nil), film("zero.mp4", nil)]
    let learned = ["channels/movies/new.mp4": 42.5, "channels/movies/zero.mp4": 0, "channels/movies/known.mp4": 999]
    let f = Playout.fillDurations(files, learned: learned)
    #expect(f.files.map(\.file) == ["known.mp4", "new.mp4"])
    #expect(f.files.map(\.duration) == [100, 42.5], "a length the server already had is kept")
    #expect(f.report == ["new.mp4": 42.5], "only what was learned here is posted back, by file name")
    #expect(f.unreadable.map(\.file) == ["broken.mkv", "zero.mp4"], "a zero length is no length")
}

@Test func nothingLearnedMeansNothingToReport() {
    let f = Playout.fillDurations([film("a.mp4", 10)], learned: [:])
    #expect(f.report.isEmpty && f.unreadable.isEmpty && f.files.count == 1)
    #expect(Playout.fillDurations([], learned: ["x": 1]) == Playout.Filled(files: [], report: [:], unreadable: []))
}

// MARK: - The dial at sign-on

@Test func theSetSignsOnWhereItLeftOffWhenItCan() {
    let lineup = [Channel(number: 0, type: .guide), Channel(number: 2, type: .video),
                  Channel(number: 9, type: .external), Channel(number: 82, type: .bulletin)]
    let dial = Dial.tunable(lineup)
    #expect(dial.map(\.number) == [0, 2, 82], "external channels need a web view")
    #expect(Dial.startIndex(dial, last: 82) == 2)
    #expect(Dial.startIndex(dial, last: 9) == 0, "the last channel was external: the first")
    #expect(Dial.startIndex(dial, last: 44) == 0, "the last channel is gone: the first")
    #expect(Dial.startIndex(dial, last: nil) == 0)
    #expect(Dial.tunable([Channel(number: 9, type: .external)]).isEmpty)
}
