import { resetEventBus } from '@finclaw/infra';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { ManagedAuthProfile } from '../src/auth/profiles.js';
import { ProfileHealthMonitor } from '../src/auth/health.js';

describe('ProfileHealthMonitor', () => {
  let monitor: ProfileHealthMonitor;

  beforeEach(() => {
    vi.useFakeTimers();
    monitor = new ProfileHealthMonitor();
  });

  afterEach(() => {
    vi.useRealTimers();
    resetEventBus();
  });

  it('기록이 없으면 healthy', () => {
    expect(monitor.getHealth('p1')).toBe('healthy');
  });

  it('연속 성공 → healthy 유지', () => {
    for (let i = 0; i < 5; i++) {
      monitor.recordResult('p1', true);
    }
    expect(monitor.getHealth('p1')).toBe('healthy');
  });

  it('실패율 30%+ → degraded', () => {
    // 10번 중 4번 실패 = 40%, 연속 실패 최대 2회 (disabled 회피)
    monitor.recordResult('p1', true);
    monitor.recordResult('p1', true);
    monitor.recordResult('p1', false);
    monitor.recordResult('p1', false);
    monitor.recordResult('p1', true);
    monitor.recordResult('p1', true);
    monitor.recordResult('p1', false);
    monitor.recordResult('p1', false);
    monitor.recordResult('p1', true);
    monitor.recordResult('p1', true);
    expect(monitor.getHealth('p1')).toBe('degraded');
  });

  it('실패율 70%+ → unhealthy', () => {
    // maxConsecutiveFailures를 높여서 disabled 회피, 순수 실패율 테스트
    const m = new ProfileHealthMonitor({ maxConsecutiveFailures: 100 });
    for (let i = 0; i < 2; i++) {
      m.recordResult('p1', true);
    }
    for (let i = 0; i < 8; i++) {
      m.recordResult('p1', false);
    }
    expect(m.getHealth('p1')).toBe('unhealthy');
  });

  it('연속 실패 3회 → disabled', () => {
    monitor.recordResult('p1', false);
    monitor.recordResult('p1', false);
    monitor.recordResult('p1', false);
    expect(monitor.getHealth('p1')).toBe('disabled');
  });

  it('성공으로 연속 실패 카운터 리셋', () => {
    monitor.recordResult('p1', false);
    monitor.recordResult('p1', false);
    monitor.recordResult('p1', true); // 리셋
    monitor.recordResult('p1', false);
    // consecutiveFailures = 1 (3 미만) → disabled 아님
    expect(monitor.getHealth('p1')).not.toBe('disabled');
  });

  it('윈도우 밖 기록은 무시', () => {
    // 과거에 실패 다수
    for (let i = 0; i < 10; i++) {
      monitor.recordResult('p1', false);
    }

    // 5분 경과 → 윈도우 밖
    vi.advanceTimersByTime(300_001);

    // 새로운 성공 기록
    monitor.recordResult('p1', true);
    // 윈도우 내 기록: 성공 1개 → healthy
    // (단, consecutiveFailures가 리셋되지 않았을 수 있으므로 recordResult(true)에서 리셋됨)
    expect(monitor.getHealth('p1')).toBe('healthy');
  });

  it('filterHealthy: disabled 프로필 제외', () => {
    monitor.recordResult('p1', false);
    monitor.recordResult('p1', false);
    monitor.recordResult('p1', false); // disabled

    const profiles = [
      { id: 'p1' } as unknown as ManagedAuthProfile,
      { id: 'p2' } as unknown as ManagedAuthProfile,
    ];
    const healthy = monitor.filterHealthy(profiles);
    expect(healthy).toHaveLength(1);
    expect(healthy[0].id).toBe('p2');
  });

  it('getSummary: 모든 추적 프로필의 상태 반환', () => {
    monitor.recordResult('p1', true);
    monitor.recordResult('p2', false);
    monitor.recordResult('p2', false);
    monitor.recordResult('p2', false);

    const summary = monitor.getSummary();
    expect(summary.get('p1')).toBe('healthy');
    expect(summary.get('p2')).toBe('disabled');
  });

  it('커스텀 thresholds 적용', () => {
    const custom = new ProfileHealthMonitor({ maxConsecutiveFailures: 5 });
    for (let i = 0; i < 4; i++) {
      custom.recordResult('p1', false);
    }
    expect(custom.getHealth('p1')).not.toBe('disabled');

    custom.recordResult('p1', false); // 5번째
    expect(custom.getHealth('p1')).toBe('disabled');
  });
});
