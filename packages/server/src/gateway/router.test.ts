import { resetEventBus } from '@finclaw/infra';
import { type IncomingMessage, type ServerResponse } from 'node:http';
// packages/server/src/gateway/router.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { z } from 'zod/v4';
import type { GatewayServerContext } from './context.js';
import type { GatewayServerConfig } from './rpc/types.js';
import { handleHttpRequest } from './router.js';
import { clearMethods, registerMethod } from './rpc/index.js';

/** 최소 ctx 팩토리 */
function makeCtx(overrides?: Partial<GatewayServerConfig>): GatewayServerContext {
  const config: GatewayServerConfig = {
    host: '0.0.0.0',
    port: 0,
    cors: { origins: ['http://localhost:3000'], maxAge: 600 },
    auth: { apiKeys: [], jwtSecret: 'test', sessionTtlMs: 60_000 },
    ws: {
      heartbeatIntervalMs: 30_000,
      heartbeatTimeoutMs: 10_000,
      maxPayloadBytes: 1024 * 1024,
      handshakeTimeoutMs: 10_000,
      maxConnections: 100,
    },
    rpc: { maxBatchSize: 10, timeoutMs: 60_000 },
    ...overrides,
  };
  return {
    config,
    httpServer: {} as GatewayServerContext['httpServer'],
    wss: {} as GatewayServerContext['wss'],
    connections: new Map(),
    registry: { activeCount: () => 0 } as GatewayServerContext['registry'],
    broadcaster: {} as GatewayServerContext['broadcaster'],
  };
}

/** http.IncomingMessage/ServerResponse mock */
function mockReqRes(method: string, url: string, body?: string, headers?: Record<string, string>) {
  const req = {
    method,
    url,
    headers: { ...headers },
    socket: { remoteAddress: '127.0.0.1' },
    on: vi.fn((event: string, cb: (...args: unknown[]) => void) => {
      if (event === 'data' && body) {
        cb(Buffer.from(body));
      }
      if (event === 'end') {
        cb();
      }
      return req;
    }),
  } as unknown as IncomingMessage;

  let statusCode = 0;
  let responseBody = '';
  const responseHeaders: Record<string, string> = {};

  const res = {
    writeHead: vi.fn((code: number, hdrs?: Record<string, string>) => {
      statusCode = code;
      if (hdrs) {
        Object.assign(responseHeaders, hdrs);
      }
      return res;
    }),
    setHeader: vi.fn((key: string, value: string) => {
      responseHeaders[key] = value;
    }),
    end: vi.fn((data?: string) => {
      if (data) {
        responseBody = data;
      }
    }),
    getHeader: vi.fn((key: string) => responseHeaders[key]),
    get statusCode() {
      return statusCode;
    },
    get body() {
      return responseBody;
    },
    get sentHeaders() {
      return responseHeaders;
    },
  } as unknown as ServerResponse & {
    body: string;
    statusCode: number;
    sentHeaders: Record<string, string>;
  };

  return { req, res };
}

describe('HTTP Router', () => {
  beforeEach(() => {
    clearMethods();
    resetEventBus();
  });

  it('returns 404 for unknown routes', async () => {
    const ctx = makeCtx();
    const { req, res } = mockReqRes('GET', '/unknown');
    await handleHttpRequest(req, res, ctx);
    expect(res.writeHead).toHaveBeenCalledWith(404, expect.any(Object));
  });

  it('GET /health returns status ok', async () => {
    const ctx = makeCtx();
    const { req, res } = mockReqRes('GET', '/health');
    await handleHttpRequest(req, res, ctx);
    expect(res.writeHead).toHaveBeenCalledWith(200, expect.any(Object));
    const body = JSON.parse((res.end as ReturnType<typeof vi.fn>).mock.calls[0][0]);
    expect(body.status).toBe('ok');
  });

  it('GET /info returns server info', async () => {
    const ctx = makeCtx();
    const { req, res } = mockReqRes('GET', '/info');
    await handleHttpRequest(req, res, ctx);
    expect(res.writeHead).toHaveBeenCalledWith(200, expect.any(Object));
    const body = JSON.parse((res.end as ReturnType<typeof vi.fn>).mock.calls[0][0]);
    expect(body.name).toBe('finclaw-gateway');
  });

  it('POST /rpc dispatches to RPC handler', async () => {
    registerMethod({
      method: 'test.ping',
      description: 'ping',
      authLevel: 'none',
      schema: z.object({}),
      async execute() {
        return { pong: true };
      },
    });

    const ctx = makeCtx();
    const body = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'test.ping', params: {} });
    const { req, res } = mockReqRes('POST', '/rpc', body, {
      'content-type': 'application/json',
    });
    await handleHttpRequest(req, res, ctx);
    expect(res.writeHead).toHaveBeenCalledWith(200, expect.any(Object));
    const result = JSON.parse((res.end as ReturnType<typeof vi.fn>).mock.calls[0][0]);
    expect(result.result).toEqual({ pong: true });
  });

  it('POST /rpc returns parse error for invalid JSON', async () => {
    const ctx = makeCtx();
    const { req, res } = mockReqRes('POST', '/rpc', '{bad json}');
    await handleHttpRequest(req, res, ctx);
    expect(res.writeHead).toHaveBeenCalledWith(400, expect.any(Object));
    const result = JSON.parse((res.end as ReturnType<typeof vi.fn>).mock.calls[0][0]);
    expect(result.error.code).toBe(-32700);
  });

  it('OPTIONS returns CORS preflight with 204', async () => {
    const ctx = makeCtx();
    const { req, res } = mockReqRes('OPTIONS', '/rpc', undefined, {
      origin: 'http://localhost:3000',
    });
    await handleHttpRequest(req, res, ctx);
    expect(res.writeHead).toHaveBeenCalledWith(204);
  });
});
