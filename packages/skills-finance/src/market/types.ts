// packages/skills-finance/src/market/types.ts — 프로바이더 전용 확장 타입
// @finclaw/types의 기존 타입을 재사용하고, 이 phase에서만 필요한 확장 타입을 정의한다.

import type { MarketQuote, OHLCVCandle, TickerSymbol, CurrencyCode } from '@finclaw/types';

// 기존 타입 re-export (편의용)
export type { MarketQuote, OHLCVCandle, TickerSymbol, CurrencyCode };

/** 프로바이더 확장 시세 데이터 — MarketQuote에 프로바이더 메타데이터 추가 */
export interface ProviderMarketQuote extends MarketQuote {
  readonly provider: string; // "alpha-vantage" | "coingecko" | "frankfurter"
  readonly delayed: boolean; // 지연 데이터 여부
  readonly currency: CurrencyCode; // 가격 통화
}

/** 시장 데이터 프로바이더 인터페이스 */
export interface MarketDataProvider {
  readonly id: string; // "alpha-vantage" | "coingecko" | "frankfurter"
  readonly name: string; // 표시명
  readonly rateLimit: RateLimitConfig; // API 제한 설정

  /** 실시간/지연 시세 조회 */
  getQuote(symbol: TickerSymbol): Promise<ProviderQuoteResponse>;

  /** 과거 데이터 조회 */
  getHistorical(
    symbol: TickerSymbol,
    period: HistoricalPeriod,
  ): Promise<ProviderHistoricalResponse>;

  /** 지원 여부 확인 */
  supports(symbol: TickerSymbol): boolean;
}

/** Rate Limit 설정 */
export interface RateLimitConfig {
  readonly maxRequests: number; // 윈도우 내 최대 요청 수
  readonly windowMs: number; // 윈도우 크기 (밀리초)
  readonly dailyLimit?: number; // 일별 최대 요청 수 (Alpha Vantage: 25)
}

/** 과거 데이터 조회 기간 */
export type HistoricalPeriod = '1d' | '5d' | '1m' | '3m' | '6m' | '1y' | '5y';

/** 과거 데이터 응답 (정규화됨) — OHLCVCandle 재사용 */
export interface MarketHistorical {
  readonly symbol: TickerSymbol;
  readonly period: HistoricalPeriod;
  readonly currency: CurrencyCode;
  readonly candles: OHLCVCandle[];
  readonly provider: string;
}

/** 프로바이더 원시 응답 (정규화 전) */
export interface ProviderQuoteResponse {
  readonly raw: unknown; // 프로바이더별 원시 데이터
  readonly symbol: TickerSymbol;
  readonly provider: string;
}

export interface ProviderHistoricalResponse {
  readonly raw: unknown;
  readonly symbol: TickerSymbol;
  readonly period: HistoricalPeriod;
  readonly provider: string;
}

// 스파크라인 차트 옵션
export interface ChartOptions {
  readonly width?: number; // 차트 너비 (문자 수, 기본 40)
  readonly height?: number; // 차트 높이 (라인 수, 기본 5)
  readonly showAxis?: boolean; // 축 표시 (기본 true)
  readonly showPrice?: boolean; // 현재가 표시 (기본 true)
  readonly currency?: CurrencyCode; // 통화 단위 (기본 "USD")
}
