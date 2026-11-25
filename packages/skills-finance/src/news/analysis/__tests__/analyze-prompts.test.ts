import { describe, expect, it } from 'vitest';
import { z } from 'zod/v4';
import { loadAnalysisPrompt } from '../prompt-loader.js';

const EvidenceSchema = z.array(z.number().int().min(1)).default([]);
const AnalysisResponseSchema = z.object({
  summary: z.string(),
  summaryEvidence: EvidenceSchema,
  sentiment: z.object({
    score: z.number().min(-1).max(1),
    label: z.enum(['very_negative', 'negative', 'neutral', 'positive', 'very_positive']),
    confidence: z.number().min(0).max(1),
    rationale: z.string(),
    evidence: EvidenceSchema,
  }),
  keyFactors: z.array(
    z.object({
      factor: z.string(),
      impact: z.enum(['high', 'medium', 'low']),
      evidence: EvidenceSchema,
    }),
  ),
  risks: z.array(
    z.object({
      risk: z.string(),
      category: z.enum(['regulatory', 'market', 'company', 'macro']),
      probability: z.enum(['low', 'medium', 'high']),
      evidence: EvidenceSchema,
    }),
  ),
  opportunities: z.array(
    z.object({
      opportunity: z.string(),
      impact: z.enum(['high', 'medium', 'low']),
      evidence: EvidenceSchema,
    }),
  ),
  timeHorizon: z.enum(['short_term', 'medium_term', 'long_term']),
  dataGaps: z.array(z.string()).default([]),
});

const validMockResponse = {
  summary: 'mock summary',
  summaryEvidence: [1],
  sentiment: {
    score: 0.1,
    label: 'neutral' as const,
    confidence: 0.7,
    rationale: 'mock',
    evidence: [1],
  },
  keyFactors: [{ factor: 'f', impact: 'high' as const, evidence: [1] }],
  risks: [
    { risk: 'r', category: 'market' as const, probability: 'medium' as const, evidence: [1] },
  ],
  opportunities: [{ opportunity: 'o', impact: 'low' as const, evidence: [2] }],
  timeHorizon: 'short_term' as const,
  dataGaps: [],
};

describe('analyze prompt (standard.ko) persona + schema integrity', () => {
  it('embeds the 5 persona principles in the header', async () => {
    const text = await loadAnalysisPrompt();
    for (const kw of [
      'CITE EVERY CLAIM',
      'NO HALLUCINATION',
      'QUANTIFY UNCERTAINTY',
      'READ-ONLY',
      'CONCISE',
    ]) {
      expect(text).toContain(kw);
    }
  });

  it('response-format names every Zod field', async () => {
    const text = await loadAnalysisPrompt();
    for (const field of [
      'summary',
      'summaryEvidence',
      'sentiment',
      'keyFactors',
      'risks',
      'opportunities',
      'timeHorizon',
      'dataGaps',
      'rationale',
      'evidence',
      'impact',
      'category',
      'probability',
    ]) {
      expect(text).toContain(field);
    }
  });
});

describe('AnalysisResponseSchema (mirrors market-analysis.ts)', () => {
  it('valid mock passes', () => {
    expect(AnalysisResponseSchema.safeParse(validMockResponse).success).toBe(true);
  });

  it('rejects unknown risk category', () => {
    const bad = {
      ...validMockResponse,
      risks: [{ risk: 'r', category: 'bogus', probability: 'medium' as const, evidence: [1] }],
    };
    expect(AnalysisResponseSchema.safeParse(bad).success).toBe(false);
  });

  it('rejects flat string keyFactors (regression guard for old schema)', () => {
    const bad = { ...validMockResponse, keyFactors: ['old format'] };
    expect(AnalysisResponseSchema.safeParse(bad).success).toBe(false);
  });

  it('rejects missing rationale on sentiment (new field)', () => {
    const { rationale: _r, ...sentimentNoRationale } = validMockResponse.sentiment;
    const bad = { ...validMockResponse, sentiment: sentimentNoRationale };
    expect(AnalysisResponseSchema.safeParse(bad).success).toBe(false);
  });

  it('rejects missing timeHorizon (new required field)', () => {
    const { timeHorizon: _t, ...rest } = validMockResponse;
    expect(AnalysisResponseSchema.safeParse(rest).success).toBe(false);
  });
});
