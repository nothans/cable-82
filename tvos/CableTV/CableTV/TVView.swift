import CableCore
import SwiftUI
import UIKit

/// The set. Up and down on the remote change channel, Select shows what's
/// on, Play/Pause is the power switch, and holding Select opens settings.
/// Menu is left to the system, so it leaves the app, as tvOS expects.
struct TVView: View {
    let onChangeServer: () -> Void

    @State private var tuner: Tuner
    @State private var showingSettings = false
    @FocusState private var focused: Bool
    @Environment(\.scenePhase) private var scenePhase

    init(server: URL, onChangeServer: @escaping () -> Void) {
        self.onChangeServer = onChangeServer
        _tuner = State(initialValue: Tuner(client: StationClient(baseURL: server)))
    }

    var body: some View {
        ZStack {
            Color.black
            picture
                .modifier(PowerEffect(on: tuner.poweredOn, crt: tuner.powerIsCRT))
        }
        .ignoresSafeArea()
        .focusable()
        .focusEffectDisabled()
        .focused($focused)
        .onMoveCommand { direction in
            switch direction {
            case .up: tuner.channelUp()
            case .down: tuner.channelDown()
            default: break
            }
        }
        .onPlayPauseCommand { tuner.togglePower() }
        .onLongPressGesture(minimumDuration: 1) { showingSettings = true }
        .onTapGesture { tuner.showInfo() }
        .confirmationDialog("Settings", isPresented: $showingSettings) {
            Button("Change station (\(tuner.stationHost))", action: onChangeServer)
            Button("Reconnect") { Task { await tuner.boot() } }
            Button("Cancel", role: .cancel) {}
        }
        .onAppear {
            focused = true
            UIApplication.shared.isIdleTimerDisabled = true // a TV doesn't doze off
        }
        .onDisappear {
            tuner.suspend()
            UIApplication.shared.isIdleTimerDisabled = false
        }
        .task { await tuner.boot() }
        .onChange(of: scenePhase) { _, phase in
            switch phase {
            case .background: tuner.suspend()
            case .active: tuner.resume()
            default: break
            }
        }
    }

    private var picture: some View {
        ZStack {
            PlayerSurfaceView(surface: tuner.engine.surface)
                .opacity(tuner.screen == .onAir ? 1 : 0)
            screenCard
            if tuner.screen == .onAir, tuner.engine.trouble != nil {
                StandByCard(text: "TECHNICAL DIFFICULTIES\nPLEASE STAND BY")
            }
            if tuner.covering {
                if tuner.coverIsStatic { StaticView() } else { Color.black }
            }
            if let notice = tuner.notice {
                OnScreenDisplay(notice: notice)
            }
        }
    }

    @ViewBuilder private var screenCard: some View {
        switch tuner.screen {
        case .connecting:
            StandByCard(text: "TUNING IN\n\(tuner.stationHost)")
        case let .trouble(text):
            StandByCard(text: text + "\n\nHOLD SELECT FOR SETTINGS")
        case let .standBy(text):
            StandByCard(text: text)
        case .noPrograms:
            TestCard(channel: tuner.current, text: "NO PROGRAMMING AVAILABLE", clockMode: tuner.clockMode)
        case let .offAir(mode, text):
            switch mode {
            case .snow: StaticView()
            case .bars: ColorBars()
            case .testcard, .bulletin: // .bulletin shows the board instead, unless it's missing
                TestCard(channel: tuner.current, text: text, clockMode: tuner.clockMode)
            }
        case .board:
            if let board = tuner.board { BoardView(board: board, clockMode: tuner.clockMode) }
        case .guide:
            GuideView(preview: tuner.preview, clockMode: tuner.clockMode, lineup: tuner.lineup,
                      listings: tuner.listings, refresh: tuner.refreshListings)
        case .onAir:
            EmptyView()
        }
    }
}

/// Hosts the engine's two-layer player view in SwiftUI.
struct PlayerSurfaceView: UIViewRepresentable {
    let surface: PlayerSurface
    func makeUIView(context: Context) -> PlayerSurface { surface }
    func updateUIView(_ uiView: PlayerSurface, context: Context) {}
}

/// Switching off like a tube: the picture folds into a bright line, the line
/// pulls in to a dot, and the phosphor fades. On is the reverse, quicker.
/// Timings are tuner.js's POWER_FX.
struct PowerEffect: ViewModifier {
    let on: Bool
    let crt: Bool

    @State private var sx: CGFloat = 1
    @State private var sy: CGFloat = 1
    @State private var glow: Double = 0
    @State private var alpha: Double = 1

    func body(content: Content) -> some View {
        content
            .scaleEffect(x: sx, y: sy)
            .brightness(glow)
            .opacity(alpha)
            .onChange(of: on) { _, isOn in isOn ? warmUp() : switchOff() }
    }

    private let line: CGFloat = 0.004

    private func switchOff() {
        guard crt else { alpha = 0; return }
        withAnimation(.easeIn(duration: 0.17)) { sy = line; glow = 0.6 } completion: {
            withAnimation(.easeIn(duration: 0.175)) { sx = line } completion: {
                withAnimation(.easeOut(duration: 0.38)) { alpha = 0 }
            }
        }
    }

    private func warmUp() {
        guard crt else { sx = 1; sy = 1; glow = 0; alpha = 1; return }
        sx = line; sy = line; glow = 0.6; alpha = 1
        withAnimation(.easeOut(duration: 0.09)) { sx = 1 } completion: {
            withAnimation(.easeOut(duration: 0.19)) { sy = 1; glow = 0 }
        }
    }
}
