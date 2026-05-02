import type { DatabaseSync } from 'node:sqlite';
import type {
  AlertCondition,
  AlertStore,
  CreateAlertInput,
  NewsAggregator,
  PortfolioStore,
  QuoteService,
} from '@finclaw/skills-finance';
import {
  addTransaction,
  deleteTransaction,
  getTransaction,
  listTransactions,
  updateTransaction,
  type Transaction,
} from '@finclaw/storage';
import {
  createCurrencyCode,
  createTickerSymbol,
  type Timestamp,
  type TransactionAction,
} from '@finclaw/types';
// packages/server/src/gateway/rpc/methods/finance.ts
import { z } from 'zod/v4';
import type { GatewayBroadcaster } from '../../broadcaster.js';
import { registerMethod } from '../index.js';
import type { RpcMethodHandler, WsConnection } from '../types.js';

/** finance.* RPC 메서드 의존성 (main.ts 에서 주입) */
export interface FinanceRpcDeps {
  readonly quoteService?: QuoteService;
  readonly newsAggregator?: NewsAggregator;
  readonly alertStore?: AlertStore;
  readonly portfolioStore?: PortfolioStore;
  /** 알림 생성 직후 1회 평가 훅 (Todo 3 에서 monitor 에 추가된 evaluateOnce 배선) */
  readonly evaluateAlertOnce?: (alertId: string) => Promise<boolean>;
  /** Phase 26 A: transactions CRUD 용 SQLite 핸들 (생략 시 transaction.* 메서드는 provider_unavailable) */
  readonly db?: DatabaseSync;
  /** Phase 26 A: portfolio.changed broadcast (생략 시 응답은 성공, broadcast 만 skip) */
  readonly broadcaster?: GatewayBroadcaster;
  /** Phase 26 A: broadcast 대상 WebSocket 연결 맵 (broadcaster 와 함께 주입) */
  readonly connections?: Map<string, WsConnection>;
}

// ─── Phase 26 A: 헬퍼 ───

/** portfolioId 미지정 시 portfolios 테이블의 첫 번째 행 사용. 없으면 NOT_FOUND. */
function resolvePortfolioId(db: DatabaseSync, explicit: string | undefined): string {
  if (explicit !== undefined) {
    const row = db.prepare('SELECT id FROM portfolios WHERE id = ?').get(explicit) as
      | { id: string }
      | undefined;
    if (!row) {
      throw new Error(`not_found: portfolio not found: ${explicit}`);
    }
    return row.id;
  }
  const row = db.prepare('SELECT id FROM portfolios ORDER BY updated_at ASC LIMIT 1').get() as
    | { id: string }
    | undefined;
  if (!row) {
    throw new Error('not_found: no portfolio exists');
  }
  return row.id;
}

/** transactions 변경 후 holdings 스냅샷 (RPC 응답용). storage 가 이미 재계산했으므로 단순 SELECT. */
interface UpdatedHolding {
  symbol: string;
  quantity: number;
  averageCost: number;
}
function readHoldings(db: DatabaseSync, portfolioId: string): UpdatedHolding[] {
  const rows = db
    .prepare(
      'SELECT symbol, quantity, average_cost FROM portfolio_holdings WHERE portfolio_id = ? ORDER BY symbol ASC',
    )
    .all(portfolioId) as Array<{ symbol: string; quantity: number; average_cost: number }>;
  return rows.map((r) => ({ symbol: r.symbol, quantity: r.quantity, averageCost: r.average_cost }));
}

/** broadcaster + connections 둘 다 있을 때만 best-effort broadcast. 실패해도 throw 안 함. */
function tryBroadcastPortfolioChanged(
  deps: FinanceRpcDeps,
  payload: {
    portfolioId: string;
    reason: 'transaction.add' | 'transaction.update' | 'transaction.delete';
    transactionId: string;
  },
): void {
  if (!deps.broadcaster || !deps.connections) {
    return;
  }
  try {
    deps.broadcaster.broadcastToChannel(deps.connections, 'portfolio.changed', {
      portfolioId: payload.portfolioId,
      updatedAt: Date.now(),
      reason: payload.reason,
      transactionId: payload.transactionId,
    });
  } catch {
    // best-effort: broadcaster 실패는 RPC 응답에 영향을 주지 않음.
  }
}

