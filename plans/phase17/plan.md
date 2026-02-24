# Phase 17: 금융 스킬 -- 뉴스 & AI 분석

## 1. 목표

금융 뉴스 수집과 AI 기반 시장 분석 기능을 구현한다. 구체적으로:

1. **뉴스 어그리게이션**: 다중 소스(NewsAPI.org, Alpha Vantage News Sentiment, RSS 피드)에서 금융 뉴스를 수집하고 정규화된 `NewsItem` 형식으로 통합한다.
2. **AI 시장 분석**: LLM을 활용하여 뉴스 묶음에 대한 시장 전망 요약, 감성 분석(bullish/bearish/neutral 스코어링), 기술적 지표 해석을 수행한다.
3. **포트폴리오 추적**: 사용자가 보유 종목(ticker, 수량, 평균 매입가)을 정의하고, 현재 가치 평가(P&L, 일일 변동), 포트폴리오 특화 뉴스 필터링을 제공한다.
4. **에이전트 도구 등록**: `get_financial_news`, `analyze_market`, `get_portfolio_summary` 세 가지 도구를 에이전트 tool registry에 등록하여 자연어 대화를 통해 호출 가능하게 한다.

Phase 16의 시장 데이터(시세, 차트, 기술 분석)와 결합하여 포괄적인 금융 정보 파이프라인을 완성한다.

---

## 2. OpenClaw 참조

| 참조 문서            | 경로                                                              | 적용할 패턴                                                                                                     |
| -------------------- | ----------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| 스킬 시스템 아키텍처 | `openclaw_review/docs/20.스킬-빌드-배포-인프라.md`                | Progressive Disclosure 3-Level 스킬 구조 (메타데이터 -> 본문 -> 번들 리소스)                                    |
| 스킬 Deep Dive       | `openclaw_review/deep-dive/20-skills-docs-scripts.md`             | `OpenClawSkillMetadata` 인터페이스, `loadSkills()` 5개 디렉토리 순회, `validateRequirements()` 활성화 조건 패턴 |
| 도구 시스템          | `openclaw_review/docs/04.에이전트-도구-시스템과-샌드박스-격리.md` | 도구 정의 스키마(name, description, parameters), 도구 실행 결과 직렬화 패턴                                     |
| Pi 실행 엔진         | `openclaw_review/deep-dive/05-agent-pi-embedding.md`              | LLM 호출 시 tool_use 블록 처리, 스트리밍 응답 조립 패턴                                                         |

**핵심 적용 패턴:**

1. **Provider 추상화**: OpenClaw의 채널 어댑터 패턴을 뉴스 소스에 적용. 각 뉴스 프로바이더가 동일한 `NewsProvider` 인터페이스를 구현하여 교체/추가 가능하도록 설계한다.
2. **Tool Definition Schema**: OpenClaw의 `ToolDefinition` 형식(JSON Schema 기반 parameters)을 따라 에이전트 도구를 정의한다.
3. **Graceful Degradation**: 뉴스 API 장애 시 다른 프로바이더로 폴백하고, API 키 미설정 시 해당 프로바이더만 비활성화하는 패턴.

---

## 3. 생성할 파일

### 소스 파일 (8개)

| #   | 파일 경로                                         | 설명                                                                                 | 예상 LOC |
| --- | ------------------------------------------------- | ------------------------------------------------------------------------------------ | -------- |
| 1   | `src/skills/news/index.ts`                        | 스킬 등록 진입점, 뉴스/분석/포트폴리오 모듈 초기화                                   | ~60      |
| 2   | `src/skills/news/types.ts`                        | 뉴스/분석/포트폴리오 도메인 타입 정의                                                | ~120     |
| 3   | `src/skills/news/providers/newsapi.ts`            | NewsAPI.org 프로바이더 구현                                                          | ~100     |
| 4   | `src/skills/news/providers/alpha-vantage-news.ts` | Alpha Vantage News Sentiment 프로바이더 구현                                         | ~100     |
| 5   | `src/skills/news/providers/rss.ts`                | RSS 피드 프로바이더 구현 (범용 XML 파싱)                                             | ~90      |
| 6   | `src/skills/news/analysis/market-analysis.ts`     | LLM 기반 시장 전망 요약, 멀티 뉴스 분석                                              | ~130     |
| 7   | `src/skills/news/analysis/sentiment.ts`           | 뉴스 감성 분석 (bullish/bearish/neutral 스코어링)                                    | ~100     |
| 8   | `src/skills/news/portfolio/tracker.ts`            | 포트폴리오 정의, 현재가 평가, P&L 계산, 뉴스 필터링                                  | ~150     |
| 9   | `src/skills/news/tools.ts`                        | 에이전트 도구 정의 (`get_financial_news`, `analyze_market`, `get_portfolio_summary`) | ~120     |

