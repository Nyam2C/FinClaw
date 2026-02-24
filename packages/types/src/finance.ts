import type { Brand, Timestamp } from './common.js';

// ─── 금융 상품 식별 ───

/** 티커 심볼 (e.g., 'AAPL', 'BTC-USD', '005930.KS') */
export type TickerSymbol = Brand<string, 'TickerSymbol'>;

/** 통화 코드 (ISO 4217) */
export type CurrencyCode = Brand<string, 'CurrencyCode'>;

/** 금융 상품 유형 */
export type InstrumentType =
  | 'stock'
  | 'etf'
  | 'crypto'
  | 'forex'
  | 'index'
  | 'bond'
  | 'commodity';

/** 금융 상품 */
export interface FinancialInstrument {
  symbol: TickerSymbol;
  name: string;
  type: InstrumentType;
  exchange?: string;
  currency: CurrencyCode;
  sector?: string;
  industry?: string;
}

// ─── 시장 데이터 ───

/** 실시간 시세 */
export interface MarketQuote {
  symbol: TickerSymbol;
  price: number;
  change: number;
  changePercent: number;
  volume: number;
  high: number;
  low: number;
  open: number;
  previousClose: number;
  marketCap?: number;
  timestamp: Timestamp;
}

/** OHLCV 캔들 */
export interface OHLCVCandle {
  timestamp: Timestamp;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

/** 시계열 간격 */
export type TimeInterval = '1m' | '5m' | '15m' | '30m' | '1h' | '4h' | '1d' | '1w' | '1M';

/** 시장 데이터 요청 */
export interface MarketDataRequest {
  symbols: TickerSymbol[];
  interval?: TimeInterval;
  from?: Timestamp;
  to?: Timestamp;
  limit?: number;
}

/** 시장 데이터 응답 */
export interface MarketDataResponse {
  symbol: TickerSymbol;
  candles: OHLCVCandle[];
  quote?: MarketQuote;
  fetchedAt: Timestamp;
}

// ─── 기술 분석 ───

/** 기술 지표 유형 */
export type TechnicalIndicator = 'sma' | 'ema' | 'rsi' | 'macd' | 'bollinger' | 'atr' | 'vwap';

/** 기술 분석 결과 */
export interface TechnicalAnalysisResult {
  indicator: TechnicalIndicator;
  symbol: TickerSymbol;
  values: IndicatorValue[];
  signal?: 'buy' | 'sell' | 'neutral';
  summary?: string;
}

export interface IndicatorValue {
  timestamp: Timestamp;
  value: number;
  upperBand?: number;
  lowerBand?: number;
  signal?: number;
  histogram?: number;
}

// ─── 뉴스 ───

/** 뉴스 아이템 */
export interface NewsItem {
  id: string;
  title: string;
  summary?: string;
  content?: string;
  url: string;
  source: string;
  publishedAt: Timestamp;
  symbols?: TickerSymbol[];
  sentiment?: NewsSentiment;
  categories?: string[];
  imageUrl?: string;
}

/** 뉴스 감성 분석 */
export interface NewsSentiment {
  score: number;
  label: 'very_negative' | 'negative' | 'neutral' | 'positive' | 'very_positive';
  confidence: number;
}

// ─── 알림 ───

/** 알림 정의 */
export interface Alert {
  id: string;
  name?: string;
  symbol: TickerSymbol;
  condition: AlertCondition;
  enabled: boolean;
  channelId?: string;
  createdAt: Timestamp;
  lastTriggeredAt?: Timestamp;
  triggerCount: number;
  cooldownMs: number;
}

/** 알림 조건 */
export interface AlertCondition {
  type: AlertConditionType;
  value: number;
  field?: 'price' | 'changePercent' | 'volume' | 'rsi';
}

export type AlertConditionType =
  | 'above'
  | 'below'
  | 'crosses_above'
  | 'crosses_below'
  | 'change_percent';

/** 알림 트리거 이벤트 */
export interface AlertTrigger {
  alertId: string;
  symbol: TickerSymbol;
  condition: AlertCondition;
  currentValue: number;
  previousValue?: number;
  triggeredAt: Timestamp;
  message: string;
}

// ─── 포트폴리오 ───

/** 포트폴리오 */
export interface Portfolio {
  id: string;
  name: string;
  holdings: PortfolioHolding[];
  totalValue?: number;
  totalCost?: number;
  totalPnL?: number;
  totalPnLPercent?: number;
  currency: CurrencyCode;
  updatedAt: Timestamp;
}

/** 포트폴리오 보유 종목 */
export interface PortfolioHolding {
  symbol: TickerSymbol;
  instrument?: FinancialInstrument;
  quantity: number;
  averageCost: number;
  currentPrice?: number;
  marketValue?: number;
  pnl?: number;
  pnlPercent?: number;
  weight?: number;
}

/** 포트폴리오 요약 */
export interface PortfolioSummary {
  portfolio: Portfolio;
  topGainers: PortfolioHolding[];
  topLosers: PortfolioHolding[];
  sectorAllocation: Record<string, number>;
  dailyChange: number;
  dailyChangePercent: number;
}

/** 티커 심볼 생성 (대문자 정규화) */
export function createTickerSymbol(symbol: string): TickerSymbol {
  return symbol.toUpperCase().trim() as TickerSymbol;
}

/** 통화 코드 생성 (ISO 4217 3글자 검증) */
export function createCurrencyCode(code: string): CurrencyCode {
  const normalized = code.toUpperCase().trim();
  if (!/^[A-Z]{3}$/.test(normalized)) {
    throw new Error(`Invalid currency code: ${code}`);
  }
  return normalized as CurrencyCode;
}
