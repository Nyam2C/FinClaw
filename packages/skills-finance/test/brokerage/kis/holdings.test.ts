// packages/skills-finance/test/brokerage/kis/holdings.test.ts
import { describe, expect, it, vi } from 'vitest';
import {
  KisClient,
  KisTokenManager,
  fetchNormalizedHoldings,
  normalizeDomestic,
  normalizeOverseas,
} from '../../../src/brokerage/kis/index.js';
import type { KisCredentials } from '../../../src/brokerage/kis/index.js';

const CREDS: KisCredentials = {
  env: 'vts',
  appKey: 'test-key',
  appSecret: 'test-secret',
  accountNo: '50000000',
  accountProductCode: '01',
};

// 실제 KIS 응답 구조 모방 (값은 placeholder).
const DOMESTIC_FIXTURE = {
  output1: [
    { pdno: '005930', hldg_qty: '10', pchs_avg_pric: '70000', prpr: '72000' },
    { pdno: '000660', hldg_qty: '0', pchs_avg_pric: '0', prpr: '0' }, // qty=0 → 제외
  ],
};
const OVERSEAS_FIXTURE = {
  output1: [{ ovrs_pdno: 'NVDA', ovrs_cblc_qty: '5', pchs_avg_pric: '800', now_pric2: '900' }],
};

function jsonRes(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status });
}

describe('KIS normalizers', () => {
  it('정규화: 한국 잔고 + qty=0 제외', () => {
    const out = normalizeDomestic(DOMESTIC_FIXTURE, 1_700_000_000_000);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ symbol: '005930', market: 'KR', quantity: 10, currency: 'KRW' });
  });
  it('정규화: 해외 잔고', () => {
    const out = normalizeOverseas(OVERSEAS_FIXTURE, 1_700_000_000_000);
    expect(out[0]).toMatchObject({ symbol: 'NVDA', market: 'US', quantity: 5, currency: 'USD' });
  });
});

describe('KIS client (mock fetch)', () => {
  it('토큰 만료 → 자동 갱신 (issue 1회)', async () => {
    let issueCalls = 0;
    const fetchFn = vi.fn(async (url: string | URL) => {
      const u = String(url);
      if (u.endsWith('/oauth2/tokenP')) {
        issueCalls++;
        return jsonRes({ access_token: 'tok', expires_in: 86400 });
      }
      return jsonRes(u.includes('domestic') ? DOMESTIC_FIXTURE : OVERSEAS_FIXTURE);
    }) as unknown as typeof fetch;

    const tokens = new KisTokenManager(CREDS, fetchFn);
    const client = new KisClient(CREDS, tokens, fetchFn);
    const holdings = await fetchNormalizedHoldings(client);
    expect(holdings).toHaveLength(2);
    expect(issueCalls).toBe(1); // 동일 호출 안에서 토큰 재발급 1회만
  });

  it('401 → KisError(auth, non-recoverable)', async () => {
    const fetchFn = vi.fn(async (url: string | URL) => {
      const u = String(url);
      if (u.endsWith('/oauth2/tokenP')) {
        return jsonRes({ access_token: 'tok', expires_in: 86400 });
      }
      return jsonRes({ msg: 'forbidden' }, 401);
    }) as unknown as typeof fetch;
    const tokens = new KisTokenManager(CREDS, fetchFn);
    const client = new KisClient(CREDS, tokens, fetchFn);
    await expect(client.fetchBalances()).rejects.toMatchObject({
      kind: 'auth',
      recoverable: false,
    });
  });
});
