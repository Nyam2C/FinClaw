// packages/server/src/process/errors.ts
import { FinClawError } from '@finclaw/infra';

/** spawn 실행 실패 */
export class SpawnError extends FinClawError {
  constructor(message: string, details?: Record<string, unknown>) {
    super(message, 'SPAWN_ERROR', { details });
    this.name = 'SpawnError';
  }
}

/** spawn 타임아웃 */
export class SpawnTimeoutError extends FinClawError {
  constructor(command: string, timeoutMs: number) {
    super(`Spawn timeout: ${command} (${timeoutMs}ms)`, 'SPAWN_TIMEOUT', {
      details: { command, timeoutMs },
    });
    this.name = 'SpawnTimeoutError';
  }
}

/** 레인 대기열 정리됨 (Generation 리셋) */
export class LaneClearedError extends FinClawError {
  constructor(laneKey?: string) {
    super('Lane cleared', 'LANE_CLEARED', { details: { laneKey } });
    this.name = 'LaneClearedError';
  }
}

/** 큐 가득 참 */
export class QueueFullError extends FinClawError {
  constructor(sessionKey: string, maxSize: number) {
    super(`Queue full for session: ${sessionKey}`, 'QUEUE_FULL', {
      details: { sessionKey, maxSize },
    });
    this.name = 'QueueFullError';
  }
}
