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

/** chat.stream.tool_start — 도구 호출 시작 */
export interface ChatStreamToolStartParams {
  readonly sessionId: string;
  readonly toolCall: { readonly name: string; readonly input: unknown };
}

/** chat.stream.tool_end — 도구 호출 결과 */
export interface ChatStreamToolEndParams {
  readonly sessionId: string;
  readonly result: unknown;
}

/** 브로드캐스트 채널 */
export type BroadcastChannel = 'config.updated' | 'session.event' | 'system.status' | 'market.tick';
