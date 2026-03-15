# Phase 17: 금융 스킬 -- 뉴스 & AI 분석

## 1. 목표

금융 뉴스 수집과 AI 기반 시장 분석 기능을 구현한다. 구체적으로:

1. **뉴스 어그리게이션**: 다중 소스(NewsAPI.org, Alpha Vantage News Sentiment, RSS 피드)에서 금융 뉴스를 수집하고 정규화된 `NewsItem` 형식으로 통합한다.
2. **AI 시장 분석**: LLM을 활용하여 뉴스 묶음에 대한 시장 전망 요약, 감성 분석(5단계: very_negative ~ very_positive 스코어링), 기술적 지표 해석을 수행한다.
3. **포트폴리오 추적**: 사용자가 보유 종목(symbol, 수량, 평균 비용(averageCost))을 정의하고, 현재 가치 평가(P&L, 일일 변동), 포트폴리오 특화 뉴스 필터링을 제공한다.
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
2. **Tool Definition Schema**: `RegisteredToolDefinition` 형식(`inputSchema` 기반) + `ToolExecutor` 분리 패턴을 따라 에이전트 도구를 정의한다. (`@finclaw/agent`의 `registry.ts` 참조)
3. **Graceful Degradation**: 뉴스 API 장애 시 다른 프로바이더로 폴백하고, API 키 미설정 시 해당 프로바이더만 비활성화하는 패턴.
4. **Phase 16 Review 교훈 적용**: `plans/phase16/review.md`의 이슈를 반복하지 않는다.
   - I-1: 모든 executor에 try-catch 필수 → `{ content: error.message, isError: true }` 반환
   - I-4: 외부 API 응답에 `as` 캐스트 대신 Zod v4 `safeParse` 검증 사용

---

## 3. 생성할 파일

> **경로**: `src/news/` (Phase 16 `src/market/`와 병렬 구조)

### 소스 파일 (11개)

| #   | 파일 경로                                  | 설명                                                                       | 예상 LOC |
| --- | ------------------------------------------ | -------------------------------------------------------------------------- | -------- |
| 1   | `src/news/index.ts`                        | 스킬 진입점, `registerNewsTools(registry, config)` + `NEWS_SKILL_METADATA` | ~70      |
| 2   | `src/news/types.ts`                        | 스킬 전용 타입 + `NewsAggregator` 인터페이스 (Phase 18이 import)           | ~80      |
| 3   | `src/news/aggregator.ts`                   | `NewsAggregator` 구현: 병렬 수집, URL 기반 중복 제거, 캐시                 | ~100     |
| 4   | `src/news/providers/newsapi.ts`            | NewsAPI.org + `safeFetchJson` + `retry`                                    | ~100     |
| 5   | `src/news/providers/alpha-vantage-news.ts` | Alpha Vantage News + `safeFetchJson` + `retry`                             | ~100     |
| 6   | `src/news/providers/rss.ts`                | RSS 피드 (`feedsmith` 패키지 사용)                                         | ~90      |
| 7   | `src/news/analysis/market-analysis.ts`     | `@anthropic-ai/sdk` 직접 호출 + Zod v4 응답 검증                           | ~130     |
| 8   | `src/news/analysis/sentiment.ts`           | 5단계 `NewsSentiment` + 규칙 기반 폴백                                     | ~100     |
| 9   | `src/news/portfolio/tracker.ts`            | P&L 계산, `QuoteService` 어댑터 (Phase 16 `getQuoteFromState` 브릿지)      | ~130     |
| 10  | `src/news/portfolio/store.ts`              | SQLite CRUD (portfolios + holdings 테이블)                                 | ~120     |
| 11  | `src/news/tools.ts`                        | `RegisteredToolDefinition` + `ToolExecutor` 패턴 도구 정의                 | ~120     |

### 테스트 파일 (4개)

| #   | 파일 경로                                                 | 테스트 대상                                             | 예상 LOC |
| --- | --------------------------------------------------------- | ------------------------------------------------------- | -------- |
| 1   | `src/news/providers/__tests__/newsapi.test.ts`            | NewsAPI 프로바이더 (응답 파싱, 에러 핸들링, rate limit) | ~120     |
| 2   | `src/news/providers/__tests__/alpha-vantage-news.test.ts` | Alpha Vantage News 프로바이더                           | ~100     |
| 3   | `src/news/analysis/__tests__/sentiment.test.ts`           | 감성 분석 5단계 스코어링 로직                           | ~100     |
| 4   | `src/news/portfolio/__tests__/tracker.test.ts`            | 포트폴리오 평가, P&L 계산, 뉴스 필터링                  | ~120     |

