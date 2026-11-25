// packages/types/src/notification.ts

/** JSON-RPC 2.0 알림 (서버 → 클라이언트, id 없음) */
export interface JsonRpcNotification<T = Record<string, unknown>> {
  readonly jsonrpc: '2.0';
  readonly method: string;
  readonly params?: T;
}

// ─── 채팅 스트리밍 notification params ───

/** chat.stream.delta — 증분 텍스트 조각 */
export interface ChatStreamDeltaParams {
  readonly sessionId: string;
  readonly delta: string; // 증분 텍스트 (전체가 아님, += 로 누적)
}

/** chat.stream.end — 스트리밍 완료 */
export interface ChatStreamEndParams {
  readonly sessionId: string;
  readonly result: unknown;
}

/** chat.stream.error — 스트리밍 에러 */
export interface ChatStreamErrorParams {
  readonly sessionId: string;
  readonly error: string;
}
