# Phase 34 Todo: LLM 오케스트레이터 라우팅 (키워드 휴리스틱 폐기)

> plan.md 의 밀스톤 A~D 를 코드 단위로 분해. **plan.md "## 인스펙션 보강 (post-phase33)" 섹션이 본문(밀스톤 A~D·스키마)의 어긋난 서술을 OVERRIDE** 하며, 본 todo 는 보강을 우선 반영했다.
>
> 핵심 grounding (인스펙션이 교정한 사실):
>
> - 실제 통합 파일은 `packages/server/src/auto-reply/execution-adapter.ts` (plan 이 "execution-adapter.ts" 라 부른 곳).
> - 라우터는 **SDK Haiku 고정** (`sdkAdapter.chatCompletion`, dual-path CLI 안 따름) — B-0.
> - 라우터 출력은 `allowedToolGroups` 아님 → **`allowedToolNames: string[]`** 화이트리스트 — B-1 (tool group 5개 코드 미존재, 전부 `group:'finance'` 단일).
> - `inferRole` 키워드 추론은 **라우터 실패/타임아웃 폴백으로만 잔존**, 정상 경로 비활성 — B-2.
> - `applyRouting`(`:464`) + `applyTuiRouting`(`:502`) **2개 모두** 대체 — B-3.
> - `pipeline.routed` / `tui.routed` 는 **로그 라인** (events.ts 신규 이벤트 불요) — C-0.
> - Anthropic JSON mode 부재 → **프롬프트 강제 + JSON.parse + zod + 1회 재시도** — D-0.

---

## 보강(OVERRIDE) 반영 매핑

| 보강                                                               | 반영 단계                                                                                                                         |
| ------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------- |
| B-0 라우터 = SDK Haiku 고정                                        | A1 (어댑터 인터페이스), B1 (deps.routerLlm 주입), main.ts B6 (sdkAdapter 연결)                                                    |
| B-1 `allowedToolNames` 화이트리스트                                | A2 (RouterResult 스키마), A3 (intent→{tier,allowedToolNames} 매핑), B2/B3 (exposedTools 필터 재사용)                              |
| B-2 inferRole 폴백 잔존                                            | B2 (정상=LLM 라우터, 실패=inferRole 폴백), B4 동일                                                                                |
| B-3 applyRouting + applyTuiRouting 2개 모두 + respectMinModel 폐기 | B2 (applyRouting async 화), B4 (applyTuiRouting async 화), B5 (makeRouterHelper/resolveModelForRequest/respectMinModel 폐기 경로) |
| C-0 로그 라인에 필드 추가                                          | C1 (pipeline.routed), C2 (tui.routed)                                                                                             |
| D-0 JSON parse + zod + 재시도                                      | A4 (parse+검증+재시도 헬퍼)                                                                                                       |
| D-0 비용 별도 누적                                                 | C3 (라우터 Haiku 토큰 로깅), D1~D3 (fixture 비용·정확도 비교)                                                                     |
| 어휘 매핑 intent↔ModelRole                                         | A3 (매핑 테이블 신규 산출물)                                                                                                      |
| 신규 디렉터리 router/                                              | A1                                                                                                                                |

---

## 사전 준비

### P-1. 신규 디렉터리 확인 — `packages/agent/src/router/`

`packages/agent/src/router/` 디렉터리 자체가 신규. `llm-router.ts` 를 이 아래 생성한다 (A1~A4). agent 패키지 의존 그래프상 router 는 `providers/`(ProviderAdapter), `models/routing.ts`(ModelTier/ModelRole) 만 의존 — 역방향 의존 없음. zod 는 이미 agent devDep 아닌 dep (`packages/agent/package.json` `"zod": "^4.0.0"`).

검증: 디렉터리 생성은 A1 의 파일 작성으로 갈음 (`mkdir` 불필요, Write 가 생성).

---

## 밀스톤 A — 라우터 prompt + 호출 헬퍼 (`packages/agent/src/router/llm-router.ts`)

> plan A: "라우터 prompt + 호출 헬퍼. Haiku + JSON + 캐시." 보강: JSON mode 부재 → 프롬프트 강제 + zod + 1회 재시도. 캐시는 plan §비대상(라우터 결과 캐싱 X) → 미구현.

라우터는 agent 패키지에 두되 **provider 를 주입받는 순수 함수** 로 설계 (server 가 sdkAdapter 를 주입). agent 가 server 를 import 하면 의존 역전이므로, 라우터는 `ProviderAdapter` 인터페이스만 의존.

### A1. CREATE `packages/agent/src/router/llm-router.ts` — 타입 + 라우터 인터페이스

```ts
// packages/agent/src/router/llm-router.ts
// Phase 34: 키워드 inferRole 을 대체하는 소형 라우터 LLM (SDK Haiku 고정).
// 메인 LLM 호출 직전 1회 호출 → {intent, modelTier, allowedToolNames, reason}.
// 도구 불필요(allowedToolNames=[]) 시 메인 호출에서 도구 정의 미전달 → 인풋 토큰 절감.

import { z } from 'zod';
import type { ModelTier } from '@finclaw/types';
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
```

검증: `pnpm --filter @finclaw/agent build` (타입만; 다음 단계에서 구현 완성 후 통과)

### A2. EDIT `packages/agent/src/router/llm-router.ts` — zod 스키마 + 시스템 프롬프트

`RouterDecision` 의 LLM 산출 부분만 검증하는 스키마 + 강제 JSON 프롬프트. `routerUsage`/`fallback` 은 코드가 채우므로 스키마 제외.

```ts
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
```

검증: `pnpm --filter @finclaw/agent build`

### A3. EDIT `packages/agent/src/router/llm-router.ts` — intent → {modelTier, allowedToolNames} 매핑 (신규 산출물)

