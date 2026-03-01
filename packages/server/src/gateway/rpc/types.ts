import type { RpcRequest, RpcResponse } from '@finclaw/types';
// packages/server/src/gateway/rpc/types.ts
import type { z } from 'zod/v4';

// === @finclaw/types re-export ===
export type {
  RpcRequest,
  RpcResponse,
  RpcError,
  RpcMethod,
  WsEvent,
  GatewayStatus,
} from '@finclaw/types';
export { RPC_ERROR_CODES } from '@finclaw/types';

// === 인증 타입 ===

/** 인증 레벨 (4-layer) */
export type AuthLevel =
  | 'none' // 공개 (health, info, ping)
  | 'api_key' // API 키 (외부 서비스)
  | 'token' // JWT 토큰 (웹 클라이언트)
  | 'session'; // 세션 스코프 (활성 채팅 세션 전용)

/** 인증 정보 */
export interface AuthInfo {
  readonly level: AuthLevel;
  readonly clientId?: string;
  readonly userId?: string;
  readonly sessionId?: string;
  readonly permissions: readonly Permission[];
}

/** 권한 */
export type Permission =
  | 'chat:read'
  | 'chat:write'
  | 'chat:execute'
  | 'config:read'
  | 'config:write'
  | 'agent:read'
  | 'agent:manage'
  | 'system:admin';

/** 인증 결과 */
export type AuthResult =
  | { readonly ok: true; readonly info: AuthInfo }
  | { readonly ok: false; readonly error: string; readonly code: number };

// === JSON-RPC 프로토콜 확장 ===

/** JSON-RPC 알림 (서버 → 클라이언트, id 없음) */
export interface JsonRpcNotification {
  readonly jsonrpc: '2.0';
  readonly method: string;
  readonly params?: Record<string, unknown>;
}

/** JSON-RPC 배치 요청 */
export type JsonRpcBatchRequest = readonly RpcRequest[];

/** RPC 메서드 핸들러 */
export interface RpcMethodHandler<TParams = unknown, TResult = unknown> {
  readonly method: string;
  readonly description: string;
  readonly authLevel: AuthLevel;
  readonly schema: z.ZodType<TParams>;
  execute(params: TParams, ctx: RpcContext): Promise<TResult>;
}

/** RPC 실행 컨텍스트 */
export interface RpcContext {
  readonly requestId: string | number;
  readonly auth: AuthInfo;
  readonly connectionId?: string;
  readonly remoteAddress: string;
}

// === WebSocket 연결 ===

/** WebSocket 연결 정보 */
export interface WsConnection {
  readonly id: string;
  readonly ws: import('ws').WebSocket;
  readonly auth: AuthInfo;
  readonly connectedAt: number;
  lastPongAt: number;
  readonly subscriptions: Set<string>;
}

/** WebSocket 아웃바운드 메시지 */
export type WsOutboundMessage = RpcResponse | JsonRpcNotification;

// === 서버 설정 ===

/** 게이트웨이 서버 상세 설정 */
export interface GatewayServerConfig {
  readonly host: string;
  readonly port: number;
  readonly tls?: {
    readonly cert: string;
    readonly key: string;
  };
  readonly cors?: {
    readonly origins: readonly string[];
    readonly maxAge?: number;
  };
  readonly auth: {
    readonly apiKeys: readonly string[];
    readonly jwtSecret: string;
    readonly sessionTtlMs: number;
  };
  readonly ws: {
    readonly heartbeatIntervalMs: number;
    readonly heartbeatTimeoutMs: number;
    readonly maxPayloadBytes: number;
    readonly handshakeTimeoutMs: number;
    readonly maxConnections: number;
  };
  readonly rpc: {
    readonly maxBatchSize: number;
    readonly timeoutMs: number;
  };
}

// === Chat Registry 타입 ===

/** 활성 채팅 세션 */
export interface ActiveSession {
  readonly sessionId: string;
  readonly agentId: string;
  readonly connectionId: string;
  readonly startedAt: number;
  readonly status: 'running' | 'paused' | 'stopping';
  readonly abortController: AbortController;
}

/** 레지스트리 이벤트 */
export type RegistryEvent =
  | { readonly type: 'session_started'; readonly session: ActiveSession }
  | { readonly type: 'session_completed'; readonly sessionId: string; readonly durationMs: number }
  | { readonly type: 'session_error'; readonly sessionId: string; readonly error: Error };
