import { resetEventBus } from '@finclaw/infra';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { FailoverError } from '../src/errors.js';
import type { FallbackConfig } from '../src/models/fallback.js';
import {
  runWithModelFallback,
  DEFAULT_FALLBACK_TRIGGERS,
  ModelFloorExhaustedError,
} from '../src/models/fallback.js';
import type { ResolvedModel } from '../src/models/selection.js';
import { resetBreakers } from '../src/providers/adapter.js';

// 모킹 helpers
function makeResolved(id: string): ResolvedModel {
  return {
    entry: { id, provider: 'anthropic' } as unknown as ResolvedModel['entry'],
    provider: 'anthropic',
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
    'model-b': makeResolved('model-b'),
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

// Phase 24 (B6) — floor 기반 fallback 차단
describe('runWithModelFallback — floor (B6)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    resetBreakers();
  });

  afterEach(() => {
    vi.useRealTimers();
    resetEventBus();
    resetBreakers();
  });

  // 실제 모델 ID 를 사용해야 modelIdToTier 가 'opus'/'sonnet'/'haiku' 키워드를 감지.
  const tieredResolveMap: Record<string, ResolvedModel> = {
    'claude-opus-4-7': makeResolved('claude-opus-4-7'),
    'claude-sonnet-4-6': makeResolved('claude-sonnet-4-6'),
    'claude-haiku-4-5-20251001': makeResolved('claude-haiku-4-5-20251001'),
  };
  const tieredResolve = (ref: { raw: string }) => tieredResolveMap[ref.raw];

  function tieredConfig(overrides: Partial<FallbackConfig>): FallbackConfig {
    return {
      models: [
        { raw: 'claude-opus-4-7' },
        { raw: 'claude-sonnet-4-6' },
        { raw: 'claude-haiku-4-5-20251001' },
      ],
      maxRetriesPerModel: 0,
      retryBaseDelayMs: 10,
      fallbackOn: [...DEFAULT_FALLBACK_TRIGGERS],
      ...overrides,
    };
  }

  it('floor=opus + Opus 503 → ModelFloorExhaustedError, Sonnet/Haiku 시도 안 함', async () => {
    const err = new FailoverError('503', 'server-error', { statusCode: 503 });
    const fn = vi.fn().mockRejectedValue(err);

    await expect(
      runWithModelFallback(tieredConfig({ floor: 'opus' }), fn, tieredResolve),
    ).rejects.toThrow(ModelFloorExhaustedError);
    expect(fn).toHaveBeenCalledTimes(1); // Opus 만 시도
  });

  it('floor=opus 차단 시 ModelFloorExhaustedError.floor 와 chainAttempted 보존', async () => {
    const err = new FailoverError('503', 'server-error', { statusCode: 503 });
    const fn = vi.fn().mockRejectedValue(err);

    try {
      await runWithModelFallback(tieredConfig({ floor: 'opus' }), fn, tieredResolve);
      expect.fail('should have thrown');
    } catch (e) {
      expect(e).toBeInstanceOf(ModelFloorExhaustedError);
      const fe = e as ModelFloorExhaustedError;
      expect(fe.floor).toBe('opus');
      expect(fe.chainAttempted).toEqual(['claude-opus-4-7']);
      expect(fe.lastError.message).toContain('503');
    }
  });

  it('floor=sonnet + Opus 503 → Sonnet 으로 fallback 후 성공', async () => {
    const err = new FailoverError('503', 'server-error', { statusCode: 503 });
    const fn = vi.fn().mockRejectedValueOnce(err).mockResolvedValueOnce('sonnet-ok');

    const promise = runWithModelFallback(tieredConfig({ floor: 'sonnet' }), fn, tieredResolve);
    await vi.advanceTimersByTimeAsync(100);
    const result = await promise;

    expect(result.result).toBe('sonnet-ok');
    expect(result.modelUsed.modelId).toBe('claude-sonnet-4-6');
    expect(fn).toHaveBeenCalledTimes(2); // Opus → Sonnet
  });

  it('floor=haiku + Opus/Sonnet 503 → Haiku 까지 정상 fallback', async () => {
    const err = new FailoverError('503', 'server-error', { statusCode: 503 });
    const fn = vi
      .fn()
      .mockRejectedValueOnce(err)
      .mockRejectedValueOnce(err)
      .mockResolvedValueOnce('haiku-ok');

    const promise = runWithModelFallback(tieredConfig({ floor: 'haiku' }), fn, tieredResolve);
    await vi.advanceTimersByTimeAsync(200);
    const result = await promise;

    expect(result.result).toBe('haiku-ok');
    expect(result.modelUsed.modelId).toBe('claude-haiku-4-5-20251001');
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it('floor=opus 인데 chain 에 opus 가 없으면 즉시 ModelFloorExhaustedError (chain 빈)', async () => {
    const fn = vi.fn();

    await expect(
      runWithModelFallback(
        {
          models: [{ raw: 'claude-haiku-4-5-20251001' }],
          maxRetriesPerModel: 0,
          retryBaseDelayMs: 10,
          fallbackOn: [...DEFAULT_FALLBACK_TRIGGERS],
          floor: 'opus',
        },
        fn,
        tieredResolve,
      ),
    ).rejects.toThrow(ModelFloorExhaustedError);
    expect(fn).not.toHaveBeenCalled();
  });

  it('automation=true + strictFallback + floor=sonnet → Sonnet 만 시도, Opus/Haiku 무시', async () => {
    const err = new FailoverError('503', 'server-error', { statusCode: 503 });
    const fn = vi.fn().mockRejectedValue(err);

    await expect(
      runWithModelFallback(
        tieredConfig({ floor: 'sonnet', automation: true, strictFallback: true }),
        fn,
        tieredResolve,
      ),
    ).rejects.toThrow(ModelFloorExhaustedError);
    expect(fn).toHaveBeenCalledTimes(1); // Sonnet 만
  });

  // floor 미설정 시 AggregateError 동작은 위 'runWithModelFallback' 그룹의
  // '모든 모델 소진 → AggregateError' 케이스로 커버됨 — 중복 회피.
});

// Phase 29 A — cross-provider 폴백 차단 가드
describe('runWithModelFallback — cross-provider gate (Phase 29 A)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    resetBreakers();
  });

  afterEach(() => {
    vi.useRealTimers();
    resetEventBus();
    resetBreakers();
  });

  // anthropic 1개 + openai 1개 + anthropic 1개 chain.
  const mixedResolve = (ref: { raw: string }): ResolvedModel => {
    const provider = ref.raw.startsWith('gpt') ? 'openai' : 'anthropic';
    return {
      entry: { id: ref.raw, provider } as unknown as ResolvedModel['entry'],
      provider,
      modelId: ref.raw,
      resolvedFrom: 'id',
    };
  };

  it('allowCrossProvider=false (default) — skips models from different provider', async () => {
    const called: string[] = [];
    const err = new FailoverError('rl', 'rate-limit');
    const fn = vi.fn().mockImplementation(async (resolved: ResolvedModel) => {
      called.push(resolved.modelId);
      throw err;
    });

    await expect(
      runWithModelFallback(
        {
          models: [
            { raw: 'claude-sonnet-4-6' },
            { raw: 'gpt-4o' },
            { raw: 'claude-haiku-4-5-20251001' },
          ],
          maxRetriesPerModel: 0,
          retryBaseDelayMs: 1,
          fallbackOn: ['rate-limit'],
        },
        fn,
        mixedResolve,
      ),
    ).rejects.toThrow();
    expect(called).not.toContain('gpt-4o');
    expect(called).toContain('claude-sonnet-4-6');
    expect(called).toContain('claude-haiku-4-5-20251001');
  });

  it('allowCrossProvider=true — visits all providers in chain', async () => {
    const called: string[] = [];
    const err = new FailoverError('rl', 'rate-limit');
    const fn = vi.fn().mockImplementation(async (resolved: ResolvedModel) => {
      called.push(resolved.modelId);
      throw err;
    });

    await expect(
      runWithModelFallback(
        {
          models: [{ raw: 'claude-sonnet-4-6' }, { raw: 'gpt-4o' }],
          maxRetriesPerModel: 0,
          retryBaseDelayMs: 1,
          fallbackOn: ['rate-limit'],
          allowCrossProvider: true,
        },
        fn,
        mixedResolve,
      ),
    ).rejects.toThrow();
    expect(called).toContain('gpt-4o');
  });
});
