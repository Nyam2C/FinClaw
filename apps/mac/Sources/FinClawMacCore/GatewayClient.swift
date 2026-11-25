import Foundation

public enum OfflineReason: Equatable, Sendable { case serverDown, noToken, badToken /* close 4001 */, shutdown }
public enum ClientEvent: Equatable, Sendable {
  case connecting, connected, disconnected(OfflineReason), server(ServerEvent)
}

/// 재연결 지연: 0.8s × 1.7ⁿ, 최대 15s.
public func backoffDelay(attempt: Int) -> Duration {
  .milliseconds(Int(min(800 * pow(1.7, Double(attempt)), 15_000).rounded()))
}

/// 접속 루프(토큰 재읽기·헤더 인증·chat.start = 온라인) · 수신 루프 · id 매칭 pending · 요청 타임아웃 · ping · 백오프.
@MainActor public final class GatewayClient {
  private let url: URL
  private let tokenURL: URL
  private let connect: (URLRequest) -> WebSocketConnection
  private let sleep: (Duration) async throws -> Void
  private let requestTimeout: Duration
  private let onEvent: (ClientEvent) -> Void

  public private(set) var sessionId: String?
  private var conn: WebSocketConnection?
  private var loopTask: Task<Void, Never>?
  private var pending: [Int: CheckedContinuation<Data, Error>] = [:]
  private var nextId = 0
  private var sawShutdown = false

  public init(
    url: URL,
    tokenURL: URL,
    connect: @escaping (URLRequest) -> WebSocketConnection = {
      URLSessionConnection(URLSession.shared.webSocketTask(with: $0))
    },
    sleep: @escaping (Duration) async throws -> Void = { try await Task.sleep(for: $0) },
    requestTimeout: Duration = .seconds(30),
    onEvent: @escaping (ClientEvent) -> Void
  ) {
    self.url = url
    self.tokenURL = tokenURL
    self.connect = connect
    self.sleep = sleep
    self.requestTimeout = requestTimeout
    self.onEvent = onEvent
  }

  /// 즉시 접속, 실패하면 백오프 (Q14)
  public func start() {
    guard loopTask == nil else { return }
    loopTask = Task { await runLoop() }
  }

  /// 메뉴바 "재연결" — 백오프 초기화 후 즉시
  public func reconnect() {
    loopTask?.cancel()
    loopTask = nil
    if let c = conn { drop(c) }
    start()
  }

  private func runLoop() async {
    var attempt = 0
    while !Task.isCancelled {
      onEvent(.connecting)
      let (reason, wasOnline) = await connectOnce()
      if Task.isCancelled { return }  // reconnect() 가 새 루프를 띄웠다 — 옛 루프는 조용히 끝난다
      onEvent(.disconnected(reason))
      if wasOnline { attempt = 0 }  // chat.start 성공 시 백오프 초기화
      let delay = reason == .badToken ? Duration.seconds(15) : backoffDelay(attempt: attempt)
      attempt += 1
      try? await sleep(delay)
    }
  }

  private func connectOnce() async -> (OfflineReason, Bool) {
    guard let token = readToken(at: tokenURL) else { return (.noToken, false) }  // 접속 시도 없음
    var req = URLRequest(url: url)
    req.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")  // G6. URL 쿼리 금지
    let c = connect(req)
    conn = c
    sawShutdown = false
    c.resume()
    let reader = Task { await receiveLoop(c) }  // 끝나면 = 끊김
    var online = false
    do {
      sessionId = try await call("chat.start", ["agentId": "default"], as: StartResult.self).sessionId
      online = true
      onEvent(.connected)
    } catch { c.cancel() }
    let pinger = Task {  // 서버 사망 감지용 (G7 과 별개)
      while !Task.isCancelled {
        try? await sleep(.seconds(25))
        if Task.isCancelled { return }
        do { try await c.sendPing() } catch { c.cancel() }
      }
    }
    await reader.value
    pinger.cancel()
    let reason: OfflineReason = c.closeCode == 4001 ? .badToken : (sawShutdown ? .shutdown : .serverDown)  // G9
    return (reason, online)
  }

  private func receiveLoop(_ c: WebSocketConnection) async {
    while let text = try? await c.receive() {
      switch decodeFrame(text) {
      case .response(let id, let result)?:
        pending.removeValue(forKey: id)?.resume(with: result.mapError { $0 as Error })  // 먼저 꺼내고 resume
      case .event(let ev)?:
        if ev == .shutdown { sawShutdown = true }
        onEvent(.server(ev))
      case nil: continue
      }
    }
    if conn === c { drop(c) }
  }

  /// 연결을 버리고 남은 pending 을 전부 "disconnected" 로 끝낸다.
  private func drop(_ c: WebSocketConnection) {
    c.cancel()
    conn = nil
    sessionId = nil
    let waiting = pending
    pending.removeAll()
    for cont in waiting.values { cont.resume(throwing: RpcError(code: -1, message: "disconnected")) }
  }

  public func call<R: Decodable>(_ method: String, _ params: some Encodable, as: R.Type) async throws -> R {
    guard let c = conn else { throw RpcError(code: -1, message: "disconnected") }
    nextId += 1
    let id = nextId
    let text = try encodeRequest(id: id, method: method, params: params)
    let frame: Data = try await withCheckedThrowingContinuation { cont in
      pending[id] = cont
      Task {
        do { try await c.send(text) } catch { pending.removeValue(forKey: id)?.resume(throwing: error) }
      }
      Task {
        try? await sleep(requestTimeout)
        pending.removeValue(forKey: id)?.resume(throwing: RpcError(code: -2, message: "timeout"))
      }
    }
    return try JSONDecoder().decode(Reply<R>.self, from: frame).result
  }

  /// runId 는 호출자가 먼저 정한다. "session not found" → chat.start + 1회 재전송.
  public func send(_ message: String, runId: String) async throws {
    for attempt in 0..<2 {
      guard let sid = sessionId else { throw RpcError(code: -1, message: "disconnected") }
      do {
        _ = try await call("chat.send", ["sessionId": sid, "message": message, "runId": runId], as: RunIdResult.self)
        return
      } catch let e as RpcError where attempt == 0 && e.message.contains("session not found") {  // Q9
        sessionId = try await call("chat.start", ["agentId": "default"], as: StartResult.self).sessionId
      }
    }
  }

  public func abort(runId: String) async throws {
    guard let sid = sessionId else { throw RpcError(code: -1, message: "disconnected") }
    _ = try await call("chat.abort", ["sessionId": sid, "runId": runId], as: Aborted.self)
  }

  public func reset() async throws {
    guard let sid = sessionId else { throw RpcError(code: -1, message: "disconnected") }
    _ = try await call("chat.reset", ["sessionId": sid], as: ResetDone.self)
  }
}

private struct Aborted: Decodable { let aborted: Bool }
private struct ResetDone: Decodable { let reset: Bool }
