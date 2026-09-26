// The server's vocabulary, as Swift types. The server has already cleaned
// and clamped everything it serves (config-schema.js on the Node side), so
// decoding here is lenient: a missing key takes the schema's default, and an
// unknown enum value falls back instead of failing the whole config.

import Foundation

// MARK: - Config (GET /api/config)

public struct ConfigResponse: Decodable, Sendable {
    public var version: String?
    public var config: StationConfig
    public var warning: String?
}

public struct StationConfig: Decodable, Sendable {
    public var channelName: String
    public var timeFormat: ClockMode
    public var channels: [Channel]
    public var tuner: TunerConfig

    enum CodingKeys: String, CodingKey { case channelName, timeFormat, channels, tuner }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        channelName = try c.decodeIfPresent(String.self, forKey: .channelName) ?? "CABLE 82"
        timeFormat = c.lenient(ClockMode.self, .timeFormat) ?? .twelveHour
        channels = try c.decodeIfPresent([Channel].self, forKey: .channels) ?? []
        tuner = try c.decodeIfPresent(TunerConfig.self, forKey: .tuner) ?? TunerConfig()
    }

    /// The dial: enabled channels in number order, which is what the tuner walks.
    public var dial: [Channel] {
        channels.filter(\.enabled).sorted { $0.number < $1.number }
    }
}

public struct TunerConfig: Decodable, Sendable {
    public enum Cut: String, Decodable, Sendable { case `static`, black, none }
    public enum Power: String, Decodable, Sendable { case crt, black }

    public var wrap = true
    public var cut: Cut = .static
    public var power: Power = .crt

    public init() {}

    enum CodingKeys: String, CodingKey { case wrap, cut, power }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        wrap = try c.decodeIfPresent(Bool.self, forKey: .wrap) ?? true
        cut = c.lenient(Cut.self, .cut) ?? .static
        power = c.lenient(Power.self, .power) ?? .crt
    }
}

// MARK: - Channels

public struct Channel: Decodable, Sendable, Equatable {
    public enum Kind: String, Decodable, Sendable { case bulletin, video, guide, external }
    public enum Order: String, Decodable, Sendable { case sequence, shuffleDaily = "shuffle-daily" }
    public enum Mode: String, Decodable, Sendable { case continuous, schedule }
    public enum OffAir: String, Decodable, Sendable { case testcard, bars, snow, bulletin }
    public enum Titles: String, Decodable, Sendable { case filename, metadata, fixed }

    public var number: Int
    public var name: String
    public var type: Kind
    public var enabled: Bool

    // Video channels only; defaults match config-schema.js.
    public var folder: String?
    public var order: Order
    public var mode: Mode
    public var schedule: [ScheduleWindow]
    public var offAir: OffAir
    public var breaks: Breaks?
    public var titles: Titles
    public var title: String?

    // External channels only (not playable on tvOS; kept so the dial and
    // the guide still list them).
    public var url: String?

    public init(number: Int, name: String = "", type: Kind, enabled: Bool = true,
                folder: String? = nil, order: Order = .sequence, mode: Mode = .continuous,
                schedule: [ScheduleWindow] = [], offAir: OffAir = .testcard, breaks: Breaks? = nil,
                titles: Titles = .filename, title: String? = nil, url: String? = nil) {
        self.number = number; self.name = name; self.type = type; self.enabled = enabled
        self.folder = folder; self.order = order; self.mode = mode; self.schedule = schedule
        self.offAir = offAir; self.breaks = breaks; self.titles = titles; self.title = title
        self.url = url
    }

    enum CodingKeys: String, CodingKey {
        case number, name, type, enabled, folder, order, mode, schedule, offAir, breaks, titles, title, url
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        number = try c.decode(Int.self, forKey: .number)
        name = try c.decodeIfPresent(String.self, forKey: .name) ?? ""
        type = try c.decode(Kind.self, forKey: .type)
        enabled = try c.decodeIfPresent(Bool.self, forKey: .enabled) ?? true
        folder = try c.decodeIfPresent(String.self, forKey: .folder)
        order = c.lenient(Order.self, .order) ?? .sequence
        mode = c.lenient(Mode.self, .mode) ?? .continuous
        schedule = try c.decodeIfPresent([ScheduleWindow].self, forKey: .schedule) ?? []
        offAir = c.lenient(OffAir.self, .offAir) ?? .testcard
        breaks = try c.decodeIfPresent(Breaks.self, forKey: .breaks)
        titles = c.lenient(Titles.self, .titles) ?? .filename
        title = try c.decodeIfPresent(String.self, forKey: .title)
        url = try c.decodeIfPresent(String.self, forKey: .url)
    }
}

/// A scheduled-hours window: `{ "days": ["sat","sun"], "start": "08:00", "end": "11:30" }`.
/// An end at or before the start runs overnight into the next morning.
public struct ScheduleWindow: Decodable, Sendable, Equatable {
    public var days: [String]
    public var start: String
    public var end: String

    public init(days: [String], start: String, end: String) {
        self.days = days; self.start = start; self.end = end
    }
}

/// Commercial breaks: spots from a second folder, cut into the program every
/// `everyMinutes` (0 means only between programs), `spots` per break.
public struct Breaks: Decodable, Sendable, Equatable {
    public var folder: String
    public var everyMinutes: Double
    public var spots: Int

    public init(folder: String, everyMinutes: Double, spots: Int) {
        self.folder = folder; self.everyMinutes = everyMinutes; self.spots = spots
    }
}

// MARK: - Channel listings (GET /api/channels)

public struct ChannelsResponse: Decodable, Sendable {
    public var channels: [ChannelListing]

    /// The listings keyed by channel number, the shape the timeline and the guide read.
    public var libraries: [Int: Library] {
        Dictionary(channels.map { ($0.number, Library(files: $0.files, spots: $0.breaks?.files ?? [])) },
                   uniquingKeysWith: { first, _ in first })
    }
}

public struct ChannelListing: Decodable, Sendable {
    public struct BreaksListing: Decodable, Sendable {
        public var folder: String
        public var files: [MediaFile]
    }

    public var number: Int
    public var folder: String
    public var files: [MediaFile]
    public var breaks: BreaksListing?
}

/// One video file on the server. `url` is relative to the server root and
/// already percent-encoded. `duration` is nil until some display has
/// measured it and posted it back.
public struct MediaFile: Decodable, Sendable, Equatable {
    public var file: String
    public var url: String
    public var duration: Double?
    public var title: String?

    public init(file: String, url: String, duration: Double?, title: String? = nil) {
        self.file = file; self.url = url; self.duration = duration; self.title = title
    }
}

/// A video channel's programs and (with breaks) its spots.
public struct Library: Sendable, Equatable {
    public var files: [MediaFile]
    public var spots: [MediaFile]

    public init(files: [MediaFile], spots: [MediaFile] = []) {
        self.files = files; self.spots = spots
    }
}

// MARK: - Lenient decoding

extension KeyedDecodingContainer {
    /// A string enum that decodes to nil, rather than throwing, when the key
    /// is missing or holds a value this build does not know.
    func lenient<T: RawRepresentable & Decodable>(_: T.Type, _ key: Key) -> T? where T.RawValue == String {
        guard let raw = try? decodeIfPresent(String.self, forKey: key) else { return nil }
        return T(rawValue: raw)
    }
}
