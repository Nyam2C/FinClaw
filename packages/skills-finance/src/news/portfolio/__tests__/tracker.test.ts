import type { Portfolio, TickerSymbol, CurrencyCode } from '@finclaw/types';
import { createTimestamp } from '@finclaw/types';
// packages/skills-finance/src/news/portfolio/__tests__/tracker.test.ts
import { describe, it, expect } from 'vitest';
import type { NewsAggregator } from '../../types.js';
import { createPortfolioTracker, type QuoteService } from '../tracker.js';

function makePortfolio(
  holdings: Array<{ symbol: string; quantity: number; averageCost: number }>,
): Portfolio {
  return {
    id: 'test-portfolio',
    name: 'Test',
    holdings: holdings.map((h) => ({
      symbol: h.symbol as TickerSymbol,
      quantity: h.quantity,
      averageCost: h.averageCost,
    })),
    currency: 'USD' as CurrencyCode,
    updatedAt: createTimestamp(Date.now()),
  };
}

function makeQuoteService(
  prices: Record<string, { price: number; change: number; changePercent: number }>,
): QuoteService {
  return {
    async getQuote(symbol: string) {
      return prices[symbol] ?? { price: 0, change: 0, changePercent: 0 };
    },
  };
}

const mockAggregator: NewsAggregator = {
  async fetchNews() {
    return [];
  },
};

describe('PortfolioTracker', () => {
  describe('valuate', () => {
    it('현재가 기반 P&L을 정확히 계산한다', async () => {
      const tracker = createPortfolioTracker({
        quoteService: makeQuoteService({
          AAPL: { price: 200, change: 5, changePercent: 2.5 },
        }),
        newsAggregator: mockAggregator,
      });

      const portfolio = makePortfolio([{ symbol: 'AAPL', quantity: 10, averageCost: 150 }]);

      const result = await tracker.valuate(portfolio);

      expect(result.totalValue).toBe(2000); // 10 * 200
      expect(result.totalCost).toBe(1500); // 10 * 150
      expect(result.totalPnL).toBe(500);
      expect(result.totalPnLPercent).toBeCloseTo(33.33, 1);
      expect(result.holdings[0]?.currentPrice).toBe(200);
      expect(result.holdings[0]?.marketValue).toBe(2000);
      expect(result.holdings[0]?.pnl).toBe(500);
    });

    it('다수 종목의 비중을 정확히 계산한다', async () => {
      const tracker = createPortfolioTracker({
        quoteService: makeQuoteService({
          AAPL: { price: 200, change: 0, changePercent: 0 },
          GOOGL: { price: 100, change: 0, changePercent: 0 },
        }),
        newsAggregator: mockAggregator,
      });

      const portfolio = makePortfolio([
        { symbol: 'AAPL', quantity: 10, averageCost: 150 }, // 2000
        { symbol: 'GOOGL', quantity: 30, averageCost: 80 }, // 3000
      ]);

      const result = await tracker.valuate(portfolio);

      expect(result.totalValue).toBe(5000);
      expect(result.holdings[0]?.weight).toBeCloseTo(0.4, 2); // 2000/5000
      expect(result.holdings[1]?.weight).toBeCloseTo(0.6, 2); // 3000/5000
    });

    it('빈 포트폴리오를 처리한다', async () => {
      const tracker = createPortfolioTracker({
        quoteService: makeQuoteService({}),
        newsAggregator: mockAggregator,
      });

      const portfolio = makePortfolio([]);
      const result = await tracker.valuate(portfolio);

      expect(result.totalValue).toBe(0);
      expect(result.totalPnL).toBe(0);
    });
  });

  describe('summarize', () => {
    it('topGainers와 topLosers를 정확히 분리한다', async () => {
      const tracker = createPortfolioTracker({
        quoteService: makeQuoteService({
          A: { price: 200, change: 10, changePercent: 5 }, // +100% PnL
          B: { price: 80, change: -5, changePercent: -6 }, // -20% PnL
          C: { price: 150, change: 3, changePercent: 2 }, // +50% PnL
          D: { price: 50, change: -2, changePercent: -4 }, // -50% PnL
          E: { price: 110, change: 1, changePercent: 1 }, // +10% PnL
        }),
        newsAggregator: mockAggregator,
      });

      const portfolio = makePortfolio([
        { symbol: 'A', quantity: 10, averageCost: 100 },
        { symbol: 'B', quantity: 10, averageCost: 100 },
        { symbol: 'C', quantity: 10, averageCost: 100 },
        { symbol: 'D', quantity: 10, averageCost: 100 },
        { symbol: 'E', quantity: 10, averageCost: 100 },
      ]);

      const summary = await tracker.summarize(portfolio);

      // topGainers: A(+100%), C(+50%), E(+10%)
      expect(summary.topGainers).toHaveLength(3);
      expect(summary.topGainers[0]?.symbol).toBe('A');

      // topLosers: D(-50%), B(-20%) — reversed, so D first
      expect(summary.topLosers).toHaveLength(3);
      expect(summary.topLosers[0]?.symbol).toBe('D');
    });

    it('dailyChange를 정확히 집계한다', async () => {
      const tracker = createPortfolioTracker({
        quoteService: makeQuoteService({
          AAPL: { price: 200, change: 5, changePercent: 2.5 },
          GOOGL: { price: 100, change: -3, changePercent: -3 },
        }),
        newsAggregator: mockAggregator,
      });

      const portfolio = makePortfolio([
        { symbol: 'AAPL', quantity: 10, averageCost: 150 },
        { symbol: 'GOOGL', quantity: 20, averageCost: 80 },
      ]);

      const summary = await tracker.summarize(portfolio);

      // dailyChange = 10*5 + 20*(-3) = 50 - 60 = -10
      expect(summary.dailyChange).toBe(-10);
    });
  });
});
