// packages/agent/src/router/llm-router.ts
// Phase 34: 키워드 inferRole 을 대체하는 소형 라우터 LLM (SDK Haiku 고정).
// 메인 LLM 호출 직전 1회 호출 → {intent, modelTier, allowedToolNames, reason}.
// 도구 불필요(allowedToolNames=[]) 시 메인 호출에서 도구 정의 미전달 → 인풋 토큰 절감.

import type { ModelTier } from '@finclaw/types';
import { z } from 'zod';
import type { ProviderAdapter } from '../providers/adapter.js';

/** 라우터가 분류하는 의도. 어휘 매핑 표(A3)로 {modelTier, allowedToolNames} 결정. */
export type RouterIntent = 'greeting' | 'fetch' | 'analysis' | 'portfolio' | 'memory' | 'other';

/** 라우터 LLM 의 검증된 출력. allowedToolNames 빈 배열이면 메인 호출에서 도구 미전달. */
export interface RouterDecision {
  readonly intent: RouterIntent;
  readonly modelTier: ModelTier;
  readonly allowedToolNames: ReadonlyArray<string>;
  readonly reason: string;
  /** 라우터 LLM 자체 토큰 (비용 별도 누적 — D-0). 폴백 경로면 0. */
  readonly routerUsage: { readonly inputTokens: number; readonly outputTokens: number };
  /** true 면 라우터 LLM 실패 → inferRole 키워드 폴백으로 결정됨 (B-2). */
  readonly fallback: boolean;
}

/** 라우터 호출 입력. */
export interface RouterInput {
  readonly message: string;
  /** 현재 세션에서 노출 가능한 전체 도구명 (라우터가 이 중에서 화이트리스트 선택). */
  readonly availableToolNames: ReadonlyArray<string>;
}

/** Haiku 고정 모델 ID — routing.ts tierToModelId('haiku') 와 동기. */
export const ROUTER_MODEL_ID = 'claude-haiku-4-5-20251001';

/** LLM 라우터 facade. 구현은 createLlmRouter (provider 주입 클로저). */
export type LlmRouter = (input: RouterInput) => Promise<RouterDecision>;

// ── 라우터 LLM JSON 출력 스키마 (D-0: JSON mode 부재 → JSON.parse + zod 검증) ──
const RouterIntentSchema = z.enum([
  'greeting',
  'fetch',
  'analysis',
  'portfolio',
  'memory',
  'other',
]);

const RouterOutputSchema = z.object({
  intent: RouterIntentSchema,
  reason: z.string().max(200),
});
type RouterOutput = z.infer<typeof RouterOutputSchema>;

/**
 * 라우터 시스템 프롬프트. JSON mode 부재 → "오직 JSON 만 출력" 강제.
 * intent 만 분류시키고 modelTier/allowedToolNames 는 코드 매핑(A3)으로 결정 —
 * LLM 이 도구명을 환각하는 위험 차단 + 결정론성 확보.
 */
function buildRouterSystemPrompt(): string {
  return [
    '너는 금융 비서의 요청 분류기다. 사용자 발화를 아래 6개 intent 중 하나로 분류한다.',
    '',
    '- greeting: 인사·잡담·도구 불필요한 일반 대화 ("안녕", "고마워", "넌 누구야")',
    '- fetch: 단순 시세/가격/환율/차트 조회 ("삼성전자 얼마", "환율 알려줘")',
    '- analysis: 분석/판단/리포트/추천 요청 ("삼성전자 어때?", "지금 사도 돼?")',
    '- portfolio: 보유 종목·자산·수익률 관련 ("내 포트폴리오", "수익률 어때")',
    '- memory: 과거 선호/대화 회상 ("내가 전에 뭐라 했지", "내 투자 성향")',
    '- other: 위 어디에도 안 맞음',
    '',
    '반드시 아래 형식의 JSON 만 출력하라. 다른 텍스트 금지.',
    '{"intent": "<6개 중 하나>", "reason": "<분류 근거 한 줄, 한국어>"}',
  ].join('\n');
}

// ── intent → 라우팅 정책 매핑 (신규 산출물, 어휘 매핑) ──
// allowedTools: 해당 intent 에 노출할 도구명 prefix/정확명. availableToolNames 와 교집합.
// 빈 배열 = 도구 미전달 (chit-chat 비용 최소화).
//
// 도구명은 skills-finance 의 실제 등록명 기준 (market/news/alerts/brokerage tools).
// '*' prefix 매칭으로 신규 도구 자동 포함, 정확명은 그대로.
interface IntentPolicy {
  readonly modelTier: ModelTier;
  /** 도구명 매칭 패턴 ('*' = 전부, prefix 'get_'·정확명). 빈 배열 = 도구 미전달. */
  readonly toolPatterns: ReadonlyArray<string>;
}

