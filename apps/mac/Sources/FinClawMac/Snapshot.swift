import AppKit
import FinClawMacCore
import SwiftUI

/// `--snapshot <dir>` (D3·G8): 샘플 상태 → ImageRenderer(scale 2) → PNG. 한 장에 밝은/어두운 데스크톱 배경을 병치.
@MainActor enum Snapshot {
  static let t0 = Date(timeIntervalSinceReferenceDate: 1000)  // 고정 시각 — 깜빡임 밖, 입 열림 구간 (+0.06)
  static let longAnswer = (1...10).map { "\($0). **삼성전자** 외국인 순매수 \($0 * 120)억 원, 기관은 관망했어요." }
    .joined(separator: "\n")
  static let priceAlert = Proactive(
    kind: .alert, key: "alert-1", title: Copy.alertTitle("AAPL price_above"),
    body: "AAPL 현재가 210이(가) 목표가 200 이상 조건을 충족했습니다.", detail: nil)

  static func run(to dir: URL) {
    try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
    let later = t0 + 60
    let scenes: [(String, CharacterState, Double)] = [
      ("mood-offline", sample(.offline), 0.06),
      ("mood-idle", sample(.idle), 0.06),
      ("mood-listening", sample(.listening), 0.06),
      ("mood-thinking-run", sample(.thinking, .answer(text: "", closesAt: nil), run: true), 0.06),
      ("mood-working-tool-label", sample(.working, .answer(text: "AAPL 시세를", closesAt: nil), tool: "알아보는 중…", run: true), 0.06),
      ("mood-talking-streaming", sample(.talking, .answer(text: "지금 **AAPL** 은 210달러예요.", closesAt: nil), run: true), 0.06),
      ("mood-happy-short-answer", sample(.happy, .answer(text: "지금 **AAPL** 은 210달러예요.", closesAt: later)), 0.06),
      ("mood-alert-price", sample(.alert, .proactive(priceAlert, closesAt: later)), 0.15),
      ("mood-error", sample(.error, .error(Copy.reason("rate_limit"), closesAt: later)), 0.06),
      ("bubble-answer-long-clamped", sample(.happy, .answer(text: longAnswer, closesAt: later)), 0.06),
      ("bubble-offline-notice", sample(.offline, .notice(Copy.offline(.serverDown), closesAt: .distantFuture)), 0.06),
    ]
    for (name, s, offset) in scenes { png(pin(s, at: t0 + offset), dir.appending(path: "\(name).png")) }
  }

  static func sample(
    _ mood: Mood, _ bubble: Bubble? = nil, tool: String? = nil, run: Bool = false, queue: [Proactive] = []
  ) -> CharacterState {
    var s = CharacterState(now: t0)
    (s.mood, s.bubble, s.toolLabel, s.runId, s.queue) = (mood, bubble, tool, run ? "run-1" : nil, queue)
    return s
  }

  static func pin(_ state: CharacterState, at now: Date) -> some View {
    var s = state
    s.lastDeltaAt = now  // talking 입 열림
    return VStack(alignment: .trailing, spacing: 6) {
      if let b = s.bubble { BubbleView(bubble: b, running: s.runId != nil, toolLabel: s.toolLabel) }
      CharacterView(state: s, frozenAt: now)
    }
  }

  static func png(_ view: some View, _ url: URL) {
    let pair = HStack(alignment: .bottom, spacing: 0) {
      view.padding(12).background(Color(white: 0.9)).environment(\.colorScheme, .light)
      view.padding(12).background(Color(white: 0.2)).environment(\.colorScheme, .dark)
    }
    let r = ImageRenderer(content: pair)
    r.scale = 2
    guard let tiff = r.nsImage?.tiffRepresentation, let rep = NSBitmapImageRep(data: tiff),
      let data = rep.representation(using: .png, properties: [:])
    else { return print("render failed \(url.lastPathComponent)") }
    try? data.write(to: url)
  }
}
