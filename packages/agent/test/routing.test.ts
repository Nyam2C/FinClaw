import type { RoutingConfig, ToolMetadata } from '@finclaw/types';
import { describe, expect, it } from 'vitest';
import {
  computeFloor,
  maxTier,
  modelIdToTier,
  resolveModelForRequest,
  tierToModelId,
} from '../src/models/routing.js';

const DEFAULT_CFG: RoutingConfig = {
  roles: {
    fetch: { preferred: 'haiku', maxTokens: 1024 },
    chat: { preferred: 'sonnet', maxTokens: 4096 },
    analysis: { preferred: 'opus', maxTokens: 8192 },
    summarize: { preferred: 'haiku', maxTokens: 2048 },
  },
  automation: { strictFallback: true, logVerbose: true },
  override: { allowClientHint: true, respectMinModel: true },
};

const PRICE_TOOL: ToolMetadata = { name: 'get_stock_price', minModel: 'haiku' };
const ANALYZE_TOOL: ToolMetadata = { name: 'analyze_market', minModel: 'opus' };
const PORTFOLIO_TOOL: ToolMetadata = { name: 'get_portfolio_summary', minModel: 'sonnet' };
const NO_MIN_TOOL: ToolMetadata = { name: 'foo' };

describe('maxTier', () => {
  it('undefined 무시', () => {
    expect(maxTier('haiku', undefined, 'sonnet')).toBe('sonnet');
  });

  it('전부 undefined → haiku 기본', () => {
    expect(maxTier(undefined)).toBe('haiku');
    expect(maxTier()).toBe('haiku');
  });

  it('opus 가 최강', () => {
    expect(maxTier('haiku', 'opus', 'sonnet')).toBe('opus');
  });

  it('동일 tier 입력 → 그 tier', () => {
    expect(maxTier('sonnet', 'sonnet')).toBe('sonnet');
  });
});

describe('computeFloor', () => {
  it('도구 없음 → haiku', () => {
    expect(computeFloor([])).toBe('haiku');
  });

  it('analyze_market 포함 → opus', () => {
    expect(computeFloor([PRICE_TOOL, ANALYZE_TOOL])).toBe('opus');
  });

  it('portfolio + price → sonnet (max)', () => {
    expect(computeFloor([PRICE_TOOL, PORTFOLIO_TOOL])).toBe('sonnet');
  });

  it('minModel 미지정 도구 → haiku 처리', () => {
    expect(computeFloor([NO_MIN_TOOL])).toBe('haiku');
  });

  it('minModel 미지정 + 명시 도구 혼합 → 명시값 승리', () => {
    expect(computeFloor([NO_MIN_TOOL, PORTFOLIO_TOOL])).toBe('sonnet');
  });
});

describe('resolveModelForRequest — 기본 (role 단독)', () => {
  it('role=fetch + 도구 없음 → haiku (overriddenBy=role)', () => {
    const r = resolveModelForRequest({ role: 'fetch', availableTools: [] }, DEFAULT_CFG);
    expect(r.tier).toBe('haiku');
    expect(r.floor).toBe('haiku');
    expect(r.overriddenBy).toBe('role');
  });

  it('role=chat + 일반 도구 → sonnet', () => {
    const r = resolveModelForRequest({ role: 'chat', availableTools: [PRICE_TOOL] }, DEFAULT_CFG);
    expect(r.tier).toBe('sonnet');
    expect(r.overriddenBy).toBe('role');
  });

  it('role=analysis → opus', () => {
    const r = resolveModelForRequest({ role: 'analysis', availableTools: [] }, DEFAULT_CFG);
    expect(r.tier).toBe('opus');
  });

  it('role=summarize → haiku', () => {
    const r = resolveModelForRequest({ role: 'summarize', availableTools: [] }, DEFAULT_CFG);
    expect(r.tier).toBe('haiku');
  });
});

describe('resolveModelForRequest — 도구 minModel 승격 (B6)', () => {
  it('role=fetch + analyze_market → opus (tool_min 승리)', () => {
    const r = resolveModelForRequest(
      { role: 'fetch', availableTools: [PRICE_TOOL, ANALYZE_TOOL] },
      DEFAULT_CFG,
    );
    expect(r.tier).toBe('opus');
    expect(r.floor).toBe('opus');
    expect(r.overriddenBy).toBe('tool_min');
  });

  it('role=chat + portfolio → sonnet (role 과 동률, role 표기)', () => {
    const r = resolveModelForRequest(
      { role: 'chat', availableTools: [PORTFOLIO_TOOL] },
      DEFAULT_CFG,
    );
    expect(r.tier).toBe('sonnet');
    expect(r.overriddenBy).toBe('role');
  });

  it('role=fetch + portfolio → sonnet (tool_min)', () => {
    const r = resolveModelForRequest(
      { role: 'fetch', availableTools: [PORTFOLIO_TOOL] },
      DEFAULT_CFG,
    );
    expect(r.tier).toBe('sonnet');
    expect(r.overriddenBy).toBe('tool_min');
  });
});

