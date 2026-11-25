// packages/agent/src/models/catalog-data.ts
import type { ModelEntry } from './catalog.js';

/** 내장 모델 카탈로그 데이터 (3종 — Claude 전용, Phase 38). analyze_market 비용 기록용 가격만 보유. */
export const BUILT_IN_MODELS: readonly ModelEntry[] = [
  { id: 'claude-opus-4-7', pricing: { inputPerMillion: 15, outputPerMillion: 75 } },
  { id: 'claude-sonnet-4-6', pricing: { inputPerMillion: 3, outputPerMillion: 15 } },
  { id: 'claude-haiku-4-5-20251001', pricing: { inputPerMillion: 0.8, outputPerMillion: 4 } },
];
