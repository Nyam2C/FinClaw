// packages/skills-finance/src/news/providers/newsdata.ts
// Phase 27 C: NewsData.io 영문 뉴스 (200 credits/day · 키, 키 3개 = 600/day).

import { safeFetchJson } from '@finclaw/infra';
import { retry } from '@finclaw/infra';
import type { NewsItem, TickerSymbol } from '@finclaw/types';
import { z } from 'zod/v4';
import { AllKeysCooldownError, KeyRotator } from '../../shared/key-rotator.js';
import type { NewsProvider, NewsQuery, NewsSourceId } from '../types.js';

const ENDPOINT = 'https://newsdata.io/api/1/latest';

const ResponseSchema = z.object({
  status: z.string(),
  totalResults: z.number().optional(),
  results: z
    .array(
      z.object({
        article_id: z.string().optional(),
        title: z.string(),
        link: z.string(),
        description: z.string().nullable().optional(),
        pubDate: z.string(),
        source_id: z.string().optional(),
        country: z.array(z.string()).optional(),
        category: z.array(z.string()).optional(),
      }),
    )
    .optional(),
});

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

export interface NewsDataProviderConfig {
  readonly rotator: KeyRotator;
}

export function createNewsDataProvider(config: NewsDataProviderConfig): NewsProvider {
  return {
    name: 'newsdata' as NewsSourceId,
    isAvailable: () => config.rotator.availableCount() > 0,
    async fetchNews(query: NewsQuery): Promise<NewsItem[]> {
      const data = await callWithRotation(config.rotator, (token) => {
        const url = new URL(ENDPOINT);
        url.searchParams.set('apikey', token);
        url.searchParams.set('language', 'en');
        url.searchParams.set('category', mapCategory(query.category));
        if (query.symbols?.length) {
          url.searchParams.set('q', query.symbols.join(' OR '));
        } else if (query.keywords?.length) {
          url.searchParams.set('q', query.keywords.join(' OR '));
        }
        return retry(() => safeFetchJson(url.toString(), { timeoutMs: 10_000 }), {
          maxAttempts: 2,
          shouldRetry: isTransientError,
        });
      });

      const parsed = ResponseSchema.safeParse(data);
      if (!parsed.success || !parsed.data.results) {
        return [];
      }

      const limit = query.limit ?? 20;
      return parsed.data.results.slice(0, limit).map((r) => normalizeItem(r, query.symbols));
    },
  };
}

function mapCategory(c: NewsQuery['category']): string {
  switch (c) {
    case 'crypto':
      return 'business';
    case 'earnings':
    case 'merger':
    case 'ipo':
    case 'regulation':
      return 'business';
    case 'macro':
      return 'business';
    default:
      return 'business';
  }
}

function normalizeItem(
  raw: {
    title: string;
    link: string;
    description?: string | null;
    pubDate: string;
    source_id?: string;
  },
  symbols: readonly TickerSymbol[] | undefined,
): NewsItem {
  return {
    id: raw.link,
    title: raw.title,
    url: raw.link,
    source: raw.source_id ?? 'newsdata',
    publishedAt: new Date(raw.pubDate).getTime() as NewsItem['publishedAt'],
    summary: raw.description ?? '',
    symbols: symbols ? [...symbols] : [],
  };
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
  throw lastError ?? new Error('All NewsData key rotations exhausted');
}
