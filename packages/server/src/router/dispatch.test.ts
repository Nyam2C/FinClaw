import { InMemoryToolRegistry } from '@finclaw/agent';
import type {
  ChartService,
  NewsAggregator,
  PortfolioStore,
  QuoteService,
} from '@finclaw/skills-finance';
import type { Portfolio } from '@finclaw/types';
import { describe, it, expect } from 'vitest';
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

const deps: DispatcherDeps = { newsAggregator, quoteService, chartService, portfolioStore };

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

describe('M3 main tool surface — direct domain tools hidden', () => {
  it('unregister removes direct domain tools, route_task remains', () => {
    const registry = new InMemoryToolRegistry();
    // 직접 도구 등록 흉내 (이름만 검증 — executor 는 no-op)
    const noop = async () => ({ content: '', isError: false });
    for (const name of ['get_stock_price', 'route_task']) {
      registry.register(
        {
          name,
          description: name,
          inputSchema: { type: 'object', properties: {}, required: [] },
          group: 'finance',
          requiresApproval: false,
          isTransactional: false,
          accessesSensitiveData: false,
          isExternal: true,
          timeoutMs: 1000,
        },
        noop,
        'skill',
      );
    }
    registry.unregister('get_stock_price');
    const names = registry.list().map((t) => t.definition.name);
    expect(names).not.toContain('get_stock_price');
    expect(names).toContain('route_task');
  });
});
