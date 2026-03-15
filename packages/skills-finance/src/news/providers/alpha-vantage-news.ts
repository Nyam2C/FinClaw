import type { NewsItem, TickerSymbol, NewsSentiment, Timestamp } from '@finclaw/types';
// packages/skills-finance/src/news/providers/alpha-vantage-news.ts
import { safeFetchJson, retry } from '@finclaw/infra';
import { createTimestamp } from '@finclaw/types';
import { createHash } from 'node:crypto';
import { z } from 'zod/v4';
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

/** Alpha Vantage 타임스탬프 "20250315T120000" → Timestamp */
function parseAVTimestamp(ts: string): Timestamp {
  // Format: YYYYMMDDTHHMMSS
  const match = ts.match(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})$/);
  if (!match) {
    return createTimestamp(Date.now());
  }
  const [, y, m, d, hh, mm, ss] = match;
  return createTimestamp(new Date(`${y}-${m}-${d}T${hh}:${mm}:${ss}Z`).getTime());
}

function normalizeSentiment(score: number): NewsSentiment {
  return {
    score,
    label: scoreToLabel(score),
    confidence: Math.min(Math.abs(score) + 0.3, 1),
  };
}

function scoreToLabel(score: number): NewsSentiment['label'] {
  if (score >= 0.35) {
    return 'very_positive';
  }
  if (score >= 0.15) {
    return 'positive';
  }
  if (score <= -0.35) {
    return 'very_negative';
  }
  if (score <= -0.15) {
    return 'negative';
  }
  return 'neutral';
}

// TODO(R-1): news/utils.ts로 추출하여 hashUrl() 중복 제거
function hashUrl(url: string): string {
  return createHash('sha256').update(url).digest('hex').slice(0, 12);
}

// TODO(R-1): news/utils.ts로 추출하여 isTransientError() 중복 제거
function isTransientError(error: unknown): boolean {
  if (error instanceof Error && 'statusCode' in error) {
    const code = (error as { statusCode: number }).statusCode;
    return code === 429 || code >= 500;
  }
  return false;
}