> **어휘 매핑 신규 산출물 (보강).** 라우터 LLM 은 intent 만 분류, 코드가 결정론적으로 tier + 도구 화이트리스트 매핑. allowedToolNames 는 `availableToolNames` 와 교집합하여 환각 도구명 제거.

```ts
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
```

> NOTE(구현자): `toolPatterns` 의 도구명 prefix(`get_`/`quote` 등)는 **현 시점 skills-finance 등록명 기준 추정**. B2 통합 직전 `grep -rn "name:" packages/skills-finance/src` 로 실제 등록명을 확인하고 매핑을 보정할 것. 빈 배열 intent(greeting/memory/other)는 도구명 무관하므로 보정 불요. — questions.md Q1 참조.

검증: `pnpm --filter @finclaw/agent build`

### A4. EDIT `packages/agent/src/router/llm-router.ts` — createLlmRouter (parse + zod + 1회 재시도 + Haiku 직호출)

> **B-0 + D-0 핵심.** `ProviderAdapter.chatCompletion` (= sdkAdapter) 으로 Haiku 직호출. 도구 미전달. JSON.parse → zod 검증 실패 시 1회 재시도. 최종 실패 시 throw (호출자 = execution-adapter 가 inferRole 폴백, B-2).

```ts
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
```

검증: `pnpm --filter @finclaw/agent build`

### A5. EDIT `packages/agent/src/index.ts` — 라우터 barrel export

```ts
// ... 기존 export 끝부분 (Phase 33 News brief 아래) ...

// ── Phase 34: LLM 오케스트레이터 라우터 ──
export { createLlmRouter, ROUTER_MODEL_ID } from './router/llm-router.js';
export type { LlmRouter, RouterIntent, RouterDecision, RouterInput } from './router/llm-router.js';
```

검증: `pnpm --filter @finclaw/agent build`

### A6. CREATE `packages/agent/src/router/__tests__/llm-router.test.ts` — mock provider 단위 테스트 (mock-only)

> **mock-only (CLAUDE.md feedback): 실제 Anthropic 키/네트워크 금지.** mock `ProviderAdapter.chatCompletion` 으로 JSON 응답 주입.

````ts
import type { ProviderAdapter, ProviderRequestParams } from '@finclaw/agent';
import { createLlmRouter } from '@finclaw/agent';
import { describe, it, expect, vi } from 'vitest';

function mockProvider(responses: Array<{ json: unknown; usage?: { i: number; o: number } }>): {
  provider: ProviderAdapter;
  calls: ProviderRequestParams[];
} {
  const calls: ProviderRequestParams[] = [];
  let idx = 0;
  const provider = {
    providerId: 'anthropic' as const,
    async chatCompletion(params: ProviderRequestParams) {
      calls.push(params);
      const r = responses[Math.min(idx++, responses.length - 1)];
      return {
        content: [
          { type: 'text', text: typeof r.json === 'string' ? r.json : JSON.stringify(r.json) },
        ],
        usage: { input_tokens: r.usage?.i ?? 50, output_tokens: r.usage?.o ?? 10 },
      };
    },
    async *streamCompletion() {},
  } as unknown as ProviderAdapter;
  return { provider, calls };
}

describe('createLlmRouter', () => {
  it('greeting → 도구 미전달 (allowedToolNames 빈 배열)', async () => {
    const { provider } = mockProvider([{ json: { intent: 'greeting', reason: '인사' } }]);
    const router = createLlmRouter(provider);
    const d = await router({ message: '안녕', availableToolNames: ['get_stock_price'] });
    expect(d.intent).toBe('greeting');
    expect(d.modelTier).toBe('haiku');
    expect(d.allowedToolNames).toEqual([]);
    expect(d.fallback).toBe(false);
  });

  it('analysis → sonnet + 모든 도구 노출', async () => {
    const { provider } = mockProvider([{ json: { intent: 'analysis', reason: '분석 요청' } }]);
    const router = createLlmRouter(provider);
    const d = await router({
      message: '삼성전자 어때?',
      availableToolNames: ['get_stock_price', 'analyze_market', 'search_news'],
    });
    expect(d.modelTier).toBe('sonnet');
    expect(d.allowedToolNames).toEqual(['get_stock_price', 'analyze_market', 'search_news']);
  });

  it('환각 도구명은 availableToolNames 교집합으로 제거', async () => {
    const { provider } = mockProvider([{ json: { intent: 'fetch', reason: '시세' } }]);
    const router = createLlmRouter(provider);
    const d = await router({
      message: '환율',
      availableToolNames: ['get_exchange_rate'], // patterns 매칭됨
    });
    expect(d.allowedToolNames).toEqual(['get_exchange_rate']);
  });

  it('JSON 코드펜스/잡텍스트 둘러싸여도 파싱', async () => {
    const { provider } = mockProvider([
      { json: '```json\n{"intent":"fetch","reason":"시세"}\n```' },
    ]);
    const router = createLlmRouter(provider);
    const d = await router({ message: '가격', availableToolNames: [] });
    expect(d.intent).toBe('fetch');
  });

  it('zod 검증 실패 시 1회 재시도 (2번째 성공)', async () => {
    const { provider, calls } = mockProvider([
      { json: { intent: 'INVALID', reason: 'x' } }, // 1회차 실패
      { json: { intent: 'other', reason: 'ok' } }, // 2회차 성공
    ]);
    const router = createLlmRouter(provider);
    const d = await router({ message: 'x', availableToolNames: [] });
    expect(calls).toHaveLength(2);
    expect(d.intent).toBe('other');
  });

  it('2회 모두 실패 시 throw (호출자 폴백용)', async () => {
    const { provider } = mockProvider([{ json: { bad: true } }, { json: { bad: true } }]);
    const router = createLlmRouter(provider);
    await expect(router({ message: 'x', availableToolNames: [] })).rejects.toThrow();
  });

  it('routerUsage 토큰 누적 (비용 별도 추적용 — D-0)', async () => {
    const { provider } = mockProvider([
      { json: { intent: 'greeting', reason: 'hi' }, usage: { i: 120, o: 8 } },
    ]);
    const router = createLlmRouter(provider);
    const d = await router({ message: '안녕', availableToolNames: [] });
    expect(d.routerUsage).toEqual({ inputTokens: 120, outputTokens: 8 });
  });
});
````

