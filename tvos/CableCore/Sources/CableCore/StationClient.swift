// The server's HTTP API, as the display uses it: the config, the channel
// listings, and posting measured durations back. See cable-82's docs/api.md.

import Foundation

public struct StationClient: Sendable {
    public let baseURL: URL
    let session: URLSession

    public init(baseURL: URL, session: URLSession = .shared) {
        self.baseURL = baseURL
        self.session = session
    }

    public enum Failure: Error, LocalizedError {
        case http(Int, String?)

        public var errorDescription: String? {
            switch self {
            case let .http(code, message): message ?? "The server answered \(code)."
            }
        }
    }

    public func config() async throws -> ConfigResponse {
        try await get("api/config")
    }

    public func channels() async throws -> ChannelsResponse {
        try await get("api/channels")
    }

    /// A configured RSS or Atom feed, fetched by the server (GET /api/feed/<id>).
    public func feed(_ id: String) async throws -> Data {
        var req = URLRequest(url: baseURL.appending(path: "api/feed").appending(path: id))
        req.cachePolicy = .reloadIgnoringLocalCacheData
        req.timeoutInterval = 12
        let (data, resp) = try await session.data(for: req)
        try check(resp, data)
        return data
    }

    public func weather() async throws -> Weather { try await get("api/weather") }

    /// The CheerLights color name.
    public func cheerLights() async throws -> String? {
        struct Answer: Decodable { var color: String? }
        return try await (get("api/cheerlights") as Answer).color
    }

    /// The board's music bed: relative URLs of the files in music/, in order.
    public func music() async throws -> [String] {
        struct Answer: Decodable { struct Track: Decodable { var url: String }; var tracks: [Track] }
        return try await (get("api/music") as Answer).tracks.map(\.url)
    }

    /// Report file lengths so the server's `.durations.json` cache fills
    /// itself. `durations` is file name -> seconds.
    public func postDurations(folder: String, durations: [String: Double]) async throws {
        var req = URLRequest(url: baseURL.appending(path: "api/channels/durations"))
        req.httpMethod = "POST"
        req.setValue("application/json", forHTTPHeaderField: "content-type")
        req.setValue("1", forHTTPHeaderField: "x-cable82-config") // the server's guard on writes
        req.httpBody = try JSONSerialization.data(withJSONObject: ["folder": folder, "durations": durations])
        let (data, resp) = try await session.data(for: req)
        try check(resp, data)
    }

    /// A listing's `url` ("channels/retro-tv/01%20Film.mp4", already
    /// percent-encoded) as an absolute URL on this server.
    public func mediaURL(_ relative: String) -> URL {
        URL(string: relative, relativeTo: baseURL)?.absoluteURL ?? baseURL
    }

    private func get<T: Decodable>(_ path: String) async throws -> T {
        var req = URLRequest(url: baseURL.appending(path: path))
        req.cachePolicy = .reloadIgnoringLocalCacheData
        req.timeoutInterval = 10
        let (data, resp) = try await session.data(for: req)
        try check(resp, data)
        return try JSONDecoder().decode(T.self, from: data)
    }

    private func check(_ resp: URLResponse, _ data: Data) throws {
        guard let http = resp as? HTTPURLResponse, !(200..<300).contains(http.statusCode) else { return }
        // A broken config.json answers 500 with {"ok":false,"error":"..."}; pass the words on.
        let message = (try? JSONSerialization.jsonObject(with: data) as? [String: Any])?["error"] as? String
        throw Failure.http(http.statusCode, message)
    }
}

public enum ServerAddress {
    public static let defaultPort = 1982

    /// What someone types on a TV remote -> the server's base URL.
    /// "192.168.1.42", "192.168.1.42:1982", "media.local", and
    /// "http://192.168.1.42:1982/" all work. Nil when it isn't an address.
    public static func parse(_ text: String) -> URL? {
        var s = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !s.isEmpty else { return nil }
        if !s.contains("://") { s = "http://" + s }
        guard var c = URLComponents(string: s), let host = c.host, !host.isEmpty,
              c.scheme == "http" || c.scheme == "https" else { return nil }
        if c.port == nil && c.scheme == "http" { c.port = defaultPort }
        c.path = "/"
        c.query = nil
        c.fragment = nil
        return c.url
    }
}
