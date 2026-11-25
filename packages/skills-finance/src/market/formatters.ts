// packages/skills-finance/src/market/formatters.ts
export function formatPrice(value: number, currency: string): string {
  const symbols: Record<string, string> = {
    USD: '$',
    KRW: '₩',
    EUR: '€',
    GBP: '£',
    JPY: '¥',
    BTC: '₿',
  };
  const sym = symbols[currency] ?? currency;

  if (value >= 1_000_000) {
    return `${sym}${(value / 1_000_000).toFixed(2)}M`;
  }
  if (value >= 1_000) {
    return `${sym}${(value / 1_000).toFixed(2)}K`;
  }
  if (value < 1) {
    return `${sym}${value.toFixed(6)}`;
  }
  return `${sym}${value.toFixed(2)}`;
}
