import type { AlertConditionEvaluator, AlertMarketService, VolumeCondition } from '../types.js';

export function createVolumeConditionEvaluator(
  marketService: AlertMarketService,
): AlertConditionEvaluator<VolumeCondition> {
  return {
    type: 'volume',
    async evaluate(condition) {
      const quote = await marketService.getQuote(condition.ticker);
      return {
        triggered: false,
        currentValue: formatVolume(quote.volume),
        message: `${condition.ticker} 현재 거래량 ${formatVolume(quote.volume)} — 평균 거래량 데이터 미지원으로 조건 평가 불가 (multiplier: ${condition.multiplier}x)`,
      };
    },
  };
}

function formatVolume(volume: number): string {
  if (volume >= 1_000_000_000) {
    return `${(volume / 1_000_000_000).toFixed(1)}B`;
  }
  if (volume >= 1_000_000) {
    return `${(volume / 1_000_000).toFixed(1)}M`;
  }
  if (volume >= 1_000) {
    return `${(volume / 1_000).toFixed(1)}K`;
  }
  return String(volume);
}
