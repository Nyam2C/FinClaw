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
  /**
   * effectiveTier(role + hint) 보다 minModel 이 높아 LLM 에 노출하지 않는 도구를
   * 제외한 결과. respectMinModel=true (기본) 일 때 활성. 호출자는 이 목록만 LLM 에
   * 전달해 minModel 미충족 도구 호출을 원천 차단한다.
   */
  readonly allowedTools: ReadonlyArray<ToolMetadata>;
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
 *
 * Phase 24 보정 (chat → Opus 부작용 해결):
 * - effectiveTier = hint ?? role.preferred (도구 무관)
 * - respectMinModel=true (기본): effectiveTier 보다 minModel 이 높은 도구는 **필터** 하여
 *   LLM 에 노출하지 않음. 결과적으로 floor ≤ effectiveTier 가 보장되어 chosen=effectiveTier.
 *   "안녕" 같은 일반 채팅에서 analyze_market(opus) 가 등록되어도 sonnet 으로 라우팅됨.
 * - respectMinModel=false: 필터 없이 모든 도구가 LLM 에 노출되고, 도구 minModel 이 높으면
 *   chosen 이 그 tier 로 승격 (이전 B6 동작 — 안전 우선, 비용 ↑).
 * - cfg.override.allowClientHint=false → hint 무시.
 */
export function resolveModelForRequest(req: RouteRequest, cfg: RoutingConfig): RouteDecision {
  const a = cfg.roles[req.role].preferred;
  const hintAllowed = cfg.override.allowClientHint;
  const hint = hintAllowed ? req.userHint : undefined;
  const effectiveTier = hint ?? a;

  // Phase 24 보정: respectMinModel=true 면 effectiveTier 보다 높은 minModel 도구를 필터.
  // false 면 기존 동작 (도구 그대로, tier 가 도구 minModel 로 승격 가능).
  const respectMinModel = cfg.override.respectMinModel;
  const allowedTools = respectMinModel
    ? req.availableTools.filter((t) => TIER_RANK[t.minModel ?? 'haiku'] <= TIER_RANK[effectiveTier])
    : req.availableTools;

  const c = computeFloor(allowedTools);

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
    allowedTools,
  };
}

// ─── RouterHelper facade (Phase 24) ───
//
// 호출 site (RPC handler / 어댑터 / 스킬 내부 LLM) 가 공유하는 facade 시그니처.
// 구현체는 server (auto-reply/router-helper.ts) 가 routingConfig + toolMetaIndex 를
// 클로저로 묶어 만든다. 타입을 agent 에 두는 이유는 skills-finance 가 import 할 수
// 있어야 하기 때문 (server 에 두면 의존성 역전).

export interface RouterHelperRequest {
  readonly role: ModelRole;
  readonly toolNames: ReadonlyArray<string>;
  readonly userHint?: ModelTier;
  readonly automation?: boolean;
}

export interface RouterHelperResult {
  readonly decision: RouteDecision;
  readonly modelId: string;
  /**
   * decision.allowedTools 의 이름 배열 (호출자 편의). adapter / agent.ts 가 LLM 에 전달할
   * 도구 정의를 이 목록으로 필터하면 minModel 미충족 도구가 LLM 에 노출되지 않음.
   */
  readonly allowedToolNames: ReadonlyArray<string>;
}

export type RouterHelper = (req: RouterHelperRequest) => RouterHelperResult;

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