type AlertConditionId = 'price_above' | 'price_below' | 'change_percent' | 'news_match';

interface AlertCreateParams {
  symbol: string;
  condition: AlertConditionId;
  threshold?: number;
  keyword?: string;
  cooldownMs?: number;
  userId?: string;
}

function toAlertCondition(params: AlertCreateParams): AlertCondition {
  const ticker = createTickerSymbol(params.symbol.toUpperCase());
  switch (params.condition) {
    case 'price_above':
    case 'price_below':
      if (params.threshold === undefined) {
        throw new Error(`condition=${params.condition} requires threshold`);
      }
      return {
        type: 'price',
        ticker,
        direction: params.condition === 'price_above' ? 'above' : 'below',
        threshold: params.threshold,
      };
    case 'change_percent':
      if (params.threshold === undefined) {
        throw new Error('condition=change_percent requires threshold');
      }
      return {
        type: 'change',
        ticker,
        thresholdPercent: params.threshold,
        direction: 'both',
      };
    case 'news_match':
      if (!params.keyword) {
        throw new Error('condition=news_match requires keyword');
      }
      return {
        type: 'news',
        keywords: [params.keyword],
        symbols: [ticker],
      };
  }
}

interface ConditionSummary {
  symbol: string;
  condition: string;
  threshold?: number;
  keyword?: string;
}

function summarizeCondition(cond: AlertCondition): ConditionSummary {
  if (cond.type === 'price') {
    return {
      symbol: cond.ticker as string,
      condition: cond.direction === 'above' ? 'price_above' : 'price_below',
      threshold: cond.threshold,
    };
  }
  if (cond.type === 'change') {
    return {
      symbol: cond.ticker as string,
      condition: 'change_percent',
      threshold: cond.thresholdPercent,
    };
  }
  if (cond.type === 'volume') {
    return {
      symbol: cond.ticker as string,
      condition: 'volume',
      threshold: cond.multiplier,
    };
  }
  // news
  return {
    symbol: (cond.symbols?.[0] as string | undefined) ?? '',
    condition: 'news_match',
    keyword: cond.keywords.join(','),
  };
}

/**
 * finance.* RPC 메서드 일괄 등록.
 * deps 가 undefined 인 서비스는 해당 메서드 호출 시 에러를 던진다.
 */
