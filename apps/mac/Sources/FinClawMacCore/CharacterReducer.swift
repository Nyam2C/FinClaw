import Foundation

public enum Mood: String, CaseIterable, Sendable { case offline, idle, listening, thinking, working, talking, happy, alert, error }

public struct Proactive: Equatable, Sendable {
  public enum Kind: Sendable { case alert, briefing }
  public let kind: Kind
  public let key: String  // alertId | scheduleId — 병합 키
  public let title: String  // Copy.alertTitle(name) (D6) | "브리핑 · {name}"
  public var body: String  // 서버 결정적 문자열: alert message / output 앞 6줄 / error 면 Copy.briefingFailed(name)
  public var detail: String?  // 브리핑 output 전문 (U2). alert 는 nil
  public var count = 1
  public init(kind: Kind, key: String, title: String, body: String, detail: String?, count: Int = 1) {
    (self.kind, self.key, self.title, self.body, self.detail, self.count) = (kind, key, title, body, detail, count)
  }
}

public enum Bubble: Equatable, Sendable {
  case answer(text: String, closesAt: Date?)  // 스트리밍 중 nil
  case proactive(Proactive, closesAt: Date)
  case notice(String, closesAt: Date)  // 연결·유실·reset 안내 (클라이언트 고정 문구)
  case error(String, closesAt: Date)

  public var closesAt: Date? {
    switch self {
    case .answer(_, let c): c
    case .proactive(_, let c), .notice(_, let c), .error(_, let c): c
    }
  }
}

/// [TQ4f] 진행 중 도구 — 순서 배열이라 "남은 것 중 최근 것" 이 정해진다.
public struct ToolRun: Equatable, Sendable {
  public let id, label: String
  public init(id: String, label: String) { (self.id, self.label) = (id, label) }
}

public struct CharacterState: Equatable, Sendable {
  public var mood: Mood = .offline
  public var moodSince: Date
  public var runId: String?
  public var activeTools: [ToolRun] = []  // 문구 nil 인 도구는 넣지 않음
  public var toolLabel: String?
  public var bubble: Bubble?
  public var queue: [Proactive] = []
  public var lastDeltaAt: Date?
  public var offlineSince: Date?
  public var offlineReason: OfflineReason?
  public var lostRun = false  // run 도중 끊김
  public var inputFocused = false
  public var proactiveEnabled = true  // 메뉴바 "먼저 말 걸기"
  public init(now: Date) { moodSince = now }
}

public enum CharacterEvent: Equatable, Sendable {
  case client(ClientEvent)
  case sent(runId: String)  // chat.send RPC **전에**
  case requestFailed  // chat.send 등 RPC 실패
  case inputFocused(Bool)
  case dismiss  // 말풍선 닫기 · 배지 클릭(다음 큐) 공용
  case setProactive(Bool)
  case notice(String)  // 3s 안내 (예: reset 완료)
  case tick(holdBubble: Bool)  // 0.5s. holdBubble = 호버 중이거나 패널 펼침 → 말풍선 닫힘만 보류
}

/// plan §4-2 전이 표 (+ TQ4 a~f).
public enum CharacterReducer {
  static let happyHold: TimeInterval = 1.2, offlineDelay: TimeInterval = 10, noticeSecs: TimeInterval = 3
  static let lostRunSecs: TimeInterval = 8, errorSecs: TimeInterval = 5
  static let alertSecs: TimeInterval = 60, briefingSecs: TimeInterval = 30

  public static func reduce(_ s: inout CharacterState, _ e: CharacterEvent, now: Date) {
    let before = s.mood
    defer { if s.mood != before { s.moodSince = now } }
    switch e {
    case .client(.connecting), .client(.disconnected), .client(.server(.shutdown)):
      if s.runId != nil { s.lostRun = true }
      clearRun(&s)
      if s.offlineSince == nil { s.offlineSince = now }
      if case .client(.disconnected(let r)) = e { s.offlineReason = r }
      if case .client(.server(.shutdown)) = e { s.offlineReason = .shutdown }
      if case .answer? = s.bubble { s.bubble = nil }
      s.mood = .offline
    case .client(.connected):
      guard s.mood == .offline else { return }
      let long = s.offlineSince.map { now.timeIntervalSince($0) > offlineDelay } ?? false
      s.mood = .idle; s.offlineSince = nil; s.bubble = nil
      if s.lostRun { s.lostRun = false; s.bubble = .notice(Copy.lostRun, closesAt: now + lostRunSecs) }
      else if long { s.bubble = .notice(Copy.reconnected, closesAt: now + noticeSecs) }
    case .client(.server(let ev)): server(&s, ev, now)
    case .sent(let id):
      clearRun(&s)
      s.runId = id; s.mood = .thinking; s.bubble = .answer(text: "", closesAt: nil); s.lastDeltaAt = nil
    case .requestFailed: fail(&s, Copy.requestFailed, now)
    case .inputFocused(let b):
      s.inputFocused = b
      if b, s.mood == .idle { s.mood = .listening } else if !b, s.mood == .listening { s.mood = .idle }
    case .dismiss:
      guard s.runId == nil else { return }  // [TQ4c] 중지 버튼이 정식 경로
      s.bubble = nil; showNextOrIdle(&s, now)
    case .setProactive(let b):
      s.proactiveEnabled = b
      if b, s.mood == .idle, s.bubble == nil { showNextOrIdle(&s, now) }
    case .notice(let msg):
      guard s.mood != .offline else { return }
      switch s.bubble { case .answer?, .proactive?: return; default: s.bubble = .notice(msg, closesAt: now + noticeSecs) }
    case .tick(let hold):
      if s.mood == .happy, now.timeIntervalSince(s.moodSince) >= happyHold { s.mood = .talking }
      if !hold, let c = s.bubble?.closesAt, now >= c { s.bubble = nil; showNextOrIdle(&s, now) }  // [TQ4d]
      if s.mood == .offline, s.bubble == nil, let since = s.offlineSince, now.timeIntervalSince(since) >= offlineDelay {
        s.bubble = .notice(Copy.offline(s.offlineReason ?? .serverDown), closesAt: .distantFuture)
      }
    }
  }

