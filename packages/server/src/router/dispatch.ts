import { analyzeMarket, type NewsAggregator, type AnalysisOptions } from '@finclaw/skills-finance';
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
}

const ANALYSIS_MODEL_ID = 'claude-opus-4-7';
const ANALYSIS_QUEUE_KEY = 'claude-sub-agent-analysis';

export function buildRouteDispatcher(deps: DispatcherDeps): Dispatcher {
  return async (req: RouteRequest): Promise<RouteResult> => {
    switch (req.intent) {
      case 'market_analysis':
        return dispatchMarketAnalysis(req, deps);
      case 'price_lookup':
      case 'chart_data':
      case 'news_summary':
      case 'portfolio_calc':
        return {
          content: `intent '${req.intent}' not implemented yet (milestone D)`,
          source: 'function',
          isError: true,
        };
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
