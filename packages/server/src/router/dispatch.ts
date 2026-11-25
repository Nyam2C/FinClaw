import type { AgentDriver } from '@finclaw/agent';
import {
  analyzeMarket,
  createPortfolioTracker,
  type ChartService,
  type NewsAggregator,
  type PortfolioStore,
  type QuoteService,
  type AnalysisOptions,
} from '@finclaw/skills-finance';
import {
  createAgentId,
  type AgentProfile,
  type Dispatcher,
  type RouteRequest,
  type RouteResult,
  type TickerSymbol,
} from '@finclaw/types';
import { loadSubAgents } from './agent-loader.js';
import { runSubAgent } from './sub-agent.js';

/**
 * route_task 디스패치 — intent 별 분기.
 * - 함수 직접 호출 (LLM 0): price_lookup·chart_data·news_summary·portfolio_calc → service 직접.
 * - sub-agent CLI 재호출 (좁은 컨텍스트): market_analysis.
 *
 * sub-agent 모델 정의는 prompts/sub-agents/*.md frontmatter 가 단일 출처(M4 로더).
 */

export interface DispatcherDeps {
  readonly quoteService: QuoteService;
  readonly chartService: ChartService;
  /** 뉴스 키 미설정 시 undefined — 뉴스 의존 intent(news_summary·market_analysis·portfolio_calc)는 에러 결과. */
  readonly newsAggregator?: NewsAggregator;
  readonly portfolioStore?: PortfolioStore;
  /** Phase 46: market_analysis 서브에이전트 1-shot 드라이버. */
  readonly driver: AgentDriver;
}

const NEWS_UNAVAILABLE: RouteResult = {
  content: 'news provider not configured (set NEWSDATA_API_KEY, FINNHUB_KEY or ALPHA_VANTAGE_KEY)',
  source: 'function',
  isError: true,
};

export function buildRouteDispatcher(deps: DispatcherDeps): Dispatcher {
  // 파일 정의(prompts/sub-agents/*.md)에서 sub-agent 프로필 1회 로드.
  const subAgents = loadSubAgents();
  const def = subAgents.get('market_analysis');
  if (!def) {
    throw new Error('sub-agent definition missing: market_analysis');
  }
  const marketAnalysisProfile: AgentProfile = {
    id: createAgentId(def.id),
    name: def.name,
    model: { provider: 'claude-cli', model: def.model },
    agentDir: 'prompts/sub-agents',
  };

  return async (req: RouteRequest, signal?: AbortSignal): Promise<RouteResult> => {
    switch (req.intent) {
      case 'market_analysis':
        return dispatchMarketAnalysis(req, deps, marketAnalysisProfile, signal);
      case 'price_lookup':
        return dispatchPriceLookup(req, deps);
      case 'chart_data':
        return dispatchChartData(req, deps);
      case 'news_summary':
        return dispatchNewsSummary(req, deps);
      case 'portfolio_calc':
        return dispatchPortfolioCalc(req, deps);
    }
  };
}

async function dispatchMarketAnalysis(
  req: RouteRequest,
  deps: DispatcherDeps,
  profile: AgentProfile,
  signal?: AbortSignal,
): Promise<RouteResult> {
  if (!deps.newsAggregator) {
    return NEWS_UNAVAILABLE;
  }
  const modelId = profile.model.model;
  const symbols = req.symbol ? ([req.symbol] as TickerSymbol[]) : undefined;
  const news = await deps.newsAggregator.fetchNews({ symbols, limit: 30 });
  if (news.length === 0) {
    return {
      content: '분석할 뉴스가 없습니다.',
      source: 'sub-agent',
      modelUsed: modelId,
      isError: false,
    };
  }

  const options: AnalysisOptions = { symbols };

  try {
    const analysis = await analyzeMarket(
      async (runReq) =>
        runSubAgent(
          deps.driver,
          { systemPrompt: runReq.systemPrompt, query: runReq.prompt, modelId: runReq.modelId },
          signal,
        ),
      news,
      options,
      profile.model,
    );
    return {
      content: JSON.stringify(analysis),
      source: 'sub-agent',
      modelUsed: modelId,
      isError: false,
    };
  } catch (err) {
    return {
      content: err instanceof Error ? err.message : String(err),
      source: 'sub-agent',
      modelUsed: modelId,
      isError: true,
    };
  }
}

// ── 함수 dispatch (LLM 0, service 직접 호출) ──

async function dispatchPriceLookup(req: RouteRequest, deps: DispatcherDeps): Promise<RouteResult> {
  if (!req.symbol) {
    return { content: 'price_lookup requires a symbol', source: 'function', isError: true };
  }
  try {
    const q = await deps.quoteService.getQuote(req.symbol);
    return {
      content: JSON.stringify(q),
      source: 'function',
      isError: false,
    };
  } catch (err) {
    return {
      content: err instanceof Error ? err.message : String(err),
      source: 'function',
      isError: true,
    };
  }
}

async function dispatchChartData(req: RouteRequest, deps: DispatcherDeps): Promise<RouteResult> {
  if (!req.symbol) {
    return { content: 'chart_data requires a symbol', source: 'function', isError: true };
  }
  try {
    const chart = await deps.chartService.getChart(req.symbol, '1m');
    return { content: chart, source: 'function', isError: false };
  } catch (err) {
    return {
      content: err instanceof Error ? err.message : String(err),
      source: 'function',
      isError: true,
    };
  }
}

async function dispatchNewsSummary(req: RouteRequest, deps: DispatcherDeps): Promise<RouteResult> {
  if (!deps.newsAggregator) {
    return NEWS_UNAVAILABLE;
  }
  try {
    const symbols = req.symbol ? ([req.symbol] as TickerSymbol[]) : undefined;
    const news = await deps.newsAggregator.fetchNews({ symbols, limit: 10 });
    return { content: JSON.stringify(news), source: 'function', isError: false };
  } catch (err) {
    return {
      content: err instanceof Error ? err.message : String(err),
      source: 'function',
      isError: true,
    };
  }
}

async function dispatchPortfolioCalc(
  req: RouteRequest,
  deps: DispatcherDeps,
): Promise<RouteResult> {
  const { newsAggregator, portfolioStore } = deps;
  if (!newsAggregator || !portfolioStore) {
    return NEWS_UNAVAILABLE;
  }
  try {
    // 단일 사용자 기본 포트폴리오 해소 (skills.ts resolveDefaultPortfolioId 와 정합).
    const portfolios = portfolioStore.listPortfolios();
    const portfolio = portfolios[0];
    if (!portfolio) {
      return { content: '포트폴리오가 없습니다.', source: 'function', isError: true };
    }
    const tracker = createPortfolioTracker({
      quoteService: deps.quoteService,
      newsAggregator,
    });
    const summary = await tracker.summarize(portfolio);
    return { content: JSON.stringify(summary), source: 'function', isError: false };
  } catch (err) {
    return {
      content: err instanceof Error ? err.message : String(err),
      source: 'function',
      isError: true,
    };
  }
}
