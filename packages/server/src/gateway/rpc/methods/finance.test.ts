// packages/server/src/gateway/rpc/methods/finance.test.ts
import { resetEventBus } from '@finclaw/infra';
import type { AlertDefinition, AlertStore, CreateAlertInput } from '@finclaw/skills-finance';
import type { RpcMethod } from '@finclaw/types';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { GatewayServerContext } from '../../context.js';
import { RpcErrors } from '../errors.js';
import { clearMethods, dispatchRpc } from '../index.js';
import type { GatewayServerConfig } from '../types.js';
import { registerFinanceMethods, type FinanceRpcDeps } from './finance.js';

function makeServerCtx(): GatewayServerContext {
  const config: GatewayServerConfig = {
    host: '0.0.0.0',
    port: 0,
    auth: { apiKeys: [], jwtSecret: 'test', sessionTtlMs: 60_000 },
    ws: {
      heartbeatIntervalMs: 30_000,
      heartbeatTimeoutMs: 10_000,
      maxPayloadBytes: 1024 * 1024,
      handshakeTimeoutMs: 10_000,
      maxConnections: 100,
    },
    rpc: { maxBatchSize: 10, timeoutMs: 60_000 },
  };
  return {
    config,
    httpServer: {} as GatewayServerContext['httpServer'],
    wss: {} as GatewayServerContext['wss'],
    connections: new Map(),
    registry: { activeCount: () => 0 } as GatewayServerContext['registry'],
    broadcaster: {} as GatewayServerContext['broadcaster'],
    isDraining: false,
  };
}

const tokenCtx = {
  auth: { level: 'token' as const, permissions: [] },
  remoteAddress: '127.0.0.1',
};

function call(method: string, params: unknown) {
  return dispatchRpc(
    {
      jsonrpc: '2.0',
      id: 1,
      method: method as RpcMethod,
      params: params as Record<string, unknown>,
    },
    tokenCtx,
    makeServerCtx(),
  );
}

function makeAlert(overrides: Partial<AlertDefinition> = {}): AlertDefinition {
  return {
    id: 'alert-1',
    userId: 'default',
    name: 'AAPL price_above',
    condition: {
      type: 'price',
      ticker: 'AAPL' as never,
      direction: 'above',
      threshold: 150,
    },
    channels: ['log'],
    cooldownMs: 900_000,
    enabled: true,
    triggerCount: 0,
    createdAt: 1_700_000_000_000,
    updatedAt: 1_700_000_000_000,
    ...overrides,
  };
}

