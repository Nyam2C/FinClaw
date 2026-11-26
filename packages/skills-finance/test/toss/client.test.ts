// packages/skills-finance/test/toss/client.test.ts
import { mkdtempSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { TossApiError, TossClient } from '../../src/toss/client.js';

type Reply = { status?: number; body: unknown; headers?: Record<string, string> };

/** URL 경로별 응답 큐. 큐가 1개 남으면 그 응답을 계속 돌려준다. */
function fakeFetch(routes: Record<string, Reply[]>) {
  const calls: { method: string; path: string; search: string; headers: Record<string, string> }[] =
    [];
  const fn = vi.fn(async (input: URL | string | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    calls.push({
      method: init?.method ?? 'GET',
      path: url.pathname,
      search: url.search,
      headers: (init?.headers ?? {}) as Record<string, string>,
    });
    const queue = routes[url.pathname];
    if (!queue || queue.length === 0) {
      throw new Error(`unexpected request: ${url.pathname}`);
    }
    const reply = queue.length > 1 ? (queue.shift() as Reply) : queue[0];
    return new Response(JSON.stringify(reply.body), {
      status: reply.status ?? 200,
      headers: reply.headers,
    });
  });
  return { fn: fn as unknown as typeof fetch, calls };
}

const token = (value: string): Reply => ({ body: { access_token: value, expires_in: 86_399 } });
const dir = () => mkdtempSync(join(tmpdir(), 'toss-'));

function client(fetchFn: typeof fetch, tokenPath = join(dir(), 'token.json')) {
  return new TossClient({
    clientId: 'cid',
    clientSecret: 'secret',
    tokenPath,
    fetchFn,
    now: () => 1_000_000,
    sleep: vi.fn(async () => {}),
  });
}

describe('TossClient', () => {
  it('토큰은 한 번만 발급하고, 그 밖의 요청은 전부 /api/v1 GET 이다', async () => {
    const { fn, calls } = fakeFetch({
      '/oauth2/token': [token('t1')],
      '/api/v1/prices': [{ body: { result: [{ symbol: '005930', lastPrice: '70000' }] } }],
      '/api/v1/accounts': [{ body: { result: [{ accountSeq: 7, accountNo: 'x' }] } }],
      '/api/v1/holdings': [{ body: { result: { items: [] } } }],
    });
    const toss = client(fn);
    const prices = await toss.get<{ symbol: string }[]>('/api/v1/prices', { symbols: '005930' });
    await toss.get('/api/v1/prices', { symbols: 'AAPL', skipped: undefined });
    await toss.get('/api/v1/holdings', {}, { account: true });
    await toss.get('/api/v1/holdings', {}, { account: true });

    expect(prices[0].symbol).toBe('005930');
    expect(calls.filter((c) => c.path === '/oauth2/token')).toHaveLength(1);
    expect(calls.filter((c) => c.path === '/api/v1/accounts')).toHaveLength(1);
    for (const call of calls.filter((c) => c.path !== '/oauth2/token')) {
      expect(call.method).toBe('GET');
      expect(call.path.startsWith('/api/v1/')).toBe(true);
      expect(call.headers.authorization).toBe('Bearer t1');
    }
    expect(calls[2].search).toBe('?symbols=AAPL');
    expect(calls.at(-1)?.headers['x-tossinvest-account']).toBe('7');
  });

  it('허용 경로 밖은 요청을 보내지 않고 거부한다', async () => {
    const { fn, calls } = fakeFetch({});
    const toss = client(fn);
    for (const path of [
      '/oauth2/token',
      '/api/v2/prices',
      '/api/v1/stocks/../../oauth2/token',
      '/api/v1/prices?symbols=1',
      'https://evil.example/api/v1/prices',
    ]) {
      await expect(toss.get(path)).rejects.toThrow('path not allowed');
    }
    expect(calls).toHaveLength(0);
  });

  it('토큰이 revoked 되면 한 번 재발급해 다시 보낸다', async () => {
    const { fn, calls } = fakeFetch({
      '/oauth2/token': [token('old'), token('new')],
      '/api/v1/prices': [
        { status: 401, body: { error: { code: 'token-revoked', message: 'revoked' } } },
        { body: { result: [] } },
      ],
    });
    await client(fn).get('/api/v1/prices', { symbols: 'AAPL' });
    expect(calls.map((c) => c.headers.authorization ?? 'issue')).toEqual([
      'issue',
      'Bearer old',
      'issue',
      'Bearer new',
    ]);
  });

  it('발급한 토큰을 0600 파일로 공유해, 다른 인스턴스는 발급 없이 쓴다', async () => {
    const path = join(dir(), 'token.json');
    const first = fakeFetch({
      '/oauth2/token': [token('shared')],
      '/api/v1/prices': [{ body: { result: [] } }],
    });
    await client(first.fn, path).get('/api/v1/prices', { symbols: 'AAPL' });
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(JSON.parse(readFileSync(path, 'utf8')).accessToken).toBe('shared');

    const second = fakeFetch({ '/api/v1/prices': [{ body: { result: [] } }] });
    await client(second.fn, path).get('/api/v1/prices', { symbols: 'AAPL' });
    expect(second.calls).toHaveLength(1);
    expect(second.calls[0].headers.authorization).toBe('Bearer shared');
  });

  it('429 는 Retry-After 만큼 기다려 한 번 재시도한다', async () => {
    const { fn, calls } = fakeFetch({
      '/oauth2/token': [token('t1')],
      '/api/v1/prices': [
        { status: 429, body: { error: { code: 'rate-limit' } }, headers: { 'retry-after': '2' } },
        { body: { result: [] } },
      ],
    });
    const sleep = vi.fn(async () => {});
    const toss = new TossClient({
      clientId: 'cid',
      clientSecret: 'secret',
      tokenPath: join(dir(), 'token.json'),
      fetchFn: fn,
      sleep,
    });
    await toss.get('/api/v1/prices', { symbols: 'AAPL' });
    expect(sleep).toHaveBeenCalledWith(2000);
    expect(calls.filter((c) => c.path === '/api/v1/prices')).toHaveLength(2);
  });

  it('에러 envelope 을 TossApiError 로 올린다', async () => {
    const { fn } = fakeFetch({
      '/oauth2/token': [token('t1')],
      '/api/v1/stocks': [
        { status: 404, body: { error: { code: 'stock-not-found', message: '없음' } } },
      ],
    });
    const err = await client(fn)
      .get('/api/v1/stocks', { symbols: 'NOPE' })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(TossApiError);
    expect(err).toMatchObject({ status: 404, code: 'stock-not-found' });
  });

  it('토큰 발급 실패(OAuth2 형식)를 TossApiError 로 올린다', async () => {
    const { fn } = fakeFetch({
      '/oauth2/token': [
        { status: 403, body: { error: 'access_denied', error_description: 'ip not allowed' } },
      ],
    });
    await expect(client(fn).get('/api/v1/prices', { symbols: 'AAPL' })).rejects.toMatchObject({
      status: 403,
      code: 'access_denied',
    });
  });
});
