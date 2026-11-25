// packages/server/src/cli/__tests__/gateway-client.test.ts
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { issueLocalToken } from '../../composition/local-auth.js';
import { getGatewayHealth, callGateway } from '../gateway-client.js';

const mockFetch = vi.fn<(input: string | URL | Request, init?: RequestInit) => Promise<Response>>();

beforeEach(() => {
  vi.stubGlobal('fetch', mockFetch);
  mockFetch.mockReset();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('getGatewayHealth', () => {
  it('returns data on success', async () => {
    mockFetch.mockResolvedValue(new Response(JSON.stringify({ status: 'ok' }), { status: 200 }));
    const result = await getGatewayHealth();
    expect(result).toEqual({ ok: true, data: { status: 'ok' } });
  });

  it('returns error on HTTP failure', async () => {
    mockFetch.mockResolvedValue(
      new Response('', { status: 503, statusText: 'Service Unavailable' }),
    );
    const result = await getGatewayHealth();
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe(503);
    expect(result.error?.message).toContain('503');
  });

  it('returns error on network failure', async () => {
    mockFetch.mockRejectedValue(new Error('Connection refused'));
    const result = await getGatewayHealth();
    expect(result).toEqual({ ok: false, error: { code: -1, message: 'Connection refused' } });
  });
});

describe('callGateway', () => {
  it('returns RPC result on success', async () => {
    mockFetch.mockResolvedValue(
      new Response(JSON.stringify({ result: { version: '0.1.0' } }), { status: 200 }),
    );
    const result = await callGateway('system.info');
    expect(result).toEqual({ ok: true, data: { version: '0.1.0' } });
  });

  it('returns error on RPC error', async () => {
    mockFetch.mockResolvedValue(
      new Response(JSON.stringify({ error: { message: 'Method not found' } }), { status: 200 }),
    );
    const result = await callGateway('unknown.method');
    expect(result.ok).toBe(false);
    expect(result.error?.message).toBe('Method not found');
  });

  it('returns error on network failure', async () => {
    mockFetch.mockRejectedValue(new Error('timeout'));
    const result = await callGateway('system.info');
    expect(result).toEqual({ ok: false, error: { code: -1, message: 'timeout' } });
  });

  it('B10: opts.token 이 있으면 Authorization: Bearer', async () => {
    mockFetch.mockResolvedValue(new Response(JSON.stringify({ result: {} }), { status: 200 }));
    await callGateway('agent.list', undefined, { token: 'tok' });
    const init = mockFetch.mock.calls[0]?.[1];
    expect((init?.headers as Record<string, string> | undefined)?.Authorization).toBe('Bearer tok');
  });

  it('B10: token 미지정이면 ~/.finclaw/gateway.token 을 쓴다', async () => {
    issueLocalToken('s');
    mockFetch.mockResolvedValue(new Response(JSON.stringify({ result: {} }), { status: 200 }));
    await callGateway('agent.list');
    const init = mockFetch.mock.calls[0]?.[1];
    expect((init?.headers as Record<string, string> | undefined)?.Authorization).toMatch(
      /^Bearer [\w-]+\.[\w-]+\.[\w-]+$/,
    );
  });
});
