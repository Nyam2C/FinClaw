import { getEventBus, resetEventBus } from '@finclaw/infra';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type {
  RegisteredToolDefinition,
  ToolExecutionContext,
  ToolResult,
} from '../src/agents/tools/registry.js';
import { InMemoryToolRegistry } from '../src/agents/tools/registry.js';

// ── 헬퍼 ──

function makeDef(overrides?: Partial<RegisteredToolDefinition>): RegisteredToolDefinition {
  return {
    name: 'test-tool',
    description: 'A test tool',
    inputSchema: {},
    group: 'custom',
    requiresApproval: false,
    isTransactional: false,
    accessesSensitiveData: false,
    ...overrides,
  };
}

function makeCtx(overrides?: Partial<ToolExecutionContext>): ToolExecutionContext {
  return {
    sessionId: 'sess-1',
    userId: 'user-1',
    channelId: 'ch-1',
    abortSignal: AbortSignal.timeout(5_000),
    ...overrides,
  };
}

const okExecutor = async (): Promise<ToolResult> => ({
  content: 'ok',
  isError: false,
});

const errorExecutor = async (): Promise<ToolResult> => {
  throw new Error('boom');
};

describe('InMemoryToolRegistry', () => {
  let registry: InMemoryToolRegistry;

  beforeEach(() => {
    vi.useFakeTimers();
    registry = new InMemoryToolRegistry();
  });

  afterEach(() => {
    vi.useRealTimers();
    resetEventBus();
  });

  // ── register / get / has / list ──

  it('도구를 등록하고 조회한다', () => {
    const def = makeDef();
    registry.register(def, okExecutor);

    expect(registry.has('test-tool')).toBe(true);
    expect(registry.get('test-tool')?.definition.name).toBe('test-tool');
    expect(registry.list()).toHaveLength(1);
  });

  it('중복 등록 시 에러를 던진다', () => {
    registry.register(makeDef(), okExecutor);
    expect(() => registry.register(makeDef(), okExecutor)).toThrow('already registered');
  });

  it('등록 해제한다', () => {
    registry.register(makeDef(), okExecutor);
    expect(registry.unregister('test-tool')).toBe(true);
    expect(registry.has('test-tool')).toBe(false);
    expect(registry.unregister('nonexistent')).toBe(false);
  });

  // ── execute ──

  it('등록되지 않은 도구 실행 시 에러 결과를 반환한다', async () => {
    const result = await registry.execute('nonexistent', {}, makeCtx());

    expect(result.isError).toBe(true);
    expect(result.content).toContain('not found');
  });

  it('정상 도구를 실행하고 결과를 가드한다', async () => {
    registry.register(makeDef(), okExecutor);
    const result = await registry.execute('test-tool', {}, makeCtx());

    expect(result.isError).toBe(false);
    expect(result.content).toBe('ok');
  });

  it('도구 실행 중 예외를 잡아 에러 결과로 반환한다', async () => {
    registry.register(makeDef(), errorExecutor);
    const result = await registry.execute('test-tool', {}, makeCtx());

    expect(result.isError).toBe(true);
    expect(result.content).toContain('boom');
  });

  it('deny 정책이 있으면 실행을 차단한다', async () => {
    registry.register(makeDef(), okExecutor);
    registry.addPolicyRule({
      pattern: 'test-tool',
      verdict: 'deny',
      reason: 'Not allowed',
      priority: 100,
    });

    const result = await registry.execute('test-tool', {}, makeCtx());

    expect(result.isError).toBe(true);
    expect(result.content).toContain('denied');
  });

  // ── 루프 감지 통합 (Phase 31 D) ──

  it('동일 args+result 반복이 critical 임계에 도달하면 차단한다', async () => {
    registry.register(makeDef(), okExecutor);

    const verdicts: Array<{ verdict: string; stage: string }> = [];
    const loops: Array<{ detector: string; count: number }> = [];
    getEventBus().on('tool:policy:verdict', (_n, verdict, stage) =>
      verdicts.push({ verdict, stage }),
    );
    getEventBus().on('tool:loop:detected', (_n, detector, count) =>
      loops.push({ detector, count }),
    );

    // 1~20회는 통과 (warning 은 require-approval override 후 실행됨)
    for (let i = 0; i < 20; i += 1) {
      const r = await registry.execute('test-tool', {}, makeCtx());
      expect(r.isError).toBe(false);
    }

    // 21회째 — history 20건 identical → streak 20 ≥ CRITICAL_THRESHOLD → 차단
    const blocked = await registry.execute('test-tool', {}, makeCtx());
    expect(blocked.isError).toBe(true);
    expect(blocked.content).toContain('infinite loop');

    expect(verdicts).toContainEqual({ verdict: 'deny', stage: 'loop-detector' });
    expect(loops.some((l) => l.detector === 'generic_repeat')).toBe(true);
  });

  it('서로 다른 args 는 누적 streak 을 만들지 않아 차단되지 않는다', async () => {
    registry.register(makeDef(), okExecutor);

    for (let i = 0; i < 25; i += 1) {
      const r = await registry.execute('test-tool', { n: i }, makeCtx());
      expect(r.isError).toBe(false);
    }
  });
});
