import type { CircuitBreaker } from '@finclaw/infra';
import type { AlertConditionEvaluator, AlertMarketService, PriceCondition } from '../types.js';

export function createPriceConditionEvaluator(
  marketService: AlertMarketService,
  circuitBreaker: CircuitBreaker,
): AlertConditionEvaluator<PriceCondition> {
  return {
    type: 'price',
    async evaluate(condition) {
      const quote = await circuitBreaker.execute(() => marketService.getQuote(condition.ticker));
      const { price } = quote;
      const triggered =
        condition.direction === 'above'
          ? price >= condition.threshold
          : price <= condition.threshold;
      const directionLabel = condition.direction === 'above' ? '이상' : '이하';
      return {
        triggered,
        currentValue: String(price),
        message: triggered
          ? `${condition.ticker} 현재가 ${price}이(가) 목표가 ${condition.threshold} ${directionLabel} 조건을 충족했습니다.`
          : `${condition.ticker} 현재가 ${price} (목표: ${condition.threshold} ${directionLabel})`,
      };
    },
  };
}
