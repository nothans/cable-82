import AVFoundation
import CableCore
import Foundation

/// Channel 82's running parts, a port of board.js's loops: the page rotation,
/// the feeds, weather and CheerLights, and the music bed.
///
/// As in board.js, the refresh loops start the first time the board goes on
/// the air and keep running quietly while another channel covers it, so
/// coming back is instant and current. The pages and the music stop while
/// covered. A board that never goes on the air never polls anything.
@Observable
final class BulletinBoard {
    private(set) var page: BoardPage = .clock(background: "blue")
    let config: BoardConfig

    @ObservationIgnored private let client: StationClient
    @ObservationIgnored private var store: BoardStore
    @ObservationIgnored private var rotation: BoardRotation
    @ObservationIgnored private var cheerLightsColor: String?
    @ObservationIgnored private var loops: [Task<Void, Never>] = []
    @ObservationIgnored private var pageTask: Task<Void, Never>?
    @ObservationIgnored private var started = false
    @ObservationIgnored private let music = AVPlayer()
    @ObservationIgnored private var tracks: [URL] = []
    @ObservationIgnored private var trackIndex = 0
    @ObservationIgnored private var musicObserver: NSObjectProtocol?

    init(config: BoardConfig, client: StationClient) {
        self.config = config
        self.client = client
        store = BoardStore(config)
        rotation = BoardRotation(config)
        music.volume = Float(min(max(config.music.volume / 100, 0), 1))
        music.automaticallyWaitsToMinimizeStalling = true
    }

    deinit { loops.forEach { $0.cancel() } }

    // MARK: - On and off the air

    func activate() {
        if !started { start() }
        advance() // a fresh page the moment the board is back
        pageTask?.cancel()
        pageTask = Task { [weak self] in
            while !Task.isCancelled {
                try? await Task.sleep(for: .seconds(self?.config.pageSeconds ?? 12))
                guard !Task.isCancelled else { return }
                self?.advance()
            }
        }
        if config.music.enabled { playMusic() }
    }

    func deactivate() {
        pageTask?.cancel()
        pageTask = nil
        music.pause()
    }

    private func advance() { page = rotation.next(store) }

    /// The crawl's text for its next pass: headlines interleaved, CheerLights in front.
    func crawlText() -> String {
        let cheer = config.cheerlights.enabled
            ? BoardText.cheerLightsLine(template: config.cheerlights.template, color: cheerLightsColor) : ""
        return BoardText.crawlText(
            feedIDs: config.crawl.feeds, labels: store.labels, items: store.feeds,
            separator: config.crawl.separator,
            fallback: config.channelName + (config.tagline.isEmpty ? "" : " " + config.crawl.separator + " " + config.tagline),
            extras: cheer.isEmpty ? [] : ["CHEERLIGHTS: " + cheer])
    }

    // MARK: - The refresh loops

    private func start() {
        started = true
        for (i, feed) in config.feeds.enumerated() {
            loops.append(Task { [weak self] in
                try? await Task.sleep(for: .milliseconds(500 + i * 2000)) // staggered, as board.js does
                var failures = 0
                while !Task.isCancelled, let self {
                    if await self.refresh(feed: feed.id) { failures = 0 } else { failures += 1 }
                    // Back off 1, 2, 4... minutes after failures, never longer than the normal refresh.
                    let minutes = failures == 0 ? config.refreshMinutes
                        : min(config.refreshMinutes, pow(2, Double(failures - 1)))
                    try? await Task.sleep(for: .seconds(minutes * 60))
                }
            })
        }
        // Weather only when a weather page is in the rotation, so a board
        // that never shows weather never calls out.
        if config.rotation.contains(where: { $0.type == "weather" }) {
            loops.append(repeating(every: 15 * 60) { board in
                if let w = try? await board.client.weather() { board.store.weather = w }
            })
        }
        if config.cheerlights.enabled {
            loops.append(repeating(every: 60) { board in
                if let c = try? await board.client.cheerLights() { board.cheerLightsColor = c }
            })
        }
    }

    private func refresh(feed id: String) async -> Bool {
        guard let data = try? await client.feed(id) else { return false }
        let items = FeedParser.titles(data).map { BoardText.sanitize($0) }.filter { !$0.isEmpty }
        guard !items.isEmpty else { return false }
        store.feeds[id] = Array(items.prefix(config.maxItemsPerFeed)) // replaced wholesale, capped
        return true
    }

    /// Run `body` now and then every `seconds`, keeping the last good answer on a failure.
    private func repeating(every seconds: Double, _ body: @escaping (BulletinBoard) async -> Void) -> Task<Void, Never> {
        Task { [weak self] in
            while !Task.isCancelled {
                guard let self else { return }
                await body(self)
                try? await Task.sleep(for: .seconds(seconds))
            }
        }
    }

    // MARK: - Music

    /// The tracks in the station's music/ folder as a continuous bed, looping
    /// the set (reshuffled each time round when shuffle is on).
    private func playMusic() {
        if music.currentItem != nil {
            music.play()
            return
        }
        Task { [weak self] in
            guard let self, tracks.isEmpty, let urls = try? await client.music(), !urls.isEmpty else { return }
            tracks = urls.map(client.mediaURL)
            if config.music.shuffle { tracks.shuffle() }
            musicObserver = NotificationCenter.default.addObserver(
                forName: AVPlayerItem.didPlayToEndTimeNotification, object: nil, queue: .main) { [weak self] n in
                let item = n.object as? AVPlayerItem
                MainActor.assumeIsolated {
                    guard let self, item === self.music.currentItem else { return }
                    self.nextTrack()
                }
            }
            trackIndex = -1
            nextTrack()
        }
    }

    private func nextTrack() {
        trackIndex += 1
        if trackIndex >= tracks.count {
            trackIndex = 0
            if config.music.shuffle { tracks.shuffle() }
        }
        music.replaceCurrentItem(with: AVPlayerItem(url: tracks[trackIndex]))
        if pageTask != nil { music.play() } // only while the board is on the air
    }
}
