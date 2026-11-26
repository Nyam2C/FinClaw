// packages/skills-finance/test/toss/tools.test.ts
import { InMemoryToolRegistry } from '@finclaw/agent';
import { describe, expect, it, vi } from 'vitest';
import type { TossClient } from '../../src/toss/client.js';
import { registerTossTools } from '../../src/toss/tools.js';

type Call = { path: string; query: Record<string, unknown>; account: boolean };

/** 경로별 고정 응답을 돌려주는 가짜 클라이언트. 공개 메서드가 get 뿐이라 가짜도 get 만 있으면 된다. */
function fakeClient(routes: Record<string, unknown>) {
  const calls: Call[] = [];
  const get = vi.fn(
    async (path: string, query: Record<string, unknown> = {}, opts: { account?: boolean } = {}) => {
      calls.push({ path, query, account: opts.account === true });
      if (!(path in routes)) {
        throw new Error(`toss 404 not-found: ${path}`);
      }
      const reply = routes[path];
      return typeof reply === 'function'
        ? (reply as (q: Record<string, unknown>) => unknown)(query)
        : reply;
    },
  );
  return { client: { get } as unknown as TossClient, calls };
}

const ctx = {
  sessionId: 's',
  userId: 'default',
  channelId: 'agent',
  abortSignal: new AbortController().signal,
};

function setup(routes: Record<string, unknown>) {
  const registry = new InMemoryToolRegistry();
  const fake = fakeClient(routes);
  registerTossTools(registry, fake.client, { sleep: async () => {} });
  const run = async (name: string, input: Record<string, unknown> = {}) => {
    const result = await registry.execute(name, input, ctx);
    return { isError: result.isError, text: result.content, json: safeJson(result.content) };
  };
  return { registry, run, calls: fake.calls };
}

function safeJson(text: string): Record<string, unknown> | undefined {
  try {
    return JSON.parse(text) as Record<string, unknown>;
  } catch {
    return undefined;
  }
}