검증: `pnpm --filter @finclaw/agent test --run`

### A7. 밀스톤 A 검증

다음을 모두 통과해야 다음 밀스톤으로 진입:

- `pnpm --filter @finclaw/agent build`
- `pnpm --filter @finclaw/agent test --run`
- `pnpm typecheck`

---

## 밀스톤 B — execution-adapter 통합 (`packages/server/src/auto-reply/execution-adapter.ts`)

> plan B: "inferRole/applyRouting 폐기, 라우터 결과 주입, 도구 정의 group 단위 필터." 보강 OVERRIDE: ① `allowedToolNames` 화이트리스트(group 아님) ② `applyRouting` + `applyTuiRouting` **둘 다** ③ `inferRole` 은 폴백 잔존 ④ `exposedTools` 필터(`:225-227`) 통합점 재사용 ⑤ 키워드 RouterHelper(`makeRouterHelper`/`resolveModelForRequest`/`respectMinModel`) 경로 폐기.

설계: `RunnerExecutionAdapterDeps` 에 LLM 라우터를 새 필드(`routerLlm?: LlmRouter`)로 주입. 기존 `router?: RouterHelper`(키워드 facade) 는 폴백 경로용으로 **잔존**시키되 정상 경로에서 미사용 — 단, plan/보강이 키워드 경로를 폐기하므로 main.ts 에서 `router` 주입을 제거(B6)하고 `routerLlm` 만 주입. `applyRouting`/`applyTuiRouting` 은 LLM 라우터 호출하도록 async 화.

### B1. EDIT `packages/server/src/auto-reply/execution-adapter.ts` — import + deps 필드 추가

```ts
// ... 기존 import (line 13-24 의 @finclaw/agent) 에 추가 ...
import {
  calculateEstimatedCost,
  compactContext,
  DEFAULT_FALLBACK_TRIGGERS,
  evaluateContextWindow,
  ExecutionToolDispatcher as ToolDispatcherCtor,
  modelIdToTier,
  resolveModel,
  runWithModelFallback,
  tierToModelId, // 추가: routerLlm.modelTier → 모델 ID
  type LlmRouter, // 추가
  type ModelRole,
  type RouterDecision, // 추가
  type TranscriptEntry,
} from '@finclaw/agent';
```

`RunnerExecutionAdapterDeps` 에 필드 추가 (`router?: RouterHelper` 바로 아래, line 185 부근):

```ts
  /**
   * 모델 라우터 (Phase 24) — 키워드 facade. Phase 34 부터 폴백 경로 외 미사용.
   * routerLlm 미주입 시에만 정상 경로 라우팅에 쓰일 수 있으나 main.ts 는 routerLlm 만 주입.
   */
  readonly router?: RouterHelper;
  /**
   * Phase 34: LLM 오케스트레이터 라우터 (SDK Haiku 고정). 주입 시 매 요청마다
   * intent 분류 → {modelTier, allowedToolNames}. 실패 시 inferRole 키워드 폴백 (B-2).
   */
  readonly routerLlm?: LlmRouter;
```

검증: `pnpm --filter @finclaw/server build` (다음 단계까지 미완성 가능 — 최종은 B7)

### B2. EDIT `packages/server/src/auto-reply/execution-adapter.ts` — `applyRouting` async LLM 라우터화 (`:464-496`)

> 기존 `applyRouting`(키워드 `inferRole` → RouterHelper) 를 **LLM 라우터 호출**로 대체. LLM 라우터 실패 시 `inferRole` 폴백(B-2). `chain`/`floor` 는 라우터 `modelTier` 로 구성. `exposedTools` 필터(`:225-227`)는 그대로 재사용.

`execute()` 의 호출부 변경 (`:217-221`) — async 화에 따라 `await`:

```ts
// Phase 34: LLM 라우터 1회 호출 → intent 기반 모델/도구 결정. 실패 시 키워드 폴백.
const routed = await this.applyRouting({
  message: ctx.normalizedBody,
  toolDefinitions,
  automation: false,
});
```

`applyRouting` 본문 교체 (`:464-496` 전체):

```ts
  /**
   * Phase 34: LLM 라우터 호출 → chain + floor + allowedToolNames 구성.
   * - routerLlm 주입: Haiku 라우터 1회 호출. 실패/타임아웃 시 inferRole 키워드 폴백 (B-2).
   * - routerLlm 미주입: undefined (라우터 비활성, 기존 fallbackChain 동작).
   */
  private async applyRouting(args: {
    readonly message: string;
    readonly toolDefinitions: readonly { readonly name: string }[];
    readonly automation: boolean;
  }): Promise<
    | {
        readonly chain: readonly string[];
        readonly floor: ModelTier;
        readonly allowedToolNames: ReadonlyArray<string>;
        readonly routerUsage: { readonly inputTokens: number; readonly outputTokens: number };
      }
    | undefined
  > {
    if (!this.deps.routerLlm) {
      return undefined;
    }
    const toolNames = args.toolDefinitions.map((t) => t.name);
    const decision = await this.routeOrFallback(args.message, toolNames);
    this.deps.logger?.info('pipeline.routed', {
      event: 'pipeline.routed',
      intent: decision.intent,
      tier: decision.modelTier,
      allowedToolNames: decision.allowedToolNames,
      reason: decision.reason,
      fallback: decision.fallback,
      filteredCount: toolNames.length - decision.allowedToolNames.length,
      routerInputTokens: decision.routerUsage.inputTokens,
      routerOutputTokens: decision.routerUsage.outputTokens,
    });
    const modelId = tierToModelId(decision.modelTier);
    const others = (this.deps.fallbackChain ?? []).filter((m) => m !== modelId);
    return {
      chain: [modelId, ...others],
      floor: decision.modelTier,
      allowedToolNames: decision.allowedToolNames,
      routerUsage: decision.routerUsage,
    };
  }
```

