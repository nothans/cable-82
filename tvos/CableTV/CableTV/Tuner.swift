import CableCore
import Foundation

/// The dial: a port of the video parts of cable-82's tuner.js. Channel
/// changes and what covers them, the on-screen display, the off-air cards,
/// and power. v1 carries video channels only; the board and the guide are next.
@Observable
final class Tuner {
    enum Screen: Equatable {
        case connecting
        case trouble(String) // the station can't be reached, or has nothing to show
        case standBy(String) // learning durations before the clock can run
        case onAir
        case offAir(Channel.OffAir, String) // outside scheduled hours, with the resume line
        case noPrograms
    }

    struct Notice: Equatable {
        var number: Int
        var name: String
        var detail: String?
    }

    private(set) var screen: Screen = .connecting
    private(set) var dial: [Channel] = []
    private(set) var index = 0
    /// True while static (or black) covers a channel change.
    private(set) var covering = false
    private(set) var poweredOn = true
    /// The on-screen display: shown on every tune, gone after a moment.
    private(set) var notice: Notice?
    private(set) var clockMode: ClockMode = .twelveHour

    let engine: ChannelEngine
    var current: Channel? { dial.indices.contains(index) ? dial[index] : nil }

    @ObservationIgnored private let client: StationClient
    @ObservationIgnored private var tuner = TunerConfig()
    @ObservationIgnored private var libraries: [Int: Library] = [:] // last good listing per channel
    @ObservationIgnored private var tuneTask: Task<Void, Never>?
    @ObservationIgnored private var noticeTask: Task<Void, Never>?
    @ObservationIgnored private var flipTask: Task<Void, Never>?
    @ObservationIgnored private var suspended = false

    private static let lastChannelKey = "lastChannel"

    init(client: StationClient) {
        self.client = client
        engine = ChannelEngine(client: client)
    }

    var stationHost: String { client.baseURL.host() ?? client.baseURL.absoluteString }

    // MARK: - Boot

    func boot() async {
        log("boot")
        screen = .connecting
        do {
            let cfg = try await client.config().config
            tuner = cfg.tuner
            clockMode = cfg.timeFormat
            dial = cfg.dial.filter { $0.type == .video }
            guard !dial.isEmpty else {
                screen = .trouble("NO VIDEO CHANNELS ON THE DIAL YET. ADD ONE IN THE CONTROL ROOM AT \(stationHost)/config")
                return
            }
            let last = UserDefaults.standard.object(forKey: Self.lastChannelKey) as? Int
            log("last channel \(String(describing: last)), dial \(dial.map(\.number))")
            tune(to: dial.firstIndex { $0.number == last } ?? 0)
        } catch {
            screen = .trouble("CAN'T REACH THE STATION AT \(stationHost). \(error.localizedDescription.uppercased())")
        }
    }

    // MARK: - Commands

    func channelUp() { step(+1) }
    func channelDown() { step(-1) }

    private func step(_ dir: Int) {
        guard poweredOn, !dial.isEmpty else { return }
        tune(to: Dial.nextChannelIndex(count: dial.count, from: index, dir: dir, wrap: tuner.wrap))
    }

    func tune(to i: Int) {
        guard dial.indices.contains(i) else { return }
        index = i
        UserDefaults.standard.set(dial[i].number, forKey: Self.lastChannelKey)
        showNotice()
        let (before, after) = coverTiming
        tuneTask?.cancel()
        log("tune CH \(dial[i].number)")
        tuneTask = Task {
            covering = before > 0
            engine.stop()
            try? await Task.sleep(for: .milliseconds(before))
            guard !Task.isCancelled else { return }
            let t0 = Date()
            await air(dial[i])
            log("CH \(dial[i].number) \(screen) after \(String(format: "%.2f", -t0.timeIntervalSinceNow))s")
            try? await Task.sleep(for: .milliseconds(after))
            guard !Task.isCancelled else { return }
            covering = false
        }
    }

    /// Select on the remote: the channel again, with what's on.
    func showInfo() {
        guard poweredOn, let ch = current else { return }
        let program = Dial.programAt(ch, library: libraries[ch.number], at: Date())
        showNotice(detail: program?.title)
    }

    func togglePower() {
        poweredOn.toggle()
        if poweredOn {
            suspended = false
            tune(to: index) // the clock kept running: back to the program in progress
        } else {
            suspend()
        }
    }

