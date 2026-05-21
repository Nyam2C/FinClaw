// packages/skills-finance/src/brokerage/kis/types.ts

/** KIS 환경. prod=실전, vts=모의투자. */
export type KisEnv = 'prod' | 'vts';

/** KIS Open API credentials (read-only). */
export interface KisCredentials {
  readonly env: KisEnv;
  readonly appKey: string;
  readonly appSecret: string;
  readonly accountNo: string; // CANO (8자리)
  readonly accountProductCode: string; // ACNT_PRDT_CD (2자리, 보통 '01')
}

/**
 * KIS 응답을 FinClaw 도메인으로 정규화한 보유 종목.
 * §B-5: market/currentPrice/currency/asOf 는 portfolio_holdings 컬럼에 없음 →
 * 이 타입은 **메모리 내부용**. DB 저장은 (quantity, average_cost, source) 만.
 */
export interface NormalizedHolding {
  readonly symbol: string;
  readonly market: 'KR' | 'US';
  readonly quantity: number;
  readonly averagePrice: number;
  readonly currentPrice: number | null;
  readonly currency: 'KRW' | 'USD';
  readonly asOf: number; // unix ms
}

/** KIS API 에러 분류 (밀스톤 D 회복 정책에서 사용). */
export type KisErrorKind =
  | 'token_expired'
  | 'rate_limit'
  | 'network'
  | 'auth' // 401/403 non-recoverable
  | 'server'; // 5xx

export class KisError extends Error {
  constructor(
    readonly kind: KisErrorKind,
    message: string,
    readonly recoverable: boolean,
    readonly statusCode?: number,
  ) {
    super(message);
    this.name = 'KisError';
  }
}
