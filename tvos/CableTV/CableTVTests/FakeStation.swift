import AVFoundation
import CableCore
import CoreVideo
import Foundation

/// A station made of files: `api/config`, `api/channels` and the rest are
/// JSON files in a temporary folder, and the channels' videos are short
/// clips written on the spot. StationClient reads a `file:` base URL the way
/// it reads the server, so the tuner and the engine run unchanged against it.
final class FakeStation {
    let root: URL
    var client: StationClient { StationClient(baseURL: root) }

    init() throws {
        root = FileManager.default.temporaryDirectory
            .appending(path: "station-\(UUID().uuidString)", directoryHint: .isDirectory)
        try FileManager.default.createDirectory(at: root.appending(path: "api"), withIntermediateDirectories: true)
    }

    deinit { try? FileManager.default.removeItem(at: root) }

    func write(_ path: String, _ text: String) throws {
        let url = root.appending(path: path)
        try FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
        try Data(text.utf8).write(to: url)
    }

    func remove(_ path: String) throws { try FileManager.default.removeItem(at: root.appending(path: path)) }

    /// `count` clips of about `seconds` each in `folder`, listed with the
    /// lengths AVFoundation measures for them.
    func clips(_ folder: String, count: Int, seconds: Double) async throws -> [MediaFile] {
        var out: [MediaFile] = []
        for i in 1...count {
            let name = "clip\(i).mp4"
            let url = root.appending(path: "\(folder)/\(name)")
            try FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
            try await Self.writeClip(url, frames: Int(seconds * 30), shade: UInt8(40 * i % 255))
            let duration = try await AVURLAsset(url: url).load(.duration).seconds
            out.append(MediaFile(file: name, url: "\(folder)/\(name)", duration: duration))
        }
        return out
    }

    /// A file that claims to be a video and isn't: what a truncated copy looks like.
    func brokenClip(_ folder: String, _ name: String, listedAs duration: Double) throws -> MediaFile {
        try write("\(folder)/\(name)", String(repeating: "not a movie ", count: 500))
        return MediaFile(file: name, url: "\(folder)/\(name)", duration: duration)
    }

    /// The channels listing for `api/channels`.
    func list(_ listings: [(number: Int, folder: String, files: [MediaFile])]) throws {
        let channels = listings.map { l in
            ["number": l.number, "folder": l.folder,
             "files": l.files.map { ["file": $0.file, "url": $0.url, "duration": $0.duration as Any? ?? NSNull()] }] as [String: Any]
        }
        let data = try JSONSerialization.data(withJSONObject: ["channels": channels])
        try write("api/channels", String(decoding: data, as: UTF8.self))
    }

    /// A tiny H.264 clip: 64x48, one flat shade, 30 frames a second.
    static func writeClip(_ url: URL, frames: Int, shade: UInt8) async throws {
        try? FileManager.default.removeItem(at: url)
        let (w, h) = (64, 48)
        let writer = try AVAssetWriter(outputURL: url, fileType: .mp4)
        let input = AVAssetWriterInput(mediaType: .video, outputSettings: [
            AVVideoCodecKey: AVVideoCodecType.h264, AVVideoWidthKey: w, AVVideoHeightKey: h,
        ])
        input.expectsMediaDataInRealTime = false
        let adaptor = AVAssetWriterInputPixelBufferAdaptor(assetWriterInput: input, sourcePixelBufferAttributes: [
            kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_32BGRA,
            kCVPixelBufferWidthKey as String: w, kCVPixelBufferHeightKey as String: h,
        ])
        writer.add(input)
        guard writer.startWriting() else { throw writer.error ?? CocoaError(.fileWriteUnknown) }
        writer.startSession(atSourceTime: .zero)
        for i in 0..<frames {
            while !input.isReadyForMoreMediaData { try await Task.sleep(for: .milliseconds(2)) }
            var buffer: CVPixelBuffer?
            CVPixelBufferCreate(nil, w, h, kCVPixelFormatType_32BGRA, nil, &buffer)
            guard let buffer else { throw CocoaError(.fileWriteUnknown) }
            CVPixelBufferLockBaseAddress(buffer, [])
            memset(CVPixelBufferGetBaseAddress(buffer), Int32(shade), CVPixelBufferGetDataSize(buffer))
            CVPixelBufferUnlockBaseAddress(buffer, [])
            adaptor.append(buffer, withPresentationTime: CMTime(value: CMTimeValue(i), timescale: 30))
        }
        input.markAsFinished()
        writer.endSession(atSourceTime: CMTime(value: CMTimeValue(frames), timescale: 30))
        await writer.finishWriting()
        guard writer.status == .completed else { throw writer.error ?? CocoaError(.fileWriteUnknown) }
    }
}

/// Poll `condition` until it holds or `seconds` pass; true when it held.
func eventually(within seconds: Double, every ms: Int = 20, _ condition: () -> Bool) async -> Bool {
    let deadline = Date().addingTimeInterval(seconds)
    while Date() < deadline {
        if condition() { return true }
        try? await Task.sleep(for: .milliseconds(ms))
    }
    return condition()
}
