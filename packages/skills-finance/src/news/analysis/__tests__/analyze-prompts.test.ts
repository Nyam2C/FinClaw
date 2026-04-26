import { describe, expect, it } from 'vitest';
import { z } from 'zod/v4';
import { loadAnalysisPrompt, type AnalysisDepth, type AnalysisLanguage } from '../prompt-loader.js';

// market-analysis.ts 내부와 동일 스키마 — 프롬프트가 명세하는 응답 형식이
// 실제 코드 검증 스키마와 어긋나지 않는지 보장하는 회귀 가드.
const AnalysisResponseSchema = z.object({
  summary: z.string(),
  sentiment: z.object({
    score: z.number().min(-1).max(1),
    label: z.enum(['very_negative', 'negative', 'neutral', 'positive', 'very_positive']),
    confidence: z.number().min(0).max(1),
  }),
  keyFactors: z.array(z.string()),
  risks: z.array(z.string()),
  opportunities: z.array(z.string()),
});

const validMockResponse = {
  summary: 'mock summary',
  sentiment: { score: 0.1, label: 'neutral' as const, confidence: 0.7 },
  keyFactors: ['factor1'],
  risks: ['risk1'],
  opportunities: ['opp1'],
};

describe('analyze prompts (6 variants × Zod schema fields)', () => {
  const depths: readonly AnalysisDepth[] = ['brief', 'standard', 'detailed'];
  const langs: readonly AnalysisLanguage[] = ['ko', 'en'];

  for (const d of depths) {
    for (const l of langs) {
      it(`${d}.${l} 프롬프트가 응답 스키마의 모든 필드명을 명세함`, async () => {
        const text = await loadAnalysisPrompt(d, l);
        for (const field of ['summary', 'sentiment', 'keyFactors', 'risks', 'opportunities']) {
          expect(text).toContain(field);
        }
      });
    }
  }

  it('mock 응답이 Zod 스키마를 통과 (회귀 가드)', () => {
    expect(AnalysisResponseSchema.safeParse(validMockResponse).success).toBe(true);
  });

  it('잘못된 sentiment label 은 Zod 가 거부', () => {
    const bad = {
      ...validMockResponse,
      sentiment: { ...validMockResponse.sentiment, label: 'wrong' },
    };
    expect(AnalysisResponseSchema.safeParse(bad).success).toBe(false);
  });
});
