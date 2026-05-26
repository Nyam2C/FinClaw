import type { IncomingMessage, ServerResponse } from 'node:http';
import type { ToolRegistry } from '@finclaw/agent';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { describe, expect, it, vi } from 'vitest';
import type { GatewayServerConfig } from '../rpc/types.js';
import { createMcpHost, jsonSchemaToZodShape, registerSingleTool } from './host.js';

// MCP transport 핸드셰이크(JSON-RPC initialize/tools.list)는 SDK 책임 → 본 테스트는 우리 코드
// 경계만 검증: (1) 인증 게이트(401), (2) jsonSchemaToZodShape 변환, (3) registerSingleTool 의 execute 경유 ctx.
// (stateful 세션 라우팅 + 실제 tool 노출은 A8 라이브 spike 로 검증.)

const AUTH_CONFIG = {
  apiKeys: [],
  jwtSecret: 'test',
  sessionTtlMs: 60_000,
} as unknown as GatewayServerConfig['auth'];

/** 인증 헤더 없는 요청 (authenticate → level:'none'). */
function mockUnauthReq(): IncomingMessage {
  return {
    method: 'POST',
    url: '/mcp',
    headers: {},
    socket: { remoteAddress: '127.0.0.1' },
  } as unknown as IncomingMessage;
}

function mockRes() {
  let statusCode = 0;
  const res = {
    writeHead: vi.fn((code: number) => {
      statusCode = code;
      return res;
    }),
    end: vi.fn(),
    on: vi.fn(),
    get statusCode() {
      return statusCode;
    },
  };
  return res as unknown as ServerResponse & { statusCode: number };
}

function makeMockRegistry(execute?: ReturnType<typeof vi.fn>): ToolRegistry {
  return {
    get: (name: string) =>
      name === 'get_stock_price'
        ? {
            definition: {
              name: 'get_stock_price',
              description: 'Get a stock quote',
              inputSchema: {
                type: 'object',
                properties: { symbol: { type: 'string', description: 'ticker' } },
                required: ['symbol'],
              },
              group: 'finance',
              requiresApproval: false,
              isTransactional: false,
              accessesSensitiveData: false,
            },
            executor: async () => ({ content: '', isError: false }),
            registeredAt: new Date(),
            source: 'built-in' as const,
          }
        : undefined,
    execute: execute ?? vi.fn().mockResolvedValue({ content: 'AAPL $150', isError: false }),
    list: () => [],
    listByGroup: () => [],
    has: (n: string) => n === 'get_stock_price',
    register: vi.fn(),
    unregister: vi.fn(),
    addPolicyRule: vi.fn(),
  } as unknown as ToolRegistry;
}

describe('createMcpHost.handleRequest', () => {
  it('rejects unauthenticated requests with 401', async () => {
    const res = mockRes();
    const host = createMcpHost(makeMockRegistry());
    await host.handleRequest(mockUnauthReq(), res, AUTH_CONFIG);
    expect(res.statusCode).toBe(401);
  });
});

describe('registerSingleTool', () => {
  it('registers the tool and routes its callback through toolRegistry.execute with mcp ctx', async () => {
    const execute = vi.fn().mockResolvedValue({ content: 'AAPL $150', isError: false });
    const registerTool = vi.fn();
    const server = { registerTool } as unknown as McpServer;
    registerSingleTool(server, makeMockRegistry(execute), 'get_stock_price', 'user1');

    expect(registerTool).toHaveBeenCalledTimes(1);
    const [name, config, cb] = registerTool.mock.calls[0] as [
      string,
      { description: string },
      (input: Record<string, unknown>) => Promise<{ content: unknown[]; isError: boolean }>,
    ];
    expect(name).toBe('get_stock_price');
    expect(config.description).toBe('Get a stock quote');

    const result = await cb({ symbol: 'AAPL' });
    expect(execute).toHaveBeenCalledWith(
      'get_stock_price',
      { symbol: 'AAPL' },
      expect.objectContaining({ sessionId: 'mcp', userId: 'user1', channelId: 'mcp' }),
    );
    expect(result.isError).toBe(false);
    expect(result.content).toEqual([{ type: 'text', text: 'AAPL $150' }]);
  });

  it('skips registration when the tool is not in the registry', () => {
    const registerTool = vi.fn();
    const server = { registerTool } as unknown as McpServer;
    registerSingleTool(server, makeMockRegistry(), 'unknown_tool', 'user1');
    expect(registerTool).not.toHaveBeenCalled();
  });
});

describe('jsonSchemaToZodShape', () => {
  it('maps properties with required vs optional', () => {
    const shape = jsonSchemaToZodShape({
      type: 'object',
      properties: {
        symbol: { type: 'string', description: 'ticker' },
        range: { type: 'string', enum: ['1d', '1w'] },
      },
      required: ['symbol'],
    });
    expect(shape.symbol).toBeDefined();
    expect(shape.range).toBeDefined();
    // required: symbol 누락 시 실패, range 누락은 통과 (optional).
    expect(shape.symbol.safeParse(undefined).success).toBe(false);
    expect(shape.range.safeParse(undefined).success).toBe(true);
  });

  it('returns empty shape when no properties', () => {
    expect(jsonSchemaToZodShape({ type: 'object' })).toEqual({});
  });
});