**합계: 소스 11개 + 테스트 4개 = 15개 파일, 예상 ~1,460 LOC**

---

## 4. 핵심 인터페이스/타입

**원칙**: `@finclaw/types`의 타입을 **재정의하지 않고 import**한다. 스킬 전용 타입만 신규 정의.

### 4.1 `@finclaw/types`에서 import하는 타입 (재정의 금지)

| 타입               | finance.ts 위치 | 주요 필드 (plan.md 이전 대비 변경점)                                                                                      |
| ------------------ | --------------- | ------------------------------------------------------------------------------------------------------------------------- |
| `NewsItem`         | L98-110         | `summary?` (~~description~~), `symbols?: TickerSymbol[]` (~~tickers: string[]~~), `source: string`                        |
| `NewsSentiment`    | L113-117        | 5단계 label: `very_negative \| negative \| neutral \| positive \| very_positive` (~~3단계~~), `reasoning` 필드 없음       |
| `TickerSymbol`     | L6              | Branded 타입 `Brand<string, 'TickerSymbol'>`                                                                              |
| `Portfolio`        | L163-173        | `holdings: PortfolioHolding[]`, `currency: CurrencyCode`, ~~userId/createdAt 없음~~                                       |
| `PortfolioHolding` | L176-186        | `symbol: TickerSymbol` (~~ticker~~), `averageCost` (~~averagePrice~~), `currentPrice?`, `marketValue?`, `pnl?`, `weight?` |
| `PortfolioSummary` | L189-196        | `topGainers` + `topLosers` (~~topMovers~~), `sectorAllocation`, `dailyChange`                                             |

### 4.2 스킬 전용 신규 타입

```typescript
// src/news/types.ts
import type { NewsItem, TickerSymbol } from '@finclaw/types';

/** 뉴스 소스 프로바이더 식별자 */
export type NewsSourceId = 'newsapi' | 'alpha-vantage' | 'rss';

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
  readonly symbols?: readonly TickerSymbol[]; // 특정 종목 관련 뉴스
  readonly keywords?: readonly string[];
  readonly category?: NewsCategory;
  readonly sources?: readonly NewsSourceId[];
  readonly limit?: number; // 기본 20
  readonly fromDate?: Date;
}

/** 뉴스 프로바이더 인터페이스 (Provider 추상화) */
export interface NewsProvider {
  readonly name: NewsSourceId;
  readonly isAvailable: () => boolean;
  fetchNews(query: NewsQuery): Promise<NewsItem[]>;
}

/** 뉴스 어그리게이터 인터페이스 (Phase 18이 `../../news/types.js`에서 import) */
export interface NewsAggregator {
  fetchNews(query: NewsQuery): Promise<NewsItem[]>;
}

// ─── AI 분석 도메인 타입 (스킬 전용) ───

/** 시장 분석 결과 */
export interface MarketAnalysis {
  readonly summary: string;
  readonly sentiment: import('@finclaw/types').NewsSentiment;
  readonly keyFactors: readonly string[];
  readonly risks: readonly string[];
  readonly opportunities: readonly string[];
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

> **공통 패턴**: 모든 프로바이더에서 raw `fetch()` 대신 `safeFetchJson<T>(url, { timeoutMs: 10_000 })` (from `@finclaw/infra`) 사용. `retry()` 래핑 (maxAttempts: 2, 429/ECONNRESET 재시도). 정규화 시 `description` → `summary`, `tickers` → `symbols` 필드 매핑 준수.

**NewsAPI 프로바이더 (`providers/newsapi.ts`)**:

```typescript
import { safeFetchJson, retry } from '@finclaw/infra';
import type { NewsItem, TickerSymbol } from '@finclaw/types';
import type { NewsProvider, NewsQuery } from '../types.js';

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

      if (query.symbols?.length) {
        params.set('q', (query.symbols as string[]).join(' OR '));
        params.set('domains', 'reuters.com,bloomberg.com,cnbc.com');
      }

      if (query.fromDate) {
        params.set('from', query.fromDate.toISOString().split('T')[0]);
      }

      const url = `${baseUrl}/everything?${params}`;
      const data = await retry(() => safeFetchJson<NewsApiResponse>(url, { timeoutMs: 10_000 }), {
        maxAttempts: 2,
      });
      return data.articles.map(normalizeNewsApiArticle);
    },
  };
}

