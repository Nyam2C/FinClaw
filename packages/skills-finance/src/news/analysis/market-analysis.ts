// packages/skills-finance/src/news/analysis/market-analysis.ts
import type Anthropic from '@anthropic-ai/sdk';
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

export async function analyzeMarket(
  client: Anthropic,
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

  let message;
  try {
    message = await client.messages.create({
      model: modelRef.model,
      max_tokens: depth === 'brief' ? 500 : depth === 'detailed' ? 2000 : 1000,
      system: systemPrompt,
      messages: [{ role: 'user', content: userPrompt }],
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
    recordDeps.profileHealth.recordResult(recordDeps.profileId ?? 'skill-news-analyze', {
      success: true,
      modelId: modelRef.model,
      tokens: { input: message.usage.input_tokens, output: message.usage.output_tokens },
      costUsd: pricing
        ? calculateEstimatedCost(message.usage.input_tokens, message.usage.output_tokens, pricing)
        : 0,
    });
  }

  const text = message.content[0]?.type === 'text' ? message.content[0].text : '';
  const parsed = AnalysisResponseSchema.safeParse(JSON.parse(text));
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