검증: `pnpm --filter @finclaw/server build` (B3 후 통과)

### B3. EDIT `packages/server/src/auto-reply/execution-adapter.ts` — `routeOrFallback` 폴백 헬퍼 (B-2)

> **B-2 핵심.** LLM 라우터 성공 = 정상 경로. 실패 시 `inferRole` 키워드로 `RouterDecision` 형태 폴백 구성. `inferRole`(`:67-76`) 은 **삭제하지 않고 잔존**.

`applyRouting`/`applyTuiRouting` 가 공유하는 private 헬퍼 신규 추가 (클래스 내부, `applyRouting` 아래):

```ts
  /**
   * Phase 34 B-2: LLM 라우터 호출, 실패 시 inferRole 키워드 폴백.
   * 폴백 시 routerUsage=0 (라우터 LLM 미과금), fallback=true 로 로그/비용 구분.
   */
  private async routeOrFallback(
    message: string,
    availableToolNames: readonly string[],
  ): Promise<RouterDecision> {
    const routerLlm = this.deps.routerLlm;
    if (!routerLlm) {
      return this.keywordFallbackDecision(message, availableToolNames);
    }
    try {
      return await routerLlm({ message, availableToolNames: [...availableToolNames] });
    } catch (err) {
      this.deps.logger?.warn('router.fallback', {
        event: 'router.fallback',
        reason: toMessage(err),
      });
      return this.keywordFallbackDecision(message, availableToolNames);
    }
  }

  /** inferRole 키워드 휴리스틱 → RouterDecision 폴백. analysis=모든 도구, fetch/chat=sonnet 도구. */
  private keywordFallbackDecision(
    message: string,
    availableToolNames: readonly string[],
  ): RouterDecision {
    const role = inferRole(message); // 잔존: 폴백 전용 (B-2)
    const intent = role === 'analysis' ? 'analysis' : role === 'fetch' ? 'fetch' : 'other';
    const modelTier: ModelTier = role === 'analysis' ? 'sonnet' : 'haiku';
    // 폴백은 보수적: analysis 면 전체 노출, 그 외는 전체 노출(키워드 시대 동작 보존).
    return {
      intent,
      modelTier,
      allowedToolNames: [...availableToolNames],
      reason: `keyword-fallback(role=${role})`,
      routerUsage: { inputTokens: 0, outputTokens: 0 },
      fallback: true,
    };
  }
```

> NOTE(구현자): 폴백의 `allowedToolNames` 정책은 "키워드 시대엔 전체 노출이 기본이었음" 을 보존(over-call 허용)하되 모델 tier 만 inferRole 로 결정. 라우터 정상 동작이 기대값이므로 폴백 정밀도는 비핵심. — questions.md Q2.

검증: `pnpm --filter @finclaw/server build`

### B4. EDIT `packages/server/src/auto-reply/execution-adapter.ts` — `applyTuiRouting` async LLM 라우터화 (`:502-541`)

> **B-3: applyTuiRouting 도 대체 (plan 은 1개만 언급).** TUI 경로도 동일하게 LLM 라우터 사용. `userHint` 는 라우터 결정과 무관해짐(라우터가 tier 결정) — 단, 기존 호환 위해 `userHint` 있으면 tier 상향만 허용할지는 비대상(키워드 시대 hint 승격 로직 폐기). 단순화: TUI 도 라우터 tier 그대로.

`executeForTui()` 호출부 (`:374`) async 화:

```ts
// Phase 34: TUI 도 LLM 라우터 사용 (B-3). userHint 키워드 승격 폐기.
const routed = await this.applyTuiRouting({ input, toolDefinitions });
```

`applyTuiRouting` 본문 교체 (`:502-541` 전체):

```ts
  /**
   * Phase 34 B-3: TUI/RPC chat.send 전용 라우팅. execute() 와 동일 LLM 라우터.
   * userHint 기반 키워드 tier 승격(Phase 24) 폐기 — 라우터 결정 tier 그대로.
   * routerLlm 미주입 시 undefined (호출자가 input.model 사용).
   */
  private async applyTuiRouting(args: {
    readonly input: {
      readonly model: ModelRef;
      readonly userMessage: string;
      readonly userHint?: ModelTier;
    };
    readonly toolDefinitions: readonly { readonly name: string }[];
  }): Promise<
    | {
        readonly chain: readonly string[];
        readonly floor: ModelTier;
        readonly allowedToolNames: ReadonlyArray<string>;
        readonly routerUsage: { readonly inputTokens: number; readonly outputTokens: number };
      }
    | undefined
  > {
    if (!this.deps.routerLlm) {
      return undefined;
    }
    const toolNames = args.toolDefinitions.map((t) => t.name);
    const decision = await this.routeOrFallback(args.input.userMessage, toolNames);
    this.deps.logger?.info('tui.routed', {
      event: 'tui.routed',
      intent: decision.intent,
      tier: decision.modelTier,
      allowedToolNames: decision.allowedToolNames,
      reason: decision.reason,
      fallback: decision.fallback,
      filteredCount: toolNames.length - decision.allowedToolNames.length,
      routerInputTokens: decision.routerUsage.inputTokens,
      routerOutputTokens: decision.routerUsage.outputTokens,
    });
    const modelId = tierToModelId(decision.modelTier);
    const others = (this.deps.fallbackChain ?? []).filter((m) => m !== modelId);
    return {
      chain: [modelId, ...others],
      floor: decision.modelTier,
      allowedToolNames: decision.allowedToolNames,
      routerUsage: decision.routerUsage,
    };
  }
```

