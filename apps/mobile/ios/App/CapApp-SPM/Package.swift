// swift-tools-version: 5.9
import PackageDescription

// DO NOT MODIFY THIS FILE - managed by Capacitor CLI commands
let package = Package(
    name: "CapApp-SPM",
    platforms: [.iOS(.v17)],
    products: [
        .library(
            name: "CapApp-SPM",
            targets: ["CapApp-SPM"])
    ],
    dependencies: [
        .package(url: "https://github.com/ionic-team/capacitor-swift-pm.git", exact: "8.5.3"),
        .package(name: "TomverseMobileAuth", path: "../../../native-auth"),
        .package(name: "RevenuecatPurchasesCapacitor", path: "../../../../../node_modules/@revenuecat/purchases-capacitor"),
        .package(name: "CapacitorBrowser", path: "../../../../../node_modules/@capacitor/browser"),
        .package(name: "CapacitorGeolocation", path: "../../../../../node_modules/@capacitor/geolocation")
    ],
    targets: [
        .target(
            name: "CapApp-SPM",
            dependencies: [
                .product(name: "Capacitor", package: "capacitor-swift-pm"),
                .product(name: "Cordova", package: "capacitor-swift-pm"),
                .product(name: "TomverseMobileAuth", package: "TomverseMobileAuth"),
                .product(name: "RevenuecatPurchasesCapacitor", package: "RevenuecatPurchasesCapacitor"),
                .product(name: "CapacitorBrowser", package: "CapacitorBrowser"),
                .product(name: "CapacitorGeolocation", package: "CapacitorGeolocation")
            ]
        )
    ]
)
