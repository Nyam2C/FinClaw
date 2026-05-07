// packages/skills-finance/src/news/providers/finnhub-news.ts
// Phase 27 C: Finnhub company-news (sentiment 포함). 시세 KeyRotator 와 동일 인스턴스 공유.

import { safeFetchJson } from '@finclaw/infra';
import { retry } from '@finclaw/infra';
import type { NewsItem, NewsSentiment } from '@finclaw/types';
import { z } from 'zod/v4';
import { AllKeysCooldownError, KeyRotator } from '../../shared/key-rotator.js';
import type { NewsProvider, NewsQuery, NewsSourceId } from '../types.js';

const COMPANY_NEWS_URL = 'https://finnhub.io/api/v1/company-news';

const ItemSchema = z.object({
  category: z.string().optional(),
  datetime: z.number(),
  headline: z.string(),
  id: z.number(),
  image: z.string().optional(),
  related: z.string().optional(),
  source: z.string(),
  summary: z.string().optional(),
  url: z.string(),
  // Finnhub 무료 tier 는 sentiment 미포함이지만 응답에 들어오면 보존.
  headline_sentiment: z.number().optional(),
});

const ResponseSchema = z.array(ItemSchema);

function isAuthOrRateError(error: unknown): boolean {
  if (error instanceof Error && 'statusCode' in error) {
    const code = (error as { statusCode: number }).statusCode;
    return code === 401 || code === 429;
  }
  return false;
}

function isTransientError(error: unknown): boolean {
  if (error instanceof Error && 'statusCode' in error) {
    const code = (error as { statusCode: number }).statusCode;
    return code === 429 || code >= 500;
  }
  return false;
}

export interface FinnhubNewsConfig {
  readonly rotator: KeyRotator;
}

export function createFinnhubNewsProvider(config: FinnhubNewsConfig): NewsProvider {
  return {
    name: 'finnhub-news' as NewsSourceId,
    isAvailable: () => config.rotator.availableCount() > 0,
    async fetchNews(query: NewsQuery): Promise<NewsItem[]> {
      // company-news 는 종목 단위. symbols 미지정 시 빈 배열.
      if (!query.symbols?.length) {
        return [];
      }

      const to = new Date();
      const from = new Date(to.getTime() - 7 * 86_400_000); // 7일 (질문 Q7)
      const fromStr = from.toISOString().slice(0, 10);
      const toStr = to.toISOString().slice(0, 10);

      const all: NewsItem[] = [];
      for (const symbol of query.symbols) {
        const data = await callWithRotation(config.rotator, (token) => {
          const url = new URL(COMPANY_NEWS_URL);
          url.searchParams.set('symbol', symbol);
          url.searchParams.set('from', fromStr);
          url.searchParams.set('to', toStr);
          url.searchParams.set('token', token);
          return retry(() => safeFetchJson(url.toString(), { timeoutMs: 10_000 }), {
            maxAttempts: 2,
            shouldRetry: isTransientError,
          });
        });

        const parsed = ResponseSchema.safeParse(data);
        if (!parsed.success) {
          continue;
        }

        for (const r of parsed.data) {
          const item: NewsItem = {
            id: String(r.id),
            title: r.headline,
            url: r.url,
            source: r.source,
            publishedAt: (r.datetime * 1000) as NewsItem['publishedAt'],
            summary: r.summary ?? '',
            symbols: [symbol],
          };
          if (r.headline_sentiment !== undefined) {
            item.sentiment = scoreToSentiment(r.headline_sentiment);
          }
          all.push(item);
        }
      }

      return all.slice(0, query.limit ?? 20);
    },
  };
}

function scoreToSentiment(score: number): NewsSentiment {
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

async function callWithRotation<T>(
  rotator: KeyRotator,
  fetcher: (token: string) => Promise<T>,
  maxRotations = 3,
): Promise<T> {
  let lastError: Error | undefined;
  for (let i = 0; i < maxRotations; i++) {
    let token: string;
    try {
      token = rotator.next();
    } catch (err) {
      if (err instanceof AllKeysCooldownError) {
        throw err;
      }
      throw err;
    }
    try {
      const result = await fetcher(token);
      rotator.markSuccess(token);
      return result;
    } catch (err) {
      lastError = err as Error;
      if (isAuthOrRateError(err)) {
        rotator.markFailure(token, lastError);
        continue;
      }
      throw err;
    }
  }
  throw lastError ?? new Error('All Finnhub-news key rotations exhausted');
}
