import AppKit
import FinClawMacCore
import Observation
import SwiftUI

/// 화면 상태 정본. 클라이언트 이벤트 → reduce, 0.5s tick, 사용자 액션.
@MainActor @Observable final class AppModel {
  private(set) var state = CharacterState(now: .now)
  var hovering = false
  var expanded = false
  var inputOpen = false
  var hidden = false
  var input = ""
  @ObservationIgnored weak var panel: CharacterPanel?
  @ObservationIgnored private var client: GatewayClient!  // init 안에서 self 캡처 때문에 지연 대입
  @ObservationIgnored private var timer: Timer?

  init() {
    client = GatewayClient(url: Settings.gatewayURL, tokenURL: Settings.tokenURL) { [weak self] ev in
      self?.apply(.client(ev))
    }
    state.proactiveEnabled = UserDefaults.standard.object(forKey: "proactiveEnabled") as? Bool ?? true  // S9 기본 켜짐
    client.start()
    timer = Timer.scheduledTimer(withTimeInterval: 0.5, repeats: true) { [weak self] _ in
      MainActor.assumeIsolated {
        guard let self else { return }
        self.apply(.tick(holdBubble: self.hovering || self.expanded))
      }
    }
  }

  func apply(_ e: CharacterEvent) {
    var s = state
    CharacterReducer.reduce(&s, e, now: .now)
    guard s != state else { return }  // tick 마다 뷰를 다시 그리지 않게
    let old = state
    state = s
    if old.mood != .happy, s.mood == .happy, case .answer(let t, _)? = s.bubble {  // B9: end 첫 문장 1회
      announce(String(t.prefix { !".?!\n".contains($0) }), high: false)
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
    input = ""
    panel?.resignKey()
    let id = UUID().uuidString.lowercased()
    apply(.sent(runId: id))  // §2-3: RPC 전에
    Task {
      do { try await client.send(msg, runId: id) } catch { apply(.requestFailed) }
    }
  }

  func abort() {
    guard let id = state.runId else { return }
    Task { try? await client.abort(runId: id) }
  }

  func reset() {
    Task {
      do { try await client.reset(); apply(.notice(Copy.resetDone)) } catch { apply(.requestFailed) }
    }
  }

  func reconnect() { client.reconnect() }

  func setProactive(_ on: Bool) {
    UserDefaults.standard.set(on, forKey: "proactiveEnabled")
    apply(.setProactive(on))
  }

  /// B8: 캐릭터 탭 → 입력창 + key. proactive 표시에는 쓰지 않는다 (P1).
  func openInput() {
    inputOpen = true
    panel?.makeKey()
  }

  func closeInput() {
    inputOpen = false
    apply(.inputFocused(false))
    panel?.resignKey()
  }

  func toggleHidden() {
    hidden.toggle()
    if hidden { panel?.orderOut(nil) } else { panel?.orderFrontRegardless() }
  }
}
