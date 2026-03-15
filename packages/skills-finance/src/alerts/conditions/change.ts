import type { CircuitBreaker } from '@finclaw/infra';
import type { AlertConditionEvaluator, AlertMarketService, ChangeCondition } from '../types.js';

export function createChangeConditionEvaluator(
  marketService: AlertMarketService,
  circuitBreaker: CircuitBreaker,
): AlertConditionEvaluator<ChangeCondition> {
  return {
    type: 'change',
    async evaluate(condition) {
      const quote = await circuitBreaker.execute(() => marketService.getQuote(condition.ticker));
      const { changePercent } = quote;
      let triggered: boolean;
      switch (condition.direction) {
        case 'up':
          triggered = changePercent >= condition.thresholdPercent;
          break;
        case 'down':
          triggered = changePercent <= -condition.thresholdPercent;
          break;
        case 'both':
          triggered = Math.abs(changePercent) >= condition.thresholdPercent;
          break;
      }
      const directionLabel = { up: '상승', down: '하락', both: '변동' }[condition.direction];
      return {
        triggered,
        currentValue: `${changePercent.toFixed(2)}%`,
        message: triggered
          ? `${condition.ticker} ${directionLabel}률 ${changePercent.toFixed(2)}%이(가) 기준 ${condition.thresholdPercent}%를 충족했습니다.`
          : `${condition.ticker} 변동률 ${changePercent.toFixed(2)}% (기준: ±${condition.thresholdPercent}% ${directionLabel})`,
      };
    },
  };
}
