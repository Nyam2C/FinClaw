// packages/skills-finance/src/news/analysis/sentiment.ts
import type Anthropic from '@anthropic-ai/sdk';
import type { NewsItem, NewsSentiment } from '@finclaw/types';
import { z } from 'zod/v4';

const LlmSentimentSchema = z.object({
  score: z.number().min(-1).max(1),
  label: z.enum(['very_negative', 'negative', 'neutral', 'positive', 'very_positive']),
  confidence: z.number().min(0).max(1),
});

/** 규칙 기반 + LLM 하이브리드 감성 분석 */
export async function analyzeSentiment(
  news: readonly NewsItem[],
  client?: Anthropic,
): Promise<NewsSentiment> {
  // 1단계: 규칙 기반 빠른 분석
  const ruleBasedScore = computeRuleBasedSentiment(news);

  // 2단계: LLM 사용 가능하면 정밀 분석
  if (client) {
    try {
      return await computeLlmSentiment(client, news, ruleBasedScore);
    } catch {
      // LLM 실패 시 규칙 기반 폴백
    }
  }

  return {
    score: ruleBasedScore,
    label: scoreToLabel(ruleBasedScore),
    confidence: 0.6,
  };
}

// ─── 규칙 기반 ───

const POSITIVE_KEYWORDS = [
  'surge',
  'rally',
  'breakout',
  'upgrade',
  'beat',
  'record high',
  'growth',
  'bullish',
  'outperform',
  'buy',
  '상승',
  '급등',
  '돌파',
];

const NEGATIVE_KEYWORDS = [
  'crash',
  'plunge',
  'downgrade',
  'miss',
  'selloff',
  'bear',
  'decline',
  'loss',
  'cut',
  'recession',
  '하락',
  '급락',
  '폭락',
];

export function computeRuleBasedSentiment(news: readonly NewsItem[]): number {
  let positiveCount = 0;
  let negativeCount = 0;

  for (const item of news) {
    const text = (item.title + ' ' + (item.summary ?? '')).toLowerCase();
    for (const kw of POSITIVE_KEYWORDS) {
      if (text.includes(kw)) {
        positiveCount++;
      }
    }
    for (const kw of NEGATIVE_KEYWORDS) {
      if (text.includes(kw)) {
        negativeCount++;
      }
    }
  }

  const total = positiveCount + negativeCount;
  if (total === 0) {
    return 0;
  }
  return (positiveCount - negativeCount) / total;
}

/** 5단계 감성 라벨 */
export function scoreToLabel(score: number): NewsSentiment['label'] {
  if (score >= 0.6) {
    return 'very_positive';
  }
  if (score >= 0.2) {
    return 'positive';
  }
  if (score <= -0.6) {
    return 'very_negative';
  }
  if (score <= -0.2) {
    return 'negative';
  }
  return 'neutral';
}

// ─── LLM 기반 ───

async function computeLlmSentiment(
  client: Anthropic,
  news: readonly NewsItem[],
  ruleBasedHint: number,
): Promise<NewsSentiment> {
  const digest = news
    .slice(0, 15)
    .map((item) => `- ${item.title}`)
    .join('\n');

  const message = await client.messages.create({
    model: 'claude-sonnet-4-20250514',
    max_tokens: 200,
    system: `You are a financial sentiment analyzer. Analyze news headlines and return JSON: {"score": -1.0~1.0, "label": "very_negative|negative|neutral|positive|very_positive", "confidence": 0.0~1.0}. Rule-based hint score: ${ruleBasedHint.toFixed(2)}.`,
    messages: [{ role: 'user', content: `Analyze sentiment of these headlines:\n${digest}` }],
  });

  const text = message.content[0]?.type === 'text' ? message.content[0].text : '';
  const parsed = LlmSentimentSchema.safeParse(JSON.parse(text));
  if (!parsed.success) {
    throw new Error(`LLM sentiment validation failed: ${parsed.error.message}`);
  }

  return parsed.data;
}
