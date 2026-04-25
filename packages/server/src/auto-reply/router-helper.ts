import type { ModelTier, RoutingConfig, ToolMetadata } from '@finclaw/types';
// packages/server/src/auto-reply/router-helper.ts
import {
  resolveModelForRequest,
  tierToModelId,
  type ModelRole,
  type RouteDecision,
} from '@finclaw/agent';

export interface RouterHelperRequest {
  readonly role: ModelRole;
  readonly toolNames: ReadonlyArray<string>;
  readonly userHint?: ModelTier;
  readonly automation?: boolean;
}

export interface RouterHelperResult {
  readonly decision: RouteDecision;
  readonly modelId: string;
}

/**
 * RPC handler / 어댑터 / 스킬 내부 LLM 호출 site 가 공유하는 라우터 facade.
 *
 * - main.ts 에서 routingConfig + 전역 toolMetaIndex 를 주입해 만든 단일 closure.
 * - 호출자는 ToolMetadata 를 몰라도 됨 — 도구 이름 배열만 넘기면 lookup 후 라우터 호출.
 * - 미등록 이름은 minModel 미지정 ToolMetadata 로 처리 (라우터 기본값 = haiku).
 */
export type RouterHelper = (req: RouterHelperRequest) => RouterHelperResult;

export function makeRouterHelper(
  routingConfig: RoutingConfig,
  toolMetaIndex: ReadonlyMap<string, ToolMetadata>,
): RouterHelper {
  return (req) => {
    const availableTools = req.toolNames.map((name) => toolMetaIndex.get(name) ?? { name });
    const decision = resolveModelForRequest(
      {
        role: req.role,
        availableTools,
        userHint: req.userHint,
        automation: req.automation,
      },
      routingConfig,
    );
    return { decision, modelId: tierToModelId(decision.tier) };
  };
}

/**
 * 다수의 SkillMetadata 로부터 도구 이름 → ToolMetadata 인덱스 구축.
 * 동일 도구 이름이 중복될 경우 처음 등록된 항목 유지.
 */
export function buildToolMetaIndex(
  skills: ReadonlyArray<{ readonly tools: ReadonlyArray<ToolMetadata> }>,
): Map<string, ToolMetadata> {
  const index = new Map<string, ToolMetadata>();
  for (const skill of skills) {
    for (const tool of skill.tools) {
      if (!index.has(tool.name)) {
        index.set(tool.name, tool);
      }
    }
  }
  return index;
}
