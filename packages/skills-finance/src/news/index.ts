import type { DatabaseSync } from 'node:sqlite';
// packages/skills-finance/src/news/index.ts
import type { ModelCatalog, ProfileHealthMonitor, ToolRegistry } from '@finclaw/agent';
import { runCliAgent } from '@finclaw/agent';
import type { SkillMetadata } from '@finclaw/types';
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
  readonly quoteService: QuoteService;
  /** 스킬 내부 LLM 호출 비용·건강을 status 분포에 포함하기 위한 모니터. */
  readonly profileHealth?: ProfileHealthMonitor;
  readonly profileId?: string;
  /** cost 계산용 카탈로그. */
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

  // 도구 등록: analyze_market — Phase 41: CLI runner 무조건 등록 (구독 모드).
  // inner runCliAgent 은 전용 queueKey('claude-analysis') + 세션 비공유로 중첩 spawn 데드락 회피.
  registerAnalyzeMarketTool(registry, {
    newsAggregator,
    runAnalysis: async (req) => {
      const res = await runCliAgent({
        systemPrompt: req.systemPrompt,
        prompt: req.prompt,
        modelId: req.modelId,
        timeoutMs: req.timeoutMs,
        queueKey: 'claude-analysis',
        // cliSessionId 미전달 — stateless 1-shot (세션 비공유).
      });
      return {
        text: res.text,
        usage: res.usage
          ? { input: res.usage.input ?? 0, output: res.usage.output ?? 0 }
          : undefined,
      };
    },
    profileHealth: config.profileHealth,
    profileId: config.profileId,
    modelCatalog: config.modelCatalog,
  });

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
    optionalEnv: ['NEWSAPI_KEY', 'ALPHA_VANTAGE_KEY', 'FINNHUB_KEY', 'NEWSDATA_API_KEY'],
  },
  tools: [
    { name: 'get_financial_news', reason: '리스트 반환' },
    { name: 'analyze_market', reason: '금융 판단, 환각 방지' },
    { name: 'get_portfolio_summary', reason: '포트 요약 (판단 일부 포함)' },
  ],
};
