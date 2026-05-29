import {
  analyzeMarket,
  createPortfolioTracker,
  type ChartService,
  type NewsAggregator,
  type PortfolioStore,
  type QuoteService,
  type AnalysisOptions,
} from '@finclaw/skills-finance';
import type { Dispatcher, RouteRequest, RouteResult, TickerSymbol } from '@finclaw/types';
import { runSubAgent } from './sub-agent.js';

/**
 * route_task 디스패치 — intent 별 분기.
 * - 함수/OSS 직접 호출 (LLM 0) 또는
 * - sub-agent CLI 재호출 (좁은 컨텍스트)
 *
 * 마일스톤 B 범위: market_analysis 한 intent 만 구현. 나머지는 not-implemented 반환.
 */

export interface DispatcherDeps {
  readonly newsAggregator: NewsAggregator;
  readonly quoteService: QuoteService;
  readonly chartService: ChartService;
  readonly portfolioStore: PortfolioStore;
}

const ANALYSIS_MODEL_ID = 'claude-opus-4-7';
const ANALYSIS_QUEUE_KEY = 'claude-sub-agent-analysis';

export function buildRouteDispatcher(deps: DispatcherDeps): Dispatcher {
  return async (req: RouteRequest): Promise<RouteResult> => {
    switch (req.intent) {
      case 'market_analysis':
        return dispatchMarketAnalysis(req, deps);
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
): Promise<RouteResult> {
  const symbols = req.symbol ? ([req.symbol] as TickerSymbol[]) : undefined;
  const news = await deps.newsAggregator.fetchNews({ symbols, limit: 30 });
  if (news.length === 0) {
    return {
      content: '분석할 뉴스가 없습니다.',
      source: 'sub-agent',
      modelUsed: ANALYSIS_MODEL_ID,
      isError: false,
    };
  }

  const options: AnalysisOptions = { symbols, depth: 'standard', language: 'ko' };

  try {
    const analysis = await analyzeMarket(
      async (runReq) => {
        const res = await runSubAgent({
          systemPrompt: runReq.systemPrompt,
          query: runReq.prompt,
          modelId: runReq.modelId,
          timeoutMs: runReq.timeoutMs ?? 30_000,
          queueKey: ANALYSIS_QUEUE_KEY,
        });
        return { text: res.text, usage: res.usage };
      },
      news,
      options,
      { provider: 'claude-cli', model: ANALYSIS_MODEL_ID },
    );
    return {
      content: JSON.stringify(analysis),
      source: 'sub-agent',
      modelUsed: ANALYSIS_MODEL_ID,
      isError: false,
    };
  } catch (err) {
    return {
      content: err instanceof Error ? err.message : String(err),
      source: 'sub-agent',
      modelUsed: ANALYSIS_MODEL_ID,
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
  try {
    // 단일 사용자 기본 포트폴리오 해소 (skills.ts resolveDefaultPortfolioId 와 정합).
    const portfolios = deps.portfolioStore.listPortfolios();
    const portfolio = portfolios[0];
    if (!portfolio) {
      return { content: '포트폴리오가 없습니다.', source: 'function', isError: true };
    }
    const tracker = createPortfolioTracker({
      quoteService: deps.quoteService,
      newsAggregator: deps.newsAggregator,
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
