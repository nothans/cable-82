import CableCore
import SwiftUI

/// Channel 82 on screen, after cable-82's index.html and style.css: the
/// header band with the station bug and the clock, a full-color page that
/// hard-cuts every few seconds, and the crawl along the bottom behind its flag.
struct BoardView: View {
    let board: BulletinBoard
    let clockMode: ClockMode

    private var cfg: BoardConfig { board.config }
    private var crt: Bool { cfg.crtMode }
    // style.css's overscan margins (7%) and sizes, scaled from 640x480 to our 1440x1080.
    private let ovx: CGFloat = 100, ovy: CGFloat = 76, rule: CGFloat = 7

    var body: some View {
        ZStack {
            Color.black
            Stage {
                VStack(spacing: 0) {
                    header.fixedSize(horizontal: false, vertical: true)
                    Rectangle().fill(Palette.white).frame(height: rule)
                    page.frame(maxWidth: .infinity, maxHeight: .infinity)
                    Rectangle().fill(Palette.white).frame(height: rule)
                    crawl.fixedSize(horizontal: false, vertical: true)
                }
                .textCase(.uppercase) // the whole board is capitals, as style.css has it
                .background(Color(hex: BoardColors.resolve("ink", fallback: "ink", crt: crt)))
            }
        }
    }

    // MARK: - Header band

    private var header: some View {
        let bg = cfg.colors.headerBg
        return HStack(alignment: .bottom) {
            VStack(alignment: .leading, spacing: 18) {
                // The station bug: an inverted solid box, the way a local
                // channel stamped its logo in the corner.
                Text(cfg.channelName)
                    .font(.cable(72))
                    .tracking(4.5)
                    .foregroundStyle(Color(hex: BoardColors.resolve(bg, fallback: "blue", crt: crt)))
                    .padding(.horizontal, 22).padding(.top, 7).padding(.bottom, 2)
                    .background(Color(hex: BoardColors.textColor(on: bg, crt: crt)))
                Text(cfg.tagline).font(.cable(36)).dropShadow(!crt)
            }
            Spacer(minLength: 36)
            TimelineView(.periodic(from: .now, by: 1)) { ctx in
                VStack(alignment: .trailing, spacing: 13) {
                    Text(Dial.formatClock(ctx.date, clockMode)).font(.cable(72))
                    Text(Dial.formatHeaderDate(ctx.date)).font(.cable(36))
                }
                .dropShadow(!crt)
            }
        }
        .lineLimit(1)
        .foregroundStyle(Color(hex: BoardColors.textColor(on: bg, crt: crt)))
        .padding(.horizontal, ovx).padding(.top, ovy).padding(.bottom, 22)
        .background(Color(hex: BoardColors.resolve(bg, fallback: "blue", crt: crt)))
    }

    // MARK: - The page

    @ViewBuilder private var page: some View {
        switch board.page {
        case let .clock(bg):
            TimelineView(.periodic(from: .now, by: 1)) { ctx in
                VStack(spacing: 45) {
                    Text(Dial.formatClock(ctx.date, clockMode)).font(.cable(144))
                    Text(Dial.formatLongDate(ctx.date)).font(.cable(72))
                }
                .minimumScaleFactor(0.5)
                .paged(bg, cfg)
            }
        case let .text(kicker, text, bg):
            let big = text.count <= 34
            VStack(spacing: 45) {
                Kicker(text: kicker)
                Text(text)
                    .font(.cable(big ? 108 : 72))
                    .lineSpacing(big ? 27 : 25)
                    .lineLimit(big ? 4 : 5)
                    .minimumScaleFactor(0.5)
                    .dropShadow(!crt)
            }
            .paged(bg, cfg)
        case let .weather(w, bg):
            VStack(spacing: 31) {
                Kicker(text: "WEATHER")
                VStack(spacing: 18) {
                    Text(w.name ?? "").font(.cable(63))
                    Text("\(w.tempNow.map { "\(Int($0.rounded()))" } ?? "--")°\(w.tempUnit ?? "")").font(.cable(189))
                    Text(w.condition ?? "").font(.cable(72))
                    Text(hiLoWind(w)).font(.cable(58))
                    let sr = BoardText.weatherTime(w.sunrise, clockMode), ss = BoardText.weatherTime(w.sunset, clockMode)
                    if !sr.isEmpty, !ss.isEmpty {
                        Text("SUNRISE \(sr)   SUNSET \(ss)").font(.cable(40)).padding(.top, 9)
                    }
                }
                .lineLimit(1)
                .minimumScaleFactor(0.5)
                .dropShadow(!crt)
            }
            .paged(bg, cfg)
        }
    }

    private func hiLoWind(_ w: Weather) -> String {
        let n = { (v: Double) in "\(Int(v.rounded()))" }
        return [w.tempHi.map { "HI \(n($0))°" }, w.tempLo.map { "LO \(n($0))°" },
                w.wind.map { "WIND \(n($0)) \(w.windUnit ?? "")" }]
            .compactMap { $0 }.joined(separator: "   ")
    }

    // MARK: - The crawl

