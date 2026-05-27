// packages/server/src/services/brokerage-sync-service.ts
import type { DatabaseSync } from 'node:sqlite';
import type { FinClawLogger } from '@finclaw/infra';
import type { BrokerageClient } from '@finclaw/skills-finance';
import { replaceAllHoldings } from '@finclaw/storage';
import type { BrokerageSyncPort } from '@finclaw/types';

export interface BrokerageSyncResult {
  readonly syncedAt: number;
  readonly holdingsCount: number;
  readonly marketsScanned: ReadonlyArray<'KR' | 'US'>;
  readonly errors: ReadonlyArray<{ market: string; message: string }>;
}

export interface BrokerageSyncDeps {
  readonly db: DatabaseSync;
  readonly client: BrokerageClient;
  readonly logger: FinClawLogger;
  /** 1인 사용자 기본 portfolio id 조회/보장. */
  readonly resolvePortfolioId: () => string;
}

export class BrokerageSyncService implements BrokerageSyncPort {
  constructor(private readonly deps: BrokerageSyncDeps) {}

  /** read-only KIS 호출 + holdings(source='kis') 전면 교체. */
  async run(): Promise<BrokerageSyncResult> {
    const syncedAt = Date.now();
    const holdings = await this.deps.client.fetchHoldings();
    const portfolioId = this.deps.resolvePortfolioId();
    replaceAllHoldings(
      this.deps.db,
      portfolioId,
      holdings.map((h) => ({
        symbol: h.symbol,
        quantity: h.quantity,
        averageCost: h.averagePrice,
      })),
    );
    const markets = [...new Set(holdings.map((h) => h.market))];
    this.deps.logger.info('brokerage.sync.completed', {
      event: 'brokerage.sync.completed',
      holdingsCount: holdings.length,
      markets,
    });
    return { syncedAt, holdingsCount: holdings.length, marketsScanned: markets, errors: [] };
  }
}
