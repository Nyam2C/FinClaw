// packages/infra/src/events.ts
import { EventEmitter } from 'node:events';

/**
 * 이벤트 맵 타입 — 이벤트명 → 핸들러 시그니처 매핑
 *
 * 사용 예:
 * ```typescript
 * interface MyEvents {
 *   'user:login': (userId: string) => void;
 *   'error': (err: Error) => void;
 * }
 * const emitter = createTypedEmitter<MyEvents>();
 * ```
 */
export type EventMap = Record<string, (...args: never[]) => void>;

/** 타입 안전 EventEmitter 래퍼 */
export interface TypedEmitter<T extends { [K in keyof T]: (...args: never[]) => void }> {
  on<K extends keyof T & string>(event: K, listener: T[K]): this;
  off<K extends keyof T & string>(event: K, listener: T[K]): this;
  once<K extends keyof T & string>(event: K, listener: T[K]): this;
  emit<K extends keyof T & string>(event: K, ...args: Parameters<T[K]>): boolean;
  removeAllListeners<K extends keyof T & string>(event?: K): this;
  listenerCount<K extends keyof T & string>(event: K): number;
}

/** TypedEmitter 팩토리 */
export function createTypedEmitter<
  T extends { [K in keyof T]: (...args: never[]) => void },
>(): TypedEmitter<T> {
  return new EventEmitter() as unknown as TypedEmitter<T>;
}

/** FinClaw 시스템 이벤트 맵 */
export interface FinClawEventMap {
  /** 시스템 초기화 완료 */
  'system:ready': () => void;
  /** 시스템 종료 시작 */
  'system:shutdown': (reason: string) => void;
  /** 에이전트 실행 시작 */
  'agent:run:start': (agentId: string, sessionKey: string) => void;
  /** 에이전트 실행 완료 */
  'agent:run:end': (agentId: string, sessionKey: string, durationMs: number) => void;
  /** 에이전트 실행 에러 */
  'agent:run:error': (agentId: string, sessionKey: string, error: Error) => void;
  /** 채널 메시지 수신 */
  'channel:message': (channelId: string, messageId: string) => void;
  /** 설정 변경 */
  'config:change': (changedPaths: string[]) => void;
  /** 스킬 실행 */
  'skill:execute': (skillName: string, agentId: string) => void;
  /** 스킬 실행 완료 */
  'skill:complete': (skillName: string, agentId: string, durationMs: number) => void;
  /** 미처리 rejection */
  'system:unhandledRejection': (level: string, reason: unknown) => void;
  /** 모델 별칭 해석 완료 */
  'model:resolve': (alias: string, modelId: string) => void;
  /** 폴백 모델 전환 */
  'model:fallback': (from: string, to: string, reason: string) => void;
  /** 모든 모델 소진 */
  'model:exhausted': (models: string[], lastError: string) => void;
  /** API 키 해석 완료 */
  'auth:resolve': (provider: string, source: string) => void;
  /** 프로필 쿨다운 진입 */
  'auth:cooldown': (profileId: string, reason: string, ms: number) => void;
  /** 프로필 건강 상태 변경 */
  'auth:health:change': (profileId: string, from: string, to: string) => void;
}

/** 전역 이벤트 버스 (싱글턴) */
let globalBus: TypedEmitter<FinClawEventMap> | undefined;

export function getEventBus(): TypedEmitter<FinClawEventMap> {
  if (!globalBus) {
    globalBus = createTypedEmitter<FinClawEventMap>();
  }
  return globalBus;
}

/** 테스트용 이벤트 버스 초기화 */
export function resetEventBus(): void {
  globalBus?.removeAllListeners();
  globalBus = undefined;
}
