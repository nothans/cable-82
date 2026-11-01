//
//  CableTVApp.swift
//  CableTV
//
//  Created by Dale Martin on 9/25/26.
//

import AVFoundation
import SwiftUI

@main
struct CableTVApp: App {
    init() {
        // Tell the system this is video playback, so audio routes and
        // behaves the way it does for other TV apps.
        try? AVAudioSession.sharedInstance().setCategory(.playback, mode: .moviePlayback)
    }

    var body: some Scene {
        WindowGroup {
            ContentView()
        }
    }
}
