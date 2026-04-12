// swift-tools-version:5.9
import PackageDescription

let package = Package(
    name: "tauri-plugin-apple-intelligence",
    platforms: [
        .iOS(.v17) // Minimum deployment; Foundation Models requires iOS 26+ at runtime
    ],
    products: [
        .library(
            name: "tauri-plugin-apple-intelligence",
            targets: ["TauriPluginAppleIntelligence"]
        )
    ],
    dependencies: [
        .package(name: "Tauri", path: "../.tauri/tauri-api")
    ],
    targets: [
        .target(
            name: "TauriPluginAppleIntelligence",
            dependencies: [
                .product(name: "Tauri", package: "Tauri")
            ],
            path: "Sources"
        )
    ]
)
