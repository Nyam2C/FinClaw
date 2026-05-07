// packages/skills-finance/src/news/types.ts
import type { NewsItem, NewsSentiment, TickerSymbol } from '@finclaw/types';

// re-export for convenience
export type { NewsItem, NewsSentiment, TickerSymbol };

/** 뉴스 소스 프로바이더 식별자 */
export type NewsSourceId = 'newsapi' | 'alpha-vantage' | 'rss' | 'newsdata' | 'finnhub-news';

export type NewsCategory =
  | 'earnings'
  | 'merger'
  | 'ipo'
  | 'regulation'
  | 'macro'
  | 'crypto'
  | 'commodity'
  | 'general';

/** 뉴스 검색 쿼리 */
export interface NewsQuery {
  readonly symbols?: readonly TickerSymbol[];
  readonly keywords?: readonly string[];
  readonly category?: NewsCategory;
  readonly sources?: readonly NewsSourceId[];
  readonly limit?: number; // 기본 20
  readonly fromDate?: Date;
}

/** 뉴스 프로바이더 인터페이스 */
export interface NewsProvider {
  readonly name: NewsSourceId;
  readonly isAvailable: () => boolean;
  fetchNews(query: NewsQuery): Promise<NewsItem[]>;
}

/** 뉴스 어그리게이터 인터페이스 (Phase 18이 import) */
export interface NewsAggregator {
  fetchNews(query: NewsQuery): Promise<NewsItem[]>;
}

// ─── AI 분석 도메인 타입 ───

export type RiskCategory = 'regulatory' | 'market' | 'company' | 'macro';
export type Probability = 'low' | 'medium' | 'high';
export type Impact = 'high' | 'medium' | 'low';
export type TimeHorizon = 'short_term' | 'medium_term' | 'long_term';

export interface AnalysisFactor {
  readonly factor: string;
  readonly impact: Impact;
  readonly evidence: readonly number[];
}

export interface AnalysisRisk {
  readonly risk: string;
  readonly category: RiskCategory;
  readonly probability: Probability;
  readonly evidence: readonly number[];
}

export interface AnalysisOpportunity {
  readonly opportunity: string;
  readonly impact: Impact;
  readonly evidence: readonly number[];
}

export interface AnalysisSentiment {
  readonly score: number;
  readonly label: NewsSentiment['label'];
  readonly confidence: number;
  readonly rationale: string;
  readonly evidence: readonly number[];
}

/** 시장 분석 결과 */
export interface MarketAnalysis {
  readonly summary: string;
  readonly summaryEvidence: readonly number[];
  readonly sentiment: AnalysisSentiment;
  readonly keyFactors: readonly AnalysisFactor[];
  readonly risks: readonly AnalysisRisk[];
  readonly opportunities: readonly AnalysisOpportunity[];
  readonly timeHorizon: TimeHorizon;
  readonly dataGaps: readonly string[];
  readonly analyzedAt: Date;
  readonly newsCount: number;
  readonly symbols: readonly TickerSymbol[];
}

/** 시장 분석 요청 옵션 */
export interface AnalysisOptions {
  readonly symbols?: readonly TickerSymbol[];
  readonly includeIndicators?: boolean;
  readonly depth?: 'brief' | 'standard' | 'detailed';
  readonly language?: 'ko' | 'en';
}
