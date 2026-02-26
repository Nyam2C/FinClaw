import { describe, it, expect, vi } from 'vitest';
import { retry, resolveRetryConfig } from '../src/retry.js';

describe('resolveRetryConfig', () => {
  it('기본값을 적용한다', () => {
    const config = resolveRetryConfig();
    expect(config.maxAttempts).toBe(3);
    expect(config.minDelay).toBe(1000);
    expect(config.maxDelay).toBe(30000);
    expect(config.jitter).toBe(true);
  });

  it('부분 설정을 병합한다', () => {
    const config = resolveRetryConfig({ maxAttempts: 5, jitter: false });
    expect(config.maxAttempts).toBe(5);
    expect(config.minDelay).toBe(1000);
    expect(config.jitter).toBe(false);
  });
});

describe('retry', () => {
  it('첫 시도 성공 시 즉시 반환한다', async () => {
    const fn = vi.fn().mockResolvedValue('ok');
    const result = await retry(fn, { maxAttempts: 3, minDelay: 10 });
    expect(result).toBe('ok');
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('일시적 에러 후 재시도하여 성공한다', async () => {
    const err = Object.assign(new Error('fail'), { code: 'ECONNRESET' });
    const fn = vi.fn().mockRejectedValueOnce(err).mockResolvedValue('ok');
    const result = await retry(fn, { maxAttempts: 3, minDelay: 10, jitter: false });
    expect(result).toBe('ok');
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('maxAttempts 초과 시 마지막 에러를 던진다', async () => {
    const err = Object.assign(new Error('fail'), { code: 'ECONNRESET' });
    const fn = vi.fn().mockRejectedValue(err);
    await expect(retry(fn, { maxAttempts: 2, minDelay: 10, jitter: false })).rejects.toThrow(
      'fail',
    );
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('shouldRetry가 false이면 즉시 throw한다', async () => {
    const fn = vi.fn().mockRejectedValue(new Error('fatal'));
    await expect(
      retry(fn, { maxAttempts: 3, minDelay: 10, shouldRetry: () => false }),
    ).rejects.toThrow('fatal');
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('signal이 abort되면 즉시 throw한다', async () => {
    const controller = new AbortController();
    controller.abort();
    const fn = vi.fn().mockResolvedValue('ok');
    await expect(retry(fn, { maxAttempts: 3, signal: controller.signal })).rejects.toThrow(
      'Retry aborted',
    );
    expect(fn).not.toHaveBeenCalled();
  });

  it('onRetry 콜백을 호출한다', async () => {
    const err = Object.assign(new Error('fail'), { code: 'ECONNRESET' });
    const fn = vi.fn().mockRejectedValueOnce(err).mockResolvedValue('ok');
    const onRetry = vi.fn();
    await retry(fn, { maxAttempts: 3, minDelay: 10, jitter: false, onRetry });
    expect(onRetry).toHaveBeenCalledTimes(1);
    expect(onRetry).toHaveBeenCalledWith(err, 0, expect.any(Number));
  });

  it('retryAfterMs가 delay의 최소 보장을 한다', async () => {
    const err = Object.assign(new Error('fail'), { code: 'ECONNRESET' });
    const fn = vi.fn().mockRejectedValueOnce(err).mockResolvedValue('ok');
    const onRetry = vi.fn();
    await retry(fn, {
      maxAttempts: 3,
      minDelay: 10,
      jitter: false,
      retryAfterMs: 100,
      onRetry,
    });
    // delay는 최소 retryAfterMs(100)
    expect(onRetry.mock.calls[0][2]).toBeGreaterThanOrEqual(100);
  });

  it('비일시적 에러는 재시도하지 않는다 (기본 shouldRetry)', async () => {
    const fn = vi.fn().mockRejectedValue(new Error('not transient'));
    await expect(retry(fn, { maxAttempts: 3, minDelay: 10 })).rejects.toThrow('not transient');
    expect(fn).toHaveBeenCalledTimes(1);
  });
});
