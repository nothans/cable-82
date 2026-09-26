// swift-tools-version: 6.0
// CableCore: the platform-independent heart of the tvOS port. The broadcast
// clock, the channel models, and the server API types live here with no UI
// and no AVFoundation, so they build and test on macOS with `swift test`,
// with no simulator involved.
import PackageDescription

let package = Package(
    name: "CableCore",
    platforms: [.macOS(.v14), .tvOS(.v17)],
    products: [
        .library(name: "CableCore", targets: ["CableCore"]),
    ],
    targets: [
        .target(name: "CableCore"),
        .testTarget(
            name: "CableCoreTests",
            dependencies: ["CableCore"],
            resources: [.copy("Reference")]
        ),
    ]
)
