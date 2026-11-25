// packages/server/src/automation/stagger.test.ts
// Phase 46 M8 (B5): 결정적 stagger.
import { describe, expect, it } from 'vitest';
import { DEFAULT_TOP_OF_HOUR_STAGGER_MS, nextStaggeredRunAt, staggerOffsetMs } from './stagger.js';

const T = Date.UTC(2026, 10, 26, 1, 30, 0); // 01:30 UTC

describe('staggerOffsetMs', () => {
  it('같은 id → 같은 오프셋, 범위 [0, staggerMs)', () => {
    const a = staggerOffsetMs('sched-a', DEFAULT_TOP_OF_HOUR_STAGGER_MS);
    expect(staggerOffsetMs('sched-a', DEFAULT_TOP_OF_HOUR_STAGGER_MS)).toBe(a);
    expect(a).toBeGreaterThanOrEqual(0);
    expect(a).toBeLessThan(DEFAULT_TOP_OF_HOUR_STAGGER_MS);
  });

  it('stagger 0 이면 0', () => {
    expect(staggerOffsetMs('sched-a', 0)).toBe(0);
  });
});

describe('nextStaggeredRunAt', () => {
  it('정각 cron: 다음 정각 + 결정적 오프셋', () => {
    const next = nextStaggeredRunAt({ id: 'sched-a', cron: '0 * * * *' }, T);
    expect(next).toBe(
      Date.UTC(2026, 10, 26, 2, 0, 0) + staggerOffsetMs('sched-a', DEFAULT_TOP_OF_HOUR_STAGGER_MS),
    );
  });

  it('정각이 아닌 cron 은 오프셋 0', () => {
    expect(nextStaggeredRunAt({ id: 'sched-a', cron: '15 * * * *' }, T)).toBe(
      Date.UTC(2026, 10, 26, 1, 15, 0) + 60 * 60_000,
    );
  });
});
