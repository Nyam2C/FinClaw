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

  // ── Phase 7: Tool events ──
  'tool:register': (name: string, group: string, source: string) => void;
  'tool:unregister': (name: string) => void;
  'tool:execute:start': (name: string, sessionId: string) => void;
  'tool:execute:end': (name: string, sessionId: string, durationMs: number) => void;
  'tool:execute:error': (name: string, sessionId: string, error: string) => void;
  'tool:execute:timeout': (name: string, sessionId: string, timeoutMs: number) => void;
  'tool:policy:verdict': (name: string, verdict: string, stage: string) => void;
  'tool:policy:deny': (name: string, reason: string) => void;
  'tool:circuit:change': (name: string, from: string, to: string) => void;

  // ── Phase 7: Session events ──
  'session:lock:acquire': (sessionId: string, pid: number) => void;
  'session:lock:release': (sessionId: string) => void;
  'session:lock:stale': (sessionId: string, stalePid: number) => void;

  // ── Phase 7: Context events ──
  'context:window:status': (status: string, usageRatio: number) => void;
  'context:compact': (strategy: string, beforeTokens: number, afterTokens: number) => void;
  'context:compact:fallback': (fromStrategy: string, toStrategy: string) => void;

  // ── Phase 8: Pipeline events ──
  'pipeline:start': (data: { sessionKey: unknown }) => void;
  'pipeline:complete': (data: {
    sessionKey: unknown;
    success: boolean;
    durationMs: number;
    stagesExecuted: readonly string[];
    abortedAt?: string;
    abortReason?: string;
  }) => void;
  'pipeline:error': (data: { sessionKey: unknown; error: Error }) => void;

  // ── Phase 9: Execution events ──
  'execution:start': (agentId: string, sessionKey: string) => void;
  'execution:turn': (agentId: string, sessionKey: string, turn: number) => void;
  'execution:tool_use': (agentId: string, toolName: string, durationMs: number) => void;
  'execution:complete': (
    agentId: string,
    sessionKey: string,
    result: {
      status: string;
      turns: number;
      durationMs: number;
      usage: { inputTokens: number; outputTokens: number };
    },
  ) => void;
  'execution:context_threshold': (agentId: string, ratio: number, threshold: 0.8 | 0.95) => void;
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
