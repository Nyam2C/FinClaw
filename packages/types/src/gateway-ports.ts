// packages/types/src/gateway-ports.ts
// Phase 39: gateway → server 결합 역전용 narrow port (DIP). server 구현 클래스가 구조적 만족.
import type { SessionKey } from './common.js';
import type { TraceContext } from './trace.js';

/** agent.run 종료 후 memory attach 입력 (이전 server agent-memory-hook.AgentRunMemoryInput). */
export interface AttachMemoryInput {
  readonly agentRunId: string;
  readonly agentId: string;
  readonly prompt: string;
  readonly output: string;
  readonly error?: string;
  readonly sessionKey: SessionKey;
  readonly createdAt: number;
}

/** gateway agent.ts 사용면 — 반환값 무시(await 만). */
export interface AttachMemoryPort {
  attach(input: AttachMemoryInput): Promise<unknown>;
}

/** gateway agent.ts 사용면 — withSpan 만. TraceContext 는 trace.ts 기존 타입. */
export interface TracerPort {
  withSpan<T>(
    name: string,
    attrs: Readonly<Record<string, unknown>>,
    fn: (ctx: TraceContext) => Promise<T>,
  ): Promise<T>;
}

/** brokerage.ts 사용면 — run() 결과 4필드 소비. */
export interface BrokerageSyncResultLike {
  readonly syncedAt: number;
  readonly holdingsCount: number;
  readonly marketsScanned: ReadonlyArray<'KR' | 'US'>;
  readonly errors: ReadonlyArray<{ market: string; message: string }>;
}
export interface BrokerageSyncPort {
  run(): Promise<BrokerageSyncResultLike>;
}

/** schedule.ts 사용면 — triggerNow 만 (Q1). */
export interface SchedulerPort {
  triggerNow(scheduleId: string): Promise<{ runId: string | null }>;
}
