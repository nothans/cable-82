//
//  ContentView.swift
//  CableTV
//
//  Created by Dale Martin on 9/25/26.
//

import SwiftUI

/// The root: the set when a station is known, the connect screen when not.
struct ContentView: View {
    @AppStorage("serverURL") private var serverURL = ""
    @State private var choosingServer = false

    var body: some View {
        if let url = URL(string: serverURL), !serverURL.isEmpty, !choosingServer {
            TVView(server: url) { choosingServer = true }
                .id(serverURL) // a new station is a new set
        } else {
            ServerSetupView(initial: serverURL) { url in
                serverURL = url.absoluteString
                choosingServer = false
            }
        }
    }
}
