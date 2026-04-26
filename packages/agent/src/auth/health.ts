// packages/agent/src/auth/health.ts
import { getEventBus } from '@finclaw/infra';
import type { ManagedAuthProfile } from './profiles.js';

/** 프로필 건강 상태 */
export type ProfileHealthStatus = 'healthy' | 'degraded' | 'unhealthy' | 'disabled';

/** 건강 판정 기준 */
export interface HealthThresholds {
  readonly maxConsecutiveFailures: number; // 기본: 3
  readonly degradedFailureRate: number; // 기본: 0.3 (30%)
  readonly unhealthyFailureRate: number; // 기본: 0.7 (70%)
  readonly windowSizeMs: number; // 기본: 300_000 (5분)
}

const DEFAULT_THRESHOLDS: HealthThresholds = {
  maxConsecutiveFailures: 3,
  degradedFailureRate: 0.3,
  unhealthyFailureRate: 0.7,
  windowSizeMs: 300_000,
};

/** 내부 기록 엔트리 */
interface HealthRecord {
  readonly success: boolean;
  readonly timestamp: number;
  /** Phase 24 E: 모델 분포 집계용 (없으면 byModel 미반영). */
  readonly modelId?: string;
}

/** Phase 24 E: 모델별 누적 통계 (status 커맨드 분포 출력용). */
export interface ModelStats {
  calls: number;
  successCount: number;
  errorCount: number;
  totalCostUsd: number;
  /** fallback 으로 선택된 호출 수 (체인의 첫 번째 모델이 아닌 경우) */
  fallbacks: number;
  /** 토큰 누적 (input/output) */
  inputTokens: number;
  outputTokens: number;
}

/** Phase 24 E: 확장된 recordResult 입력 (modelId 가 있어야 byModel 집계). */
export interface RecordOptions {
  readonly success: boolean;
  readonly modelId?: string;
  readonly tokens?: { readonly input: number; readonly output: number };
  readonly costUsd?: number;
  readonly isFallback?: boolean;
}

/** 프로필별 상태 */
// TODO(L8): records를 readonly HealthRecord[]로 변경하고 filter 결과를 재할당하는 패턴 적용 고려
interface ProfileState {
  records: HealthRecord[];
  consecutiveFailures: number;
  lastHealth: ProfileHealthStatus;
  /** Phase 24 E: 모델별 누적 통계 (windowSizeMs 와 무관 — 누적). */
  byModel: Map<string, ModelStats>;
}

/**
 * 프로필 건강 모니터
 *
 * 알고리즘:
 * 1. 슬라이딩 윈도우 내 요청 기록 유지
 * 2. consecutiveFailures >= max → 'disabled'
 * 3. failureRate >= unhealthyRate → 'unhealthy'
 * 4. failureRate >= degradedRate → 'degraded'
 * 5. 그 외 → 'healthy'
 */
export class ProfileHealthMonitor {
  private readonly thresholds: HealthThresholds;
  private readonly states = new Map<string, ProfileState>();

  constructor(thresholds?: Partial<HealthThresholds>) {
    this.thresholds = { ...DEFAULT_THRESHOLDS, ...thresholds };
  }

  /**
   * 요청 결과 기록.
   *
   * - 단순 형식 `(profileId, true|false)`: 기존 호출자 호환.
   * - 확장 형식 `(profileId, RecordOptions)`: modelId + tokens + costUsd 포함 시 byModel
   *   누적 (Phase 24 E, status 커맨드 분포 출력용).
   */
  recordResult(profileId: string, success: boolean): void;
  recordResult(profileId: string, options: RecordOptions): void;
  recordResult(profileId: string, arg: boolean | RecordOptions): void {
    const opts: RecordOptions = typeof arg === 'boolean' ? { success: arg } : arg;
    const state = this.getOrCreateState(profileId);
    const now = Date.now();

    state.records.push({ success: opts.success, timestamp: now, modelId: opts.modelId });
    state.consecutiveFailures = opts.success ? 0 : state.consecutiveFailures + 1;

    // Phase 24 E: byModel 집계 (modelId 가 있을 때만).
    if (opts.modelId) {
      const stats = state.byModel.get(opts.modelId) ?? createEmptyModelStats();
      stats.calls += 1;
      if (opts.success) {
        stats.successCount += 1;
      } else {
        stats.errorCount += 1;
      }
      stats.totalCostUsd += opts.costUsd ?? 0;
      if (opts.isFallback) {
        stats.fallbacks += 1;
      }
      stats.inputTokens += opts.tokens?.input ?? 0;
      stats.outputTokens += opts.tokens?.output ?? 0;
      state.byModel.set(opts.modelId, stats);
    }

    // 윈도우 밖 기록 정리
    const cutoff = now - this.thresholds.windowSizeMs;
    state.records = state.records.filter((r) => r.timestamp >= cutoff);

    // 건강 상태 변경 감지
    const newHealth = this.computeHealth(state);
    if (newHealth !== state.lastHealth) {
      getEventBus().emit('auth:health:change', profileId, state.lastHealth, newHealth);
      state.lastHealth = newHealth;
    }
  }

