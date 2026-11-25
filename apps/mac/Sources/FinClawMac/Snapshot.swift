import AppKit
import FinClawMacCore
import SwiftUI

/// `--snapshot <dir>` (D3·G8): 샘플 상태 → ImageRenderer(scale 2) → PNG. 한 장에 밝은/어두운 데스크톱 배경을 병치.
@MainActor enum Snapshot {
  static let t0 = Date(timeIntervalSinceReferenceDate: 1000)  // 고정 시각 — 깜빡임 밖, 입 열림 구간 (+0.06)

  // 샘플 문구는 핀이 실제로 하는 일만 — 지어낸 시세·뉴스 수치를 쓰지 않는다 (시스템 프롬프트 원칙 2·3)
  static let longAnswer = [
    "제가 할 수 있는 일을 정리했어요.",
    "1. **시세** 조회 — 주식·암호화폐·환율 (시세 API 키 필요)",
    "2. **차트** 데이터 조회",
    "3. **뉴스** 검색·요약 (뉴스 API 키 필요)",
    "4. 뉴스를 모은 시장 분석",
    "5. 포트폴리오 손익 계산",
    "6. 등록된 알림 목록과 발동 기록 확인",
    "7. 지금 날짜·시각 확인",
    "8. 수치에는 출처와 기준 시각을 함께 적어요",
    "9. 사고팔지는 판단하지 않아요",
  ].joined(separator: "\n")
  static let shortAnswer = "지금은 **오전 9시 30분**이에요(서울 기준)."
  static let alertBody = "AAPL 현재가 210이(가) 목표가 200 이상 조건을 충족했습니다."  // conditions/price.ts 문구 형식
  static let priceAlert = Proactive(
    kind: .alert, key: "a1", title: Copy.alertTitle("AAPL price_above"), body: alertBody, detail: nil)
  static let briefingText = [
    "알림 2개를 확인했어요(알림 목록 조회, 09:00 기준).",
    "- AAPL 이상 200: 지난 24시간 발동 없음",
    "- 005930 뉴스 '실적': 지난 24시간 발동 없음",
    "- 발동 기록은 알림 기록 조회로 확인했어요",
    "- 시세는 넣지 않았어요(시세 API 키 없음)",
    "- 새 알림은 '알림' 탭에서 만들 수 있어요",
    "- 이 브리핑은 조회만 했어요",
  ].joined(separator: "\n")
  static let briefing = Proactive(
    kind: .briefing, key: "s1", title: Copy.briefingTitle("아침 브리핑"), body: Copy.firstLines(briefingText, 6),
    detail: briefingText)
  static let chat = [
    HistoryLine(role: "user", text: "지금 몇 시야?"),
    HistoryLine(role: "assistant", text: shortAnswer),
    HistoryLine(role: "user", text: "AAPL 200 넘으면 알려줘"),
    HistoryLine(role: "assistant", text: "알림은 제가 직접 만들 수 없어요. '알림' 탭에서 AAPL · 이상 · 200 으로 만들어 주세요."),
  ]

  static func run(to dir: URL) {
    try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
    let later = t0 + 60
    let working = Bubble.answer(text: "AAPL 시세를 확인해 볼게요.", closesAt: nil)
    let alertTwice = Proactive(
      kind: .alert, key: "a1", title: priceAlert.title, body: alertBody, detail: nil, count: 2)
    let scenes: [(String, CharacterState, Double)] = [
      ("mood-offline", sample(.offline), 0.06),
      ("mood-idle", sample(.idle), 0.06),
      ("mood-listening", sample(.listening), 0.06),
      ("mood-thinking-run", sample(.thinking, .answer(text: "", closesAt: nil), run: true), 0.06),
      ("mood-working-tool-label", sample(.working, working, tool: Copy.toolLabel("route_task"), run: true), 0.06),
      ("mood-talking-streaming", sample(.talking, .answer(text: "지금은 오전 9시", closesAt: nil), run: true), 0.06),
      ("mood-happy-short-answer", sample(.happy, .answer(text: shortAnswer, closesAt: later)), 0.06),
      ("mood-alert-price", sample(.alert, .proactive(priceAlert, closesAt: later)), 0.15),
      ("mood-error", sample(.error, .error(Copy.reason("rate_limit"), closesAt: later)), 0.06),
      ("bubble-answer-long-clamped", sample(.happy, .answer(text: longAnswer, closesAt: later)), 0.06),
      ("bubble-offline-notice", sample(.offline, .notice(Copy.offline(.serverDown), closesAt: .distantFuture)), 0.06),
      ("bubble-alert-x2-badge", sample(.alert, .proactive(alertTwice, closesAt: later), queue: [briefing]), 1.5),
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
        history: chat, streaming: nil, detail: nil, tab: .constant(tab), onCollapse: {}, onCloseDetail: {},
        alerts: form, scrolls: false)
      png(panel, dir.appending(path: tab == .chat ? "panel-chat-history.png" : "panel-alerts-form.png"))
    }
  }

  static func sample(
    _ mood: Mood, _ bubble: Bubble? = nil, tool: String? = nil, run: Bool = false, queue: [Proactive] = []
  ) -> CharacterState {
    var s = CharacterState(now: t0)
    s.mood = mood
    s.bubble = bubble
    s.toolLabel = tool
    s.runId = run ? "run-1" : nil
    s.queue = queue
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
