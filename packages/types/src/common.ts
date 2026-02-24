/** 브랜드 타입 -- 원시 타입에 의미론적 구분 부여 */
export type Brand<T, B extends string> = T & { readonly __brand: B };

/** 불투명 타입 -- 내부 표현을 숨기고 타입 안전성 보장 */
export type Opaque<T, K extends string> = T & { readonly __opaque: K };

/** 결과 타입 -- 에러 핸들링의 명시적 표현 */
export type Result<T, E = Error> = { ok: true; value: T } | { ok: false; error: E };

/** 깊은 부분 타입 */
export type DeepPartial<T> = {
  [P in keyof T]?: T[P] extends object ? DeepPartial<T[P]> : T[P];
};

/** 깊은 읽기 전용 */
export type DeepReadonly<T> = {
  readonly [P in keyof T]: T[P] extends object ? DeepReadonly<T[P]> : T[P];
};

/** 타임스탬프 (밀리초 Unix epoch) */
export type Timestamp = Brand<number, 'Timestamp'>;

/** 세션 키 */
export type SessionKey = Brand<string, 'SessionKey'>;

/** 에이전트 ID */
export type AgentId = Brand<string, 'AgentId'>;

/** 채널 ID */
export type ChannelId = Brand<string, 'ChannelId'>;

/**
 * 비동기 정리 함수 -- TC39 `Symbol.asyncDispose`와 이름 충돌 방지를 위해
 * `AsyncDisposable` 대신 `CleanupFn`으로 명명.
 */
export type CleanupFn = () => Promise<void>;

/** 로그 레벨 */
export type LogLevel = 'trace' | 'debug' | 'info' | 'warn' | 'error' | 'fatal';

// ─── 에러 타입 ───

/** 에러 분류 -- FinClaw 시스템 전역에서 사용 */
export type ErrorReason =
  | 'CONFIG_INVALID' // 설정 파싱/검증 실패
  | 'CHANNEL_OFFLINE' // 채널 연결 불가
  | 'AGENT_TIMEOUT' // 에이전트 응답 초과
  | 'STORAGE_FAILURE' // 스토리지 읽기/쓰기 실패
  | 'RATE_LIMITED' // 외부 API 속도 제한
  | 'AUTH_FAILURE' // 인증/인가 실패
  | 'INTERNAL'; // 분류 불가 내부 에러

/** 구조화된 에러 인터페이스 */
export interface FinClawError {
  reason: ErrorReason;
  message: string;
  cause?: unknown;
  timestamp: Timestamp;
}

/** 브랜드 타입 팩토리 */
export function createTimestamp(ms: number): Timestamp {
  return ms as Timestamp;
}

export function createSessionKey(key: string): SessionKey {
  return key as SessionKey;
}

export function createAgentId(id: string): AgentId {
  return id as AgentId;
}

export function createChannelId(id: string): ChannelId {
  return id as ChannelId;
}
