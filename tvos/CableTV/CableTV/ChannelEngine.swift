import AVFoundation
import CableCore
import Combine
import UIKit

/// The picture: two player layers stacked, only one ever showing.
final class PlayerSurface: UIView {
    let layers = [AVPlayerLayer(), AVPlayerLayer()]

    override init(frame: CGRect) {
        super.init(frame: frame)
        backgroundColor = .black
        for l in layers {
            l.videoGravity = .resizeAspect // 4:3 programs pillarbox on a 16:9 set
            layer.addSublayer(l)
        }
    }

    required init?(coder: NSCoder) { fatalError("not used") }

    override func layoutSubviews() {
        super.layoutSubviews()
        withoutAnimation { for l in layers { l.frame = bounds } }
    }

    func show(_ i: Int) {
        withoutAnimation {
            layers[i].isHidden = false
            layers[1 - i].isHidden = true
        }
    }

    private func withoutAnimation(_ body: () -> Void) {
        CATransaction.begin()
        CATransaction.setDisableActions(true)
        body()
        CATransaction.commit()
    }
}

/// A video channel on the air: a port of cable-82's video.js.
///
/// Two AVPlayers: one on the air, one cued with the next segment, so a
/// boundary is a cut, the way a station does it, not a load. Where the
/// channel is comes from the broadcast clock (Dial.positionAt over the
/// channel's timeline), never from a play cursor; the players only chase it.
@Observable
final class ChannelEngine {
    let surface = PlayerSurface()
    /// Set while the segment on the air can't be played; cleared at the next boundary.
    private(set) var trouble: String?
    var volume: Float = 1 { didSet { players[air].volume = volume } }

    @ObservationIgnored private let client: StationClient
    @ObservationIgnored private let players = [AVPlayer(), AVPlayer()]
    @ObservationIgnored private var air = 0 // which player is on the air
    private var standby: Int { 1 - air }
    @ObservationIgnored private var cuedIndex: Int? // timeline index the standby holds
    @ObservationIgnored private var channel: Channel?
    @ObservationIgnored private var library = Library(files: [])
    @ObservationIgnored private var timeline: [Segment] = []
    @ObservationIgnored private var starts: [Double] = [] // each segment's start within the loop
    @ObservationIgnored private var loopLength = 0.0
    @ObservationIgnored private(set) var index = -1 // timeline index on the air
    /// Bumped on every start and stop, so async work for an old tune drops out.
    @ObservationIgnored private var generation = 0
    @ObservationIgnored private var watches: [ObjectIdentifier: AnyCancellable] = [:]
    /// Loaded assets by URL. A channel cycles through a small set of files
    /// (the spots most of all), and a loaded asset makes an item ready fast.
    @ObservationIgnored private var assets: [URL: AVURLAsset] = [:]
    @ObservationIgnored private var resyncTimer: Timer?
    @ObservationIgnored private var troubleTimer: Timer?
    @ObservationIgnored private var watchTimer: Timer?
    /// Sees the endings and stalls the notifications miss (video.js's endWatch).
    @ObservationIgnored private var endWatch = EndWatch()
    /// True once the air is running on the clock; the watch only judges it then.
    @ObservationIgnored private var watching = false
    @ObservationIgnored private var observers: [NSObjectProtocol] = []

    /// Allowed drift from the clock before a resync seeks, as in video.js.
    private let driftTolerance = 1.5

    init(client: StationClient) {
        self.client = client
        for (i, p) in players.enumerated() {
            p.actionAtItemEnd = .pause
            // Required for setRate(_:time:atHostTime:), which starts playback on the clock.
            p.automaticallyWaitsToMinimizeStalling = false
            surface.layers[i].player = p
        }
        players[1].isMuted = true
        let center = NotificationCenter.default
        observers = [
            center.addObserver(forName: AVPlayerItem.didPlayToEndTimeNotification, object: nil, queue: .main) { [weak self] n in
                let item = n.object as? AVPlayerItem
                MainActor.assumeIsolated { self?.ended(item) }
            },
            center.addObserver(forName: AVPlayerItem.failedToPlayToEndTimeNotification, object: nil, queue: .main) { [weak self] n in
                let item = n.object as? AVPlayerItem
                MainActor.assumeIsolated { self?.failed(item) }
            },
        ]
    }

