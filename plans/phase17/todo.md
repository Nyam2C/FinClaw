# Phase 17: 뉴스 & AI 분석 — 상세 구현 가이드

> **기준 패턴**: `packages/skills-finance/src/market/` (Phase 16)를 1:1 준수한다.
> **원칙**: `@finclaw/types`의 타입을 재정의하지 않고 import만 사용한다.

---

## 0. 사전 작업

### 0-1. 외부 의존성 설치

```bash
cd packages/skills-finance
pnpm add @anthropic-ai/sdk@^0.78.0 feedsmith@^3.0.0
```

### 0-2. package.json 확인

설치 후 `dependencies`에 아래가 추가되어야 한다:

```jsonc
{
  "dependencies": {
    // ...기존...
    "@anthropic-ai/sdk": "^0.78.0",
    "feedsmith": "^3.0.0",
  },
}
```

> `pnpm format:fix` 실행하여 oxfmt가 key 순서를 재정렬할 수 있다.

### 0-3. tsconfig.json — 변경 불필요

현재 `tsconfig.json`에 이미 `@finclaw/agent`, `@finclaw/infra`, `@finclaw/storage`, `@finclaw/types` 참조가 있으므로 수정 불필요.

### 0-4. 스키마 마이그레이션 (portfolios + holdings 테이블)

`packages/storage/src/database.ts`의 `SCHEMA_DDL`에 포트폴리오 테이블을 추가하고, `SCHEMA_VERSION`을 2로 올린다.

```sql
CREATE TABLE IF NOT EXISTS portfolios (
  id         TEXT PRIMARY KEY,
  name       TEXT NOT NULL,
  currency   TEXT NOT NULL DEFAULT 'USD',
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS portfolio_holdings (
  portfolio_id TEXT NOT NULL,
  symbol       TEXT NOT NULL,
  quantity     REAL NOT NULL,
  average_cost REAL NOT NULL,
  PRIMARY KEY (portfolio_id, symbol),
  FOREIGN KEY (portfolio_id) REFERENCES portfolios(id) ON DELETE CASCADE
);
```

`MIGRATIONS` 에 추가:

```typescript
const MIGRATIONS: Record<number, string> = {
  2: `
CREATE TABLE IF NOT EXISTS portfolios (
  id         TEXT PRIMARY KEY,
  name       TEXT NOT NULL,
  currency   TEXT NOT NULL DEFAULT 'USD',
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS portfolio_holdings (
  portfolio_id TEXT NOT NULL,
  symbol       TEXT NOT NULL,
  quantity     REAL NOT NULL,
  average_cost REAL NOT NULL,
  PRIMARY KEY (portfolio_id, symbol),
  FOREIGN KEY (portfolio_id) REFERENCES portfolios(id) ON DELETE CASCADE
);
`,
};
```

`SCHEMA_VERSION`을 `1` → `2`로 변경. `SCHEMA_DDL`에도 동일 CREATE TABLE 문 추가.

---

## 1. 구현 순서 (의존성 기준 정렬)

| 순서 | 파일                                       | 의존 대상                             |
| ---- | ------------------------------------------ | ------------------------------------- |
| 1    | `src/news/types.ts`                        | `@finclaw/types`                      |
| 2    | `src/news/providers/newsapi.ts`            | types.ts, `@finclaw/infra`            |
| 3    | `src/news/providers/alpha-vantage-news.ts` | types.ts, `@finclaw/infra`            |
| 4    | `src/news/providers/rss.ts`                | types.ts, `feedsmith`                 |
| 5    | `src/news/aggregator.ts`                   | types.ts, providers                   |
| 6    | `src/news/analysis/sentiment.ts`           | `@finclaw/types`, `@anthropic-ai/sdk` |
| 7    | `src/news/analysis/market-analysis.ts`     | types.ts, `@anthropic-ai/sdk`, `zod`  |
| 8    | `src/news/portfolio/store.ts`              | `@finclaw/types`, `@finclaw/storage`  |
| 9    | `src/news/portfolio/tracker.ts`            | types.ts, store.ts, aggregator.ts     |
| 10   | `src/news/tools.ts`                        | `@finclaw/agent`, 위 모듈 전체        |
| 11   | `src/news/index.ts`                        | tools.ts, 진입점                      |

---

## 2. 파일별 전체 코드

### 2-1. `src/news/types.ts`

```typescript
// packages/skills-finance/src/news/types.ts
import type { NewsItem, NewsSentiment, TickerSymbol } from '@finclaw/types';

// re-export for convenience
export type { NewsItem, NewsSentiment, TickerSymbol };

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

/** 시장 분석 결과 */
export interface MarketAnalysis {
  readonly summary: string;
  readonly sentiment: NewsSentiment;
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

### 2-2. `src/news/providers/newsapi.ts`

```typescript
// packages/skills-finance/src/news/providers/newsapi.ts
import { safeFetchJson, retry } from '@finclaw/infra';
import { z } from 'zod/v4';
import { createHash } from 'node:crypto';
import type { NewsItem, TickerSymbol } from '@finclaw/types';
import type { NewsProvider, NewsQuery, NewsCategory } from '../types.js';

// ─── Zod 응답 스키마 ───

const NewsApiArticleSchema = z.object({
  title: z.string(),
  description: z.string().nullable(),
  url: z.string(),
  urlToImage: z.string().nullable().optional(),
  publishedAt: z.string(),
  source: z.object({ name: z.string() }),
});

const NewsApiResponseSchema = z.object({
  status: z.string(),
  totalResults: z.number(),
  articles: z.array(NewsApiArticleSchema),
});

type NewsApiArticle = z.infer<typeof NewsApiArticleSchema>;

// ─── 프로바이더 ───

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
        params.set('q', (query.symbols as readonly string[]).join(' OR '));
        params.set('domains', 'reuters.com,bloomberg.com,cnbc.com');
      } else if (query.keywords?.length) {
        params.set('q', query.keywords.join(' OR '));
      }

      if (query.fromDate) {
        params.set('from', query.fromDate.toISOString().split('T')[0]!);
      }

      const url = `${baseUrl}/everything?${params}`;
      const raw = await retry(() => safeFetchJson(url, { timeoutMs: 10_000 }), {
        maxAttempts: 2,
        shouldRetry: isTransientError,
      });

      const parsed = NewsApiResponseSchema.safeParse(raw);
      if (!parsed.success) {
        throw new Error(`NewsAPI response validation failed: ${parsed.error.message}`);
      }

      return parsed.data.articles.map(normalizeNewsApiArticle);
    },
  };
}

// ─── 내부 헬퍼 ───

