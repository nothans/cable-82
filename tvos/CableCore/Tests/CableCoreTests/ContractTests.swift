// The config contract: what the server serves is config-schema.js's
// validateConfig() output, and the Swift models have to read it the way the
// browser display does. These run the repo's own schema in JavaScriptCore:
//
// - Every value the Apple TV reads must come through decoding unchanged, for
//   the defaults and for configs full of hand-edit mistakes the schema cleans.
// - A key missing from the JSON (an older server) must decode to what the
//   schema gives a missing key.
//
// So when the schema grows a key or changes a default, this fails instead of
// the Apple TV quietly disagreeing with the browser.

#if canImport(JavaScriptCore) && os(macOS)
import Foundation
import Testing
@testable import CableCore

/// The values the Apple TV reads, keyed by their path in config.json.
private func swiftView(_ c: StationConfig) -> [String: Any] {
    let b = c.board
    return [
        "channelName": c.channelName,
        "timeFormat": c.timeFormat.rawValue,
        "tuner.wrap": c.tuner.wrap,
        "tuner.cut": c.tuner.cut.rawValue,
        "tuner.power": c.tuner.power.rawValue,
        "preview.name": c.preview.name,
        "preview.tagline": c.preview.tagline,
        "preview.slots": c.preview.slots,
        "preview.scrollSeconds": c.preview.scrollSeconds,
        "preview.seconds": c.preview.seconds,
        "preview.background": c.preview.background,
        "tagline": b.tagline,
        "pageSeconds": b.pageSeconds,
        "refreshMinutes": b.refreshMinutes,
        "maxItemsPerFeed": b.maxItemsPerFeed,
        "facts": b.facts,
        "dadJokes": b.dadJokes,
        "messages": b.messages.map { ["text": $0.text, "color": $0.color as Any? ?? NSNull()] },
        "rotation": b.rotation.map { s -> [String: Any] in s.feed.map { ["type": s.type, "feed": $0] } ?? ["type": s.type] },
        "feeds": b.feeds.map { ["id": $0.id, "label": $0.label] },
        "colors.pageCycle": b.colors.pageCycle,
        "colors.headerBg": b.colors.headerBg,
        "colors.crawlBg": b.colors.crawlBg,
        "crawl.feeds": b.crawl.feeds,
        "crawl.secondsPerScreen": b.crawl.secondsPerScreen,
        "crawl.separator": b.crawl.separator,
        "crawl.flag": b.crawl.flag,
        "music.enabled": b.music.enabled,
        "music.shuffle": b.music.shuffle,
        "music.volume": b.music.volume,
        "cheerlights.enabled": b.cheerlights.enabled,
        "cheerlights.template": b.cheerlights.template,
        "crtMode": b.crtMode,
        "crtInkText": b.crtInkText,
        "channels": c.channels.map(channelView),
    ]
}

private func channelView(_ ch: Channel) -> [String: Any] {
    var o: [String: Any] = ["number": ch.number, "name": ch.name, "type": ch.type.rawValue, "enabled": ch.enabled]
    if ch.type == .video {
        o["folder"] = ch.folder as Any? ?? NSNull()
        o["order"] = ch.order.rawValue
        o["mode"] = ch.mode.rawValue
        o["offAir"] = ch.offAir.rawValue
        o["titles"] = ch.titles.rawValue
        o["title"] = ch.titles == .fixed ? ch.title as Any? ?? NSNull() : NSNull()
        o["schedule"] = ch.schedule.map { ["days": $0.days, "start": $0.start, "end": $0.end] }
        o["breaks"] = ch.breaks.map {
            ["folder": $0.folder, "everyMinutes": $0.everyMinutes, "spots": $0.spots, "everyPrograms": $0.everyPrograms] as [String: Any]
        } ?? NSNull()
    }
    if ch.type == .external { o["url"] = ch.url as Any? ?? NSNull() }
    return o
}