### 테스트 파일 (4개)

| #   | 파일 경로                                                        | 테스트 대상                                             | 예상 LOC |
| --- | ---------------------------------------------------------------- | ------------------------------------------------------- | -------- |
| 1   | `src/skills/news/providers/__tests__/newsapi.test.ts`            | NewsAPI 프로바이더 (응답 파싱, 에러 핸들링, rate limit) | ~120     |
| 2   | `src/skills/news/providers/__tests__/alpha-vantage-news.test.ts` | Alpha Vantage News 프로바이더                           | ~100     |
| 3   | `src/skills/news/analysis/__tests__/sentiment.test.ts`           | 감성 분석 스코어링 로직                                 | ~100     |
| 4   | `src/skills/news/portfolio/__tests__/tracker.test.ts`            | 포트폴리오 평가, P&L 계산, 뉴스 필터링                  | ~120     |

**합계: 소스 9개 + 테스트 4개 = 13개 파일, 예상 ~1,310 LOC**

---

## 4. 핵심 인터페이스/타입

```typescript
// src/skills/news/types.ts

// ─── 뉴스 도메인 타입 ───

/** 뉴스 소스 프로바이더 식별자 */
export type NewsSource = 'newsapi' | 'alpha-vantage' | 'rss';

/** 정규화된 뉴스 아이템 (모든 프로바이더가 이 형식으로 출력) */
export interface NewsItem {
  readonly id: string; // 소스 + 해시 기반 고유 ID
  readonly title: string;
  readonly description: string;
  readonly url: string;
  readonly source: NewsSource;
  readonly sourceName: string; // "Reuters", "Bloomberg" 등
  readonly publishedAt: Date;
  readonly tickers: readonly string[]; // 관련 종목 코드 (AAPL, BTC 등)
  readonly imageUrl?: string;
  readonly category?: NewsCategory;
}

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
  readonly tickers?: readonly string[]; // 특정 종목 관련 뉴스
  readonly keywords?: readonly string[]; // 키워드 검색
  readonly category?: NewsCategory;
  readonly sources?: readonly NewsSource[];
  readonly limit?: number; // 기본 20
  readonly fromDate?: Date; // 검색 시작일
}

/** 뉴스 프로바이더 인터페이스 (Provider 추상화) */
export interface NewsProvider {
  readonly name: NewsSource;
  readonly isAvailable: () => boolean; // API 키 설정 여부 확인
  fetchNews(query: NewsQuery): Promise<NewsItem[]>;
}

// ─── AI 분석 도메인 타입 ───

/** 감성 분석 결과 */
export interface SentimentResult {
  readonly score: number; // -1.0 (극도 bearish) ~ +1.0 (극도 bullish)
  readonly label: 'bearish' | 'neutral' | 'bullish';
  readonly confidence: number; // 0.0 ~ 1.0
  readonly reasoning: string; // 판단 근거 요약
}

/** 시장 분석 결과 */
export interface MarketAnalysis {
  readonly summary: string; // 시장 전망 요약 (2-3 문단)
  readonly sentiment: SentimentResult; // 전체 시장 감성
  readonly keyFactors: readonly string[]; // 핵심 영향 요인
  readonly risks: readonly string[]; // 주요 리스크 요인
  readonly opportunities: readonly string[]; // 기회 요인
  readonly analyzedAt: Date;
  readonly newsCount: number; // 분석에 사용된 뉴스 수
  readonly tickers: readonly string[]; // 분석 대상 종목
}

/** 시장 분석 요청 옵션 */
export interface AnalysisOptions {
  readonly tickers?: readonly string[];
  readonly includeIndicators?: boolean; // Phase 16 기술 분석 데이터 포함 여부
  readonly depth?: 'brief' | 'standard' | 'detailed';
  readonly language?: 'ko' | 'en';
}

// ─── 포트폴리오 도메인 타입 ───

/** 포트폴리오 보유 종목 */
export interface Holding {
  readonly ticker: string;
  readonly quantity: number;
  readonly averagePrice: number; // 평균 매입가 (USD)
  readonly addedAt: Date;
}

/** 포트폴리오 정의 */
export interface Portfolio {
  readonly id: string;
  readonly name: string;
  readonly userId: string;
  readonly holdings: readonly Holding[];
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

/** 포트폴리오 평가 결과 */
export interface PortfolioValuation {
  readonly portfolioId: string;
  readonly totalValue: number; // 현재 총 가치
  readonly totalCost: number; // 총 매입가
  readonly totalGainLoss: number; // 총 손익 (절대값)
  readonly totalGainLossPercent: number; // 총 손익 (%)
  readonly dailyChange: number; // 일일 변동 (절대값)
  readonly dailyChangePercent: number; // 일일 변동 (%)
  readonly holdings: readonly HoldingValuation[];
  readonly valuedAt: Date;
}

/** 개별 보유 종목 평가 */
export interface HoldingValuation {
  readonly ticker: string;
  readonly quantity: number;
  readonly averagePrice: number;
  readonly currentPrice: number;
  readonly marketValue: number; // quantity * currentPrice
  readonly gainLoss: number; // marketValue - (quantity * averagePrice)
  readonly gainLossPercent: number;
  readonly dailyChange: number;
  readonly dailyChangePercent: number;
  readonly weight: number; // 포트폴리오 내 비중 (0.0 ~ 1.0)
}

/** 포트폴리오 요약 (뉴스 포함) */
export interface PortfolioSummary {
  readonly valuation: PortfolioValuation;
  readonly topMovers: readonly HoldingValuation[]; // 일일 변동 상위 3
  readonly relatedNews: readonly NewsItem[]; // 보유 종목 관련 뉴스
  readonly sentiment: SentimentResult; // 포트폴리오 전체 감성
}
```

