import type { TickerSymbol } from '@finclaw/types';
import type { KeyRotator } from '../shared/key-rotator.js';
// packages/skills-finance/src/market/provider-registry.ts
import type { MarketDataProvider } from './types.js';

/**
 * 티커 심볼을 적절한 프로바이더로 라우팅한다.
 * 등록 순서대로 supports() && isAvailable() 확인 → 첫 매칭 반환.
 */
export class ProviderRegistry {
  private readonly providers: MarketDataProvider[] = [];

  register(provider: MarketDataProvider): void {
    this.providers.push(provider);
  }

  /** supports() && isAvailable() 첫 매칭. 없으면 supports() 첫 매칭 (degraded). 그것도 없으면 throw. */
  resolve(symbol: TickerSymbol): MarketDataProvider {
    const supports = this.providers.filter((p) => p.supports(symbol));
    const available = supports.find((p) => p.isAvailable());
    if (available) {
      return available;
    }
    if (supports.length > 0) {
      return supports[0]; // 모두 cooldown → 첫 provider 가 throw 하도록 위임
    }
    throw new Error(`No provider found for symbol: ${symbol}`);
  }

  /** fallback chain (기존 forex 사용처 유지) */
  resolveWithFallback(symbol: TickerSymbol): MarketDataProvider[] {
    return this.providers.filter((p) => p.supports(symbol));
  }

  /** Phase 27 D: status 표시용. 등록된 provider 목록 readonly view. */
  list(): ReadonlyArray<MarketDataProvider> {
    return this.providers;
  }
}

/**
 * 기본 프로바이더 레지스트리.
 * 우선순위: Finnhub → Twelve Data → Alpha Vantage → CoinGecko → Frankfurter.
 */
export async function createDefaultRegistry(config: {
  finnhubRotator?: KeyRotator;
  twelveDataRotator?: KeyRotator;
  alphaVantageRotator?: KeyRotator;
  coinGeckoKey?: string;
}): Promise<ProviderRegistry> {
  const { AlphaVantageProvider } = await import('./providers/alpha-vantage.js');
  const { CoinGeckoProvider } = await import('./providers/coingecko.js');
  const { FrankfurterProvider } = await import('./providers/frankfurter.js');
  const { FinnhubProvider } = await import('./providers/finnhub.js');
  const { TwelveDataProvider } = await import('./providers/twelve-data.js');

  const registry = new ProviderRegistry();

  // 미국 주식 우선순위: Finnhub (real-time) → Twelve Data (4h) → Alpha Vantage (EOD).
  if (config.finnhubRotator) {
    registry.register(new FinnhubProvider(config.finnhubRotator));
  }
  if (config.twelveDataRotator) {
    registry.register(new TwelveDataProvider(config.twelveDataRotator));
  }
  if (config.alphaVantageRotator) {
    registry.register(new AlphaVantageProvider(config.alphaVantageRotator));
  }

  // 암호화폐 / 외환 — 현행 유지.
  registry.register(new CoinGeckoProvider(config.coinGeckoKey));
  registry.register(new FrankfurterProvider());

  return registry;
}
