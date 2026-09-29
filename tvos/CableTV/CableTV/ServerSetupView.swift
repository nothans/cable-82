import CableCore
import SwiftUI

/// Type in the station's address, and check that it answers before keeping it.
struct ServerSetupView: View {
    let initial: String
    let onConnect: (URL) -> Void

    @State private var text = ""
    @State private var status: String?
    @State private var busy = false

    var body: some View {
        ZStack {
            Palette.blue.ignoresSafeArea()
            VStack(spacing: 40) {
                Text("CONNECT TO YOUR STATION")
                    .font(.cable(64))
                Text("THE ADDRESS YOUR CABLE 82 SERVER PRINTS WHEN IT STARTS,\nLIKE 192.168.1.42:1982")
                    .font(.cable(30))
                    .multilineTextAlignment(.center)
                TextField("192.168.1.42:1982", text: $text)
                    .keyboardType(.URL)
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled()
                    .frame(width: 900)
                    .onSubmit(connect)
                Button(busy ? "CONNECTING…" : "CONNECT", action: connect)
                    .disabled(busy)
                if let status {
                    Text(status.uppercased())
                        .font(.cable(28))
                        .foregroundStyle(Palette.yellow)
                        .multilineTextAlignment(.center)
                        .frame(maxWidth: 1400)
                }
            }
            .foregroundStyle(.white)
        }
        .onAppear {
            if text.isEmpty, let host = URL(string: initial)?.host(), let port = URL(string: initial)?.port {
                text = "\(host):\(port)"
            }
        }
    }

    private func connect() {
        guard let url = ServerAddress.parse(text) else {
            status = "That doesn't look like an address."
            return
        }
        busy = true
        status = nil
        Task {
            defer { busy = false }
            do {
                _ = try await StationClient(baseURL: url).config()
                onConnect(url)
            } catch {
                // The first try can fail while tvOS is still asking for
                // local-network permission; the second one works.
                status = "No answer from \(url.host() ?? "there"): \(error.localizedDescription)"
            }
        }
    }
}