> NOTE: `executeForTui` 의 `routed` 분기(`:397`)는 `routed && modelCatalog && modelAliasIndex` 조건 그대로 동작. `routed.chain`/`routed.floor` 형태 불변. `modelIdToTier` import 가 TUI 경로에서만 쓰였다면(`:523` 제거 후) 미사용 가능 → B5 에서 정리.

검증: `pnpm --filter @finclaw/server build`

### B5. EDIT `packages/server/src/auto-reply/execution-adapter.ts` + main.ts — 키워드 RouterHelper 경로 폐기 정리

> **B-3 폐기 대상 정리.** `applyRouting`/`applyTuiRouting` 가 더 이상 `RouterHelper`(키워드 facade)·`modelIdToTier`(TUI userHint)를 호출하지 않으므로 미사용 import/주입을 제거. **`inferRole` 은 폴백으로 잔존하므로 삭제 X.**

`execution-adapter.ts` 정리 대상 (구현 후 `pnpm lint` 로 미사용 검출):

- `import type { RouterHelper } from './router-helper.js';`(`:39`) — `deps.router?: RouterHelper` 필드가 잔존하면 유지, 필드도 제거하면 같이 제거. **권장: deps.router 필드 + import 모두 제거** (키워드 facade 정상 경로 폐기 확정).
- `modelIdToTier` import — TUI userHint 승격(`:523`) 제거로 미사용이면 import 에서 제거.
- `inferRole`/`ANALYSIS_KEYWORDS`/`FETCH_KEYWORDS`(`:53-76`) — **잔존** (keywordFallbackDecision 가 사용).

```ts
// 제거 (deps.router 필드 폐기 시):
// import type { RouterHelper } from './router-helper.js';
// RunnerExecutionAdapterDeps.router?: RouterHelper  ← 필드도 제거
// import 의 modelIdToTier  ← TUI 승격 폐기로 미사용이면 제거
```

검증: `pnpm --filter @finclaw/server build` + `pnpm lint`

### B6. EDIT `packages/server/src/main.ts` — sdkAdapter → LLM 라우터 생성 + 어댑터 주입 (B-0)

> **B-0 핵심.** `sdkAdapter`(`:275`, CLI 모드여도 항상 생성) 로 LLM 라우터 생성. summarizer 선례(`:625-626`)와 동일하게 라우터도 SDK 고정. RunnerExecutionAdapter 들에 `router: routerHelper`(키워드) 제거 → `routerLlm` 주입.

import 추가 (`@finclaw/agent` 블록):

```ts
import {
  AnthropicAdapter,
  // ... 기존 ...
  createLlmRouter, // 추가
} from '@finclaw/agent';
```

`sdkAdapter` 생성(`:275`) 직후 라우터 생성:

```ts
const sdkAdapter = new AnthropicAdapter(anthropicKey);
// Phase 34: LLM 오케스트레이터 라우터 — SDK Haiku 고정 (B-0). CLI 모드여도 SDK.
// 선례: summarizer 도 항상 sdkAdapter (Phase 32 F).
const routerLlm = createLlmRouter(sdkAdapter);
```

RunnerExecutionAdapter 주입 변경 (`:585`, `:728`, `:783` — 3곳 모두 `router: routerHelper` → `routerLlm`):

```ts
    // 변경 전: router: routerHelper,
    routerLlm,
```

> NOTE(구현자): `routerHelper`(키워드 makeRouterHelper, `:218-228`) 가 RunnerExecutionAdapter 외 다른 소비처(`:403` agent.run 등)에서 쓰이는지 확인. **execution-adapter 외 소비처가 있으면 그 경로는 본 phase 범위 밖** — 해당 주입은 유지하고 execution-adapter 의 3곳만 routerLlm 으로 교체. 소비처가 execution-adapter 뿐이면 `makeRouterHelper`/`buildToolMetaIndex` import + 생성(`:78`, `:218-228`)까지 제거 가능 (B-3 "키워드 경로 대체"). — questions.md Q3.

검증: `pnpm --filter @finclaw/server build` + `pnpm typecheck`

### B7. EDIT `packages/server/src/auto-reply/__tests__/execution-adapter.test.ts` — 라우터 통합 단위 테스트 (mock-only)

> 라우터 → exposedTools 필터 → 메인 호출(mock runner) 통합. mock `LlmRouter` 주입. 실제 LLM 호출 없음.

기존 `makeFakeRunnerFactory` 재사용. 새 describe 블록 추가:

