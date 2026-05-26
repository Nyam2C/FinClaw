import type { IncomingMessage, ServerResponse } from 'node:http';
import type { ToolRegistry } from '@finclaw/agent';
import { describe, expect, it, vi } from 'vitest';
import { signToken } from '../auth/sign.js';
import type { GatewayServerConfig } from '../rpc/types.js';
import { createMcpHost } from './host.js';

// MCP transport 핸드셰이크(initialize/tools.list/tools.call)는 SDK 책임 + A8 라이브 spike 로 검증됨.
// 본 테스트는 우리 코드의 HTTP 게이트만 검증: (1) 인증 401, (2) 세션 없는 비-initialize 요청 400.

const CONFIG = {
  auth: { apiKeys: [], jwtSecret: 'test', sessionTtlMs: 60_000 },
} as unknown as GatewayServerConfig;

const EMPTY_REGISTRY = { list: () => [] } as unknown as ToolRegistry;

function mockReq(opts: { headers?: Record<string, string>; body?: string }): IncomingMessage {
  const { headers = {}, body } = opts;
  return {
    method: 'POST',
    url: '/mcp',
    headers,
    socket: { remoteAddress: '127.0.0.1' },
    on: vi.fn((event: string, cb: (...args: unknown[]) => void) => {
      if (event === 'data' && body) {
        cb(Buffer.from(body));
      }
      if (event === 'end') {
        cb();
      }
      return undefined;
    }),
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

describe('createMcpHost.handleRequest', () => {
  it('rejects unauthenticated requests with 401', async () => {
    const res = mockRes();
    await createMcpHost(EMPTY_REGISTRY, CONFIG).handleRequest(mockReq({}), res);
    expect(res.statusCode).toBe(401);
  });

  it('rejects an authenticated non-initialize request without a session with 400', async () => {
    const token = signToken({ sub: 'u' }, 'test');
    const body = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} });
    const res = mockRes();
    await createMcpHost(EMPTY_REGISTRY, CONFIG).handleRequest(
      mockReq({ headers: { authorization: `Bearer ${token}` }, body }),
      res,
    );
    expect(res.statusCode).toBe(400);
  });
});
