// packages/skills-finance/src/news/analysis/market-analysis.ts
import type { ModelCatalog, ProfileHealthMonitor } from '@finclaw/agent';
import { calculateEstimatedCost } from '@finclaw/agent';
import type { ModelRef, NewsItem } from '@finclaw/types';
import { z } from 'zod/v4';
import type { MarketAnalysis, AnalysisOptions } from '../types.js';
import { loadAnalysisPrompt } from './prompt-loader.js';

/** Phase 24 E: 스킬 내부 LLM 호출 건강·비용 기록을 위한 선택적 의존성. */
export interface AnalysisRecordDeps {
  readonly profileHealth?: ProfileHealthMonitor;
  readonly profileId?: string;
  readonly modelCatalog?: ModelCatalog;
}

/** Phase 41: analyze_market 의 LLM 실행 추상화 — runCliAgent 기본 주입, 테스트는 mock 주입. */
export interface AnalyzeRunnerRequest {
  readonly systemPrompt: string;
  readonly prompt: string;
  readonly modelId: string;
  readonly timeoutMs?: number;
}
export interface AnalyzeRunnerResult {
  readonly text: string;
  readonly usage?: { readonly input: number; readonly output: number };
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
  recordDeps?: AnalysisRecordDeps,
): Promise<MarketAnalysis> {
  const depth = options.depth ?? 'standard';
  const language = options.language ?? 'ko';

  const newsDigest = news
    .slice(0, 30)
    .map(
      (item, i) =>
        `[${i + 1}] ${item.title} (${item.source}, ${item.publishedAt})\n${item.summary ?? ''}`,
    )
    .join('\n\n');

  const systemPrompt = await loadAnalysisPrompt(depth, language);
  const userPrompt = buildAnalysisUserPrompt(
    newsDigest,
    options.symbols,
    options.includeIndicators,
  );

  let result: AnalyzeRunnerResult;
  try {
    result = await runAnalysis({
      systemPrompt,
      prompt: userPrompt,
      modelId: modelRef.model,
      timeoutMs: 30_000,
    });
  } catch (err) {
    // Phase 24 E: 실패도 기록 — modelId 만 알면 충분 (tokens 0).
    recordDeps?.profileHealth?.recordResult(recordDeps.profileId ?? 'skill-news-analyze', {
      success: false,
      modelId: modelRef.model,
    });
    throw err;
  }

  // Phase 24 E: 성공 호출 기록 — !finclaw status 의 모델 분포에 포함.
  if (recordDeps?.profileHealth) {
    const pricing = recordDeps.modelCatalog?.getModel(modelRef.model)?.pricing;
    const inTok = result.usage?.input ?? 0;
    const outTok = result.usage?.output ?? 0;
    recordDeps.profileHealth.recordResult(recordDeps.profileId ?? 'skill-news-analyze', {
      success: true,
      modelId: modelRef.model,
      tokens: { input: inTok, output: outTok },
      costUsd: pricing ? calculateEstimatedCost(inTok, outTok, pricing) : 0,
    });
  }

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
  includeIndicators?: boolean,
): string {
  let prompt = `Analyze the following financial news:\n\n${newsDigest}`;

  if (symbols?.length) {
    prompt += `\n\nFocus especially on these symbols: ${(symbols as readonly string[]).join(', ')}`;
  }

  if (includeIndicators) {
    prompt += '\n\nInclude technical indicator interpretation in your analysis if relevant.';
  }

  return prompt;
}
