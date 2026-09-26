// Scheduled hours: a Swift port of dial.js's airState(), plus parseHM() and
// windowSegments() from config-schema.js.

import Foundation

public struct AirState: Sendable, Equatable {
    public var onAir: Bool
    /// When the state next flips, so the tuner can set one exact timer
    /// instead of polling. Nil for a channel whose state never changes.
    public var until: Date?
    /// The test card's line: "PROGRAMMING RESUMES SATURDAY 8:00 AM".
    public var resumeText: String
}

/// A non-wrapping piece of a window: `day` is 0 = Sunday, minutes satisfy
/// start < end. `cont` marks the next-morning half of an overnight window.
public struct WindowSegment: Sendable, Equatable {
    public var day: Int
    public var start: Int
    public var end: Int
    public var cont = false
}

extension Dial {
    static let dayKeys = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"]

    /// "08:30" -> 510 minutes. "24:00" is 1440, "until midnight". Nil when malformed.
    public static func parseHM(_ s: String) -> Int? {
        let t = s.trimmingCharacters(in: .whitespacesAndNewlines)
        guard let m = t.wholeMatch(of: /(\d{1,2}):(\d{2})/),
              let h = Int(m.1), let min = Int(m.2) else { return nil }
        if h == 24 && min == 0 { return 1440 }
        if h > 23 || min > 59 { return nil }
        return h * 60 + min
    }

    /// Expand one window into non-wrapping segments. A normal window yields
    /// one per day; an overnight one yields an evening segment plus a
    /// next-morning one (dropped when empty, so "20:00-00:00" means "until
    /// midnight").
    public static func windowSegments(_ w: ScheduleWindow) -> [WindowSegment] {
        guard let start = parseHM(w.start), let end = parseHM(w.end) else { return [] }
        var segs: [WindowSegment] = []
        for key in w.days {
            guard let day = dayKeys.firstIndex(of: key) else { continue }
            if start < end {
                segs.append(WindowSegment(day: day, start: start, end: end))
            } else {
                segs.append(WindowSegment(day: day, start: start, end: 1440))
                if end > 0 { segs.append(WindowSegment(day: (day + 1) % 7, start: 0, end: end, cont: true)) }
            }
        }
        return segs
    }

    /// Is a scheduled channel on the air at `date`, and when does that change?
    public static func airState(_ channel: Channel, at date: Date, calendar: Calendar = .current) -> AirState {
        guard channel.mode == .schedule else { return AirState(onAir: true, until: nil, resumeText: "") }
        let none = AirState(onAir: false, until: nil, resumeText: "NO PROGRAMMING SCHEDULED")
        let segs = channel.schedule.flatMap(windowSegments)
        guard !segs.isEmpty else { return none }

        let c = calendar.dateComponents([.weekday, .hour, .minute, .second], from: date)
        let nowMin = Double(c.hour! * 60 + c.minute!) + Double(c.second!) / 60
        let today = c.weekday! - 1

        // On the air now?
        for g in segs where g.day == today && nowMin >= Double(g.start) && nowMin < Double(g.end) {
            return AirState(onAir: true, until: localTime(date, dayOffset: 0, minutes: g.end, calendar: calendar),
                            resumeText: "")
        }

        // Off the air: find the next segment start within the coming week. A
        // cont segment can never win wrongly: being off the air before it
        // means its evening half is in the future too, and sorts earlier.
        var best: (at: Date, day: Int, startMin: Int)?
        for d in 0..<8 {
            let day = (today + d) % 7
            for g in segs where g.day == day {
                if d == 0 && Double(g.start) <= nowMin { continue }
                let at = localTime(date, dayOffset: d, minutes: g.start, calendar: calendar)
                if best == nil || at < best!.at { best = (at, day, g.start) }
            }
            if best != nil { break }
        }
        guard let best else { return none }

        let h12 = (best.startMin / 60) % 12 == 0 ? 12 : (best.startMin / 60) % 12
        let ampm = best.startMin < 720 ? "AM" : "PM"
        let soon = best.day == today && best.at.timeIntervalSince(date) < 12 * 3600
        let dayWord = soon ? "TODAY" : days[best.day]
        return AirState(onAir: false, until: best.at,
                        resumeText: "PROGRAMMING RESUMES \(dayWord) \(h12):\(pad2(best.startMin % 60)) \(ampm)")
    }
}
