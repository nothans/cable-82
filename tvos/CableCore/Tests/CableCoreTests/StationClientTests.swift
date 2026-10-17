import Foundation
import Testing
@testable import CableCore

@Test func serverAddressAcceptsWhatPeopleType() {
    #expect(ServerAddress.parse("192.168.1.42")?.absoluteString == "http://192.168.1.42:1982/")
    #expect(ServerAddress.parse(" 192.168.1.42:8080 ")?.absoluteString == "http://192.168.1.42:8080/")
    #expect(ServerAddress.parse("media.local")?.absoluteString == "http://media.local:1982/")
    #expect(ServerAddress.parse("http://192.168.1.42:1982/config")?.absoluteString == "http://192.168.1.42:1982/")
    #expect(ServerAddress.parse("https://tv.example.com")?.absoluteString == "https://tv.example.com/")
    #expect(ServerAddress.parse("") == nil)
    #expect(ServerAddress.parse("ftp://x") == nil)
}

@Test func mediaURLsResolveAgainstTheServer() {
    let c = StationClient(baseURL: URL(string: "http://10.0.0.5:1982/")!)
    #expect(c.mediaURL("channels/retro-tv/01%20Duck%20and%20Cover.mp4").absoluteString ==
            "http://10.0.0.5:1982/channels/retro-tv/01%20Duck%20and%20Cover.mp4")
}

// MARK: - Talking to a station

/// Answers requests from a table instead of the network. Each test uses its
/// own host, so tests running side by side don't see each other's answers.
private final class StubStation: URLProtocol, @unchecked Sendable {
    struct Answer { var status = 200; var body = Data() }
    struct Seen { var method: String; var path: String; var headers: [String: String]; var body: Data? }

    nonisolated(unsafe) private static var answers: [String: (Seen) -> Answer] = [:]
    nonisolated(unsafe) private static var seen: [String: [Seen]] = [:]
    private static let lock = NSLock()

    /// A client for a fresh host whose requests `answer` handles.
    static func client(_ answer: @escaping (Seen) -> Answer) -> (StationClient, host: String) {
        let host = "station-\(UUID().uuidString.lowercased()).test"
        lock.withLock { answers[host] = answer }
        let config = URLSessionConfiguration.ephemeral
        config.protocolClasses = [StubStation.self]
        return (StationClient(baseURL: URL(string: "http://\(host):1982/")!, session: URLSession(configuration: config)), host)
    }

    static func requests(to host: String) -> [Seen] { lock.withLock { seen[host] ?? [] } }

    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

    override func startLoading() {
        let url = request.url!
        // URLSession hands a protocol the body as a stream.
        var body = request.httpBody
        if body == nil, let stream = request.httpBodyStream {
            stream.open()
            var data = Data()
            var buf = [UInt8](repeating: 0, count: 4096)
            while stream.hasBytesAvailable {
                let n = stream.read(&buf, maxLength: buf.count)
                if n <= 0 { break }
                data.append(buf, count: n)
            }
            stream.close()
            body = data
        }
        let s = Seen(method: request.httpMethod ?? "GET", path: url.path(percentEncoded: false),
                     headers: request.allHTTPHeaderFields ?? [:], body: body)
        let host = url.host() ?? ""
        let handler = Self.lock.withLock {
            Self.seen[host, default: []].append(s)
            return Self.answers[host]
        }
        let a = handler?(s) ?? Answer(status: 404)
        client?.urlProtocol(self, didReceive: HTTPURLResponse(url: url, statusCode: a.status, httpVersion: "HTTP/1.1", headerFields: nil)!,
                            cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: a.body)
        client?.urlProtocolDidFinishLoading(self)
    }

    override func stopLoading() {}
}

private func json(_ s: String) -> Data { Data(s.utf8) }

