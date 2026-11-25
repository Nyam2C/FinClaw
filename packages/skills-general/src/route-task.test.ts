// packages/skills-general/src/route-task.test.ts
import type { RegisteredToolDefinition, ToolExecutor, ToolRegistry } from '@finclaw/agent';
import type { Dispatcher } from '@finclaw/types';
import { describe, expect, it, vi } from 'vitest';
import { registerRouteTaskTool } from './route-task.js';

describe('route_task executor', () => {
  it('D2: ctx.abortSignal 을 dispatcher 로 넘긴다', async () => {
    let executor: ToolExecutor | undefined;
    const registry = {
      register: (_def: RegisteredToolDefinition, exec: ToolExecutor) => {
        executor = exec;
      },
    } as unknown as ToolRegistry;
    const dispatcher = vi
      .fn<Dispatcher>()
      .mockResolvedValue({ content: 'ok', source: 'function', isError: false });
    registerRouteTaskTool(registry, dispatcher);
    const ac = new AbortController();
    await executor?.(
      { intent: 'price_lookup', query: 'AAPL 시세', symbol: 'AAPL' },
      { sessionId: 's', userId: 'u', channelId: 'mcp', abortSignal: ac.signal },
    );
    expect(dispatcher).toHaveBeenCalledWith(
      { intent: 'price_lookup', query: 'AAPL 시세', symbol: 'AAPL' },
      ac.signal,
    );
  });
});