  static func server(_ s: inout CharacterState, _ ev: ServerEvent, _ now: Date) {
    switch ev {
    case .alertTriggered(let a):
      proactive(&s, Proactive(kind: .alert, key: a.alertId, title: Copy.alertTitle(a.name), body: a.message, detail: nil), now)
    case .scheduleCompleted(let c):
      let failed = c.error != nil
      let p = Proactive(
        kind: .briefing, key: c.scheduleId, title: Copy.briefingTitle(c.name),
        body: failed ? Copy.briefingFailed(c.name) : Copy.firstLines(c.output, 6), detail: failed ? nil : c.output)
      proactive(&s, p, now)
    case .shutdown: break  // reduce 앞단에서 처리
    case .delta(let id, let text):
      guard id == s.runId else { return }
      if case .answer(let t, _)? = s.bubble { s.bubble = .answer(text: t + text, closesAt: nil) }
      else { s.bubble = .answer(text: text, closesAt: nil) }
      s.lastDeltaAt = now
      if s.mood != .working { s.mood = .talking }
    case .tool(let id, let callId, let name, let phase, _):  // isError 는 표정에 쓰지 않는다 (회귀 ①)
      guard id == s.runId else { return }
      if phase == .start {
        guard let label = Copy.toolLabel(name) else { return }  // get_current_datetime: 아무 일 없음
        s.activeTools.append(ToolRun(id: callId, label: label)); s.toolLabel = label; s.mood = .working
      } else {
        guard let i = s.activeTools.firstIndex(where: { $0.id == callId }) else { return }  // [TQ4e]
        s.activeTools.remove(at: i); s.toolLabel = s.activeTools.last?.label  // [TQ4f]
        s.mood = s.activeTools.isEmpty ? .thinking : .working
      }
    case .end(let id, let text):
      guard id == s.runId else { return }
      clearRun(&s)
      s.bubble = .answer(text: text, closesAt: now + min(max(4 + Double(text.count) / 8, 6), 25))  // U5
      s.mood = .happy
    case .runError(let id, let reason):
      guard id == s.runId else { return }
      if reason == "aborted" { clearRun(&s); s.bubble = nil; showNextOrIdle(&s, now) }  // error 를 거치지 않음 [TQ4b]
      else { fail(&s, Copy.reason(reason), now) }
    }
  }

  static func proactive(_ s: inout CharacterState, _ p: Proactive, _ now: Date) {
    if let i = s.queue.firstIndex(where: { $0.key == p.key }) { merge(&s.queue[i], p); return }
    if case .proactive(var cur, let c)? = s.bubble, cur.key == p.key {
      merge(&cur, p); s.bubble = .proactive(cur, closesAt: c); return
    }
    let busy: Bool = switch s.bubble { case .answer?, .error?, .proactive?: true; default: false }  // [TQ4a]
    if s.runId != nil || s.mood == .listening || busy || !s.proactiveEnabled { s.queue.append(p); return }
    show(&s, p, now)
  }

  static func merge(_ cur: inout Proactive, _ new: Proactive) { cur.count += 1; cur.body = new.body; cur.detail = new.detail }

  static func show(_ s: inout CharacterState, _ p: Proactive, _ now: Date) {
    s.bubble = .proactive(p, closesAt: now + (p.kind == .alert ? alertSecs : briefingSecs)); s.mood = .alert
  }

  /// [TQ4b·d] aborted·dismiss·tick 닫힘·setProactive(true) 공용. offline 이면 mood 를 바꾸지 않는다.
  static func showNextOrIdle(_ s: inout CharacterState, _ now: Date) {
    guard s.mood != .offline else { return }
    if s.proactiveEnabled, !s.queue.isEmpty { show(&s, s.queue.removeFirst(), now) } else { s.mood = .idle }
  }

  static func clearRun(_ s: inout CharacterState) { s.runId = nil; s.activeTools = []; s.toolLabel = nil }

  static func fail(_ s: inout CharacterState, _ msg: String, _ now: Date) {
    clearRun(&s); s.bubble = .error(msg, closesAt: now + errorSecs); s.mood = .error
  }
}
