import AVFoundation

/// Learns file lengths the way video.js's probe does, but without playing
/// anything: AVURLAsset reads the duration from the file's header (one small
/// range request when the file was encoded with +faststart).
nonisolated enum DurationProbe {
    /// Seconds per URL, for the ones that answered. A file that hangs gives
    /// up after `timeout` so it can't stall the rest.
    static func probe(_ urls: [URL], concurrency: Int = 4, timeout: Double = 15) async -> [URL: Double] {
        await withTaskGroup(of: (URL, Double?).self) { group in
            var results: [URL: Double] = [:]
            var pending = urls[...]
            func addNext() {
                guard let url = pending.popFirst() else { return }
                group.addTask { (url, await duration(of: url, timeout: timeout)) }
            }
            for _ in 0..<concurrency { addNext() }
            for await (url, d) in group {
                if let d { results[url] = d }
                addNext()
            }
            return results
        }
    }

    private static func duration(of url: URL, timeout: Double) async -> Double? {
        await withTaskGroup(of: Double?.self) { group in
            group.addTask {
                guard let d = try? await AVURLAsset(url: url).load(.duration) else { return nil }
                let s = d.seconds
                return s.isFinite && s > 0 ? s : nil
            }
            group.addTask {
                try? await Task.sleep(for: .seconds(timeout))
                return nil
            }
            let first = await group.next() ?? nil
            group.cancelAll()
            return first
        }
    }
}
