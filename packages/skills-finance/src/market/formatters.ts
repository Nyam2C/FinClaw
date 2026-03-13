// packages/skills-finance/src/market/formatters.ts
import type { ProviderMarketQuote } from './types.js';

/**
 * 시세 데이터를 사용자 친화적 텍스트로 포맷한다.
 * Discord 코드블록과 터미널 양쪽에서 읽기 좋은 형태를 생성한다.
 */
export function formatQuote(quote: ProviderMarketQuote): string {
  const changeSign = quote.change >= 0 ? '+' : '';
  // branded CurrencyCode → string: formatPrice는 string을 요구하므로 명시적 캐스트
  const price = formatPrice(quote.price, quote.currency as string);
  const change = `${changeSign}${quote.change.toFixed(2)}`;
  const changePct = `${changeSign}${quote.changePercent.toFixed(2)}%`;

  const lines = [
    `${quote.symbol} ${price}`,
    `변동: ${change} (${changePct})`,
    // branded CurrencyCode → string
    `고가: ${formatPrice(quote.high, quote.currency as string)}  저가: ${formatPrice(quote.low, quote.currency as string)}`,
  ];

  if (quote.volume != null && quote.volume > 0) {
    lines.push(`거래량: ${formatNumber(quote.volume)}`);
  }
  if (quote.marketCap != null) {
    lines.push(`시가총액: ${formatNumber(quote.marketCap)}`);
  }
  if (quote.delayed) {
    lines.push('(15분 지연 데이터)');
  }

  return lines.join('\n');
}

/** 환율을 포맷한다 */
export function formatForexRate(quote: ProviderMarketQuote): string {
  // branded TickerSymbol → string: split()은 string에 정의되므로 명시적 캐스트
  const [from, to] = (quote.symbol as string).split('/');
  return `${from}/${to}: ${formatPrice(quote.price, to)}`;
}

/** 차트를 코드블록으로 래핑한다 */
export function formatChart(symbol: string, sparkline: string, period: string): string {
  return `${symbol} (${period})\n\`\`\`\n${sparkline}\n\`\`\``;
}

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

function formatNumber(value: number): string {
  if (value >= 1_000_000_000) {
    return `${(value / 1_000_000_000).toFixed(2)}B`;
  }
  if (value >= 1_000_000) {
    return `${(value / 1_000_000).toFixed(2)}M`;
  }
  if (value >= 1_000) {
    return `${(value / 1_000).toFixed(2)}K`;
  }
  return value.toFixed(0);
}
