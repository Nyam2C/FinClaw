import AppKit
import FinClawMacCore
import SwiftUI

/// `--snapshot <dir>` (D3·G8): 샘플 상태 → ImageRenderer(scale 2) → PNG. 한 장에 밝은/어두운 데스크톱 배경을 병치.
@MainActor enum Snapshot {
  static let t0 = Date(timeIntervalSinceReferenceDate: 1000)  // 고정 시각 — 깜빡임 밖, 입 열림 구간 (+0.06)
  static let longAnswer = (1...10).map { "\($0). **삼성전자** 외국인 순매수 \($0 * 120)억 원, 기관은 관망했어요." }.joined(separator: "\n")
  static let alertBody = "AAPL 현재가 210이(가) 목표가 200 이상 조건을 충족했습니다."  // conditions/price.ts 문구 형식
  static let priceAlert = Proactive(kind: .alert, key: "a1", title: Copy.alertTitle("AAPL price_above"), body: alertBody, detail: nil)
  static let briefingText = "오늘 보유 종목 요약이에요.\n- AAPL 210달러, 어제보다 1.2% 올랐어요\n- 삼성전자 7만 1천 원, 보합이에요\n- 환율 1,380원\n- 미국 CPI 발표는 내일 밤이에요\n- 실적 발표 예정 없음\n- 출처: 시세 API"
  static let briefing = Proactive(
    kind: .briefing, key: "sched-1", title: Copy.briefingTitle("아침 브리핑"), body: Copy.firstLines(briefingText, 6),
    detail: briefingText)
  static let chat = [
    HistoryLine(role: "user", text: "AAPL 지금 얼마야?"), HistoryLine(role: "assistant", text: "지금 **AAPL** 은 210달러예요."),
    HistoryLine(role: "user", text: "200 넘으면 알려줘"), HistoryLine(role: "assistant", text: "AAPL 이 200달러 이상이면 알려드릴게요."),
  ]

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
      ("bubble-alert-x2-badge", sample(.alert, .proactive(Proactive(kind: .alert, key: "a1", title: priceAlert.title, body: alertBody, detail: nil, count: 2), closesAt: later), queue: [briefing]), 1.5),
      ("bubble-briefing", sample(.alert, .proactive(briefing, closesAt: later)), 1.5),
    ]
    for (name, s, offset) in scenes { png(pin(s, at: t0 + offset), dir.appending(path: "\(name).png")) }
    let rows = [
      AlertRow(id: "a1", symbol: "AAPL", condition: "price_above", threshold: 200, keyword: nil),
      AlertRow(id: "a2", symbol: "005930", condition: "news_match", threshold: nil, keyword: "실적"),
    ]
    let form = AlertFormView(rows: rows, error: nil, onCreate: { _ in }, onDelete: { _ in })
    for tab in [PanelTab.chat, .alerts] {
      let panel = ChatPanelView(
        history: chat, streaming: nil, detail: nil, tab: .constant(tab), onCollapse: {}, onCloseDetail: {}, alerts: form,
        scrolls: false)
      png(panel, dir.appending(path: tab == .chat ? "panel-chat-history.png" : "panel-alerts-form.png"))
    }
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
