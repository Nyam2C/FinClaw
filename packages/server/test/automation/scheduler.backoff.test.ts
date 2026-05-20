import { describe, it, expect } from 'vitest';
import { errorBackoffMs } from '../../src/automation/scheduler.js';

describe('errorBackoffMs', () => {
  it('returns 30s for 1st error', () => {
    expect(errorBackoffMs(1)).toBe(30_000);
  });
  it('returns 60s for 2nd error', () => {
    expect(errorBackoffMs(2)).toBe(60_000);
  });
  it('returns 5m for 3rd error', () => {
    expect(errorBackoffMs(3)).toBe(5 * 60_000);
  });
  it('returns 15m for 4th error', () => {
    expect(errorBackoffMs(4)).toBe(15 * 60_000);
  });
  it('returns 60m for 5th error', () => {
    expect(errorBackoffMs(5)).toBe(60 * 60_000);
  });
  it('caps at 60m for 10th error', () => {
    expect(errorBackoffMs(10)).toBe(60 * 60_000);
  });
  it('returns 30s for 0 (defensive)', () => {
    expect(errorBackoffMs(0)).toBe(30_000);
  });
});