---

## 5. 구현 상세

### 5.1 뉴스 어그리게이션 흐름

```
사용자 요청 ("애플 관련 뉴스 알려줘")
    │
    ▼
에이전트 → get_financial_news 도구 호출
    │
    ▼
tools.ts: handleGetFinancialNews(query)
    │
    ├── NewsAPI 프로바이더 (isAvailable? → NEWSAPI_KEY 존재 확인)
    ├── Alpha Vantage 프로바이더 (isAvailable? → ALPHA_VANTAGE_KEY 존재 확인)
    └── RSS 프로바이더 (항상 사용 가능)
    │
    ▼
Promise.allSettled([...providers.map(p => p.fetchNews(query))])
    │
    ▼
결과 병합 + 중복 제거 (URL 해시 기반) + 날짜순 정렬
    │
    ▼
NewsItem[] → 에이전트에 반환 (JSON 직렬화)
```

### 5.2 프로바이더별 구현

**NewsAPI 프로바이더 (`providers/newsapi.ts`)**:

```typescript
export function createNewsApiProvider(config: { apiKey: string; baseUrl?: string }): NewsProvider {
  const { apiKey, baseUrl = 'https://newsapi.org/v2' } = config;

  return {
    name: 'newsapi',
    isAvailable: () => apiKey.length > 0,

    async fetchNews(query: NewsQuery): Promise<NewsItem[]> {
      const params = new URLSearchParams({
        apiKey,
        language: 'en',
        sortBy: 'publishedAt',
        pageSize: String(query.limit ?? 20),
      });

      // 티커가 있으면 everything 엔드포인트, 없으면 top-headlines
      if (query.tickers?.length) {
        params.set('q', query.tickers.join(' OR '));
        params.set('domains', 'reuters.com,bloomberg.com,cnbc.com');
      }

      if (query.fromDate) {
        params.set('from', query.fromDate.toISOString().split('T')[0]);
      }

      const url = `${baseUrl}/everything?${params}`;
      const response = await fetch(url);

      if (!response.ok) {
        throw new NewsApiError(response.status, await response.text());
      }

      const data = (await response.json()) as NewsApiResponse;
      return data.articles.map(normalizeNewsApiArticle);
    },
  };
}

/** NewsAPI 응답을 NewsItem으로 정규화 */
function normalizeNewsApiArticle(article: NewsApiArticle): NewsItem {
  return {
    id: `newsapi-${hashUrl(article.url)}`,
    title: article.title,
    description: article.description ?? '',
    url: article.url,
    source: 'newsapi',
    sourceName: article.source.name,
    publishedAt: new Date(article.publishedAt),
    tickers: extractTickers(article.title + ' ' + article.description),
    imageUrl: article.urlToImage ?? undefined,
    category: inferCategory(article.title, article.description),
  };
}
```

