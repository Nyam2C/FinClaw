import { describe, it, expect, vi } from 'vitest';
import type { AlertStore, CreateAlertInput } from '../types.js';
import { buildConditionFromParams } from '../tools.js';

type ToolExecutor = (
  input: Record<string, unknown>,
  context: {
    userId: string;
    sessionId: string;
    channelId: string;
    abortSignal: AbortSignal;
  },
) => Promise<{ content: string; isError: boolean }>;

describe('buildConditionFromParams', () => {
  it('price 조건 파싱', () => {
    const result = buildConditionFromParams({
      condition: { type: 'price', ticker: 'AAPL', direction: 'above', threshold: 200 },
    });
    expect(result).toEqual({ type: 'price', ticker: 'AAPL', direction: 'above', threshold: 200 });
  });

  it('change 조건 파싱 (default direction)', () => {
    const result = buildConditionFromParams({
      condition: { type: 'change', ticker: 'AAPL', thresholdPercent: 5 },
    });
    expect(result).toEqual({
      type: 'change',
      ticker: 'AAPL',
      thresholdPercent: 5,
      direction: 'both',
    });
  });

  it('volume 조건 파싱', () => {
    const result = buildConditionFromParams({
      condition: { type: 'volume', ticker: 'AAPL', multiplier: 2 },
    });
    expect(result).toEqual({ type: 'volume', ticker: 'AAPL', multiplier: 2 });
  });

  it('news 조건 파싱', () => {
    const result = buildConditionFromParams({
      condition: { type: 'news', keywords: ['실적'] },
    });
    expect(result).toEqual({ type: 'news', keywords: ['실적'] });
  });

  it('무효 입력 throw', () => {
    expect(() => buildConditionFromParams({ condition: { type: 'invalid' } })).toThrow();
    expect(() => buildConditionFromParams({ condition: {} })).toThrow();
    expect(() => buildConditionFromParams({})).toThrow();
  });
});

describe('registerSetAlertTool — context.userId', () => {
  it('context.userId를 사용하여 알림 생성', async () => {
    // tools.ts의 registerSetAlertTool은 registry.register를 호출하므로
    // 실제 executor를 추출하여 테스트
    const { registerSetAlertTool } = await import('../tools.js');

    let capturedExecutor: ToolExecutor | null = null;
    const mockRegistry = {
      register: vi.fn().mockImplementation((_def: unknown, executor: ToolExecutor) => {
        capturedExecutor = executor;
      }),
    };

    const mockStore: Partial<AlertStore> = {
      create: vi.fn().mockImplementation((input: CreateAlertInput) => ({
        id: 'new-id',
        ...input,
        createdAt: Date.now(),
        updatedAt: Date.now(),
        cooldownMs: input.cooldownMs ?? 900_000,
        enabled: input.enabled ?? true,
      })),
    };

    registerSetAlertTool(mockRegistry as never, { store: mockStore as AlertStore });
    expect(capturedExecutor).toBeTruthy();

    const executor = capturedExecutor as ToolExecutor;
    const result = await executor(
      {
        name: 'Test',
        condition: { type: 'price', ticker: 'AAPL', direction: 'above', threshold: 200 },
      },
      {
        userId: 'test-user',
        sessionId: 's',
        channelId: 'c',
        abortSignal: new AbortController().signal,
      },
    );

    expect(result.isError).toBe(false);
    expect(mockStore.create).toHaveBeenCalledWith(expect.objectContaining({ userId: 'test-user' }));
  });
});

describe('registerRemoveAlertTool — 다른 사용자 알림 삭제 거부', () => {
  it('다른 사용자의 알림은 삭제 불가', async () => {
    const { registerRemoveAlertTool } = await import('../tools.js');

    let capturedExecutor: ToolExecutor | null = null;
    const mockRegistry = {
      register: vi.fn().mockImplementation((_def: unknown, executor: ToolExecutor) => {
        capturedExecutor = executor;
      }),
    };

    const mockStore: Partial<AlertStore> = {
      getById: vi.fn().mockReturnValue({
        id: 'alert-1',
        userId: 'other-user',
        name: 'Test',
        condition: { type: 'price', ticker: 'AAPL', direction: 'above', threshold: 200 },
        channels: ['log'],
        cooldownMs: 900_000,
        enabled: true,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      }),
      delete: vi.fn(),
    };

    registerRemoveAlertTool(mockRegistry as never, { store: mockStore as AlertStore });
    expect(capturedExecutor).toBeTruthy();

    const executor = capturedExecutor as ToolExecutor;
    const result = await executor(
      { alertId: 'alert-1' },
      {
        userId: 'my-user',
        sessionId: 's',
        channelId: 'c',
        abortSignal: new AbortController().signal,
      },
    );

    expect(result.isError).toBe(true);
    expect(result.content).toContain('다른 사용자');
    expect(mockStore.delete).not.toHaveBeenCalled();
  });
});
