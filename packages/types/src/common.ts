/** 브랜드 타입 -- 원시 타입에 의미론적 구분 부여 */
export type Brand<T, B extends string> = T & { readonly __brand: B };

/** 결과 타입 -- 에러 핸들링의 명시적 표현 */
export type Result<T, E = Error> = { ok: true; value: T } | { ok: false; error: E };

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
