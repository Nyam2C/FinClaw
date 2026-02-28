// packages/agent/src/models/fallback.ts
import { sleepWithAbort, computeBackoff, getEventBus } from '@finclaw/infra';
import type { FallbackReason } from '../errors.js';
import type { UnresolvedModelRef, ResolvedModel } from './selection.js';
import { classifyFallbackError } from '../errors.js';
import { getBreakerForProvider } from '../providers/adapter.js';

/** FallbackReason의 별칭 (fallback 컨텍스트 가독성용) */
export type FallbackTrigger = FallbackReason;

/** 폴백 체인 설정 */
export interface FallbackConfig {
  /** 시도할 모델 목록 (우선순위 순) */
  readonly models: readonly UnresolvedModelRef[];
  /** 모델별 최대 재시도 횟수 */
  readonly maxRetriesPerModel: number;
  /** 재시도 기본 간격 (ms) */
  readonly retryBaseDelayMs: number;
  /** 폴백 사유 필터 */
  readonly fallbackOn: readonly FallbackTrigger[];
  /** 취소 시그널 */
  readonly abortSignal?: AbortSignal;
}

/** 폴백 실행 결과 */
export interface FallbackResult<T> {
  readonly result: T;
  readonly modelUsed: ResolvedModel;
  readonly attempts: readonly FallbackAttempt[];
}

/** 개별 시도 기록 */
export interface FallbackAttempt {
  readonly model: ResolvedModel;
  readonly success: boolean;
  readonly error?: Error;
  readonly durationMs: number;
}

/**
 * 기본 fallbackOn (context-overflow 의도적 미포함):
 * 더 작은 컨텍스트 윈도우 모델로 폴백하면 동일 에러 반복.
 */
export const DEFAULT_FALLBACK_TRIGGERS: readonly FallbackTrigger[] = [
  'rate-limit',
  'server-error',
  'timeout',
  'model-unavailable',
];

/**
 * 폴백 체인 실행
 *
 * 1. models 순회, 각 모델마다 CircuitBreaker 확인
 * 2. maxRetriesPerModel만큼 재시도
 * 3. 실패 시 classifyFallbackError로 분류 → fallbackOn 해당 시 다음 모델
 * 4. AbortError는 즉시 rethrow
 * 5. 모든 모델 소진 시 AggregateError throw
 */
export async function runWithModelFallback<T>(
  config: FallbackConfig,
  fn: (model: ResolvedModel) => Promise<T>,
  resolve: (ref: UnresolvedModelRef) => ResolvedModel,
): Promise<FallbackResult<T>> {
  const attempts: FallbackAttempt[] = [];
  const bus = getEventBus();

  let previousModelId: string | undefined;

  for (const modelRef of config.models) {
    const resolved = resolve(modelRef);

    // CircuitBreaker: open 상태면 이 제공자 건너뛰기
    // TODO(L4): circuit.execute() 내부 CircuitBreakerOpenError가 classifyFallbackError에 미매핑.
    // 현재는 getState() 선 검사로 우회되므로 실질적 영향 없음.
    const circuit = getBreakerForProvider(resolved.provider);
    if (circuit.getState() === 'open') {
      continue;
    }

    // 모델 전환 시에만 fallback 이벤트 발행 (재시도는 제외)
    if (previousModelId !== undefined && previousModelId !== resolved.modelId) {
      const lastTrigger = classifyFallbackError(attempts.at(-1)?.error ?? new Error('unknown'));
      bus.emit(
        'model:fallback',
        previousModelId,
        resolved.modelId,
        lastTrigger ?? 'model-unavailable',
      );
    }

    for (let retry = 0; retry <= config.maxRetriesPerModel; retry++) {
      const startTime = performance.now();
      try {
        const result = await circuit.execute(() => fn(resolved));
        attempts.push({
          model: resolved,
          success: true,
          durationMs: performance.now() - startTime,
        });
        return { result, modelUsed: resolved, attempts };
      } catch (error) {
        const err = error instanceof Error ? error : new Error(String(error));

        // AbortError: 사용자 취소 → 즉시 전파
        if (err.name === 'AbortError') {
          throw err;
        }

        attempts.push({
          model: resolved,
          success: false,
          error: err,
          durationMs: performance.now() - startTime,
        });

        // 폴백 트리거 해당 여부 확인
        const trigger = classifyFallbackError(err);
        if (!trigger || !config.fallbackOn.includes(trigger)) {
          throw err; // 폴백 대상이 아닌 에러 → 즉시 throw
        }

        // 동일 모델 재시도 전 대기
        if (retry < config.maxRetriesPerModel) {
          const delayMs = computeBackoff(retry, { minDelay: config.retryBaseDelayMs });
          await sleepWithAbort(delayMs, config.abortSignal);
        }
      }
    }

    previousModelId = resolved.modelId;
  }

  // 모든 모델 소진
  const lastError = attempts.at(-1)?.error ?? new Error('All models exhausted');
  const modelIds = config.models.map((m) => m.raw);
  bus.emit('model:exhausted', modelIds, lastError.message);
  throw new AggregateError(
    attempts
      .filter((a): a is FallbackAttempt & { error: Error } => a.error !== undefined)
      .map((a) => a.error),
    `All ${config.models.length} models failed: ${lastError.message}`,
  );
}
