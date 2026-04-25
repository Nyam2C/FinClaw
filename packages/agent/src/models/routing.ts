// packages/agent/src/models/routing.ts
import type { ModelTier, RoutingConfig, ToolMetadata } from '@finclaw/types';

const TIER_RANK: Record<ModelTier, number> = { haiku: 0, sonnet: 1, opus: 2 };
const RANK_TO_TIER: ReadonlyArray<ModelTier> = ['haiku', 'sonnet', 'opus'];

export type ModelRole = 'fetch' | 'chat' | 'analysis' | 'summarize';

export interface RouteRequest {
  readonly role: ModelRole;
  readonly availableTools: ReadonlyArray<ToolMetadata>;
  readonly userHint?: ModelTier;
  readonly automation?: boolean;
}

export interface RouteDecision {
  readonly tier: ModelTier;
  /** fallback chain 절단 하한선 (밀스톤 D 의 strictFallback 에서 사용) */
  readonly floor: ModelTier;
  readonly reason: string;
  readonly overriddenBy: 'role' | 'tool_min' | 'hint';
}

export function maxTier(...tiers: ReadonlyArray<ModelTier | undefined>): ModelTier {
  let max = 0;
  for (const t of tiers) {
    if (t === undefined) {
      continue;
    }
    const rank = TIER_RANK[t];
    if (rank > max) {
      max = rank;
    }
  }
  return RANK_TO_TIER[max];
}

/** 도구 세트의 minModel 최댓값 — fallback chain 의 floor 가 된다. */
export function computeFloor(tools: ReadonlyArray<ToolMetadata>): ModelTier {
  if (tools.length === 0) {
    return 'haiku';
  }
  return maxTier(...tools.map((t) => t.minModel ?? 'haiku'));
}

/**
 * 역할(A) + 도구 최대 minModel(C) + 사용자 hint → 모델 결정.
 * - hint 미지정: max(A, C)
 * - hint 지정: max(hint, C) — hint 가 C 미만이면 C 가 승리 (B6 결정: respectMinModel)
 * - cfg.override.allowClientHint=false → hint 무시
 */
export function resolveModelForRequest(req: RouteRequest, cfg: RoutingConfig): RouteDecision {
  const a = cfg.roles[req.role].preferred;
  const c = computeFloor(req.availableTools);
  const hintAllowed = cfg.override.allowClientHint;
  const hint = hintAllowed ? req.userHint : undefined;

  let chosen: ModelTier;
  let overriddenBy: 'role' | 'tool_min' | 'hint';

  if (hint !== undefined) {
    chosen = maxTier(hint, c);
    overriddenBy = chosen === c && c !== hint ? 'tool_min' : 'hint';
  } else {
    chosen = maxTier(a, c);
    overriddenBy = chosen === c && c !== a ? 'tool_min' : 'role';
  }

  return {
    tier: chosen,
    floor: c,
    reason: `A=${a}, C=${c}, hint=${hint ?? 'none'} → ${chosen} (${overriddenBy})`,
    overriddenBy,
  };
}

/** ModelTier → 카탈로그 모델 ID. catalog-data.ts 의 BUILT_IN_MODELS 와 동기. */
export function tierToModelId(tier: ModelTier): string {
  switch (tier) {
    case 'haiku':
      return 'claude-haiku-4-5-20251001';
    case 'sonnet':
      return 'claude-sonnet-4-6';
    case 'opus':
      return 'claude-opus-4-7';
  }
}

/** 모델 ID → ModelTier. fallback floor 비교에 사용. */
export function modelIdToTier(modelId: string): ModelTier {
  if (modelId.includes('opus')) {
    return 'opus';
  }
  if (modelId.includes('sonnet')) {
    return 'sonnet';
  }
  return 'haiku';
}