```ts
import type { LlmRouter } from '@finclaw/agent';

function mockRouter(
  decision: Partial<import('@finclaw/agent').RouterDecision> & { allowedToolNames: string[] },
): LlmRouter {
  return async () => ({
    intent: 'other',
    modelTier: 'haiku',
    reason: 'mock',
    routerUsage: { inputTokens: 0, outputTokens: 0 },
    fallback: false,
    ...decision,
  });
}

describe('RunnerExecutionAdapter + LLM 라우터 (Phase 34)', () => {
  it('allowedToolNames 빈 배열이면 메인 호출에 tools 미전달', async () => {
    const { runnerFactory, calls } = makeFakeRunnerFactory([{ role: 'assistant', content: 'hi' }]);
    const adapter = new RunnerExecutionAdapter({
      runnerFactory,
      defaultModel: DEFAULT_MODEL,
      systemPrompt: 'sp',
      // toolRegistry 미주입 → toolDefinitions=[] 이지만 라우터 경로 자체를 검증.
      routerLlm: mockRouter({ intent: 'greeting', allowedToolNames: [] }),
      // 라우터 chain 사용하려면 modelCatalog 필요 — 미주입 시 단일 호출 경로.
    });
    await adapter.execute(makePipelineCtx(), AbortSignal.timeout(5000));
    expect(calls[0]?.tools).toBeUndefined();
  });

  it('라우터 실패(throw) 시 inferRole 폴백으로 진행 (B-2)', async () => {
    const { runnerFactory, calls } = makeFakeRunnerFactory([{ role: 'assistant', content: 'ok' }]);
    const failingRouter: LlmRouter = async () => {
      throw new Error('router down');
    };
    const adapter = new RunnerExecutionAdapter({
      runnerFactory,
      defaultModel: DEFAULT_MODEL,
      systemPrompt: 'sp',
      routerLlm: failingRouter,
    });
    // throw 가 전파되지 않고 폴백으로 정상 응답.
    const result = await adapter.execute(makePipelineCtx(), AbortSignal.timeout(5000));
    expect(result.content).toBe('ok');
    expect(calls).toHaveLength(1);
  });
});
```

> NOTE(구현자): `routerLlm` 만 주입하고 `modelCatalog`/`modelAliasIndex` 미주입 시 `applyRouting` 은 `routed` 를 반환하지만 `execute` 의 `if (modelCatalog && ...)` 분기(`:268`)가 false → `runner.execute(buildParams(defaultModel))` 단일 경로. `exposedTools` 필터(`:225-227`)는 `routed` 유무로 동작하므로 `tools` 미전달 검증은 유효. chain/floor 경로까지 검증하려면 mock catalog 추가 — questions.md Q4 참조(비핵심).

검증: `pnpm --filter @finclaw/server test --run execution-adapter`

### B8. 밀스톤 B 검증

다음을 모두 통과해야 다음 밀스톤으로 진입:

- `pnpm --filter @finclaw/server build`
- `pnpm --filter @finclaw/server test --run execution-adapter`
- `pnpm typecheck`
- `pnpm lint` (미사용 import 0 — B5 정리 확인)

---

## 밀스톤 C — 라우팅 결정 로깅 + 라우터 비용 누적 (`execution-adapter.ts`)

> plan C: "pipeline.routed 이벤트 확장." 보강 C-0 OVERRIDE: **events.ts 신규 이벤트 X. 기존 로그 라인(`:486-493` pipeline.routed, `:530-538` tui.routed)에 intent/tier/allowedToolNames/reason 필드 추가.** 이미 B2/B4 에서 로그 라인을 새 필드로 교체했으므로 C 는 **검증 + 라우터 토큰 비용 누적 마무리**.

### C1. EDIT `execution-adapter.ts` — `pipeline.routed` 로그 필드 확인 (B2 에 포함됨)

B2 의 `applyRouting` 가 이미 `intent/tier/allowedToolNames/reason/fallback/filteredCount/routerInputTokens/routerOutputTokens` 를 로깅. **이 단계는 신규 코드 없음 — B2 산출물 검토.** events.ts 변경 없음(C-0).

검증: 로그 필드 존재를 B7 또는 신규 단위 테스트로 assert (C3 에 포함).

### C2. EDIT `execution-adapter.ts` — `tui.routed` 로그 필드 확인 (B4 에 포함됨)

B4 의 `applyTuiRouting` 가 동일 필드 로깅. **신규 코드 없음.**

검증: 동일.

### C3. EDIT `execution-adapter.ts` — 라우터 Haiku 토큰 별도 누적 (D-0)

> **D-0: "라우터 자체 Haiku 토큰은 메인 호출과 별도 누적/로깅."** B2/B4 로그에 `routerInputTokens/routerOutputTokens` 이미 포함. 추가로 `profileHealth.recordResult` 에 라우터 비용을 메인과 **분리** 기록 — 라우터 모델 ID 로 byModel 집계되어 "≤$0.0005" 검증 가능.

`execute()` 의 `profileHealth.recordResult`(`:304-318`) 메인 기록 직후, `routed?.routerUsage` 가 있으면 라우터 토큰을 Haiku 모델 ID 로 별도 기록:

```ts
// Phase 34 D-0: 라우터 Haiku 토큰을 메인 호출과 분리하여 byModel 집계.
// ROUTER_MODEL_ID 의 catalog pricing 으로 비용 환산 → "≤$0.0005" 완료조건 검증 가능.
if (
  routed?.routerUsage &&
  (routed.routerUsage.inputTokens > 0 || routed.routerUsage.outputTokens > 0)
) {
  const routerPricing = modelCatalog?.get?.(ROUTER_MODEL_ID)?.pricing;
  this.deps.profileHealth?.recordResult(profileId, {
    success: true,
    modelId: ROUTER_MODEL_ID,
    tokens: { input: routed.routerUsage.inputTokens, output: routed.routerUsage.outputTokens },
    costUsd: routerPricing
      ? calculateEstimatedCost(
          routed.routerUsage.inputTokens,
          routed.routerUsage.outputTokens,
          routerPricing,
        )
      : 0,
    isFallback: false,
  });
}
```

> NOTE(구현자): `modelCatalog.get(ROUTER_MODEL_ID)` 의 정확한 API 시그니처는 `InMemoryModelCatalog` 확인 후 보정 (`get`/`resolve`/`lookup` 중). pricing 미발견 시 costUsd=0 (로그의 routerInputTokens 로도 사후 환산 가능). `ROUTER_MODEL_ID` import 추가 필요. — questions.md Q5.

