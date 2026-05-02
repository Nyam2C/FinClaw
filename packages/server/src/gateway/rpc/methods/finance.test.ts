// packages/server/src/gateway/rpc/methods/finance.test.ts
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resetEventBus } from '@finclaw/infra';
import type { AlertDefinition, AlertStore, CreateAlertInput } from '@finclaw/skills-finance';
import { type Database, openDatabase } from '@finclaw/storage';
import type { RpcMethod } from '@finclaw/types';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { GatewayBroadcaster } from '../../broadcaster.js';
import type { GatewayServerContext } from '../../context.js';
import { RpcErrors } from '../errors.js';
import { clearMethods, dispatchRpc } from '../index.js';
import type { GatewayServerConfig, WsConnection } from '../types.js';
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
      const r = (
        result as {
          result: {
            holdings: unknown[];
            summary: { currency: string };
            recentTransactions: unknown[];
          };
        }
      ).result;
      expect(r.holdings).toEqual([]);
      expect(r.summary.currency).toBe('USD');
      expect(r.recentTransactions).toEqual([]);
    });
  });

  // ─── Phase 26 A: finance.transaction.* ───
  describe('finance.transaction.*', () => {
    let tmpDir: string;
    let database: Database;
    const PF_ID = 'pf-test';

    function seedPortfolio(): void {
      database.db
        .prepare(
          "INSERT INTO portfolios (id, name, currency, updated_at) VALUES (?, 'Test', 'USD', 1700000000000)",
        )
        .run(PF_ID);
    }

    function makeBroadcaster(): { spy: ReturnType<typeof vi.fn>; broadcaster: GatewayBroadcaster } {
      const spy = vi.fn().mockReturnValue(1);
      const broadcaster = { broadcastToChannel: spy } as unknown as GatewayBroadcaster;
      return { spy, broadcaster };
    }

    function makeConnections(): Map<string, WsConnection> {
      // 핸들러는 broadcaster 에 connections 를 그대로 넘기기만 하므로 빈 Map 으로도 호출 검증 가능.
      return new Map<string, WsConnection>();
    }

    function makePortfolioStore(): FinanceRpcDeps['portfolioStore'] {
      return {
        listPortfolios: vi.fn().mockReturnValue([
          {
            id: PF_ID,
            name: 'Test',
            currency: 'USD',
            updatedAt: 1_700_000_000_000,
            holdings: [],
          },
        ]),
      } as unknown as FinanceRpcDeps['portfolioStore'];
    }

    beforeEach(() => {
      tmpDir = mkdtempSync(join(tmpdir(), 'finclaw-rpc-fin-'));
      database = openDatabase({ path: join(tmpDir, 'rpc.db') });
      seedPortfolio();
    });

    afterEach(() => {
      database.close();
      rmSync(tmpDir, { recursive: true, force: true });
    });

    it('transaction.add inserts row, recomputes holdings, and broadcasts portfolio.changed', async () => {
      const { spy, broadcaster } = makeBroadcaster();
      const connections = makeConnections();
      registerFinanceMethods({ db: database.db, broadcaster, connections });

      const result = await call('finance.transaction.add', {
        symbol: 'aapl',
        action: 'buy',
        quantity: 10,
        price: 180,
        currency: 'USD',
        executedAt: 1_710_000_000_000,
      });

      const r = (
        result as {
          result: {
            transactionId: string;
            createdAt: number;
            updatedHoldings: Array<{ symbol: string; quantity: number; averageCost: number }>;
          };
        }
      ).result;

      expect(typeof r.transactionId).toBe('string');
      expect(r.transactionId.length).toBeGreaterThan(0);
      expect(r.updatedHoldings).toHaveLength(1);
      expect(r.updatedHoldings[0]).toEqual({ symbol: 'AAPL', quantity: 10, averageCost: 180 });

      // broadcaster 호출 검증
      expect(spy).toHaveBeenCalledTimes(1);
      const [conns, channel, payload] = spy.mock.calls[0] as [
        Map<string, WsConnection>,
        string,
        { portfolioId: string; reason: string; transactionId: string },
      ];
      expect(conns).toBe(connections);
      expect(channel).toBe('portfolio.changed');
      expect(payload.portfolioId).toBe(PF_ID);
      expect(payload.reason).toBe('transaction.add');
      expect(payload.transactionId).toBe(r.transactionId);
    });

    it('transaction.add errors with provider_unavailable when db missing', async () => {
      registerFinanceMethods({});
      const result = await call('finance.transaction.add', {
        symbol: 'AAPL',
        action: 'buy',
        quantity: 1,
        price: 100,
        currency: 'USD',
        executedAt: 1_710_000_000_000,
      });
      const msg = (result as { error: { message: string } }).error.message;
      expect(msg).toContain('provider_unavailable');
    });

    it('transaction.add errors with not_found when portfolioId does not exist', async () => {
      registerFinanceMethods({ db: database.db });
      const result = await call('finance.transaction.add', {
        portfolioId: 'pf-missing',
        symbol: 'AAPL',
        action: 'buy',
        quantity: 1,
        price: 100,
        currency: 'USD',
        executedAt: 1_710_000_000_000,
      });
      expect((result as { error: { message: string } }).error.message).toContain('not_found');
    });

    it('transaction.list returns rows in executed_at DESC order', async () => {
      registerFinanceMethods({ db: database.db });

      // 시드: 두 건 추가 (executedAt 순서 다르게)
      await call('finance.transaction.add', {
        symbol: 'AAPL',
        action: 'buy',
        quantity: 5,
        price: 200,
        currency: 'USD',
        executedAt: 1_700_000_000_000,
      });
      await call('finance.transaction.add', {
        symbol: 'AAPL',
        action: 'buy',
        quantity: 10,
        price: 180,
        currency: 'USD',
        executedAt: 1_710_000_000_000,
      });

      const result = await call('finance.transaction.list', { portfolioId: PF_ID });
      const r = (
        result as {
          result: { transactions: Array<{ executedAt: number; quantity: number }> };
        }
      ).result;
      expect(r.transactions).toHaveLength(2);
      expect(r.transactions[0].executedAt).toBe(1_710_000_000_000);
      expect(r.transactions[1].executedAt).toBe(1_700_000_000_000);
    });

    it('transaction.delete removes row, returns updatedHoldings, and broadcasts', async () => {
      const { spy, broadcaster } = makeBroadcaster();
      const connections = makeConnections();
      registerFinanceMethods({ db: database.db, broadcaster, connections });

      const addResult = await call('finance.transaction.add', {
        symbol: 'AAPL',
        action: 'buy',
        quantity: 10,
        price: 180,
        currency: 'USD',
        executedAt: 1_710_000_000_000,
      });
      const txnId = (addResult as { result: { transactionId: string } }).result.transactionId;

      spy.mockClear();

      const delResult = await call('finance.transaction.delete', { transactionId: txnId });
      const r = (
        delResult as {
          result: { deleted: boolean; updatedHoldings: Array<unknown> };
        }
      ).result;
      expect(r.deleted).toBe(true);
      expect(r.updatedHoldings).toEqual([]); // 마지막 buy 삭제 → holdings 비워짐

      expect(spy).toHaveBeenCalledTimes(1);
      const [, channel, payload] = spy.mock.calls[0] as [
        unknown,
        string,
        { reason: string; transactionId: string },
      ];
      expect(channel).toBe('portfolio.changed');
      expect(payload.reason).toBe('transaction.delete');
      expect(payload.transactionId).toBe(txnId);
    });

    it('transaction.delete errors with not_found for unknown id', async () => {
      registerFinanceMethods({ db: database.db });
      const result = await call('finance.transaction.delete', { transactionId: 'unknown-id' });
      expect((result as { error: { message: string } }).error.message).toContain('not_found');
    });

    it('transaction.update broadcasts and reflects new holdings', async () => {
      const { spy, broadcaster } = makeBroadcaster();
      const connections = makeConnections();
      registerFinanceMethods({ db: database.db, broadcaster, connections });

      const addResult = await call('finance.transaction.add', {
        symbol: 'AAPL',
        action: 'buy',
        quantity: 10,
        price: 180,
        currency: 'USD',
        executedAt: 1_710_000_000_000,
      });
      const txnId = (addResult as { result: { transactionId: string } }).result.transactionId;
      spy.mockClear();

      const updResult = await call('finance.transaction.update', {
        transactionId: txnId,
        quantity: 20,
      });
      const r = (
        updResult as {
          result: { updatedHoldings: Array<{ symbol: string; quantity: number }> };
        }
      ).result;
      expect(r.updatedHoldings[0].quantity).toBe(20);

      expect(spy).toHaveBeenCalledTimes(1);
      const [, , payload] = spy.mock.calls[0] as [
        unknown,
        unknown,
        { reason: string; transactionId: string },
      ];
      expect(payload.reason).toBe('transaction.update');
      expect(payload.transactionId).toBe(txnId);
    });

    it('portfolio.get includes recentTransactions when db is provided', async () => {
      registerFinanceMethods({
        db: database.db,
        portfolioStore: makePortfolioStore(),
      });

      // 거래 1건 추가 후 portfolio.get 호출
      await call('finance.transaction.add', {
        symbol: 'AAPL',
        action: 'buy',
        quantity: 10,
        price: 180,
        currency: 'USD',
        executedAt: 1_710_000_000_000,
      });

      const result = await call('finance.portfolio.get', {});
      const r = (
        result as {
          result: {
            recentTransactions: Array<{ symbol: string; quantity: number; action: string }>;
          };
        }
      ).result;
      expect(r.recentTransactions).toHaveLength(1);
      expect(r.recentTransactions[0].symbol).toBe('AAPL');
      expect(r.recentTransactions[0].action).toBe('buy');
    });

    it('portfolio.get returns empty recentTransactions when db is missing', async () => {
      registerFinanceMethods({ portfolioStore: makePortfolioStore() });
      const result = await call('finance.portfolio.get', {});
      const r = (result as { result: { recentTransactions: unknown[] } }).result;
      expect(r.recentTransactions).toEqual([]);
    });

    it('transaction.add succeeds even when broadcaster is missing (best-effort)', async () => {
      registerFinanceMethods({ db: database.db });
      const result = await call('finance.transaction.add', {
        symbol: 'AAPL',
        action: 'buy',
        quantity: 1,
        price: 100,
        currency: 'USD',
        executedAt: 1_710_000_000_000,
      });
      // 에러 없이 result 반환
      expect((result as { result: { transactionId: string } }).result.transactionId).toBeTruthy();
    });

    // Phase 26 A QA: storage ↔ RPC ↔ portfolio.get 경계면 통합 검증
    it('transaction.add followed by portfolio.get returns the new holding in recentTransactions and updated holdings', async () => {
      // portfolioStore mock 이 db 의 portfolio_holdings 를 동적으로 읽도록 구성 →
      // production 의 SQLite 기반 PortfolioStore 와 동일한 경계 시뮬레이션.
      const dynamicPortfolioStore = {
        listPortfolios: vi.fn(() => {
          const rows = database.db
            .prepare(
              'SELECT symbol, quantity, average_cost FROM portfolio_holdings WHERE portfolio_id = ?',
            )
            .all(PF_ID) as Array<{ symbol: string; quantity: number; average_cost: number }>;
          return [
            {
              id: PF_ID,
              name: 'Test',
              currency: 'USD',
              updatedAt: 1_700_000_000_000,
              holdings: rows.map((r) => ({
                symbol: r.symbol,
                quantity: r.quantity,
                averageCost: r.average_cost,
              })),
            },
          ];
        }),
      } as unknown as FinanceRpcDeps['portfolioStore'];

      const { spy, broadcaster } = makeBroadcaster();
      const connections = makeConnections();
      registerFinanceMethods({
        db: database.db,
        portfolioStore: dynamicPortfolioStore,
        broadcaster,
        connections,
      });

      // 1) transaction.add
      const addResult = await call('finance.transaction.add', {
        symbol: 'AAPL',
        action: 'buy',
        quantity: 10,
        price: 180,
        currency: 'USD',
        executedAt: 1_710_000_000_000,
      });
      const addR = (
        addResult as { result: { transactionId: string; updatedHoldings: Array<unknown> } }
      ).result;
      expect(addR.transactionId).toBeTruthy();

      // broadcast 가 발생했는지 mock broadcaster 로 검증
      expect(spy).toHaveBeenCalledTimes(1);
      const [, channel, payload] = spy.mock.calls[0] as [
        unknown,
        string,
        { reason: string; transactionId: string },
      ];
      expect(channel).toBe('portfolio.changed');
      expect(payload.reason).toBe('transaction.add');
      expect(payload.transactionId).toBe(addR.transactionId);

      // 2) portfolio.get → holdings + recentTransactions 동시에 갱신 확인
      const getResult = await call('finance.portfolio.get', {});
      const getR = (
        getResult as {
          result: {
            holdings: Array<{ symbol: string; quantity: number; avgPrice: number }>;
            recentTransactions: Array<{ symbol: string; quantity: number; action: string }>;
          };
        }
      ).result;

      expect(getR.holdings).toHaveLength(1);
      expect(getR.holdings[0]).toMatchObject({ symbol: 'AAPL', quantity: 10, avgPrice: 180 });

      expect(getR.recentTransactions).toHaveLength(1);
      expect(getR.recentTransactions[0]).toMatchObject({
        symbol: 'AAPL',
        quantity: 10,
        action: 'buy',
      });
    });
  });
});
