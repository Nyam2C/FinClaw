import type { CircuitBreaker } from '@finclaw/infra';
import { describe, it, expect, vi } from 'vitest';
import type { NewsAggregator } from '../../news/types.js';
import type {
  AlertMarketService,
  PriceCondition,
  ChangeCondition,
  VolumeCondition,
  NewsCondition,
} from '../types.js';
import { createChangeConditionEvaluator } from '../conditions/change.js';
import { createNewsConditionEvaluator } from '../conditions/news.js';
import { createPriceConditionEvaluator } from '../conditions/price.js';
import { createVolumeConditionEvaluator } from '../conditions/volume.js';

function mockMarketService(quote: {
  price: number;
  changePercent: number;
  volume: number;
}): AlertMarketService {
  return { getQuote: vi.fn().mockResolvedValue(quote) };
}

function passThroughCB(): CircuitBreaker {
  return { execute: (fn: () => Promise<unknown>) => fn() } as unknown as CircuitBreaker;
}

describe('PriceConditionEvaluator', () => {
  const condition: PriceCondition = {
    type: 'price',
    ticker: 'AAPL',
    direction: 'above',
    threshold: 200,
  };

  it('above — price >= threshold → triggered', async () => {
    const evaluator = createPriceConditionEvaluator(
      mockMarketService({ price: 210, changePercent: 1, volume: 1000 }),
      passThroughCB(),
    );
    const result = await evaluator.evaluate(condition);
    expect(result.triggered).toBe(true);
  });

  it('above — price < threshold → not triggered', async () => {
    const evaluator = createPriceConditionEvaluator(
      mockMarketService({ price: 190, changePercent: 1, volume: 1000 }),
      passThroughCB(),
    );
    const result = await evaluator.evaluate(condition);
    expect(result.triggered).toBe(false);
  });

  it('above — 경계값 (price === threshold) → triggered', async () => {
    const evaluator = createPriceConditionEvaluator(
      mockMarketService({ price: 200, changePercent: 1, volume: 1000 }),
      passThroughCB(),
    );
    const result = await evaluator.evaluate(condition);
    expect(result.triggered).toBe(true);
  });

  it('below — price <= threshold → triggered', async () => {
    const belowCondition: PriceCondition = { ...condition, direction: 'below' };
    const evaluator = createPriceConditionEvaluator(
      mockMarketService({ price: 190, changePercent: 1, volume: 1000 }),
      passThroughCB(),
    );
    const result = await evaluator.evaluate(belowCondition);
    expect(result.triggered).toBe(true);
  });
});

describe('ChangeConditionEvaluator', () => {
  const condition: ChangeCondition = {
    type: 'change',
    ticker: 'AAPL',
    thresholdPercent: 5,
    direction: 'up',
  };

  it('up — changePercent >= thresholdPercent → triggered', async () => {
    const evaluator = createChangeConditionEvaluator(
      mockMarketService({ price: 200, changePercent: 6, volume: 1000 }),
      passThroughCB(),
    );
    const result = await evaluator.evaluate(condition);
    expect(result.triggered).toBe(true);
  });

  it('down — 음수 changePercent 처리', async () => {
    const downCondition: ChangeCondition = { ...condition, direction: 'down' };
    const evaluator = createChangeConditionEvaluator(
      mockMarketService({ price: 200, changePercent: -6, volume: 1000 }),
      passThroughCB(),
    );
    const result = await evaluator.evaluate(downCondition);
    expect(result.triggered).toBe(true);
  });

  it('both — 절대값 기준', async () => {
    const bothCondition: ChangeCondition = { ...condition, direction: 'both' };
    const evaluator = createChangeConditionEvaluator(
      mockMarketService({ price: 200, changePercent: -5, volume: 1000 }),
      passThroughCB(),
    );
    const result = await evaluator.evaluate(bothCondition);
    expect(result.triggered).toBe(true);
  });
});

describe('VolumeConditionEvaluator', () => {
  const condition: VolumeCondition = { type: 'volume', ticker: 'AAPL', multiplier: 2 };

  it('항상 triggered:false, 메시지에 "미지원" 포함', async () => {
    const evaluator = createVolumeConditionEvaluator(
      mockMarketService({ price: 200, changePercent: 1, volume: 5_000_000 }),
    );
    const result = await evaluator.evaluate(condition);
    expect(result.triggered).toBe(false);
    expect(result.message).toContain('미지원');
  });
});

describe('NewsConditionEvaluator', () => {
  const condition: NewsCondition = { type: 'news', keywords: ['실적', '배당'] };

  it('뉴스 있을 때 triggered', async () => {
    const aggregator: NewsAggregator = {
      fetchNews: vi.fn().mockResolvedValue([
        {
          title: '삼성전자 실적 발표',
          source: 'test',
          url: 'http://test.com',
          publishedAt: new Date(),
        },
      ]),
    };
    const evaluator = createNewsConditionEvaluator(aggregator, passThroughCB());
    const result = await evaluator.evaluate(condition);
    expect(result.triggered).toBe(true);
    expect(result.currentValue).toBe('1');
  });

  it('뉴스 없을 때 false', async () => {
    const aggregator: NewsAggregator = { fetchNews: vi.fn().mockResolvedValue([]) };
    const evaluator = createNewsConditionEvaluator(aggregator, passThroughCB());
    const result = await evaluator.evaluate(condition);
    expect(result.triggered).toBe(false);
  });

  it('excludeKeywords 필터링', async () => {
    const conditionWithExclude: NewsCondition = { ...condition, excludeKeywords: ['실적'] };
    const aggregator: NewsAggregator = {
      fetchNews: vi.fn().mockResolvedValue([
        {
          title: '삼성전자 실적 발표',
          source: 'test',
          url: 'http://test.com',
          publishedAt: new Date(),
        },
      ]),
    };
    const evaluator = createNewsConditionEvaluator(aggregator, passThroughCB());
    const result = await evaluator.evaluate(conditionWithExclude);
    expect(result.triggered).toBe(false);
  });
});