@Test func aBrokenConfigsErrorReachesTheScreen() async throws {
    let (c, _) = StubStation.client { _ in .init(status: 500, body: json(#"{"ok":false,"error":"LINE 12: UNEXPECTED TOKEN"}"#)) }
    let error = await #expect(throws: StationClient.Failure.self) { try await c.config() }
    #expect(error?.errorDescription == "LINE 12: UNEXPECTED TOKEN", "the server's own words, not just a code")

    let (plain, _) = StubStation.client { _ in .init(status: 503, body: json("SERVICE UNAVAILABLE")) }
    let bare = await #expect(throws: StationClient.Failure.self) { try await plain.channels() }
    #expect(bare?.errorDescription == "The server answered 503.")
}

@Test func theConfigAndListingsDecodeFromTheirEndpoints() async throws {
    let (c, host) = StubStation.client { req in
        switch req.path {
        case "/api/config":
            return .init(body: json(#"{"version":"1.2.0","config":{"channelName":"KTVU","channels":[{"number":2,"type":"video","folder":"movies"}]}}"#))
        case "/api/channels":
            return .init(body: json(#"{"channels":[{"number":2,"folder":"movies","files":[{"file":"a.mp4","url":"channels/movies/a.mp4","duration":60}]}]}"#))
        default:
            return .init(status: 404)
        }
    }
    let cfg = try await c.config()
    #expect(cfg.version == "1.2.0")
    #expect(cfg.config.channelName == "KTVU")
    #expect(try await c.channels().libraries[2]?.files.map(\.duration) == [60])
    #expect(StubStation.requests(to: host).map(\.path) == ["/api/config", "/api/channels"])
}

@Test func measuredLengthsArePostedWithTheWriteGuard() async throws {
    let (c, host) = StubStation.client { _ in .init(body: json(#"{"ok":true}"#)) }
    try await c.postDurations(folder: "retro-tv", durations: ["01 Duck and Cover.mp4": 548.2])
    let req = try #require(StubStation.requests(to: host).first)
    #expect(req.method == "POST")
    #expect(req.path == "/api/channels/durations")
    #expect(req.headers["x-cable82-config"] == "1", "the server refuses writes without it")
    #expect(req.headers["Content-Type"] ?? req.headers["content-type"] == "application/json")
    let sent = try #require(try JSONSerialization.jsonObject(with: req.body ?? Data()) as? [String: Any])
    #expect(sent["folder"] as? String == "retro-tv")
    #expect(sent["durations"] as? [String: Double] == ["01 Duck and Cover.mp4": 548.2])
}

@Test func aRefusedPostIsAnError() async {
    let (c, _) = StubStation.client { _ in .init(status: 403, body: json(#"{"ok":false,"error":"FORBIDDEN"}"#)) }
    await #expect(throws: StationClient.Failure.self) {
        try await c.postDurations(folder: "x", durations: ["a.mp4": 1])
    }
}

@Test func feedIDsTravelInThePathIntact() async throws {
    // The server decodes the whole path (decodeURIComponent) before it reads
    // the id, so an id with a space or a slash has to arrive whole.
    let (c, host) = StubStation.client { _ in .init(body: json("<rss/>")) }
    _ = try await c.feed("news")
    _ = try await c.feed("local news")
    _ = try await c.feed("a/b")
    #expect(StubStation.requests(to: host).map(\.path) == ["/api/feed/news", "/api/feed/local news", "/api/feed/a/b"])
}

@Test func theSmallEndpointsDecodeWhatTheBoardReads() async throws {
    let (c, _) = StubStation.client { req in
        switch req.path {
        case "/api/cheerlights": return .init(body: json(#"{"color":"purple"}"#))
        case "/api/music": return .init(body: json(#"{"tracks":[{"url":"music/a.mp3"},{"url":"music/b%20c.mp3"}]}"#))
        case "/api/weather": return .init(body: json(#"{"name":"Natick","tempNow":61.5,"tempUnit":"F"}"#))
        default: return .init(status: 404)
        }
    }
    #expect(try await c.cheerLights() == "purple")
    #expect(try await c.music() == ["music/a.mp3", "music/b%20c.mp3"])
    #expect(try await c.weather().tempNow == 61.5)
}
