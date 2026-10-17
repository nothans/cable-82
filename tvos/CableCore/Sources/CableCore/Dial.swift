// The broadcast clock: a Swift port of CABLE 82's dial.js.
//
// A channel's position is a function of the wall clock, never a play cursor.
// That's what lets a channel resume at exactly the moment it would have
// reached, makes two sets agree to the frame, and keeps the guide from ever
// disagreeing with the picture. An Apple TV and a browser display tuned to
// the same channel must show the same frame, so everything here matches
// dial.js exactly: the same epoch, the same shuffle bits, and the same
// floating-point order of operations. ReferenceTests.swift checks this by
// running the original JavaScript in JavaScriptCore beside this code.
//
// Times are milliseconds since 1970 as Double, like JavaScript's Date, so
// the arithmetic is the same. Calendar-dependent functions take a Calendar
// (defaulting to the device's), because the JS runs in local time.

import Foundation

/// Something with a length in seconds, unknown (nil) until measured.
public protocol Timed {
    var duration: Double? { get }
}

extension MediaFile: Timed {}

/// Where the clock puts a playlist: item `index`, `offset` seconds in.
public struct Position: Sendable, Equatable {
    public var index: Int
    public var offset: Double

    public init(index: Int, offset: Double) {
        self.index = index; self.offset = offset
    }
}

/// One slice of one file on a channel's air.
public struct Segment: Timed, Sendable, Equatable {
    public enum Kind: String, Sendable { case program, spot }

    public var kind: Kind
    public var file: String
    public var title: String?
    public var url: String
    /// Start and end within the file, in seconds. `to` is nil while the
    /// file's duration is unknown: play to the end.
    public var from: Double
    public var to: Double?
    public var duration: Double?
}

public enum ClockMode: String, Decodable, Sendable {
    case twelveHour = "12h"
    case twentyFourHour = "24h"
}

public struct VolumeStep: Sendable, Equatable {
    public var level: Double
    public var name: String
}

public enum Dial {
    // MARK: - The clock face

    static let days3 = ["SUN", "MON", "TUE", "WED", "THU", "FRI", "SAT"]
    static let days = ["SUNDAY", "MONDAY", "TUESDAY", "WEDNESDAY", "THURSDAY", "FRIDAY", "SATURDAY"]
    static let months3 = ["JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEP", "OCT", "NOV", "DEC"]
    static let months = ["JANUARY", "FEBRUARY", "MARCH", "APRIL", "MAY", "JUNE", "JULY",
                         "AUGUST", "SEPTEMBER", "OCTOBER", "NOVEMBER", "DECEMBER"]

    /// The broadcast clock's origin, `Date.UTC(2026, 0, 1)` in dial.js: the
    /// fixed point every channel's position is measured from.
    public static let epochMs: Double = 1_767_225_600_000

    public static func formatClock(_ date: Date, _ mode: ClockMode, seconds: Bool = false,
                                   calendar: Calendar = .current) -> String {
        let c = calendar.dateComponents([.hour, .minute, .second], from: date)
        let (h, m, s) = (c.hour!, c.minute!, c.second!)
        let mm = pad2(m)
        let ss = seconds ? ":" + pad2(s) : ""
        if mode == .twentyFourHour { return pad2(h) + ":" + mm + ss }
        let h12 = h % 12 == 0 ? 12 : h % 12
        return "\(h12):\(mm)\(ss) \(h < 12 ? "AM" : "PM")"
    }

    public static func formatHeaderDate(_ date: Date, calendar: Calendar = .current) -> String {
        let c = calendar.dateComponents([.weekday, .month, .day], from: date)
        return "\(days3[c.weekday! - 1]) \(months3[c.month! - 1]) \(c.day!)"
    }

    public static func formatLongDate(_ date: Date, calendar: Calendar = .current) -> String {
        let c = calendar.dateComponents([.weekday, .month, .day, .year], from: date)
        return "\(days[c.weekday! - 1]), \(months[c.month! - 1]) \(c.day!), \(c.year!)"
    }

    // MARK: - The running order

    /// Where the clock is in a looping playlist at `nowMs`. Nil when the
    /// playlist is empty or any duration is unknown or non-positive: the
    /// clock can only run when the whole loop's length is known.
    public static func positionAt<T: Timed>(_ playlist: [T], nowMs: Double, epochMs: Double = epochMs) -> Position? {
        guard !playlist.isEmpty else { return nil }
        var total = 0.0
        for item in playlist {
            guard let d = item.duration, d.isFinite, d > 0 else { return nil }
            total += d
        }
        // JS's % is a truncating remainder; the double wrap makes it non-negative.
        var t = (((nowMs - epochMs) / 1000).truncatingRemainder(dividingBy: total) + total)
            .truncatingRemainder(dividingBy: total)
        for (i, item) in playlist.enumerated() {
            let d = item.duration!
            if t < d { return Position(index: i, offset: t) }
            t -= d
        }
        return Position(index: 0, offset: 0)
    }

    public static func positionAt<T: Timed>(_ playlist: [T], at date: Date, epochMs: Double = epochMs) -> Position? {
        positionAt(playlist, nowMs: date.timeIntervalSince1970 * 1000, epochMs: epochMs)
    }