describe('registerTossTools', () => {
  it('조회 도구만 등록한다 — 주문·조건주문을 넣는 도구는 없다', () => {
    const { registry } = setup({});
    const names = registry
      .list()
      .map((t) => t.definition.name)
      .toSorted();
    expect(names).toEqual([
      'find_stock',
      'get_account_activity',
      'get_candles',
      'get_holdings',
      'get_market_overview',
      'get_orderbook',
      'get_quote',
      'get_rankings',
      'get_stock_signals',
    ]);
    for (const t of registry.list()) {
      expect(t.definition.isTransactional).toBe(false);
      expect(t.definition.requiresApproval).toBe(false);
    }
  });

  it('get_quote: 현재가에 종목명과 전일 대비 등락을 붙인다', async () => {
    const { run, calls } = setup({
      '/api/v1/prices': [
        {
          symbol: '005930',
          timestamp: '2026-11-26T13:57:23.000+09:00',
          lastPrice: '173800',
          currency: 'KRW',
        },
        {
          symbol: 'AAPL',
          timestamp: '2026-11-26T09:59:54.000+09:00',
          lastPrice: '355.14',
          currency: 'USD',
        },
      ],
      '/api/v1/stocks': [
        { symbol: '005930', name: '삼성전자', market: 'KOSPI' },
        { symbol: 'AAPL', name: '애플', market: 'NASDAQ' },
      ],
      '/api/v1/candles': (q: Record<string, unknown>) =>
        q.symbol === '005930'
          ? {
              candles: [
                { timestamp: '2026-11-26T00:00:00.000+09:00', closePrice: '173750' }, // 오늘 봉
                { timestamp: '2026-11-25T00:00:00.000+09:00', closePrice: '166800' },
              ],
            }
          : { candles: [{ timestamp: '2026-11-25T00:00:00.000-05:00', closePrice: '350.00' }] }, // 장 시작 전
    });
    const { isError, json } = await run('get_quote', { symbols: ['005930', 'aapl', '005930'] });

    expect(isError).toBe(false);
    expect(calls[0]).toMatchObject({ path: '/api/v1/prices', query: { symbols: '005930,AAPL' } });
    expect(json?.quotes).toEqual([
      {
        symbol: '005930',
        name: '삼성전자',
        market: 'KOSPI',
        lastPrice: '173800',
        currency: 'KRW',
        asOf: '2026-11-26T13:57:23.000+09:00',
        prevClose: '166800',
        change: 7000,
        changeRatePct: 4.2,
      },
      {
        symbol: 'AAPL',
        name: '애플',
        market: 'NASDAQ',
        lastPrice: '355.14',
        currency: 'USD',
        asOf: '2026-11-26T09:59:54.000+09:00',
        prevClose: '350.00',
        change: 5.14,
        changeRatePct: 1.47,
      },
    ]);
  });

  it('잘못된 종목코드는 요청을 보내지 않고 고칠 방법을 알려 준다', async () => {
    const { run, calls } = setup({});
    for (const symbol of ['../oauth2/token', '삼성전자', '']) {
      const r = await run('get_candles', { symbol });
      expect(r.isError).toBe(true);
      expect(r.text).toContain('find_stock');
    }
    expect(calls).toHaveLength(0);
  });

  it('find_stock: 종목 목록을 한 번만 받아 이름·코드로 찾는다 (정확히 같은 것이 먼저)', async () => {
    const { run, calls } = setup({
      '/api/v1/stocks/all': (q: Record<string, unknown>) =>
        q.market === 'KOSPI'
          ? [
              { symbol: '005935', name: '삼성전자우', securityType: 'STOCK' },
              { symbol: '005930', name: '삼성전자', securityType: 'STOCK' },
            ]
          : q.market === 'NASDAQ'
            ? [{ symbol: 'AAPL', name: '애플', securityType: 'STOCK' }]
            : [],
    });
    const first = await run('find_stock', { query: '삼성전자' });
    expect(((first.json?.matches ?? []) as { symbol: string }[]).map((m) => m.symbol)).toEqual([
      '005930',
      '005935',
    ]);
    const second = await run('find_stock', { query: 'aapl' });
    expect(second.json?.matches).toEqual([
      { symbol: 'AAPL', name: '애플', market: 'NASDAQ', securityType: 'STOCK' },
    ]);
    expect(calls.filter((c) => c.path === '/api/v1/stocks/all')).toHaveLength(5); // 시장 5개 × 1회
  });

  it('계좌 도구는 계좌 헤더로 조회하고, 계좌번호는 결과에서 뺀다', async () => {
    const { run, calls } = setup({
      '/api/v1/holdings': {
        accountNo: '12345678901',
        marketValue: { amount: { krw: '1234567' } },
        items: [{ symbol: '005930', quantity: '10' }],
      },
      '/api/v1/orders': { orders: [], hasNext: false },
    });
    const holdings = await run('get_holdings');
    expect(holdings.isError).toBe(false);
    expect(holdings.text).not.toContain('12345678901');
    expect(holdings.text).not.toContain('accountNo');
    expect(holdings.json?.items).toEqual([{ symbol: '005930', quantity: '10' }]);

    await run('get_account_activity', { kind: 'open_orders' });
    expect(calls).toEqual([
      { path: '/api/v1/holdings', query: {}, account: true },
      { path: '/api/v1/orders', query: { status: 'OPEN', limit: 20 }, account: true },
    ]);
  });

  it('큰 금액은 결과 가드에 지워지지 않게 천 단위 쉼표로 내보낸다', async () => {
    const { run } = setup({
      '/api/v1/rankings': {
        rankedAt: null,
        rankings: [
          { rank: 1, symbol: '005930', tradingAmount: '3051234567890', tradingVolume: '17531281' },
        ],
      },
      '/api/v1/stocks': [{ symbol: '005930', name: '삼성전자' }],
    });
    const r = await run('get_rankings', { type: 'MARKET_TRADING_AMOUNT', market: 'KR' });
    expect(r.text).not.toContain('[REDACTED]');
    expect(((r.json?.rankings ?? []) as Record<string, unknown>[])[0]).toMatchObject({
      name: '삼성전자',
      tradingAmount: '3,051,234,567,890',
      tradingVolume: '17531281',
    });
  });

  it('API 오류는 예외가 아니라 에러 결과로 돌아간다', async () => {
    const { run } = setup({});
    const r = await run('get_orderbook', { symbol: 'NOPE' });
    expect(r.isError).toBe(true);
    expect(r.text).toContain('not-found');
  });
});