    /// Off the air while the app is in the background; the clock does the rest on return.
    func suspend() {
        suspended = true
        tuneTask?.cancel()
        flipTask?.cancel()
        engine.stop()
        covering = false
    }

    func resume() {
        guard suspended else { return } // launching is .active too; boot() tunes then
        suspended = false
        guard poweredOn, !dial.isEmpty else { return }
        log("resume")
        tune(to: index)
    }

    // MARK: - Putting a channel on the air

    private func air(_ ch: Channel) async {
        flipTask?.cancel()
        let state = Dial.airState(ch, at: Date())
        if let until = state.until { scheduleFlip(at: until) }
        guard state.onAir else {
            screen = .offAir(ch.offAir, state.resumeText)
            return
        }

        // The folder is the truth and it changes, so every tune re-reads it.
        // The last good listing only covers a blip while the server restarts.
        var lib: Library
        do {
            let t0 = Date()
            lib = try await client.channels().libraries[ch.number] ?? Library(files: [])
            log("listing in \(String(format: "%.2f", -t0.timeIntervalSinceNow))s")
        } catch {
            guard !Task.isCancelled else { return }
            guard let cached = libraries[ch.number] else {
                screen = .trouble("CAN'T REACH THE STATION AT \(stationHost)")
                return
            }
            lib = cached
        }
        guard !Task.isCancelled else { return }

        lib = await learnDurations(ch, lib)
        guard !Task.isCancelled else { return }
        libraries[ch.number] = lib
        guard !lib.files.isEmpty else {
            screen = .noPrograms
            return
        }
        screen = .onAir
        engine.start(ch, library: lib)
    }

    /// The clock can only run when every length is known. Measure the ones
    /// the server doesn't have yet and post them back so its cache fills.
    /// A file that can't be measured can't be played here either, so it
    /// sits out of this set's timeline until it can be.
    private func learnDurations(_ ch: Channel, _ lib: Library) async -> Library {
        let missing = lib.files.filter { $0.duration == nil } + lib.spots.filter { $0.duration == nil }
        guard !missing.isEmpty else { return lib }
        screen = .standBy("PLEASE STAND BY\nMEASURING \(missing.count) \(missing.count == 1 ? "PROGRAM" : "PROGRAMS")")
        let learned = await DurationProbe.probe(missing.map { client.mediaURL($0.url) })

        func fill(_ files: [MediaFile], folder: String?) -> [MediaFile] {
            var report: [String: Double] = [:]
            let out = files.map { f -> MediaFile in
                guard f.duration == nil, let d = learned[client.mediaURL(f.url)] else { return f }
                report[f.file] = d
                var g = f
                g.duration = d
                return g
            }
            if let folder, !report.isEmpty {
                let client = client
                Task.detached { try? await client.postDurations(folder: folder, durations: report) }
            }
            for f in out where f.duration == nil { print("[cable-tv] can't read \(f.url); leaving it out") }
            return out.filter { $0.duration != nil }
        }
        return Library(files: fill(lib.files, folder: ch.folder), spots: fill(lib.spots, folder: ch.breaks?.folder))
    }

    /// A scheduled channel comes on or goes off at an exact time; retune then.
    private func scheduleFlip(at date: Date) {
        let tuned = index
        flipTask = Task {
            try? await Task.sleep(for: .seconds(max(date.timeIntervalSinceNow, 1) + 0.5))
            guard !Task.isCancelled, poweredOn, index == tuned else { return }
            tune(to: tuned)
        }
    }

    // MARK: - The on-screen display

    private func showNotice(detail: String? = nil) {
        guard let ch = current else { return }
        notice = Notice(number: ch.number, name: ch.name, detail: detail)
        noticeTask?.cancel()
        noticeTask = Task {
            try? await Task.sleep(for: .milliseconds(2600))
            guard !Task.isCancelled else { return }
            notice = nil
        }
    }

    /// Milliseconds of cover before the swap, and after it so the new
    /// channel has its first frame up (tuner.js's CUT_TIMING).
    private var coverTiming: (Int, Int) {
        switch tuner.cut {
        case .static: (220, 120)
        case .black: (300, 200)
        case .none: (0, 0)
        }
    }

    var coverIsStatic: Bool { tuner.cut == .static }

    private func log(_ message: String) {
        #if DEBUG
        print("[tuner] \(message)")
        #endif
    }
    var powerIsCRT: Bool { tuner.power == .crt }
}
