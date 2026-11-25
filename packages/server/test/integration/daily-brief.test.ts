// packages/server/test/integration/daily-brief.test.ts
// Phase 33 E1: 매일 시나리오 경량 통합 (외부 API mock, 키 없이 통과).
// 흐름: KIS mock 잔고 → sync(source='kis') → portfolio_holdings.
import { KisClient, KisTokenManager } from '@finclaw/skills-finance';
import type { KisCredentials } from '@finclaw/skills-finance';
import { openDatabase } from '@finclaw/storage';
import { describe, expect, it, vi } from 'vitest';
import { BrokerageSyncService } from '../../src/services/brokerage-sync-service.js';

const CREDS: KisCredentials = {
  env: 'vts',
  appKey: 'k',
  appSecret: 's',
  accountNo: '50000000',
  accountProductCode: '01',
};
const noopLogger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as never;

function res(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status });
}

describe('daily brief integration (mock)', () => {
  it('KIS sync → holdings(source=kis)', async () => {
    const fetchFn = vi.fn(async (url: string | URL) => {
      const u = String(url);
      if (u.endsWith('/oauth2/tokenP')) {
        return res({ access_token: 't', expires_in: 86400 });
      }
      if (u.includes('domestic')) {
        return res({
          output1: [{ pdno: '005930', hldg_qty: '10', pchs_avg_pric: '70000', prpr: '72000' }],
        });
      }
      return res({
        output1: [
          { ovrs_pdno: 'NVDA', ovrs_cblc_qty: '5', pchs_avg_pric: '800', now_pric2: '900' },
        ],
      });
    }) as unknown as typeof fetch;

    const { db, close } = openDatabase({ path: ':memory:', enableWAL: false });
    db.prepare(
      `INSERT INTO portfolios (id,name,currency,updated_at) VALUES ('p1','main','USD',?)`,
    ).run(Date.now());

    const client = new KisClient(CREDS, new KisTokenManager(CREDS, fetchFn), fetchFn);
    const sync = new BrokerageSyncService({
      db,
      client,
      logger: noopLogger,
      resolvePortfolioId: () => 'p1',
    });
    const syncResult = await sync.run();
    expect(syncResult.holdingsCount).toBe(2);
    const kisRows = db
      .prepare(`SELECT COUNT(*) c FROM portfolio_holdings WHERE source='kis'`)
      .get() as { c: number };
    expect(kisRows.c).toBe(2);

    close();
  });
});
