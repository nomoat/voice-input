// swift-tools-version: 6.0
import PackageDescription

let package = Package(
    name: "VoiceInput",
    platforms: [.iOS(.v17), .macOS(.v14)],
    products: [
        .library(name: "VoiceInputCore", targets: ["VoiceInputCore"]),
        .library(name: "VoiceInputUI", targets: ["VoiceInputUI"]),
    ],
    targets: [
        .target(name: "VoiceInputCore", path: "swift/Sources/VoiceInputCore"),
        .target(name: "VoiceInputUI", dependencies: ["VoiceInputCore"], path: "swift/Sources/VoiceInputUI"),
        .testTarget(name: "VoiceInputCoreTests", dependencies: ["VoiceInputCore"], path: "swift/Tests/VoiceInputCoreTests"),
    ]
)
