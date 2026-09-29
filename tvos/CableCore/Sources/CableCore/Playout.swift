// The player's and the tuner's decisions that don't need a player: how far
// the air has wandered from the clock, when a cued segment should start,
// whether a stopped player has finished or stalled, when the day's running
// order changes, what a tune puts on the screen, and folding measured lengths
// back into a listing. ChannelEngine and Tuner act on these answers; keeping
// them here lets `swift test` cover them on the Mac.

import Foundation

public enum Playout {
    // MARK: - Against the clock

    /// Seconds the air is ahead (+) or behind (-) the clock, taken the short
    /// way round the loop, so the last second of the loop and the first are
    /// neighbours. Both positions are seconds into the loop.
    public static func drift(onAir: Double, clock: Double, loopLength: Double) -> Double {
        guard loopLength > 0 else { return 0 }
        var d = (onAir - clock).truncatingRemainder(dividingBy: loopLength)
        if d > loopLength / 2 { d -= loopLength }
        if d < -loopLength / 2 { d += loopLength }
        return d
    }

    /// Seconds from now until a segment that starts `segmentStart` into the
    /// loop comes up, when the clock is `clock` into it. A segment that
    /// started less than `tolerance` ago answers negative (start it that far
    /// in), not a whole loop from now. The tolerance never exceeds half the
    /// loop, so a loop shorter than the tolerance still waits for its turn.
    public static func startDelay(segmentStart: Double, clock: Double, loopLength: Double, tolerance: Double) -> Double {
        guard loopLength > 0 else { return 0 }
        var delta = (segmentStart - clock).truncatingRemainder(dividingBy: loopLength)
        if delta < 0 { delta += loopLength }
        if delta > loopLength - min(tolerance, loopLength / 2) { delta -= loopLength }
        return delta
    }

    /// The timeline for `date` when it differs from `current`, nil when the
    /// air can carry on. A shuffled channel's order is the day's, so it
    /// changes at local midnight; a channel in sequence never changes here.
    public static func timelineChange(_ channel: Channel, library: Library, current: [Segment],
                                      at date: Date, calendar: Calendar = .current) -> [Segment]? {
        let fresh = Dial.channelTimeline(channel, files: library.files, spots: library.spots, date: date, calendar: calendar)
        return fresh == current ? nil : fresh
    }

    // MARK: - What a tune puts on the screen

    /// Where a tune lands before any listing is fetched.
    public enum Plan: Sendable, Equatable {
        case guide
        case board
        /// Outside scheduled hours: the channel's off-air card and its resume line.
        case offAir(Channel.OffAir, String)
        /// On the air: fetch the listing and play.
        case video
    }

    /// What tuning `channel` at `date` shows, and when that next changes (a
    /// scheduled channel's next on or off). An off-air channel set to fall
    /// back to the board shows the board when there is one, its test card
    /// when there isn't.
    public static func plan(_ channel: Channel, at date: Date, hasBoard: Bool,
                            calendar: Calendar = .current) -> (plan: Plan, flipAt: Date?) {
        switch channel.type {
        case .guide: return (.guide, nil)
        case .bulletin: return (.board, nil)
        case .video, .external: break
        }
        let state = Dial.airState(channel, at: date, calendar: calendar)
        guard state.onAir else {
            if channel.offAir == .bulletin, hasBoard { return (.board, state.until) }
            return (.offAir(channel.offAir, state.resumeText), state.until)
        }
        return (.video, state.until)
    }

    // MARK: - Lengths measured here

    /// Measured lengths folded into a listing.
    public struct Filled: Sendable, Equatable {
        /// The files that can go on the air: every one with a known length.
        public var files: [MediaFile]
        /// What to post back to the server: file name -> seconds, only the newly learned.
        public var report: [String: Double]
        /// Files with no length yet and none learned: left out of this set's timeline.
        public var unreadable: [MediaFile]
    }

    /// Fill in the lengths `learned` holds (keyed by each file's `url`) for
    /// files the server didn't know yet.
    public static func fillDurations(_ files: [MediaFile], learned: [String: Double]) -> Filled {
        var out = Filled(files: [], report: [:], unreadable: [])
        for f in files {
            if f.duration != nil {
                out.files.append(f)
            } else if let d = learned[f.url], d.isFinite, d > 0 {
                var g = f
                g.duration = d
                out.files.append(g)
                out.report[f.file] = d
            } else {
                out.unreadable.append(f)
            }
        }
        return out
    }
}

/// The dial's startup choices.
extension Dial {
    /// The channels this set can tune: everything on the dial but external
    /// channels, which need a web view tvOS doesn't have.
    public static func tunable(_ lineup: [Channel]) -> [Channel] {
        lineup.filter { $0.type != .external }
    }

    /// Where a set signs on: the channel it was last on when that is still
    /// on the dial, otherwise the first.
    public static func startIndex(_ dial: [Channel], last: Int?) -> Int {
        dial.firstIndex { $0.number == last } ?? 0
    }
}

/// Watches the air player the way video.js's endWatch watches its video
/// element, for the endings and stalls a notification can miss. Feed it the
/// player's time a few times a second while the air should be running.
///
/// A clock stopped inside the last second before the segment's end mark is
/// the ending. A clock stopped anywhere else for long enough (a network stall,
/// a wedged decoder) is a stall: reload from the broadcast clock.
public struct EndWatch: Sendable {
    public enum Verdict: Sendable, Equatable { case fine, ended, stalled }

    /// How long a stopped clock at the end counts as the ending, and how
    /// long one anywhere else counts as a stall, in seconds (video.js's 300 ms and 4 s).
    public var endGrace = 0.3
    public var stallLimit = 4.0

    private var lastTime: Double?
    private var since = 0.0

    public init() {}

    /// Forget what was seen: call after a cut, a load, or a seek.
    public mutating func reset() { lastTime = nil }

    /// One look: the player's time within the file, the segment's end mark
    /// within the file, and now (any monotonic seconds).
    public mutating func look(time: Double, end: Double, now: Double) -> Verdict {
        guard time.isFinite else { return .fine }
        if time != lastTime {
            lastTime = time
            since = now
            return .fine
        }
        let still = now - since
        if time >= end - 1, still >= endGrace { return .ended }
        if still >= stallLimit { return .stalled }
        return .fine
    }
}
