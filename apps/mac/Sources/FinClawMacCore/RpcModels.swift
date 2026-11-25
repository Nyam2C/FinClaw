import Foundation

// RPC 요청·응답 모델 — 서버 핸들러(packages/gateway/src/rpc/methods/{chat,finance}.ts)의 반환 shape 그대로.
// 응답은 항상 명시적 struct 로 디코드한다 (키별 dictionary 디코드는 숫자 필드 하나에도 깨진다).

/// chat.history → `{messages: [{role, text}]}`
public struct HistoryLine: Codable, Hashable, Sendable {
  public let role: String
  public let text: String
  public init(role: String, text: String) {
    self.role = role
    self.text = text
  }
}

public struct ChatHistory: Decodable, Sendable {
  public let messages: [HistoryLine]
}

/// finance.alert.list 의 한 행. 서버는 enabled·cooldownMs·createdAt·triggerCount 도 보내지만 쓰지 않는다.
public struct AlertRow: Decodable, Identifiable, Sendable {
  public let id: String
  public let symbol: String
  public let condition: String
  public let threshold: Double?
  public let keyword: String?
  public init(id: String, symbol: String, condition: String, threshold: Double?, keyword: String?) {
    self.id = id
    self.symbol = symbol
    self.condition = condition
    self.threshold = threshold
    self.keyword = keyword
  }
}

/// finance.alert.list → `{alerts: [...], total}`
public struct AlertList: Decodable, Sendable {
  public let alerts: [AlertRow]
  public let total: Int
}

/// finance.alert.create params. condition 은 서버 zod enum 그대로, nil 필드는 인코드하지 않는다.
public struct AlertCreate: Encodable, Equatable, Sendable {
  /// (서버 값, 폼 라벨)
  public static let conditions = [
    ("price_above", "이상"), ("price_below", "이하"), ("change_percent", "등락률"), ("news_match", "뉴스"),
  ]

  public let symbol: String
  public let condition: String
  public let threshold: Double?
  public let keyword: String?

  /// 폼 입력 → 요청. 종목이 비었거나 값이 조건에 맞지 않으면(뉴스 = 키워드, 그 외 = 숫자) nil.
  public init?(symbol: String, condition: String, value: String) {
    let symbol = symbol.trimmingCharacters(in: .whitespaces)
    let value = value.trimmingCharacters(in: .whitespaces)
    let news = condition == "news_match"
    let number = Double(value)
    guard !symbol.isEmpty, !value.isEmpty, news || number != nil else { return nil }
    self.symbol = symbol
    self.condition = condition
    threshold = news ? nil : number
    keyword = news ? value : nil
  }
}

/// 내용을 쓰지 않는 응답 (finance.alert.create · finance.alert.delete)
public struct Ack: Decodable, Sendable {}
