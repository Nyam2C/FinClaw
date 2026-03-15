// packages/skills-finance/src/news/analysis/market-analysis.ts
import type Anthropic from '@anthropic-ai/sdk';
import type { NewsItem } from '@finclaw/types';
import { z } from 'zod/v4';
import type { MarketAnalysis, AnalysisOptions } from '../types.js';

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

  const systemPrompt = buildAnalysisSystemPrompt(depth, language);
  const userPrompt = buildAnalysisUserPrompt(
    newsDigest,
    options.symbols,
    options.includeIndicators,
  );

  const message = await client.messages.create({
    model: 'claude-sonnet-4-20250514',
    max_tokens: depth === 'brief' ? 500 : depth === 'detailed' ? 2000 : 1000,
    system: systemPrompt,
    messages: [{ role: 'user', content: userPrompt }],
  });

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

function buildAnalysisSystemPrompt(depth: string, language: string): string {
  const langInstruction =
    language === 'ko' ? '한국어로 분석 결과를 작성하세요.' : 'Write analysis results in English.';

  const depthInstruction =
    depth === 'brief'
      ? 'Be concise, 1-2 sentences per field.'
      : depth === 'detailed'
        ? 'Provide thorough analysis with multiple paragraphs for summary.'
        : 'Provide a balanced, moderate-length analysis.';

  return `You are a professional financial market analyst. Analyze the provided news articles and generate a market analysis report.
${langInstruction}
${depthInstruction}

Response format (strict JSON, no markdown):
{
  "summary": "시장 전망 요약",
  "sentiment": { "score": -1.0~1.0, "label": "very_negative|negative|neutral|positive|very_positive", "confidence": 0.0~1.0 },
  "keyFactors": ["핵심 요인 1", "핵심 요인 2"],
  "risks": ["리스크 1"],
  "opportunities": ["기회 1"]
}`;
}

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