export function registerFinanceMethods(deps: FinanceRpcDeps): void {
  // ── finance.quote ──
  const quoteHandler: RpcMethodHandler<{ symbol: string }, unknown> = {
    method: 'finance.quote',
    description: '종목/암호화폐/외환 시세를 조회합니다',
    authLevel: 'token',
    schema: z.object({ symbol: z.string().min(1).max(20) }),
    async execute(params) {
      if (!deps.quoteService) {
        throw new Error('provider_unavailable: ALPHA_VANTAGE_KEY or COINGECKO_API_KEY required');
      }
      try {
        const quote = await deps.quoteService.getQuote(params.symbol);
        return {
          symbol: params.symbol.toUpperCase(),
          price: quote.price,
          change: quote.change,
          changePercent: quote.changePercent,
          timestamp: Date.now(),
        };
      } catch (err) {
        throw new Error(`invalid_symbol: ${params.symbol} — ${(err as Error).message}`, {
          cause: err,
        });
      }
    },
  };

  // ── finance.news ──
  const newsHandler: RpcMethodHandler<
    { query?: string; symbols?: string[]; limit?: number },
    unknown
  > = {
    method: 'finance.news',
    description: '금융 뉴스를 검색합니다',
    authLevel: 'token',
    schema: z.object({
      query: z.string().optional(),
      symbols: z.array(z.string()).optional(),
      limit: z.number().int().min(1).optional(),
    }),
    async execute(params) {
      if (!deps.newsAggregator) {
        throw new Error('provider_unavailable: news aggregator requires ALPHA_VANTAGE_KEY');
      }
      const limit = Math.min(params.limit ?? 20, 50);
      const articles = await deps.newsAggregator.fetchNews({
        keywords: params.query ? [params.query] : undefined,
        symbols: params.symbols?.map((s) => createTickerSymbol(s.toUpperCase())),
        limit,
      });
      return {
        articles: articles.map((a) => ({
          id: a.id,
          title: a.title,
          url: a.url,
          source: a.source,
          publishedAt: a.publishedAt,
          summary: a.summary,
          symbols: a.symbols ?? [],
          sentiment: a.sentiment,
        })),
        total: articles.length,
      };
    },
  };

  // ── finance.alert.create ──
  const alertCreateHandler: RpcMethodHandler<AlertCreateParams, unknown> = {
    method: 'finance.alert.create',
    description: '가격/뉴스 알림을 생성합니다. 생성 직후 현재 조건을 1회 평가합니다.',
    authLevel: 'token',
    schema: z.object({
      symbol: z.string().min(1),
      condition: z.enum(['price_above', 'price_below', 'change_percent', 'news_match']),
      threshold: z.number().optional(),
      keyword: z.string().optional(),
      cooldownMs: z.number().int().min(60_000).optional(),
      userId: z.string().optional(),
    }),
    async execute(params) {
      if (!deps.alertStore) {
        throw new Error('provider_unavailable: alert store not initialized');
      }
      const condition = toAlertCondition(params);
      const input: CreateAlertInput = {
        userId: params.userId ?? 'default',
        name: `${params.symbol.toUpperCase()} ${params.condition}`,
        condition,
        channels: ['log', 'discord'],
        cooldownMs: params.cooldownMs ?? 900_000,
        enabled: true,
      };
      const alert = deps.alertStore.create(input);

      let immediateTrigger = false;
      if (deps.evaluateAlertOnce) {
        try {
          immediateTrigger = await deps.evaluateAlertOnce(alert.id);
        } catch {
          immediateTrigger = false;
        }
      }

      return {
        alertId: alert.id,
        createdAt: alert.createdAt,
        immediateTrigger,
      };
    },
  };

  // ── finance.alert.list ──
  const alertListHandler: RpcMethodHandler<{ symbol?: string; userId?: string }, unknown> = {
    method: 'finance.alert.list',
    description: '설정된 알림 목록을 조회합니다',
    authLevel: 'token',
    schema: z.object({
      symbol: z.string().optional(),
      userId: z.string().optional(),
    }),
    async execute(params) {
      if (!deps.alertStore) {
        throw new Error('provider_unavailable: alert store not initialized');
      }
      const userId = params.userId ?? 'default';
      let alerts = deps.alertStore.listByUser(userId);
      if (params.symbol) {
        const upper = params.symbol.toUpperCase();
        alerts = alerts.filter((a) => {
          const cond = a.condition;
          if (cond.type === 'price' || cond.type === 'change' || cond.type === 'volume') {
            return (cond.ticker as string).toUpperCase() === upper;
          }
          if (cond.type === 'news') {
            return cond.symbols?.some((s) => (s as string).toUpperCase() === upper) ?? false;
          }
          return false;
        });
      }
      return {
        alerts: alerts.map((a) => ({
          id: a.id,
          ...summarizeCondition(a.condition),
          enabled: a.enabled,
          cooldownMs: a.cooldownMs,
          createdAt: a.createdAt,
          triggerCount: a.triggerCount,
        })),
        total: alerts.length,
      };
    },
  };

  // ── finance.portfolio.get ──
  const portfolioGetHandler: RpcMethodHandler<Record<string, never>, unknown> = {
    method: 'finance.portfolio.get',
    description: '포트폴리오 스냅샷 + 최근 거래 10건을 조회합니다',
    authLevel: 'token',
    schema: z.object({}),
    async execute() {
      if (!deps.portfolioStore) {
        return {
          holdings: [],
          summary: { currency: 'USD', totalHoldings: 0 },
          recentTransactions: [],
        };
      }
      const portfolios = deps.portfolioStore.listPortfolios();
      const portfolio = portfolios[0];
      if (!portfolio) {
        return {
          holdings: [],
          summary: { currency: 'USD', totalHoldings: 0 },
          recentTransactions: [],
        };
      }
      // Phase 26 A: db 가 주입된 경우에만 최근 거래 10건 동봉. 없으면 빈 배열.
      const recentTransactions: Transaction[] = deps.db
        ? listTransactions(deps.db, { portfolioId: portfolio.id, limit: 10 })
        : [];
      return {
        portfolioId: portfolio.id,
        name: portfolio.name,
        holdings: portfolio.holdings.map((h) => ({
          symbol: h.symbol as string,
          quantity: h.quantity,
          avgPrice: h.averageCost,
          currency: portfolio.currency as string,
        })),
        summary: {
          currency: portfolio.currency as string,
          totalHoldings: portfolio.holdings.length,
        },
        recentTransactions,
      };
    },
  };

  // ── finance.transaction.add (Phase 26 A) ──
  const transactionAddHandler: RpcMethodHandler<
    {
      portfolioId?: string;
      symbol: string;
      action: TransactionAction;
      quantity: number;
      price?: number;
      fee?: number;
      currency: string;
      executedAt: number;
      note?: string;
    },
    unknown
  > = {
    method: 'finance.transaction.add',
    description: '거래를 추가하고 holdings 를 재계산합니다',
    authLevel: 'token',
    schema: z.object({
      portfolioId: z.string().optional(),
      symbol: z.string().min(1).max(20),
      action: z.enum(['buy', 'sell', 'dividend', 'fee', 'split']),
      quantity: z.number().positive(),
      price: z.number().nonnegative().optional(),
      fee: z.number().nonnegative().optional(),
      currency: z.string().length(3),
      executedAt: z.number().int().positive(),
      note: z.string().max(500).optional(),
    }),
    async execute(params) {
      if (!deps.db) {
        throw new Error('provider_unavailable: storage db not initialized');
      }
      const portfolioId = resolvePortfolioId(deps.db, params.portfolioId);
      const txn = addTransaction(deps.db, {
        portfolioId,
        symbol: createTickerSymbol(params.symbol.toUpperCase()),
        action: params.action,
        quantity: params.quantity,
        price: params.price,
        fee: params.fee,
        currency: createCurrencyCode(params.currency),
        executedAt: params.executedAt as Timestamp,
        source: 'manual',
        note: params.note,
      });
      const updatedHoldings = readHoldings(deps.db, portfolioId);

      tryBroadcastPortfolioChanged(deps, {
        portfolioId,
        reason: 'transaction.add',
        transactionId: txn.id,
      });

      return {
        transactionId: txn.id,
        createdAt: txn.createdAt,
        updatedHoldings,
      };
    },
  };

  // ── finance.transaction.list (Phase 26 A) ──
  const transactionListHandler: RpcMethodHandler<
    {
      portfolioId?: string;
      symbol?: string;
      from?: number;
      to?: number;
      limit?: number;
    },
    unknown
  > = {
    method: 'finance.transaction.list',
    description: '거래 이력을 조회합니다 (executed_at DESC)',
    authLevel: 'token',
    schema: z.object({
      portfolioId: z.string().optional(),
      symbol: z.string().min(1).max(20).optional(),
      from: z.number().int().positive().optional(),
      to: z.number().int().positive().optional(),
      limit: z.number().int().min(1).max(500).optional(),
    }),
    async execute(params) {
      if (!deps.db) {
        throw new Error('provider_unavailable: storage db not initialized');
      }
      const transactions = listTransactions(deps.db, {
        portfolioId: params.portfolioId,
        symbol: params.symbol ? createTickerSymbol(params.symbol.toUpperCase()) : undefined,
        from: params.from as Timestamp | undefined,
        to: params.to as Timestamp | undefined,
        limit: params.limit,
      });
      return { transactions };
    },
  };

  // ── finance.transaction.update (Phase 26 A) ──
  const transactionUpdateHandler: RpcMethodHandler<
    {
      transactionId: string;
      portfolioId?: string;
      symbol?: string;
      action?: TransactionAction;
      quantity?: number;
      price?: number | null;
      fee?: number;
      currency?: string;
      executedAt?: number;
      note?: string | null;
    },
    unknown
  > = {
    method: 'finance.transaction.update',
    description: '거래를 부분 수정하고 holdings 를 재계산합니다',
    authLevel: 'token',
    schema: z.object({
      transactionId: z.string().min(1),
      portfolioId: z.string().optional(),
      symbol: z.string().min(1).max(20).optional(),
      action: z.enum(['buy', 'sell', 'dividend', 'fee', 'split']).optional(),
      quantity: z.number().positive().optional(),
      price: z.number().nonnegative().nullable().optional(),
      fee: z.number().nonnegative().optional(),
      currency: z.string().length(3).optional(),
      executedAt: z.number().int().positive().optional(),
      note: z.string().max(500).nullable().optional(),
    }),
    async execute(params) {
      if (!deps.db) {
        throw new Error('provider_unavailable: storage db not initialized');
      }
      const updated = updateTransaction(deps.db, params.transactionId, {
        portfolioId: params.portfolioId,
        symbol: params.symbol ? createTickerSymbol(params.symbol.toUpperCase()) : undefined,
        action: params.action,
        quantity: params.quantity,
        price: params.price,
        fee: params.fee,
        currency: params.currency ? createCurrencyCode(params.currency) : undefined,
        executedAt: params.executedAt as Timestamp | undefined,
        note: params.note,
      });
      if (!updated) {
        throw new Error(`not_found: transaction not found: ${params.transactionId}`);
      }
      const updatedHoldings = readHoldings(deps.db, updated.portfolioId);

      tryBroadcastPortfolioChanged(deps, {
        portfolioId: updated.portfolioId,
        reason: 'transaction.update',
        transactionId: updated.id,
      });

      return { updatedHoldings };
    },
  };

  // ── finance.transaction.delete (Phase 26 A) ──
  const transactionDeleteHandler: RpcMethodHandler<{ transactionId: string }, unknown> = {
    method: 'finance.transaction.delete',
    description: '거래를 삭제하고 holdings 를 재계산합니다',
    authLevel: 'token',
    schema: z.object({
      transactionId: z.string().min(1),
    }),
    async execute(params) {
      if (!deps.db) {
        throw new Error('provider_unavailable: storage db not initialized');
      }
      // delete 후에는 portfolioId 를 알 수 없으니 미리 조회.
      const existing = getTransaction(deps.db, params.transactionId);
      if (!existing) {
        throw new Error(`not_found: transaction not found: ${params.transactionId}`);
      }
      const ok = deleteTransaction(deps.db, params.transactionId);
      if (!ok) {
        throw new Error(`not_found: transaction not found: ${params.transactionId}`);
      }
      const updatedHoldings = readHoldings(deps.db, existing.portfolioId);

      tryBroadcastPortfolioChanged(deps, {
        portfolioId: existing.portfolioId,
        reason: 'transaction.delete',
        transactionId: existing.id,
      });

      return { deleted: true, updatedHoldings };
    },
  };

  registerMethod(quoteHandler);
  registerMethod(newsHandler);
  registerMethod(alertCreateHandler);
  registerMethod(alertListHandler);
  registerMethod(portfolioGetHandler);
  registerMethod(transactionAddHandler);
  registerMethod(transactionListHandler);
  registerMethod(transactionUpdateHandler);
  registerMethod(transactionDeleteHandler);
}