describe('resolveModelForRequest — userHint (B2)', () => {
  it('hint=opus + role=chat → opus (hint 승리)', () => {
    const r = resolveModelForRequest(
      { role: 'chat', availableTools: [PRICE_TOOL], userHint: 'opus' },
      DEFAULT_CFG,
    );
    expect(r.tier).toBe('opus');
    expect(r.overriddenBy).toBe('hint');
  });

  it('hint=haiku + analyze_market → opus (C 승리, hint 무시)', () => {
    const r = resolveModelForRequest(
      { role: 'chat', availableTools: [ANALYZE_TOOL], userHint: 'haiku' },
      DEFAULT_CFG,
    );
    expect(r.tier).toBe('opus');
    expect(r.overriddenBy).toBe('tool_min');
  });

  it('hint=haiku + role=analysis (A=opus) + 도구 없음 → haiku (hint 가 A 보다 약하지만 hint 승리)', () => {
    const r = resolveModelForRequest(
      { role: 'analysis', availableTools: [], userHint: 'haiku' },
      DEFAULT_CFG,
    );
    expect(r.tier).toBe('haiku');
    expect(r.overriddenBy).toBe('hint');
  });

  it('allowClientHint=false → hint 무시, role 적용', () => {
    const cfg = { ...DEFAULT_CFG, override: { ...DEFAULT_CFG.override, allowClientHint: false } };
    const r = resolveModelForRequest({ role: 'fetch', availableTools: [], userHint: 'opus' }, cfg);
    expect(r.tier).toBe('haiku');
    expect(r.overriddenBy).toBe('role');
  });
});

describe('resolveModelForRequest — floor 반환 (밀스톤 D 준비)', () => {
  it('analyze_market → floor=opus', () => {
    const r = resolveModelForRequest({ role: 'chat', availableTools: [ANALYZE_TOOL] }, DEFAULT_CFG);
    expect(r.floor).toBe('opus');
  });

  it('일반 도구만 → floor=haiku', () => {
    const r = resolveModelForRequest({ role: 'chat', availableTools: [PRICE_TOOL] }, DEFAULT_CFG);
    expect(r.floor).toBe('haiku');
  });

  it('floor 는 chosen tier 와 무관하게 도구 minModel 만 반영', () => {
    const r = resolveModelForRequest(
      { role: 'analysis', availableTools: [PRICE_TOOL], userHint: 'opus' },
      DEFAULT_CFG,
    );
    expect(r.tier).toBe('opus');
    expect(r.floor).toBe('haiku');
  });
});

describe('automation 플래그 (밀스톤 D 의 strictFallback 입력)', () => {
  it('automation=true 는 모델 선택 결과에 영향 주지 않음', () => {
    const r1 = resolveModelForRequest(
      { role: 'analysis', availableTools: [], automation: true },
      DEFAULT_CFG,
    );
    const r2 = resolveModelForRequest(
      { role: 'analysis', availableTools: [], automation: false },
      DEFAULT_CFG,
    );
    expect(r1.tier).toBe(r2.tier);
  });
});

describe('tierToModelId / modelIdToTier 왕복', () => {
  it('haiku ↔ claude-haiku-4-5-20251001', () => {
    expect(tierToModelId('haiku')).toBe('claude-haiku-4-5-20251001');
    expect(modelIdToTier('claude-haiku-4-5-20251001')).toBe('haiku');
  });

  it('sonnet ↔ claude-sonnet-4-6', () => {
    expect(tierToModelId('sonnet')).toBe('claude-sonnet-4-6');
    expect(modelIdToTier('claude-sonnet-4-6')).toBe('sonnet');
  });

  it('opus ↔ claude-opus-4-7', () => {
    expect(tierToModelId('opus')).toBe('claude-opus-4-7');
    expect(modelIdToTier('claude-opus-4-7')).toBe('opus');
  });

  it('알 수 없는 모델 ID → haiku 기본', () => {
    expect(modelIdToTier('claude-unknown')).toBe('haiku');
  });
});

describe('reason 문자열 — 감사 로그용', () => {
  it('A/C/hint 모두 포함', () => {
    const r = resolveModelForRequest(
      { role: 'chat', availableTools: [ANALYZE_TOOL], userHint: 'haiku' },
      DEFAULT_CFG,
    );
    expect(r.reason).toContain('A=sonnet');
    expect(r.reason).toContain('C=opus');
    expect(r.reason).toContain('hint=haiku');
    expect(r.reason).toContain('opus');
    expect(r.reason).toContain('tool_min');
  });

  it('hint 미지정 시 hint=none', () => {
    const r = resolveModelForRequest({ role: 'chat', availableTools: [] }, DEFAULT_CFG);
    expect(r.reason).toContain('hint=none');
  });
});
