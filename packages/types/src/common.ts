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

/** 비동기 정리 함수 */
export type AsyncDisposable = () => Promise<void>;

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
