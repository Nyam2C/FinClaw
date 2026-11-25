import Foundation
import Testing

@testable import FinClawMacCore

// MARK: - 헬퍼

/// 가상 시간. sleep 은 deadline 을 등록하고 advance 가 지난 것만 깨운다. 즉시 반환하지 않는다
/// (그러면 30s 타임아웃이 바로 터지고 재접속 루프가 무한히 돈다).
@MainActor final class TestClock {
  private(set) var now: Duration = .zero
  private(set) var delays: [Duration] = []
  private var waiters: [Int: (deadline: Duration, cont: CheckedContinuation<Void, Error>)] = [:]
  private var nextId = 0

  func sleep(_ d: Duration) async throws {
    delays.append(d)
    nextId += 1
    let id = nextId
    try await withTaskCancellationHandler {
      try await withCheckedThrowingContinuation { (c: CheckedContinuation<Void, Error>) in
        if Task.isCancelled { c.resume(throwing: CancellationError()) } else { waiters[id] = (now + d, c) }
      }
    } onCancel: {
      Task { @MainActor in self.waiters.removeValue(forKey: id)?.cont.resume(throwing: CancellationError()) }
    }
  }

  func advance(by d: Duration) async {
    now += d
    for (id, w) in waiters where w.deadline <= now {
      waiters.removeValue(forKey: id)
      w.cont.resume()
    }
    await settle()
  }

  /// 남은 대기를 CancellationError 로 끝낸다 (continuation 누수 방지).
  func drain() {
    let all = waiters
    waiters.removeAll()
    for w in all.values { w.cont.resume(throwing: CancellationError()) }
  }
}

final class FakeConnection: WebSocketConnection, @unchecked Sendable {
  let request: URLRequest
  var autoStart: Bool  // 테스트 스레드(MainActor)에서만 바꾼다
  private let lock = NSLock()
  private var _sent: [String] = []
  private var _closeCode = 0
  private var iterator: AsyncThrowingStream<String, Error>.AsyncIterator
  private let input: AsyncThrowingStream<String, Error>.Continuation

  init(_ request: URLRequest, autoStart: Bool) {
    self.request = request
    self.autoStart = autoStart
    let (stream, cont) = AsyncThrowingStream<String, Error>.makeStream()
    iterator = stream.makeAsyncIterator()
    input = cont
  }

  var sent: [String] { lock.withLock { _sent } }
  var closeCode: Int { lock.withLock { _closeCode } }
  /// 보낸 요청을 (id, method, params) 로
  var requests: [(id: Int, method: String, params: [String: Any])] {
    sent.compactMap {
      guard let o = try? JSONSerialization.jsonObject(with: Data($0.utf8)) as? [String: Any],
        let id = o["id"] as? Int, let m = o["method"] as? String
      else { return nil }
      return (id, m, o["params"] as? [String: Any] ?? [:])
    }
  }

