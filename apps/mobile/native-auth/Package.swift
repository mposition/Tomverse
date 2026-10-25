// swift-tools-version: 5.9
import PackageDescription

let package = Package(
    name: "TomverseMobileAuth",
    platforms: [.iOS(.v15)],
    products: [.library(name: "TomverseMobileAuth", targets: ["MobileAuthPlugin"])],
    dependencies: [.package(url: "https://github.com/ionic-team/capacitor-swift-pm.git", from: "8.0.0")],
    targets: [.target(name: "MobileAuthPlugin", dependencies: [
        .product(name: "Capacitor", package: "capacitor-swift-pm"),
        .product(name: "Cordova", package: "capacitor-swift-pm")
    ], path: "ios/Sources/MobileAuthPlugin")]
)
