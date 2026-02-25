import { describe, it, expect } from 'vitest';
import { computeBackoff, sleepWithAbort } from '../src/backoff.js';

describe('computeBackoff', () => {
  it('attempt=0에서 minDelay 근처 값을 반환한다', () => {
    const delay = computeBackoff(0, { minDelay: 1000, maxDelay: 30000, jitter: false });
    expect(delay).toBe(1000);
  });

  it('attempt 증가에 따라 지수적으로 증가한다', () => {
    const d0 = computeBackoff(0, { jitter: false });
    const d1 = computeBackoff(1, { jitter: false });
    const d2 = computeBackoff(2, { jitter: false });
    expect(d1).toBe(d0 * 2);
    expect(d2).toBe(d0 * 4);
  });

  it('maxDelay를 초과하지 않는다', () => {
    const delay = computeBackoff(20, { minDelay: 1000, maxDelay: 5000, jitter: false });
    expect(delay).toBe(5000);
  });

  it('jitter 활성화 시 기본값보다 크거나 같다', () => {
    const delay = computeBackoff(2, { minDelay: 1000, maxDelay: 30000, jitter: true });
    const base = computeBackoff(2, { minDelay: 1000, maxDelay: 30000, jitter: false });
    expect(delay).toBeGreaterThanOrEqual(base);
  });

  it('기본 옵션으로 동작한다', () => {
    const delay = computeBackoff(0);
    expect(delay).toBeGreaterThanOrEqual(1000);
  });
});

describe('sleepWithAbort', () => {
  it('짧은 시간 sleep이 정상 완료된다', async () => {
    await expect(sleepWithAbort(10)).resolves.toBeUndefined();
  });

  it('이미 abort된 signal로 즉시 reject된다', async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(sleepWithAbort(10000, controller.signal)).rejects.toThrow();
  });

  it('sleep 중 abort 시 reject된다', async () => {
    const controller = new AbortController();
    const promise = sleepWithAbort(10000, controller.signal);
    setTimeout(() => controller.abort(), 10);
    await expect(promise).rejects.toThrow();
  });
});
