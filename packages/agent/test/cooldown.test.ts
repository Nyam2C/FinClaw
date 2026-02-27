import { resetEventBus } from '@finclaw/infra';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { CooldownTracker } from '../src/auth/cooldown.js';

describe('CooldownTracker', () => {
  let tracker: CooldownTracker;

  beforeEach(() => {
    vi.useFakeTimers();
    tracker = new CooldownTracker();
  });

  afterEach(() => {
    vi.useRealTimers();
    resetEventBus();
  });

  it('setCooldown 후 isInCooldown = true', () => {
    tracker.setCooldown('p1');
    expect(tracker.isInCooldown('p1')).toBe(true);
  });

  it('DEFAULT_COOLDOWN_MS 경과 후 쿨다운 만료', () => {
    tracker.setCooldown('p1');
    expect(tracker.isInCooldown('p1')).toBe(true);

    vi.advanceTimersByTime(CooldownTracker.DEFAULT_COOLDOWN_MS);
    expect(tracker.isInCooldown('p1')).toBe(false);
  });

  it('billing 사유 → 24시간 쿨다운', () => {
    tracker.setCooldown('p1', 'billing');
    vi.advanceTimersByTime(86_400_000 - 1);
    expect(tracker.isInCooldown('p1')).toBe(true);

    vi.advanceTimersByTime(1);
    expect(tracker.isInCooldown('p1')).toBe(false);
  });

  it('server-error 사유 → 5분 쿨다운', () => {
    tracker.setCooldown('p1', 'server-error');
    vi.advanceTimersByTime(300_000 - 1);
    expect(tracker.isInCooldown('p1')).toBe(true);

    vi.advanceTimersByTime(1);
    expect(tracker.isInCooldown('p1')).toBe(false);
  });

  it('retryAfterMs 우선 적용', () => {
    tracker.setCooldown('p1', 'rate-limit', 5_000);
    vi.advanceTimersByTime(5_000);
    expect(tracker.isInCooldown('p1')).toBe(false);
  });

  it('연속 실패 시 지수 백오프', () => {
    // 첫 실패: 60s
    tracker.setCooldown('p1', 'rate-limit');
    const remaining1 = tracker.getRemainingMs('p1');
    expect(remaining1).toBeLessThanOrEqual(60_000);

    vi.advanceTimersByTime(60_000);

    // 두 번째 실패: 120s (60 * 2^1)
    tracker.setCooldown('p1', 'rate-limit');
    const remaining2 = tracker.getRemainingMs('p1');
    expect(remaining2).toBeGreaterThan(60_000);
    expect(remaining2).toBeLessThanOrEqual(120_000);
  });

  it('쿨다운 만료 시 consecutiveFailures 리셋', () => {
    tracker.setCooldown('p1', 'rate-limit');
    vi.advanceTimersByTime(CooldownTracker.DEFAULT_COOLDOWN_MS);
    expect(tracker.isInCooldown('p1')).toBe(false);

    // 리셋 후 다시 쿨다운 → 초기 시간(지수 백오프 없이)
    tracker.setCooldown('p1', 'rate-limit');
    const remaining = tracker.getRemainingMs('p1');
    expect(remaining).toBeLessThanOrEqual(60_000);
  });

  it('clearCooldown 수동 해제', () => {
    tracker.setCooldown('p1');
    tracker.clearCooldown('p1');
    expect(tracker.isInCooldown('p1')).toBe(false);
  });

  it('pruneExpired 만료된 엔트리 정리', () => {
    tracker.setCooldown('p1');
    tracker.setCooldown('p2');
    vi.advanceTimersByTime(CooldownTracker.DEFAULT_COOLDOWN_MS);
    tracker.pruneExpired();
    expect(tracker.isInCooldown('p1')).toBe(false);
    expect(tracker.isInCooldown('p2')).toBe(false);
  });

  it('getRemainingMs 정확도', () => {
    tracker.setCooldown('p1');
    vi.advanceTimersByTime(30_000);
    const remaining = tracker.getRemainingMs('p1');
    expect(remaining).toBeCloseTo(30_000, -2); // ±100ms
  });

  it('쿨다운 중이 아닌 프로필 → getRemainingMs = 0', () => {
    expect(tracker.getRemainingMs('nonexistent')).toBe(0);
  });
});
