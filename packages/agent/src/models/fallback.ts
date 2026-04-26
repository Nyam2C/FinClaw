import type { ModelTier } from '@finclaw/types';
// packages/agent/src/models/fallback.ts
import { sleepWithAbort, computeBackoff, getEventBus } from '@finclaw/infra';
import type { FallbackReason } from '../errors.js';
import type { UnresolvedModelRef, ResolvedModel } from './selection.js';
import { classifyFallbackError } from '../errors.js';
import { getBreakerForProvider } from '../providers/adapter.js';
import { modelIdToTier } from './routing.js';

/**
 * 라우터 결정 floor 미만으로 fallback 이 차단된 경우 throw 되는 에러 (Phase 24, B6).
 *
 * 예: analyze_market 도구 (minModel=opus) 가 활성화된 요청에서 Opus 가 503 일 때,
 * Sonnet/Haiku 로 다운그레이드하면 도구 동작이 보장되지 않으므로 차단하고 사용자에게
 * 한국어 안내 ("Opus 모델 일시 불가, 약 60초 후 재시도") 를 반환한다.
 */
export class ModelFloorExhaustedError extends Error {
  constructor(
    public readonly floor: ModelTier,
    public readonly chainAttempted: ReadonlyArray<string>,
    public readonly lastError: Error,
  ) {
    super(
      `No model at or above tier ${floor} succeeded. Attempted: ${chainAttempted.join(', ') || '(none — chain empty after floor filter)'}`,
    );
    this.name = 'ModelFloorExhaustedError';
  }
}

const TIER_RANK: Record<ModelTier, number> = { haiku: 0, sonnet: 1, opus: 2 };

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
  /**
   * Phase 24: 라우터 floor 하한선 — 이 tier 미만 모델은 chain 에서 제거되고
   * 모두 실패 시 ModelFloorExhaustedError throw. 미설정 시 기존 동작
   * (AggregateError) 유지.
   */
  readonly floor?: ModelTier;
  /** Phase 24: 자동화 컨텍스트 — strictFallback 와 함께 floor tier 외 시도 차단 */
  readonly automation?: boolean;
  /** Phase 24: 자동화 시 동일 tier 만 시도 (escalation/degradation 모두 차단) */
  readonly strictFallback?: boolean;
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

  // Phase 24: floor 가 지정되면 chain 사전 필터링.
  // - floor 미만 모델 제거 (ex: floor=opus → sonnet/haiku 제거)
  // - automation + strictFallback: 동일 tier 만 (ex: floor=sonnet 이고 chain=[opus,sonnet] → [sonnet])
  let effectiveModels: readonly UnresolvedModelRef[] = config.models;
  if (config.floor !== undefined) {
    const floorRank = TIER_RANK[config.floor];
    effectiveModels = config.models.filter((m) => TIER_RANK[modelIdToTier(m.raw)] >= floorRank);
    if (config.automation && config.strictFallback) {
      effectiveModels = effectiveModels.filter(
        (m) => TIER_RANK[modelIdToTier(m.raw)] === floorRank,
      );
    }
    if (effectiveModels.length === 0) {
      throw new ModelFloorExhaustedError(
        config.floor,
        [],
        new Error('chain is empty after floor filter'),
      );
    }
  }

  let previousModelId: string | undefined;

  for (const modelRef of effectiveModels) {
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
  const modelIds = effectiveModels.map((m) => m.raw);
  bus.emit('model:exhausted', modelIds, lastError.message);

  // Phase 24: floor 가 지정된 경우 ModelFloorExhaustedError 로 wrap
  // (caller 가 user-facing 한국어 메시지로 변환).
  if (config.floor !== undefined) {
    throw new ModelFloorExhaustedError(config.floor, modelIds, lastError);
  }

  throw new AggregateError(
    attempts
      .filter((a): a is FallbackAttempt & { error: Error } => a.error !== undefined)
      .map((a) => a.error),
    `All ${effectiveModels.length} models failed: ${lastError.message}`,
  );
}
