// packages/infra/src/concurrency-lane.ts
import { FinClawError } from './errors.js';

/** 3-Lane ID: main(사용자 대화), cron(정기 작업), subagent(하위 에이전트) */
export type LaneId = 'main' | 'cron' | 'subagent';

export interface LaneConfig {
  /** 최대 동시 실행 수 */
  maxConcurrent: number;
  /** 대기열 최대 크기 (기본: 100) */
  maxQueueSize?: number;
  /** 대기 타임아웃 (ms, 기본: 60000) */
  waitTimeoutMs?: number;
}

/** 기본 레인 설정 */
export const DEFAULT_LANE_CONFIG: Record<LaneId, LaneConfig> = {
  main: { maxConcurrent: 1 },
  cron: { maxConcurrent: 2 },
  subagent: { maxConcurrent: 3 },
};

export interface LaneHandle {
  /** 레인 해제 */
  release(): void;
}

/**
 * 동시성 레인 -- 키별 동시 실행 제한
 *
 * - 키별 독립 카운터
 * - maxConcurrent 초과 시 대기열에 삽입
 * - release 시 대기열에서 다음 항목 실행
 * - Generation counter: resetGeneration() 시 stale completion 무시
 */
export class ConcurrencyLane {
  private active = new Map<string, number>();
  private generation = 0;
  private waiters = new Map<
    string,
    Array<{
      resolve: (handle: LaneHandle) => void;
      reject: (err: Error) => void;
      timer: ReturnType<typeof setTimeout>;
      generation: number;
    }>
  >();

  constructor(private readonly config: LaneConfig) {}

  async acquire(key: string): Promise<LaneHandle> {
    const current = this.active.get(key) ?? 0;
    const gen = this.generation;

    if (current < this.config.maxConcurrent) {
      this.active.set(key, current + 1);
      return { release: () => this.releaseIfCurrent(key, gen) };
    }

    const queue = this.waiters.get(key) ?? [];
    if (queue.length >= (this.config.maxQueueSize ?? 100)) {
      throw new FinClawError('Concurrency lane queue full', 'LANE_QUEUE_FULL', {
        details: { key },
      });
    }

    return new Promise<LaneHandle>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.removeWaiter(key, waiter);
        reject(
          new FinClawError('Concurrency lane timeout', 'LANE_TIMEOUT', {
            details: { key },
          }),
        );
      }, this.config.waitTimeoutMs ?? 60_000);

      const waiter = { resolve, reject, timer, generation: gen };
      if (!this.waiters.has(key)) {
        this.waiters.set(key, []);
      }
      this.waiters.get(key)?.push(waiter);
    });
  }

  /** Generation이 일치할 때만 release (stale completion 무시) */
  private releaseIfCurrent(key: string, gen: number): void {
    if (gen !== this.generation) {
      return; // stale — 무시
    }
    this.release(key);
  }

  // NOTE: waiter에게 slot을 넘길 때 active를 감소시키지 않는다 (slot transfer).
  // waiter가 release를 호출할 때 비로소 active가 감소하므로 동시성 제한이 유지된다.
  private release(key: string): void {
    const current = this.active.get(key) ?? 0;
    const queue = this.waiters.get(key);

    if (queue && queue.length > 0) {
      const next = queue.shift();
      if (!next) {
        return;
      }
      clearTimeout(next.timer);
      next.resolve({ release: () => this.releaseIfCurrent(key, next.generation) });
    } else {
      if (current <= 1) {
        this.active.delete(key);
      } else {
        this.active.set(key, current - 1);
      }
    }
  }

  /** Generation 리셋 — 진행 중인 모든 작업의 release를 무효화 */
  resetGeneration(): void {
    this.generation++;
    this.clearWaiters();
  }

  /** 모든 대기열 정리 (LANE_CLEARED 에러로 reject) */
  clearWaiters(): void {
    for (const [, queue] of this.waiters) {
      for (const waiter of queue) {
        clearTimeout(waiter.timer);
        waiter.reject(new FinClawError('Lane cleared', 'LANE_CLEARED'));
      }
    }
    this.waiters.clear();
  }

  /** 리소스 정리 */
  dispose(): void {
    this.clearWaiters();
    this.active.clear();
  }

  // NOTE: waiter는 동일 객체 참조. unknown으로 받아 캐스트하는 이유: setTimeout 콜백에서 타입 추론 한계.
  private removeWaiter(key: string, waiter: unknown): void {
    const queue = this.waiters.get(key);
    if (queue) {
      const idx = queue.indexOf(waiter as (typeof queue)[number]);
      if (idx !== -1) {
        queue.splice(idx, 1);
      }
    }
  }

  getActiveCount(key: string): number {
    return this.active.get(key) ?? 0;
  }

  getWaitingCount(key: string): number {
    return this.waiters.get(key)?.length ?? 0;
  }
}

/**
 * 3-Lane 관리자 — main, cron, subagent 레인 통합 관리
 */
export class ConcurrencyLaneManager {
  private readonly lanes: Map<LaneId, ConcurrencyLane>;

  constructor(configs: Partial<Record<LaneId, LaneConfig>> = {}) {
    this.lanes = new Map();
    for (const id of ['main', 'cron', 'subagent'] as LaneId[]) {
      this.lanes.set(id, new ConcurrencyLane(configs[id] ?? DEFAULT_LANE_CONFIG[id]));
    }
  }

  acquire(laneId: LaneId, key: string): Promise<LaneHandle> {
    return this.getLane(laneId).acquire(key);
  }

  resetGeneration(laneId: LaneId): void {
    this.getLane(laneId).resetGeneration();
  }

  dispose(): void {
    for (const lane of this.lanes.values()) {
      lane.dispose();
    }
  }

  private getLane(id: LaneId): ConcurrencyLane {
    const lane = this.lanes.get(id);
    if (!lane) {
      throw new FinClawError(`Unknown lane: ${id}`, 'UNKNOWN_LANE');
    }
    return lane;
  }
}