    isolated deinit {
        stop()
        observers.forEach(NotificationCenter.default.removeObserver)
    }

    /// Put a channel on the air. Every duration in `library` must be known.
    func start(_ channel: Channel, library: Library) {
        stop()
        self.channel = channel
        self.library = library
        setTimeline(Dial.channelTimeline(channel, files: library.files, spots: library.spots, date: Date()))
        drive()
        resyncTimer = Timer.scheduledTimer(withTimeInterval: 10, repeats: true) { [weak self] _ in
            MainActor.assumeIsolated { self?.resync() }
        }
        watchTimer = Timer.scheduledTimer(withTimeInterval: 0.25, repeats: true) { [weak self] _ in
            MainActor.assumeIsolated { self?.watch() }
        }
    }

    private func setTimeline(_ segments: [Segment]) {
        timeline = segments
        var t = 0.0
        starts = timeline.map { seg in defer { t += seg.duration ?? 0 }; return t }
        loopLength = t
    }

    func stop() {
        generation += 1
        resyncTimer?.invalidate()
        troubleTimer?.invalidate()
        watchTimer?.invalidate()
        watching = false
        for p in players {
            p.pause()
            p.replaceCurrentItem(with: nil)
        }
        watches.removeAll()
        assets.removeAll()
        channel = nil
        library = Library(files: [])
        setTimeline([])
        index = -1
        cuedIndex = nil
        trouble = nil
    }

    // MARK: - Driving from the clock

    /// Cold-load whatever the clock says is on now, at the right moment.
    private func drive() {
        guard let pos = Dial.positionAt(timeline, at: Date()) else { return }
        let seg = timeline[pos.index]
        index = pos.index
        cuedIndex = nil
        trouble = nil
        watching = false
        let p = players[air]
        p.isMuted = false
        p.volume = volume
        let item = load(seg, into: p)
        let gen = generation
        log("cold load \(seg.file) at \(fmt(seg.from + pos.offset))")
        Task {
            guard await ready(item), gen == generation, p.currentItem === item else { return }
            // Loading took time: buffer from about where the clock will be, then start on it.
            let soon = Dial.positionAt(timeline, at: Date().addingTimeInterval(0.5))
            let offset = soon?.index == index ? soon!.offset : pos.offset
            await p.seek(to: seconds(seg.from + offset), toleranceBefore: .zero, toleranceAfter: .zero)
            guard gen == generation, p.currentItem === item else { return }
            _ = await p.preroll(atRate: 1)
            guard gen == generation, p.currentItem === item else { return }
            lock(p, to: index)
            surface.show(air)
            cueNext()
        }
    }

    /// Load the segment after the one on the air into the standby, parked at its first frame.
    private func cueNext() {
        guard !timeline.isEmpty, index >= 0 else { return }
        let n = (index + 1) % timeline.count
        let seg = timeline[n]
        // Load the files after it too, off the players: a paused standby's
        // loading waits behind the air player's buffering, which can take
        // longer than a 6-second spot.
        for k in 2...3 { warm(timeline[(index + k) % timeline.count]) }
        let p = players[standby]
        p.pause()
        p.isMuted = true
        let item = load(seg, into: p)
        cuedIndex = n
        let gen = generation
        let t0 = Date()
        Task {
            let ok = await ready(item)
            if !ok || -t0.timeIntervalSinceNow > 1 { log("slow cue: ready=\(ok) after \(fmt(-t0.timeIntervalSinceNow))s, \(seg.file)") }
            guard ok, gen == generation, p.currentItem === item else { return }
            await p.seek(to: seconds(seg.from), toleranceBefore: .zero, toleranceAfter: .zero)
            guard gen == generation, p.currentItem === item, p.rate == 0 else { return }
            _ = await p.preroll(atRate: 1)
            guard gen == generation, p.currentItem === item else { return }
            // Start (muted, hidden) the moment the clock reaches this segment,
            // so the cut is on time however late the ending is reported.
            schedule(p, toStart: n)
        }
    }