/** NewsAPI 응답을 NewsItem으로 정규화 */
function normalizeNewsApiArticle(article: NewsApiArticle): NewsItem {
  return {
    id: `newsapi-${hashUrl(article.url)}`,
    title: article.title,
    summary: article.description ?? undefined, // description → summary
    url: article.url,
    source: 'newsapi', // string (NewsSourceId와 동일 값)
    publishedAt: new Date(article.publishedAt).toISOString(),
    symbols: extractTickers(article.title + ' ' + (article.description ?? '')) as TickerSymbol[],
    imageUrl: article.urlToImage ?? undefined,
    categories: [inferCategory(article.title, article.description)],
  };
}
```

**Alpha Vantage News 프로바이더 (`providers/alpha-vantage-news.ts`)**:

```typescript
import { safeFetchJson, retry } from '@finclaw/infra';

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

      if (query.symbols?.length) {
        params.set('tickers', (query.symbols as string[]).join(','));
      }

      if (query.keywords?.length) {
        params.set('topics', query.keywords.join(','));
      }

      const url = `https://www.alphavantage.co/query?${params}`;
      const data = await retry(
        () => safeFetchJson<AlphaVantageNewsResponse>(url, { timeoutMs: 10_000 }),
        { maxAttempts: 2 },
      );
      return (data.feed ?? []).map(normalizeAlphaVantageItem);
    },
  };
}
```

**RSS 프로바이더 (`providers/rss.ts`)**: `feedsmith` 패키지 (^3.0.0) 사용하여 XML 파싱.

### 5.3 AI 시장 분석

**LLM 기반 분석 (`analysis/market-analysis.ts`)**:

> `ExecutionEngine` (Phase 9)은 사용하지 않는다. `@anthropic-ai/sdk`를 직접 호출한다.

```typescript
import Anthropic from '@anthropic-ai/sdk';
import { z } from 'zod/v4';
import type { NewsItem } from '@finclaw/types';
import type { MarketAnalysis, AnalysisOptions } from '../types.js';

// Zod v4 응답 검증 스키마 (Phase 16 review I-4 교훈: as 캐스트 금지)
const AnalysisResponseSchema = z.object({
  summary: z.string(),
  sentiment: z.object({
    score: z.number().min(-1).max(1),
    label: z.enum(['very_negative', 'negative', 'neutral', 'positive', 'very_positive']),
    confidence: z.number().min(0).max(1),
  }),
  keyFactors: z.array(z.string()),
  risks: z.array(z.string()),
  opportunities: z.array(z.string()),
});

export async function analyzeMarket(
  client: Anthropic,
  news: readonly NewsItem[],
  options: AnalysisOptions,
): Promise<MarketAnalysis> {
  const depth = options.depth ?? 'standard';
  const language = options.language ?? 'ko';

  const newsDigest = news
    .slice(0, 30)
    .map(
      (item, i) =>
        `[${i + 1}] ${item.title} (${item.source}, ${item.publishedAt})\n${item.summary ?? ''}`,
    )
    .join('\n\n');

  const systemPrompt = buildAnalysisSystemPrompt(depth, language);
  const userPrompt = buildAnalysisUserPrompt(
    newsDigest,
    options.symbols,
    options.includeIndicators,
  );

  // @anthropic-ai/sdk 직접 호출 (engine.complete() 아님)
  const message = await client.messages.create({
    model: 'claude-sonnet-4-20250514',
    max_tokens: depth === 'brief' ? 500 : depth === 'detailed' ? 2000 : 1000,
    system: systemPrompt,
    messages: [{ role: 'user', content: userPrompt }],
  });

  const text = message.content[0]?.type === 'text' ? message.content[0].text : '';
  const parsed = AnalysisResponseSchema.safeParse(JSON.parse(text));
  if (!parsed.success) {
    throw new Error(`LLM response validation failed: ${parsed.error.message}`);
  }

  return {
    ...parsed.data,
    analyzedAt: new Date(),
    newsCount: news.length,
    symbols: options.symbols ?? [],
  };
}

