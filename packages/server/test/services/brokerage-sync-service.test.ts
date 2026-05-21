// packages/server/test/services/brokerage-sync-service.test.ts
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

describe('BrokerageSyncService', () => {
  it('KIS 응답 → portfolio_holdings(source=kis) 적재', async () => {
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
    const svc = new BrokerageSyncService({
      db,
      client,
      logger: noopLogger,
      resolvePortfolioId: () => 'p1',
    });

    const r = await svc.run();
    expect(r.holdingsCount).toBe(2);
    const rows = db
      .prepare(`SELECT symbol, source FROM portfolio_holdings ORDER BY symbol`)
      .all() as Array<{
      symbol: string;
      source: string;
    }>;
    expect(rows.every((x) => x.source === 'kis')).toBe(true);
    close();
  });
});
