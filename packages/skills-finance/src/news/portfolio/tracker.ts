import type { Portfolio, PortfolioHolding, PortfolioSummary } from '@finclaw/types';
// packages/skills-finance/src/news/portfolio/tracker.ts
import { createTimestamp } from '@finclaw/types';
import type { NewsAggregator } from '../types.js';

/** Phase 16 시세 조회 어댑터 인터페이스 */
export interface QuoteService {
  getQuote(symbol: string): Promise<{ price: number; change: number; changePercent: number }>;
}

export function createPortfolioTracker(deps: {
  quoteService: QuoteService;
  newsAggregator: NewsAggregator;
}) {
  const { quoteService, newsAggregator: _newsAggregator } = deps;

  return {
    /** 포트폴리오 보유 종목에 현재가 반영 */
    async valuate(portfolio: Portfolio): Promise<Portfolio> {
      let totalValue = 0;
      let totalCost = 0;

      const holdings: PortfolioHolding[] = await Promise.all(
        portfolio.holdings.map(async (h) => {
          const quote = await quoteService.getQuote(h.symbol as string);
          const marketValue = h.quantity * quote.price;
          const cost = h.quantity * h.averageCost;
          const pnl = marketValue - cost;

          totalValue += marketValue;
          totalCost += cost;

          return {
            ...h,
            currentPrice: quote.price,
            marketValue,
            pnl,
            pnlPercent: cost > 0 ? (pnl / cost) * 100 : 0,
            weight: 0, // 아래에서 재계산
          };
        }),
      );

      // 비중 계산
      for (const h of holdings) {
        h.weight = totalValue > 0 ? (h.marketValue ?? 0) / totalValue : 0;
      }

      return {
        ...portfolio,
        holdings,
        totalValue,
        totalCost,
        totalPnL: totalValue - totalCost,
        totalPnLPercent: totalCost > 0 ? ((totalValue - totalCost) / totalCost) * 100 : 0,
        updatedAt: createTimestamp(Date.now()),
      };
    },

    /** 포트폴리오 종합 요약 */
    async summarize(portfolio: Portfolio): Promise<PortfolioSummary> {
      const valuated = await this.valuate(portfolio);

      const sorted = valuated.holdings.toSorted(
        (a, b) => (b.pnlPercent ?? 0) - (a.pnlPercent ?? 0),
      );
      const topGainers = sorted.slice(0, 3);
      const topLosers = sorted.slice(-3).toReversed();

      // dailyChange 집계
      let dailyChange = 0;
      for (const h of valuated.holdings) {
        const quote = await quoteService.getQuote(h.symbol as string);
        dailyChange += h.quantity * quote.change;
      }
      const dailyChangePercent =
        (valuated.totalValue ?? 0) > 0 ? (dailyChange / (valuated.totalValue ?? 0)) * 100 : 0;

      return {
        portfolio: valuated,
        topGainers,
        topLosers,
        sectorAllocation: {}, // 향후 FinancialInstrument.sector 기반 구현
        dailyChange,
        dailyChangePercent,
      };
    },
  };
}
