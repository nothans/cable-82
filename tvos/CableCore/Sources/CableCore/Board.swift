// Channel 82, the Community Bulletin Board: the parts of board.js and
// config-schema.js that don't touch a screen. The settings, the page
// rotation, the colors, feed parsing, the crawl text, and text cleanup, so
// the Apple TV's board makes the same choices the browser's does.

import Foundation

// MARK: - Settings (config.json)

/// Everything channel 82 reads from config.json. Defaults are the schema's.
public struct BoardConfig: Decodable, Sendable {
    public struct Message: Decodable, Sendable, Equatable {
        public var text: String
        public var color: String?
    }
    public struct Colors: Decodable, Sendable {
        public var pageCycle = ["blue", "green", "red", "cyan"]
        public var headerBg = "blue"
        public var crawlBg = "ink"
        public init() {}
        public init(from decoder: Decoder) throws {
            let c = try decoder.container(keyedBy: AnyKey.self), d = Colors()
            pageCycle = c.value("pageCycle", d.pageCycle)
            headerBg = c.value("headerBg", d.headerBg)
            crawlBg = c.value("crawlBg", d.crawlBg)
        }
    }
    public struct Crawl: Decodable, Sendable {
        public var feeds: [String] = []
        public var secondsPerScreen = 9.0
        public var separator = "  ■  "
        public var flag = "LATEST"
        public init() {}
        public init(from decoder: Decoder) throws {
            let c = try decoder.container(keyedBy: AnyKey.self), d = Crawl()
            feeds = c.value("feeds", d.feeds)
            secondsPerScreen = c.value("secondsPerScreen", d.secondsPerScreen)
            separator = c.value("separator", d.separator)
            flag = c.value("flag", d.flag)
        }
    }
    public struct Slot: Decodable, Sendable, Equatable {
        public var type: String
        public var feed: String?
        public init(type: String, feed: String? = nil) { self.type = type; self.feed = feed }
    }
    public struct Feed: Decodable, Sendable {
        public var id: String
        public var label: String
    }
    public struct Music: Decodable, Sendable {
        public var enabled = true
        public var shuffle = true
        public var volume = 60.0
        public init() {}
        public init(from decoder: Decoder) throws {
            let c = try decoder.container(keyedBy: AnyKey.self), d = Music()
            enabled = c.value("enabled", d.enabled)
            shuffle = c.value("shuffle", d.shuffle)
            volume = c.value("volume", d.volume)
        }
    }
    public struct CheerLights: Decodable, Sendable {
        public var enabled = true
        public var template = "THE WORLD IS SET TO {COLOR}"
        public init() {}
        public init(from decoder: Decoder) throws {
            let c = try decoder.container(keyedBy: AnyKey.self), d = CheerLights()
            enabled = c.value("enabled", d.enabled)
            template = c.value("template", d.template)
        }
    }

    public var channelName = "CABLE 82"
    public var tagline = "COMMUNITY BULLETIN BOARD"
    public var messages: [Message] = []
    public var facts: [String] = []
    public var dadJokes: [String] = []
    public var rotation: [Slot] = [Slot(type: "clock"), Slot(type: "messages"), Slot(type: "facts")]
    public var pageSeconds = 12.0
    public var refreshMinutes = 10.0
    public var maxItemsPerFeed = 20
    public var feeds: [Feed] = []
    public var colors = Colors()
    public var crawl = Crawl()
    public var music = Music()
    public var cheerlights = CheerLights()
    public var crtMode = false
    public var crtInkText = false

    public init() {}

    enum CodingKeys: String, CodingKey {
        case channelName, tagline, messages, facts, dadJokes, rotation, pageSeconds, refreshMinutes
        case maxItemsPerFeed, feeds, colors, crawl, music, cheerlights, crtMode, crtInkText
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        let d = BoardConfig()
        func get<T: Decodable>(_ key: CodingKeys, _ fallback: T) -> T {
            (try? c.decodeIfPresent(T.self, forKey: key)).flatMap { $0 } ?? fallback
        }
        channelName = get(.channelName, d.channelName)
        tagline = get(.tagline, d.tagline)
        messages = get(.messages, d.messages)
        facts = get(.facts, d.facts)
        dadJokes = get(.dadJokes, d.dadJokes)
        rotation = get(.rotation, d.rotation)
        pageSeconds = get(.pageSeconds, d.pageSeconds)
        refreshMinutes = get(.refreshMinutes, d.refreshMinutes)
        maxItemsPerFeed = get(.maxItemsPerFeed, d.maxItemsPerFeed)
        feeds = get(.feeds, d.feeds)
        colors = get(.colors, d.colors)
        crawl = get(.crawl, d.crawl)
        music = get(.music, d.music)
        cheerlights = get(.cheerlights, d.cheerlights)
        crtMode = get(.crtMode, d.crtMode)
        crtInkText = get(.crtInkText, d.crtInkText)
    }
}

