import Foundation
import Testing

@testable import FinClawMacCore

// RPC 응답·요청 모델 ↔ 서버 shape. 응답은 Fixtures/frames.jsonl (chat.history·provider_unavailable 은 실측,
// finance.alert.* 성공 응답은 finance.ts 핸들러 반환 shape 로 만든 synthetic:server-shape).

private func result<R: Decodable>(_ name: String, as: R.Type) throws -> R {
  guard case .response(_, .success(let data))? = decodeFrame(fixture(name)) else {
    throw RpcError(code: 0, message: name)
  }
  return try JSONDecoder().decode(Reply<R>.self, from: data).result
}

private func rpcError(_ name: String) throws -> RpcError {
  guard case .response(_, .failure(let e))? = decodeFrame(fixture(name)) else {
    throw RpcError(code: 0, message: name)
  }
  return e
}

@Test func chatHistoryDecodesRealFrame() throws {
  let messages = try result("chat.history.result", as: ChatHistory.self).messages
  #expect(messages.map(\.role) == ["user", "assistant"])
  #expect(messages[0].text == "한 문장으로 인사해줘.")
  #expect(!messages[1].text.isEmpty)
}

@Test func alertListDecodesEmptyAndRows() throws {
  let empty = try result("finance.alert.list.result.empty", as: AlertList.self)
  #expect(empty.alerts.isEmpty)
  #expect(empty.total == 0)

  let list = try result("finance.alert.list.result", as: AlertList.self)
  #expect(list.total == 2)
  #expect(list.alerts.map(\.id) == ["alert-1", "alert-2"])
  #expect(list.alerts[0].condition == "price_above")
  #expect(list.alerts[0].threshold == 200)
  #expect(list.alerts[0].keyword == nil)
  #expect(list.alerts[1].condition == "news_match")
  #expect(list.alerts[1].keyword == "실적")
  #expect(list.alerts[1].threshold == nil)
}

@Test func alertCreateAndDeleteRepliesDecode() throws {
  _ = try result("finance.alert.create.result", as: Ack.self)
  _ = try result("finance.alert.delete.result", as: Ack.self)
}

/// 폼이 보내는 params ↔ finance.ts zod: symbol, condition enum, threshold?, keyword?
@Test func alertCreateParamsMatchServerSchema() throws {
  #expect(AlertCreate.conditions.map(\.0) == ["price_above", "price_below", "change_percent", "news_match"])

  func params(_ a: AlertCreate?) throws -> [String: Any] {
    let text = try encodeRequest(id: 1, method: "finance.alert.create", params: try #require(a))
    let frame = try #require(try JSONSerialization.jsonObject(with: Data(text.utf8)) as? [String: Any])
    return try #require(frame["params"] as? [String: Any])
  }
  let price = try params(AlertCreate(symbol: " AAPL ", condition: "price_above", value: "200"))
  #expect(Set(price.keys) == ["symbol", "condition", "threshold"])
  #expect(price["symbol"] as? String == "AAPL")
  #expect(price["threshold"] as? Double == 200)
  let news = try params(AlertCreate(symbol: "005930", condition: "news_match", value: "실적"))
  #expect(Set(news.keys) == ["symbol", "condition", "keyword"])
  #expect(news["keyword"] as? String == "실적")

  #expect(AlertCreate(symbol: " ", condition: "price_above", value: "200") == nil)
  #expect(AlertCreate(symbol: "AAPL", condition: "change_percent", value: "abc") == nil)
  #expect(AlertCreate(symbol: "AAPL", condition: "news_match", value: "") == nil)
}

@Test func alertErrorsMapToCopy() throws {
  #expect(Copy.alertError(try rpcError("finance.alert.list.error.provider-unavailable")) == Copy.alertsUnavailable)
  #expect(Copy.alertError(try rpcError("finance.alert.delete.error.provider-unavailable")) == Copy.alertsUnavailable)
  #expect(Copy.alertError(try rpcError("chat.history.error.session-not-found")) == "session not found")
  #expect(Copy.alertError(CancellationError()) == Copy.requestFailed)
}
