// packages/agent/src/models/catalog-data.ts
import type { ModelEntry } from './catalog.js';

/**
 * 내장 모델 카탈로그 데이터 (6종)
 *
 * TODO(M6): config.models.definitions에서 읽어 registerModel()로 등록하는 초기화 로직 추가.
 * 이 하드코딩 데이터는 폴백 기본값으로만 유지할 것.
 */
export const BUILT_IN_MODELS: readonly ModelEntry[] = [
  {
    id: 'claude-opus-4-7',
    provider: 'anthropic',
    displayName: 'Claude Opus 4.7',
    contextWindow: 200_000,
    maxOutputTokens: 32_768,
    capabilities: {
      vision: true,
      functionCalling: true,
      streaming: true,
      jsonMode: true,
      extendedThinking: true,
      numericalReasoningTier: 'high',
    },
    pricing: { inputPerMillion: 15, outputPerMillion: 75 },
    aliases: ['opus', 'opus-4', 'claude-opus'],
    deprecated: false,
    releaseDate: '2025-05-22',
  },
  {
    id: 'claude-sonnet-4-6',
    provider: 'anthropic',
    displayName: 'Claude Sonnet 4.6',
    contextWindow: 200_000,
    maxOutputTokens: 16_384,
    capabilities: {
      vision: true,
      functionCalling: true,
      streaming: true,
      jsonMode: true,
      extendedThinking: true,
      numericalReasoningTier: 'medium',
    },
    pricing: { inputPerMillion: 3, outputPerMillion: 15 },
    aliases: ['sonnet', 'sonnet-4', 'claude-sonnet'],
    deprecated: false,
    releaseDate: '2025-05-22',
  },
  {
    id: 'claude-haiku-4-5-20251001',
    provider: 'anthropic',
    displayName: 'Claude Haiku 4.5',
    contextWindow: 200_000,
    maxOutputTokens: 8_192,
    capabilities: {
      vision: true,
      functionCalling: true,
      streaming: true,
      jsonMode: true,
      extendedThinking: false,
      numericalReasoningTier: 'low',
    },
    pricing: { inputPerMillion: 0.8, outputPerMillion: 4 },
    aliases: ['haiku', 'haiku-4.5', 'claude-haiku'],
    deprecated: false,
    releaseDate: '2025-10-01',
  },
];

/** 권장 폴백 체인 순서 */
export const DEFAULT_FALLBACK_CHAIN = [
  'claude-opus-4-7',
  'claude-sonnet-4-6',
  'claude-haiku-4-5-20251001',
] as const;
