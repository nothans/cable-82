import Foundation
import Testing
@testable import CableCore

private func config(_ json: String) throws -> BoardConfig {
    try JSONDecoder().decode(BoardConfig.self, from: Data(json.utf8))
}

@Test func theRotationSkipsWhatItCantShowAndCyclesColors() throws {
    let cfg = try config("""
    {"rotation":[{"type":"clock"},{"type":"messages"},{"type":"weather"},{"type":"headlines","feed":"news"},{"type":"facts"}],
     "messages":[{"text":"WELCOME","color":"magenta"},{"text":"GARAGE SALE"}],
     "facts":["HONEY NEVER SPOILS"],"feeds":[{"id":"news","label":"NEWS"}],
     "colors":{"pageCycle":["blue","green"]}}
    """)
    var store = BoardStore(cfg)
    var r = BoardRotation(cfg)
    #expect(r.next(store) == .clock(background: "blue"))
    #expect(r.next(store) == .text(kicker: "COMMUNITY BULLETIN", body: "WELCOME", background: "magenta"), "a message's own color, not the cycle")
    // no weather yet and no headlines yet: both skipped
    #expect(r.next(store) == .text(kicker: "DID YOU KNOW", body: "HONEY NEVER SPOILS", background: "green"))
    #expect(r.next(store) == .clock(background: "blue"))
    #expect(r.next(store) == .text(kicker: "COMMUNITY BULLETIN", body: "GARAGE SALE", background: "green"), "round robin within messages")
    store.weather = Weather(name: "BOSTON", tempNow: 62)
    store.feeds["news"] = ["FIRST", "SECOND"]
    if case .weather(let w, _) = r.next(store) { #expect(w.name == "BOSTON") } else { Issue.record("expected weather") }
    #expect(r.next(store) == .text(kicker: "NEWS", body: "FIRST", background: "green"))
}

@Test func anEmptyRotationStillShowsTheClock() throws {
    var r = BoardRotation(try config(#"{"rotation":[]}"#))
    #expect(r.next(BoardStore(BoardConfig())) == .clock(background: "blue"))
}

@Test func emptyFactsAndJokesFallBackToTheBundledOnes() {
    let store = BoardStore(BoardConfig())
    #expect(store.facts.first == "The Weather Channel debuted on May 2, 1982")
    #expect(store.dadJokes.count == 3)
}

@Test func feedTitlesComeFromItemsAndEntriesNotMediaTitles() {
    let rss = """
    <?xml version="1.0"?><rss xmlns:media="http://search.yahoo.com/mrss/"><channel><title>The Feed</title>
    <item><media:title>not this</media:title><title>First &amp; foremost</title></item>
    <item><title><![CDATA[Second <b>story</b>]]></title></item></channel></rss>
    """
    #expect(FeedParser.titles(Data(rss.utf8)) == ["First & foremost", "Second <b>story</b>"])
    let atom = """
    <feed xmlns="http://www.w3.org/2005/Atom"><title>Blog</title>
    <entry><title>An entry</title><link href="x"/></entry></feed>
    """
    #expect(FeedParser.titles(Data(atom.utf8)) == ["An entry"])
    #expect(FeedParser.titles(Data("not xml".utf8)) == [])
}

@Test func boardSettingsDecodeWithTheSchemasDefaults() throws {
    let r = try JSONDecoder().decode(ConfigResponse.self, from: Data(#"{"config":{"messages":[{"text":"HI"}]}}"#.utf8))
    #expect(r.config.board.messages == [BoardConfig.Message(text: "HI", color: nil)])
    #expect(r.config.board.pageSeconds == 12)
    #expect(r.config.board.crawl.flag == "LATEST")
    #expect(r.config.board.rotation.map(\.type) == ["clock", "messages", "facts"])
}

#if canImport(JavaScriptCore) && os(macOS)
import JavaScriptCore

/// The repo's schema, dial, and board.js loaded in JavaScriptCore. board.js
/// only needs `window` at load; its DOM work is inside functions we never call.
private func boardContext() throws -> JSContext {
    let root = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent()
        .deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
    let ctx = JSContext()!
    ctx.exceptionHandler = { _, e in Issue.record("JS exception: \(e?.toString() ?? "?")") }
    ctx.evaluateScript("var window = this;")
    for f in ["config-schema.js", "dial.js", "board.js"] {
        let url = root.appending(path: f)
        ctx.evaluateScript(try String(contentsOf: url, encoding: .utf8), withSourceURL: url)
    }
    return ctx
}

private func js(_ ctx: JSContext, _ fn: String, _ args: Any...) -> JSValue {
    ctx.evaluateScript(fn)!.call(withArguments: args)!
}

@Test func sanitizeMatchesTheSchema() throws {
    let ctx = try boardContext()
    let samples = [
        "It’s “quoted” — and…", "tabs\tand\nnewlines", "  lead and trail  ", "émoji 📺 dropped",
        "Ünïcödé ☃ snow • bullet ■ square ▪ small", String(repeating: "word ", count: 50), "\u{00A0}nbsp\u{2003}em",
        "combining e\u{0301} accent", "",
    ]
    var rng = SystemRandomNumberGenerator()
    let alphabet = Array("abc XYZ 019 ’“”—…•■▪\t\n📺ñß€\u{00A0}\u{2009}")
    let generated = (0..<300).map { _ in String((0..<Int.random(in: 0...200, using: &rng)).map { _ in alphabet.randomElement(using: &rng)! }) }
    for s in samples + generated {
        for max in [160, 40, 3] {
            let expected = js(ctx, "(s, m) => Cable82Schema.sanitize(s, m)", s, max).toString()!
            #expect(BoardText.sanitize(s, max: max) == expected, "\(s.debugDescription) max \(max)")
        }
    }
}

@Test func crawlTextWeatherTimeAndCheerLightsMatchBoardJS() throws {
    let ctx = try boardContext()
    let H = "Cable82Board.helpers"
    let items = ["news": ["A", "B", "C"], "tech": ["X"], "blog": []]
    for ids in [["news", "tech", "blog"], ["tech"], [], ["missing"]] {
        for extras in [[], ["CHEERLIGHTS: RED"]] {
            let expected = js(ctx, "(o) => \(H).buildCrawlText(o)", [
                "feedIds": ids, "labels": ["news": "NEWS", "tech": "TECH"], "items": items,
                "separator": "  ■  ", "fallback": "CABLE 82", "extras": extras,
            ] as [String: Any]).toString()!
            #expect(BoardText.crawlText(feedIDs: ids, labels: ["news": "NEWS", "tech": "TECH"], items: items,
                                        separator: "  ■  ", fallback: "CABLE 82", extras: extras) == expected)
        }
    }
    for iso in ["2026-07-22T05:27", "2026-07-22T00:05", "2026-07-22T12:00", "2026-07-22T23:59", "junk", ""] {
        for (mode, name) in [(ClockMode.twelveHour, "12h"), (.twentyFourHour, "24h")] {
            #expect(BoardText.weatherTime(iso, mode) == js(ctx, "(i, m) => \(H).formatWxTime(i, m)", iso, name).toString())
        }
    }
    for (t, c) in [("THE WORLD IS SET TO {COLOR}", "purple"), ("{color} and {Color}", "warmwhite"), ("NONE", "")] {
        #expect(BoardText.cheerLightsLine(template: t, color: c) == js(ctx, "(t, c) => \(H).cheerlightsLine(t, c)", t, c).toString())
    }
}

@Test func colorRulesMatchTheSchema() throws {
    let ctx = try boardContext()
    let names = ["blue", "cyan", "green", "yellow", "red", "magenta", "white", "ink", "#fff", "#000000", "#C8A020",
                 "#123", "#7f7f7f", "chartreuse", "#12345", ""]
    for n in names {
        for crt in [false, true] {
            let pal = crt ? "Cable82Schema.PALETTE_CRT" : "Cable82Schema.PALETTE"
            #expect(BoardColors.resolve(n, fallback: "ink", crt: crt)
                    == js(ctx, "(n) => Cable82Schema.resolveColor(n, 'ink', \(pal))", n).toString(), "\(n)")
            #expect(BoardColors.textColor(on: n, crt: crt)
                    == js(ctx, "(n) => Cable82Schema.textColorFor(n, \(pal))", n).toString(), "\(n)")
        }
    }
}
#endif
