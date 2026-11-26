import type { AgentDriver, DriverRequest } from '@finclaw/agent';
import type {
  ChartService,
  NewsAggregator,
  PortfolioStore,
  QuoteService,
} from '@finclaw/skills-finance';
import type { NewsItem, Portfolio } from '@finclaw/types';
import { describe, it, expect, vi } from 'vitest';
import { buildRouteDispatcher, type DispatcherDeps } from './dispatch.js';

const quoteService: QuoteService = {
  async getQuote(symbol) {
    if (symbol === 'FAIL') {
      throw new Error('quote failed');
    }
    return { price: 100, change: 1, changePercent: 1 };
  },
};

const chartService: ChartService = {
  async getChart(symbol) {
    if (symbol === 'FAIL') {
      throw new Error('chart failed');
    }
    return `sparkline for ${symbol}`;
  },
};

const newsAggregator: NewsAggregator = {
  async fetchNews() {
    return [];
  },
};

const samplePortfolio = {
  id: 'default',
  name: 'Default',
  currency: 'USD',
  holdings: [],
} as unknown as Portfolio;

const portfolioStore = {
  listPortfolios: () => [samplePortfolio],
  getPortfolio: () => samplePortfolio,
} as unknown as PortfolioStore;

const idleDriver: AgentDriver = async function* (req) {
  yield { type: 'error', runId: req.runId, reason: 'unknown', message: 'not used' };
};

const deps: DispatcherDeps = {
  newsAggregator,
  quoteService,
  chartService,
  portfolioStore,
  driver: idleDriver,
};

describe('route_task dispatcher — function intents', () => {
  it('price_lookup returns source=function with quote', async () => {
    const d = buildRouteDispatcher(deps);
    const r = await d({ intent: 'price_lookup', query: 'AAPL price', symbol: 'AAPL' });
    expect(r.source).toBe('function');
    expect(r.isError).toBe(false);
    expect(r.content).toContain('100');
  });

  it('price_lookup without symbol is an error', async () => {
    const d = buildRouteDispatcher(deps);
    const r = await d({ intent: 'price_lookup', query: 'price' });
    expect(r.isError).toBe(true);
    expect(r.source).toBe('function');
  });

  it('price_lookup propagates service error (isError=true, no fake data)', async () => {
    const d = buildRouteDispatcher(deps);
    const r = await d({ intent: 'price_lookup', query: 'x', symbol: 'FAIL' });
    expect(r.isError).toBe(true);
    expect(r.content).toContain('quote failed');
  });

  it('chart_data returns sparkline', async () => {
    const d = buildRouteDispatcher(deps);
    const r = await d({ intent: 'chart_data', query: 'chart', symbol: 'AAPL' });
    expect(r.source).toBe('function');
    expect(r.isError).toBe(false);
    expect(r.content).toContain('sparkline');
  });

  it('chart_data without symbol is an error', async () => {
    const d = buildRouteDispatcher(deps);
    const r = await d({ intent: 'chart_data', query: 'chart' });
    expect(r.isError).toBe(true);
  });

  it('news_summary returns function source', async () => {
    const d = buildRouteDispatcher(deps);
    const r = await d({ intent: 'news_summary', query: 'tech news', symbol: 'AAPL' });
    expect(r.source).toBe('function');
    expect(r.isError).toBe(false);
  });

  it('portfolio_calc summarizes default portfolio', async () => {
    const d = buildRouteDispatcher(deps);
    const r = await d({ intent: 'portfolio_calc', query: 'my pnl' });
    expect(r.source).toBe('function');
    expect(r.isError).toBe(false);
  });

  it('portfolio_calc with no portfolios is an error', async () => {
    const emptyStore = {
      listPortfolios: () => [],
      getPortfolio: () => null,
    } as unknown as PortfolioStore;
    const d = buildRouteDispatcher({ ...deps, portfolioStore: emptyStore });
    const r = await d({ intent: 'portfolio_calc', query: 'pnl' });
    expect(r.isError).toBe(true);
  });
});

describe('route_task dispatcher — no news provider', () => {
  const marketOnly: DispatcherDeps = { quoteService, chartService, driver: idleDriver };

  it('price_lookup still works', async () => {
    const r = await buildRouteDispatcher(marketOnly)({
      intent: 'price_lookup',
      query: 'AAPL price',
      symbol: 'AAPL',
    });
    expect(r.isError).toBe(false);
  });

  it.each(['news_summary', 'market_analysis', 'portfolio_calc'] as const)(
    '%s returns an error result',
    async (intent) => {
      const r = await buildRouteDispatcher(marketOnly)({ intent, query: 'x' });
      expect(r.isError).toBe(true);
      expect(r.content).toContain('news provider not configured');
    },
  );
});

describe('route_task dispatcher — market_analysis 서브에이전트 (D2)', () => {
  it('dispatcher 의 signal 이 서브에이전트 드라이버까지 전달된다', async () => {
    const seen: DriverRequest[] = [];
    const driver: AgentDriver = async function* (req) {
      seen.push(req);
      yield { type: 'error', runId: req.runId, reason: 'aborted', message: 'aborted' };
    };
    const news = [
      { title: 't', source: 's', publishedAt: '2026-11-26', summary: 'x' },
    ] as unknown as NewsItem[];
    const ac = new AbortController();
    ac.abort();
    const r = await buildRouteDispatcher({
      ...deps,
      driver,
      newsAggregator: { fetchNews: async () => news },
    })({ intent: 'market_analysis', query: 'x' }, ac.signal);
    expect(seen[0]?.signal.aborted).toBe(true);
    expect(seen[0]?.tools).toEqual([]);
    expect(r.isError).toBe(true);
  });

  it('동시 2호출은 서브에이전트 spawn 이 순차 실행된다 (전용 lane maxConcurrent 1)', async () => {
    let open: () => void = () => {};
    const opened = new Promise<void>((resolve) => {
      open = resolve;
    });
    const seen: DriverRequest[] = [];
    const driver: AgentDriver = async function* (req) {
      seen.push(req);
      if (seen.length === 1) {
        await opened;
      }
      yield { type: 'error', runId: req.runId, reason: 'unknown', message: 'x' };
    };
    const news = [
      { title: 't', source: 's', publishedAt: '2026-11-26', summary: 'x' },
    ] as unknown as NewsItem[];
    const d = buildRouteDispatcher({
      ...deps,
      driver,
      newsAggregator: { fetchNews: async () => news },
    });
    const both = Promise.all([
      d({ intent: 'market_analysis', query: 'a' }),
      d({ intent: 'market_analysis', query: 'b' }),
    ]);
    await vi.waitFor(() => expect(seen).toHaveLength(1));
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(seen).toHaveLength(1); // 둘째는 첫째가 끝날 때까지 대기
    open();
    await both;
    expect(seen).toHaveLength(2);
  });
});