**Alpha Vantage News 프로바이더 (`providers/alpha-vantage-news.ts`)**:

```typescript
export function createAlphaVantageNewsProvider(config: { apiKey: string }): NewsProvider {
  const { apiKey } = config;

  return {
    name: 'alpha-vantage',
    isAvailable: () => apiKey.length > 0,

    async fetchNews(query: NewsQuery): Promise<NewsItem[]> {
      const params = new URLSearchParams({
        function: 'NEWS_SENTIMENT',
        apikey: apiKey,
        limit: String(query.limit ?? 20),
        sort: 'LATEST',
      });

      if (query.tickers?.length) {
        params.set('tickers', query.tickers.join(','));
      }

      if (query.keywords?.length) {
        params.set('topics', query.keywords.join(','));
      }

      const url = `https://www.alphavantage.co/query?${params}`;
      const response = await fetch(url);
      const data = (await response.json()) as AlphaVantageNewsResponse;

      return (data.feed ?? []).map(normalizeAlphaVantageItem);
    },
  };
}
```

### 5.3 AI 시장 분석

**LLM 기반 분석 (`analysis/market-analysis.ts`)**:

```typescript
import type { ExecutionEngine } from '../../engine/types.js';
import type { MarketAnalysis, AnalysisOptions, NewsItem } from '../types.js';

export async function analyzeMarket(
  engine: ExecutionEngine,
  news: readonly NewsItem[],
  options: AnalysisOptions,
): Promise<MarketAnalysis> {
  const depth = options.depth ?? 'standard';
  const language = options.language ?? 'ko';

  // 뉴스를 분석 가능한 형태로 요약
  const newsDigest = news
    .slice(0, 30)
    .map(
      (item, i) =>
        `[${i + 1}] ${item.title} (${item.sourceName}, ${item.publishedAt.toLocaleDateString()})\n${item.description}`,
    )
    .join('\n\n');

  const systemPrompt = buildAnalysisSystemPrompt(depth, language);
  const userPrompt = buildAnalysisUserPrompt(
    newsDigest,
    options.tickers,
    options.includeIndicators,
  );

  // Phase 9 실행 엔진을 통한 LLM 호출
  const result = await engine.complete({
    systemPrompt,
    userPrompt,
    responseFormat: 'json',
    maxTokens: depth === 'brief' ? 500 : depth === 'detailed' ? 2000 : 1000,
  });

  return parseAnalysisResponse(result.content, news.length, options.tickers ?? []);
}

function buildAnalysisSystemPrompt(depth: string, language: string): string {
  const langInstruction =
    language === 'ko' ? '한국어로 분석 결과를 작성하세요.' : 'Write analysis results in English.';

  return `You are a professional financial market analyst. Analyze the provided news articles and generate a market analysis report.
${langInstruction}

Response format (JSON):
{
  "summary": "시장 전망 요약 (2-3 문단)",
  "sentiment": { "score": -1.0~1.0, "label": "bearish|neutral|bullish", "confidence": 0.0~1.0, "reasoning": "..." },
  "keyFactors": ["핵심 요인 1", "핵심 요인 2", ...],
  "risks": ["리스크 1", ...],
  "opportunities": ["기회 1", ...]
}`;
}
```

### 5.4 감성 분석 알고리즘

```typescript
// analysis/sentiment.ts

/** 규칙 기반 + LLM 하이브리드 감성 분석 */
export async function analyzeSentiment(
  news: readonly NewsItem[],
  engine?: ExecutionEngine,
): Promise<SentimentResult> {
  // 1단계: 규칙 기반 빠른 분석 (키워드 매칭)
  const ruleBasedScore = computeRuleBasedSentiment(news);

  // 2단계: LLM이 사용 가능하면 정밀 분석
  if (engine) {
    return await computeLlmSentiment(engine, news, ruleBasedScore);
  }

  // LLM 미사용 시 규칙 기반 결과 반환
  return {
    score: ruleBasedScore,
    label: scoreToLabel(ruleBasedScore),
    confidence: 0.6, // 규칙 기반은 신뢰도 상한 0.6
    reasoning: 'Rule-based sentiment analysis (keyword matching)',
  };
}

