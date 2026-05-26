import type { ToolGroupId, ToolRegistry } from '@finclaw/agent';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { describe, expect, it, vi } from 'vitest';
import {
  computeDeniedTools,
  DEFAULT_MCP_TOOL_DENY,
  jsonSchemaToZodShape,
  registerBridgedTools,
} from './bridge.js';

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

describe('computeDeniedTools', () => {
  it('denies the read-only-first default set with no config', () => {
    const denied = computeDeniedTools({});
    for (const name of DEFAULT_MCP_TOOL_DENY) {
      expect(denied.has(name)).toBe(true);
    }
  });

  it('allowTools removes a tool from the default deny (opt-in)', () => {
    expect(computeDeniedTools({ allowTools: ['set_alert'] }).has('set_alert')).toBe(false);
  });

  it('denyTools adds tools to the deny set', () => {
    expect(computeDeniedTools({ denyTools: ['get_stock_price'] }).has('get_stock_price')).toBe(
      true,
    );
  });
});

describe('registerBridgedTools', () => {
  const identity = { userId: 'u', sessionId: 's' };

  it('registers read-only tools but not the default-denied mutating/escape tools', () => {
    const server = mockServer();
    registerBridgedTools(
      server,
      makeRegistry([
        { name: 'get_stock_price', group: 'finance' },
        { name: 'set_alert', group: 'finance' },
        { name: 'web_fetch', group: 'web' },
        { name: 'read_local_file', group: 'system' },
      ]),
      {},
      identity,
    );
    const registered = server.registerTool.mock.calls.map((c) => c[0]);
    expect(registered).toContain('get_stock_price');
    expect(registered).not.toContain('set_alert');
    expect(registered).not.toContain('web_fetch');
    expect(registered).not.toContain('read_local_file');
  });

  it('restricts to allowedGroups when set', () => {
    const server = mockServer();
    registerBridgedTools(
      server,
      makeRegistry([
        { name: 'get_stock_price', group: 'finance' },
        { name: 'get_current_datetime', group: 'custom' },
      ]),
      { allowedGroups: ['finance'] },
      identity,
    );
    const registered = server.registerTool.mock.calls.map((c) => c[0]);
    expect(registered).toEqual(['get_stock_price']);
  });

  it('bridged executor routes to toolRegistry.execute with mcp ctx + request signal', async () => {
    const execute = vi.fn().mockResolvedValue({ content: 'AAPL 231.55', isError: false });
    const server = mockServer();
    registerBridgedTools(
      server,
      makeRegistry([{ name: 'get_stock_price', group: 'finance' }], execute),
      {},
      identity,
    );
    const cb = server.registerTool.mock.calls[0][2] as (
      input: Record<string, unknown>,
      extra: { signal: AbortSignal },
    ) => Promise<{ content: unknown[]; isError: boolean }>;
    const signal = new AbortController().signal;
    const result = await cb({ symbol: 'AAPL' }, { signal });
    expect(execute).toHaveBeenCalledWith(
      'get_stock_price',
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
