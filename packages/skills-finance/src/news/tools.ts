// packages/skills-finance/src/news/tools.ts
import type {
  ModelCatalog,
  ProfileHealthMonitor,
  RegisteredToolDefinition,
  ToolExecutor,
  ToolRegistry,
} from '@finclaw/agent';
import type { TickerSymbol } from '@finclaw/types';
import { z } from 'zod/v4';
import { analyzeMarket, type AnalyzeRunner } from './analysis/market-analysis.js';
import type { PortfolioStore } from './portfolio/store.js';
import { createPortfolioTracker, type QuoteService } from './portfolio/tracker.js';
import type { NewsAggregator, AnalysisOptions, NewsCategory } from './types.js';

/**
 * Phase 30 B5: analyze_market 의 structured output schema.
 *
 * 모델이 자유 텍스트가 아닌 schema 일치 객체를 반환하게 강제.
 * runner 가 schema 검증 → 1회 retry → StructuredOutputValidationError.
 */
export const AnalyzeMarketOutputSchema = z.object({
  trend: z.enum(['up', 'down', 'flat']),
  volatility: z.number().min(0),
  drivers: z.array(z.string()).max(10),
  /** 1차 — 추가 자유 텍스트 요약 (필수 아님). */
  summary: z.string().optional(),
});

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
  deps: {
    newsAggregator: NewsAggregator;
    runAnalysis: AnalyzeRunner;
    /** 스킬 내부 LLM 비용·건강 기록용 (선택) */
    profileHealth?: ProfileHealthMonitor;
    profileId?: string;
    modelCatalog?: ModelCatalog;
  },
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
    // Phase 30 B5: structured output 강제 — 도구 결과는 schema 일치 객체.
    outputSchema: AnalyzeMarketOutputSchema,
    enforceStructuredOutput: true,
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

      const modelRef = { provider: 'anthropic', model: 'claude-opus-4-7' } as const;
      const analysis = await analyzeMarket(deps.runAnalysis, news, options, modelRef, {
        profileHealth: deps.profileHealth,
        profileId: deps.profileId,
        modelCatalog: deps.modelCatalog,
      });
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
