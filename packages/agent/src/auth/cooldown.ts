// packages/agent/src/auth/cooldown.ts
import { getEventBus } from '@finclaw/infra';

/** 쿨다운 엔트리 */
export interface CooldownEntry {
  readonly profileId: string;
  readonly reason: string;
  readonly startedAt: number;
  readonly expiresAt: number;
  readonly consecutiveFailures: number;
}

/** 쿨다운 트래커 */
export class CooldownTracker {
  /** 기본 쿨다운 시간 (ms) */
  static readonly DEFAULT_COOLDOWN_MS = 60_000;

  /** 사유별 기본 쿨다운 시간 (ms) */
  static readonly COOLDOWN_DEFAULTS: Record<string, number> = {
    'rate-limit': 60_000, // 1분
    billing: 86_400_000, // 24시간
    'server-error': 300_000, // 5분
    default: 60_000,
  };

  /** 지수 백오프 상한 (ms) */
  private static readonly MAX_BACKOFF_MS = 300_000; // 5분

  private readonly cooldowns = new Map<string, CooldownEntry>();

  /**
   * 프로필을 쿨다운 상태로 전환
   *
   * @param profileId 프로필 ID
   * @param reason 쿨다운 사유 (rate-limit, billing, server-error 등)
   * @param retryAfterMs Retry-After 헤더 값 (최우선)
   */
  setCooldown(profileId: string, reason = 'default', retryAfterMs?: number): void {
    const existing = this.cooldowns.get(profileId);
    const consecutiveFailures = (existing?.consecutiveFailures ?? 0) + 1;

    // 쿨다운 시간 결정: retryAfterMs > 사유별 기본값 > 지수 백오프
    let durationMs: number;
    if (retryAfterMs !== undefined) {
      durationMs = retryAfterMs;
    } else {
      const baseDuration =
        CooldownTracker.COOLDOWN_DEFAULTS[reason] ?? CooldownTracker.DEFAULT_COOLDOWN_MS;
      // 연속 실패 시 지수 백오프: base * 2^(failures - 1)
      // 상한은 baseDuration과 MAX_BACKOFF_MS 중 큰 값 (사유별 기본값 보장)
      const backoff = baseDuration * Math.pow(2, consecutiveFailures - 1);
      durationMs = Math.min(backoff, Math.max(baseDuration, CooldownTracker.MAX_BACKOFF_MS));
    }

    const now = Date.now();
    this.cooldowns.set(profileId, {
      profileId,
      reason,
      startedAt: now,
      expiresAt: now + durationMs,
      consecutiveFailures,
    });

    getEventBus().emit('auth:cooldown', profileId, reason, durationMs);
  }

  /**
   * 프로필이 쿨다운 중인지 확인
   * 만료 시 엔트리 삭제 (consecutiveFailures도 리셋)
   */
  isInCooldown(profileId: string): boolean {
    const entry = this.cooldowns.get(profileId);
    if (!entry) {
      return false;
    }
    if (Date.now() >= entry.expiresAt) {
      this.cooldowns.delete(profileId);
      return false;
    }
    return true;
  }

  /** 잔여 쿨다운 시간 (ms) */
  getRemainingMs(profileId: string): number {
    const entry = this.cooldowns.get(profileId);
    if (!entry) {
      return 0;
    }
    return Math.max(0, entry.expiresAt - Date.now());
  }

  /** 쿨다운 수동 해제 */
  clearCooldown(profileId: string): void {
    this.cooldowns.delete(profileId);
  }

  /** 만료된 쿨다운 일괄 정리 */
  pruneExpired(): void {
    const now = Date.now();
    for (const [id, entry] of this.cooldowns) {
      if (now >= entry.expiresAt) {
        this.cooldowns.delete(id);
      }
    }
  }
}