    /// The segment on the air reached its end (or its act's end): cut to the standby.
    private func ended(_ item: AVPlayerItem?) {
        guard let item, item === players[air].currentItem, !timeline.isEmpty else { return }
        let n = (index + 1) % timeline.count
        let s = players[standby]
        watching = false
        guard cuedIndex == n, s.currentItem?.status == .readyToPlay else {
            log("boundary with nothing cued: cued \(String(describing: cuedIndex)) want \(n), standby status \(s.currentItem?.status.rawValue ?? -1), error \(String(describing: s.currentItem?.error))")
            drive() // nothing cued in time: cold-load from the clock
            return
        }
        log("cut to \(timeline[n].file)")
        players[air].pause()
        players[air].isMuted = true
        air = standby
        s.isMuted = false
        s.volume = volume
        if s.rate == 0 { s.play() } // it should already be running on the clock
        surface.show(air)
        index = n
        cuedIndex = nil
        trouble = nil
        troubleTimer?.invalidate()
        startWatching()
        cueNext()
    }

    /// The clock is the truth: if the air has wandered from it, put it back.
    private func resync() {
        // A shuffled channel's running order is the day's: at midnight the
        // browser display picks up the new one, so this set does too.
        if let channel, let fresh = Playout.timelineChange(channel, library: library, current: timeline, at: Date()) {
            log("new day's running order")
            generation += 1 // what's cued belongs to yesterday's order
            setTimeline(fresh)
            drive()
            return
        }
        guard !timeline.isEmpty, index >= 0, trouble == nil,
              let pos = Dial.positionAt(timeline, at: Date()) else { return }
        let p = players[air]
        guard p.currentItem?.status == .readyToPlay, p.rate > 0 else { return } // mid-load or mid-cut; the watch covers a stop
        let seg = timeline[index]
        let onAir = starts[index] + (p.currentTime().seconds - seg.from)
        let clock = starts[pos.index] + pos.offset
        let drift = Playout.drift(onAir: onAir, clock: clock, loopLength: loopLength)
        if abs(drift) > 0.05 { log("drift \(fmt(drift))s on \(seg.file)") }
        guard abs(drift) > driftTolerance else { return }
        if pos.index == index {
            lock(p, to: index)
        } else {
            drive()
        }
    }

    /// A few times a second: a notification can go missing, and a player
    /// can stop without one. A stop at the end mark is the ending; a stop
    /// anywhere else reloads from the clock.
    private func watch() {
        guard watching, trouble == nil, timeline.indices.contains(index) else { return }
        let p = players[air]
        guard let item = p.currentItem else { return }
        let seg = timeline[index]
        let end = seg.to ?? seg.from + (seg.duration ?? .infinity)
        switch endWatch.look(time: p.currentTime().seconds, end: end, now: ProcessInfo.processInfo.systemUptime) {
        case .fine: break
        case .ended:
            log("watch: stopped at the end of \(seg.file)")
            ended(item)
        case .stalled:
            log("watch: stalled in \(seg.file); reloading from the clock")
            drive()
        }
    }

    // MARK: - Failure

    private func failed(_ item: AVPlayerItem?) {
        guard let item else { return }
        log("failed: \(item === players[air].currentItem ? "air" : item === players[standby].currentItem ? "standby" : "stale") \(String(describing: item.error))")
        if item === players[air].currentItem {
            // Stay on the clock: sit out this segment behind a card, and
            // pick the air back up where the next one starts.
            trouble = item.error?.localizedDescription ?? "This program can't be played."
            watching = false
            players[air].pause()
            let remaining = Dial.positionAt(timeline, at: Date()).map { (timeline[$0.index].duration ?? 5) - $0.offset } ?? 5
            troubleTimer?.invalidate()
            troubleTimer = Timer.scheduledTimer(withTimeInterval: max(remaining, 1) + 0.1, repeats: false) { [weak self] _ in
                MainActor.assumeIsolated { self?.drive() }
            }
        } else if item === players[standby].currentItem {
            cuedIndex = nil // the boundary cold-loads instead
        }
    }

    // MARK: - Starting on the clock

    /// Play segment `i` from wherever the clock says, starting a moment from
    /// now at an exact host time.
    private func lock(_ p: AVPlayer, to i: Int) {
        let startAt = Date().addingTimeInterval(0.15)
        guard let pos = Dial.positionAt(timeline, at: startAt), pos.index == i else {
            p.play() // at a boundary: the cut or the next resync sorts it out
            startWatching()
            return
        }
        p.setRate(1, time: seconds(timeline[i].from + pos.offset), atHostTime: hostTime(at: startAt))
        startWatching()
    }