describe('finance.* RPC methods', () => {
  beforeEach(() => {
    clearMethods();
    resetEventBus();
  });

  describe('schema & auth', () => {
    it('finance.quote rejects missing symbol', async () => {
      registerFinanceMethods({});
      const result = await call('finance.quote', {});
      expect((result as { error: { code: number } }).error.code).toBe(RpcErrors.INVALID_PARAMS);
    });

    it('finance.alert.create rejects missing symbol', async () => {
      registerFinanceMethods({});
      const result = await call('finance.alert.create', { condition: 'price_above' });
      expect((result as { error: { code: number } }).error.code).toBe(RpcErrors.INVALID_PARAMS);
    });

    it('finance.quote requires token auth', async () => {
      registerFinanceMethods({});
      const result = await dispatchRpc(
        { jsonrpc: '2.0', id: 1, method: 'finance.quote', params: { symbol: 'AAPL' } },
        { auth: { level: 'none', permissions: [] }, remoteAddress: '127.0.0.1' },
        makeServerCtx(),
      );
      expect((result as { error: { code: number } }).error.code).toBe(RpcErrors.UNAUTHORIZED);
    });
  });

  describe('provider availability', () => {
    it('finance.quote errors when quoteService missing', async () => {
      registerFinanceMethods({});
      const result = await call('finance.quote', { symbol: 'AAPL' });
      const msg = (result as { error: { message: string } }).error.message;
      expect(msg).toContain('provider_unavailable');
    });

    it('finance.news errors when newsAggregator missing', async () => {
      registerFinanceMethods({});
      const result = await call('finance.news', {});
      expect((result as { error: { message: string } }).error.message).toContain(
        'provider_unavailable',
      );
    });

    it('finance.alert.create errors when alertStore missing', async () => {
      registerFinanceMethods({});
      const result = await call('finance.alert.create', {
        symbol: 'AAPL',
        condition: 'price_above',
        threshold: 150,
      });
      expect((result as { error: { message: string } }).error.message).toContain(
        'provider_unavailable',
      );
    });

    it('finance.portfolio.get returns empty snapshot when portfolioStore missing', async () => {
      registerFinanceMethods({});
      const result = await call('finance.portfolio.get', {});
      expect((result as { result: { holdings: unknown[] } }).result.holdings).toEqual([]);
    });
  });

  describe('finance.quote', () => {
    it('calls quoteService.getQuote and returns price', async () => {
      const quoteService = {
        getQuote: vi.fn().mockResolvedValue({ price: 187.23, change: 1.5, changePercent: 0.8 }),
      };
      registerFinanceMethods({ quoteService });
      const result = await call('finance.quote', { symbol: 'aapl' });
      const r = (result as { result: { symbol: string; price: number; changePercent: number } })
        .result;
      expect(quoteService.getQuote).toHaveBeenCalledWith('aapl');
      expect(r.symbol).toBe('AAPL');
      expect(r.price).toBe(187.23);
      expect(r.changePercent).toBe(0.8);
    });

    it('reports invalid_symbol on fetch error', async () => {
      const quoteService = {
        getQuote: vi.fn().mockRejectedValue(new Error('network error')),
      };
      registerFinanceMethods({ quoteService });
      const result = await call('finance.quote', { symbol: 'BOGUS' });
      expect((result as { error: { message: string } }).error.message).toContain('invalid_symbol');
    });
  });

  describe('finance.news', () => {
    it('passes query as keywords and clamps limit to 50', async () => {
      const newsAggregator = { fetchNews: vi.fn().mockResolvedValue([]) };
      registerFinanceMethods({ newsAggregator });
      await call('finance.news', { query: 'tesla', limit: 999 });
      expect(newsAggregator.fetchNews).toHaveBeenCalledWith(
        expect.objectContaining({
          keywords: ['tesla'],
          limit: 50,
        }),
      );
    });

    it('maps NewsItem fields in response', async () => {
      const newsAggregator = {
        fetchNews: vi.fn().mockResolvedValue([
          {
            id: 'n1',
            title: 'Tesla beats',
            url: 'https://example.com/a',
            source: 'newsapi',
            publishedAt: 1_700_000_000_000,
            summary: 'short',
            symbols: ['TSLA'],
          },
        ]),
      };
      registerFinanceMethods({ newsAggregator });
      const result = await call('finance.news', { symbols: ['TSLA'] });
      const r = (result as { result: { articles: Array<{ id: string }>; total: number } }).result;
      expect(r.total).toBe(1);
      expect(r.articles[0].id).toBe('n1');
    });
  });

  describe('finance.alert.create', () => {
    function makeStore(): AlertStore {
      return {
        create: vi.fn((input: CreateAlertInput) => makeAlert({ name: input.name })),
        getById: vi.fn(),
        listByUser: vi.fn().mockReturnValue([]),
        listEnabled: vi.fn().mockReturnValue([]),
        update: vi.fn(),
        delete: vi.fn(),
        setEnabled: vi.fn(),
        recordTrigger: vi.fn(),
        getHistory: vi.fn().mockReturnValue([]),
        getLastTrigger: vi.fn(),
      } as unknown as AlertStore;
    }

    it('requires threshold for price_above', async () => {
      registerFinanceMethods({ alertStore: makeStore() });
      const result = await call('finance.alert.create', {
        symbol: 'AAPL',
        condition: 'price_above',
      });
      expect((result as { error: { message: string } }).error.message).toContain(
        'requires threshold',
      );
    });

    it('requires keyword for news_match', async () => {
      registerFinanceMethods({ alertStore: makeStore() });
      const result = await call('finance.alert.create', {
        symbol: 'AAPL',
        condition: 'news_match',
      });
      expect((result as { error: { message: string } }).error.message).toContain(
        'requires keyword',
      );
    });

    it('creates a price alert and reports immediateTrigger=false when no evaluator hook', async () => {
      const store = makeStore();
      registerFinanceMethods({ alertStore: store });
      const result = await call('finance.alert.create', {
        symbol: 'AAPL',
        condition: 'price_above',
        threshold: 200,
      });
      const r = (result as { result: { alertId: string; immediateTrigger: boolean } }).result;
      expect(r.alertId).toBe('alert-1');
      expect(r.immediateTrigger).toBe(false);
      expect(store.create).toHaveBeenCalledWith(
        expect.objectContaining({
          userId: 'default',
          condition: expect.objectContaining({ type: 'price', direction: 'above', threshold: 200 }),
        }),
      );
    });

    it('invokes evaluateAlertOnce and reports triggered', async () => {
      const store = makeStore();
      const evaluateAlertOnce: FinanceRpcDeps['evaluateAlertOnce'] = vi
        .fn()
        .mockResolvedValue(true);
      registerFinanceMethods({ alertStore: store, evaluateAlertOnce });
      const result = await call('finance.alert.create', {
        symbol: 'AAPL',
        condition: 'price_above',
        threshold: 1,
      });
      const r = (result as { result: { immediateTrigger: boolean } }).result;
      expect(r.immediateTrigger).toBe(true);
      expect(evaluateAlertOnce).toHaveBeenCalledWith('alert-1');
    });

    it('reports immediateTrigger=false when evaluateAlertOnce throws', async () => {
      const store = makeStore();
      const evaluateAlertOnce: FinanceRpcDeps['evaluateAlertOnce'] = vi
        .fn()
        .mockRejectedValue(new Error('evaluator down'));
      registerFinanceMethods({ alertStore: store, evaluateAlertOnce });
      const result = await call('finance.alert.create', {
        symbol: 'AAPL',
        condition: 'price_above',
        threshold: 1,
      });
      const r = (result as { result: { immediateTrigger: boolean } }).result;
      expect(r.immediateTrigger).toBe(false);
    });
  });

  describe('finance.alert.list', () => {
    it('filters by symbol client-side', async () => {
      const alerts: AlertDefinition[] = [
        makeAlert({
          id: 'a1',
          name: 'AAPL above',
          condition: { type: 'price', ticker: 'AAPL' as never, direction: 'above', threshold: 200 },
        }),
        makeAlert({
          id: 'a2',
          name: 'TSLA above',
          condition: { type: 'price', ticker: 'TSLA' as never, direction: 'above', threshold: 300 },
        }),
      ];
      const alertStore = {
        listByUser: vi.fn().mockReturnValue(alerts),
      } as unknown as AlertStore;
      registerFinanceMethods({ alertStore });
      const result = await call('finance.alert.list', { symbol: 'TSLA' });
      const r = (
        result as { result: { alerts: Array<{ id: string; symbol: string }>; total: number } }
      ).result;
      expect(r.total).toBe(1);
      expect(r.alerts[0].id).toBe('a2');
      expect(r.alerts[0].symbol).toBe('TSLA');
    });
  });

  describe('finance.portfolio.get', () => {
    it('returns holdings from first portfolio', async () => {
      const portfolioStore = {
        listPortfolios: vi.fn().mockReturnValue([
          {
            id: 'p1',
            name: 'Main',
            currency: 'USD',
            updatedAt: 1_700_000_000_000,
            holdings: [
              { symbol: 'AAPL', quantity: 10, averageCost: 150 },
              { symbol: 'TSLA', quantity: 5, averageCost: 200 },
            ],
          },
        ]),
      } as unknown as FinanceRpcDeps['portfolioStore'];
      registerFinanceMethods({ portfolioStore });
      const result = await call('finance.portfolio.get', {});
      const r = (
        result as {
          result: {
            holdings: Array<{ symbol: string; avgPrice: number }>;
            summary: { totalHoldings: number };
          };
        }
      ).result;
      expect(r.holdings).toHaveLength(2);
      expect(r.holdings[0]).toEqual({
        symbol: 'AAPL',
        quantity: 10,
        avgPrice: 150,
        currency: 'USD',
      });
      expect(r.summary.totalHoldings).toBe(2);
    });

    it('returns empty snapshot when no portfolios', async () => {
      const portfolioStore = {
        listPortfolios: vi.fn().mockReturnValue([]),
      } as unknown as FinanceRpcDeps['portfolioStore'];
      registerFinanceMethods({ portfolioStore });
      const result = await call('finance.portfolio.get', {});
      const r = (result as { result: { holdings: unknown[]; summary: { currency: string } } })
        .result;
      expect(r.holdings).toEqual([]);
      expect(r.summary.currency).toBe('USD');
    });
  });
});
