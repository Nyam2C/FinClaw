// packages/skills-finance/src/brokerage/kis/holdings.ts
import type { KisClient, KisRawBalances } from './client.js';
import type { NormalizedHolding } from './types.js';

/** 한국 inquire-balance output1 행 (필요 필드만). */
interface DomesticRow {
  pdno: string; // 종목코드 (6자리)
  hldg_qty: string; // 보유수량
  pchs_avg_pric: string; // 매입평균가격
  prpr: string; // 현재가
}

/** 해외 inquire-balance output1 행. */
interface OverseasRow {
  ovrs_pdno: string; // 해외 종목코드 (티커)
  ovrs_cblc_qty: string; // 해외 잔고 수량
  pchs_avg_pric: string; // 매입평균
  now_pric2: string; // 현재가
}

function num(s: string | undefined): number {
  const n = Number(s ?? '0');
  return Number.isFinite(n) ? n : 0;
}

export function normalizeDomestic(raw: unknown, asOf: number): NormalizedHolding[] {
  const rows = ((raw as { output1?: DomesticRow[] })?.output1 ?? []).filter(
    (r) => num(r.hldg_qty) > 0,
  );
  return rows.map((r) => ({
    symbol: r.pdno,
    market: 'KR' as const,
    quantity: num(r.hldg_qty),
    averagePrice: num(r.pchs_avg_pric),
    currentPrice: r.prpr ? num(r.prpr) : null,
    currency: 'KRW' as const,
    asOf,
  }));
}

export function normalizeOverseas(raw: unknown, asOf: number): NormalizedHolding[] {
  const rows = ((raw as { output1?: OverseasRow[] })?.output1 ?? []).filter(
    (r) => num(r.ovrs_cblc_qty) > 0,
  );
  return rows.map((r) => ({
    symbol: r.ovrs_pdno,
    market: 'US' as const,
    quantity: num(r.ovrs_cblc_qty),
    averagePrice: num(r.pchs_avg_pric),
    currentPrice: r.now_pric2 ? num(r.now_pric2) : null,
    currency: 'USD' as const,
    asOf,
  }));
}

/** client 로 잔고 조회 후 한국+해외 정규화 병합. */
export async function fetchNormalizedHoldings(
  client: KisClient,
  now: () => number = Date.now,
): Promise<NormalizedHolding[]> {
  const asOf = now();
  const balances: KisRawBalances = await client.fetchBalances();
  return [
    ...normalizeDomestic(balances.domestic, asOf),
    ...normalizeOverseas(balances.overseas, asOf),
  ];
}
