import CableCore
import SwiftUI
import UIKit

/// cable-82's broadcast-safe palette (config-schema.js PALETTE).
enum Palette {
    static let blue = Color(hex: 0x2038C8)
    static let yellow = Color(hex: 0xC8A020)
    static let white = Color(hex: 0xF0F0EC)
}

extension Color {
    init(hex: UInt32) {
        self.init(red: Double(hex >> 16 & 0xFF) / 255, green: Double(hex >> 8 & 0xFF) / 255, blue: Double(hex & 0xFF) / 255)
    }
}

extension Font {
    /// Chunky and monospaced, standing in for the IBM VGA face for now.
    static func cable(_ size: CGFloat) -> Font { .system(size: size, weight: .heavy, design: .monospaced) }
}

/// Everything is composed on a 4:3 stage centered on the 16:9 screen, as
/// the original is on its virtual 640x480. tvOS lays out at 1920x1080 points.
struct Stage<Content: View>: View {
    @ViewBuilder var content: Content
    var body: some View {
        content.frame(width: 1440, height: 1080).clipped()
    }
}

/// Tuner static: a few frames of noise, drawn once and flipped through.
struct StaticView: View {
    private static let frames: [UIImage] = (0..<6).map { _ in noise(width: 160, height: 120) }

    var body: some View {
        TimelineView(.animation(minimumInterval: 1 / 30)) { ctx in
            let i = Int(ctx.date.timeIntervalSinceReferenceDate * 30) % Self.frames.count
            Image(uiImage: Self.frames[i])
                .resizable()
                .interpolation(.none)
        }
    }

    private static func noise(width: Int, height: Int) -> UIImage {
        var bytes = (0..<width * height).map { _ in UInt8.random(in: 0...255) }
        let ctx = bytes.withUnsafeMutableBytes { buf in
            CGContext(data: buf.baseAddress, width: width, height: height, bitsPerComponent: 8,
                      bytesPerRow: width, space: CGColorSpaceCreateDeviceGray(), bitmapInfo: CGImageAlphaInfo.none.rawValue)
        }
        return UIImage(cgImage: ctx!.makeImage()!)
    }
}

/// The blue card for words: standing by, trouble, measuring.
struct StandByCard: View {
    let text: String
    var body: some View {
        ZStack {
            Palette.blue
            Text(text)
                .font(.cable(48))
                .foregroundStyle(Palette.white)
                .multilineTextAlignment(.center)
                .padding(80)
        }
    }
}

/// SMPTE-style 75% bars.
struct ColorBars: View {
    private static let bars: [UInt32] = [0xBFBFBF, 0xBFBF00, 0x00BFBF, 0x00BF00, 0xBF00BF, 0xBF0000, 0x0000BF]
    var body: some View {
        HStack(spacing: 0) {
            ForEach(Self.bars, id: \.self) { Color(hex: $0) }
        }
    }
}

/// Off the air: bars, the channel, the time, and when programming resumes.
struct TestCard: View {
    let channel: Channel?
    let text: String
    let clockMode: ClockMode

    var body: some View {
        ZStack {
            Color.black
            Stage {
                VStack(spacing: 0) {
                    ColorBars().frame(height: 620)
                    VStack(spacing: 28) {
                        if let channel {
                            Text("CH \(channel.number)  \(channel.name)")
                        }
                        TimelineView(.periodic(from: .now, by: 1)) { ctx in
                            Text(Dial.formatClock(ctx.date, clockMode))
                        }
                        Text(text).foregroundStyle(Palette.yellow)
                    }
                    .font(.cable(52))
                    .foregroundStyle(Palette.white)
                    .multilineTextAlignment(.center)
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
                    .background(Color.black)
                }
            }
        }
    }
}

/// The on-screen display a cable box drew: the channel on a dark plate,
/// centered in the upper part of the picture.
struct OnScreenDisplay: View {
    let notice: Tuner.Notice
    var body: some View {
        Stage {
            VStack {
                VStack(spacing: 10) {
                    Text("CH \(notice.number)").font(.cable(96))
                    if !notice.name.isEmpty { Text(notice.name).font(.cable(40)) }
                    if let detail = notice.detail { Text(detail).font(.cable(34)).foregroundStyle(Palette.yellow) }
                }
                .foregroundStyle(Palette.white)
                .multilineTextAlignment(.center)
                .padding(.horizontal, 48)
                .padding(.vertical, 28)
                .background(Color.black.opacity(0.72))
                .padding(.top, 120)
                Spacer()
            }
        }
        .allowsHitTesting(false)
    }
}
