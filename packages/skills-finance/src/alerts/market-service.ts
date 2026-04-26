import { createTickerSymbol } from '@finclaw/types';
import type { MarketCache } from '../market/cache.js';
import { normalizeQuote } from '../market/normalizer.js';
import type { ProviderRegistry } from '../market/provider-registry.js';
import type { AlertMarketService } from './types.js';

export function createAlertMarketService(deps: {
  cache: MarketCache;
  registry: ProviderRegistry;
}): AlertMarketService {
  return {
    async getQuote(ticker) {
      const symbol = createTickerSymbol(ticker);
      const provider = deps.registry.resolve(symbol);
      const quote = await deps.cache.getQuote(
        symbol as string,
        {
          id: provider.id,
          rateLimit: provider.rateLimit,
          getQuote: (s) => provider.getQuote(createTickerSymbol(s)),
        },
        (raw) => normalizeQuote(raw),
      );
      return { price: quote.price, changePercent: quote.changePercent, volume: quote.volume };
    },
  };
}