/// GET /api/weather.
public struct Weather: Decodable, Sendable, Equatable {
    public var name: String?
    public var tempNow: Double?
    public var tempUnit: String?
    public var condition: String?
    public var tempHi: Double?
    public var tempLo: Double?
    public var wind: Double?
    public var windUnit: String?
    public var sunrise: String?
    public var sunset: String?
}

/// A coding key for any name, so each settings group can default key by key.
struct AnyKey: CodingKey {
    var stringValue: String
    var intValue: Int? { nil }
    init(stringValue: String) { self.stringValue = stringValue }
    init?(intValue: Int) { nil }
}

extension KeyedDecodingContainer where Key == AnyKey {
    /// The value at `key`, or `fallback` when it's missing or the wrong type.
    func value<T: Decodable>(_ key: String, _ fallback: T) -> T {
        (try? decodeIfPresent(T.self, forKey: AnyKey(stringValue: key))).flatMap { $0 } ?? fallback
    }
}

// MARK: - Colors (config-schema.js)

public enum BoardColors {
    /// Broadcast-safe primaries, and the calmer set for composite and RF.
    public static let palette: [String: String] = [
        "blue": "#2038C8", "cyan": "#20A8B8", "green": "#18A038", "yellow": "#C8A020",
        "red": "#C03028", "magenta": "#B03898", "white": "#F0F0EC", "ink": "#101018",
    ]
    public static let paletteCRT: [String: String] = [
        "blue": "#2C48A0", "cyan": "#3098A4", "green": "#2C8C48", "yellow": "#B09030",
        "red": "#A84038", "magenta": "#9C4890", "white": "#E4E4E0", "ink": "#181820",
    ]
    static let textOn = ["blue": "white", "green": "white", "red": "white", "magenta": "white",
                         "cyan": "ink", "yellow": "ink", "white": "ink", "ink": "white"]

