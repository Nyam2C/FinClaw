// packages/skills-finance/src/market/index.ts
import type { DatabaseSync } from 'node:sqlite';
import { createTickerSymbol } from '@finclaw/types';
import type { QuoteService } from '../news/portfolio/tracker.js';
import type { KeyRotator } from '../shared/key-rotator.js';
import { MarketCache } from './cache.js';
import { generateSparkline } from './charts.js';
import { normalizeQuote, normalizeHistorical } from './normalizer.js';
import { ProviderRegistry, createDefaultRegistry } from './provider-registry.js';
import type { ProviderMarketQuote, HistoricalPeriod } from './types.js';

/** Phase 43: 차트(스파크라인) 조회 어댑터 — route_task chart_data 가 소비. */
export interface ChartService {
  getChart(symbol: string, period: string): Promise<string>;
}

/** 스킬 초기화에 필요한 설정 */
export interface MarketSkillConfig {
  readonly db: DatabaseSync;
  /** Phase 27: KeyRotator 들 (각각 옵션). 미주입 시 해당 provider 비활성. */
  readonly finnhubRotator?: KeyRotator;
  readonly twelveDataRotator?: KeyRotator;
  readonly alphaVantageRotator?: KeyRotator;
  readonly coinGeckoKey?: string;
}

/** 초기화된 스킬 상태 (내부 상태 캡슐화) */
interface MarketSkillState {
  readonly providers: ProviderRegistry;
  readonly cache: MarketCache;
}

/** Phase 22: main.ts가 news/alerts 배선에 재사용할 수 있도록 내부 상태 노출 */
/** Phase 27 D: status 명령이 사용량을 표시하기 위해 rotator 들도 노출. */
export interface MarketSkillHandle {
  readonly providers: ProviderRegistry;
  readonly cache: MarketCache;
  readonly quoteService: QuoteService;
  /** Phase 43: route_task chart_data intent 가 직접 호출하는 차트 서비스(스파크라인 텍스트). */
  readonly chartService: ChartService;
  readonly keyRotators: {
    readonly finnhub?: KeyRotator;
    readonly twelveData?: KeyRotator;
    readonly alphaVantage?: KeyRotator;
  };
}

/** 시세 provider·캐시를 초기화한다 (도구는 route_task 가 노출). */
export async function createMarketSkill(config: MarketSkillConfig): Promise<MarketSkillHandle> {
  const providers = await createDefaultRegistry({
    finnhubRotator: config.finnhubRotator,
    twelveDataRotator: config.twelveDataRotator,
    alphaVantageRotator: config.alphaVantageRotator,
    coinGeckoKey: config.coinGeckoKey,
  });
  const cache = new MarketCache(config.db);
  const state: MarketSkillState = { providers, cache };

  const quoteService: QuoteService = {
    async getQuote(symbol: string) {
      const quote = await getQuoteFromState(state, symbol);
      return {
        price: quote.price,
        change: quote.change ?? 0,
        changePercent: quote.changePercent ?? 0,
      };
    },
  };

  const chartService: ChartService = {
    getChart(symbol: string, period: string) {
      return getChartFromState(state, symbol, period);
    },
  };

  return {
    providers,
    cache,
    quoteService,
    chartService,
    keyRotators: {
      finnhub: config.finnhubRotator,
      twelveData: config.twelveDataRotator,
      alphaVantage: config.alphaVantageRotator,
    },
  };
}

export type { MarketCache } from './cache.js';
export type { ProviderRegistry } from './provider-registry.js';

// ── 내부 헬퍼 ──

async function getQuoteFromState(
  state: MarketSkillState,
  symbolStr: string,
): Promise<ProviderMarketQuote> {
  const symbol = createTickerSymbol(symbolStr);
  const provider = state.providers.resolve(symbol);

  return state.cache.getQuote(
    symbol as string,
    {
      id: provider.id,
      rateLimit: provider.rateLimit,
      getQuote: (s) => provider.getQuote(createTickerSymbol(s)),
    },
    (raw) => normalizeQuote(raw),
  );
}

async function getChartFromState(
  state: MarketSkillState,
  symbolStr: string,
  periodStr: string,
): Promise<string> {
  const symbol = createTickerSymbol(symbolStr);
  const period = periodStr as HistoricalPeriod;
  const provider = state.providers.resolve(symbol);
  const rawResponse = await provider.getHistorical(symbol, period);
  const historical = normalizeHistorical(rawResponse);
  return generateSparkline(historical.candles, { currency: historical.currency });
}
