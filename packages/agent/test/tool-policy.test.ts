import { describe, it, expect } from 'vitest';
import type { PolicyRule, PolicyContext } from '../src/agents/tools/policy.js';
import type { RegisteredToolDefinition } from '../src/agents/tools/registry.js';
import { evaluateToolPolicy, matchToolPattern } from '../src/agents/tools/policy.js';

// ── 헬퍼 ──

function makeCtx(overrides?: Partial<PolicyContext>): PolicyContext {
  return {
    toolName: 'finance:get-price',
    toolDefinition: {
      name: 'finance:get-price',
      description: 'Get stock price',
      inputSchema: {},
      group: 'finance',
      requiresApproval: false,
      isTransactional: false,
      accessesSensitiveData: false,
    } as RegisteredToolDefinition,
    userId: 'user-1',
    channelId: 'ch-1',
    sessionId: 'sess-1',
    ...overrides,
  };
}

describe('matchToolPattern', () => {
  it('와일드카드 * 는 모든 도구에 매칭된다', () => {
    expect(matchToolPattern('*', 'anything')).toBe(true);
  });

  it('접두사:* 패턴으로 그룹 매칭한다', () => {
    expect(matchToolPattern('finance:*', 'finance:get-price')).toBe(true);
    expect(matchToolPattern('finance:*', 'system:ls')).toBe(false);
  });

  it('정확히 일치하는 이름에 매칭된다', () => {
    expect(matchToolPattern('finance:get-price', 'finance:get-price')).toBe(true);
    expect(matchToolPattern('finance:get-price', 'finance:set-price')).toBe(false);
  });
});

describe('evaluateToolPolicy', () => {
  it('규칙 없으면 기본 allow를 반환한다', () => {
    const result = evaluateToolPolicy(makeCtx(), []);

    expect(result.finalVerdict).toBe('allow');
    expect(result.stageResults).toHaveLength(9);
  });

  it('글로벌 deny 규칙이 즉시 중단한다', () => {
    const rules: PolicyRule[] = [
      { pattern: '*', verdict: 'deny', reason: 'All denied', priority: 100 },
    ];
    const result = evaluateToolPolicy(makeCtx(), rules);

    expect(result.finalVerdict).toBe('deny');
    expect(result.decidingStage).toBe('global-deny');
  });

  it('글로벌 deny가 글로벌 allow보다 먼저 평가된다', () => {
    const rules: PolicyRule[] = [
      { pattern: '*', verdict: 'deny', priority: 50 },
      { pattern: '*', verdict: 'allow', priority: 100 },
    ];
    const result = evaluateToolPolicy(makeCtx(), rules);

    // deny 가 Stage 1 에서 먼저 잡힘
    expect(result.finalVerdict).toBe('deny');
    expect(result.decidingStage).toBe('global-deny');
  });

  it('사용자별 deny가 적용된다', () => {
    const rules: PolicyRule[] = [
      {
        pattern: 'finance:get-price',
        verdict: 'deny',
        priority: 50,
        scope: { userId: 'user-1' },
      },
    ];
    const result = evaluateToolPolicy(makeCtx(), rules);

    expect(result.finalVerdict).toBe('deny');
    expect(result.decidingStage).toBe('user-deny');
  });

  it('다른 사용자의 deny 규칙은 무시된다', () => {
    const rules: PolicyRule[] = [
      {
        pattern: 'finance:get-price',
        verdict: 'deny',
        priority: 50,
        scope: { userId: 'user-2' },
      },
    ];
    const result = evaluateToolPolicy(makeCtx(), rules);

    expect(result.finalVerdict).toBe('allow');
  });

  it('isTransactional 도구는 require-approval을 반환한다 (Stage 8)', () => {
    const ctx = makeCtx({
      toolDefinition: {
        name: 'finance:execute-trade',
        description: 'Execute trade',
        inputSchema: {},
        group: 'finance',
        requiresApproval: false,
        isTransactional: true,
        accessesSensitiveData: false,
      } as RegisteredToolDefinition,
    });
    const result = evaluateToolPolicy(ctx, []);

    expect(result.finalVerdict).toBe('require-approval');
    expect(result.decidingStage).toBe('finance-safety');
  });

  it('require-approval은 누적되고 파이프라인 끝에서 적용된다', () => {
    const ctx = makeCtx({
      toolDefinition: {
        name: 'finance:trade',
        description: 'Trade',
        inputSchema: {},
        group: 'finance',
        requiresApproval: false,
        isTransactional: true,
        accessesSensitiveData: false,
      } as RegisteredToolDefinition,
    });
    const result = evaluateToolPolicy(ctx, []);

    expect(result.finalVerdict).toBe('require-approval');
    // 9단계 모두 실행됨 (deny로 중단되지 않았으므로)
    expect(result.stageResults).toHaveLength(9);
  });

  it('deny가 require-approval보다 우선한다', () => {
    const ctx = makeCtx({
      toolName: 'finance:trade',
      toolDefinition: {
        name: 'finance:trade',
        description: 'Trade',
        inputSchema: {},
        group: 'finance',
        requiresApproval: false,
        isTransactional: true,
        accessesSensitiveData: false,
      } as RegisteredToolDefinition,
    });
    const rules: PolicyRule[] = [
      { pattern: 'finance:trade', verdict: 'deny', reason: 'Blocked', priority: 100 },
    ];
    const result = evaluateToolPolicy(ctx, rules);

    expect(result.finalVerdict).toBe('deny');
  });
});