  /**
   * Phase 24 E: 프로필의 모델별 누적 통계 (현재까지의 sinceMs 윈도우 내 호출 수 기준).
   *
   * `byModel` 자체는 누적이지만, 최근 sinceMs 동안의 calls 수는 records 에서
   * modelId 별 카운트로 계산한다 (windowSizeMs 와 별개). totalCostUsd / tokens 등
   * 누적 필드는 그대로 반환 — status 출력은 calls 만 시간 가중하면 충분.
   */
  getModelBreakdown(profileId: string, sinceMs = 60 * 60 * 1000): Map<string, ModelStats> {
    const state = this.states.get(profileId);
    if (!state) {
      return new Map();
    }
    const cutoff = Date.now() - sinceMs;
    const recentByModel = new Map<string, number>();
    for (const r of state.records) {
      if (r.timestamp < cutoff || !r.modelId) {
        continue;
      }
      recentByModel.set(r.modelId, (recentByModel.get(r.modelId) ?? 0) + 1);
    }
    // byModel 의 누적 stats 에 최근 calls 수만 덮어쓴 사본 반환.
    const out = new Map<string, ModelStats>();
    for (const [modelId, stats] of state.byModel) {
      const recentCalls = recentByModel.get(modelId);
      if (recentCalls === undefined) {
        continue;
      }
      out.set(modelId, { ...stats, calls: recentCalls });
    }
    return out;
  }

  /** 현재 건강 상태 조회 */
  getHealth(profileId: string): ProfileHealthStatus {
    const state = this.states.get(profileId);
    if (!state) {
      return 'healthy';
    }

    // 윈도우 밖 기록 정리
    const cutoff = Date.now() - this.thresholds.windowSizeMs;
    state.records = state.records.filter((r) => r.timestamp >= cutoff);

    return this.computeHealth(state);
  }

  /** 건강한 프로필만 필터링 (disabled 제외) */
  filterHealthy(profiles: readonly ManagedAuthProfile[]): readonly ManagedAuthProfile[] {
    return profiles.filter((p) => this.getHealth(p.id) !== 'disabled');
  }

  /** 건강 상태 요약 */
  getSummary(): Map<string, ProfileHealthStatus> {
    const summary = new Map<string, ProfileHealthStatus>();
    for (const [id] of this.states) {
      summary.set(id, this.getHealth(id));
    }
    return summary;
  }

  private computeHealth(state: ProfileState): ProfileHealthStatus {
    // 연속 실패 → disabled (최우선)
    if (state.consecutiveFailures >= this.thresholds.maxConsecutiveFailures) {
      return 'disabled';
    }

    // 기록이 없으면 healthy
    if (state.records.length === 0) {
      return 'healthy';
    }

    // 실패율 계산
    const failCount = state.records.filter((r) => !r.success).length;
    const failureRate = failCount / state.records.length;

    if (failureRate >= this.thresholds.unhealthyFailureRate) {
      return 'unhealthy';
    }
    if (failureRate >= this.thresholds.degradedFailureRate) {
      return 'degraded';
    }
    return 'healthy';
  }

  private getOrCreateState(profileId: string): ProfileState {
    let state = this.states.get(profileId);
    if (!state) {
      state = {
        records: [],
        consecutiveFailures: 0,
        lastHealth: 'healthy',
        byModel: new Map(),
      };
      this.states.set(profileId, state);
    }
    return state;
  }
}

function createEmptyModelStats(): ModelStats {
  return {
    calls: 0,
    successCount: 0,
    errorCount: 0,
    totalCostUsd: 0,
    fallbacks: 0,
    inputTokens: 0,
    outputTokens: 0,
  };
}
