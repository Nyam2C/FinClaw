import type { RegisteredToolDefinition } from './registry.js';

// ── 타입 ──

/** 정책 판정 결과 */
export type PolicyVerdict = 'allow' | 'deny' | 'require-approval';

/** 정책 규칙 */
export interface PolicyRule {
  readonly pattern: string; // 도구 이름 glob 패턴 (e.g., "finance:*")
  readonly verdict: PolicyVerdict;
  readonly reason?: string;
  readonly priority: number; // 높을수록 우선
  /** 적용 범위 필터 — 미지정이면 모든 범위에 적용 */
  readonly scope?: {
    readonly userId?: string;
    readonly channelId?: string;
  };
}

/** 정책 컨텍스트 */
export interface PolicyContext {
  readonly toolName: string;
  readonly toolDefinition: RegisteredToolDefinition;
  readonly userId: string;
  readonly channelId: string;
  readonly sessionId: string;
}

/** 정책 필터 단계 정의 */
export interface PolicyStage {
  readonly name: string;
  readonly evaluate: (ctx: PolicyContext, rules: readonly PolicyRule[]) => PolicyStageResult;
}

export interface PolicyStageResult {
  readonly verdict: PolicyVerdict | 'continue';
  readonly reason: string;
  readonly stage: string;
}

export interface PolicyEvaluationResult {
  readonly finalVerdict: PolicyVerdict;
  readonly stageResults: readonly PolicyStageResult[];
  readonly decidingStage: string;
  readonly reason: string;
}

// ── glob 매칭 ──

/** 간이 glob 매칭 (* 지원) */
export function matchToolPattern(pattern: string, toolName: string): boolean {
  if (pattern === '*') {
    return true;
  }
  if (pattern.endsWith(':*')) {
    const prefix = pattern.slice(0, -2);
    return toolName.startsWith(prefix + ':');
  }
  return pattern === toolName;
}

// ── 9단계 평가 함수 ──

/** 규칙을 priority 내림차순으로 필터링 */
function findMatchingRules(
  rules: readonly PolicyRule[],
  toolName: string,
  filterFn?: (rule: PolicyRule) => boolean,
): PolicyRule[] {
  return rules
    .filter((r) => matchToolPattern(r.pattern, toolName) && (!filterFn || filterFn(r)))
    .toSorted((a, b) => b.priority - a.priority);
}

/** Stage 1: 글로벌 deny 리스트 */
function evaluateGlobalDeny(ctx: PolicyContext, rules: readonly PolicyRule[]): PolicyStageResult {
  const matched = findMatchingRules(rules, ctx.toolName, (r) => r.verdict === 'deny' && !r.scope);
  if (matched.length > 0) {
    return {
      verdict: 'deny',
      reason: matched[0].reason ?? 'Globally denied',
      stage: 'global-deny',
    };
  }
  return { verdict: 'continue', reason: '', stage: 'global-deny' };
}

/** Stage 2: 글로벌 allow 리스트 */
function evaluateGlobalAllow(ctx: PolicyContext, rules: readonly PolicyRule[]): PolicyStageResult {
  const matched = findMatchingRules(rules, ctx.toolName, (r) => r.verdict === 'allow' && !r.scope);
  if (matched.length > 0) {
    return {
      verdict: 'allow',
      reason: matched[0].reason ?? 'Globally allowed',
      stage: 'global-allow',
    };
  }
  return { verdict: 'continue', reason: '', stage: 'global-allow' };
}

/** Stage 3: 사용자별 deny */
function evaluateUserDeny(ctx: PolicyContext, rules: readonly PolicyRule[]): PolicyStageResult {
  const matched = findMatchingRules(
    rules,
    ctx.toolName,
    (r) => r.verdict === 'deny' && r.scope?.userId === ctx.userId,
  );
  if (matched.length > 0) {
    return { verdict: 'deny', reason: matched[0].reason ?? 'Denied for user', stage: 'user-deny' };
  }
  return { verdict: 'continue', reason: '', stage: 'user-deny' };
}

/** Stage 4: 사용자별 allow */
function evaluateUserAllow(ctx: PolicyContext, rules: readonly PolicyRule[]): PolicyStageResult {
  const matched = findMatchingRules(
    rules,
    ctx.toolName,
    (r) => r.verdict === 'allow' && r.scope?.userId === ctx.userId,
  );
  if (matched.length > 0) {
    return {
      verdict: 'allow',
      reason: matched[0].reason ?? 'Allowed for user',
      stage: 'user-allow',
    };
  }
  return { verdict: 'continue', reason: '', stage: 'user-allow' };
}

/** Stage 5: 채널별 정책 */
function evaluateChannelPolicy(
  ctx: PolicyContext,
  rules: readonly PolicyRule[],
): PolicyStageResult {
  const matched = findMatchingRules(
    rules,
    ctx.toolName,
    (r) => r.scope?.channelId === ctx.channelId,
  );
  if (matched.length > 0) {
    return {
      verdict: matched[0].verdict,
      reason: matched[0].reason ?? 'Channel policy',
      stage: 'channel-policy',
    };
  }
  return { verdict: 'continue', reason: '', stage: 'channel-policy' };
}

