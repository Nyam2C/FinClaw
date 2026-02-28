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
    id: 'claude-opus-4-6',
    provider: 'anthropic',
    displayName: 'Claude Opus 4.6',
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
    id: 'gpt-4o',
    provider: 'openai',
    displayName: 'GPT-4o',
    contextWindow: 128_000,
    maxOutputTokens: 16_384,
    capabilities: {
      vision: true,
      functionCalling: true,
      streaming: true,
      jsonMode: true,
      extendedThinking: false,
      numericalReasoningTier: 'medium',
    },
    pricing: { inputPerMillion: 2.5, outputPerMillion: 10 },
    aliases: ['gpt4o', '4o'],
    deprecated: false,
    releaseDate: '2024-05-13',
  },
  {
    id: 'claude-haiku-3.5',
    provider: 'anthropic',
    displayName: 'Claude Haiku 3.5',
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
    aliases: ['haiku', 'haiku-3.5', 'claude-haiku'],
    deprecated: false,
    releaseDate: '2024-10-29',
  },
  {
    id: 'gpt-4o-mini',
    provider: 'openai',
    displayName: 'GPT-4o mini',
    contextWindow: 128_000,
    maxOutputTokens: 16_384,
    capabilities: {
      vision: true,
      functionCalling: true,
      streaming: true,
      jsonMode: true,
      extendedThinking: false,
      numericalReasoningTier: 'low',
    },
    pricing: { inputPerMillion: 0.15, outputPerMillion: 0.6 },
    aliases: ['4o-mini', 'gpt4o-mini'],
    deprecated: false,
    releaseDate: '2024-07-18',
  },
  {
    id: 'o3',
    provider: 'openai',
    displayName: 'o3',
    contextWindow: 200_000,
    maxOutputTokens: 100_000,
    capabilities: {
      vision: true,
      functionCalling: true,
      streaming: true,
      jsonMode: true,
      extendedThinking: true,
      numericalReasoningTier: 'high',
    },
    pricing: { inputPerMillion: 10, outputPerMillion: 40 },
    aliases: [],
    deprecated: false,
    releaseDate: '2025-04-16',
  },
];

/** 권장 폴백 체인 순서 */
export const DEFAULT_FALLBACK_CHAIN = [
  'claude-opus-4-6',
  'claude-sonnet-4-6',
  'claude-haiku-3.5',
  'gpt-4o',
  'gpt-4o-mini',
] as const;
