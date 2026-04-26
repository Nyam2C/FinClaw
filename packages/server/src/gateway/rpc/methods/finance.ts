import type {
  AlertCondition,
  AlertStore,
  CreateAlertInput,
  NewsAggregator,
  PortfolioStore,
  QuoteService,
} from '@finclaw/skills-finance';
import { createTickerSymbol } from '@finclaw/types';
// packages/server/src/gateway/rpc/methods/finance.ts
import { z } from 'zod/v4';
import { registerMethod } from '../index.js';
import type { RpcMethodHandler } from '../types.js';

/** finance.* RPC 메서드 의존성 (main.ts 에서 주입) */
export interface FinanceRpcDeps {
  readonly quoteService?: QuoteService;
  readonly newsAggregator?: NewsAggregator;
  readonly alertStore?: AlertStore;
  readonly portfolioStore?: PortfolioStore;
  /** 알림 생성 직후 1회 평가 훅 (Todo 3 에서 monitor 에 추가된 evaluateOnce 배선) */
  readonly evaluateAlertOnce?: (alertId: string) => Promise<boolean>;
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
    description: '포트폴리오 스냅샷을 조회합니다 (거래 이력은 Phase 25 예정)',
    authLevel: 'token',
    schema: z.object({}),
    async execute() {
      if (!deps.portfolioStore) {
        return { holdings: [], summary: { currency: 'USD', totalHoldings: 0 } };
      }
      const portfolios = deps.portfolioStore.listPortfolios();
      const portfolio = portfolios[0];
      if (!portfolio) {
        return { holdings: [], summary: { currency: 'USD', totalHoldings: 0 } };
      }
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
      };
    },
  };

  registerMethod(quoteHandler);
  registerMethod(newsHandler);
  registerMethod(alertCreateHandler);
  registerMethod(alertListHandler);
  registerMethod(portfolioGetHandler);
}