/** Stage 6: 그룹별 정책 */
function evaluateGroupPolicy(ctx: PolicyContext, rules: readonly PolicyRule[]): PolicyStageResult {
  // 그룹 패턴: "<group>:*"
  const groupPattern = `${ctx.toolDefinition.group}:*`;
  const matched = findMatchingRules(rules, groupPattern, (r) => !r.scope).filter((r) =>
    matchToolPattern(r.pattern, ctx.toolName),
  );

  if (matched.length > 0) {
    return {
      verdict: matched[0].verdict,
      reason: matched[0].reason ?? 'Group policy',
      stage: 'group-policy',
    };
  }
  return { verdict: 'continue', reason: '', stage: 'group-policy' };
}

/** Stage 7: 도구별 명시적 정책 */
function evaluateToolSpecificPolicy(
  ctx: PolicyContext,
  rules: readonly PolicyRule[],
): PolicyStageResult {
  const matched = findMatchingRules(
    rules,
    ctx.toolName,
    (r) => r.pattern === ctx.toolName && !r.scope,
  );
  if (matched.length > 0) {
    return {
      verdict: matched[0].verdict,
      reason: matched[0].reason ?? 'Tool-specific policy',
      stage: 'tool-policy',
    };
  }
  return { verdict: 'continue', reason: '', stage: 'tool-policy' };
}

/** Stage 8: 금융 안전 정책 (FinClaw 전용) */
function evaluateFinanceSafety(
  ctx: PolicyContext,
  _rules: readonly PolicyRule[],
): PolicyStageResult {
  if (ctx.toolDefinition.isTransactional) {
    return {
      verdict: 'require-approval',
      reason: `Transactional tool "${ctx.toolName}" requires explicit approval`,
      stage: 'finance-safety',
    };
  }
  if (ctx.toolDefinition.accessesSensitiveData) {
    console.warn(
      `[Policy:finance-safety] Tool "${ctx.toolName}" accesses sensitive financial data`,
    );
  }
  return { verdict: 'continue', reason: '', stage: 'finance-safety' };
}

/** Stage 9: 기본 정책 (allow) */
function evaluateDefault(_ctx: PolicyContext, _rules: readonly PolicyRule[]): PolicyStageResult {
  return { verdict: 'allow', reason: 'Default allow', stage: 'default-policy' };
}

// ── 기본 9단계 파이프라인 ──

const DEFAULT_STAGES: readonly PolicyStage[] = [
  { name: 'global-deny', evaluate: evaluateGlobalDeny },
  { name: 'global-allow', evaluate: evaluateGlobalAllow },
  { name: 'user-deny', evaluate: evaluateUserDeny },
  { name: 'user-allow', evaluate: evaluateUserAllow },
  { name: 'channel-policy', evaluate: evaluateChannelPolicy },
  { name: 'group-policy', evaluate: evaluateGroupPolicy },
  { name: 'tool-policy', evaluate: evaluateToolSpecificPolicy },
  { name: 'finance-safety', evaluate: evaluateFinanceSafety },
  { name: 'default-policy', evaluate: evaluateDefault },
];

// ── 메인 함수 ──

/**
 * 9단계 정책 필터 파이프라인
 *
 * - deny → 즉시 중단
 * - require-approval → 누적, 파이프라인 끝에서 적용
 * - allow / continue → 후속 단계 진행 (finance-safety 보장)
 */
export function evaluateToolPolicy(
  ctx: PolicyContext,
  rules: readonly PolicyRule[],
  stages: readonly PolicyStage[] = DEFAULT_STAGES,
): PolicyEvaluationResult {
  const stageResults: PolicyStageResult[] = [];
  let pendingApproval: PolicyStageResult | undefined;

  for (const stage of stages) {
    const result = stage.evaluate(ctx, rules);
    stageResults.push(result);

    switch (result.verdict) {
      case 'deny':
        return {
          finalVerdict: 'deny',
          stageResults,
          decidingStage: stage.name,
          reason: result.reason,
        };

      case 'require-approval':
        pendingApproval ??= result;
        break;

      // allow / continue → 계속
      default:
        break;
    }
  }

  if (pendingApproval) {
    return {
      finalVerdict: 'require-approval',
      stageResults,
      decidingStage: pendingApproval.stage,
      reason: pendingApproval.reason,
    };
  }

  // TODO: Stage 9 default-policy가 'allow'를 반환하지만 decidingStage가 'fallthrough'로 표시됨.
  // 'default-policy'가 더 정확한 라벨 (review-1 이슈 3)
  return {
    finalVerdict: 'allow',
    stageResults,
    decidingStage: 'fallthrough',
    reason: 'No matching policy rule found, defaulting to allow',
  };
}
