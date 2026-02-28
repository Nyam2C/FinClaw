import { resetEventBus } from '@finclaw/infra';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type {
  RegisteredToolDefinition,
  ToolExecutionContext,
  ToolResult,
} from '../src/agents/tools/registry.js';
import { InMemoryToolRegistry, toApiToolDefinition } from '../src/agents/tools/registry.js';

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

  it('그룹별로 도구를 조회한다', () => {
    registry.register(makeDef({ name: 'a', group: 'finance' }), okExecutor);
    registry.register(makeDef({ name: 'b', group: 'finance' }), okExecutor);
    registry.register(makeDef({ name: 'c', group: 'system' }), okExecutor);

    expect(registry.listByGroup('finance')).toHaveLength(2);
    expect(registry.listByGroup('system')).toHaveLength(1);
    expect(registry.listByGroup('web')).toHaveLength(0);
  });

  // ── toApiToolDefinition ──

  it('RegisteredToolDefinition을 3필드 ToolDefinition으로 변환한다', () => {
    const reg = makeDef({ name: 'x', group: 'finance', isTransactional: true });
    const api = toApiToolDefinition(reg);

    expect(api).toEqual({ name: 'x', description: 'A test tool', inputSchema: {} });
    expect(api).not.toHaveProperty('group');
    expect(api).not.toHaveProperty('isTransactional');
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

  it('beforeToolExecute 훅으로 실행을 skip할 수 있다', async () => {
    const hookRegistry = new InMemoryToolRegistry({
      hooks: {
        beforeToolExecute: async (payload) => ({
          ...payload,
          skip: true,
          skipResult: { content: 'Hooked!', isError: false },
        }),
      },
    });
    hookRegistry.register(makeDef(), okExecutor);

    const result = await hookRegistry.execute('test-tool', {}, makeCtx());

    expect(result.content).toBe('Hooked!');
  });
});
