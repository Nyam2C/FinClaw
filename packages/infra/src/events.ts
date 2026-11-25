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
  /** 채널 메시지 수신 */
  'channel:message': (channelId: string, messageId: string) => void;
  /** 미처리 rejection */
  'system:unhandledRejection': (level: string, reason: unknown) => void;
  /** 프로필 건강 상태 변경 */
  'auth:health:change': (profileId: string, from: string, to: string) => void;

  // ── Phase 7: Tool events ──
  'tool:register': (name: string, group: string, source: string) => void;
  'tool:execute:start': (name: string, sessionId: string) => void;
  'tool:execute:end': (name: string, sessionId: string, durationMs: number) => void;
  'tool:execute:error': (name: string, sessionId: string, error: string) => void;
  'tool:execute:timeout': (name: string, sessionId: string, timeoutMs: number) => void;
  'tool:policy:verdict': (name: string, verdict: string, stage: string) => void;
  'tool:policy:deny': (name: string, reason: string) => void;
  /** Phase 31 D: sha256 기반 루프 감지 — generic_repeat / global_circuit_breaker. */
  'tool:loop:detected': (name: string, detector: string, count: number) => void;

  // ── Phase 10: Gateway events ──
  'gateway:start': (port: number) => void;
  'gateway:stop': () => void;
  'gateway:ws:connect': (connectionId: string, authLevel: string) => void;
  'gateway:ws:disconnect': (connectionId: string, code: number) => void;
  'gateway:rpc:request': (method: string, connectionId: string) => void;
  'gateway:rpc:error': (method: string, errorCode: number) => void;
  'gateway:auth:failure': (ip: string, reason: string) => void;
  'gateway:auth:rate_limit': (ip: string, failures: number) => void;
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
