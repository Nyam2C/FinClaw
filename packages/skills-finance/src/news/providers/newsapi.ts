import type { NewsItem, TickerSymbol } from '@finclaw/types';
// packages/skills-finance/src/news/providers/newsapi.ts
import { safeFetchJson, retry } from '@finclaw/infra';
import { createTimestamp } from '@finclaw/types';
import { createHash } from 'node:crypto';
import { z } from 'zod/v4';
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
        params.set('from', query.fromDate.toISOString().split('T')[0] ?? '');
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
    publishedAt: createTimestamp(new Date(article.publishedAt).getTime()),
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
  if (!matches) {
    return [];
  }
  return [...new Set(matches.map((m) => m.slice(1)))];
}

/** 제목/본문에서 뉴스 카테고리 추론 */
export function inferCategory(title: string, description: string | null): NewsCategory {
  const text = (title + ' ' + (description ?? '')).toLowerCase();
  if (/\bearnings?\b|revenue|profit|eps\b/.test(text)) {
    return 'earnings';
  }
  if (/\bmerger|acquisition|takeover|buyout\b/.test(text)) {
    return 'merger';
  }
  if (/\bipo\b|initial public offering|debut/.test(text)) {
    return 'ipo';
  }
  if (/\bregulat|sec\b|compliance|antitrust/.test(text)) {
    return 'regulation';
  }
  if (/\bfed\b|interest rate|inflation|gdp|cpi\b|unemployment/.test(text)) {
    return 'macro';
  }
  if (/\bcrypto|bitcoin|ethereum|blockchain/.test(text)) {
    return 'crypto';
  }
  if (/\boil\b|gold|silver|commodity|crude/.test(text)) {
    return 'commodity';
  }
  return 'general';
}

function isTransientError(error: unknown): boolean {
  if (error instanceof Error && 'statusCode' in error) {
    const code = (error as { statusCode: number }).statusCode;
    return code === 429 || code >= 500;
  }
  return false;
}
