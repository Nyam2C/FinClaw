import type { DatabaseSync } from 'node:sqlite';
// packages/skills-finance/src/news/index.ts
import type { KeyRotator } from '../shared/key-rotator.js';
import { createNewsAggregator } from './aggregator.js';
import { PortfolioStore } from './portfolio/store.js';
import { createAlphaVantageNewsProvider } from './providers/alpha-vantage-news.js';
import { createFinnhubNewsProvider } from './providers/finnhub-news.js';
import { createNewsDataProvider } from './providers/newsdata.js';
import { createRssProvider } from './providers/rss.js';
import type { NewsProvider } from './types.js';

export type { NewsAggregator, NewsQuery, NewsProvider, NewsSourceId } from './types.js';
export type { QuoteService } from './portfolio/tracker.js';

/** 스킬 초기화에 필요한 설정 */
export interface NewsSkillConfig {
  readonly db: DatabaseSync;
  readonly alphaVantageKey?: string;
  /** Phase 27: NewsData.io 전용 KeyRotator */
  readonly newsdataRotator?: KeyRotator;
  /** Phase 27: Finnhub 시세와 공유하는 KeyRotator */
  readonly finnhubRotator?: KeyRotator;
  readonly rssFeedUrls?: string[];
}

/** Phase 22: main.ts가 alerts 배선에 재사용할 수 있도록 aggregator 노출 */
/** Phase 23: finance.portfolio.get RPC 배선을 위해 portfolioStore 도 함께 노출 */
/** Phase 27 D: status 표시용 newsdata rotator 노출. */
export interface NewsSkillHandle {
  readonly aggregator: import('./types.js').NewsAggregator;
  readonly portfolioStore: PortfolioStore;
  readonly keyRotators: {
    readonly newsdata?: KeyRotator;
  };
}

/** 뉴스 어그리게이터·포트폴리오 스토어를 초기화한다 (도구는 route_task 가 노출). */
export function createNewsSkill(config: NewsSkillConfig): NewsSkillHandle {
  // 프로바이더 초기화
  const providers: NewsProvider[] = [];

  if (config.alphaVantageKey) {
    providers.push(createAlphaVantageNewsProvider({ apiKey: config.alphaVantageKey }));
  }

  if (config.newsdataRotator) {
    providers.push(createNewsDataProvider({ rotator: config.newsdataRotator }));
  }

  if (config.finnhubRotator) {
    providers.push(createFinnhubNewsProvider({ rotator: config.finnhubRotator }));
  }

  providers.push(createRssProvider({ feedUrls: config.rssFeedUrls }));

  return {
    aggregator: createNewsAggregator({ providers, db: config.db }),
    portfolioStore: new PortfolioStore(config.db),
    keyRotators: { newsdata: config.newsdataRotator },
  };
}
