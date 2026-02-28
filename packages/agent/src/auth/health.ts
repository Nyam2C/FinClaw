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
}

/** 프로필별 상태 */
// TODO(L8): records를 readonly HealthRecord[]로 변경하고 filter 결과를 재할당하는 패턴 적용 고려
interface ProfileState {
  records: HealthRecord[];
  consecutiveFailures: number;
  lastHealth: ProfileHealthStatus;
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

  /** 요청 결과 기록 */
  recordResult(profileId: string, success: boolean): void {
    const state = this.getOrCreateState(profileId);
    const now = Date.now();

    state.records.push({ success, timestamp: now });
    state.consecutiveFailures = success ? 0 : state.consecutiveFailures + 1;

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
      state = { records: [], consecutiveFailures: 0, lastHealth: 'healthy' };
      this.states.set(profileId, state);
    }
    return state;
  }
}
