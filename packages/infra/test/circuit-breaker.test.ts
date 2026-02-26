import { describe, it, expect, beforeEach } from 'vitest';
import { CircuitBreaker, createCircuitBreaker } from '../src/circuit-breaker.js';

describe('CircuitBreaker', () => {
  let cb: CircuitBreaker;

  beforeEach(() => {
    cb = createCircuitBreaker({ failureThreshold: 3, resetTimeoutMs: 100 });
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

    // resetTimeout 경과 대기
    await new Promise((r) => setTimeout(r, 150));

    // half-open에서 성공 → closed
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

    await new Promise((r) => setTimeout(r, 60));

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
});