    /// Deterministic shuffle, seeded: FNV-1a over the seed's UTF-16 code
    /// units, then xorshift32, done in the same 32-bit wrapping arithmetic
    /// JavaScript's bitwise operators use. Non-mutating.
    public static func seededShuffle<T>(_ arr: [T], seed: String) -> [T] {
        var h = Int32(bitPattern: 2_166_136_261)
        for unit in seed.utf16 {
            h ^= Int32(unit)
            h = h &* 16_777_619 // Math.imul
        }
        func rand() -> Double {
            h ^= h << 13
            h ^= Int32(bitPattern: UInt32(bitPattern: h) >> 17) // >>>
            h ^= h << 5
            return Double(UInt32(bitPattern: h) % 1_000_000) / 1e6
        }
        var a = arr
        var i = a.count - 1
        while i > 0 {
            let j = Int((rand() * Double(i + 1)).rounded(.down))
            a.swapAt(i, j)
            i -= 1
        }
        return a
    }

    /// A folder's running order for the day: the server's natural sort, or a
    /// shuffle seeded by the date so it holds all day and reshuffles tomorrow.
    public static func orderFiles<T>(_ files: [T], _ order: Channel.Order, seed: String) -> [T] {
        order == .shuffleDaily ? seededShuffle(files, seed: seed) : files
    }

    /// A video channel's air as segments, each a slice of one file, walked by
    /// positionAt like any playlist.
    ///
    /// Without breaks, it's one segment per file, played whole. With breaks,
    /// each program is cut into acts of about `everyMinutes` (a 63-minute film
    /// at 15 becomes four acts of 15:45). A break of `spots` spots follows
    /// every act, the last one included, so a break separates programs. The
    /// spot pool cycles across the whole loop. At 0 minutes, `everyPrograms`
    /// spaces the breaks out: one after every Nth program, and always one at
    /// the end of the loop, so the loop's seam is a break too. Acts need every program's
    /// duration up front; spots with unknown lengths sit out, and if no spots
    /// are usable the programs play whole.
    public static func channelTimeline(_ channel: Channel, files: [MediaFile], spots: [MediaFile],
                                       date: Date, calendar: Calendar = .current) -> [Segment] {
        let c = calendar.dateComponents([.year, .month, .day], from: date)
        let day = "\(c.year!)-\(c.month!)-\(c.day!)"
        let program = orderFiles(files, channel.order, seed: "\(day)#\(channel.number)")
        let pool = channel.breaks.map { _ in
            orderFiles(spots.filter { ($0.duration ?? 0) > 0 }, channel.order, seed: "\(day)#\(channel.number)#breaks")
        } ?? []

        func whole(_ f: MediaFile, _ kind: Segment.Kind) -> Segment {
            Segment(kind: kind, file: f.file, title: f.title, url: f.url, from: 0, to: f.duration, duration: f.duration)
        }

        guard let b = channel.breaks, !pool.isEmpty, program.allSatisfy({ ($0.duration ?? 0) > 0 }) else {
            return program.map { whole($0, .program) }
        }
        let actLen = b.everyMinutes * 60
        let every = actLen > 0 ? 1 : max(1, b.everyPrograms)
        var out: [Segment] = []
        var cursor = 0
        for (pi, p) in program.enumerated() {
            let d = p.duration!
            let acts = actLen > 0 ? max(1, Int((d / actLen).rounded(.toNearestOrAwayFromZero))) : 1
            for a in 0..<acts {
                let from = (d * Double(a)) / Double(acts)
                let to = a == acts - 1 ? d : (d * Double(a + 1)) / Double(acts)
                out.append(Segment(kind: .program, file: p.file, title: p.title, url: p.url,
                                   from: from, to: to, duration: to - from))
                if (pi + 1) % every != 0 && pi != program.count - 1 { continue }
                for _ in 0..<b.spots {
                    out.append(whole(pool[cursor % pool.count], .spot))
                    cursor += 1
                }
            }
        }
        return out
    }

    // MARK: - The dial itself

    /// Which dial position a tune command lands on. `channels` is the
    /// enabled, number-sorted dial; `dir` is +1 or -1.
    public static func nextChannelIndex(count: Int, from idx: Int, dir: Int, wrap: Bool) -> Int {
        guard count >= 2 else { return idx }
        let next = idx + dir
        if next < 0 { return wrap ? count - 1 : 0 }
        if next >= count { return wrap ? 0 : count - 1 }
        return next
    }

    /// The levels a volume key steps through, the Zenith Space Command's
    /// order: loud, off, soft, medium, back to loud. On tvOS this is the
    /// player's own gain; the system volume isn't the app's to set.
    public static let volumeSteps = [
        VolumeStep(level: 1, name: "LOUD"),
        VolumeStep(level: 0, name: "SOUND OFF"),
        VolumeStep(level: 0.35, name: "SOFT"),
        VolumeStep(level: 0.7, name: "MEDIUM"),
    ]

    public static func nextVolumeStep(_ i: Int?) -> Int {
        guard let i, volumeSteps.indices.contains(i) else { return 1 }
        return (i + 1) % volumeSteps.count
    }

    // MARK: - Helpers

    static func pad2(_ n: Int) -> String { n < 10 ? "0\(n)" : "\(n)" }

    /// JavaScript's `d = new Date(date); d.setDate(d.getDate() + dayOffset);
    /// d.setHours(0, minutes, 0, 0)`: a local wall-clock time, where 1440
    /// minutes means the next midnight.
    static func localTime(_ date: Date, dayOffset: Int, minutes: Int, calendar: Calendar) -> Date {
        var c = calendar.dateComponents([.year, .month, .day], from: date)
        c.day! += dayOffset + minutes / 1440
        c.hour = (minutes % 1440) / 60
        c.minute = minutes % 60
        c.second = 0
        c.nanosecond = 0
        return calendar.date(from: c)!
    }
}
