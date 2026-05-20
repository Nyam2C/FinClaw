import { InMemoryToolRegistry, type ToolExecutionContext } from '@finclaw/agent';
import type { ScheduleRpc } from '@finclaw/types';
import { describe, expect, it, vi } from 'vitest';
import { registerScheduleTool } from '../src/schedule-tool.js';

type MockRpc = ScheduleRpc & {
  create: ReturnType<typeof vi.fn>;
  list: ReturnType<typeof vi.fn>;
  delete: ReturnType<typeof vi.fn>;
  testCron: ReturnType<typeof vi.fn>;
};

function makeMockRpc(): MockRpc {
  return {
    create: vi.fn().mockResolvedValue({ id: 'sch_1', nextRunAt: 1234567890 }),
    list: vi.fn().mockResolvedValue({ schedules: [] }),
    delete: vi.fn().mockResolvedValue(undefined),
    testCron: vi.fn().mockResolvedValue({ valid: true }),
  };
}

const ctx: ToolExecutionContext = {
  sessionId: 's1',
  userId: 'u1',
  channelId: 'c1',
  abortSignal: new AbortController().signal,
};

function setup(rpc: ScheduleRpc): InMemoryToolRegistry {
  const registry = new InMemoryToolRegistry();
  registerScheduleTool(registry, rpc);
  return registry;
}

describe('schedule_manage tool', () => {
  it('registers the tool with name schedule_manage', () => {
    const registry = setup(makeMockRpc());
    expect(registry.has('schedule_manage')).toBe(true);
  });

  it('creates schedule from natural language intent', async () => {
    const rpc = makeMockRpc();
    const registry = setup(rpc);
    const result = await registry.execute(
      'schedule_manage',
      {
        action: 'create',
        name: '매일 12시 포트폴리오 보고',
        cron: '0 3 * * *', // KST 12시 = UTC 03:00
        prompt: '현재 포트폴리오 요약해줘',
      },
      ctx,
    );
    expect(result.isError).toBe(false);
    expect(rpc.create).toHaveBeenCalledWith(
      expect.objectContaining({
        name: '매일 12시 포트폴리오 보고',
        cron: '0 3 * * *',
        enabled: true,
      }),
    );
  });

  it('rejects create with missing fields', async () => {
    const rpc = makeMockRpc();
    const registry = setup(rpc);
    const result = await registry.execute(
      'schedule_manage',
      { action: 'create', name: 'test' },
      ctx,
    );
    expect(result.isError).toBe(true);
    expect(rpc.create).not.toHaveBeenCalled();
  });

  it('rejects invalid cron via testCron', async () => {
    const rpc = makeMockRpc();
    rpc.testCron.mockRejectedValue(new Error('Invalid cron syntax'));
    const registry = setup(rpc);
    const result = await registry.execute(
      'schedule_manage',
      { action: 'create', name: 'bad', cron: 'not a cron', prompt: 'x' },
      ctx,
    );
    expect(result.isError).toBe(true);
    expect(rpc.create).not.toHaveBeenCalled();
  });

  it('lists schedules', async () => {
    const rpc = makeMockRpc();
    rpc.list.mockResolvedValue({
      schedules: [
        {
          id: 'sch_1',
          name: '12시 보고',
          cron: '0 3 * * *',
          enabled: true,
          status: 'active',
          consecutiveFailures: 0,
          nextRunAt: 0,
        },
      ],
    });
    const registry = setup(rpc);
    const result = await registry.execute('schedule_manage', { action: 'list' }, ctx);
    expect(result.isError).toBe(false);
    expect(rpc.list).toHaveBeenCalled();
    expect(result.content).toContain('12시 보고');
  });
});
