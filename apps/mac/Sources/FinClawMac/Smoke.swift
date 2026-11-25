import FinClawMacCore
import Foundation

/// 헤드리스 스모크 (plan §8-2). 화면·NSApplication 없음. 토큰·sessionId 미출력.
@MainActor enum Smoke {
  private static var online = false, lastOffline = OfflineReason.serverDown  // 10s 감시 Task 와 공유
  static func run(question: String, listen: Double) async -> Int32 {
    var deltas = 0, chars = 0
    let runId = UUID().uuidString.lowercased()
    let (stream, cont) = AsyncStream<ClientEvent>.makeStream()
    let client = GatewayClient(url: Settings.gatewayURL, tokenURL: Settings.tokenURL) { cont.yield($0) }
    print("connecting \(Settings.gatewayURL.absoluteString)")
    Task {
      try? await Task.sleep(for: .seconds(10))
      if !online { print("offline \(lastOffline)"); exit(2) }
    }
    Task { try? await Task.sleep(for: .seconds(330)); print("timeout"); exit(3) }
    client.start()
    for await ev in stream {
      switch ev {
      case .connected where !online:
        online = true
        print("connected")
        print("sent run=\(runId)")
        Task {
          do { try await client.send(question, runId: runId) } catch { print("send failed"); exit(1) }
        }
      case .disconnected(let r):
        lastOffline = r
        if online { print("offline \(r)") }
      case .server(.tool(runId, _, let name, let phase, let isError)):
        let short = name.components(separatedBy: "__").last ?? name
        print(phase == .start ? "tool start \(short)" : "tool end \(short) error=\(isError)")
      case .server(.delta(runId, let t)):
        deltas += 1
        chars += t.count
      case .server(.end(runId, let text)):
        print("delta x\(deltas) chars=\(chars)")
        print("end chars=\(text.count) text=\"\(text.prefix(120))\"")
        guard listen > 0 else { return 0 }
        Task { try? await Task.sleep(for: .seconds(listen)); exit(0) }
      case .server(.runError(runId, let reason)):
        print("reason=\(reason)")
        return 1
      case .server(.alertTriggered(let a)):
        print("event alert.triggered alertId=\(a.alertId) title=\"\(Copy.alertTitle(a.name))\"")
      case .server(.scheduleCompleted(let c)):
        print("event schedule.completed scheduleId=\(c.scheduleId) error=\(c.error != nil)")
      default: break
      }
    }
    return 0
  }
}