function normalizeNewsApiArticle(article: NewsApiArticle): NewsItem {
  return {
    id: `newsapi-${hashUrl(article.url)}`,
    title: article.title,
    summary: article.description ?? undefined,
    url: article.url,
    source: 'newsapi',
    publishedAt: new Date(article.publishedAt).toISOString(),
    symbols: extractTickers(article.title + ' ' + (article.description ?? '')) as TickerSymbol[],
    imageUrl: article.urlToImage ?? undefined,
    categories: [inferCategory(article.title, article.description)],
  };
}

function hashUrl(url: string): string {
  return createHash('sha256').update(url).digest('hex').slice(0, 12);
}

/** 텍스트에서 $TICKER 패턴 추출 */
export function extractTickers(text: string): string[] {
  const matches = text.match(/\$([A-Z]{1,5})\b/g);
  if (!matches) return [];
  return [...new Set(matches.map((m) => m.slice(1)))];
}

/** 제목/본문에서 뉴스 카테고리 추론 */
export function inferCategory(title: string, description: string | null): NewsCategory {
  const text = (title + ' ' + (description ?? '')).toLowerCase();
  if (/\bearnings?\b|revenue|profit|eps\b/.test(text)) return 'earnings';
  if (/\bmerger|acquisition|takeover|buyout\b/.test(text)) return 'merger';
  if (/\bipo\b|initial public offering|debut/.test(text)) return 'ipo';
  if (/\bregulat|sec\b|compliance|antitrust/.test(text)) return 'regulation';
  if (/\bfed\b|interest rate|inflation|gdp|cpi\b|unemployment/.test(text)) return 'macro';
  if (/\bcrypto|bitcoin|ethereum|blockchain/.test(text)) return 'crypto';
  if (/\boil\b|gold|silver|commodity|crude/.test(text)) return 'commodity';
  return 'general';
}

function isTransientError(error: unknown): boolean {
  if (error instanceof Error && 'statusCode' in error) {
    const code = (error as { statusCode: number }).statusCode;
    return code === 429 || code >= 500;
  }
  return false;
}
```

### 2-3. `src/news/providers/alpha-vantage-news.ts`

```typescript
// packages/skills-finance/src/news/providers/alpha-vantage-news.ts
import { safeFetchJson, retry } from '@finclaw/infra';
import { z } from 'zod/v4';
import { createHash } from 'node:crypto';
import type { NewsItem, TickerSymbol, NewsSentiment } from '@finclaw/types';
import type { NewsProvider, NewsQuery } from '../types.js';

// ─── Zod 응답 스키마 ───

const AVNewsFeedItemSchema = z.object({
  title: z.string(),
  url: z.string(),
  summary: z.string().optional(),
  time_published: z.string(),
  source: z.string(),
  overall_sentiment_score: z.number().optional(),
  overall_sentiment_label: z.string().optional(),
  ticker_sentiment: z
    .array(
      z.object({
        ticker: z.string(),
        relevance_score: z.string(),
        ticker_sentiment_score: z.string(),
        ticker_sentiment_label: z.string(),
      }),
    )
    .optional(),
});

const AVNewsResponseSchema = z.object({
  feed: z.array(AVNewsFeedItemSchema).optional(),
  Information: z.string().optional(),
  Note: z.string().optional(),
});

type AVNewsFeedItem = z.infer<typeof AVNewsFeedItemSchema>;

// ─── 프로바이더 ───

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
        params.set('tickers', (query.symbols as readonly string[]).join(','));
      }

      if (query.keywords?.length) {
        params.set('topics', query.keywords.join(','));
      }

      const url = `https://www.alphavantage.co/query?${params}`;
      const raw = await retry(() => safeFetchJson(url, { timeoutMs: 10_000 }), {
        maxAttempts: 2,
        shouldRetry: isTransientError,
      });

      const parsed = AVNewsResponseSchema.safeParse(raw);
      if (!parsed.success) {
        throw new Error(`Alpha Vantage News response validation failed: ${parsed.error.message}`);
      }

      if (parsed.data.Note || parsed.data.Information) {
        throw new Error('Alpha Vantage API rate limit exceeded');
      }

      return (parsed.data.feed ?? []).map(normalizeAVNewsItem);
    },
  };
}

// ─── 내부 헬퍼 ───

function normalizeAVNewsItem(item: AVNewsFeedItem): NewsItem {
  const tickers = (item.ticker_sentiment ?? []).map((t) => t.ticker) as TickerSymbol[];

  return {
    id: `av-${hashUrl(item.url)}`,
    title: item.title,
    summary: item.summary,
    url: item.url,
    source: 'alpha-vantage',
    publishedAt: parseAVTimestamp(item.time_published),
    symbols: tickers.length > 0 ? tickers : undefined,
    sentiment:
      item.overall_sentiment_score != null
        ? normalizeSentiment(item.overall_sentiment_score)
        : undefined,
  };
}

/** Alpha Vantage 타임스탬프 "20250315T120000" → ISO 문자열 */
function parseAVTimestamp(ts: string): string {
  // Format: YYYYMMDDTHHMMSS
  const match = ts.match(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})$/);
  if (!match) return new Date().toISOString();
  const [, y, m, d, hh, mm, ss] = match;
  return new Date(`${y}-${m}-${d}T${hh}:${mm}:${ss}Z`).toISOString();
}

function normalizeSentiment(score: number): NewsSentiment {
  return {
    score,
    label: scoreToLabel(score),
    confidence: Math.min(Math.abs(score) + 0.3, 1),
  };
}

function scoreToLabel(score: number): NewsSentiment['label'] {
  if (score >= 0.35) return 'very_positive';
  if (score >= 0.15) return 'positive';
  if (score <= -0.35) return 'very_negative';
  if (score <= -0.15) return 'negative';
  return 'neutral';
}

function hashUrl(url: string): string {
  return createHash('sha256').update(url).digest('hex').slice(0, 12);
}

function isTransientError(error: unknown): boolean {
  if (error instanceof Error && 'statusCode' in error) {
    const code = (error as { statusCode: number }).statusCode;
    return code === 429 || code >= 500;
  }
  return false;
}
```

### 2-4. `src/news/providers/rss.ts`

```typescript
// packages/skills-finance/src/news/providers/rss.ts
import { safeFetch } from '@finclaw/infra';
import { createHash } from 'node:crypto';
import { parse as parseFeed } from 'feedsmith';
import type { NewsItem } from '@finclaw/types';
import type { NewsProvider, NewsQuery } from '../types.js';

const DEFAULT_FEEDS = [
  'https://feeds.finance.yahoo.com/rss/2.0/headline?s=^GSPC&region=US&lang=en-US',
  'https://www.investing.com/rss/news.rss',
];