function buildAnalysisSystemPrompt(depth: string, language: string): string {
  const langInstruction =
    language === 'ko' ? '한국어로 분석 결과를 작성하세요.' : 'Write analysis results in English.';

  return `You are a professional financial market analyst. Analyze the provided news articles and generate a market analysis report.
${langInstruction}

Response format (JSON):
{
  "summary": "시장 전망 요약 (2-3 문단)",
  "sentiment": { "score": -1.0~1.0, "label": "very_negative|negative|neutral|positive|very_positive", "confidence": 0.0~1.0 },
  "keyFactors": ["핵심 요인 1", "핵심 요인 2", ...],
  "risks": ["리스크 1", ...],
  "opportunities": ["기회 1", ...]
}`;
}
```

> **참고**: `@anthropic-ai/sdk` (^0.78.0)를 `@finclaw/skills-finance`의 `package.json`에 추가 필요.

### 5.4 감성 분석 알고리즘

```typescript
// analysis/sentiment.ts
import type Anthropic from '@anthropic-ai/sdk';
import type { NewsItem, NewsSentiment } from '@finclaw/types';

/** 규칙 기반 + LLM 하이브리드 감성 분석 */
export async function analyzeSentiment(
  news: readonly NewsItem[],
  client?: Anthropic,
): Promise<NewsSentiment> {
  // 1단계: 규칙 기반 빠른 분석 (키워드 매칭)
  const ruleBasedScore = computeRuleBasedSentiment(news);

  // 2단계: LLM이 사용 가능하면 정밀 분석
  if (client) {
    return await computeLlmSentiment(client, news, ruleBasedScore);
  }

  // LLM 미사용 시 규칙 기반 결과 반환
  return {
    score: ruleBasedScore,
    label: scoreToLabel(ruleBasedScore),
    confidence: 0.6, // 규칙 기반은 신뢰도 상한 0.6
  };
}