    private var crawl: some View {
        // CRT mode pins the crawl to a dark blue band whatever the config says.
        let bg = crt ? "#182858" : cfg.colors.crawlBg
        return HStack(spacing: 0) {
            if !cfg.crawl.flag.isEmpty {
                Text(cfg.crawl.flag)
                    .font(.cable(58))
                    .tracking(4.5)
                    .dropShadow(!crt)
                    .foregroundStyle(Palette.white)
                    .padding(.vertical, 22).padding(.trailing, 40).padding(.leading, 40 + ovx)
                    .frame(maxHeight: .infinity)
                    .background(Color(hex: BoardColors.resolve("red", fallback: "red", crt: crt)))
                Rectangle().fill(Palette.white).frame(width: rule)
            }
            Ticker(board: board, secondsPerScreen: cfg.crawl.secondsPerScreen, shadow: !crt)
                .foregroundStyle(Color(hex: BoardColors.textColor(on: bg, crt: crt)))
        }
        .fixedSize(horizontal: false, vertical: true)
        .padding(.bottom, ovy)
        .background(Color(hex: BoardColors.resolve(bg, fallback: "ink", crt: crt)))
    }
}

/// The black label above a page: COMMUNITY BULLETIN, DID YOU KNOW, WEATHER...
private struct Kicker: View {
    let text: String
    var body: some View {
        Text(text)
            .font(.cable(45))
            .tracking(4.5)
            .foregroundStyle(Palette.white)
            .padding(.horizontal, 40).padding(.top, 18).padding(.bottom, 13)
            .background(Color(hex: BoardColors.resolve("ink", fallback: "ink")))
    }
}

/// The scrolling ticker: one pass across the window, rebuilt from the latest
/// headlines at the start of every pass, a screenful every `secondsPerScreen`.
private struct Ticker: View {
    let board: BulletinBoard
    let secondsPerScreen: Double
    let shadow: Bool

    @State private var text = ""
    @State private var x: CGFloat = 2000
    @State private var textWidth: CGFloat = 0
    @State private var windowWidth: CGFloat = 0

    var body: some View {
        Color.clear
            .frame(height: 72 + 44)
            .overlay(alignment: .leading) {
                Text(text)
                    .font(.cable(72))
                    .lineLimit(1)
                    .fixedSize()
                    .dropShadow(shadow)
                    .onGeometryChange(for: CGFloat.self) { $0.size.width } action: { textWidth = $0 }
                    .offset(x: x)
            }
            .onGeometryChange(for: CGFloat.self) { $0.size.width } action: { windowWidth = $0 }
            .clipped()
            .task {
                while !Task.isCancelled {
                    text = board.crawlText()
                    try? await Task.sleep(for: .milliseconds(100)) // let it lay out and be measured
                    let win = max(windowWidth, 1), width = max(textWidth, 1)
                    var reset = Transaction()
                    reset.disablesAnimations = true
                    withTransaction(reset) { x = win }
                    try? await Task.sleep(for: .milliseconds(20))
                    let duration = max(1, (win + width) / win * secondsPerScreen)
                    withAnimation(.linear(duration: duration)) { x = -width }
                    try? await Task.sleep(for: .seconds(duration))
                }
            }
    }
}

private extension View {
    /// A full page of color: the background, and text that reads on it.
    func paged(_ bg: String, _ cfg: BoardConfig) -> some View {
        var ink = BoardColors.textColor(on: bg, crt: cfg.crtMode)
        // On some tubes white text smears; crtInkText trades it for ink.
        if cfg.crtMode && cfg.crtInkText && ink == BoardColors.paletteCRT["white"] { ink = BoardColors.paletteCRT["ink"]! }
        return self
            .multilineTextAlignment(.center)
            .foregroundStyle(Color(hex: ink))
            .modifier(FitToPage())
            .padding(.horizontal, 100).padding(.vertical, 36)
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            .background(Color(hex: BoardColors.resolve(bg, fallback: "blue", crt: cfg.crtMode)))
    }

    /// The hard, blurless down-and-right shadow a character generator drew.
    /// CRT mode drops it; a real tube needs no help.
    @ViewBuilder func dropShadow(_ on: Bool) -> some View {
        if on { shadow(color: Color(red: 8 / 255, green: 8 / 255, blue: 16 / 255, opacity: 0.7), radius: 0, x: 4.5, y: 4.5) }
        else { self }
    }
}

/// board.js fitPage(): content that would run taller than the page shrinks,
/// all of it together, just enough to fit. It never grows.
private struct FitToPage: ViewModifier {
    @State private var natural: CGFloat = 0

    func body(content: Content) -> some View {
        GeometryReader { geo in
            let scale = natural > geo.size.height && natural > 0 ? geo.size.height / natural : 1
            content
                .fixedSize(horizontal: false, vertical: true)
                .onGeometryChange(for: CGFloat.self) { $0.size.height } action: { natural = $0 }
                .scaleEffect(scale)
                .frame(width: geo.size.width, height: geo.size.height)
        }
    }
}

extension Color {
    /// "#2038C8" or "#fff".
    init(hex: String) {
        var h = String(hex.dropFirst())
        if h.count == 3 { h = h.map { "\($0)\($0)" }.joined() }
        self.init(hex: UInt32(h, radix: 16) ?? 0x2038C8)
    }
}