export function createRssProvider(config?: { feedUrls?: string[] }): NewsProvider {
  const feedUrls = config?.feedUrls ?? DEFAULT_FEEDS;

  return {
    name: 'rss',
    isAvailable: () => true, // RSS는 항상 사용 가능

    async fetchNews(query: NewsQuery): Promise<NewsItem[]> {
      const limit = query.limit ?? 20;
      const results: NewsItem[] = [];

      const settled = await Promise.allSettled(feedUrls.map((url) => fetchAndParseFeed(url)));

      for (const result of settled) {
        if (result.status === 'fulfilled') {
          results.push(...result.value);
        }
      }

      // 날짜순 정렬 + limit 적용
      results.sort((a, b) => new Date(b.publishedAt).getTime() - new Date(a.publishedAt).getTime());

      // 키워드/심볼 필터링
      const filtered = filterByQuery(results, query);
      return filtered.slice(0, limit);
    },
  };
}

// ─── 내부 헬퍼 ───

async function fetchAndParseFeed(url: string): Promise<NewsItem[]> {
  const response = await safeFetch(url, { timeoutMs: 10_000 });
  const xml = await response.text();
  const feed = parseFeed(xml);

  if (!feed || !feed.items) return [];

  return feed.items.map(
    (item): NewsItem => ({
      id: `rss-${hashUrl(item.link ?? item.id ?? item.title ?? '')}`,
      title: item.title ?? '',
      summary: item.description ?? item.summary ?? undefined,
      url: item.link ?? '',
      source: 'rss',
      publishedAt: item.published
        ? new Date(item.published).toISOString()
        : new Date().toISOString(),
    }),
  );
}

function filterByQuery(items: NewsItem[], query: NewsQuery): NewsItem[] {
  if (!query.symbols?.length && !query.keywords?.length) return items;

  return items.filter((item) => {
    const text = (item.title + ' ' + (item.summary ?? '')).toLowerCase();

    if (query.symbols?.length) {
      const hasSymbol = query.symbols.some((s) => text.includes((s as string).toLowerCase()));
      if (hasSymbol) return true;
    }

    if (query.keywords?.length) {
      const hasKeyword = query.keywords.some((kw) => text.includes(kw.toLowerCase()));
      if (hasKeyword) return true;
    }

    return false;
  });
}

function hashUrl(url: string): string {
  return createHash('sha256').update(url).digest('hex').slice(0, 12);
}
```

> **참고**: `feedsmith`의 `parse()` API가 실제 버전과 다를 수 있다. 설치 후 `node_modules/feedsmith`의 타입을 확인하고 import 경로를 조정할 것. `feedsmith`가 named export가 아니라 default export라면 `import parseFeed from 'feedsmith'` 형태로 수정.

### 2-5. `src/news/aggregator.ts`

```typescript
// packages/skills-finance/src/news/aggregator.ts
import { createHash } from 'node:crypto';
import type { NewsItem } from '@finclaw/types';
import type { DatabaseSync } from 'node:sqlite';
import { getCachedData, setCachedData } from '@finclaw/storage';
import type { NewsAggregator, NewsProvider, NewsQuery, NewsSourceId } from './types.js';

const NEWS_CACHE_TTL = 300_000; // 5분

export function createNewsAggregator(deps: {
  providers: NewsProvider[];
  db?: DatabaseSync; // 캐시용 (선택)
}): NewsAggregator {
  const { providers, db } = deps;

  return {
    async fetchNews(query: NewsQuery): Promise<NewsItem[]> {
      // 캐시 확인
      if (db) {
        const cacheKey = buildCacheKey(query);
        const cached = getCachedData<NewsItem[]>(db, cacheKey);
        if (cached) return cached;
      }

      // 요청된 소스 필터링
      const activeProviders = providers.filter((p) => {
        if (!p.isAvailable()) return false;
        if (query.sources?.length) {
          return query.sources.includes(p.name);
        }
        return true;
      });

      // 병렬 수집 (Promise.allSettled로 개별 실패 허용)
      const settled = await Promise.allSettled(activeProviders.map((p) => p.fetchNews(query)));

      // 결과 병합
      const allItems: NewsItem[] = [];
      for (const result of settled) {
        if (result.status === 'fulfilled') {
          allItems.push(...result.value);
        }
        // rejected는 무시 (Graceful Degradation)
      }

      // URL 기반 중복 제거
      const deduped = deduplicateByUrl(allItems);

      // 날짜순 정렬 (최신 우선)
      deduped.sort((a, b) => new Date(b.publishedAt).getTime() - new Date(a.publishedAt).getTime());

      // limit 적용
      const limited = deduped.slice(0, query.limit ?? 20);

      // 캐시 저장
      if (db) {
        const cacheKey = buildCacheKey(query);
        setCachedData(db, cacheKey, limited, 'aggregator', NEWS_CACHE_TTL);
      }

      return limited;
    },
  };
}

// ─── 내부 헬퍼 ───

function deduplicateByUrl(items: NewsItem[]): NewsItem[] {
  const seen = new Set<string>();
  return items.filter((item) => {
    const hash = createHash('sha256').update(item.url).digest('hex').slice(0, 12);
    if (seen.has(hash)) return false;
    seen.add(hash);
    return true;
  });
}

function buildCacheKey(query: NewsQuery): string {
  const parts = [
    'news',
    query.symbols?.join(',') ?? '',
    query.keywords?.join(',') ?? '',
    query.category ?? '',
    String(query.limit ?? 20),
  ];
  return parts.join(':');
}
```

### 2-6. `src/news/analysis/sentiment.ts`

```typescript
// packages/skills-finance/src/news/analysis/sentiment.ts
import type Anthropic from '@anthropic-ai/sdk';
import { z } from 'zod/v4';
import type { NewsItem, NewsSentiment } from '@finclaw/types';

const LlmSentimentSchema = z.object({
  score: z.number().min(-1).max(1),
  label: z.enum(['very_negative', 'negative', 'neutral', 'positive', 'very_positive']),
  confidence: z.number().min(0).max(1),
});

/** 규칙 기반 + LLM 하이브리드 감성 분석 */
export async function analyzeSentiment(
  news: readonly NewsItem[],
  client?: Anthropic,
): Promise<NewsSentiment> {
  // 1단계: 규칙 기반 빠른 분석
  const ruleBasedScore = computeRuleBasedSentiment(news);

  // 2단계: LLM 사용 가능하면 정밀 분석
  if (client) {
    try {
      return await computeLlmSentiment(client, news, ruleBasedScore);
    } catch {
      // LLM 실패 시 규칙 기반 폴백
    }
  }

  return {
    score: ruleBasedScore,
    label: scoreToLabel(ruleBasedScore),
    confidence: 0.6,
  };
}

// ─── 규칙 기반 ───

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