/** 키워드 기반 감성 점수 (-1 ~ +1) */
function computeRuleBasedSentiment(news: readonly NewsItem[]): number {
  const POSITIVE_KEYWORDS = [
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
  const NEGATIVE_KEYWORDS = [
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

  let positiveCount = 0;
  let negativeCount = 0;

  for (const item of news) {
    const text = (item.title + ' ' + (item.summary ?? '')).toLowerCase();
    for (const kw of POSITIVE_KEYWORDS) {
      if (text.includes(kw)) positiveCount++;
    }
    for (const kw of NEGATIVE_KEYWORDS) {
      if (text.includes(kw)) negativeCount++;
    }
  }

  const total = positiveCount + negativeCount;
  if (total === 0) return 0;
  return (positiveCount - negativeCount) / total;
}

/** 5단계 감성 라벨 (NewsSentiment.label과 일치) */
function scoreToLabel(score: number): NewsSentiment['label'] {
  if (score >= 0.6) return 'very_positive';
  if (score >= 0.2) return 'positive';
  if (score <= -0.6) return 'very_negative';
  if (score <= -0.2) return 'negative';
  return 'neutral';
}
```

### 5.5 포트폴리오 추적

> **핵심 변경**: `PortfolioValuation`, `HoldingValuation` 커스텀 타입 제거. `@finclaw/types`의 `Portfolio`, `PortfolioHolding`, `PortfolioSummary`를 직접 사용. `portfolio/store.ts`에서 SQLite CRUD 담당.

```typescript
// portfolio/tracker.ts
import type { Portfolio, PortfolioHolding, PortfolioSummary } from '@finclaw/types';
import type { NewsAggregator } from '../types.js';
import { analyzeSentiment } from '../analysis/sentiment.js';

/** Phase 16 시세 조회 어댑터 인터페이스 */
export interface QuoteService {
  getQuote(symbol: string): Promise<{ price: number; change: number; changePercent: number }>;
}

export function createPortfolioTracker(deps: {
  quoteService: QuoteService; // Phase 16 getQuoteFromState 브릿지
  newsAggregator: NewsAggregator; // 이 Phase
}) {
  const { quoteService, newsAggregator } = deps;

  return {
    /** 포트폴리오 보유 종목에 현재가 반영 */
    async valuate(portfolio: Portfolio): Promise<Portfolio> {
      let totalValue = 0;
      let totalCost = 0;

      const holdings: PortfolioHolding[] = await Promise.all(
        portfolio.holdings.map(async (h) => {
          const quote = await quoteService.getQuote(h.symbol as string);
          const marketValue = h.quantity * quote.price;
          const cost = h.quantity * h.averageCost;
          const pnl = marketValue - cost;

          totalValue += marketValue;
          totalCost += cost;

          return {
            ...h,
            currentPrice: quote.price,
            marketValue,
            pnl,
            pnlPercent: cost > 0 ? (pnl / cost) * 100 : 0,
            weight: 0, // 아래에서 계산
          };
        }),
      );

      // 비중 계산
      const holdingsWithWeight = holdings.map((h) => ({
        ...h,
        weight: totalValue > 0 ? (h.marketValue ?? 0) / totalValue : 0,
      }));

      return {
        ...portfolio,
        holdings: holdingsWithWeight,
        totalValue,
        totalCost,
        totalPnL: totalValue - totalCost,
        totalPnLPercent: totalCost > 0 ? ((totalValue - totalCost) / totalCost) * 100 : 0,
        updatedAt: new Date().toISOString(),
      };
    },

    /** 포트폴리오 종합 요약 */
    async summarize(portfolio: Portfolio): Promise<PortfolioSummary> {
      const symbols = portfolio.holdings.map((h) => h.symbol);
      const valuated = await this.valuate(portfolio);

      const sorted = [...valuated.holdings].sort(
        (a, b) => (b.pnlPercent ?? 0) - (a.pnlPercent ?? 0),
      );
      const topGainers = sorted.slice(0, 3);
      const topLosers = sorted.slice(-3).reverse();

      // dailyChange는 각 종목의 change를 집계하여 계산
      let dailyChange = 0;
      for (const h of valuated.holdings) {
        const quote = await quoteService.getQuote(h.symbol as string);
        dailyChange += h.quantity * quote.change;
      }
      const dailyChangePercent =
        (valuated.totalValue ?? 0) > 0 ? (dailyChange / valuated.totalValue!) * 100 : 0;

      return {
        portfolio: valuated,
        topGainers,
        topLosers,
        sectorAllocation: {}, // 향후 FinancialInstrument.sector 기반 구현
        dailyChange,
        dailyChangePercent,
      };
    },
  };
}
```

**`portfolio/store.ts`**: SQLite 기반 포트폴리오 + 보유종목 CRUD. `@finclaw/storage`의 `node:sqlite` 래퍼 활용.

### 5.6 에이전트 도구 정의

> Phase 16 `market/index.ts` 패턴을 1:1 준수한다.
>
> | 변경 항목     | Before                                                          | After                                                                        |
> | ------------- | --------------------------------------------------------------- | ---------------------------------------------------------------------------- |
> | import        | `ToolDefinition, ToolResult` from `../../agents/tools/types.js` | `RegisteredToolDefinition, ToolExecutor, ToolRegistry` from `@finclaw/agent` |
> | 함수 시그니처 | `createNewsTools(): ToolDefinition[]`                           | `registerNewsTools(registry: ToolRegistry, config): Promise<void>`           |
> | 스키마 키     | `parameters`                                                    | `inputSchema`                                                                |
> | 실행 패턴     | `execute: async (params) => {success, data}`                    | 별도 `ToolExecutor` → `{content: string, isError: boolean}`                  |
> | 에러 처리     | 없음                                                            | 모든 executor try-catch 필수 (I-1 교훈)                                      |

```typescript
// tools.ts
import type { RegisteredToolDefinition, ToolExecutor, ToolRegistry } from '@finclaw/agent';

function registerGetFinancialNewsTool(
  registry: ToolRegistry,
  deps: { newsAggregator: NewsAggregator },
): void {
  const def: RegisteredToolDefinition = {
    name: 'get_financial_news',
    description: '금융 뉴스를 검색합니다. 특정 종목, 키워드, 카테고리로 필터링할 수 있습니다.',
    inputSchema: {
      type: 'object',
      properties: {
        symbols: {
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
        limit: { type: 'number', description: '반환할 뉴스 수 (기본 10, 최대 50)' },
      },
      required: [],
    },
    group: 'finance',
    requiresApproval: false,
    isTransactional: false,
    accessesSensitiveData: false,
    isExternal: true,
    timeoutMs: 15_000,
  };
  const executor: ToolExecutor = async (input) => {
    try {
      const news = await deps.newsAggregator.fetchNews({
        symbols: input.symbols as any,
        keywords: input.keywords as string[],
        category: input.category as any,
        limit: Math.min((input.limit as number) ?? 10, 50),
      });
      return { content: JSON.stringify(news), isError: false };
    } catch (error) {
      return { content: error instanceof Error ? error.message : String(error), isError: true };
    }
  };
  registry.register(def, executor, 'skill');
}

// analyze_market, get_portfolio_summary 도 동일 패턴으로 등록
// (각각 별도 함수 → registerNewsTools()에서 일괄 호출)
```

```typescript
// index.ts (진입점)
export async function registerNewsTools(
  registry: ToolRegistry,
  config: NewsSkillConfig,
): Promise<void> {
  // 프로바이더, 어그리게이터, 분석기, 포트폴리오 트래커 초기화
  // ...
  registerGetFinancialNewsTool(registry, { newsAggregator });
  registerAnalyzeMarketTool(registry, { newsAggregator, client });
  registerGetPortfolioSummaryTool(registry, { portfolioTracker });
}

/** 스킬 메타데이터 */
export const NEWS_SKILL_METADATA = {
  name: 'news-analysis',
  description: '금융 뉴스 수집, AI 시장 분석, 포트폴리오 추적을 제공합니다.',
  version: '1.0.0',
  requires: {
    env: [],
    optionalEnv: ['NEWSAPI_KEY', 'ALPHA_VANTAGE_KEY', 'ANTHROPIC_API_KEY'],
  },
  tools: ['get_financial_news', 'analyze_market', 'get_portfolio_summary'],
} as const;
```

---

## 6. 선행 조건

| 선행 Phase                 | 산출물                                                                           | 사용 목적                                         |
| -------------------------- | -------------------------------------------------------------------------------- | ------------------------------------------------- |
| **Phase 1** (핵심 타입)    | `NewsItem`, `NewsSentiment`, `Portfolio`, `PortfolioHolding`, `PortfolioSummary` | 도메인 모델 SSOT. 재정의 금지, import만 사용      |
| **Phase 2** (인프라)       | `safeFetch`, `safeFetchJson`, `retry`, 로거, 에러 클래스                         | 모든 프로바이더의 HTTP 호출 + 재시도 처리         |
| **Phase 3** (설정)         | Zod 스키마, 환경변수 로딩                                                        | `NEWSAPI_KEY`, `ALPHA_VANTAGE_KEY` 등 API 키 설정 |
| **Phase 7** (도구 시스템)  | `RegisteredToolDefinition`, `ToolExecutor`, `ToolRegistry`, `ToolResult`         | 에이전트 도구 등록 및 실행                        |
| **Phase 14** (스토리지)    | SQLite CRUD, `node:sqlite` 래퍼                                                  | 포트폴리오 데이터 영속화 (portfolio/store.ts)     |
| **Phase 16** (시장 데이터) | `getQuoteFromState()`, `ProviderMarketQuote`, `TechnicalIndicator`               | 포트폴리오 현재가 평가 (QuoteService 어댑터)      |

### 외부 의존성

| 패키지              | 버전    | 용도                                                     |
| ------------------- | ------- | -------------------------------------------------------- |
| `@anthropic-ai/sdk` | ^0.78.0 | AI 시장 분석 LLM 호출 (engine.complete() 대신 직접 사용) |
| `feedsmith`         | ^3.0.0  | RSS 피드 XML 파싱                                        |

### 직접 의존 관계

```
Phase 16 (시장 데이터) ──→ Phase 17 (뉴스 & 분석)
Phase 7  (도구 시스템) ──→ Phase 17 (도구 등록)
Phase 14 (스토리지)   ──→ Phase 17 (포트폴리오 저장)
```

> **참고**: Phase 9 (실행 엔진) 의존 **제거**. `@anthropic-ai/sdk`를 직접 사용한다.

---

## 7. 산출물 및 검증

### 기능 검증 체크리스트

| #   | 검증 항목                                                                         | 테스트 방법                             | 파일                         |
| --- | --------------------------------------------------------------------------------- | --------------------------------------- | ---------------------------- |
| 1   | NewsAPI 프로바이더가 응답을 `NewsItem[]`으로 정규화 (`summary`, `symbols` 필드)   | unit test: mock HTTP 응답 파싱          | `newsapi.test.ts`            |
| 2   | Alpha Vantage News 프로바이더가 sentiment 데이터 포함하여 정규화                  | unit test: mock 응답 매핑               | `alpha-vantage-news.test.ts` |
| 3   | API 키 미설정 시 해당 프로바이더 `isAvailable()` = false                          | unit test: 환경변수 미설정 케이스       | `newsapi.test.ts`            |
| 4   | 다중 프로바이더 병합 시 URL 기반 중복 제거                                        | unit test: 동일 URL 뉴스 중복 검증      | `newsapi.test.ts`            |
| 5   | 규칙 기반 감성 분석이 5단계 라벨 반환 (`very_negative` ~ `very_positive`)         | unit test: 키워드 뉴스 셋               | `sentiment.test.ts`          |
| 6   | 포트폴리오 평가가 정확한 P&L, 비중 계산 (`averageCost`, `symbol` 사용)            | unit test: 고정 시세 + 보유종목         | `tracker.test.ts`            |
| 7   | 도구가 `RegisteredToolDefinition` 필수 필드 전부 포함 (`inputSchema`, `group` 등) | unit test: 스키마 검증                  | 통합 테스트                  |
| 8   | 프로바이더 장애 시 다른 프로바이더 결과만 반환 (Graceful Degradation)             | unit test: 하나의 프로바이더 reject     | `newsapi.test.ts`            |
| 9   | `limit` 파라미터가 50을 초과하지 않도록 클램핑                                    | unit test: limit=100 -> 50 변환         | `tools.ts` 테스트            |
| 10  | 포트폴리오 요약에서 `topGainers` + `topLosers` 분리 정렬                          | unit test: 5개 종목 중 상위/하위 3 검증 | `tracker.test.ts`            |
| 11  | 모든 프로바이더가 `safeFetchJson` + `retry` 사용 (raw `fetch()` 없음)             | 코드 리뷰                               | 전체 프로바이더              |
| 12  | 모든 executor가 `{ content: string, isError: boolean }` 반환                      | unit test: 에러 케이스 검증             | `tools.ts` 테스트            |
| 13  | `NewsAggregator` 인터페이스가 Phase 18 import 경로와 호환                         | `pnpm typecheck`                        | `src/news/types.ts`          |
| 14  | `portfolio/store.ts` SQLite CRUD 동작                                             | unit test: in-memory DB                 | `tracker.test.ts`            |

### vitest 실행 기대 결과

```bash
# unit 테스트 (mock 기반, 외부 API 호출 없음)
pnpm vitest run src/news/

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
| **소스 파일**      | 11개                                                       |
| **테스트 파일**    | 4개                                                        |
| **총 파일 수**     | **15개**                                                   |
| **예상 LOC**       | ~1,460                                                     |
| **예상 소요 기간** | 2-3일                                                      |
| **외부 의존성**    | `@anthropic-ai/sdk` (^0.78.0), `feedsmith` (^3.0.0)        |
| **새 환경변수**    | `NEWSAPI_KEY`, `ALPHA_VANTAGE_KEY`, `RSS_FEED_URLS` (선택) |

### 복잡도 근거

- 3개 뉴스 프로바이더 구현 (각각 독립적, 공통 인터페이스, `safeFetchJson` + `retry` 사용)
- AI 분석은 `@anthropic-ai/sdk`를 직접 호출하고 Zod v4로 응답 검증 (Phase 9 실행 엔진 미사용)
- 포트폴리오 추적은 Phase 16 `getQuoteFromState` 브릿지 + SQLite CRUD (store.ts)
- 에이전트 도구는 `RegisteredToolDefinition` + `ToolExecutor` 분리 패턴 + try-catch 필수
- 외부 API 호출이 핵심이므로 mock 기반 테스트가 중요
