import Foundation
import Testing

@testable import FinClawMacCore

/// Fixtures/frames.jsonl — 줄마다 {name, source, raw}. raw = 실 서버 프레임 원문 (alert 1줄만 synthetic).
private struct FixtureLine: Decodable { let name: String; let raw: String }
let fixtureLines: [(name: String, raw: String)] = {
  let url = Bundle.module.url(forResource: "frames", withExtension: "jsonl", subdirectory: "Fixtures")!
  let text = try! String(contentsOf: url, encoding: .utf8)
  return text.split(separator: "\n").map {
    let l = try! JSONDecoder().decode(FixtureLine.self, from: Data($0.utf8))
    return (l.name, l.raw)
  }
}()
func fixture(_ name: String) -> String { fixtureLines.first { $0.name == name }!.raw }

private func event(_ name: String) -> ServerEvent? {
  if case .event(let e)? = decodeFrame(fixture(name)) { return e }
  return nil
}
private func success(_ name: String) -> Data? {
  if case .response(_, .success(let d))? = decodeFrame(fixture(name)) { return d }
  return nil
}
private func failure(_ name: String) -> RpcError? {
  if case .response(_, .failure(let e))? = decodeFrame(fixture(name)) { return e }
  return nil
}

@Test func everyFixtureDecodes() {
  #expect(fixtureLines.count >= 12)
  for line in fixtureLines { #expect(decodeFrame(line.raw) != nil, "\(line.name)") }
}

@Test func startResult() throws {
  let data = try #require(success("chat.start.result"))
  #expect(try !JSONDecoder().decode(Reply<StartResult>.self, from: data).result.sessionId.isEmpty)
}

@Test func sendResult() throws {
  let data = try #require(success("chat.send.result"))
  let runId = try JSONDecoder().decode(Reply<RunIdResult>.self, from: data).result.runId
  #expect(UUID(uuidString: runId) != nil)
}

@Test func delta() throws {
  guard case .delta(let runId, let text)? = event("chat.stream.delta") else {
    Issue.record("not a delta")
    return
  }
  #expect(!runId.isEmpty)
  #expect(!text.isEmpty)
}

@Test func toolStartEnd() {
  guard case .tool(_, let id1, let name1, let phase1, _)? = event("chat.stream.tool.start"),
    case .tool(_, let id2, let name2, let phase2, let isError)? = event("chat.stream.tool.end")
  else {
    Issue.record("not tool events")
    return
  }
  #expect(phase1 == .start)
  #expect(phase2 == .end)
  #expect(id1 == id2)
  #expect(name1.hasPrefix("mcp__finclaw__"))
  #expect(name2.hasPrefix("mcp__finclaw__"))
  #expect(isError == false)
}

@Test func end() throws {
  let raw = fixture("chat.stream.end")
  let obj = try #require(JSONSerialization.jsonObject(with: Data(raw.utf8)) as? [String: Any])
  let params = try #require(obj["params"] as? [String: Any])
  let original = try #require((params["result"] as? [String: Any])?["text"] as? String)
  guard case .end(_, let text)? = event("chat.stream.end") else {
    Issue.record("not an end")
    return
  }
  #expect(text == original)
}

@Test func abortedError() {
  guard case .runError(_, let reason)? = event("chat.stream.error.aborted") else {
    Issue.record("not a runError")
    return
  }
  #expect(reason == "aborted")
}

@Test func sessionNotFound() {
  #expect(failure("error.session-not-found") == RpcError(code: -32603, message: "session not found"))
}

@Test func unauthorized() {
  #expect(failure("error.unauthorized")?.code == -32001)
}

@Test func scheduleCompleted() {
  guard case .scheduleCompleted(let c)? = event("notification.schedule.completed") else {
    Issue.record("not scheduleCompleted")
    return
  }
  #expect(!c.scheduleId.isEmpty)
  #expect(!c.name.isEmpty)
  #expect(!c.output.isEmpty)
  #expect(c.error == nil)
}

@Test func shutdown() {
  #expect(decodeFrame(fixture("system.shutdown")) == .event(.shutdown))
}

@Test func alertTriggered() {
  guard case .alertTriggered(let a)? = event("notification.alert.triggered") else {
    Issue.record("not alertTriggered")
    return
  }
  #expect(a.alertId == "alert-1")
  #expect(a.name == "AAPL price_above")
}

@Test func unknownMethodIsNil() {
  #expect(decodeFrame(#"{"jsonrpc":"2.0","method":"notification.portfolio.changed","params":{"data":{},"timestamp":0}}"#) == nil)
}

@Test func nullIdParseErrorIsNil() {
  #expect(decodeFrame(#"{"jsonrpc":"2.0","id":null,"error":{"code":-32700,"message":"Parse error"}}"#) == nil)
}

@Test func encodeRequestRoundTrip() throws {
  let text = try encodeRequest(id: 7, method: "chat.send", params: ["a": "b"])
  let obj = try #require(JSONSerialization.jsonObject(with: Data(text.utf8)) as? [String: Any])
  #expect(obj["jsonrpc"] as? String == "2.0")
  #expect(obj["id"] as? Int == 7)
  #expect(obj["method"] as? String == "chat.send")
  #expect(obj["params"] as? [String: String] == ["a": "b"])
}
