import UserNotifications

/// P2 시스템 알림. 번들 없는 실행 파일(swift run·스모크·스냅샷)에서는 아무것도 안 한다 (번들 없이 current() 가 크래시).
/// 권한은 첫 게시 때(= 첫 proactive 수신) 한 번만 묻는다 — 앱 시작 시 묻지 않는다.
@MainActor enum Notifier {
  static var enabled: Bool { Bundle.main.bundleIdentifier != nil }
  private static var asked = false

  /// id = alertId | scheduleId → 같은 id 는 교체 게시 (P3)
  static func post(id: String, title: String, body: String, active: Bool) {
    guard enabled else { return }
    let center = UNUserNotificationCenter.current()
    if !asked {
      asked = true
      center.requestAuthorization(options: [.alert, .sound]) { _, _ in }
    }
    let c = UNMutableNotificationContent()
    c.title = title
    c.body = body  // 본문 = 서버 결정적 문자열 (M2)
    // 가격·뉴스 .active + 기본 사운드, 브리핑 .passive (U4)
    c.interruptionLevel = active ? .active : .passive
    if active { c.sound = .default }
    center.add(UNNotificationRequest(identifier: id, content: c, trigger: nil))
  }
}
