import FinClawMacCore
import Foundation

@main enum Entry {
  static func main() {
    let args = CommandLine.arguments
    if let i = args.firstIndex(of: "--smoke"), i + 1 < args.count {
      let listen = args.firstIndex(of: "--listen").flatMap { $0 + 1 < args.count ? Double(args[$0 + 1]) : nil } ?? 0
      setvbuf(stdout, nil, _IOLBF, 0)  // 파이프로 볼 때 줄 단위 출력 (--listen 중 실시간 확인)
      Task { @MainActor in exit(await Smoke.run(question: args[i + 1], listen: listen)) }
      dispatchMain()
    }
    // M7: --snapshot 분기 + FinClawMacApp.main()
    FileHandle.standardError.write(Data("usage: FinClawMac --smoke \"<질문>\" [--listen <초>]\n".utf8))
    exit(64)
  }
}

/// D1 — 인자 도메인 덕에 `-gatewayURL`·`-tokenPath` 와 `defaults write` 둘 다 먹는다.
enum Settings {
  static var gatewayURL: URL {
    UserDefaults.standard.string(forKey: "gatewayURL").flatMap(URL.init(string:)) ?? URL(string: "ws://127.0.0.1:3000/")!
  }
  static var tokenURL: URL {
    let path = UserDefaults.standard.string(forKey: "tokenPath") ?? "~/.finclaw/gateway.token"
    return URL(fileURLWithPath: NSString(string: path).expandingTildeInPath)
  }
}