/** 키워드 기반 감성 점수 (-1 ~ +1) */
function computeRuleBasedSentiment(news: readonly NewsItem[]): number {
  const BULLISH_KEYWORDS = [
    'surge',
    'rally',
    'breakout',
    'upgrade',
    'beat',
    'record high',
    'growth',
    'bullish',
    'outperform',
    'buy',
    '상승',
    '급등',
    '돌파',
  ];
  const BEARISH_KEYWORDS = [
    'crash',
    'plunge',
    'downgrade',
    'miss',
    'selloff',
    'bear',
    'decline',
    'loss',
    'cut',
    'recession',
    '하락',
    '급락',
    '폭락',
  ];

  let bullishCount = 0;
  let bearishCount = 0;

  for (const item of news) {
    const text = (item.title + ' ' + item.description).toLowerCase();
    for (const kw of BULLISH_KEYWORDS) {
      if (text.includes(kw)) bullishCount++;
    }
    for (const kw of BEARISH_KEYWORDS) {
      if (text.includes(kw)) bearishCount++;
    }
  }

  const total = bullishCount + bearishCount;
  if (total === 0) return 0;
  return (bullishCount - bearishCount) / total;
}

function scoreToLabel(score: number): 'bearish' | 'neutral' | 'bullish' {
  if (score >= 0.2) return 'bullish';
  if (score <= -0.2) return 'bearish';
  return 'neutral';
}
```

### 5.5 포트폴리오 추적

```typescript
// portfolio/tracker.ts

import type { MarketDataService } from '../../market/types.js';
import type {
  Portfolio,
  PortfolioValuation,
  HoldingValuation,
  PortfolioSummary,
} from '../types.js';

export function createPortfolioTracker(deps: {
  marketData: MarketDataService; // Phase 16
  newsAggregator: NewsAggregator; // 이 Phase
}) {
  const { marketData, newsAggregator } = deps;

  return {
    /** 포트폴리오 현재가 평가 */
    async valuate(portfolio: Portfolio): Promise<PortfolioValuation> {
      const tickers = portfolio.holdings.map((h) => h.ticker);
      const quotes = await marketData.getQuotes(tickers);

      let totalValue = 0;
      let totalCost = 0;
      let totalDailyChange = 0;

      const holdingValuations: HoldingValuation[] = portfolio.holdings.map((holding) => {
        const quote = quotes.get(holding.ticker);
        if (!quote) {
          throw new TickerNotFoundError(holding.ticker);
        }

        const marketValue = holding.quantity * quote.price;
        const cost = holding.quantity * holding.averagePrice;
        const gainLoss = marketValue - cost;
        const dailyChange = holding.quantity * (quote.change ?? 0);

        totalValue += marketValue;
        totalCost += cost;
        totalDailyChange += dailyChange;

        return {
          ticker: holding.ticker,
          quantity: holding.quantity,
          averagePrice: holding.averagePrice,
          currentPrice: quote.price,
          marketValue,
          gainLoss,
          gainLossPercent: cost > 0 ? (gainLoss / cost) * 100 : 0,
          dailyChange,
          dailyChangePercent: quote.changePercent ?? 0,
          weight: 0, // 아래에서 계산
        };
      });

      // 비중 계산
      const valuationsWithWeight = holdingValuations.map((hv) => ({
        ...hv,
        weight: totalValue > 0 ? hv.marketValue / totalValue : 0,
      }));

      return {
        portfolioId: portfolio.id,
        totalValue,
        totalCost,
        totalGainLoss: totalValue - totalCost,
        totalGainLossPercent: totalCost > 0 ? ((totalValue - totalCost) / totalCost) * 100 : 0,
        dailyChange: totalDailyChange,
        dailyChangePercent: totalValue > 0 ? (totalDailyChange / totalValue) * 100 : 0,
        holdings: valuationsWithWeight,
        valuedAt: new Date(),
      };
    },

    /** 포트폴리오 종합 요약 (평가 + 뉴스 + 감성) */
    async summarize(portfolio: Portfolio): Promise<PortfolioSummary> {
      const tickers = portfolio.holdings.map((h) => h.ticker);

      const [valuation, relatedNews] = await Promise.all([
        this.valuate(portfolio),
        newsAggregator.fetchNews({ tickers, limit: 10 }),
      ]);

      const topMovers = [...valuation.holdings]
        .sort((a, b) => Math.abs(b.dailyChangePercent) - Math.abs(a.dailyChangePercent))
        .slice(0, 3);

      const sentiment = await analyzeSentiment(relatedNews);

      return { valuation, topMovers, relatedNews, sentiment };
    },
  };
}
```

### 5.6 에이전트 도구 정의

```typescript
// tools.ts

