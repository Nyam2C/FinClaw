import { resetEventBus } from '@finclaw/infra';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { FallbackConfig } from '../src/models/fallback.js';
import type { ResolvedModel } from '../src/models/selection.js';
import { FailoverError } from '../src/errors.js';
import { runWithModelFallback, DEFAULT_FALLBACK_TRIGGERS } from '../src/models/fallback.js';
import { resetBreakers } from '../src/providers/adapter.js';

// 모킹 helpers
function makeResolved(id: string, provider: 'anthropic' | 'openai' = 'anthropic'): ResolvedModel {
  return {
    entry: { id, provider } as unknown as ResolvedModel['entry'],
    provider,
    modelId: id,
    resolvedFrom: 'id',
  };
}

function makeConfig(overrides?: Partial<FallbackConfig>): FallbackConfig {
  return {
    models: [{ raw: 'model-a' }, { raw: 'model-b' }],
    maxRetriesPerModel: 1,
    retryBaseDelayMs: 10,
    fallbackOn: [...DEFAULT_FALLBACK_TRIGGERS],
    ...overrides,
  };
}

describe('runWithModelFallback', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    resetBreakers();
  });

  afterEach(() => {
    vi.useRealTimers();
    resetEventBus();
    resetBreakers();
  });

  const resolveMap: Record<string, ResolvedModel> = {
    'model-a': makeResolved('model-a'),
    'model-b': makeResolved('model-b', 'openai'),
  };
  const resolve = (ref: { raw: string }) => resolveMap[ref.raw];

  it('첫 모델 성공 → 폴백 없이 반환', async () => {
    const fn = vi.fn().mockResolvedValue('success');
    const result = await runWithModelFallback(makeConfig(), fn, resolve);
    expect(result.result).toBe('success');
    expect(result.modelUsed.modelId).toBe('model-a');
    expect(result.attempts).toHaveLength(1);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('첫 모델 rate-limit → 두 번째 모델로 폴백', async () => {
    const rateLimitErr = new FailoverError('rate limited', 'rate-limit', { statusCode: 429 });
    const fn = vi
      .fn()
      .mockRejectedValueOnce(rateLimitErr)
      .mockRejectedValueOnce(rateLimitErr) // retry
      .mockResolvedValueOnce('fallback-success');

    const promise = runWithModelFallback(makeConfig(), fn, resolve);
    // sleepWithAbort 대기 처리
    await vi.advanceTimersByTimeAsync(100);
    const result = await promise;

    expect(result.result).toBe('fallback-success');
    expect(result.modelUsed.modelId).toBe('model-b');
    expect(result.attempts.length).toBeGreaterThan(1);
  });

  it('모든 모델 소진 → AggregateError', async () => {
    const err = new FailoverError('server error', 'server-error', { statusCode: 500 });
    const fn = vi.fn().mockRejectedValue(err);

    const promise = runWithModelFallback(makeConfig(), fn, resolve);
    await vi.advanceTimersByTimeAsync(10_000);

    await expect(promise).rejects.toThrow(AggregateError);
  });

  it('비폴백 에러 (401) → 즉시 throw', async () => {
    const authErr = Object.assign(new Error('unauthorized'), { status: 401 });
    const fn = vi.fn().mockRejectedValue(authErr);

    await expect(runWithModelFallback(makeConfig(), fn, resolve)).rejects.toThrow('unauthorized');
    expect(fn).toHaveBeenCalledTimes(1); // 재시도 없음
  });

  it('AbortError → 즉시 throw', async () => {
    const abortErr = new Error('aborted');
    abortErr.name = 'AbortError';
    const fn = vi.fn().mockRejectedValue(abortErr);

    await expect(runWithModelFallback(makeConfig(), fn, resolve)).rejects.toThrow('aborted');
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('context-overflow는 기본 fallbackOn에 없음 → 즉시 throw', async () => {
    const ctxErr = new FailoverError('context', 'context-overflow');
    const fn = vi.fn().mockRejectedValue(ctxErr);

    await expect(runWithModelFallback(makeConfig(), fn, resolve)).rejects.toThrow('context');
  });

  it('context-overflow를 fallbackOn에 명시 → 폴백 트리거', async () => {
    const ctxErr = new FailoverError('context', 'context-overflow');
    const fn = vi
      .fn()
      .mockRejectedValueOnce(ctxErr)
      .mockRejectedValueOnce(ctxErr)
      .mockResolvedValueOnce('ok');

    const config = makeConfig({
      fallbackOn: [...DEFAULT_FALLBACK_TRIGGERS, 'context-overflow'],
    });

    const promise = runWithModelFallback(config, fn, resolve);
    await vi.advanceTimersByTimeAsync(10_000);
    const result = await promise;

    expect(result.result).toBe('ok');
  });

  it('maxRetriesPerModel=0이면 재시도 없이 바로 다음 모델', async () => {
    const err = new FailoverError('rate limit', 'rate-limit');
    const fn = vi.fn().mockRejectedValueOnce(err).mockResolvedValueOnce('second');

    const result = await runWithModelFallback(makeConfig({ maxRetriesPerModel: 0 }), fn, resolve);
    expect(result.modelUsed.modelId).toBe('model-b');
    expect(fn).toHaveBeenCalledTimes(2);
  });
});
