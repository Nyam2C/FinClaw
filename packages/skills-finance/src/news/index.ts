import type { DatabaseSync } from 'node:sqlite';
import Anthropic from '@anthropic-ai/sdk';
// packages/skills-finance/src/news/index.ts
import type {
  ModelCatalog,
  ProfileHealthMonitor,
  RouterHelper,
  ToolRegistry,
} from '@finclaw/agent';
import type { ModelRef, SkillMetadata } from '@finclaw/types';
import type { KeyRotator } from '../shared/key-rotator.js';
import { createNewsAggregator } from './aggregator.js';
import { PortfolioStore } from './portfolio/store.js';
import type { QuoteService } from './portfolio/tracker.js';
import { createAlphaVantageNewsProvider } from './providers/alpha-vantage-news.js';
import { createFinnhubNewsProvider } from './providers/finnhub-news.js';
import { createNewsApiProvider } from './providers/newsapi.js';
import { createNewsDataProvider } from './providers/newsdata.js';
import { createRssProvider } from './providers/rss.js';
import {
  registerGetFinancialNewsTool,
  registerAnalyzeMarketTool,
  registerGetPortfolioSummaryTool,
} from './tools.js';
import type { NewsProvider } from './types.js';

export type { NewsAggregator, NewsQuery, NewsProvider, NewsSourceId } from './types.js';
export type { QuoteService } from './portfolio/tracker.js';

/** 스킬 초기화에 필요한 설정 */
export interface NewsSkillConfig {
  readonly db: DatabaseSync;
  readonly newsApiKey?: string;
  readonly alphaVantageKey?: string;
  /** Phase 27: NewsData.io 전용 KeyRotator */
  readonly newsdataRotator?: KeyRotator;
  /** Phase 27: Finnhub 시세와 공유하는 KeyRotator */
  readonly finnhubRotator?: KeyRotator;
  readonly rssFeedUrls?: string[];
  readonly anthropicApiKey?: string;
  readonly quoteService: QuoteService;
  /**
   * Phase 24: 모델 라우터. analyze_market 도구 실행 시 role='analysis' 로
   * 호출되어 modelRef 결정. 미주입 시 defaultModel 사용.
   */
  readonly router?: RouterHelper;
  /**
   * 라우터 미주입 시 fallback 으로 사용할 LLM modelRef.
   * 주입 시에도 router 결정 외 다른 ModelRef 필드 (provider, contextWindow 등) 의 출처.
   */
  readonly defaultModel?: ModelRef;
  /** Phase 24 E: 스킬 내부 LLM 호출 비용·건강을 status 분포에 포함하기 위한 모니터. */
  readonly profileHealth?: ProfileHealthMonitor;
  /** Phase 24 E: 스킬 호출 기록의 profileId (기본 'skill-news-analyze'). */
  readonly profileId?: string;
  /** Phase 24 E: cost 계산용 카탈로그 (pricing 조회). */
  readonly modelCatalog?: ModelCatalog;
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

/** 스킬을 초기화하고 도구를 등록한다 */
export async function registerNewsTools(
  registry: ToolRegistry,
  config: NewsSkillConfig,
): Promise<NewsSkillHandle> {
  // 프로바이더 초기화
  const providers: NewsProvider[] = [];

  if (config.newsApiKey) {
    providers.push(createNewsApiProvider({ apiKey: config.newsApiKey }));
  }

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

  // 어그리게이터
  const newsAggregator = createNewsAggregator({ providers, db: config.db });

  // 도구 등록: get_financial_news
  registerGetFinancialNewsTool(registry, { newsAggregator });

  // 도구 등록: analyze_market (Anthropic API 키가 있을 때만)
  if (config.anthropicApiKey) {
    const client = new Anthropic({ apiKey: config.anthropicApiKey });
    registerAnalyzeMarketTool(registry, {
      newsAggregator,
      client,
      router: config.router,
      defaultModel: config.defaultModel,
      profileHealth: config.profileHealth,
      profileId: config.profileId,
      modelCatalog: config.modelCatalog,
    });
  }

  // 도구 등록: get_portfolio_summary
  const portfolioStore = new PortfolioStore(config.db);
  registerGetPortfolioSummaryTool(registry, {
    portfolioStore,
    quoteService: config.quoteService,
    newsAggregator,
  });

  return {
    aggregator: newsAggregator,
    portfolioStore,
    keyRotators: { newsdata: config.newsdataRotator },
  };
}

/** 스킬 메타데이터 */
export const NEWS_SKILL_METADATA: SkillMetadata = {
  name: 'news-analysis',
  description: '금융 뉴스 수집, AI 시장 분석, 포트폴리오 추적을 제공합니다.',
  version: '1.0.0',
  requires: {
    env: [],
    optionalEnv: [
      'NEWSAPI_KEY',
      'ALPHA_VANTAGE_KEY',
      'FINNHUB_KEY',
      'NEWSDATA_API_KEY',
      'ANTHROPIC_API_KEY',
    ],
  },
  tools: [
    { name: 'get_financial_news', minModel: 'haiku', reason: '리스트 반환' },
    { name: 'analyze_market', minModel: 'opus', reason: '금융 판단, 환각 방지' },
    { name: 'get_portfolio_summary', minModel: 'sonnet', reason: '포트 요약 (판단 일부 포함)' },
  ],
};
