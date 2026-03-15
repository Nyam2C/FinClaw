import type { Portfolio, PortfolioHolding, TickerSymbol, CurrencyCode } from '@finclaw/types';
// packages/skills-finance/src/news/portfolio/store.ts
import type { DatabaseSync } from 'node:sqlite';
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

  /** 포트폴리오 생성/갱신 */
  upsertPortfolio(portfolio: Pick<Portfolio, 'id' | 'name' | 'currency'>): void {
    this.db
      .prepare(
        `INSERT INTO portfolios (id, name, currency, updated_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           name = excluded.name,
           currency = excluded.currency,
           updated_at = excluded.updated_at`,
      )
      .run(portfolio.id, portfolio.name, portfolio.currency as string, Date.now());
  }

  /** 포트폴리오 삭제 (CASCADE로 holdings도 삭제) */
  deletePortfolio(id: string): boolean {
    const result = this.db.prepare('DELETE FROM portfolios WHERE id = ?').run(id);
    return Number(result.changes) > 0;
  }

  /** 보유 종목 추가/갱신 */
  upsertHolding(
    portfolioId: string,
    holding: Pick<PortfolioHolding, 'symbol' | 'quantity' | 'averageCost'>,
  ): void {
    this.db
      .prepare(
        `INSERT INTO portfolio_holdings (portfolio_id, symbol, quantity, average_cost)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(portfolio_id, symbol) DO UPDATE SET
           quantity = excluded.quantity,
           average_cost = excluded.average_cost`,
      )
      .run(portfolioId, holding.symbol as string, holding.quantity, holding.averageCost);

    // updated_at 갱신
    this.db
      .prepare('UPDATE portfolios SET updated_at = ? WHERE id = ?')
      .run(Date.now(), portfolioId);
  }

  /** 보유 종목 제거 */
  removeHolding(portfolioId: string, symbol: TickerSymbol): boolean {
    const result = this.db
      .prepare('DELETE FROM portfolio_holdings WHERE portfolio_id = ? AND symbol = ?')
      .run(portfolioId, symbol as string);
    return Number(result.changes) > 0;
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
