import type { NewsItem } from '@finclaw/types';
import type { DatabaseSync } from 'node:sqlite';
import { getCachedData, setCachedData } from '@finclaw/storage';
// packages/skills-finance/src/news/aggregator.ts
import { createHash } from 'node:crypto';
import type { NewsAggregator, NewsProvider, NewsQuery } from './types.js';

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
        if (cached) {
          return cached;
        }
      }

      // 요청된 소스 필터링
      const activeProviders = providers.filter((p) => {
        if (!p.isAvailable()) {
          return false;
        }
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

      // 날짜순 정렬 (최신 우선) — Timestamp는 branded number, 직접 비교
      deduped.sort((a, b) => (b.publishedAt as number) - (a.publishedAt as number));

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
    if (seen.has(hash)) {
      return false;
    }
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
