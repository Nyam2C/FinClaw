// packages/agent/src/models/provider-normalize.ts
import type { ProviderId, ModelPricing } from './catalog.js';

export type StopReason = 'end_turn' | 'max_tokens' | 'stop_sequence' | 'tool_use';

/** 정규화된 토큰 사용량 */
export interface NormalizedUsage {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheReadTokens: number;
  readonly cacheWriteTokens: number;
  readonly totalTokens: number;
  /** 금융 특화: 예상 비용 (USD) */
  readonly estimatedCostUsd: number;
}

/** 정규화된 AI 응답 */
export interface NormalizedResponse {
  readonly content: string;
  readonly stopReason: StopReason;
  readonly usage: NormalizedUsage;
  readonly modelId: string;
  readonly provider: ProviderId;
  readonly raw: unknown;
}

/** 스트리밍 청크 (타입만 선언, 구현은 Phase 9) */
export interface StreamChunk {
  readonly type: 'text_delta' | 'tool_use_delta' | 'usage' | 'done';
  readonly text?: string;
  readonly usage?: Partial<NormalizedUsage>;
}

/**
 * 비용 계산 헬퍼
 *
 * TODO(L1): cacheReadTokens/cacheWriteTokens 비용 미산정.
 * pricing.cacheReadPerMillion / cacheWritePerMillion 필드를 반영해야 함.
 */
export function calculateEstimatedCost(
  inputTokens: number,
  outputTokens: number,
  pricing: ModelPricing,
): number {
  return (
    (inputTokens / 1_000_000) * pricing.inputPerMillion +
    (outputTokens / 1_000_000) * pricing.outputPerMillion
  );
}

/** 제공자별 응답 정규화 함수 타입 */
export type ResponseNormalizer = (raw: unknown, pricing: ModelPricing) => NormalizedResponse;

/**
 * Anthropic SDK 응답 정규화
 *
 * 필드 매핑:
 * - usage.input_tokens → inputTokens
 * - usage.output_tokens → outputTokens
 * - usage.cache_read_input_tokens → cacheReadTokens
 * - usage.cache_creation_input_tokens → cacheWriteTokens
 * - stop_reason: 'end_turn' | 'max_tokens' | 'stop_sequence' | 'tool_use'
 */
// TODO(M5): raw를 as 캐스트 대신 런타임 검증(zod 등)으로 교체 권장.
// TODO(L5): stop_reason을 직접 캐스트 대신 mapAnthropicStopReason() 헬퍼로 변환 권장.
export function normalizeAnthropicResponse(
  raw: unknown,
  pricing: ModelPricing,
): NormalizedResponse {
  const r = raw as {
    id?: string;
    model?: string;
    content?: Array<{ type: string; text?: string }>;
    stop_reason?: string;
    usage?: {
      input_tokens?: number;
      output_tokens?: number;
      cache_read_input_tokens?: number;
      cache_creation_input_tokens?: number;
    };
  };

  const inputTokens = r.usage?.input_tokens ?? 0;
  const outputTokens = r.usage?.output_tokens ?? 0;
  const cacheReadTokens = r.usage?.cache_read_input_tokens ?? 0;
  const cacheWriteTokens = r.usage?.cache_creation_input_tokens ?? 0;

  const content =
    r.content
      ?.filter((b) => b.type === 'text')
      .map((b) => b.text ?? '')
      .join('') ?? '';

  return {
    content,
    stopReason: (r.stop_reason as StopReason) ?? 'end_turn',
    usage: {
      inputTokens,
      outputTokens,
      cacheReadTokens,
      cacheWriteTokens,
      totalTokens: inputTokens + outputTokens,
      estimatedCostUsd: calculateEstimatedCost(inputTokens, outputTokens, pricing),
    },
    modelId: r.model ?? '',
    provider: 'anthropic',
    raw,
  };
}

/**
 * OpenAI SDK 응답 정규화
 *
 * 필드 매핑:
 * - usage.prompt_tokens → inputTokens
 * - usage.completion_tokens → outputTokens
 * - cacheReadTokens, cacheWriteTokens → 0 (OpenAI N/A)
 * - usage.total_tokens → totalTokens
 * - finish_reason: 'stop' → 'end_turn', 'length' → 'max_tokens', 'tool_calls' → 'tool_use'
 */
// TODO(M5): raw를 as 캐스트 대신 런타임 검증(zod 등)으로 교체 권장.
export function normalizeOpenAIResponse(raw: unknown, pricing: ModelPricing): NormalizedResponse {
  const r = raw as {
    id?: string;
    model?: string;
    choices?: Array<{
      message?: { content?: string | null };
      finish_reason?: string;
    }>;
    usage?: {
      prompt_tokens?: number;
      completion_tokens?: number;
      total_tokens?: number;
    };
  };

  const inputTokens = r.usage?.prompt_tokens ?? 0;
  const outputTokens = r.usage?.completion_tokens ?? 0;
  const content = r.choices?.[0]?.message?.content ?? '';

  const openAiReason = r.choices?.[0]?.finish_reason;
  const stopReason = mapOpenAIFinishReason(openAiReason);

  return {
    content,
    stopReason,
    usage: {
      inputTokens,
      outputTokens,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      totalTokens: r.usage?.total_tokens ?? inputTokens + outputTokens,
      estimatedCostUsd: calculateEstimatedCost(inputTokens, outputTokens, pricing),
    },
    modelId: r.model ?? '',
    provider: 'openai',
    raw,
  };
}

function mapOpenAIFinishReason(reason?: string): StopReason {
  switch (reason) {
    case 'stop':
      return 'end_turn';
    case 'length':
      return 'max_tokens';
    case 'tool_calls':
      return 'tool_use';
    default:
      return 'end_turn';
  }
}

/** 정규화 함수 레지스트리 */
export const normalizers: ReadonlyMap<ProviderId, ResponseNormalizer> = new Map([
  ['anthropic', normalizeAnthropicResponse],
  ['openai', normalizeOpenAIResponse],
]);
