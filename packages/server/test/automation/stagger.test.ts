import { describe, it, expect } from 'vitest';
import {
  DEFAULT_TOP_OF_HOUR_STAGGER_MS,
  isRecurringTopOfHourCronExpr,
  resolveCronStaggerMs,
} from '../../src/automation/stagger.js';

describe('isRecurringTopOfHourCronExpr', () => {
  it('returns true for "0 * * * *"', () => {
    expect(isRecurringTopOfHourCronExpr('0 * * * *')).toBe(true);
  });
  it('returns false for "*/5 * * * *"', () => {
    expect(isRecurringTopOfHourCronExpr('*/5 * * * *')).toBe(false);
  });
  it('returns true for "0 */2 * * *" (매 2시간 정각)', () => {
    expect(isRecurringTopOfHourCronExpr('0 */2 * * *')).toBe(true);
  });
  it('returns false for "30 * * * *" (정각 아님)', () => {
    expect(isRecurringTopOfHourCronExpr('30 * * * *')).toBe(false);
  });
});

describe('resolveCronStaggerMs', () => {
  it('returns 0 for non-top-of-hour', () => {
    expect(resolveCronStaggerMs({ cron: '*/5 * * * *' })).toBe(0);
  });
  it('returns DEFAULT for top-of-hour', () => {
    expect(resolveCronStaggerMs({ cron: '0 * * * *' })).toBe(DEFAULT_TOP_OF_HOUR_STAGGER_MS);
  });
  it('honors explicit staggerMs over default', () => {
    expect(resolveCronStaggerMs({ cron: '0 * * * *', staggerMs: 60_000 })).toBe(60_000);
  });
});