const INTENT_POLICY: Record<RouterIntent, IntentPolicy> = {
  greeting: { modelTier: 'haiku', toolPatterns: [] }, // 도구 미전달
  fetch: { modelTier: 'haiku', toolPatterns: ['get_', 'quote', 'price', 'rate', 'chart'] },
  analysis: { modelTier: 'sonnet', toolPatterns: ['*'] }, // 모든 도구 (analyze 포함)
  portfolio: { modelTier: 'sonnet', toolPatterns: ['get_', 'portfolio', 'holding'] },
  memory: { modelTier: 'haiku', toolPatterns: [] }, // 메모리는 RAG 가 system prompt 로 주입
  other: { modelTier: 'haiku', toolPatterns: [] },
};

/** intent + 사용 가능 도구명 → allowedToolNames (환각 도구명 제거 위해 교집합). */
function resolveAllowedToolNames(
  intent: RouterIntent,
  availableToolNames: ReadonlyArray<string>,
): string[] {
  const { toolPatterns } = INTENT_POLICY[intent];
  if (toolPatterns.length === 0) {
    return [];
  }
  if (toolPatterns.includes('*')) {
    return [...availableToolNames];
  }
  return availableToolNames.filter((name) =>
    toolPatterns.some((p) => name === p || name.startsWith(p)),
  );
}

/**
 * SDK Haiku 고정 라우터 생성 (B-0). provider 는 server 가 sdkAdapter 를 주입.
 * - 도구 미전달 (라우터는 분류만).
 * - JSON.parse + zod 검증, 실패 시 1회 재시도 (D-0).
 * - 2회 모두 실패 시 throw → 호출자가 inferRole 폴백 (B-2).
 */
export function createLlmRouter(provider: ProviderAdapter): LlmRouter {
  const systemPrompt = buildRouterSystemPrompt();

  return async (input: RouterInput): Promise<RouterDecision> => {
    let lastErr: unknown;
    let inputTokens = 0;
    let outputTokens = 0;
    for (let attempt = 0; attempt < 2; attempt++) {
      const raw = await provider.chatCompletion({
        model: ROUTER_MODEL_ID,
        systemPrompt,
        messages: [{ role: 'user', content: input.message }],
        maxTokens: 200,
        temperature: 0,
        // tools 미전달 — 도구 사용 안 함 (분류 전용).
      });
      const { text, usage } = extractRouterResponse(raw);
      inputTokens += usage.inputTokens;
      outputTokens += usage.outputTokens;
      const parsed = parseRouterOutput(text);
      if (parsed) {
        return {
          intent: parsed.intent,
          modelTier: INTENT_POLICY[parsed.intent].modelTier,
          allowedToolNames: resolveAllowedToolNames(parsed.intent, input.availableToolNames),
          reason: parsed.reason,
          routerUsage: { inputTokens, outputTokens },
          fallback: false,
        };
      }
      lastErr = new Error('router output failed zod validation');
    }
    throw lastErr instanceof Error ? lastErr : new Error('router failed');
  };
}

/** chatCompletion 의 unknown 응답에서 text + usage 추출 (Anthropic Messages 형태). */
function extractRouterResponse(raw: unknown): {
  text: string;
  usage: { inputTokens: number; outputTokens: number };
} {
  const r = raw as {
    content?: Array<{ type: string; text?: string }>;
    usage?: { input_tokens?: number; output_tokens?: number };
  };
  const text =
    r.content
      ?.filter((b) => b.type === 'text')
      .map((b) => b.text ?? '')
      .join('') ?? '';
  return {
    text,
    usage: {
      inputTokens: r.usage?.input_tokens ?? 0,
      outputTokens: r.usage?.output_tokens ?? 0,
    },
  };
}

/** JSON 추출(코드펜스/잡텍스트 방어) + zod 검증. 실패 시 null. */
function parseRouterOutput(text: string): RouterOutput | null {
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) {
    return null;
  }
  try {
    const result = RouterOutputSchema.safeParse(JSON.parse(match[0]));
    return result.success ? result.data : null;
  } catch {
    return null;
  }
}
