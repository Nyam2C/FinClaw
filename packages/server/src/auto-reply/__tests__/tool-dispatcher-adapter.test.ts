import {
  InMemoryToolRegistry,
  type RegisteredToolDefinition,
  type ToolExecutor,
} from '@finclaw/agent';
import { describe, expect, it, vi } from 'vitest';
import { buildDispatcher } from '../tool-dispatcher-adapter.js';

function registerEcho(registry: InMemoryToolRegistry, executor?: ToolExecutor): void {
  const def: RegisteredToolDefinition = {
    name: 'echo',
    description: 'echo',
    inputSchema: {
      type: 'object',
      properties: { text: { type: 'string', description: 't' } },
      required: ['text'],
    },
    group: 'custom',
    requiresApproval: false,
    isTransactional: false,
    accessesSensitiveData: false,
    isExternal: false,
  };
  const defaultExec: ToolExecutor = async (input) => ({
    content: String(input.text ?? ''),
    isError: false,
  });
  registry.register(def, executor ?? defaultExec, 'skill');
}

describe('buildDispatcher', () => {
  it('toolDefinitions는 registered 도구 목록을 반영한다', () => {
    const registry = new InMemoryToolRegistry();
    registerEcho(registry);

    const { toolDefinitions } = buildDispatcher(registry, {
      sessionId: 's1',
      userId: 'u1',
      channelId: 'c1',
    });

    expect(toolDefinitions.map((t) => t.name)).toEqual(['echo']);
  });

  it('dispatcher.executeAll은 registry.execute로 라우팅한다', async () => {
    const registry = new InMemoryToolRegistry();
    registerEcho(registry);

    const { dispatcher } = buildDispatcher(registry, {
      sessionId: 's1',
      userId: 'u1',
      channelId: 'c1',
    });

    const [result] = await dispatcher.executeAll([
      { id: 'call-1', name: 'echo', input: { text: 'hi' } },
    ]);

    expect(result.toolUseId).toBe('call-1');
    expect(result.isError).toBe(false);
    expect(result.content).toBe('hi');
  });

  it('registry.execute에 sessionId/userId/channelId를 전달한다', async () => {
    const registry = new InMemoryToolRegistry();
    const executor = vi.fn<ToolExecutor>(async (_input, ctx) => ({
      content: `${ctx.sessionId}|${ctx.userId}|${ctx.channelId}`,
      isError: false,
    }));
    registerEcho(registry, executor);

    const { dispatcher } = buildDispatcher(registry, {
      sessionId: 'session-X',
      userId: 'user-Y',
      channelId: 'channel-Z',
    });

    const [result] = await dispatcher.executeAll([{ id: 'c', name: 'echo', input: { text: 'x' } }]);

    expect(result.content).toBe('session-X|user-Y|channel-Z');
    expect(executor).toHaveBeenCalledOnce();
  });

  it('미등록 도구는 "Unknown tool" 에러를 반환한다', async () => {
    const registry = new InMemoryToolRegistry();
    const { dispatcher } = buildDispatcher(registry, {
      sessionId: 's',
      userId: 'u',
      channelId: 'c',
    });

    const [result] = await dispatcher.executeAll([{ id: 'x', name: 'nonexistent', input: {} }]);

    expect(result.isError).toBe(true);
    expect(result.content).toMatch(/Unknown tool/);
  });
});