import type { ToolDefinition, ToolResult } from '../../agents/tools/types.js';

export function createNewsTools(deps: {
  newsAggregator: NewsAggregator;
  marketAnalyzer: MarketAnalyzer;
  portfolioTracker: PortfolioTracker;
}): ToolDefinition[] {
  return [
    {
      name: 'get_financial_news',
      description: '금융 뉴스를 검색합니다. 특정 종목, 키워드, 카테고리로 필터링할 수 있습니다.',
      parameters: {
        type: 'object',
        properties: {
          tickers: {
            type: 'array',
            items: { type: 'string' },
            description: '종목 코드 목록 (예: ["AAPL", "GOOGL", "BTC"])',
          },
          keywords: {
            type: 'array',
            items: { type: 'string' },
            description: '검색 키워드 (예: ["earnings", "Fed"])',
          },
          category: {
            type: 'string',
            enum: [
              'earnings',
              'merger',
              'ipo',
              'regulation',
              'macro',
              'crypto',
              'commodity',
              'general',
            ],
            description: '뉴스 카테고리',
          },
          limit: {
            type: 'number',
            description: '반환할 뉴스 수 (기본 10, 최대 50)',
          },
        },
        required: [],
      },
      execute: async (params): Promise<ToolResult> => {
        const news = await deps.newsAggregator.fetchNews({
          tickers: params.tickers,
          keywords: params.keywords,
          category: params.category,
          limit: Math.min(params.limit ?? 10, 50),
        });
        return { success: true, data: news };
      },
    },
    {
      name: 'analyze_market',
      description:
        '최신 뉴스를 기반으로 AI 시장 분석을 수행합니다. 감성 분석, 핵심 요인, 리스크/기회를 제공합니다.',
      parameters: {
        type: 'object',
        properties: {
          tickers: {
            type: 'array',
            items: { type: 'string' },
            description: '분석 대상 종목 (미지정 시 전체 시장)',
          },
          depth: {
            type: 'string',
            enum: ['brief', 'standard', 'detailed'],
            description: '분석 깊이 (기본 standard)',
          },
        },
        required: [],
      },
      execute: async (params): Promise<ToolResult> => {
        const analysis = await deps.marketAnalyzer.analyze({
          tickers: params.tickers,
          depth: params.depth ?? 'standard',
        });
        return { success: true, data: analysis };
      },
    },
    {
      name: 'get_portfolio_summary',
      description:
        '사용자 포트폴리오의 현재 가치, 손익, 관련 뉴스, 시장 감성을 종합적으로 요약합니다.',
      parameters: {
        type: 'object',
        properties: {
          portfolioId: {
            type: 'string',
            description: '포트폴리오 ID (미지정 시 기본 포트폴리오)',
          },
        },
        required: [],
      },
      execute: async (params): Promise<ToolResult> => {
        const summary = await deps.portfolioTracker.summarize(params.portfolioId);
        return { success: true, data: summary };
      },
    },
  ];
}
```

---

## 6. 선행 조건

| 선행 Phase                 | 산출물                                                    | 사용 목적                                         |
| -------------------------- | --------------------------------------------------------- | ------------------------------------------------- |
| **Phase 1** (핵심 타입)    | `NewsItem`, `Portfolio`, `Holding` 기본 타입              | 도메인 모델의 기초 타입. Phase 17에서 확장/구체화 |
| **Phase 2** (인프라)       | 로거, 에러 클래스, 재시도 유틸                            | API 호출 실패 시 로깅 및 재시도 처리              |
| **Phase 3** (설정)         | Zod 스키마, 환경변수 로딩                                 | `NEWSAPI_KEY`, `ALPHA_VANTAGE_KEY` 등 API 키 설정 |
| **Phase 7** (도구 시스템)  | `ToolDefinition`, `ToolRegistry`, `ToolResult` 인터페이스 | 에이전트 도구 등록 및 실행                        |
| **Phase 9** (실행 엔진)    | `ExecutionEngine.complete()`                              | AI 시장 분석 시 LLM 호출                          |
| **Phase 14** (스토리지)    | SQLite CRUD, `node:sqlite` 래퍼                           | 포트폴리오 데이터 영속화 (holdings CRUD)          |
| **Phase 16** (시장 데이터) | `MarketDataService.getQuotes()`, `TechnicalIndicator`     | 포트폴리오 현재가 평가, 기술 분석 데이터 연동     |

### 직접 의존 관계

```
Phase 16 (시장 데이터) ──→ Phase 17 (뉴스 & 분석)
Phase 9  (실행 엔진)  ──→ Phase 17 (LLM 호출)
Phase 7  (도구 시스템) ──→ Phase 17 (도구 등록)
Phase 14 (스토리지)   ──→ Phase 17 (포트폴리오 저장)
```

---

## 7. 산출물 및 검증

### 기능 검증 체크리스트

| #   | 검증 항목                                                             | 테스트 방법                         | 파일                         |
| --- | --------------------------------------------------------------------- | ----------------------------------- | ---------------------------- |
| 1   | NewsAPI 프로바이더가 응답을 `NewsItem[]`으로 정규화                   | unit test: mock HTTP 응답 파싱      | `newsapi.test.ts`            |
| 2   | Alpha Vantage News 프로바이더가 sentiment 데이터 포함하여 정규화      | unit test: mock 응답 매핑           | `alpha-vantage-news.test.ts` |
| 3   | API 키 미설정 시 해당 프로바이더 `isAvailable()` = false              | unit test: 환경변수 미설정 케이스   | `newsapi.test.ts`            |
| 4   | 다중 프로바이더 병합 시 URL 기반 중복 제거                            | unit test: 동일 URL 뉴스 중복 검증  | `newsapi.test.ts`            |
| 5   | 규칙 기반 감성 분석이 키워드에 따라 bullish/bearish/neutral 반환      | unit test: 키워드 뉴스 셋           | `sentiment.test.ts`          |
| 6   | 포트폴리오 평가가 정확한 P&L, 일일 변동, 비중 계산                    | unit test: 고정 시세 + 보유종목     | `tracker.test.ts`            |
| 7   | `get_financial_news` 도구가 올바른 JSON Schema 파라미터 정의          | unit test: 스키마 검증              | 통합 테스트                  |
| 8   | 프로바이더 장애 시 다른 프로바이더 결과만 반환 (Graceful Degradation) | unit test: 하나의 프로바이더 reject | `newsapi.test.ts`            |
| 9   | `limit` 파라미터가 50을 초과하지 않도록 클램핑                        | unit test: limit=100 -> 50 변환     | `tools.ts` 테스트            |
| 10  | 포트폴리오 요약에서 topMovers가 일일 변동률 상위 3 정렬               | unit test: 5개 종목 중 상위 3 검증  | `tracker.test.ts`            |

### vitest 실행 기대 결과

```bash
# unit 테스트 (mock 기반, 외부 API 호출 없음)
pnpm vitest run src/skills/news/