검증: `pnpm --filter @finclaw/server test --run execution-adapter`

### C4. EDIT `execution-adapter.test.ts` — 로그 필드 + 라우터 비용 분리 단위 테스트

mock logger 로 `pipeline.routed` 로그가 `intent/tier/allowedToolNames/reason` 을 담는지 assert.

```ts
describe('Phase 34 라우팅 로깅', () => {
  it('pipeline.routed 로그에 intent/tier/allowedToolNames/reason 포함', async () => {
    const logged: Array<{ msg: string; meta: Record<string, unknown> }> = [];
    const logger = {
      info: (msg: string, meta: Record<string, unknown>) => logged.push({ msg, meta }),
      warn: () => {},
      error: () => {},
      debug: () => {},
    } as unknown as import('@finclaw/infra').FinClawLogger;
    const { runnerFactory } = makeFakeRunnerFactory([{ role: 'assistant', content: 'ok' }]);
    const adapter = new RunnerExecutionAdapter({
      runnerFactory,
      defaultModel: DEFAULT_MODEL,
      systemPrompt: 'sp',
      logger,
      routerLlm: mockRouter({
        intent: 'fetch',
        modelTier: 'haiku',
        allowedToolNames: [],
        reason: 'r',
      }),
    });
    await adapter.execute(makePipelineCtx(), AbortSignal.timeout(5000));
    const routedLog = logged.find((l) => l.meta.event === 'pipeline.routed');
    expect(routedLog).toBeDefined();
    expect(routedLog?.meta).toMatchObject({ intent: 'fetch', tier: 'haiku', reason: 'r' });
    expect(routedLog?.meta.allowedToolNames).toEqual([]);
  });
});
```

검증: `pnpm --filter @finclaw/server test --run execution-adapter`

### C5. 밀스톤 C 검증

- `pnpm --filter @finclaw/server build`
- `pnpm --filter @finclaw/server test --run execution-adapter`
- `pnpm typecheck`
- events.ts 무변경 확인: `git diff --stat packages/infra/src/events.ts` → 빈 출력 (C-0)

---

## 밀스톤 D — 비용·정확도 검증 (fixture mock + live 분리)

> plan D: "같은 발화 100건 키워드 vs LLM 라우터 비교. 토큰·tool*call 수 기록." 보강 D-0: agent_runs tokens*\*/profileHealth/calculateEstimatedCost 재사용 + 라우터 토큰 별도 누적. **mock-only 제약(CLAUDE.md): 실제 LLM 100건 실측은 사용자 운영 영역(live/수동)으로 분리.** 단위 테스트는 fixture intent 기대값으로 라우터 정확도 + 비용 계산을 검증.

### D1. CREATE `packages/agent/src/router/__tests__/fixtures/routing-cases.ts` — 발화 fixture (intent 기대값)

> 100건 실측 대신, 대표 발화 + 기대 intent 를 fixture 로. 라우터 정확도 회귀 가드 + 비용 계산 입력.

```ts
// packages/agent/src/router/__tests__/fixtures/routing-cases.ts
// Phase 34 D: 라우터 정확도 회귀 fixture. 실 LLM 100건 실측은 live/수동 (D3 NOTE).
import type { RouterIntent } from '../../llm-router.js';

export interface RoutingCase {
  readonly message: string;
  readonly expectedIntent: RouterIntent;
  /** 도구 노출 기대 — greeting/memory/other 는 false(미전달). */
  readonly expectsTools: boolean;
}

export const ROUTING_CASES: ReadonlyArray<RoutingCase> = [
  { message: '안녕', expectedIntent: 'greeting', expectsTools: false },
  { message: '고마워', expectedIntent: 'greeting', expectsTools: false },
  { message: '삼성전자 얼마야?', expectedIntent: 'fetch', expectsTools: true },
  { message: '달러 환율 알려줘', expectedIntent: 'fetch', expectsTools: true },
  { message: '삼성전자 지금 사도 될까?', expectedIntent: 'analysis', expectsTools: true },
  { message: '이 종목 분석해줘', expectedIntent: 'analysis', expectsTools: true },
  { message: '내 포트폴리오 수익률 어때', expectedIntent: 'portfolio', expectsTools: true },
  { message: '내가 전에 어떤 투자 성향이라 했지', expectedIntent: 'memory', expectsTools: false },
  { message: '오늘 날씨 어때', expectedIntent: 'other', expectsTools: false },
  // ... 구현자: 대표 케이스를 20~30건으로 확장 (각 intent 균형). 100건 실측은 D3.
];
```

검증: `pnpm --filter @finclaw/agent build`

### D2. CREATE `packages/agent/src/router/__tests__/routing-accuracy.test.ts` — fixture 정확도 + 비용 (mock-only)

> mock provider 가 fixture 의 `expectedIntent` 를 그대로 반환 → 라우터의 **매핑/필터/비용 계산** 로직을 검증 (LLM 분류 정확도가 아니라 매핑 정합성 + over-call 차단 회귀 가드). 실제 분류 정확도는 D3 live.

