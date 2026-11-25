// swift-tools-version: 6.0
import PackageDescription

let package = Package(
  name: "FinClawMac",
  platforms: [.macOS(.v14)],
  targets: [
    .target(name: "FinClawMacCore"),
    .executableTarget(name: "FinClawMac", dependencies: ["FinClawMacCore"]),
    .testTarget(
      name: "FinClawMacCoreTests", dependencies: ["FinClawMacCore"],
      resources: [.copy("Fixtures")]),
  ]
)
