// swift-tools-version: 5.9
import PackageDescription

let package = Package(
    name: "TomverseMobileAuth",
    platforms: [.iOS(.v15)],
    products: [.library(name: "TomverseMobileAuth", targets: ["TomverseMobileAuth"])],
    dependencies: [.package(url: "https://github.com/ionic-team/capacitor-swift-pm.git", from: "8.5.2")],
    targets: [.target(name: "TomverseMobileAuth", dependencies: [.product(name: "Capacitor", package: "capacitor-swift-pm")], path: "ios/Sources/MobileAuth")]
)
