import type { TickerSymbol } from '@finclaw/types';
// packages/skills-finance/src/market/provider-registry.ts
import type { MarketDataProvider } from './types.js';

/**
 * 티커 심볼을 적절한 프로바이더로 라우팅한다.
 * 등록 순서대로 supports()를 확인하여 첫 번째 매칭 프로바이더를 반환한다.
 */
export class ProviderRegistry {
  private readonly providers: MarketDataProvider[] = [];

  register(provider: MarketDataProvider): void {
    this.providers.push(provider);
  }

  /** 심볼에 맞는 프로바이더를 찾는다. 없으면 에러 */
  resolve(symbol: TickerSymbol): MarketDataProvider {
    const provider = this.providers.find((p) => p.supports(symbol));
    if (!provider) {
      throw new Error(`No provider found for symbol: ${symbol}`);
    }
    return provider;
  }

  /** 외환용 폴백 체인 — 첫 번째 실패 시 다음 프로바이더 시도 */
  resolveWithFallback(symbol: TickerSymbol): MarketDataProvider[] {
    return this.providers.filter((p) => p.supports(symbol));
  }
}

/** 기본 프로바이더 레지스트리를 생성한다 (AV → CoinGecko → Frankfurter 순서) */
export async function createDefaultRegistry(config: {
  alphaVantageKey?: string;
  coinGeckoKey?: string;
}): Promise<ProviderRegistry> {
  const { AlphaVantageProvider } = await import('./providers/alpha-vantage.js');
  const { CoinGeckoProvider } = await import('./providers/coingecko.js');
  const { FrankfurterProvider } = await import('./providers/frankfurter.js');

  const registry = new ProviderRegistry();

  // Alpha Vantage는 API 키가 있을 때만 등록
  if (config.alphaVantageKey) {
    registry.register(new AlphaVantageProvider(config.alphaVantageKey));
  }

  // CoinGecko는 항상 등록 (무키 동작 가능)
  registry.register(new CoinGeckoProvider(config.coinGeckoKey));

  // Frankfurter는 항상 등록 (무료, 키 불필요)
  registry.register(new FrankfurterProvider());

  return registry;
}
