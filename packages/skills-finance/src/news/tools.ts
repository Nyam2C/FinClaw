import type Anthropic from '@anthropic-ai/sdk';
// packages/skills-finance/src/news/tools.ts
import type { RegisteredToolDefinition, ToolExecutor, ToolRegistry } from '@finclaw/agent';
import type { TickerSymbol } from '@finclaw/types';
import type { PortfolioStore } from './portfolio/store.js';
import type { NewsAggregator, AnalysisOptions, NewsCategory } from './types.js';
import { analyzeMarket } from './analysis/market-analysis.js';
import { createPortfolioTracker, type QuoteService } from './portfolio/tracker.js';

// ─── get_financial_news ───

export function registerGetFinancialNewsTool(
  registry: ToolRegistry,
  deps: { newsAggregator: NewsAggregator },
): void {
  const def: RegisteredToolDefinition = {
    name: 'get_financial_news',
    description: '금융 뉴스를 검색합니다. 특정 종목, 키워드, 카테고리로 필터링할 수 있습니다.',
    inputSchema: {
      type: 'object',
      properties: {
        symbols: {
          type: 'array',
          items: { type: 'string' },
          description: '종목 코드 목록 (예: ["AAPL", "GOOGL"])',
        },
        keywords: {
          type: 'array',
          items: { type: 'string' },
          description: '검색 키워드 (예: ["earnings", "Fed"])',
        },
        category: {
          type: 'string',
          enum: [
            'earnings',
            'merger',
            'ipo',
            'regulation',
            'macro',
            'crypto',
            'commodity',
            'general',
          ],
          description: '뉴스 카테고리',
        },
        limit: { type: 'number', description: '반환할 뉴스 수 (기본 10, 최대 50)' },
      },
      required: [],
    },
    group: 'finance',
    requiresApproval: false,
    isTransactional: false,
    accessesSensitiveData: false,
    isExternal: true,
    timeoutMs: 15_000,
  };

  const executor: ToolExecutor = async (input) => {
    try {
      const news = await deps.newsAggregator.fetchNews({
        symbols: input.symbols as TickerSymbol[] | undefined,
        keywords: input.keywords as string[] | undefined,
        category: input.category as NewsCategory | undefined,
        limit: Math.min((input.limit as number) ?? 10, 50),
      });
      return { content: JSON.stringify(news), isError: false };
    } catch (error) {
      return { content: error instanceof Error ? error.message : String(error), isError: true };
    }
  };

  registry.register(def, executor, 'skill');
}

// ─── analyze_market ───

export function registerAnalyzeMarketTool(
  registry: ToolRegistry,
  deps: { newsAggregator: NewsAggregator; client: Anthropic },
): void {
  const def: RegisteredToolDefinition = {
    name: 'analyze_market',
    description:
      'AI 기반 시장 분석을 수행합니다. 뉴스를 종합하여 시장 전망, 감성 분석, 리스크/기회를 제공합니다.',
    inputSchema: {
      type: 'object',
      properties: {
        symbols: {
          type: 'array',
          items: { type: 'string' },
          description: '분석할 종목 코드 (예: ["AAPL"])',
        },
        depth: {
          type: 'string',
          enum: ['brief', 'standard', 'detailed'],
          description: '분석 깊이 (기본: standard)',
        },
        language: {
          type: 'string',
          enum: ['ko', 'en'],
          description: '분석 언어 (기본: ko)',
        },
      },
      required: [],
    },
    group: 'finance',
    requiresApproval: false,
    isTransactional: false,
    accessesSensitiveData: false,
    isExternal: true,
    timeoutMs: 30_000,
  };

  const executor: ToolExecutor = async (input) => {
    try {
      const symbols = input.symbols as TickerSymbol[] | undefined;
      const options: AnalysisOptions = {
        symbols,
        depth: (input.depth as AnalysisOptions['depth']) ?? 'standard',
        language: (input.language as AnalysisOptions['language']) ?? 'ko',
      };

      const news = await deps.newsAggregator.fetchNews({ symbols, limit: 30 });
      if (news.length === 0) {
        return { content: '분석할 뉴스가 없습니다.', isError: false };
      }

      const analysis = await analyzeMarket(deps.client, news, options);
      return { content: JSON.stringify(analysis), isError: false };
    } catch (error) {
      return { content: error instanceof Error ? error.message : String(error), isError: true };
    }
  };

  registry.register(def, executor, 'skill');
}

// ─── get_portfolio_summary ───

export function registerGetPortfolioSummaryTool(
  registry: ToolRegistry,
  deps: {
    portfolioStore: PortfolioStore;
    quoteService: QuoteService;
    newsAggregator: NewsAggregator;
  },
): void {
  const def: RegisteredToolDefinition = {
    name: 'get_portfolio_summary',
    description:
      '포트폴리오 종합 요약을 제공합니다. 현재가 기반 P&L, 상위 수익/손실 종목, 일일 변동을 포함합니다.',
    inputSchema: {
      type: 'object',
      properties: {
        portfolioId: {
          type: 'string',
          description: '포트폴리오 ID',
        },
      },
      required: ['portfolioId'],
    },
    group: 'finance',
    requiresApproval: false,
    isTransactional: false,
    accessesSensitiveData: true,
    isExternal: true,
    timeoutMs: 20_000,
  };

  const executor: ToolExecutor = async (input) => {
    try {
      const portfolioId = input.portfolioId as string;
      const portfolio = deps.portfolioStore.getPortfolio(portfolioId);
      if (!portfolio) {
        return { content: `포트폴리오를 찾을 수 없습니다: ${portfolioId}`, isError: true };
      }

      const tracker = createPortfolioTracker({
        quoteService: deps.quoteService,
        newsAggregator: deps.newsAggregator,
      });

      const summary = await tracker.summarize(portfolio);
      return { content: JSON.stringify(summary), isError: false };
    } catch (error) {
      return { content: error instanceof Error ? error.message : String(error), isError: true };
    }
  };

  registry.register(def, executor, 'skill');
}
