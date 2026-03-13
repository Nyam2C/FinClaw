import type { RegisteredToolDefinition, ToolExecutor, ToolRegistry } from '@finclaw/agent';
// packages/skills-finance/src/market/index.ts
import type { DatabaseSync } from 'node:sqlite';
import { createTickerSymbol } from '@finclaw/types';
import type { ProviderMarketQuote, HistoricalPeriod } from './types.js';
import { MarketCache } from './cache.js';
import { generateSparkline } from './charts.js';
import { formatQuote, formatForexRate, formatChart } from './formatters.js';
import { normalizeQuote, normalizeHistorical } from './normalizer.js';
import { ProviderRegistry, createDefaultRegistry } from './provider-registry.js';

/** 스킬 초기화에 필요한 설정 */
export interface MarketSkillConfig {
  readonly db: DatabaseSync;
  readonly alphaVantageKey?: string;
  readonly coinGeckoKey?: string;
}

/** 초기화된 스킬 상태 (내부 상태 캡슐화) */
interface MarketSkillState {
  readonly providers: ProviderRegistry;
  readonly cache: MarketCache;
}

/** 스킬을 초기화하고 도구를 등록한다 */
export async function registerMarketTools(
  registry: ToolRegistry,
  config: MarketSkillConfig,
): Promise<void> {
  const providers = await createDefaultRegistry({
    alphaVantageKey: config.alphaVantageKey,
    coinGeckoKey: config.coinGeckoKey,
  });
  const cache = new MarketCache(config.db);
  const state: MarketSkillState = { providers, cache };

  registerStockPriceTool(registry, state);
  registerCryptoPriceTool(registry, state);
  registerForexRateTool(registry, state);
  registerMarketChartTool(registry, state);
}

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

// ── 도구 등록 ──

function registerStockPriceTool(registry: ToolRegistry, state: MarketSkillState): void {
  const def: RegisteredToolDefinition = {
    name: 'get_stock_price',
    description:
      '주식 실시간/지연 시세를 조회합니다. 미국 주식 티커(예: AAPL, GOOGL, MSFT)를 지원합니다.',
    inputSchema: {
      type: 'object',
      properties: {
        symbol: { type: 'string', description: '주식 티커 심볼 (예: AAPL)' },
      },
      required: ['symbol'],
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
      const quote = await getQuoteFromState(state, input.symbol as string);
      return { content: formatQuote(quote), isError: false };
    } catch (error) {
      return { content: error instanceof Error ? error.message : String(error), isError: true };
    }
  };
  registry.register(def, executor, 'skill');
}

function registerCryptoPriceTool(registry: ToolRegistry, state: MarketSkillState): void {
  const def: RegisteredToolDefinition = {
    name: 'get_crypto_price',
    description: '암호화폐 실시간 시세를 조회합니다. BTC, ETH, SOL 등 주요 암호화폐를 지원합니다.',
    inputSchema: {
      type: 'object',
      properties: {
        symbol: { type: 'string', description: '암호화폐 심볼 (예: BTC, ETH)' },
      },
      required: ['symbol'],
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
      const quote = await getQuoteFromState(state, input.symbol as string);
      return { content: formatQuote(quote), isError: false };
    } catch (error) {
      return { content: error instanceof Error ? error.message : String(error), isError: true };
    }
  };
  registry.register(def, executor, 'skill');
}

function registerForexRateTool(registry: ToolRegistry, state: MarketSkillState): void {
  const def: RegisteredToolDefinition = {
    name: 'get_forex_rate',
    description: '외환 환율을 조회합니다. USD/KRW, EUR/USD 등의 통화쌍을 지원합니다.',
    inputSchema: {
      type: 'object',
      properties: {
        from: { type: 'string', description: '기준 통화 (예: USD)' },
        to: { type: 'string', description: '대상 통화 (예: KRW)' },
      },
      required: ['from', 'to'],
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
      const from = input.from as string;
      const to = input.to as string;
      const quote = await getQuoteFromState(state, `${from}/${to}`);
      return { content: formatForexRate(quote), isError: false };
    } catch (error) {
      return { content: error instanceof Error ? error.message : String(error), isError: true };
    }
  };
  registry.register(def, executor, 'skill');
}

function registerMarketChartTool(registry: ToolRegistry, state: MarketSkillState): void {
  const def: RegisteredToolDefinition = {
    name: 'get_market_chart',
    description:
      '시세 차트를 텍스트 스파크라인으로 생성합니다. 기간별(1일~5년) 과거 데이터를 시각화합니다.',
    inputSchema: {
      type: 'object',
      properties: {
        symbol: { type: 'string', description: '티커 심볼 (예: AAPL, BTC)' },
        period: {
          type: 'string',
          description: '기간 (1d, 5d, 1m, 3m, 6m, 1y, 5y)',
          default: '1m',
          enum: ['1d', '5d', '1m', '3m', '6m', '1y', '5y'],
        },
      },
      required: ['symbol'],
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
      const symbol = input.symbol as string;
      const period = (input.period as string) ?? '1m';
      const sparkline = await getChartFromState(state, symbol, period);
      return { content: formatChart(symbol, sparkline, period), isError: false };
    } catch (error) {
      return { content: error instanceof Error ? error.message : String(error), isError: true };
    }
  };
  registry.register(def, executor, 'skill');
}

/** 스킬 메타데이터 — Phase 7의 skill registry에 등록 */
export const MARKET_SKILL_METADATA = {
  name: 'market-data',
  description: '주식, 암호화폐, 외환 시장 데이터를 조회하고 차트를 생성합니다.',
  version: '1.0.0',
  requires: {
    env: [], // API 키는 선택사항 (무료 티어 가능)
    optionalEnv: ['ALPHA_VANTAGE_KEY', 'COINGECKO_DEMO_KEY'],
  },
  tools: ['get_stock_price', 'get_crypto_price', 'get_forex_rate', 'get_market_chart'],
} as const;
