import Foundation

public struct RpcError: Error, Decodable, Equatable, Sendable {
  public let code: Int
  public let message: String
}

public enum ToolPhase: String, Decodable, Sendable { case start, end }

/// notification.alert.triggered params.data (서버 AlertTriggeredData 와 1:1)
public struct AlertTriggered: Decodable, Equatable, Sendable {
  public let alertId: String, name: String, message: String, currentValue: String
  public let triggeredAt: Double  // epoch ms
}

/// notification.schedule.completed params.data (server/src/automation/delivery.ts)
public struct ScheduleCompleted: Decodable, Equatable, Sendable {
  public let scheduleId: String, name: String
  public let runId: String?  // agentRunId: string | null
  public let output: String
  public let error: String?  // undefined 면 키 자체가 없음
  public let completedAt: Double
}

public enum ServerEvent: Equatable, Sendable {
  case delta(runId: String, text: String)
  case tool(runId: String, toolCallId: String, name: String, phase: ToolPhase, isError: Bool)
  case end(runId: String, text: String)  // result.text = 정본
  case runError(runId: String, reason: String)  // AgentErrorReason 원문. error(raw) 는 UI 에 안 씀
  case alertTriggered(AlertTriggered)
  case scheduleCompleted(ScheduleCompleted)
  case shutdown
}

/// 텍스트 프레임 1개 → 응답(id 정수) 또는 이벤트. 응답의 Data 는 프레임 전체 바이트 — 호출자가 Reply<R> 로 다시 디코드.
public enum Frame: Equatable, Sendable {
  case response(id: Int, result: Result<Data, RpcError>)
  case event(ServerEvent)
}

public struct Reply<R: Decodable>: Decodable { public let result: R }
public struct StartResult: Decodable, Sendable { public let sessionId: String }
public struct RunIdResult: Decodable, Sendable { public let runId: String }

private struct Envelope: Decodable {
  let id: Int?
  let method: String?
  let error: RpcError?
}
private struct Params<P: Decodable>: Decodable { let params: P }
private struct Wrapped<T: Decodable>: Decodable { let data: T }  // notification.* 의 params.data
private struct DeltaP: Decodable {
  let runId: String
  let delta: String
}
private struct ToolP: Decodable {
  let runId, toolCallId, name: String
  let phase: ToolPhase
  let isError: Bool?
}
private struct EndP: Decodable {
  let runId: String
  let result: Text
  struct Text: Decodable { let text: String }
}
private struct ErrP: Decodable {
  let runId: String
  let reason: String
}

public func decodeFrame(_ text: String) -> Frame? {
  let data = Data(text.utf8)
  let dec = JSONDecoder()
  guard let env = try? dec.decode(Envelope.self, from: data) else { return nil }
  if let id = env.id {  // id:null(파스 에러)은 nil 로 떨어져 아래 default → nil
    return .response(id: id, result: env.error.map { .failure($0) } ?? .success(data))
  }
  func p<P: Decodable>(_: P.Type) -> P? { try? dec.decode(Params<P>.self, from: data).params }
  switch env.method {
  case "chat.stream.delta": return p(DeltaP.self).map { .event(.delta(runId: $0.runId, text: $0.delta)) }
  case "chat.stream.tool":
    return p(ToolP.self).map {
      let tool = ServerEvent.tool(
        runId: $0.runId, toolCallId: $0.toolCallId, name: $0.name, phase: $0.phase, isError: $0.isError ?? false)
      return .event(tool)
    }
  case "chat.stream.end": return p(EndP.self).map { .event(.end(runId: $0.runId, text: $0.result.text)) }
  case "chat.stream.error": return p(ErrP.self).map { .event(.runError(runId: $0.runId, reason: $0.reason)) }
  case "notification.alert.triggered":
    return p(Wrapped<AlertTriggered>.self).map { .event(.alertTriggered($0.data)) }
  case "notification.schedule.completed":
    return p(Wrapped<ScheduleCompleted>.self).map { .event(.scheduleCompleted($0.data)) }
  case "system.shutdown": return .event(.shutdown)
  default: return nil  // notification.portfolio.changed 등 — 무시
  }
}

private struct Req<P: Encodable>: Encodable {
  var jsonrpc = "2.0"
  let id: Int
  let method: String
  let params: P
}

public func encodeRequest(id: Int, method: String, params: some Encodable) throws -> String {
  String(decoding: try JSONEncoder().encode(Req(id: id, method: method, params: params)), as: UTF8.self)
}
