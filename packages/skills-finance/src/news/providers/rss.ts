import type { NewsItem } from '@finclaw/types';
// packages/skills-finance/src/news/providers/rss.ts
import { safeFetch } from '@finclaw/infra';
import { createTimestamp } from '@finclaw/types';
import { parseRssFeed } from 'feedsmith';
import { createHash } from 'node:crypto';
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

      // TODO(I-7): Timestamp branded type에 대한 비교 유틸 도입 검토
      // 날짜순 정렬 + limit 적용 (Timestamp는 branded number — 직접 비교)
      results.sort((a, b) => (b.publishedAt as number) - (a.publishedAt as number));

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
  const feed = parseRssFeed(xml);

  if (!feed || !feed.items) {
    return [];
  }

  return feed.items.map(
    (item): NewsItem => ({
      id: `rss-${hashUrl(item.link ?? item.guid?.value ?? item.title ?? '')}`,
      title: item.title ?? '',
      summary: item.description ?? undefined,
      url: item.link ?? '',
      source: 'rss',
      publishedAt: item.pubDate
        ? createTimestamp(new Date(item.pubDate).getTime())
        : createTimestamp(Date.now()),
    }),
  );
}

function filterByQuery(items: NewsItem[], query: NewsQuery): NewsItem[] {
  if (!query.symbols?.length && !query.keywords?.length) {
    return items;
  }

  return items.filter((item) => {
    const text = (item.title + ' ' + (item.summary ?? '')).toLowerCase();

    if (query.symbols?.length) {
      const hasSymbol = query.symbols.some((s) => text.includes((s as string).toLowerCase()));
      if (hasSymbol) {
        return true;
      }
    }

    if (query.keywords?.length) {
      const hasKeyword = query.keywords.some((kw) => text.includes(kw.toLowerCase()));
      if (hasKeyword) {
        return true;
      }
    }

    return false;
  });
}

// TODO(R-1): news/utils.ts로 추출하여 hashUrl() 중복 제거
function hashUrl(url: string): string {
  return createHash('sha256').update(url).digest('hex').slice(0, 12);
}