  func push(_ text: String) { input.yield(text) }
  func respond(_ id: Int, _ result: String) { push(#"{"jsonrpc":"2.0","id":\#(id),"result":\#(result)}"#) }
  func fail(_ id: Int, _ code: Int, _ message: String) {
    push(#"{"jsonrpc":"2.0","id":\#(id),"error":{"code":\#(code),"message":"\#(message)"}}"#)
  }
  func close(code: Int) {
    lock.withLock { _closeCode = code }
    input.finish(throwing: URLError(.networkConnectionLost))
  }

  func resume() {}
  func send(_ text: String) async throws {
    lock.withLock { _sent.append(text) }
    if autoStart, let r = requests.last, r.method == "chat.start" { respond(r.id, #"{"sessionId":"s1"}"#) }
  }
  func receive() async throws -> String {
    guard let s = try await iterator.next() else { throw URLError(.networkConnectionLost) }
    return s
  }
  func sendPing() async throws {}
  func cancel() { input.finish(throwing: CancellationError()) }
}

/// MainActor 작업·연결 스레드 왕복이 끝나도록 양보한다 (실제 sleep 없음).
@MainActor func settle(_ n: Int = 200) async { for _ in 0..<n { await Task.yield() } }
@MainActor func eventually(_ cond: () -> Bool) async -> Bool {
  for _ in 0..<20_000 {
    if cond() { return true }
    await Task.yield()
  }
  return cond()
}

@MainActor final class Harness {
  let clock = TestClock()
  let tokenURL = FileManager.default.temporaryDirectory.appendingPathComponent("finclaw-test-\(UUID().uuidString).token")
  var autoStart = true
  var conns: [FakeConnection] = []
  var events: [ClientEvent] = []
  private(set) var client: GatewayClient!

  init(token: String? = "tok") {
    if let token { setToken(token) }
    client = GatewayClient(
      url: URL(string: "ws://127.0.0.1:3000/")!, tokenURL: tokenURL,
      // weak — 테스트가 끝나도 클라이언트 루프는 남은 가상 sleep 에 매달려 있다 (stop API 없음)
      connect: { [weak self] req in
        let f = FakeConnection(req, autoStart: self?.autoStart ?? false)
        self?.conns.append(f)
        return f
      },
      sleep: { [clock] d in try await clock.sleep(d) },
      onEvent: { [weak self] in self?.events.append($0) })
  }

  func setToken(_ t: String) { try! t.write(to: tokenURL, atomically: true, encoding: .utf8) }
  var conn: FakeConnection { conns.last! }
  func online() async -> Bool {
    client.start()
    return await eventually { events.contains(.connected) }
  }
  func finish() {
    clock.drain()
    try? FileManager.default.removeItem(at: tokenURL)
  }
}

// MARK: - 케이스

@MainActor @Test func bearerHeaderFromTokenFile() async {
  let h = Harness(token: "tok")
  defer { h.finish() }
  #expect(await h.online())
  #expect(h.conn.request.value(forHTTPHeaderField: "Authorization") == "Bearer tok")
  #expect(h.conn.request.url?.query == nil)
}

@MainActor @Test func noTokenSkipsConnect() async {
  let h = Harness(token: nil)
  defer { h.finish() }
  h.client.start()
  #expect(await eventually { h.events.count >= 2 })
  #expect(h.conns.isEmpty)
  #expect(h.events == [.connecting, .disconnected(.noToken)])
}

@MainActor @Test func connectedOnlyAfterChatStart() async {
  let h = Harness()
  defer { h.finish() }
  h.autoStart = false
  h.client.start()
  #expect(await eventually { h.conns.first?.requests.first?.method == "chat.start" })
  await settle()
  #expect(!h.events.contains(.connected))
  h.conn.respond(h.conn.requests[0].id, #"{"sessionId":"s1"}"#)
  #expect(await eventually { h.events.contains(.connected) })
  #expect(h.client.sessionId == "s1")
}

private struct Echo: Decodable { let v: Int }

@MainActor @Test func matchesResponsesById() async throws {
  let h = Harness()
  defer { h.finish() }
  #expect(await h.online())
  async let a = h.client.call("x.a", ["k": "a"], as: Echo.self)
  async let b = h.client.call("x.b", ["k": "b"], as: Echo.self)
  #expect(await eventually { h.conn.requests.count == 3 })
  let ida = h.conn.requests.first { $0.method == "x.a" }!.id
  let idb = h.conn.requests.first { $0.method == "x.b" }!.id
  h.conn.respond(idb, #"{"v":2}"#)
  h.conn.respond(ida, #"{"v":1}"#)
  #expect(try await a.v == 1)
  #expect(try await b.v == 2)
}

@MainActor @Test func requestTimesOut() async {
  let h = Harness()
  defer { h.finish() }
  #expect(await h.online())
  let t = Task { try await h.client.call("x.slow", ["k": "v"], as: Echo.self) }
  #expect(await eventually { h.conn.requests.count == 2 })
  await h.clock.advance(by: .seconds(30))
  await #expect(throws: RpcError(code: -2, message: "timeout")) { try await t.value }
  // pending 이 비었으므로 늦게 온 응답은 무시된다
  h.conn.respond(h.conn.requests[1].id, #"{"v":1}"#)
  await settle()
}

@MainActor @Test func disconnectFailsPending() async {
  let h = Harness()
  defer { h.finish() }
  #expect(await h.online())
  let t = Task { try await h.client.call("x.slow", ["k": "v"], as: Echo.self) }
  #expect(await eventually { h.conn.requests.count == 2 })
  h.conn.close(code: 1006)
  await #expect(throws: RpcError(code: -1, message: "disconnected")) { try await t.value }
}

@MainActor @Test func close4001IsBadToken() async {
  let h = Harness()
  defer { h.finish() }
  #expect(await h.online())
  h.conn.close(code: 4001)
  #expect(await eventually { h.events.last == .disconnected(.badToken) })
  #expect(await eventually { h.clock.delays.last == .seconds(15) })
}

@MainActor @Test func shutdownThenCloseIsShutdown() async {
  let h = Harness()
  defer { h.finish() }
  #expect(await h.online())
  h.conn.push(#"{"jsonrpc":"2.0","method":"system.shutdown","params":{"reason":"Server shutting down"}}"#)
  h.conn.close(code: 1000)
  #expect(await eventually { h.events.last == .disconnected(.shutdown) })
  #expect(h.events.suffix(2) == [.server(.shutdown), .disconnected(.shutdown)])
}

@MainActor @Test func otherCloseIsServerDown() async {
  let h = Harness()
  defer { h.finish() }
  #expect(await h.online())
  h.conn.close(code: 1006)
  #expect(await eventually { h.events.last == .disconnected(.serverDown) })
}

@MainActor @Test func sendCarriesRunId() async throws {
  let h = Harness()
  defer { h.finish() }
  #expect(await h.online())
  async let done: Void = h.client.send("hi", runId: "r1")
  #expect(await eventually { h.conn.requests.count == 2 })
  let r = h.conn.requests[1]
  #expect(r.method == "chat.send")
  #expect(r.params as? [String: String] == ["sessionId": "s1", "message": "hi", "runId": "r1"])
  h.conn.respond(r.id, #"{"runId":"r1"}"#)
  try await done
}

@MainActor @Test func sessionNotFoundRestartsOnce() async throws {
  let h = Harness()
  defer { h.finish() }
  #expect(await h.online())
  h.conn.autoStart = false
  async let done: Void = h.client.send("hi", runId: "r1")
  #expect(await eventually { h.conn.requests.count == 2 })
  h.conn.fail(h.conn.requests[1].id, -32603, "session not found")
  #expect(await eventually { h.conn.requests.count == 3 })
  #expect(h.conn.requests[2].method == "chat.start")
  h.conn.respond(h.conn.requests[2].id, #"{"sessionId":"s2"}"#)
  #expect(await eventually { h.conn.requests.count == 4 })
  let resend = h.conn.requests[3]
  #expect(resend.method == "chat.send")
  #expect(resend.params as? [String: String] == ["sessionId": "s2", "message": "hi", "runId": "r1"])
  h.conn.respond(resend.id, #"{"runId":"r1"}"#)
  try await done
  #expect(h.client.sessionId == "s2")
}

@MainActor @Test func secondSessionNotFoundThrows() async {
  let h = Harness()
  defer { h.finish() }
  #expect(await h.online())
  let t = Task { try await h.client.send("hi", runId: "r1") }
  #expect(await eventually { h.conn.requests.count == 2 })
  h.conn.fail(h.conn.requests[1].id, -32603, "session not found")
  #expect(await eventually { h.conn.requests.count == 4 })  // autoStart 가 chat.start 에 s1 응답 → 재전송
  h.conn.fail(h.conn.requests[3].id, -32603, "session not found")
  await #expect(throws: RpcError(code: -32603, message: "session not found")) { try await t.value }
  #expect(h.conn.requests.filter { $0.method == "chat.send" }.count == 2)
}

@Test func backoffSequence() {
  let d = (0...10).map { backoffDelay(attempt: $0) }
  #expect(Array(d.prefix(4)) == [.milliseconds(800), .milliseconds(1360), .milliseconds(2312), .milliseconds(3930)])
  #expect(zip(d, d.dropFirst()).allSatisfy { $0 <= $1 })
  #expect(d.last == .seconds(15))
}

@MainActor @Test func backoffResetsAfterOnline() async {
  let h = Harness(token: nil)
  defer { h.finish() }
  h.client.start()
  #expect(await eventually { h.clock.delays == [.milliseconds(800)] })
  await h.clock.advance(by: .milliseconds(800))
  #expect(await eventually { h.clock.delays == [.milliseconds(800), .milliseconds(1360)] })
  h.setToken("tok")
  await h.clock.advance(by: .milliseconds(1360))
  #expect(await eventually { h.events.contains(.connected) })
  h.conn.close(code: 1006)
  #expect(await eventually { h.clock.delays.last == .milliseconds(800) && h.clock.delays.count >= 4 })
  // delays: 800, 1360, (pinger 25s), 800
  #expect(h.clock.delays.filter { $0 != .seconds(25) && $0 != .seconds(30) } == [.milliseconds(800), .milliseconds(1360), .milliseconds(800)])
}

@MainActor @Test func rereadsTokenEachAttempt() async {
  let h = Harness(token: "a")
  defer { h.finish() }
  h.autoStart = false
  h.client.start()
  #expect(await eventually { h.conns.count == 1 && !h.conn.requests.isEmpty })
  h.conn.close(code: 1006)  // 1차 실패
  #expect(await eventually { h.events.last == .disconnected(.serverDown) })
  h.setToken("b")
  await h.clock.advance(by: .milliseconds(800))
  #expect(await eventually { h.conns.count == 2 })
  #expect(h.conns[0].request.value(forHTTPHeaderField: "Authorization") == "Bearer a")
  #expect(h.conns[1].request.value(forHTTPHeaderField: "Authorization") == "Bearer b")
}

@MainActor @Test func historySessionNotFoundRestartsOnce() async throws {
  let h = Harness()
  defer { h.finish() }
  #expect(await h.online())
  h.conn.autoStart = false
  async let lines = h.client.history()
  #expect(await eventually { h.conn.requests.count == 2 })
  #expect(h.conn.requests[1].method == "chat.history")
  h.conn.fail(h.conn.requests[1].id, -32603, "session not found")
  #expect(await eventually { h.conn.requests.count == 3 })
  #expect(h.conn.requests[2].method == "chat.start")
  h.conn.respond(h.conn.requests[2].id, #"{"sessionId":"s2"}"#)
  #expect(await eventually { h.conn.requests.count == 4 })
  #expect(h.conn.requests[3].params as? [String: String] == ["sessionId": "s2"])
  h.conn.respond(h.conn.requests[3].id, #"{"messages":[{"role":"user","text":"안녕"}]}"#)
  #expect(try await lines == [HistoryLine(role: "user", text: "안녕")])
}

@MainActor @Test func abortReportsMissingRun() async throws {
  let h = Harness()
  defer { h.finish() }
  #expect(await h.online())
  async let aborted = h.client.abort(runId: "r1")
  #expect(await eventually { h.conn.requests.count == 2 })
  #expect(h.conn.requests[1].params as? [String: String] == ["sessionId": "s1", "runId": "r1"])
  h.conn.respond(h.conn.requests[1].id, #"{"aborted":false}"#)
  #expect(try await aborted == false)
}
