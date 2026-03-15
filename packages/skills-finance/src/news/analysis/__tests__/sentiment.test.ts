import type { NewsItem } from '@finclaw/types';
import { createTimestamp } from '@finclaw/types';
// packages/skills-finance/src/news/analysis/__tests__/sentiment.test.ts
import { describe, it, expect } from 'vitest';
import { computeRuleBasedSentiment, scoreToLabel, analyzeSentiment } from '../sentiment.js';

function makeNews(titles: string[]): NewsItem[] {
  return titles.map((title, i) => ({
    id: `test-${i}`,
    title,
    url: `https://example.com/${i}`,
    source: 'test',
    publishedAt: createTimestamp(Date.now()),
  }));
}

describe('sentiment', () => {
  describe('computeRuleBasedSentiment', () => {
    it('긍정 키워드만 있으면 양수를 반환한다', () => {
      const news = makeNews(['Market surge continues', 'Bullish rally ahead']);
      const score = computeRuleBasedSentiment(news);
      expect(score).toBeGreaterThan(0);
    });

    it('부정 키워드만 있으면 음수를 반환한다', () => {
      const news = makeNews(['Market crash deepens', 'Bear market confirmed']);
      const score = computeRuleBasedSentiment(news);
      expect(score).toBeLessThan(0);
    });

    it('키워드가 없으면 0을 반환한다', () => {
      const news = makeNews(['Nothing special happened today']);
      const score = computeRuleBasedSentiment(news);
      expect(score).toBe(0);
    });

    it('한국어 키워드도 감지한다', () => {
      const news = makeNews(['코스피 급등, 삼성전자 상승']);
      const score = computeRuleBasedSentiment(news);
      expect(score).toBeGreaterThan(0);
    });

    it('긍정/부정 균형이면 0에 가깝다', () => {
      const news = makeNews(['Market surge then crash']);
      const score = computeRuleBasedSentiment(news);
      expect(Math.abs(score)).toBeLessThanOrEqual(0.5);
    });
  });

  describe('scoreToLabel', () => {
    it('0.6 이상이면 very_positive', () => {
      expect(scoreToLabel(0.8)).toBe('very_positive');
    });

    it('0.2~0.6이면 positive', () => {
      expect(scoreToLabel(0.4)).toBe('positive');
    });

    it('-0.2~0.2이면 neutral', () => {
      expect(scoreToLabel(0)).toBe('neutral');
      expect(scoreToLabel(0.1)).toBe('neutral');
    });

    it('-0.6~-0.2이면 negative', () => {
      expect(scoreToLabel(-0.3)).toBe('negative');
    });

    it('-0.6 이하이면 very_negative', () => {
      expect(scoreToLabel(-0.8)).toBe('very_negative');
    });
  });

  describe('analyzeSentiment', () => {
    it('LLM 없이 규칙 기반 결과를 반환한다', async () => {
      const news = makeNews(['Stock surge', 'Bull rally']);
      const result = await analyzeSentiment(news);

      expect(result.score).toBeGreaterThan(0);
      expect(result.confidence).toBe(0.6);
      expect(['positive', 'very_positive']).toContain(result.label);
    });
  });
});
