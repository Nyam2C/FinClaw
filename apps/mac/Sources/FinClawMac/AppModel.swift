import AppKit
import FinClawMacCore
import Observation
import SwiftUI

/// 화면 상태 정본. 클라이언트 이벤트 → reduce, 0.5s tick, 사용자 액션.
@MainActor @Observable final class AppModel {
  private(set) var state = CharacterState(now: .now)
  var hovering = false; var expanded = false; var inputOpen = false; var hidden = false; var input = ""
  var tab = PanelTab.chat; var history: [HistoryLine] = []; var detail: String?  // 브리핑 전문 (U2)
  var alerts: [AlertRow] = []; var alertError: String?
  @ObservationIgnored weak var panel: CharacterPanel?
  @ObservationIgnored private var client: GatewayClient!  // init 안에서 self 캡처 때문에 지연 대입
  @ObservationIgnored private var timer: Timer?

  init() {
    client = GatewayClient(url: Settings.gatewayURL, tokenURL: Settings.tokenURL) { [weak self] in self?.apply(.client($0)) }
    state.proactiveEnabled = UserDefaults.standard.object(forKey: "proactiveEnabled") as? Bool ?? true  // S9 기본 켜짐
    client.start()
    timer = Timer.scheduledTimer(withTimeInterval: 0.5, repeats: true) { [weak self] _ in
      MainActor.assumeIsolated { if let self { self.apply(.tick(holdBubble: self.hovering || self.expanded)) } }
    }
  }

  func apply(_ e: CharacterEvent) {
    if case .client(.server(let ev)) = e { notify(ev) }  // 리듀서 큐·토글과 무관하게 항상 (P2·P6)
    var s = state
    CharacterReducer.reduce(&s, e, now: .now)
    guard s != state else { return }  // tick 마다 뷰를 다시 그리지 않게
    let old = state; state = s
    if old.mood != .happy, s.mood == .happy, case .answer(let t, _)? = s.bubble {  // B9: end 첫 문장 1회
      announce(String(t.prefix { !".?!\n".contains($0) }), high: false)
    }
    if case .proactive(let p, _)? = s.bubble, p.key != Self.key(old.bubble) {  // 새 proactive 1회
      announce("\(p.title). \(p.body)", high: p.kind == .alert)
      if !hidden { panel?.orderFrontRegardless() }  // P1: makeKey 금지
    }
  }

  private static func key(_ b: Bubble?) -> String? { if case .proactive(let p, _)? = b { p.key } else { nil } }

  private func notify(_ ev: ServerEvent) {
    switch ev {
    case .alertTriggered(let a): Notifier.post(id: a.alertId, title: Copy.alertTitle(a.name), body: a.message, active: true)
    case .scheduleCompleted(let c):
      Notifier.post(
        id: c.scheduleId, title: Copy.briefingTitle(c.name),
        body: c.error == nil ? Copy.firstLines(c.output, 6) : Copy.briefingFailed(c.name), active: false)
    default: break
    }
  }

  private func announce(_ text: String, high: Bool) {
    var s = AttributedString(text)
    if high { s.accessibilitySpeechAnnouncementPriority = .high }
    AccessibilityNotification.Announcement(s).post()
  }

  func send() {  // D4: run 중엔 뷰가 입력을 잠근다
    let msg = input.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !msg.isEmpty, state.runId == nil else { return }
    input = ""; panel?.resignKey()
    let id = UUID().uuidString.lowercased()
    apply(.sent(runId: id))  // §2-3: RPC 전에
    Task { do { try await client.send(msg, runId: id) } catch { apply(.requestFailed) } }
  }

  func abort() { if let id = state.runId { Task { try? await client.abort(runId: id) } } }
  func reset() { Task { do { try await client.reset(); apply(.notice(Copy.resetDone)) } catch { apply(.requestFailed) } } }
  func reconnect() { client.reconnect() }
  func setProactive(_ on: Bool) { UserDefaults.standard.set(on, forKey: "proactiveEnabled"); apply(.setProactive(on)) }
  /// B8: 캐릭터 탭 → 입력창 + key. proactive 표시에는 쓰지 않는다 (P1).
  func openInput() { inputOpen = true; panel?.makeKey() }
  func closeInput() { inputOpen = false; apply(.inputFocused(false)); panel?.resignKey() }
  func collapse() { expanded = false; detail = nil }
  func toggleHidden() {
    hidden.toggle()
    if hidden { panel?.orderOut(nil) } else { panel?.orderFrontRegardless() }
  }

  /// "자세히 ▸": 브리핑이면 전문, 답이면 대화 탭.
  func more() {
    if case .proactive(let p, _)? = state.bubble { detail = p.detail } else { tab = .chat }
    expand()
  }

  func expand() {
    expanded = true
    if tab == .alerts { listAlerts() }
    guard let sid = client.sessionId else { return }
    Task {  // limit 생략 = 서버 기본 20
      if let r = try? await client.call("chat.history", ["sessionId": sid], as: [String: [HistoryLine]].self) { history = r["messages"] ?? [] }
    }
  }

  /// B6 "설명 물어보기": 입력창 프리필만, 전송은 사용자가 (M2·P7).
  func explain() {
    guard case .proactive(let p, _)? = state.bubble else { return }
    input = "이 알림 설명해줘: \(p.body)"; openInput()
  }

  func deleteShownAlert() {
    guard case .proactive(let p, _)? = state.bubble, p.kind == .alert else { return }
    apply(.dismiss); deleteAlert(p.key)
  }

  func listAlerts() { alertCall {} }
  func createAlert(_ a: AlertCreate) { alertCall { _ = try await self.client.call("finance.alert.create", a, as: Ack.self) } }
  func deleteAlert(_ id: String) { alertCall { _ = try await self.client.call("finance.alert.delete", ["alertId": id], as: Ack.self) } }

  /// 만들기·삭제 뒤 목록 재조회. 실패는 폼에, 접힌 상태면 말풍선 안내로.
  private func alertCall(_ work: @escaping @MainActor () async throws -> Void) {
    Task {
      do {
        try await work()
        alerts = try await client.call("finance.alert.list", [String: String](), as: [String: [AlertRow]].self)["alerts"] ?? []
        alertError = nil
      } catch {
        let r = error as? RpcError
        let msg = r?.message.hasPrefix("provider_unavailable") == true ? Copy.alertsUnavailable : r?.message ?? Copy.requestFailed
        alertError = msg; if !expanded { apply(.notice(msg)) }
      }
    }
  }
}

private struct Ack: Decodable {}
