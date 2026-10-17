// What's on: a Swift port of dial.js's guide functions. The guide answers
// from the same broadcast clock the player runs on, so it can't disagree
// with the picture.

import Foundation

public struct ProgramInfo: Sendable, Equatable {
    public enum Kind: String, Sendable { case program, guide, bulletin, external, offair, empty, unknown }

    public var title: String
    public var kind: Kind
    public var file: String?
}

public struct GuideCell: Sendable, Equatable {
    public var title: String
    public var kind: ProgramInfo.Kind
    public var span: Int
    public var slot: Int
}

public struct GuideRow: Sendable, Equatable {
    public var number: Int
    public var name: String
    public var type: Channel.Kind
    public var cells: [GuideCell]
}

public struct GuideGrid: Sendable, Equatable {
    public var slots: [Date]
    public var rows: [GuideRow]
}

extension Dial {
    /// A program's on-screen name, from its file name. "02 Design for
    /// Dreaming (1956).mp4" becomes "DESIGN FOR DREAMING (1956)".
    public static func programTitle(_ file: String) -> String {
        var t = file.replacing(/\.[a-z0-9]+$/.ignoresCase(), with: "", maxReplacements: 1)
        t = t.replacing(/^\s*\d{1,3}[\s._-]+/, with: "", maxReplacements: 1)
        t = t.replacing(/^s\d{1,2}[\s._-]*e\d{1,3}[\s._-]*/.ignoresCase(), with: "", maxReplacements: 1)
        t = t.replacing(/[._]+/, with: " ").replacing(/\s+/, with: " ")
            .trimmingCharacters(in: .whitespacesAndNewlines)
        return t.isEmpty ? "PROGRAM" : t.uppercased()
    }

    /// What the guide calls one segment, by the channel's titles setting.
    public static func segmentName(_ channel: Channel, _ seg: Segment) -> String {
        switch channel.titles {
        case .fixed:
            if let t = channel.title, !t.isEmpty { return t }
            return channel.name.isEmpty ? programTitle(seg.file) : channel.name
        case .metadata:
            if let t = seg.title, !t.isEmpty { return t.uppercased() }
            return programTitle(seg.file)
        case .filename:
            return programTitle(seg.file)
        }
    }

    /// The half-hour slots a guide page shows: the one we're in now, then
    /// the ones after it.
    public static func guideSlots(_ date: Date, count: Int = 3, calendar: Calendar = .current) -> [Date] {
        var c = calendar.dateComponents([.year, .month, .day, .hour, .minute], from: date)
        c.minute = c.minute! < 30 ? 0 : 30
        c.second = 0
        c.nanosecond = 0
        let first = calendar.date(from: c)!
        return (0..<count).map { first.addingTimeInterval(Double($0) * 30 * 60) }
    }

    /// What one channel is showing at a moment. A commercial break is never
    /// the answer: the guide names the program the break sits inside.
    public static func programAt(_ channel: Channel, library: Library?, at date: Date,
                                 epochMs: Double = epochMs, calendar: Calendar = .current) -> ProgramInfo? {
        guard channel.enabled else { return nil }
        switch channel.type {
        case .guide: return ProgramInfo(title: "PROGRAM GUIDE", kind: .guide)
        case .bulletin: return ProgramInfo(title: "COMMUNITY BULLETIN BOARD", kind: .bulletin)
        case .external: return ProgramInfo(title: "LIVE", kind: .external)
        case .video: break
        }
        guard airState(channel, at: date, calendar: calendar).onAir else { return ProgramInfo(title: "OFF AIR", kind: .offair) }
        let files = library?.files ?? []
        guard !files.isEmpty else { return ProgramInfo(title: "NO PROGRAMS", kind: .empty) }
        let tl = channelTimeline(channel, files: files, spots: library?.spots ?? [], date: date, calendar: calendar)
        guard let pos = positionAt(tl, at: date, epochMs: epochMs) else {
            return ProgramInfo(title: "TO BE ANNOUNCED", kind: .unknown)
        }
        var i = pos.index
        if tl[i].kind == .spot {
            // The act before the break, or for a loop that opens on a break, the one after.
            var j = i
            while j >= 0 && tl[j].kind == .spot { j -= 1 }
            if j < 0 {
                j = i
                while j < tl.count && tl[j].kind == .spot { j += 1 }
            }
            if j >= 0 && j < tl.count { i = j }
        }
        let seg = tl[i]
        return ProgramInfo(title: segmentName(channel, seg), kind: .program, file: seg.file)
    }

    /// The grid: a row per enabled channel, with a cell merged across slots
    /// wherever the same program runs on.
    public static func guideGrid(_ channels: [Channel], libraries: [Int: Library], at date: Date, count: Int = 3,
                                 epochMs: Double = epochMs, calendar: Calendar = .current) -> GuideGrid {
        let slots = guideSlots(date, count: count, calendar: calendar)
        var rows: [GuideRow] = []
        for ch in channels where ch.enabled {
            var cells: [GuideCell] = []
            for (i, slot) in slots.enumerated() {
                let p = programAt(ch, library: libraries[ch.number], at: slot, epochMs: epochMs, calendar: calendar)
                    ?? ProgramInfo(title: "", kind: .empty)
                if let last = cells.last, last.title == p.title, last.kind == p.kind {
                    cells[cells.count - 1].span += 1
                } else {
                    cells.append(GuideCell(title: p.title, kind: p.kind, span: 1, slot: i))
                }
            }
            rows.append(GuideRow(number: ch.number, name: ch.name, type: ch.type, cells: cells))
        }
        return GuideGrid(slots: slots, rows: rows)
    }
}
