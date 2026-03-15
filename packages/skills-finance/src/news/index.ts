// packages/skills-finance/src/news/index.ts
import type { ToolRegistry } from '@finclaw/agent';
import type { DatabaseSync } from 'node:sqlite';
import Anthropic from '@anthropic-ai/sdk';
import type { QuoteService } from './portfolio/tracker.js';
import type { NewsProvider } from './types.js';
import { createNewsAggregator } from './aggregator.js';
import { PortfolioStore } from './portfolio/store.js';
import { createAlphaVantageNewsProvider } from './providers/alpha-vantage-news.js';
import { createNewsApiProvider } from './providers/newsapi.js';
import { createRssProvider } from './providers/rss.js';
import {
  registerGetFinancialNewsTool,
  registerAnalyzeMarketTool,
  registerGetPortfolioSummaryTool,
} from './tools.js';

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
