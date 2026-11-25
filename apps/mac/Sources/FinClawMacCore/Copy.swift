import Foundation

/// 사용자 문구 전부 (plan §4-6). 느낌표·이모지 없음.
public enum Copy {
  /// 마지막 "__" 뒤로 조회 (`mcp__finclaw__route_task` → `route_task`). nil = 표시 안 함(working 진입 없음).
  public static func toolLabel(_ name: String) -> String? {
    switch name.components(separatedBy: "__").last ?? name {
    case "route_task": "알아보는 중…"
    case "list_alerts": "알림 목록 보는 중…"
    case "get_alert_history": "알림 기록 보는 중…"
    case "get_current_datetime": nil
    default: "도구 사용 중…"
    }
  }

  public static func reason(_ r: String) -> String {
    switch r {
    case "auth": "Claude 로그인이 필요해요. 서버에서 `claude login` 을 실행해 주세요"
    case "rate_limit": "Claude 사용 한도에 닿았어요. 잠시 후 다시 물어봐 주세요"
    case "timeout": "답이 너무 오래 걸려요. 질문을 나눠 주세요"
    default: "답을 만드는 중에 문제가 생겼어요"
    }
  }

  public static func offline(_ r: OfflineReason) -> String {
    switch r {
    case .serverDown: "서버가 꺼져 있어요 (`pnpm dev`)"
    case .noToken: "토큰 파일이 없어요. 서버를 한 번 실행해 주세요"
    case .badToken: "토큰이 맞지 않아요. 서버를 다시 시작해 주세요"
    case .shutdown: "서버가 종료됐어요. 다시 켜지면 연결할게요"
    }
  }

  /// D6: 알림 이름 "{SYMBOL} {condition}" 의 접미 → 제목
  public static func alertTitle(_ alertName: String) -> String {
    guard let space = alertName.lastIndex(of: " ") else { return "알림" }
    let symbol = alertName[..<space]
    switch alertName[alertName.index(after: space)...] {
    case "price_above", "price_below": return "\(symbol) 가격 알림"
    case "change_percent": return "\(symbol) 등락 알림"
    case "news_match": return "\(symbol) 뉴스 알림"
    default: return "알림"
    }
  }

  public static func briefingTitle(_ name: String) -> String { "브리핑 · \(name)" }
  public static func briefingFailed(_ name: String) -> String { "브리핑 '\(name)'을 만들지 못했어요" }
  public static func firstLines(_ s: String, _ n: Int) -> String {
    s.split(separator: "\n", omittingEmptySubsequences: false).prefix(n).joined(separator: "\n")
  }

  /// §4-1 접근성 라벨
  public static func accessibility(_ mood: Mood, toolLabel: String?, alertTitle: String?) -> String {
    switch mood {
    case .offline: "핀, 서버와 연결 끊김"
    case .idle, .happy: "핀, 대기 중"
    case .listening: "핀, 입력 듣는 중"
    case .thinking: "핀, 생각하는 중"
    case .working: "핀, \(toolLabel ?? "도구 사용 중…")"
    case .talking: "핀, 답하는 중"
    case .alert: alertTitle.map { "핀, 새 알림: \($0)" } ?? "핀, 새 알림"
    case .error: "핀, 문제가 생겼어요"
    }
  }

  public static let requestFailed = "요청을 보내지 못했어요. 잠시 후 다시 해 주세요"
  public static let reconnected = "다시 연결됐어요"
  public static let lostRun = "연결이 끊겨서 답을 못 받았어요. 자세히에서 확인해 주세요"
  public static let resetDone = "새 대화를 시작했어요"
  public static let alertsUnavailable = "알림 기능이 꺼져 있어요 — 시세·뉴스 API 키가 필요해요"
  public static let inputPlaceholder = "핀에게 물어보기"
}
