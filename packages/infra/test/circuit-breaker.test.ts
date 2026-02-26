import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { CircuitBreaker, createCircuitBreaker } from '../src/circuit-breaker.js';

describe('CircuitBreaker', () => {
  let cb: CircuitBreaker;

  beforeEach(() => {
    vi.useFakeTimers();
    cb = createCircuitBreaker({ failureThreshold: 3, resetTimeoutMs: 100 });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('closed 상태에서 성공 → closed 유지', async () => {
    await cb.execute(async () => 'ok');
    expect(cb.getState()).toBe('closed');
  });

  it('failureThreshold 도달 → open 전환', async () => {
    for (let i = 0; i < 3; i++) {
      await cb
        .execute(async () => {
          throw new Error('fail');
        })
        .catch(() => {});
    }
    expect(cb.getState()).toBe('open');
    expect(cb.getFailures()).toBe(3);
  });

  it('open 상태에서 즉시 호출 → 에러 throw', async () => {
    for (let i = 0; i < 3; i++) {
      await cb
        .execute(async () => {
          throw new Error('fail');
        })
        .catch(() => {});
    }
    await expect(cb.execute(async () => 'ok')).rejects.toThrow('Circuit is open');
  });

  it('resetTimeoutMs 경과 후 → half-open 전환, 성공 시 closed', async () => {
    for (let i = 0; i < 3; i++) {
      await cb
        .execute(async () => {
          throw new Error('fail');
        })
        .catch(() => {});
    }
    expect(cb.getState()).toBe('open');

    vi.advanceTimersByTime(150);

    const result = await cb.execute(async () => 'recovered');
    expect(result).toBe('recovered');
    expect(cb.getState()).toBe('closed');
    expect(cb.getFailures()).toBe(0);
  });

  it('half-open에서 실패 → open으로 재전환', async () => {
    const fastCb = createCircuitBreaker({ failureThreshold: 1, resetTimeoutMs: 50 });
    await fastCb
      .execute(async () => {
        throw new Error('fail');
      })
      .catch(() => {});
    expect(fastCb.getState()).toBe('open');

    vi.advanceTimersByTime(60);

    await fastCb
      .execute(async () => {
        throw new Error('fail again');
      })
      .catch(() => {});
    expect(fastCb.getState()).toBe('open');
  });

  it('reset()으로 초기 상태 복귀', async () => {
    for (let i = 0; i < 3; i++) {
      await cb
        .execute(async () => {
          throw new Error('fail');
        })
        .catch(() => {});
    }
    cb.reset();
    expect(cb.getState()).toBe('closed');
    expect(cb.getFailures()).toBe(0);
  });

  it('성공하면 실패 카운터가 리셋된다', async () => {
    await cb
      .execute(async () => {
        throw new Error('fail');
      })
      .catch(() => {});
    await cb
      .execute(async () => {
        throw new Error('fail');
      })
      .catch(() => {});
    expect(cb.getFailures()).toBe(2);

    await cb.execute(async () => 'ok');
    expect(cb.getFailures()).toBe(0);
  });

  it('half-open에서 halfOpenMaxAttempts 초과 시 에러 throw', async () => {
    const limitedCb = createCircuitBreaker({
      failureThreshold: 1,
      resetTimeoutMs: 50,
      halfOpenMaxAttempts: 1,
    });

    // open으로 전환
    await limitedCb
      .execute(async () => {
        throw new Error('fail');
      })
      .catch(() => {});
    expect(limitedCb.getState()).toBe('open');

    vi.advanceTimersByTime(60);

    // 느린 probe 시작 (아직 resolve하지 않음 → half-open 슬롯 점유)
    let resolveProbe!: (v: string) => void;
    const probePromise = limitedCb.execute(
      () =>
        new Promise<string>((r) => {
          resolveProbe = r;
        }),
    );

    // 두 번째 요청은 max attempts 초과로 거부
    await expect(limitedCb.execute(async () => 'ok')).rejects.toThrow('max probe attempts');

    // 첫 probe 완료 → closed
    resolveProbe('recovered');
    await probePromise;
    expect(limitedCb.getState()).toBe('closed');
  });
});