# 예상 결과:
# ✓ providers/newsapi.test.ts (6 tests)
# ✓ providers/alpha-vantage-news.test.ts (5 tests)
# ✓ analysis/sentiment.test.ts (8 tests)
# ✓ portfolio/tracker.test.ts (7 tests)
# Total: 26 tests passed
```

---

## 8. 복잡도 및 예상 파일 수

| 항목               | 값                                                         |
| ------------------ | ---------------------------------------------------------- |
| **복잡도**         | **M** (Medium)                                             |
| **소스 파일**      | 9개                                                        |
| **테스트 파일**    | 4개                                                        |
| **총 파일 수**     | **13개**                                                   |
| **예상 LOC**       | ~1,310                                                     |
| **예상 소요 기간** | 2-3일                                                      |
| **외부 의존성**    | 없음 (Node.js 22+ 내장 `fetch` 사용)                       |
| **새 환경변수**    | `NEWSAPI_KEY`, `ALPHA_VANTAGE_KEY`, `RSS_FEED_URLS` (선택) |

### 복잡도 근거

- 3개 뉴스 프로바이더 구현 (각각 독립적, 공통 인터페이스)
- AI 분석은 Phase 9 실행 엔진에 위임하므로 LLM 통합 로직은 프롬프트 구성 + 응답 파싱에 집중
- 포트폴리오 추적은 Phase 16 시장 데이터 서비스를 조합하는 얇은 계층
- 에이전트 도구는 JSON Schema 정의 + 핸들러 위임 패턴
- 외부 API 호출이 핵심이므로 mock 기반 테스트가 중요