/// The same view of the schema's own output, built in JavaScript. Keys the
/// schema leaves out are null, except `everyPrograms`, which the schema only
/// writes when it isn't 1 (dial.js reads a missing one as 1).
private let jsView = """
(() => {
  const r = Cable82Schema.validateConfig(raw);
  if (!r.ok) return null;
  const c = r.cfg;
  const ch = (x) => {
    const o = { number: x.number, name: x.name, type: x.type, enabled: x.enabled };
    if (x.type === "video") {
      Object.assign(o, {
        folder: x.folder ?? null, order: x.order ?? null, mode: x.mode ?? null, offAir: x.offAir ?? null,
        titles: x.titles ?? null, title: x.titles === "fixed" ? (x.title ?? null) : null,
        schedule: (x.schedule ?? []).map((w) => ({ days: w.days, start: w.start, end: w.end })),
        breaks: x.breaks ? { folder: x.breaks.folder, everyMinutes: x.breaks.everyMinutes, spots: x.breaks.spots,
                             everyPrograms: x.breaks.everyPrograms ?? 1 } : null,
      });
    }
    if (x.type === "external") o.url = x.url ?? null;
    return o;
  };
  return {
    view: {
      "channelName": c.channelName, "timeFormat": c.timeFormat,
      "tuner.wrap": c.tuner.wrap, "tuner.cut": c.tuner.cut, "tuner.power": c.tuner.power,
      "preview.name": c.preview.name, "preview.tagline": c.preview.tagline, "preview.slots": c.preview.slots,
      "preview.scrollSeconds": c.preview.scrollSeconds, "preview.seconds": c.preview.seconds,
      "preview.background": c.preview.background,
      "tagline": c.tagline, "pageSeconds": c.pageSeconds, "refreshMinutes": c.refreshMinutes,
      "maxItemsPerFeed": c.maxItemsPerFeed, "facts": c.facts, "dadJokes": c.dadJokes,
      "messages": c.messages.map((m) => ({ text: m.text, color: m.color ?? null })),
      "rotation": c.rotation.map((s) => (s.feed === undefined ? { type: s.type } : { type: s.type, feed: s.feed })),
      "feeds": c.feeds.map((f) => ({ id: f.id, label: f.label })),
      "colors.pageCycle": c.colors.pageCycle, "colors.headerBg": c.colors.headerBg, "colors.crawlBg": c.colors.crawlBg,
      "crawl.feeds": c.crawl.feeds, "crawl.secondsPerScreen": c.crawl.secondsPerScreen,
      "crawl.separator": c.crawl.separator, "crawl.flag": c.crawl.flag,
      "music.enabled": c.music.enabled, "music.shuffle": c.music.shuffle, "music.volume": c.music.volume,
      "cheerlights.enabled": c.cheerlights.enabled, "cheerlights.template": c.cheerlights.template,
      "crtMode": c.crtMode, "crtInkText": c.crtInkText,
      "channels": c.channels.map(ch),
    },
    cfg: c,
  };
})()
"""

/// One value as canonical JSON, so 60 and 60.0 and key order don't matter.
private func canonical(_ v: Any) -> String {
    let data = (try? JSONSerialization.data(withJSONObject: v, options: [.fragmentsAllowed, .sortedKeys])) ?? Data()
    return String(decoding: data, as: UTF8.self)
}

private struct Validated {
    var view: [String: Any]
    var cfg: Data
}

private func validate(_ ref: ReferenceDial, _ raw: Any) throws -> Validated? {
    let data = try ref.json(jsView, ["raw": raw])
    guard let top = try JSONSerialization.jsonObject(with: data, options: [.fragmentsAllowed]) as? [String: Any],
          let view = top["view"] as? [String: Any], let cfg = top["cfg"] else { return nil }
    return Validated(view: view, cfg: try JSONSerialization.data(withJSONObject: cfg))
}

private func mismatches(_ swift: [String: Any], _ js: [String: Any], skipping: Set<String> = []) -> [String] {
    js.keys.sorted().filter { !skipping.contains($0) }.compactMap { k in
        let a = canonical(swift[k] ?? NSNull()), b = canonical(js[k] ?? NSNull())
        return a == b ? nil : "\(k): Swift \(a), schema \(b)"
    }
}

