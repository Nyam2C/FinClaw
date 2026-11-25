import type { ToolGroupId, ToolRegistry } from '@finclaw/agent';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { describe, expect, it, vi } from 'vitest';
import { jsonSchemaToZodShape, registerBridgedTools } from './bridge.js';

function makeRegistry(
  tools: Array<{ name: string; group: ToolGroupId }>,
  execute?: ReturnType<typeof vi.fn>,
): ToolRegistry {
  return {
    list: () =>
      tools.map((t) => ({
        definition: {
          name: t.name,
          description: `desc ${t.name}`,
          inputSchema: {
            type: 'object',
            properties: { symbol: { type: 'string', description: 'x' } },
            required: ['symbol'],
          },
          group: t.group,
          requiresApproval: false,
          isTransactional: false,
          accessesSensitiveData: false,
        },
        executor: async () => ({ content: '', isError: false }),
        registeredAt: new Date(),
        source: 'skill' as const,
      })),
    execute: execute ?? vi.fn().mockResolvedValue({ content: 'ok', isError: false }),
  } as unknown as ToolRegistry;
}

function mockServer() {
  return { registerTool: vi.fn() } as unknown as McpServer & {
    registerTool: ReturnType<typeof vi.fn>;
  };
}

describe('registerBridgedTools', () => {
  const identity = { userId: 'u', sessionId: 's' };

  it('registers every registry tool', () => {
    const server = mockServer();
    registerBridgedTools(
      server,
      makeRegistry([
        { name: 'route_task', group: 'custom' },
        { name: 'list_alerts', group: 'finance' },
      ]),
      identity,
    );
    const registered = server.registerTool.mock.calls.map((c) => c[0]);
    expect(registered).toEqual(['route_task', 'list_alerts']);
  });

  it('bridged executor routes to toolRegistry.execute with mcp ctx + request signal', async () => {
    const execute = vi.fn().mockResolvedValue({ content: 'AAPL 231.55', isError: false });
    const server = mockServer();
    registerBridgedTools(
      server,
      makeRegistry([{ name: 'route_task', group: 'custom' }], execute),
      identity,
    );
    const cb = server.registerTool.mock.calls[0][2] as (
      input: Record<string, unknown>,
      extra: { signal: AbortSignal },
    ) => Promise<{ content: unknown[]; isError: boolean }>;
    const signal = new AbortController().signal;
    const result = await cb({ symbol: 'AAPL' }, { signal });
    expect(execute).toHaveBeenCalledWith(
      'route_task',
      { symbol: 'AAPL' },
      {
        sessionId: 's',
        userId: 'u',
        channelId: 'mcp',
        abortSignal: signal,
      },
    );
    expect(result).toEqual({ content: [{ type: 'text', text: 'AAPL 231.55' }], isError: false });
  });
});

describe('jsonSchemaToZodShape', () => {
  it('maps required vs optional properties', () => {
    const shape = jsonSchemaToZodShape({
      type: 'object',
      properties: {
        symbol: { type: 'string', description: 'ticker' },
        range: { type: 'string', enum: ['1d', '1w'] },
      },
      required: ['symbol'],
    });
    expect(shape.symbol.safeParse(undefined).success).toBe(false);
    expect(shape.range.safeParse(undefined).success).toBe(true);
  });

  it('returns an empty shape when there are no properties', () => {
    expect(jsonSchemaToZodShape({ type: 'object' })).toEqual({});
  });
});