export function computeRuleBasedSentiment(news: readonly NewsItem[]): number {
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

/** 5단계 감성 라벨 */
export function scoreToLabel(score: number): NewsSentiment['label'] {
  if (score >= 0.6) return 'very_positive';
  if (score >= 0.2) return 'positive';
  if (score <= -0.6) return 'very_negative';
  if (score <= -0.2) return 'negative';
  return 'neutral';
}

// ─── LLM 기반 ───

async function computeLlmSentiment(
  client: Anthropic,
  news: readonly NewsItem[],
  ruleBasedHint: number,
): Promise<NewsSentiment> {
  const digest = news
    .slice(0, 15)
    .map((item) => `- ${item.title}`)
    .join('\n');

  const message = await client.messages.create({
    model: 'claude-sonnet-4-20250514',
    max_tokens: 200,
    system: `You are a financial sentiment analyzer. Analyze news headlines and return JSON: {"score": -1.0~1.0, "label": "very_negative|negative|neutral|positive|very_positive", "confidence": 0.0~1.0}. Rule-based hint score: ${ruleBasedHint.toFixed(2)}.`,
    messages: [{ role: 'user', content: `Analyze sentiment of these headlines:\n${digest}` }],
  });

  const text = message.content[0]?.type === 'text' ? message.content[0].text : '';
  const parsed = LlmSentimentSchema.safeParse(JSON.parse(text));
  if (!parsed.success) {
    throw new Error(`LLM sentiment validation failed: ${parsed.error.message}`);
  }

  return parsed.data;
}
```

### 2-7. `src/news/analysis/market-analysis.ts`

```typescript
// packages/skills-finance/src/news/analysis/market-analysis.ts
import type Anthropic from '@anthropic-ai/sdk';
import { z } from 'zod/v4';
import type { NewsItem } from '@finclaw/types';
import type { MarketAnalysis, AnalysisOptions } from '../types.js';

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

// ─── 프롬프트 빌더 ───

function buildAnalysisSystemPrompt(depth: string, language: string): string {
  const langInstruction =
    language === 'ko' ? '한국어로 분석 결과를 작성하세요.' : 'Write analysis results in English.';

  const depthInstruction =
    depth === 'brief'
      ? 'Be concise, 1-2 sentences per field.'
      : depth === 'detailed'
        ? 'Provide thorough analysis with multiple paragraphs for summary.'
        : 'Provide a balanced, moderate-length analysis.';

  return `You are a professional financial market analyst. Analyze the provided news articles and generate a market analysis report.
${langInstruction}
${depthInstruction}

Response format (strict JSON, no markdown):
{
  "summary": "시장 전망 요약",
  "sentiment": { "score": -1.0~1.0, "label": "very_negative|negative|neutral|positive|very_positive", "confidence": 0.0~1.0 },
  "keyFactors": ["핵심 요인 1", "핵심 요인 2"],
  "risks": ["리스크 1"],
  "opportunities": ["기회 1"]
}`;
}

function buildAnalysisUserPrompt(
  newsDigest: string,
  symbols?: readonly import('@finclaw/types').TickerSymbol[],
  includeIndicators?: boolean,
): string {
  let prompt = `Analyze the following financial news:\n\n${newsDigest}`;

  if (symbols?.length) {
    prompt += `\n\nFocus especially on these symbols: ${(symbols as readonly string[]).join(', ')}`;
  }

  if (includeIndicators) {
    prompt += '\n\nInclude technical indicator interpretation in your analysis if relevant.';
  }

  return prompt;
}
```

### 2-8. `src/news/portfolio/store.ts`

```typescript
// packages/skills-finance/src/news/portfolio/store.ts
import type { DatabaseSync } from 'node:sqlite';
import type { Portfolio, PortfolioHolding, TickerSymbol, CurrencyCode } from '@finclaw/types';

/** 포트폴리오 CRUD (SQLite) */
export class PortfolioStore {
  constructor(private readonly db: DatabaseSync) {}

  /** 포트폴리오 조회 */
  getPortfolio(id: string): Portfolio | null {
    const row = this.db
      .prepare('SELECT id, name, currency, updated_at FROM portfolios WHERE id = ?')
      .get(id) as { id: string; name: string; currency: string; updated_at: number } | undefined;

    if (!row) return null;

    const holdings = this.getHoldings(id);

    return {
      id: row.id,
      name: row.name,
      holdings,
      currency: row.currency as CurrencyCode,
      updatedAt: new Date(row.updated_at).toISOString(),
    };
  }

  /** 모든 포트폴리오 목록 */
  listPortfolios(): Portfolio[] {
    const rows = this.db
      .prepare('SELECT id, name, currency, updated_at FROM portfolios ORDER BY updated_at DESC')
      .all() as Array<{ id: string; name: string; currency: string; updated_at: number }>;

    return rows.map((row) => ({
      id: row.id,
      name: row.name,
      holdings: this.getHoldings(row.id),
      currency: row.currency as CurrencyCode,
      updatedAt: new Date(row.updated_at).toISOString(),
    }));
  }

  /** 포트폴리오 생성/갱신 */
  upsertPortfolio(portfolio: Pick<Portfolio, 'id' | 'name' | 'currency'>): void {
    this.db
      .prepare(
        `INSERT INTO portfolios (id, name, currency, updated_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           name = excluded.name,
           currency = excluded.currency,
           updated_at = excluded.updated_at`,
      )
      .run(portfolio.id, portfolio.name, portfolio.currency as string, Date.now());
  }

  /** 포트폴리오 삭제 (CASCADE로 holdings도 삭제) */
  deletePortfolio(id: string): boolean {
    const result = this.db.prepare('DELETE FROM portfolios WHERE id = ?').run(id);
    return Number(result.changes) > 0;
  }

  /** 보유 종목 추가/갱신 */
  upsertHolding(
    portfolioId: string,
    holding: Pick<PortfolioHolding, 'symbol' | 'quantity' | 'averageCost'>,
  ): void {
    this.db
      .prepare(
        `INSERT INTO portfolio_holdings (portfolio_id, symbol, quantity, average_cost)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(portfolio_id, symbol) DO UPDATE SET
           quantity = excluded.quantity,
           average_cost = excluded.average_cost`,
      )
      .run(portfolioId, holding.symbol as string, holding.quantity, holding.averageCost);

    // updated_at 갱신
    this.db
      .prepare('UPDATE portfolios SET updated_at = ? WHERE id = ?')
      .run(Date.now(), portfolioId);
  }

  /** 보유 종목 제거 */
  removeHolding(portfolioId: string, symbol: TickerSymbol): boolean {
    const result = this.db
      .prepare('DELETE FROM portfolio_holdings WHERE portfolio_id = ? AND symbol = ?')
      .run(portfolioId, symbol as string);
    return Number(result.changes) > 0;
  }

  // ─── 내부 헬퍼 ───

  private getHoldings(portfolioId: string): PortfolioHolding[] {
    const rows = this.db
      .prepare(
        'SELECT symbol, quantity, average_cost FROM portfolio_holdings WHERE portfolio_id = ?',
      )
      .all(portfolioId) as Array<{ symbol: string; quantity: number; average_cost: number }>;

    return rows.map((r) => ({
      symbol: r.symbol as TickerSymbol,
      quantity: r.quantity,
      averageCost: r.average_cost,
    }));
  }
}
```

### 2-9. `src/news/portfolio/tracker.ts`

```typescript
// packages/skills-finance/src/news/portfolio/tracker.ts
import type { Portfolio, PortfolioHolding, PortfolioSummary } from '@finclaw/types';
import type { NewsAggregator } from '../types.js';

/** Phase 16 시세 조회 어댑터 인터페이스 */
export interface QuoteService {
  getQuote(symbol: string): Promise<{ price: number; change: number; changePercent: number }>;
}

export function createPortfolioTracker(deps: {
  quoteService: QuoteService;
  newsAggregator: NewsAggregator;
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
            weight: 0, // 아래에서 재계산
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
      const valuated = await this.valuate(portfolio);

      const sorted = [...valuated.holdings].sort(
        (a, b) => (b.pnlPercent ?? 0) - (a.pnlPercent ?? 0),
      );
      const topGainers = sorted.slice(0, 3);
      const topLosers = sorted.slice(-3).reverse();

      // dailyChange 집계
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

### 2-10. `src/news/tools.ts`

```typescript
// packages/skills-finance/src/news/tools.ts
import type { RegisteredToolDefinition, ToolExecutor, ToolRegistry } from '@finclaw/agent';
import type Anthropic from '@anthropic-ai/sdk';
import type { TickerSymbol } from '@finclaw/types';
import type { NewsAggregator, AnalysisOptions } from './types.js';
import type { PortfolioStore } from './portfolio/store.js';
import { analyzeMarket } from './analysis/market-analysis.js';
import { createPortfolioTracker, type QuoteService } from './portfolio/tracker.js';

// ─── get_financial_news ───

export function registerGetFinancialNewsTool(
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
          description: '종목 코드 목록 (예: ["AAPL", "GOOGL"])',
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
        symbols: input.symbols as TickerSymbol[] | undefined,
        keywords: input.keywords as string[] | undefined,
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

// ─── analyze_market ───

export function registerAnalyzeMarketTool(
  registry: ToolRegistry,
  deps: { newsAggregator: NewsAggregator; client: Anthropic },
): void {
  const def: RegisteredToolDefinition = {
    name: 'analyze_market',
    description:
      'AI 기반 시장 분석을 수행합니다. 뉴스를 종합하여 시장 전망, 감성 분석, 리스크/기회를 제공합니다.',
    inputSchema: {
      type: 'object',
      properties: {
        symbols: {
          type: 'array',
          items: { type: 'string' },
          description: '분석할 종목 코드 (예: ["AAPL"])',
        },
        depth: {
          type: 'string',
          enum: ['brief', 'standard', 'detailed'],
          description: '분석 깊이 (기본: standard)',
        },
        language: {
          type: 'string',
          enum: ['ko', 'en'],
          description: '분석 언어 (기본: ko)',
        },
      },
      required: [],
    },
    group: 'finance',
    requiresApproval: false,
    isTransactional: false,
    accessesSensitiveData: false,
    isExternal: true,
    timeoutMs: 30_000,
  };

  const executor: ToolExecutor = async (input) => {
    try {
      const symbols = input.symbols as TickerSymbol[] | undefined;
      const options: AnalysisOptions = {
        symbols,
        depth: (input.depth as AnalysisOptions['depth']) ?? 'standard',
        language: (input.language as AnalysisOptions['language']) ?? 'ko',
      };

      const news = await deps.newsAggregator.fetchNews({ symbols, limit: 30 });
      if (news.length === 0) {
        return { content: '분석할 뉴스가 없습니다.', isError: false };
      }

      const analysis = await analyzeMarket(deps.client, news, options);
      return { content: JSON.stringify(analysis), isError: false };
    } catch (error) {
      return { content: error instanceof Error ? error.message : String(error), isError: true };
    }
  };

  registry.register(def, executor, 'skill');
}

// ─── get_portfolio_summary ───

export function registerGetPortfolioSummaryTool(
  registry: ToolRegistry,
  deps: {
    portfolioStore: PortfolioStore;
    quoteService: QuoteService;
    newsAggregator: NewsAggregator;
  },
): void {
  const def: RegisteredToolDefinition = {
    name: 'get_portfolio_summary',
    description:
      '포트폴리오 종합 요약을 제공합니다. 현재가 기반 P&L, 상위 수익/손실 종목, 일일 변동을 포함합니다.',
    inputSchema: {
      type: 'object',
      properties: {
        portfolioId: {
          type: 'string',
          description: '포트폴리오 ID',
        },
      },
      required: ['portfolioId'],
    },
    group: 'finance',
    requiresApproval: false,
    isTransactional: false,
    accessesSensitiveData: true,
    isExternal: true,
    timeoutMs: 20_000,
  };

  const executor: ToolExecutor = async (input) => {
    try {
      const portfolioId = input.portfolioId as string;
      const portfolio = deps.portfolioStore.getPortfolio(portfolioId);
      if (!portfolio) {
        return { content: `포트폴리오를 찾을 수 없습니다: ${portfolioId}`, isError: true };
      }

      const tracker = createPortfolioTracker({
        quoteService: deps.quoteService,
        newsAggregator: deps.newsAggregator,
      });

      const summary = await tracker.summarize(portfolio);
      return { content: JSON.stringify(summary), isError: false };
    } catch (error) {
      return { content: error instanceof Error ? error.message : String(error), isError: true };
    }
  };

  registry.register(def, executor, 'skill');
}
```

### 2-11. `src/news/index.ts`

```typescript
// packages/skills-finance/src/news/index.ts
import type { ToolRegistry } from '@finclaw/agent';
import type { DatabaseSync } from 'node:sqlite';
import Anthropic from '@anthropic-ai/sdk';
import { createNewsApiProvider } from './providers/newsapi.js';
import { createAlphaVantageNewsProvider } from './providers/alpha-vantage-news.js';
import { createRssProvider } from './providers/rss.js';
import { createNewsAggregator } from './aggregator.js';
import { PortfolioStore } from './portfolio/store.js';
import {
  registerGetFinancialNewsTool,
  registerAnalyzeMarketTool,
  registerGetPortfolioSummaryTool,
} from './tools.js';
import type { NewsProvider, QuoteService } from './types.js';

export type { NewsAggregator, NewsQuery, NewsProvider, NewsSourceId } from './types.js';
export type { QuoteService } from './portfolio/tracker.js';

/** 스킬 초기화에 필요한 설정 */
export interface NewsSkillConfig {
  readonly db: DatabaseSync;
  readonly newsApiKey?: string;
  readonly alphaVantageKey?: string;
  readonly rssFeedUrls?: string[];
  readonly anthropicApiKey?: string;
  readonly quoteService: QuoteService;
}

/** 스킬을 초기화하고 도구를 등록한다 */
export async function registerNewsTools(
  registry: ToolRegistry,
  config: NewsSkillConfig,
): Promise<void> {
  // 프로바이더 초기화
  const providers: NewsProvider[] = [];

  if (config.newsApiKey) {
    providers.push(createNewsApiProvider({ apiKey: config.newsApiKey }));
  }

  if (config.alphaVantageKey) {
    providers.push(createAlphaVantageNewsProvider({ apiKey: config.alphaVantageKey }));
  }

  providers.push(createRssProvider({ feedUrls: config.rssFeedUrls }));

  // 어그리게이터
  const newsAggregator = createNewsAggregator({ providers, db: config.db });

  // 도구 등록: get_financial_news
  registerGetFinancialNewsTool(registry, { newsAggregator });

  // 도구 등록: analyze_market (Anthropic API 키가 있을 때만)
  if (config.anthropicApiKey) {
    const client = new Anthropic({ apiKey: config.anthropicApiKey });
    registerAnalyzeMarketTool(registry, { newsAggregator, client });
  }

  // 도구 등록: get_portfolio_summary
  const portfolioStore = new PortfolioStore(config.db);
  registerGetPortfolioSummaryTool(registry, {
    portfolioStore,
    quoteService: config.quoteService,
    newsAggregator,
  });
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

## 3. 테스트 코드

### 3-1. `src/news/providers/__tests__/newsapi.test.ts`

```typescript
// packages/skills-finance/src/news/providers/__tests__/newsapi.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createNewsApiProvider, extractTickers, inferCategory } from '../newsapi.js';

vi.mock('@finclaw/infra', () => ({
  safeFetchJson: vi.fn(),
  retry: vi.fn((fn: () => Promise<unknown>) => fn()),
}));

import { safeFetchJson } from '@finclaw/infra';
const mockFetch = vi.mocked(safeFetchJson);

describe('NewsAPI Provider', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('isAvailable', () => {
    it('API 키가 있으면 true', () => {
      const provider = createNewsApiProvider({ apiKey: 'test-key' });
      expect(provider.isAvailable()).toBe(true);
    });

    it('API 키가 빈 문자열이면 false', () => {
      const provider = createNewsApiProvider({ apiKey: '' });
      expect(provider.isAvailable()).toBe(false);
    });
  });

  describe('fetchNews', () => {
    it('정상 응답을 NewsItem[]으로 정규화한다', async () => {
      const provider = createNewsApiProvider({ apiKey: 'test-key' });
      mockFetch.mockResolvedValueOnce({
        status: 'ok',
        totalResults: 1,
        articles: [
          {
            title: 'Apple $AAPL beats earnings',
            description: 'Revenue up 15%',
            url: 'https://example.com/article1',
            urlToImage: 'https://example.com/img.jpg',
            publishedAt: '2026-03-15T10:00:00Z',
            source: { name: 'Reuters' },
          },
        ],
      });

      const result = await provider.fetchNews({ limit: 10 });

      expect(result).toHaveLength(1);
      expect(result[0]!.title).toBe('Apple $AAPL beats earnings');
      expect(result[0]!.summary).toBe('Revenue up 15%');
      expect(result[0]!.source).toBe('newsapi');
      expect(result[0]!.id).toMatch(/^newsapi-/);
    });

    it('잘못된 응답 형식이면 에러를 던진다', async () => {
      const provider = createNewsApiProvider({ apiKey: 'test-key' });
      mockFetch.mockResolvedValueOnce({ unexpected: 'data' });

      await expect(provider.fetchNews({})).rejects.toThrow('validation failed');
    });

    it('description이 null이면 summary는 undefined', async () => {
      const provider = createNewsApiProvider({ apiKey: 'test-key' });
      mockFetch.mockResolvedValueOnce({
        status: 'ok',
        totalResults: 1,
        articles: [
          {
            title: 'Test',
            description: null,
            url: 'https://example.com/a',
            publishedAt: '2026-03-15T10:00:00Z',
            source: { name: 'Test' },
          },
        ],
      });

      const result = await provider.fetchNews({});
      expect(result[0]!.summary).toBeUndefined();
    });
  });

  describe('extractTickers', () => {
    it('$TICKER 패턴을 추출한다', () => {
      expect(extractTickers('$AAPL and $GOOGL are up')).toEqual(['AAPL', 'GOOGL']);
    });

    it('중복 티커를 제거한다', () => {
      expect(extractTickers('$AAPL $AAPL $AAPL')).toEqual(['AAPL']);
    });

    it('패턴이 없으면 빈 배열을 반환한다', () => {
      expect(extractTickers('no tickers here')).toEqual([]);
    });
  });

  describe('inferCategory', () => {
    it('earnings 관련 키워드를 감지한다', () => {
      expect(inferCategory('Q3 Earnings Beat Expectations', null)).toBe('earnings');
    });

    it('crypto 관련 키워드를 감지한다', () => {
      expect(inferCategory('Bitcoin hits new high', null)).toBe('crypto');
    });

    it('매칭 없으면 general을 반환한다', () => {
      expect(inferCategory('Random headline', null)).toBe('general');
    });
  });
});
```

### 3-2. `src/news/providers/__tests__/alpha-vantage-news.test.ts`

```typescript
// packages/skills-finance/src/news/providers/__tests__/alpha-vantage-news.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createAlphaVantageNewsProvider } from '../alpha-vantage-news.js';

vi.mock('@finclaw/infra', () => ({
  safeFetchJson: vi.fn(),
  retry: vi.fn((fn: () => Promise<unknown>) => fn()),
}));

import { safeFetchJson } from '@finclaw/infra';
const mockFetch = vi.mocked(safeFetchJson);

describe('AlphaVantageNews Provider', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('isAvailable', () => {
    it('API 키가 있으면 true', () => {
      const provider = createAlphaVantageNewsProvider({ apiKey: 'test-key' });
      expect(provider.isAvailable()).toBe(true);
    });

    it('API 키가 빈 문자열이면 false', () => {
      const provider = createAlphaVantageNewsProvider({ apiKey: '' });
      expect(provider.isAvailable()).toBe(false);
    });
  });

  describe('fetchNews', () => {
    it('정상 응답을 NewsItem[]으로 정규화한다', async () => {
      const provider = createAlphaVantageNewsProvider({ apiKey: 'test-key' });
      mockFetch.mockResolvedValueOnce({
        feed: [
          {
            title: 'AAPL surges on earnings',
            url: 'https://example.com/av1',
            summary: 'Strong quarter results',
            time_published: '20260315T100000',
            source: 'Reuters',
            overall_sentiment_score: 0.45,
            overall_sentiment_label: 'Bullish',
            ticker_sentiment: [
              {
                ticker: 'AAPL',
                relevance_score: '0.95',
                ticker_sentiment_score: '0.50',
                ticker_sentiment_label: 'Bullish',
              },
            ],
          },
        ],
      });

      const result = await provider.fetchNews({ limit: 10 });

      expect(result).toHaveLength(1);
      expect(result[0]!.source).toBe('alpha-vantage');
      expect(result[0]!.id).toMatch(/^av-/);
      expect(result[0]!.symbols).toEqual(['AAPL']);
      expect(result[0]!.sentiment).toBeDefined();
      expect(result[0]!.sentiment!.label).toBe('very_positive');
    });

    it('rate limit 응답 시 에러를 던진다', async () => {
      const provider = createAlphaVantageNewsProvider({ apiKey: 'test-key' });
      mockFetch.mockResolvedValueOnce({
        Note: 'API rate limit exceeded',
      });

      await expect(provider.fetchNews({})).rejects.toThrow('rate limit');
    });

    it('feed가 없으면 빈 배열을 반환한다', async () => {
      const provider = createAlphaVantageNewsProvider({ apiKey: 'test-key' });
      mockFetch.mockResolvedValueOnce({});

      const result = await provider.fetchNews({});
      expect(result).toEqual([]);
    });

    it('sentiment 없는 뉴스도 처리한다', async () => {
      const provider = createAlphaVantageNewsProvider({ apiKey: 'test-key' });
      mockFetch.mockResolvedValueOnce({
        feed: [
          {
            title: 'Some news',
            url: 'https://example.com/av2',
            time_published: '20260315T120000',
            source: 'Test',
          },
        ],
      });

      const result = await provider.fetchNews({});
      expect(result[0]!.sentiment).toBeUndefined();
    });
  });
});
```

### 3-3. `src/news/analysis/__tests__/sentiment.test.ts`

```typescript
// packages/skills-finance/src/news/analysis/__tests__/sentiment.test.ts
import { describe, it, expect } from 'vitest';
import { computeRuleBasedSentiment, scoreToLabel, analyzeSentiment } from '../sentiment.js';
import type { NewsItem } from '@finclaw/types';

function makeNews(titles: string[]): NewsItem[] {
  return titles.map((title, i) => ({
    id: `test-${i}`,
    title,
    url: `https://example.com/${i}`,
    source: 'test',
    publishedAt: new Date().toISOString(),
  }));
}

describe('sentiment', () => {
  describe('computeRuleBasedSentiment', () => {
    it('긍정 키워드만 있으면 양수를 반환한다', () => {
      const news = makeNews(['Market surge continues', 'Bullish rally ahead']);
      const score = computeRuleBasedSentiment(news);
      expect(score).toBeGreaterThan(0);
    });

    it('부정 키워드만 있으면 음수를 반환한다', () => {
      const news = makeNews(['Market crash deepens', 'Bear market confirmed']);
      const score = computeRuleBasedSentiment(news);
      expect(score).toBeLessThan(0);
    });

    it('키워드가 없으면 0을 반환한다', () => {
      const news = makeNews(['Nothing special happened today']);
      const score = computeRuleBasedSentiment(news);
      expect(score).toBe(0);
    });

    it('한국어 키워드도 감지한다', () => {
      const news = makeNews(['코스피 급등, 삼성전자 상승']);
      const score = computeRuleBasedSentiment(news);
      expect(score).toBeGreaterThan(0);
    });

    it('긍정/부정 균형이면 0에 가깝다', () => {
      const news = makeNews(['Market surge then crash']);
      const score = computeRuleBasedSentiment(news);
      expect(Math.abs(score)).toBeLessThanOrEqual(0.5);
    });
  });

  describe('scoreToLabel', () => {
    it('0.6 이상이면 very_positive', () => {
      expect(scoreToLabel(0.8)).toBe('very_positive');
    });

    it('0.2~0.6이면 positive', () => {
      expect(scoreToLabel(0.4)).toBe('positive');
    });

    it('-0.2~0.2이면 neutral', () => {
      expect(scoreToLabel(0)).toBe('neutral');
      expect(scoreToLabel(0.1)).toBe('neutral');
    });

    it('-0.6~-0.2이면 negative', () => {
      expect(scoreToLabel(-0.3)).toBe('negative');
    });

    it('-0.6 이하이면 very_negative', () => {
      expect(scoreToLabel(-0.8)).toBe('very_negative');
    });
  });

  describe('analyzeSentiment', () => {
    it('LLM 없이 규칙 기반 결과를 반환한다', async () => {
      const news = makeNews(['Stock surge', 'Bull rally']);
      const result = await analyzeSentiment(news);

      expect(result.score).toBeGreaterThan(0);
      expect(result.confidence).toBe(0.6);
      expect(['positive', 'very_positive']).toContain(result.label);
    });
  });
});
```

### 3-4. `src/news/portfolio/__tests__/tracker.test.ts`

```typescript
// packages/skills-finance/src/news/portfolio/__tests__/tracker.test.ts
import { describe, it, expect, vi } from 'vitest';
import { createPortfolioTracker, type QuoteService } from '../tracker.js';
import type { Portfolio, TickerSymbol, CurrencyCode } from '@finclaw/types';
import type { NewsAggregator } from '../../types.js';

function makePortfolio(
  holdings: Array<{ symbol: string; quantity: number; averageCost: number }>,
): Portfolio {
  return {
    id: 'test-portfolio',
    name: 'Test',
    holdings: holdings.map((h) => ({
      symbol: h.symbol as TickerSymbol,
      quantity: h.quantity,
      averageCost: h.averageCost,
    })),
    currency: 'USD' as CurrencyCode,
    updatedAt: new Date().toISOString(),
  };
}

function makeQuoteService(
  prices: Record<string, { price: number; change: number; changePercent: number }>,
): QuoteService {
  return {
    async getQuote(symbol: string) {
      return prices[symbol] ?? { price: 0, change: 0, changePercent: 0 };
    },
  };
}

const mockAggregator: NewsAggregator = {
  async fetchNews() {
    return [];
  },
};

describe('PortfolioTracker', () => {
  describe('valuate', () => {
    it('현재가 기반 P&L을 정확히 계산한다', async () => {
      const tracker = createPortfolioTracker({
        quoteService: makeQuoteService({
          AAPL: { price: 200, change: 5, changePercent: 2.5 },
        }),
        newsAggregator: mockAggregator,
      });

      const portfolio = makePortfolio([{ symbol: 'AAPL', quantity: 10, averageCost: 150 }]);

      const result = await tracker.valuate(portfolio);

      expect(result.totalValue).toBe(2000); // 10 * 200
      expect(result.totalCost).toBe(1500); // 10 * 150
      expect(result.totalPnL).toBe(500);
      expect(result.totalPnLPercent).toBeCloseTo(33.33, 1);
      expect(result.holdings[0]!.currentPrice).toBe(200);
      expect(result.holdings[0]!.marketValue).toBe(2000);
      expect(result.holdings[0]!.pnl).toBe(500);
    });

    it('다수 종목의 비중을 정확히 계산한다', async () => {
      const tracker = createPortfolioTracker({
        quoteService: makeQuoteService({
          AAPL: { price: 200, change: 0, changePercent: 0 },
          GOOGL: { price: 100, change: 0, changePercent: 0 },
        }),
        newsAggregator: mockAggregator,
      });

      const portfolio = makePortfolio([
        { symbol: 'AAPL', quantity: 10, averageCost: 150 }, // 2000
        { symbol: 'GOOGL', quantity: 30, averageCost: 80 }, // 3000
      ]);

      const result = await tracker.valuate(portfolio);

      expect(result.totalValue).toBe(5000);
      expect(result.holdings[0]!.weight).toBeCloseTo(0.4, 2); // 2000/5000
      expect(result.holdings[1]!.weight).toBeCloseTo(0.6, 2); // 3000/5000
    });

    it('빈 포트폴리오를 처리한다', async () => {
      const tracker = createPortfolioTracker({
        quoteService: makeQuoteService({}),
        newsAggregator: mockAggregator,
      });

      const portfolio = makePortfolio([]);
      const result = await tracker.valuate(portfolio);

      expect(result.totalValue).toBe(0);
      expect(result.totalPnL).toBe(0);
    });
  });

  describe('summarize', () => {
    it('topGainers와 topLosers를 정확히 분리한다', async () => {
      const tracker = createPortfolioTracker({
        quoteService: makeQuoteService({
          A: { price: 200, change: 10, changePercent: 5 }, // +100% PnL
          B: { price: 80, change: -5, changePercent: -6 }, // -20% PnL
          C: { price: 150, change: 3, changePercent: 2 }, // +50% PnL
          D: { price: 50, change: -2, changePercent: -4 }, // -50% PnL
          E: { price: 110, change: 1, changePercent: 1 }, // +10% PnL
        }),
        newsAggregator: mockAggregator,
      });

      const portfolio = makePortfolio([
        { symbol: 'A', quantity: 10, averageCost: 100 },
        { symbol: 'B', quantity: 10, averageCost: 100 },
        { symbol: 'C', quantity: 10, averageCost: 100 },
        { symbol: 'D', quantity: 10, averageCost: 100 },
        { symbol: 'E', quantity: 10, averageCost: 100 },
      ]);

      const summary = await tracker.summarize(portfolio);

      // topGainers: A(+100%), C(+50%), E(+10%)
      expect(summary.topGainers).toHaveLength(3);
      expect(summary.topGainers[0]!.symbol).toBe('A');

      // topLosers: D(-50%), B(-20%) — reversed, so D first
      expect(summary.topLosers).toHaveLength(3);
      expect(summary.topLosers[0]!.symbol).toBe('D');
    });

    it('dailyChange를 정확히 집계한다', async () => {
      const tracker = createPortfolioTracker({
        quoteService: makeQuoteService({
          AAPL: { price: 200, change: 5, changePercent: 2.5 },
          GOOGL: { price: 100, change: -3, changePercent: -3 },
        }),
        newsAggregator: mockAggregator,
      });

      const portfolio = makePortfolio([
        { symbol: 'AAPL', quantity: 10, averageCost: 150 },
        { symbol: 'GOOGL', quantity: 20, averageCost: 80 },
      ]);

      const summary = await tracker.summarize(portfolio);

      // dailyChange = 10*5 + 20*(-3) = 50 - 60 = -10
      expect(summary.dailyChange).toBe(-10);
    });
  });
});
```

---

## 4. barrel export 수정

### `src/index.ts`

기존:

```typescript
export { registerMarketTools, MARKET_SKILL_METADATA } from './market/index.js';
export type { MarketSkillConfig } from './market/index.js';
```

추가:

```typescript
export { registerNewsTools, NEWS_SKILL_METADATA } from './news/index.js';
export type { NewsSkillConfig } from './news/index.js';
```

---

## 5. 스키마 마이그레이션 상세

`packages/storage/src/database.ts`에서:

1. `SCHEMA_VERSION`을 `1` → `2`로 변경
2. `SCHEMA_DDL` 끝에 portfolios + portfolio_holdings CREATE TABLE 추가
3. `MIGRATIONS` 객체에 key `2` 추가 (위 0-4 참조)

---

## 6. 검증 체크리스트

```bash
# 1. 의존성 설치
cd packages/skills-finance && pnpm add @anthropic-ai/sdk@^0.78.0 feedsmith@^3.0.0

# 2. 전체 빌드
pnpm tsc --build

# 3. 뉴스 스킬 테스트
cd packages/skills-finance && pnpm vitest run src/news/

# 4. 포맷 정리
pnpm format:fix

# 5. lint
pnpm oxlint
```

### 예상 테스트 결과

```
✓ providers/__tests__/newsapi.test.ts (9 tests)
✓ providers/__tests__/alpha-vantage-news.test.ts (5 tests)
✓ analysis/__tests__/sentiment.test.ts (8 tests)
✓ portfolio/__tests__/tracker.test.ts (7 tests)
Total: 29 tests passed
```

### 수동 확인 항목

- [ ] 모든 프로바이더가 `safeFetchJson` + `retry` 사용 (raw `fetch()` 없음)
- [ ] 모든 executor가 try-catch 래핑 + `{ content, isError }` 반환
- [ ] `@finclaw/types`의 타입을 재정의하지 않고 import만 사용
- [ ] Zod v4 `safeParse`로 외부 API 응답 검증 (`as` 캐스트 금지)
- [ ] `NewsAggregator` 인터페이스가 `src/news/types.ts`에서 export (Phase 18 호환)
- [ ] `feedsmith` import 경로가 실제 패키지 export와 일치하는지 확인