    private func startWatching() {
        endWatch.reset()
        watching = true
    }

    /// Arrange for segment `n` to start playing when the clock reaches it.
    private func schedule(_ p: AVPlayer, toStart n: Int) {
        let now = Date()
        guard let pos = Dial.positionAt(timeline, at: now) else { return }
        let delta = Playout.startDelay(segmentStart: starts[n], clock: starts[pos.index] + pos.offset,
                                       loopLength: loopLength, tolerance: driftTolerance)
        let from = timeline[n].from
        if delta > 0 {
            p.setRate(1, time: seconds(from), atHostTime: hostTime(at: now.addingTimeInterval(delta)))
        } else {
            p.setRate(1, time: seconds(from - delta), atHostTime: hostTime(at: now))
        }
    }

    private func hostTime(at date: Date) -> CMTime {
        CMTimeAdd(CMClockGetTime(CMClockGetHostTimeClock()), seconds(date.timeIntervalSinceNow))
    }

    // MARK: - Helpers

    private func asset(for seg: Segment) -> AVURLAsset {
        let url = client.mediaURL(seg.url)
        if let a = assets[url] { return a }
        let a = AVURLAsset(url: url)
        assets[url] = a
        return a
    }

    private func warm(_ seg: Segment) {
        let a = asset(for: seg)
        Task { _ = try? await a.load(.isPlayable, .duration, .tracks) }
    }

    @discardableResult
    private func load(_ seg: Segment, into p: AVPlayer) -> AVPlayerItem {
        let item = AVPlayerItem(asset: asset(for: seg))
        // An act ends mid-file for its break; ending there raises didPlayToEndTime.
        if let to = seg.to { item.forwardPlaybackEndTime = seconds(to) }
        if let old = p.currentItem { watches[ObjectIdentifier(old)] = nil }
        watches[ObjectIdentifier(item)] = item.publisher(for: \.status)
            .filter { $0 == .failed }
            .receive(on: DispatchQueue.main)
            .sink { [weak self, weak item] _ in MainActor.assumeIsolated { self?.failed(item) } }
        p.replaceCurrentItem(with: item)
        return item
    }

    /// Wait until an item can seek: true when ready, false when it failed
    /// (or never got there, say because it was replaced before loading).
    private func ready(_ item: AVPlayerItem, timeout: Double = 20) async -> Bool {
        if item.status != .unknown { return item.status == .readyToPlay }
        return await withCheckedContinuation { cont in
            let once = ResumeOnce(cont)
            // .initial reports the current status too, so a change that lands
            // between the check above and this line can't be missed.
            once.hold(item.observe(\.status, options: [.initial, .new]) { item, _ in
                if item.status != .unknown { once.resume(item.status == .readyToPlay) }
            })
            DispatchQueue.main.asyncAfter(deadline: .now() + timeout) { once.resume(false) }
        }
    }

    private func seconds(_ s: Double) -> CMTime { CMTime(seconds: s, preferredTimescale: 600) }

    // MARK: - What's on the air, for the tests

    var segments: [Segment] { timeline }
    var airURL: URL? { (players[air].currentItem?.asset as? AVURLAsset)?.url }
    var airSeconds: Double { players[air].currentTime().seconds }
    var airIsPlaying: Bool { players[air].rate > 0 }

    private func log(_ message: String) {
        #if DEBUG
        print("[engine] \(message)")
        #endif
    }

    private func fmt(_ s: Double) -> String { String(format: "%.2f", s) }
}

/// Resumes a continuation exactly once, from whichever thread gets there
/// first (KVO calls back on the thread that changed the value).
nonisolated private final class ResumeOnce: @unchecked Sendable {
    private let lock = NSLock()
    private var cont: CheckedContinuation<Bool, Never>?
    private var observation: NSKeyValueObservation?

    init(_ cont: CheckedContinuation<Bool, Never>) { self.cont = cont }

    func hold(_ observation: NSKeyValueObservation) {
        lock.withLock { self.observation = cont == nil ? nil : observation }
    }

    func resume(_ value: Bool) {
        let c: CheckedContinuation<Bool, Never>? = lock.withLock {
            defer { cont = nil; observation = nil }
            return cont
        }
        c?.resume(returning: value)
    }
}