    static func isHex(_ s: String) -> Bool { s.wholeMatch(of: /#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})/) != nil }

    /// A color name or #hex -> #hex, the fallback name's color when it's neither.
    public static func resolve(_ name: String?, fallback: String, crt: Bool = false) -> String {
        let pal = crt ? paletteCRT : palette
        if let name {
            if let hex = pal[name] { return hex }
            if isHex(name) { return name }
        }
        return pal[fallback] ?? pal["blue"]!
    }

    /// The text color that keeps contrast on a background (name or #hex).
    public static func textColor(on bg: String?, crt: Bool = false) -> String {
        let pal = crt ? paletteCRT : palette
        if let bg, let t = textOn[bg] { return pal[t]! }
        if let bg, let m = bg.wholeMatch(of: /#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})/) {
            var h = String(m.1)
            if h.count == 3 { h = h.map { "\($0)\($0)" }.joined() }
            let v = { (i: Int) in Double(Int(h.dropFirst(i).prefix(2), radix: 16)!) }
            let lum = 0.2126 * v(0) + 0.7152 * v(2) + 0.0722 * v(4)
            return lum > 145 ? pal["ink"]! : pal["white"]!
        }
        return pal["white"]!
    }
}

// MARK: - Text (config-schema.js sanitize)

public enum BoardText {
    /// The schema's sanitize(): typographic punctuation to plain, whitespace
    /// collapsed, anything the station's font can't draw dropped, and cut to
    /// `max` characters with "..." when longer.
    public static func sanitize(_ text: String, max: Int = 160) -> String {
        // Typographic punctuation to plain, odd spaces to a space.
        var mapped = String.UnicodeScalarView()
        for u in text.unicodeScalars {
            switch u.value {
            case 0x2018, 0x2019, 0x201A, 0x2032: mapped.append("'")
            case 0x201C, 0x201D, 0x201E, 0x2033: mapped.append("\"")
            case 0x2013, 0x2014, 0x2015, 0x2212: mapped.append("-")
            case 0x2026: mapped.append(contentsOf: "...".unicodeScalars)
            case 0x00A0, 0x2000...0x200B, 0x202F, 0x3000: mapped.append(" ")
            default: mapped.append(u)
            }
        }
        var t = String(mapped).replacing(/\s+/, with: " ")
        // Only what the station's font can draw: printable ASCII, Latin-1, bullet, squares.
        t = String(String.UnicodeScalarView(t.unicodeScalars.filter { u in
            (0x20...0x7E).contains(u.value) || (0xA1...0xFF).contains(u.value)
                || u.value == 0x2022 || u.value == 0x25A0 || u.value == 0x25AA
        }))
        t = t.replacing(/\s+/, with: " ").trimmingCharacters(in: .whitespaces)
        if max >= 4 && t.count > max {
            t = String(t.prefix(max - 3)).replacing(/\s+$/, with: "") + "..."
        }
        return t
    }

    /// board.js buildCrawlText(): headlines interleaved across feeds (news 1,
    /// tech 1, blog 1, news 2, ...), extras in front, or the fallback when empty.
    public static func crawlText(feedIDs: [String], labels: [String: String], items: [String: [String]],
                                 separator: String, fallback: String, extras: [String] = []) -> String {
        var parts = extras.filter { !$0.isEmpty }
        let most = feedIDs.map { items[$0]?.count ?? 0 }.max() ?? 0
        for k in 0..<most {
            for id in feedIDs {
                if let list = items[id], k < list.count { parts.append((labels[id] ?? id.uppercased()) + ": " + list[k]) }
            }
        }
        return parts.isEmpty ? fallback : parts.joined(separator: separator)
    }

    /// board.js formatWxTime(): "2026-07-22T05:27" -> "5:27 AM", reading the
    /// digits as they are (Open-Meteo already gives the location's local time).
    public static func weatherTime(_ iso: String?, _ mode: ClockMode) -> String {
        guard let iso, let m = iso.firstMatch(of: /T(\d{2}):(\d{2})/), let hh = Int(m.1) else { return "" }
        if mode == .twentyFourHour { return Dial.pad2(hh) + ":" + m.2 }
        return "\(hh % 12 == 0 ? 12 : hh % 12):\(m.2) \(hh < 12 ? "AM" : "PM")"
    }

    /// "THE WORLD IS SET TO {COLOR}" + "purple" -> "THE WORLD IS SET TO PURPLE".
    public static func cheerLightsLine(template: String, color: String?) -> String {
        guard let color, !color.isEmpty else { return "" }
        return template.replacing(/\{color\}/.ignoresCase(), with: color.uppercased())
    }
}

// MARK: - Feeds

/// RSS 2.0 and Atom item titles, as board.js parseFeed() reads them: the
/// `<title>` that is a direct child of each `<item>` or `<entry>`, in that
/// element's own namespace (so a `<media:title>` never stands in for it).
public enum FeedParser {
    public static func titles(_ data: Data) -> [String] {
        let delegate = Delegate()
        let parser = XMLParser(data: data)
        parser.shouldProcessNamespaces = true
        parser.delegate = delegate
        return parser.parse() ? delegate.titles : []
    }

    private final class Delegate: NSObject, XMLParserDelegate {
        var titles: [String] = []
        private var stack: [(name: String, ns: String?)] = []
        private var itemDepth: Int? // depth of the open item/entry
        private var itemNS: String?
        private var inTitle = false
        private var tookTitle = false
        private var buffer = ""

        func parser(_ parser: XMLParser, didStartElement name: String, namespaceURI ns: String?,
                    qualifiedName: String?, attributes: [String: String] = [:]) {
            let local = name
            if itemDepth == nil, local == "item" || local == "entry" {
                itemDepth = stack.count
                itemNS = ns
                tookTitle = false
            } else if let d = itemDepth, stack.count == d + 1, local == "title", ns == itemNS, !tookTitle {
                inTitle = true
                buffer = ""
            }
            stack.append((local, ns))
        }

        func parser(_ parser: XMLParser, foundCharacters string: String) { if inTitle { buffer += string } }

        func parser(_ parser: XMLParser, foundCDATA data: Data) {
            if inTitle { buffer += String(decoding: data, as: UTF8.self) }
        }

        func parser(_ parser: XMLParser, didEndElement name: String, namespaceURI: String?, qualifiedName: String?) {
            stack.removeLast()
            if inTitle, let d = itemDepth, stack.count == d + 1 {
                inTitle = false
                tookTitle = true
                if !buffer.isEmpty { titles.append(buffer) }
            }
            if let d = itemDepth, stack.count == d { itemDepth = nil }
        }
    }
}

// MARK: - The page rotation

/// What the board shows on one page. `background` is a color name or #hex.
public enum BoardPage: Equatable, Sendable {
    case clock(background: String)
    case text(kicker: String, body: String, background: String)
    case weather(Weather, background: String)
}

/// What the rotation draws from: the config's text plus what the loops fetched.
public struct BoardStore: Sendable {
    public var messages: [BoardConfig.Message]
    public var facts: [String]
    public var dadJokes: [String]
    public var feeds: [String: [String]] = [:]
    public var labels: [String: String] = [:]
    public var weather: Weather?

    static let fallbackFacts = [
        "The Weather Channel debuted on May 2, 1982",
        "The first smiley emoticon was posted in September 1982",
        "Honey never spoils",
        "A day on Venus is longer than its year",
        "A group of flamingos is called a flamboyance",
    ]
    static let fallbackJokes = [
        "Why did the scarecrow win an award? He was outstanding in his field.",
        "I'm reading a book about anti-gravity. It's impossible to put down.",
        "What do you call a fake noodle? An impasta.",
    ]

    public init(_ cfg: BoardConfig) {
        messages = cfg.messages
        facts = cfg.facts.isEmpty ? Self.fallbackFacts : cfg.facts
        dadJokes = cfg.dadJokes.isEmpty ? Self.fallbackJokes : cfg.dadJokes
        labels = Dictionary(cfg.feeds.map { ($0.id, $0.label) }, uniquingKeysWith: { a, _ in a })
    }
}

/// board.js advancePage(): walk the rotation, skipping slots with nothing to
/// show, round-robin within each kind, and color pages from the cycle unless
/// a message names its own.
public struct BoardRotation: Sendable {
    let rotation: [BoardConfig.Slot]
    let pageCycle: [String]
    private var slot = -1
    private var messages = RoundRobin(), facts = RoundRobin(), jokes = RoundRobin(), cycle = RoundRobin()
    private var headlines: [String: RoundRobin] = [:]

    public init(_ cfg: BoardConfig) {
        rotation = cfg.rotation
        pageCycle = cfg.colors.pageCycle
    }

    public mutating func next(_ store: BoardStore) -> BoardPage {
        for _ in 0..<max(rotation.count, 1) where !rotation.isEmpty {
            slot = (slot + 1) % rotation.count
            if let page = render(rotation[slot], store) { return page }
        }
        return .clock(background: nextCycleColor()) // nothing renderable: the clock always is
    }

    private mutating func nextCycleColor() -> String {
        let i = cycle.next(pageCycle.count)
        return i < 0 ? "blue" : pageCycle[i]
    }

    private mutating func background(_ name: String?) -> String {
        if let name, BoardColors.palette[name] != nil || name.hasPrefix("#") { return name }
        return nextCycleColor()
    }

    private mutating func render(_ s: BoardConfig.Slot, _ store: BoardStore) -> BoardPage? {
        switch s.type {
        case "clock":
            return .clock(background: background(nil))
        case "messages":
            let i = messages.next(store.messages.count)
            guard i >= 0 else { return nil }
            let m = store.messages[i]
            return .text(kicker: "COMMUNITY BULLETIN", body: m.text, background: background(m.color))
        case "facts":
            let i = facts.next(store.facts.count)
            guard i >= 0 else { return nil }
            return .text(kicker: "DID YOU KNOW", body: store.facts[i], background: background(nil))
        case "dadjokes":
            let i = jokes.next(store.dadJokes.count)
            guard i >= 0 else { return nil }
            return .text(kicker: "DAD JOKE", body: store.dadJokes[i], background: background(nil))
        case "weather":
            guard let w = store.weather, w.tempNow != nil else { return nil } // not loaded yet: skip
            return .weather(w, background: background(nil))
        case "headlines":
            let feed = s.feed ?? ""
            let items = store.feeds[feed] ?? []
            var rr = headlines[feed] ?? RoundRobin()
            let i = rr.next(items.count)
            headlines[feed] = rr
            guard i >= 0 else { return nil }
            return .text(kicker: store.labels[feed] ?? feed.uppercased(), body: items[i], background: background(nil))
        default:
            return nil
        }
    }
}

/// Round-robin over a list whose length may change between calls.
struct RoundRobin: Sendable {
    private var i = -1
    mutating func next(_ count: Int) -> Int {
        guard count > 0 else { return -1 }
        i = (i + 1) % count
        return i
    }
}
