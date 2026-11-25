// packages/skills-finance/src/news/analysis/market-analysis.ts
import type { ModelRef, NewsItem } from '@finclaw/types';
import { z } from 'zod/v4';
import type { MarketAnalysis, AnalysisOptions } from '../types.js';
import { loadAnalysisPrompt } from './prompt-loader.js';

/** Phase 41: market_analysis 의 LLM 실행 추상화 — route_task 가 runSubAgent 주입, 테스트는 mock 주입. */
export interface AnalyzeRunnerRequest {
  readonly systemPrompt: string;
  readonly prompt: string;
  readonly modelId: string;
}
export interface AnalyzeRunnerResult {
  readonly text: string;
}
export type AnalyzeRunner = (req: AnalyzeRunnerRequest) => Promise<AnalyzeRunnerResult>;

const EvidenceSchema = z.array(z.number().int().min(1)).default([]);
const ImpactSchema = z.enum(['high', 'medium', 'low']);
const ProbabilitySchema = z.enum(['low', 'medium', 'high']);
const RiskCategorySchema = z.enum(['regulatory', 'market', 'company', 'macro']);
const TimeHorizonSchema = z.enum(['short_term', 'medium_term', 'long_term']);

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
      impact: ImpactSchema,
      evidence: EvidenceSchema,
    }),
  ),
  risks: z.array(
    z.object({
      risk: z.string(),
      category: RiskCategorySchema,
      probability: ProbabilitySchema,
      evidence: EvidenceSchema,
    }),
  ),
  opportunities: z.array(
    z.object({
      opportunity: z.string(),
      impact: ImpactSchema,
      evidence: EvidenceSchema,
    }),
  ),
  timeHorizon: TimeHorizonSchema,
  dataGaps: z.array(z.string()).default([]),
});

export async function analyzeMarket(
  runAnalysis: AnalyzeRunner,
  news: readonly NewsItem[],
  options: AnalysisOptions,
  modelRef: ModelRef,
): Promise<MarketAnalysis> {
  const newsDigest = news
    .slice(0, 30)
    .map(
      (item, i) =>
        `[${i + 1}] ${item.title} (${item.source}, ${item.publishedAt})\n${item.summary ?? ''}`,
    )
    .join('\n\n');

  const systemPrompt = await loadAnalysisPrompt();
  const userPrompt = buildAnalysisUserPrompt(newsDigest, options.symbols);

  const result = await runAnalysis({
    systemPrompt,
    prompt: userPrompt,
    modelId: modelRef.model,
  });

  const parsed = AnalysisResponseSchema.safeParse(JSON.parse(result.text));
  if (!parsed.success) {
    throw new Error(`LLM response validation failed: ${parsed.error.message}`);
  }

  return {
    ...parsed.data,
    analyzedAt: new Date(),
    newsCount: news.length,
    symbols: options.symbols ?? [],
  };
}

// ─── 프롬프트 빌더 ───

function buildAnalysisUserPrompt(
  newsDigest: string,
  symbols?: readonly import('@finclaw/types').TickerSymbol[],
): string {
  let prompt = `Analyze the following financial news:\n\n${newsDigest}`;

  if (symbols?.length) {
    prompt += `\n\nFocus especially on these symbols: ${(symbols as readonly string[]).join(', ')}`;
  }

  return prompt;
}
