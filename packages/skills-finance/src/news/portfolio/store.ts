// packages/skills-finance/src/news/portfolio/store.ts
import type { DatabaseSync } from 'node:sqlite';
import type { Portfolio, PortfolioHolding, TickerSymbol, CurrencyCode } from '@finclaw/types';
import { createTimestamp } from '@finclaw/types';

/** 포트폴리오 CRUD (SQLite) */
export class PortfolioStore {
  constructor(private readonly db: DatabaseSync) {}

  /** 포트폴리오 조회 */
  getPortfolio(id: string): Portfolio | null {
    const row = this.db
      .prepare('SELECT id, name, currency, updated_at FROM portfolios WHERE id = ?')
      .get(id) as { id: string; name: string; currency: string; updated_at: number } | undefined;

    if (!row) {
      return null;
    }

    const holdings = this.getHoldings(id);

    return {
      id: row.id,
      name: row.name,
      holdings,
      currency: row.currency as CurrencyCode,
      updatedAt: createTimestamp(row.updated_at),
    };
  }

  /** 모든 포트폴리오 목록 */
  listPortfolios(): Portfolio[] {
    const rows = this.db
      .prepare('SELECT id, name, currency, updated_at FROM portfolios ORDER BY updated_at DESC')
      .all() as Array<{ id: string; name: string; currency: string; updated_at: number }>;

    return rows.map((row) => ({
      id: row.id,
      name: row.name,
      holdings: this.getHoldings(row.id),
      currency: row.currency as CurrencyCode,
      updatedAt: createTimestamp(row.updated_at),
    }));
  }

  // ─── 내부 헬퍼 ───

  private getHoldings(portfolioId: string): PortfolioHolding[] {
    const rows = this.db
      .prepare(
        'SELECT symbol, quantity, average_cost FROM portfolio_holdings WHERE portfolio_id = ?',
      )
      .all(portfolioId) as Array<{ symbol: string; quantity: number; average_cost: number }>;

    return rows.map((r) => ({
      symbol: r.symbol as TickerSymbol,
      quantity: r.quantity,
      averageCost: r.average_cost,
    }));
  }
}