```ts
import {
  createLlmRouter,
  calculateEstimatedCost,
  BUILT_IN_MODELS,
  ROUTER_MODEL_ID,
} from '@finclaw/agent';
import { describe, it, expect } from 'vitest';
import { ROUTING_CASES } from './fixtures/routing-cases.js';

const AVAILABLE = [
  'get_stock_price',
  'get_exchange_rate',
  'analyze_market',
  'search_news',
  'get_portfolio',
];

describe('라우터 정확도 fixture (mock intent)', () => {
  it.each(ROUTING_CASES)('$message → expectsTools=$expectsTools', async (c) => {
    // mock: LLM 이 expectedIntent 를 정확히 분류했다고 가정.
    const provider = {
      providerId: 'anthropic' as const,
      async chatCompletion() {
        return {
          content: [
            { type: 'text', text: JSON.stringify({ intent: c.expectedIntent, reason: 'fixture' }) },
          ],
          usage: { input_tokens: 180, output_tokens: 12 },
        };
      },
      async *streamCompletion() {},
    } as unknown as import('@finclaw/agent').ProviderAdapter;
    const router = createLlmRouter(provider);
    const d = await router({ message: c.message, availableToolNames: AVAILABLE });
    expect(d.intent).toBe(c.expectedIntent);
    expect(d.allowedToolNames.length > 0).toBe(c.expectsTools);
  });

  it('라우터 추가 비용 ≤ $0.0005/메시지 (Haiku, 200in/100out 상한 기준)', () => {
    const pricing = BUILT_IN_MODELS.find((m) => m.id === ROUTER_MODEL_ID)?.pricing;
    expect(pricing).toBeDefined();
    const cost = calculateEstimatedCost(200, 100, pricing!);
    expect(cost).toBeLessThanOrEqual(0.0005);
  });
});
```

> 비용 검증: Haiku pricing input 0.8 / output 4 per million → (200/1e6)*0.8 + (100/1e6)*4 = 0.00016 + 0.0004 = 0.00056. **200in/100out 은 상한 초과** → fixture 는 plan 완료조건의 "평균 인풋 200tok" 기준(출력은 intent+reason 짧음, ~20out)으로 맞출 것: (200/1e6)*0.8 + (20/1e6)*4 = 0.00016 + 0.00008 = 0.00024 ≤ 0.0005 ✓. 위 테스트의 output 토큰을 **20** 으로 수정하여 완료조건과 정합. — 구현자 보정.

검증: `pnpm --filter @finclaw/agent test --run`

### D3. 실측 비용·정확도 — live/수동 (mock 범위 밖, 문서화만)

> **mock-only 제약상 본 단계는 코드 아님 — 운영 검증 절차 문서화.** plan 완료조건(100건 over-call 70%↓, 라우터 ≤$0.0005)의 실측은 실제 ANTHROPIC_API_KEY 환경에서 수동 또는 live 테스트 tier 로 수행. CI/유닛 테스트에 포함 X.

문서화 위치: review.md 의 "검증" 섹션 또는 `_workspace/phase-execute/34-implementer-log.md` 에 절차만 기록:

- profileHealth byModel 에서 `claude-haiku-4-5-20251001` 의 평균 costUsd 조회 → ≤$0.0005 확인.
- agent_runs `tool_calls_json` 길이 분포를 phase34 전후 비교 → over-call 감소율 산출.
- 절차는 사용자 운영 영역. 본 phase 의 자동 검증 게이트 아님.

검증: 해당 없음 (문서화). D2 의 비용 단위 테스트가 자동 게이트.

### D4. 밀스톤 D 검증

- `pnpm --filter @finclaw/agent build`
- `pnpm --filter @finclaw/agent test --run`
- `pnpm typecheck`

---

## 최종 검증

phase 전체 완료 후 다음 모두 통과:

- [ ] `pnpm typecheck`
- [ ] `pnpm test --run`
- [ ] `pnpm test:storage` (storage 변경 없음 — 회귀 0 확인)
- [ ] `pnpm lint` (미사용 import 0, inferRole 잔존 확인)
- [ ] `pnpm build`
- [ ] **mock-only 격리: `ANTHROPIC_API_KEY` unset 상태에서 `pnpm test --run` 통과** (라우터 테스트 전부 mock provider)
- [ ] events.ts 무변경 (`git diff --stat packages/infra/src/events.ts` 빈 출력 — C-0)
- [ ] `inferRole`/`ANALYSIS_KEYWORDS`/`FETCH_KEYWORDS` 잔존 (폴백 경로, B-2) — `grep -n inferRole packages/server/src/auto-reply/execution-adapter.ts` 가 keywordFallbackDecision 에서 1회 호출 확인
- [ ] 회귀: 기존 execution-adapter.test.ts 전체 통과 (라우터 미주입 시 기존 동작 보존)

---

## 정리

- `makeRouterHelper`/`buildToolMetaIndex`(router-helper.ts) 가 execution-adapter 외 미사용으로 확정되면(B6 NOTE / questions.md Q3) `router-helper.ts` 와 main.ts 의 키워드 routerHelper 생성(`:78`,`:218-228`) 제거 고려 — **단 다른 소비처 확인 전 삭제 금지** (CLAUDE.md §3, 죽은 코드는 언급만).
- `respectMinModel`(`models/routing.ts:72-75`) 은 `resolveModelForRequest` 내부 로직. execution-adapter 가 더 이상 `resolveModelForRequest` 를 (직접) 호출하지 않으면 키워드 경로 폐기로 자연 비활성. **routing.ts 자체 삭제는 비대상** (config 검증·다른 소비처 가능성).

---

## 롤백 절차

각 밀스톤이 독립 커밋 → 단계적 롤백:

- 밀스톤 D 롤백: `git revert {sha-D}` — fixture/정확도 테스트만 제거 (라우터 동작 유지).
- 밀스톤 C 롤백: `git revert {sha-D} {sha-C}` — 라우터 비용 분리 누적 제거 (로그 필드는 B 에 포함되어 잔존).
- 밀스톤 B 롤백: `git revert {sha-D} {sha-C} {sha-B}` — execution-adapter LLM 라우터 통합 제거, 키워드 경로 복원 (main.ts router 주입 복원 포함).
- 밀스톤 A 롤백: `git revert {sha-A}..{sha-D}` — router/ 디렉터리 전체 제거.

storage 마이그레이션 없음 → SCHEMA_VERSION 처리 불요. events.ts 무변경 → 이벤트 호환성 영향 없음.