/// A raw config.json with hand-edit mistakes sprinkled through it.
private func messyConfig(_ r: inout Rng, base: [String: Any]) -> [String: Any] {
    let junk: [Any] = [NSNull(), -5, 0, 2.5, 1e9, "junk", "", true, [Any](), [String: Any](), "#FFF", "24h", "black", "none"]
    var raw = base
    raw["channels"] = [
        ["number": 0, "type": "guide"],
        ["number": 2, "type": "video", "name": "MOVIES", "folder": "movies", "order": "shuffle-daily", "titles": "metadata",
         "breaks": ["folder": "spots", "everyMinutes": 15, "spots": 2]],
        ["number": 3, "type": "video", "folder": "cartoons", "mode": "schedule", "offAir": "bulletin", "titles": "fixed",
         "schedule": [["days": ["sat", "sun"], "start": "08:00", "end": "11:30"], ["days": ["fri"], "start": "22:00", "end": "01:00"]],
         "breaks": ["folder": "spots", "everyMinutes": 0, "spots": 1, "everyPrograms": 4]],
        ["number": 7, "type": "external", "url": "https://example.com/weather"],
        ["number": 82, "type": "bulletin"],
    ]
    let paths = [
        "channelName", "tagline", "timeFormat", "pageSeconds", "refreshMinutes", "maxItemsPerFeed", "crtMode", "crtInkText",
        "facts", "dadJokes", "messages", "rotation", "feeds",
        "music.enabled", "music.shuffle", "music.volume", "cheerlights.enabled", "cheerlights.template",
        "crawl.feeds", "crawl.secondsPerScreen", "crawl.separator", "crawl.flag",
        "colors.pageCycle", "colors.headerBg", "colors.crawlBg",
        "preview", "preview.name", "preview.tagline", "preview.slots", "preview.scrollSeconds", "preview.seconds", "preview.background",
        "tuner", "tuner.wrap", "tuner.cut", "tuner.power",
        "channels.1.order", "channels.1.titles", "channels.1.name", "channels.1.enabled", "channels.1.breaks.everyMinutes",
        "channels.1.breaks.spots", "channels.2.mode", "channels.2.offAir", "channels.2.title", "channels.2.breaks.everyPrograms",
        "channels.2.schedule", "channels.3.url",
    ]
    for _ in 0..<r.int(1...8) {
        let path = paths[r.int(0...(paths.count - 1))].split(separator: ".").map(String.init)
        let value = junk[r.int(0...(junk.count - 1))]
        raw = setting(raw, path[...], r.int(0...4) == 0 ? nil : value)
    }
    return raw
}

/// `object` with the value at `path` replaced (or removed, for nil).
private func setting(_ object: Any, _ path: ArraySlice<String>, _ value: Any?) -> [String: Any] {
    var o = object as? [String: Any] ?? [:]
    guard let key = path.first else { return o }
    if path.count == 1 {
        o[key] = value
        return o
    }
    if var list = o[key] as? [Any], let i = Int(path[path.startIndex + 1]), list.indices.contains(i) {
        let rest = path.dropFirst(2)
        list[i] = rest.isEmpty ? (value ?? NSNull()) : setting(list[i], rest, value)
        o[key] = list
    } else {
        o[key] = setting(o[key] ?? [String: Any](), path.dropFirst(), value)
    }
    return o
}

@Suite struct ContractTests {
    fileprivate let ref: ReferenceDial
    init() throws { ref = try ReferenceDial() }

    @Test func whatTheServerServesDecodesUnchanged() throws {
        let base = try #require(try JSONSerialization.jsonObject(with: ref.json("Cable82Schema.DEFAULT_CONFIG")) as? [String: Any])
        var r = Rng(state: 5)
        var checked = 0
        for i in 0..<300 {
            let raw: [String: Any] = i == 0 ? [:] : i == 1 ? base : messyConfig(&r, base: base)
            guard let v = try validate(ref, raw) else { continue }
            let decoded = try JSONDecoder().decode(StationConfig.self, from: v.cfg)
            let diff = mismatches(swiftView(decoded), v.view)
            #expect(diff.isEmpty, "raw \(canonical(raw)):\n\(diff.joined(separator: "\n"))")
            checked += 1
        }
        #expect(checked > 250, "most messy configs still validate")
    }

    @Test func aMissingKeyDecodesToTheSchemasDefault() throws {
        // An older server may not send a key this build knows. Swift's
        // default for it must be the schema's answer for a missing key.
        let v = try #require(try validate(ref, [String: Any]()))
        let fromNothing = try JSONDecoder().decode(StationConfig.self, from: Data("{}".utf8))
        // The schema invents a dial (guide and board) when there is none; the
        // Swift side has nothing to invent it from.
        let diff = mismatches(swiftView(fromNothing), v.view, skipping: ["channels"])
        #expect(diff.isEmpty, "\(diff.joined(separator: "\n"))")
    }

    @Test func aMissingKeyInAChannelDecodesToTheSchemasDefault() throws {
        let raw: [String: Any] = ["channels": [["number": 2, "type": "video", "name": "TWO", "folder": "movies",
                                                "breaks": ["folder": "spots", "everyMinutes": 0, "spots": 1]]]]
        let v = try #require(try validate(ref, raw))
        let jsTwo = try #require((v.view["channels"] as? [[String: Any]])?.first { $0["number"] as? Int == 2 })
        let bare = #"{"number":2,"type":"video","name":"TWO","folder":"movies","breaks":{"folder":"spots","everyMinutes":0,"spots":1}}"#
        let swiftTwo = channelView(try JSONDecoder().decode(Channel.self, from: Data(bare.utf8)))
        #expect(mismatches(swiftTwo, jsTwo).isEmpty, "\(mismatches(swiftTwo, jsTwo))")
    }
}
#endif
