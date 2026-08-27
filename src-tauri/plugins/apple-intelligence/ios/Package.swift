// swift-tools-version:5.9
// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Zyra Project

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
