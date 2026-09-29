import CableCore
import SwiftUI

/// Channel 0: CABLEVUE, a port of cable-82's guide.js. A masthead with the
/// clock, a grid of what's on every channel now and next, and the lineup
/// crawling up the screen when it's taller than the screen. It reads the same
/// broadcast clock the player does (Dial.guideGrid), so it can't disagree
/// with the picture.
struct GuideView: View {
    let preview: PreviewConfig
    let clockMode: ClockMode
    let lineup: [Channel]
    let listings: [Int: Library]
    /// Ask the station for fresh listings (new files, newly measured durations).
    let refresh: () async -> Void

    // Sizes are cable-82's style.css, scaled from its 640x480 stage to our 1440x1080.
    private let margin: CGFloat = 64
    private let channelColumn: CGFloat = 430
    private let gap: CGFloat = 7

    var body: some View {
        ZStack {
            Color.black
            Stage {
                VStack(spacing: 0) {
                    masthead
                    Rectangle().fill(Palette.white).frame(height: 7)
                    // The grid only changes when a half hour turns over or the
                    // listings change; once a minute is plenty.
                    TimelineView(.everyMinute) { ctx in
                        grid(Dial.guideGrid(lineup, libraries: listings, at: ctx.date, count: preview.slots))
                    }
                }
                .foregroundStyle(Palette.white)
                .background(Palette.named(preview.background))
            }
        }
        .task {
            await refresh()
            while !Task.isCancelled {
                try? await Task.sleep(for: .seconds(300))
                await refresh()
            }
        }
    }

    // MARK: - Masthead

    private var masthead: some View {
        HStack(alignment: .center) {
            VStack(alignment: .leading, spacing: 18) {
                // The wordmark with a ring cut around it, the way every guide
                // channel of the period drew an ellipse through its logo.
                Text(preview.name)
                    .font(.cable(76))
                    .tracking(4)
                    .padding(.vertical, 9)
                    .padding(.horizontal, 36)
                    .overlay {
                        Ellipse()
                            .stroke(Palette.white.opacity(0.85), lineWidth: 4.5)
                            .rotationEffect(.degrees(-7))
                    }
                if !preview.tagline.isEmpty {
                    Text(preview.tagline)
                        .font(.cable(30))
                        .tracking(7)
                        .foregroundStyle(Palette.yellow)
                        .padding(.leading, 9)
                }
            }
            .lineLimit(1)
            Spacer(minLength: 36)
            TimelineView(.periodic(from: .now, by: 1)) { ctx in
                Text(Dial.formatClock(ctx.date, clockMode, seconds: preview.seconds))
                    .font(.cable(60))
                    .tracking(2)
                    .monospacedDigit()
            }
        }
        .padding(.horizontal, margin)
        .padding(.top, 50)
        .padding(.bottom, 18)
    }

    // MARK: - Grid

    private func grid(_ g: GuideGrid) -> some View {
        GeometryReader { geo in
            let width = geo.size.width - margin * 2
            let slotWidth = (width - channelColumn - gap * CGFloat(g.slots.count)) / CGFloat(g.slots.count)
            VStack(spacing: 0) {
                // Column heads share the rows' columns so they line up.
                HStack(spacing: gap) {
                    Color.clear.frame(width: channelColumn, height: 1)
                    ForEach(g.slots, id: \.self) { slot in
                        Text(Dial.formatClock(slot, clockMode))
                            .frame(width: slotWidth)
                    }
                }
                .font(.cable(42))
                .foregroundStyle(Palette.yellow)
                .padding(.vertical, 16)

                Crawl(scrollSeconds: preview.scrollSeconds, gap: gap) {
                    ForEach(g.rows, id: \.number) { row in
                        GuideRowView(row: row, channelColumn: channelColumn, slotWidth: slotWidth, gap: gap)
                    }
                }
            }
            .padding(.horizontal, margin)
            .padding(.bottom, 44)
        }
    }
}

/// One channel's row: its number and name, then a cell per program, each as
/// wide as the half hours it runs across.
private struct GuideRowView: View {
    let row: GuideRow
    let channelColumn: CGFloat
    let slotWidth: CGFloat
    let gap: CGFloat

    var body: some View {
        HStack(alignment: .top, spacing: gap) {
            HStack(alignment: .firstTextBaseline, spacing: 22) {
                Text("\(row.number)")
                    .foregroundStyle(Palette.yellow)
                    .frame(width: 90, alignment: .trailing)
                    .layoutPriority(1) // a channel you can't name is still one you can tune
                Text(row.name)
                    .lineLimit(2)
            }
            .cell(width: channelColumn)
            ForEach(row.cells, id: \.slot) { cell in
                Text(cell.title)
                    .lineLimit(2)
                    .opacity(cell.kind == .offair || cell.kind == .unknown ? 0.62 : 1)
                    .cell(width: slotWidth * CGFloat(cell.span) + gap * CGFloat(cell.span - 1))
            }
        }
        .font(.cable(44))
        .fixedSize(horizontal: false, vertical: true) // every cell as tall as the row's tallest
    }
}

private extension View {
    func cell(width: CGFloat) -> some View {
        self
            .truncationMode(.tail)
            .padding(.vertical, 18)
            .padding(.horizontal, 22)
            .frame(width: width, alignment: .topLeading)
            .frame(minHeight: 90, maxHeight: .infinity, alignment: .topLeading)
            .background(Color.black.opacity(0.22))
    }
}

/// The lineup crawling up the screen when it's taller than the space for it:
/// drawn twice, so the loop has no seam, moving a screenful every `scrollSeconds`.
private struct Crawl<Content: View>: View {
    let scrollSeconds: Double
    let gap: CGFloat
    @ViewBuilder var content: Content

    @State private var contentHeight: CGFloat = 0

    var body: some View {
        GeometryReader { geo in
            let viewHeight = geo.size.height
            let crawling = contentHeight > viewHeight && viewHeight > 0
            let loop = contentHeight + gap
            TimelineView(.animation(paused: !crawling)) { ctx in
                let y = crawling
                    ? (ctx.date.timeIntervalSinceReferenceDate * viewHeight / scrollSeconds).truncatingRemainder(dividingBy: loop)
                    : 0
                VStack(spacing: gap) {
                    VStack(spacing: gap) { content }
                        .onGeometryChange(for: CGFloat.self) { $0.size.height } action: { contentHeight = $0 }
                    if crawling {
                        VStack(spacing: gap) { content }
                    }
                }
                .offset(y: -y.rounded()) // whole points, so text doesn't shimmer
            }
        }
        .clipped()
    }
}
