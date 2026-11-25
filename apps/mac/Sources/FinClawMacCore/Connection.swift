import Foundation

/// 전송 seam — 실 구현 1 (URLSessionConnection) + 테스트 fake 1.
public protocol WebSocketConnection: AnyObject, Sendable {
  func resume()
  func send(_ text: String) async throws
  func receive() async throws -> String  // 텍스트 프레임만. binary 는 throw
  func sendPing() async throws
  func cancel()
  var closeCode: Int { get }  // G9
}

/// URLSessionWebSocketTask 를 직접 적합시키면 closeCode(타입 다름)·receive()(반환형 오버로드)가 충돌한다 → 래퍼.
public final class URLSessionConnection: WebSocketConnection, @unchecked Sendable {
  private let task: URLSessionWebSocketTask
  public init(_ task: URLSessionWebSocketTask) {
    self.task = task
    task.maximumMessageSize = 8 << 20  // 기본 1MB — chat.history{limit:40} 대비
  }
  public func resume() { task.resume() }
  public func send(_ text: String) async throws { try await task.send(.string(text)) }
  public func receive() async throws -> String {
    guard case .string(let s) = try await task.receive() else { throw URLError(.cannotDecodeContentData) }
    return s
  }
  public func sendPing() async throws {
    try await withCheckedThrowingContinuation { (c: CheckedContinuation<Void, Error>) in
      task.sendPing { err in if let err { c.resume(throwing: err) } else { c.resume() } }
    }
  }
  public func cancel() { task.cancel(with: .goingAway, reason: nil) }
  public var closeCode: Int { task.closeCode.rawValue }
}

public func readToken(at url: URL) -> String? {
  guard let raw = try? String(contentsOf: url, encoding: .utf8) else { return nil }
  let t = raw.trimmingCharacters(in: .whitespacesAndNewlines)
  return t.isEmpty ? nil : t
}
