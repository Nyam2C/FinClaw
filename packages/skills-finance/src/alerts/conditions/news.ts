import type { CircuitBreaker } from '@finclaw/infra';
import type { TickerSymbol } from '@finclaw/types';
import type { NewsAggregator } from '../../news/types.js';
import type { AlertConditionEvaluator, NewsCondition } from '../types.js';

export function createNewsConditionEvaluator(
  newsAggregator: NewsAggregator,
  circuitBreaker: CircuitBreaker,
): AlertConditionEvaluator<NewsCondition> {
  return {
    type: 'news',
    async evaluate(condition) {
      const news = await circuitBreaker.execute(() =>
        newsAggregator.fetchNews({
          symbols: condition.symbols as TickerSymbol[] | undefined,
          keywords: condition.keywords as string[],
          limit: 10,
          fromDate: new Date(Date.now() - 3_600_000),
        }),
      );
      const filtered = condition.excludeKeywords?.length
        ? news.filter((item) => {
            const text = `${item.title} ${item.summary ?? ''}`.toLowerCase();
            return !condition.excludeKeywords?.some((kw) => text.includes(kw.toLowerCase()));
          })
        : news;
      const triggered = filtered.length > 0;
      return {
        triggered,
        currentValue: String(filtered.length),
        message: triggered
          ? `키워드 [${condition.keywords.join(', ')}] 관련 뉴스 ${filtered.length}건 발견: "${filtered[0]?.title}"`
          : `키워드 [${condition.keywords.join(', ')}] 관련 뉴스 없음 (최근 1시간)`,
      };
    },
  };
}
