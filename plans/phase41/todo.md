# Phase 41 Todo: Anthropic SDK 전면 제거 + analyze_market CLI 재배선 + KIS→Toss 추상화

> plan.md (`plans/phase41/plan.md`) 의 밀스톤 A~E 를 코드 단위로 분해한 작업 가이드.
> base = main `dea0a0d`. 외과적 변경 (CLAUDE.md §3) — 명시 파일 외 인접 코드 비건드림.
> 테스트 mock-only (실 키/네트워크/라이브 CLI 금지). 각 밀스톤 = 1커밋, ASCII subject.
>
> ✅ **Q1 해소 (2026-05-26 승인)**: execution-adapter 라우터 의존 테스트는 실측 4건 + mockRouter helper + import →
> **전부 삭제** (D6). baseline −38 확정.
> ✅ **TUI 결정 (D5, 2026-05-26)**: `executeForTui` 는 `input.model` 단발 경로 **보존** (현 CLI 동작 유지 — 사용자
> 세션 모델 존중). fallbackChain(sonnet)은 `execute()`(Discord/web)에만 적용. 모든 단계 즉시 구현 가능.

---

## 사전 준비

P-1 별도 사전 작업 없음. 밀스톤 A 가 가장 저위험이라 그대로 시작. 밀스톤 의존: **D 는 C 이후** (C 가
routerLlm *배선*을 걷고, D 가 라우터 *코드*를 삭제). A·B·E 는 상호 독립이나 plan 순서(A→B→C→D→E) 준수.

---

## 밀스톤 A — sentiment 죽은 feature 클러스터 삭제

> 목표: 프로덕션 호출처 0건인 `sentiment.ts` + 전용 prompt 로더/md + 테스트 통째 삭제. skills-finance 의
> SDK import 1개 소멸 (나머지 SDK 사용처는 밀스톤 B 에서 제거). baseline −15 (sentiment 11 + loadSentimentPrompt 4).

### A1. DELETE `packages/skills-finance/src/news/analysis/sentiment.ts`

파일 전체 삭제. `analyzeSentiment`/`computeLlmSentiment`/`computeRuleBasedSentiment`/`scoreToLabel` 전부
프로덕션 호출처 0건 (providers 는 각자 로컬 `scoreToLabel` 정의 — sentiment.ts import 아님). SDK import
(`import type Anthropic` L2) + `loadSentimentPrompt` import (L5) 가 여기서 소멸.

### A2. DELETE `packages/skills-finance/src/news/analysis/__tests__/sentiment.test.ts`

파일 전체 삭제 (11 tests). sentiment.ts 의 유일 참조처.

### A3. EDIT `packages/skills-finance/src/news/analysis/prompt-loader.ts` — `loadSentimentPrompt` 제거

L44-47 의 `loadSentimentPrompt` 함수만 제거. `readPromptFile`/`loadAnalysisPrompt`/`SkillPromptLoadError`/
`AnalysisDepth`/`AnalysisLanguage` 등 나머지 전부 불변.

```ts
// ... loadAnalysisPrompt (L34-42) 까지 그대로 유지 ...
export async function loadAnalysisPrompt(
  depth: AnalysisDepth,
  language: AnalysisLanguage,
): Promise<string> {
  return readPromptFile(
    `analyze.${depth}.${language}.md`,
    `loadAnalysisPrompt(${depth},${language})`,
  );
}
// ↓ 아래 loadSentimentPrompt 블록 전체 삭제 (L44-47):
//   export async function loadSentimentPrompt(ruleHint: number): Promise<string> {
//     const tpl = await readPromptFile('sentiment.system.md', 'loadSentimentPrompt');
//     return tpl.replaceAll('{{ruleHint}}', ruleHint.toFixed(2));
//   }
```

### A4. EDIT `packages/skills-finance/src/news/analysis/__tests__/prompt-loader.test.ts` — `loadSentimentPrompt` describe 제거

L1-8 import 에서 `loadSentimentPrompt` 제거 + L36-54 `describe('loadSentimentPrompt', ...)` 블록(4 tests) 제거.
`loadAnalysisPrompt` / `SkillPromptLoadError` describe 는 불변.

```ts
import { describe, expect, it } from 'vitest';
import {
  loadAnalysisPrompt,
  SkillPromptLoadError,
  type AnalysisDepth,
  type AnalysisLanguage,
} from '../prompt-loader.js';
// ↑ import 에서 loadSentimentPrompt 제거

// describe('loadAnalysisPrompt', ...) 블록 그대로 유지
// ↓ describe('loadSentimentPrompt', ...) 블록 전체 삭제 (L36-54)
// describe('SkillPromptLoadError', ...) 블록 그대로 유지
```

### A5. DELETE `packages/skills-finance/prompts/news/sentiment.system.md`

`loadSentimentPrompt` 전용 prompt 파일 (227 bytes, `readPromptFile('sentiment.system.md', ...)` 유일 참조 →
A3 후 고아). `analyze.{depth}.{lang}.md` 6종은 불변.

> 참고 (questions.md Q3): `package-files.test.ts` 는 `pkg.files` 의 glob `'prompts/**/*.md'` 포함만 단언하고
> sentiment.system.md 존재는 단언 안 함 → **정정 불필요**. plan §5 A 의 "그 md 존재 단언하면 정정" = 해당 없음.

### A6. 밀스톤 A 검증

```bash
grep -rn "analyzeSentiment\|loadSentimentPrompt\|sentiment.system\|computeLlmSentiment" packages/skills-finance/src   # 0건
pnpm typecheck            # tsgo --noEmit green
pnpm test --run --filter @finclaw/skills-finance
```

커밋: `refactor(phase41): remove dead sentiment feature (no production caller)`

---

## 밀스톤 B — analyze_market → runCliAgent 재배선 + skills-finance SDK dep 제거

> 목표: analyze_market 의 유일 SDK 호출(`client.messages.create`)을 `runAnalysis` 콜백 주입으로 일반화 →
> 기본 구현은 `runCliAgent({queueKey:'claude-analysis', modelId:'opus'})` (세션 비공유, 중첩 데드락 회피).
> skills-finance 의 `@anthropic-ai/sdk` dep 완전 제거. baseline 불변 (선택 runner 테스트 +1).

### B1. EDIT `packages/agent/src/providers/claude-cli/runner.ts` — `queueKey?` override 추가

`RunCliAgentRequest` 에 `queueKey?: string` 추가 + L84 queue 빌드에 override 반영. 기존 호출 무영향 (미지정 시 동일).

```ts
export interface RunCliAgentRequest {
  prompt: string;
  systemPrompt?: string;
  modelId?: string;
  cliSessionId?: string;
  timeoutMs?: number;
  abortSignal?: AbortSignal;
  cwd?: string;
  backend?: CliBackendConfig;
  /** Phase 41: 큐 키 override. inner analyze_market spawn 이 outer ReAct 와 다른 큐를 쓰게 해
   *  중첩 spawn 데드락 회피. 미지정 시 buildCliQueueKey(backendId:'claude', ...) 기본. */
  queueKey?: string;
}
```

L84 의 queue 빌드 (변경 부분만):

```ts
// queue — Phase 41: req.queueKey override 우선, 미지정 시 기존 backendId/세션 기반 키.
const queueKey =
  req.queueKey ??
  buildCliQueueKey({
    backendId: 'claude',
    cliSessionId: useResume ? req.cliSessionId : undefined,
  });
```

검증: `pnpm typecheck`

### B2. EDIT `packages/skills-finance/src/news/analysis/market-analysis.ts` — `analyzeMarket(runAnalysis, ...)`

`import type Anthropic` 제거. `analyzeMarket` 첫 인자 `client: Anthropic` → `runAnalysis: AnalyzeRunner`.
`client.messages.create(...)` → `runAnalysis({...})`. usage 회계는 `runAnalysis` 응답 `usage` 로 매핑
(`message.usage.input_tokens` → `usage.input`, `output_tokens` → `usage.output`). text 추출은 응답 `text` 직접 사용.

import 교체 (L2 제거, L3-8 유지):

```ts
// packages/skills-finance/src/news/analysis/market-analysis.ts
import type { ModelCatalog, ProfileHealthMonitor } from '@finclaw/agent';
import { calculateEstimatedCost } from '@finclaw/agent';
import type { ModelRef, NewsItem } from '@finclaw/types';
import { z } from 'zod/v4';
import type { MarketAnalysis, AnalysisOptions } from '../types.js';
import { loadAnalysisPrompt } from './prompt-loader.js';
```

`AnalysisRecordDeps` 아래에 runner 타입 추가:

```ts
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
```

`analyzeMarket` 시그니처 + 본문 (L59-126 교체):

```ts
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
```

`buildAnalysisUserPrompt` (L130-146) 불변. `AnalysisResponseSchema` (L23-57) 불변.

> 주의: `max_tokens` (brief 500 / detailed 2000 / standard 1000) 는 SDK 전용 인자였음. CLI 는 max_tokens
> 미지원이라 drop (plan §3 — runCliAgent req shape 에 max_tokens 없음). 출력 길이는 systemPrompt 의 depth 지시로 제어.

### B3. EDIT `packages/skills-finance/src/news/tools.ts` — `deps.client` → `deps.runAnalysis`

L1 `import type Anthropic` 제거. `registerAnalyzeMarketTool` 의 `deps.client: Anthropic` → `deps.runAnalysis: AnalyzeRunner`.
executor 의 `analyzeMarket(deps.client, ...)` → `analyzeMarket(deps.runAnalysis, ...)`.

import 교체 (L1 제거, L14 에 AnalyzeRunner 추가):

```ts
// packages/skills-finance/src/news/tools.ts
import type {
  ModelCatalog,
  ProfileHealthMonitor,
  RegisteredToolDefinition,
  RouterHelper,
  ToolExecutor,
  ToolRegistry,
} from '@finclaw/agent';
import { ModelFloorExhaustedError } from '@finclaw/agent';
import type { ModelRef, TickerSymbol } from '@finclaw/types';
import { z } from 'zod/v4';
import { analyzeMarket, type AnalyzeRunner } from './analysis/market-analysis.js';
import type { PortfolioStore } from './portfolio/store.js';
import { createPortfolioTracker, type QuoteService } from './portfolio/tracker.js';
import type { NewsAggregator, AnalysisOptions, NewsCategory } from './types.js';
```

`registerAnalyzeMarketTool` deps (L108-120 변경 부분):

```ts
export function registerAnalyzeMarketTool(
  registry: ToolRegistry,
  deps: {
    newsAggregator: NewsAggregator;
    runAnalysis: AnalyzeRunner;
    router?: RouterHelper;
    defaultModel?: ModelRef;
    profileHealth?: ProfileHealthMonitor;
    profileId?: string;
    modelCatalog?: ModelCatalog;
  },
): void {
```

executor 의 analyzeMarket 호출 (L183 변경):

```ts
const analysis = await analyzeMarket(deps.runAnalysis, news, options, modelRef, {
  profileHealth: deps.profileHealth,
  profileId: deps.profileId,
  modelCatalog: deps.modelCatalog,
});
```

> `ANALYZE_MARKET_FALLBACK_MODEL` (L33-39, `provider: 'anthropic'` 는 ModelRef.provider — plan §4 불변) +
> router/floor 선택 로직 (L171-181) + `AnalyzeMarketOutputSchema` 전부 불변.

### B4. EDIT `packages/skills-finance/src/news/index.ts` — CLI runner 무조건 등록

`import Anthropic` 제거, `runCliAgent` import 추가. `NewsSkillConfig.anthropicApiKey` 제거. L104 의
`if (config.anthropicApiKey)` 게이트 제거 → analyze_market 을 무조건 등록하되 기본 `runAnalysis` 를
`runCliAgent` 기반 클로저로 주입 (queueKey='claude-analysis', 세션 비공유, usage 매핑).

import 교체 (L2 제거, agent import 에 runCliAgent 추가):

```ts
import type { DatabaseSync } from 'node:sqlite';
// packages/skills-finance/src/news/index.ts
import type {
  ModelCatalog,
  ProfileHealthMonitor,
  RouterHelper,
  ToolRegistry,
} from '@finclaw/agent';
import { runCliAgent } from '@finclaw/agent';
import type { ModelRef, SkillMetadata } from '@finclaw/types';
import type { KeyRotator } from '../shared/key-rotator.js';
// ... 나머지 provider import 불변 ...
```

`NewsSkillConfig` 에서 `anthropicApiKey` 필드 제거 (L40 줄 삭제):

```ts
export interface NewsSkillConfig {
  readonly db: DatabaseSync;
  readonly newsApiKey?: string;
  readonly alphaVantageKey?: string;
  readonly newsdataRotator?: KeyRotator;
  readonly finnhubRotator?: KeyRotator;
  readonly rssFeedUrls?: string[];
  // ↑ anthropicApiKey 제거
  readonly quoteService: QuoteService;
  readonly router?: RouterHelper;
  readonly defaultModel?: ModelRef;
  readonly profileHealth?: ProfileHealthMonitor;
  readonly profileId?: string;
  readonly modelCatalog?: ModelCatalog;
}
```

analyze_market 등록 (L103-115 교체) — 게이트 제거 + 무조건 등록:

```ts
// 도구 등록: analyze_market — Phase 41: CLI runner 무조건 등록 (구독 모드).
// inner runCliAgent 은 전용 queueKey('claude-analysis') + 세션 비공유로 중첩 spawn 데드락 회피.
registerAnalyzeMarketTool(registry, {
  newsAggregator,
  runAnalysis: async (req) => {
    const res = await runCliAgent({
      systemPrompt: req.systemPrompt,
      prompt: req.prompt,
      modelId: req.modelId,
      timeoutMs: req.timeoutMs,
      queueKey: 'claude-analysis',
      // cliSessionId 미전달 — stateless 1-shot (세션 비공유).
    });
    return {
      text: res.text,
      usage: res.usage ? { input: res.usage.input ?? 0, output: res.usage.output ?? 0 } : undefined,
    };
  },
  router: config.router,
  defaultModel: config.defaultModel,
  profileHealth: config.profileHealth,
  profileId: config.profileId,
  modelCatalog: config.modelCatalog,
});
```

`NEWS_SKILL_METADATA.requires.optionalEnv` (L139-145) 에서 `'ANTHROPIC_API_KEY'` 제거:

```ts
    optionalEnv: ['NEWSAPI_KEY', 'ALPHA_VANTAGE_KEY', 'FINNHUB_KEY', 'NEWSDATA_API_KEY'],
```

> `tools` 배열의 `analyze_market minModel:'opus'` 불변 (opus floor 유지 — 금융 판단 환각 방지, plan 리스크표).

### B5. EDIT `packages/server/src/composition/skills.ts` — `anthropicApiKey` 인자 제거

`registerNewsTools` 호출 (L120-133) 에서 `anthropicApiKey: anthropicKey` 줄 제거. 나머지 인자 불변.

```ts
newsHandle = await registerNewsTools(toolRegistry, {
  db: storage.db,
  alphaVantageKey: alphaVantageKeys[0],
  newsdataRotator,
  finnhubRotator,
  quoteService: marketHandle.quoteService,
  // ↑ anthropicApiKey: anthropicKey 제거
  router: routerHelper,
  defaultModel,
  profileHealth,
  profileId: 'default',
  modelCatalog,
});
```

> `anthropicKey` 자체는 밀스톤 C 에서 buildProviders 정리와 함께 다룬다. 여기선 news 인자만 제거. (`anthropicKey`
> 가 RegisterSkillsDeps 에 남아도 C 까지는 다른 곳에서 안 쓰여 unused 가 되지 않음 — C 가 정리.)
> RegisterSkillsDeps 의 L46-47 주석/`anthropicKey` 필드는 C 에서 처리 (아래 C 단계 참조).

### B6. EDIT `packages/skills-finance/package.json` — SDK dep 제거

`dependencies` 에서 `"@anthropic-ai/sdk": "^0.91.1"` 줄 제거 (A+B 후 skills-finance 의 유일 SDK 사용처 소멸).
편집 후 `pnpm format:fix` (oxfmt 가 package.json 키 재정렬) + `pnpm install` (lockfile 갱신).

### B7. (선택) `packages/agent/test/providers/claude-cli/` 에 queueKey override 단위 테스트 +1

plan §5 B "선택: runner.ts queueKey override 단위 테스트 1건". mock-only. `enqueueCliRun` 직렬화를
spy 로 검증하거나, `queueKey` 가 spawn 직전 큐 키로 쓰이는지 확인. 신규 파일
`packages/agent/test/providers/claude-cli/queue-override.test.ts`:

```ts
import { describe, it, expect, vi } from 'vitest';
import * as queueMod from '../../../src/providers/claude-cli/queue.js';
import { runCliAgent } from '../../../src/providers/claude-cli/runner.js';
import * as spawnMod from '../../../src/providers/claude-cli/spawn.js';

describe('runCliAgent queueKey override (Phase 41)', () => {
  it('uses provided queueKey instead of backendId-derived key', async () => {
    const enqueueSpy = vi.spyOn(queueMod, 'enqueueCliRun');
    vi.spyOn(spawnMod, 'spawnWithWatchdog').mockResolvedValue({
      stdout: '{"result":"ok"}',
      stderr: '',
      exitCode: 0,
      reason: 'exit',
      noOutputTimedOut: false,
    } as never);

    await runCliAgent({ prompt: 'hi', queueKey: 'claude-analysis', modelId: 'opus' });

    expect(enqueueSpy).toHaveBeenCalledWith('claude-analysis', expect.any(Function));
  });

  it('falls back to backendId key when queueKey omitted', async () => {
    const enqueueSpy = vi.spyOn(queueMod, 'enqueueCliRun');
    vi.spyOn(spawnMod, 'spawnWithWatchdog').mockResolvedValue({
      stdout: '{"result":"ok"}',
      stderr: '',
      exitCode: 0,
      reason: 'exit',
      noOutputTimedOut: false,
    } as never);

    await runCliAgent({ prompt: 'hi' });

    expect(enqueueSpy).toHaveBeenCalledWith('claude', expect.any(Function));
  });
});
```

> ⚠️ 구현 시 `spawnWithWatchdog` 의 실제 반환 shape 를 `spawn.ts` 에서 확인하고 mock 맞출 것 (위는 근사치).
> `parseCliJson` 가 stdout 을 파싱하므로 backend.output 기본 모드에 맞는 stdout 형태로 mock. baseline +2.

### B8. 밀스톤 B 검증

```bash
grep -rn "@anthropic-ai/sdk" packages/skills-finance/src   # 0건
grep -rn "anthropicApiKey" packages/skills-finance/src packages/server/src/composition/skills.ts   # 0건
pnpm typecheck
tsc --build
pnpm test --run --filter @finclaw/skills-finance --filter @finclaw/agent
pnpm lint
```

커밋: `refactor(phase41): rewire analyze_market to runCliAgent, drop skills-finance SDK dep`

---

## 밀스톤 C — Anthropic SDK 전면 제거 (agent + composition) ⚠️ 비가역

> 목표: `AnthropicAdapter`·`summarizeText`·`anthropic-sdk` provider 모드·W2 sdkFallback·dual-path 배선
> 전부 삭제. CLI 단일 런타임 확정. **routerLlm 파일 삭제는 D** (여기선 *배선*만 제거). baseline −9
> (summarize-text 4 + cli-fallback 2 + structured-output 2 + providers dual-path 1).

### C1. DELETE `packages/agent/src/providers/anthropic.ts`

파일 전체 삭제 (`AnthropicAdapter` + `summarizeText` + `toAnthropicMessages` + `wrapAnthropicError`).

### C2. DELETE 테스트 3종

- DELETE `packages/agent/test/providers/summarize-text.test.ts` (4 tests, `summarizeText` 전용)
- DELETE `packages/agent/src/providers/structured-output.test.ts` (2 tests, `AnthropicAdapter.streamCompletion` 전용)
- DELETE `packages/agent/test/providers/claude-cli/cli-fallback.test.ts` (2 tests, W2 sdkFallback 경로 전용)

### C3. EDIT `packages/agent/src/index.ts` — AnthropicAdapter / summarizeText export 제거

L70 `export { AnthropicAdapter } from './providers/anthropic.js';` 삭제.
L178-179 의 compaction wiring 어댑터 export 중 `summarizeText` 삭제 (`approxTokenCount` 는 유지):

```ts
// ── Phase 7: Context ──  (L168-177 불변)
export { evaluateContextWindow, compactContext } from './agents/context/index.js';
// Phase 31 C — compaction wiring 어댑터.
export { approxTokenCount } from './execution/token-fn.js';
// ↑ summarizeText export 삭제, 위 주석 줄에서 summarizeText 언급 제거
```

> `createLlmRouter`/`LlmRouter`/`ROUTER_MODEL_ID`/`RouterIntent`/`RouterDecision`/`RouterInput` export
> (L213-215) 제거는 **밀스톤 D** — 여기선 손대지 않음.

### C4. EDIT `packages/agent/src/providers/factory.ts` — `anthropic-sdk` 분기 + sdkFallback 제거

`AnthropicAdapter` import 제거. `ProviderKind` 를 `'claude-cli'` 단일로. `anthropic-sdk` case + `apiKey`/
`sdkFallback` 필드 제거. switch → CLI 단일 (exhaustive never 불필요).

```ts
// packages/agent/src/providers/factory.ts
import type { ProviderAdapter } from './adapter.js';
import { CliProviderAdapter } from './claude-cli/adapter.js';
import type { CliBackendConfig } from './claude-cli/types.js';

export type ProviderKind = 'claude-cli';

export interface ProviderFactoryConfig {
  kind: ProviderKind;
  cliBackend?: CliBackendConfig;
  defaultTimeoutMs?: number;
}

export function createProviderAdapter(cfg: ProviderFactoryConfig): ProviderAdapter {
  // Phase 41: CLI 단일 런타임 — SDK 모드 영구 제거.
  return new CliProviderAdapter({
    backend: cfg.cliBackend,
    defaultTimeoutMs: cfg.defaultTimeoutMs,
  });
}
```

> `cfg.kind` 는 `'claude-cli'` 만 가능하나 호출부 호환을 위해 필드는 유지 (providers.ts 가 여전히 `kind` 전달).

### C5. EDIT `packages/agent/src/providers/claude-cli/adapter.ts` — sdkFallback + W2 분기 제거

`CliProviderAdapterOptions.sdkFallback` 제거. `streamCompletion` 의 try/catch 에서 W2 auth 위임 분기 (L36-43) 제거
→ 단순 `await this.#run(params)`. `ProviderAdapter` import 가 sdkFallback 에만 쓰였으면 제거 (L5 — `ProviderRequestParams`
는 유지되므로 import 줄에서 `ProviderAdapter` 만 빼고 `ProviderRequestParams` 유지). `CliFailoverError` import 는
다른 곳에서 안 쓰이면 제거 (실측: W2 분기가 유일 사용처 → 제거).

import 정리 (L5-6):

```ts
import type { ProviderRequestParams } from '../adapter.js';
// ↑ ProviderAdapter 제거 (sdkFallback 옵션 전용이었음)
import { runCliAgent, type RunCliAgentResponse } from './runner.js';
// ↑ CliFailoverError import 제거 (W2 분기 전용이었음)
```

`CliProviderAdapterOptions` (L10-15):

```ts
export interface CliProviderAdapterOptions {
  backend?: CliBackendConfig;
  defaultTimeoutMs?: number;
  // ↑ sdkFallback 제거
}
```

`streamCompletion` (L32-62 교체):

```ts
  // ★ async generator: text_delta → usage → done
  async *streamCompletion(params: ProviderRequestParams): AsyncIterable<StreamChunk> {
    // Phase 41: W2 sdkFallback 제거 — CLI 단일 경로. 에러는 상위로 그대로 전파.
    const result: RunCliAgentResponse = await this.#run(params);
    if (result.text) {
      yield { type: 'text_delta', text: result.text };
    }
    if (result.usage) {
      yield {
        type: 'usage',
        usage: {
          inputTokens: result.usage.input ?? 0,
          outputTokens: result.usage.output ?? 0,
          cacheReadTokens: result.usage.cacheRead ?? 0,
          cacheWriteTokens: result.usage.cacheWrite ?? 0,
          estimatedCostUsd: result.usage.costUsd ?? 0,
        },
      };
    }
    yield { type: 'done' };
  }
```

> `#run` / `chatCompletion` / `extractPrompt` / `providerId='claude-cli'` 불변.

### C6. EDIT `packages/types/src/config.ts` — provider enum 단일화

L20 `provider?: 'anthropic-sdk' | 'claude-cli';` → `provider?: 'claude-cli';`. 주석 (L19) 유지.

```ts
  /** Phase 32 W6: 백엔드 경로 선택 (모델 벤더 의미의 agents.defaults.provider 와 분리). */
  provider?: 'claude-cli';
```

### C7. EDIT `packages/config/src/zod-schema.ts` — provider enum 단일화

L196 `provider: z.enum(['anthropic-sdk', 'claude-cli']).optional(),` → `provider: z.literal('claude-cli').optional(),`.

```ts
  // Phase 32 W6 / Phase 41: 백엔드 경로 — claude-cli 단일 (SDK 모드 제거).
  provider: z.literal('claude-cli').optional(),
```

### C8. EDIT `packages/server/src/composition/providers.ts` — sdkAdapter/routerLlm 배선 제거

`AnthropicAdapter`/`createLlmRouter` import 제거. `anthropicKey` deps 필드 제거. `sdkAdapter`/`routerLlm`
생성 (L42-44) + `ProvidersBundle` 의 `sdkAdapter`/`routerLlm` 필드 + `createProviderAdapter` 의 `apiKey`/
`sdkFallback` 인자 제거. `logger.info` 의 `keyless` 는 의미 소멸 → 제거 (또는 항상 CLI 표기).

```ts
// packages/server/src/composition/providers.ts
// Phase 36: main.ts 274-303 에서 추출. Phase 41: SDK dual-path 제거 (CLI 단일).

import {
  createProviderAdapter,
  DEFAULT_CLAUDE_BACKEND,
  InMemoryToolRegistry,
} from '@finclaw/agent';
import { signToken } from '@finclaw/gateway';
import { ConcurrencyLaneManager, type FinClawLogger } from '@finclaw/infra';
import type { FinClawConfig } from '@finclaw/types';

export interface BuildProvidersDeps {
  readonly finclawConfig: FinClawConfig;
  readonly logger: FinClawLogger;
  readonly mcpEndpoint?: { readonly url: string; readonly jwtSecret: string };
}

export interface ProvidersBundle {
  readonly providerAdapter: ReturnType<typeof createProviderAdapter>;
  readonly lanes: ConcurrencyLaneManager;
  readonly toolRegistry: InMemoryToolRegistry;
}

export function buildProviders({
  finclawConfig,
  logger,
  mcpEndpoint,
}: BuildProvidersDeps): ProvidersBundle {
  const cliBackend =
    finclawConfig.cliBackend || mcpEndpoint
      ? {
          ...DEFAULT_CLAUDE_BACKEND,
          command: finclawConfig.cliBackend?.command ?? 'claude',
          ...(finclawConfig.cliBackend?.watchdog
            ? { reliability: { watchdog: finclawConfig.cliBackend.watchdog } }
            : {}),
          ...(mcpEndpoint
            ? {
                mcp: {
                  url: mcpEndpoint.url,
                  mintToken: () =>
                    signToken({ sub: 'finclaw', sessionId: 'mcp' }, mcpEndpoint.jwtSecret),
                  allowedTools: 'mcp__finclaw__*',
                },
              }
            : {}),
        }
      : undefined;
  const providerAdapter = createProviderAdapter({
    kind: 'claude-cli',
    cliBackend,
    defaultTimeoutMs: finclawConfig.cliBackend?.timeoutMs ?? 60_000,
  });
  logger.info('provider.initialized', {
    event: 'provider.initialized',
    providerKind: 'claude-cli',
  });
  const lanes = new ConcurrencyLaneManager();
  const toolRegistry = new InMemoryToolRegistry();

  return { providerAdapter, lanes, toolRegistry };
}
```

> `finclawConfig.provider` 는 이제 `'claude-cli'` 만 가능 → `kind: 'claude-cli'` 하드코딩 (??' 분기 불필요).

### C9. EDIT `packages/server/src/composition/runtime.ts` — sdkAdapter/summarizer/routerLlm 제거

import 에서 `createLlmRouter`/`AnthropicAdapter` 제거. `BuildExecutionDeps.routerLlm` 필드 제거 + `buildExecution`
구조분해/주입에서 `routerLlm` 제거. `BuildPipelineDeps.sdkAdapter` 필드 제거 + `summarizer` 생성 (L192-196) 제거 →
AutoReplyPipeline 의 `summarizer` 인자 제거 (또는 undefined).

import (L4-17):

```ts
import {
  approxTokenCount,
  buildModelAliasIndex,
  DEFAULT_FALLBACK_CHAIN,
  InMemoryModelCatalog,
  InMemoryToolRegistry,
  NEWS_BRIEF_SCHEDULE_ID,
  ProfileHealthMonitor,
  Runner,
  type ProviderAdapter,
  type RunnerTracerAdapter,
} from '@finclaw/agent';
// ↑ createLlmRouter, type AnthropicAdapter 제거
```

`BuildExecutionDeps` — `routerLlm` 필드 (L53-54) 제거:

```ts
export interface BuildExecutionDeps {
  readonly storage: Storage;
  readonly providerAdapter: ProviderAdapter;
  readonly lanes: ConcurrencyLaneManager;
  readonly toolRegistry: InMemoryToolRegistry;
  readonly modelCatalog: InMemoryModelCatalog;
  readonly modelAliasIndex: ReturnType<typeof buildModelAliasIndex>;
  readonly profileHealth: ProfileHealthMonitor;
  // ↑ routerLlm 제거
  readonly logger: FinClawLogger;
  readonly defaultModel: ModelRef;
  readonly systemPrompt: string;
}
```

`buildExecution` 구조분해 (L66-79) 에서 `routerLlm` 제거 + RunnerExecutionAdapter 주입 (L97-111) 에서
`routerLlm` 줄 + Phase 34 주석 제거:

```ts
const adapter = new RunnerExecutionAdapter({
  runnerFactory,
  defaultModel,
  systemPrompt,
  storage,
  toolRegistry,
  logger,
  modelCatalog,
  modelAliasIndex,
  fallbackChain: DEFAULT_FALLBACK_CHAIN,
  profileHealth,
  profileId: 'default',
  // ↑ routerLlm + Phase 34 주석 제거
});
```

`BuildPipelineDeps` — `sdkAdapter` 필드 (L127-128) 제거:

```ts
  readonly finclawConfig: import('@finclaw/types').FinClawConfig;
  // ↑ sdkAdapter 제거
  readonly tracer: Tracer;
```

`buildPipeline` 구조분해 (L141-155) 에서 `sdkAdapter` 제거. summarizer 생성 (L192-196) 제거 + AutoReplyPipeline
deps (L206-217) 의 `summarizer` 인자 제거:

```ts
// Phase 31 C / Phase 41: SDK summarizer 영구 제거 — compaction off (tokenCounter 만 유지,
// maybeCompactMessages 가 summarizer 미주입 시 원본 messages 그대로 반환 = graceful degrade).
const pipeline = new AutoReplyPipeline(
  {
    enableAck: true,
    commandPrefix: '!finclaw ',
    maxResponseLength: 2000,
    timeoutMs: 60_000,
    respectMarketHours: false,
  },
  {
    executionAdapter: adapter,
    financeContextProvider: financeCtxProvider,
    commandRegistry,
    logger,
    getChannel: (id) => channelPluginRegistry.get(id),
    memoryCaptureService,
    memoryRetrievalService,
    tracer,
    tokenCounter: approxTokenCount,
    // ↑ summarizer 인자 제거
  },
);
```

> ✅ 실측: `AutoReplyPipeline` deps 의 `summarizer?` 는 이미 optional (pipeline.ts:69) → **인자만 빼면 됨**
> (시그니처 변경 불필요). tokenCounter 만 있고 summarizer 없으면 `maybeCompactMessages` 가 원본 반환
> (execution-adapter.ts:686 — graceful degrade, compaction off). pipeline.ts 의 `this.deps.summarizer` 소비처
> (L345) 는 undefined 를 그대로 전달 → 동작 안전.

### C10. EDIT `packages/server/src/main.ts` — sdkAdapter/routerLlm threading + anthropic-sdk 게이트 제거

L193 `buildProviders` 분해에서 `sdkAdapter`/`routerLlm` 제거. L231-243 `buildExecution` 호출에서 `routerLlm` 줄(L239) 제거.
L247-261 `buildPipeline` 호출에서 `sdkAdapter` 줄(L256) 제거. `anthropicKey` 가 더 이상 buildProviders 에 안 들어가므로
buildProviders 호출에서 `anthropicKey` 인자(L195) 제거.

**추가 (필수) — L111-117 의 `provider === 'anthropic-sdk'` 게이트 제거**: C6/C7 후 `finclawConfig.provider` 타입이
`'claude-cli'` 단일이 되어 `=== 'anthropic-sdk'` 비교가 **타입 에러 + 영원히 false 인 dead branch** 가 됨. 블록 삭제:

```ts
const finclawConfig = loadConfig({ logger });
validateConfigStrict(finclawConfig);
// ↓ L111-117 블록 전체 삭제 (provider=anthropic-sdk 게이트 — SDK 모드 제거로 무의미):
//   // Phase 40 D: SDK provider 는 키 필수 ...
//   if ((finclawConfig.provider ?? 'claude-cli') === 'anthropic-sdk' && !anthropicKey) {
//     console.error('[fatal] provider=anthropic-sdk requires ANTHROPIC_API_KEY. ...');
//     process.exit(1);
//   }
const routing = finclawConfig.routing;
```

게이트 + buildProviders/skills 인자 제거 후 `anthropicKey` (L93 `const anthropicKey = process.env.ANTHROPIC_API_KEY`)
가 고아가 되면 그 선언 + L91-92 주석도 제거 (C 변경 연쇄로 미사용 — CLAUDE.md §3 허용). 구현 시
`grep -n "anthropicKey" packages/server/src/main.ts` 로 0 소비처 확인 후 삭제.

```ts
const { providerAdapter, lanes, toolRegistry } = buildProviders({
  finclawConfig,
  logger,
  mcpEndpoint: {
    url: `http://127.0.0.1:${gatewayPort}/mcp`,
    jwtSecret: defaultConfig.auth.jwtSecret,
  },
});
```

`buildExecution` 호출 (L239 줄 제거):

```ts
const { tracer, runnerFactory, adapter } = buildExecution({
  storage,
  providerAdapter,
  lanes,
  toolRegistry,
  modelCatalog,
  modelAliasIndex,
  profileHealth,
  // ↑ routerLlm 제거
  logger,
  defaultModel: DEFAULT_MODEL,
  systemPrompt: DEFAULT_SYSTEM_PROMPT,
});
```

`buildPipeline` 호출 (L256 줄 제거): `sdkAdapter,` 삭제.

> ⚠️ `anthropicKey` 변수 자체가 main.ts 에서 다른 소비처가 있는지 구현 시 확인
> (`grep -n "anthropicKey" packages/server/src/main.ts`). registerSkills 가 B5 후에도 `anthropicKey` 를 deps 로
> 받지만 — C 에서 RegisterSkillsDeps 의 `anthropicKey` 도 제거 검토 (C11 참조). 모든 소비처 제거 후 `anthropicKey`
> 선언/`resolveApiKeyForProvider` 류 로딩이 고아면 함께 제거. **단 이는 "C 변경으로 미사용이 된 것"이라 CLAUDE.md §3
> 허용 범위.** 고아 판단은 grep 으로 실측 후.

### C11. EDIT `packages/server/src/composition/skills.ts` — RegisterSkillsDeps.anthropicKey 정리

B5 후 skills.ts 내부에서 `anthropicKey` 사용처가 0 이면 `RegisterSkillsDeps.anthropicKey` 필드 (L46-47) 제거 +
구조분해 (L66-79) 에서 `anthropicKey` 제거 + main.ts 의 registerSkills 호출 (L221) 에서 `anthropicKey` 인자 제거.

> 실측: B5 후 skills.ts 의 `anthropicKey` 유일 소비처(news 인자)가 사라짐 → 고아. C 변경 연쇄로 정리 (CLAUDE.md §3).

### C12. EDIT `packages/agent/package.json` — SDK dep 제거

`dependencies` 에서 `"@anthropic-ai/sdk": "^0.91.1"` 제거 (C1 후 agent 의 유일 SDK 사용처 소멸).
`pnpm format:fix` + `pnpm install`.

### C13. EDIT `packages/server/src/composition/providers.test.ts` — dual-path 테스트 정정

L31-39 의 `creates sdkAdapter + routerLlm when anthropicKey present` 테스트(1) 삭제. L18-29 의 pure-CLI 테스트를
`sdkAdapter`/`routerLlm`/`anthropicKey` 단언 제거하고 `providerAdapter`/`toolRegistry` 만 단언하도록 축소.

```ts
import type { FinClawLogger } from '@finclaw/infra';
import type { FinClawConfig } from '@finclaw/types';
import { describe, expect, it, vi } from 'vitest';
import { buildProviders } from './providers.js';

const logger = {
  trace: vi.fn(),
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  fatal: vi.fn(),
  child: vi.fn(),
  flush: vi.fn(),
} as unknown as FinClawLogger;

describe('buildProviders — Phase 41 CLI-only', () => {
  it('creates CLI providerAdapter + toolRegistry', () => {
    const b = buildProviders({
      finclawConfig: { provider: 'claude-cli' } as unknown as FinClawConfig,
      logger,
    });
    expect(b.providerAdapter).toBeDefined();
    expect(b.toolRegistry).toBeDefined();
  });
});
```

### C14. 고아 확인 + 밀스톤 C 검증

```bash
grep -rn "@anthropic-ai/sdk\|AnthropicAdapter\|summarizeText\|sdkFallback\|sdkAdapter\|anthropic-sdk" \
  packages/*/src packages/*/test    # src/test 0건 (dist 잔재는 무시 → build clean 으로 정리)
tsc --build --clean && tsc --build  # dist 잔재(anthropic.d.ts 등) 정리 후 재빌드
pnpm typecheck
pnpm test --run
pnpm lint
```

> `createProviderAdapter({kind:'claude-cli'})` 만 남는지 확인. SDK 모드 경로 0.

커밋: `refactor(phase41)!: remove Anthropic SDK entirely (irreversible — CLI-only)`

---

## 밀스톤 D — LLM 라우터 하위시스템 제거 + 정적 sonnet 기본 모델 (C 의존)

> 목표: C 가 routerLlm *배선*을 걷은 뒤 라우터 _코드_ 삭제 + 토큰 관리를 정적 sonnet 기본으로 전환.
> baseline: llm-router 9 + routing-accuracy 1 + execution-adapter 라우터 테스트 (plan 1건, **실측 4건 — Q1 확인 필요**).
> ⚠️ **단계 D6 은 questions.md Q1 사용자 확인 후 진행 (보류).** D1~D5, D7 은 즉시 가능.

### D1. DELETE `packages/agent/src/router/llm-router.ts`

파일 전체 삭제 (`createLlmRouter`/`LlmRouter`/`RouterIntent`/`RouterDecision`/`RouterInput`/`ROUTER_MODEL_ID`

- `INTENT_POLICY`/`resolveAllowedToolNames`/`extractRouterResponse`/`parseRouterOutput`).

### D2. DELETE 라우터 테스트 2종

- DELETE `packages/agent/src/router/__tests__/llm-router.test.ts` (9 tests)
- DELETE `packages/agent/src/router/__tests__/routing-accuracy.test.ts` (1 test)

> `packages/agent/src/router/` 디렉토리가 비면 빈 디렉토리 정리. (다른 파일이 router/ 에 있으면 유지 — 구현 시 `ls`.)

### D3. EDIT `packages/agent/src/index.ts` — router export 제거

L213-215 의 라우터 export 블록 전체 삭제:

```ts
// ↓ 이 블록 (L213-215) 전체 삭제:
// // ── Phase 34: LLM 오케스트레이터 라우터 ──
// export { createLlmRouter, ROUTER_MODEL_ID } from './router/llm-router.js';
// export type { LlmRouter, RouterIntent, RouterDecision, RouterInput } from './router/llm-router.js';
```

> `models/routing.ts` 의 `ModelRole`/`RouteDecision`/`tierToModelId` 등 export (L50-65) 는 **불변** (라우터
> 하위시스템과 별개 — questions.md Q2). `router-helper.ts` 가 `resolveModelForRequest` 등을 계속 씀.

### D4. EDIT `packages/agent/src/models/catalog-data.ts` — DEFAULT_FALLBACK_CHAIN sonnet-primary

L71-75. opus 격리 (analyze_market 전용) → 기본 체인 sonnet 선두, opus 제외 (questions.md Q4 확정):

```ts
/** 권장 폴백 체인 순서 — Phase 41: sonnet 기본 (opus 는 analyze_market 전용 격리, 토큰 관리). */
export const DEFAULT_FALLBACK_CHAIN = ['claude-sonnet-4-6', 'claude-haiku-4-5-20251001'] as const;
```

### D5. EDIT `packages/server/src/auto-reply/execution-adapter.ts` — 라우터 코드/분기 제거

import 정리 (L1-30): `ROUTER_MODEL_ID`/`tierToModelId`/`type LlmRouter`/`type ModelRole`/`type RouterDecision`
제거. `resolveModel`/`runWithModelFallback`/`calculateEstimatedCost`/`compactContext`/`DEFAULT_FALLBACK_TRIGGERS`/
`evaluateContextWindow`/`ExecutionToolDispatcher as ToolDispatcherCtor`/`type TranscriptEntry` 는 **유지**.

```ts
import {
  calculateEstimatedCost,
  compactContext,
  DEFAULT_FALLBACK_TRIGGERS,
  evaluateContextWindow,
  ExecutionToolDispatcher as ToolDispatcherCtor,
  resolveModel,
  runWithModelFallback,
  type TranscriptEntry,
} from '@finclaw/agent';
// ↑ ROUTER_MODEL_ID, tierToModelId, type LlmRouter, type ModelRole, type RouterDecision 제거
```

제거 대상 (전부 내부 전용, 외부 import 0건 — 실측):

- `ANALYSIS_KEYWORDS`/`FETCH_KEYWORDS` 상수 (L57-69) + `inferRole` 함수 (L48-80) — `ModelRole` 반환했음.
- `RunnerExecutionAdapterDeps.routerLlm` 필드 (L174-179) + Phase 34 주석.
- `execute` 의 `routed` 블록 (L210-222) — `routeToChain` 호출 + `exposedTools = routed ? ... : ...` 삼항을
  `exposedTools = toolDefinitions` 직결로:

```ts
const runner = this.deps.runnerFactory(dispatcher);
const profileId = this.deps.profileId ?? 'default';
const startedAt = Date.now();

// Phase 41: LLM 라우터 제거 — 전체 도구 노출 + fallbackChain(sonnet 선두) 직결.
const exposedTools = toolDefinitions;
```

- `execute` 의 `effectiveChain`/`effectiveFloor` (L256-257) → `routed` 참조 제거:

```ts
const { modelCatalog, modelAliasIndex, fallbackChain } = this.deps;
const effectiveChain = fallbackChain;
let result;
```

그리고 `runWithModelFallback` 의 `floor: effectiveFloor` 인자 (L271) 제거 (floor 없음 → 라우터 시대 floor 미적용):

```ts
        const fallback = await runWithModelFallback(
          {
            models: effectiveChain.map((raw) => ({ raw })),
            maxRetriesPerModel: 1,
            retryBaseDelayMs: 500,
            fallbackOn: DEFAULT_FALLBACK_TRIGGERS,
            abortSignal: signal,
            // ↑ floor: effectiveFloor 제거
          },
```

- `execute` 의 `routed?.routerUsage` 기록 블록 (L315-338) 전체 제거 (ROUTER_MODEL_ID pricing 회계).
- `executeForTui` 의 `routed` 블록 (L392-403) — `routeToChain` 호출 제거, `exposedTools = toolDefinitions` 직결:

```ts
const runner = this.deps.runnerFactory(dispatcher);

// Phase 41: LLM 라우터 제거 — TUI 도 전체 도구 노출.
const exposedTools = toolDefinitions;
```

- `executeForTui` 의 fallback 분기 (L421-449) — `routed` 게이트 제거. 현재 `if (routed && modelCatalog && modelAliasIndex)`
  였던 것을 `fallbackChain` 기반으로. **`executeForTui` 는 `fallbackChain` 을 안 쓰고 `input.model` 단발이었음** →
  라우터 없으면 `runner.execute(buildParams(input.model))` 단발 경로로 단순화 (execute() 와 달리 TUI 는 세션 model 사용):

```ts
const { modelCatalog, modelAliasIndex, fallbackChain } = this.deps;
let result;
let usedModelId: string | undefined;
let usedPricing: ModelPricing | undefined;
let usedIsFallback = false;
if (modelCatalog && modelAliasIndex && fallbackChain && fallbackChain.length > 0) {
  const fallback = await runWithModelFallback(
    {
      models: fallbackChain.map((raw) => ({ raw })),
      maxRetriesPerModel: 1,
      retryBaseDelayMs: 500,
      fallbackOn: DEFAULT_FALLBACK_TRIGGERS,
      abortSignal: signal,
    },
    async (resolved) => {
      const model: ModelRef = {
        ...input.model,
        provider: resolved.provider,
        model: resolved.modelId,
        contextWindow: resolved.entry.contextWindow,
        maxOutputTokens: Math.min(resolved.entry.maxOutputTokens, input.model.maxOutputTokens),
      };
      return runner.execute(buildParams(model), listener);
    },
    (ref) => resolveModel(ref, modelCatalog, modelAliasIndex),
  );
  result = fallback.result;
  usedModelId = fallback.modelUsed.modelId;
  usedPricing = fallback.modelUsed.entry.pricing;
  usedIsFallback = fallback.modelUsed.modelId !== fallbackChain[0];
} else {
  result = await runner.execute(buildParams(input.model), listener);
}
```

> ✅ **결정 (2026-05-26): 보수적 단발 경로 채택 — 위 fallbackChain 통일 블록은 사용하지 않는다.** `executeForTui`
> 는 `routed` 게이트만 제거하고 `result = await runner.execute(buildParams(input.model), listener)` 단발 경로로
> 둔다 (현 CLI 모드 동작 보존 — TUI 사용자가 고른 세션 모델 존중, sonnet 강제 X). `usedModelId`/`usedPricing` 은
> 기존 else 분기의 `input.model` 단발 회계 유지. fallbackChain(sonnet)은 `execute()`(auto-reply Discord/web)에만 적용.

- `routeToChain` (L487-525) / `routeOrFallback` (L531-553) / `keywordFallbackDecision` (L555-572) 메서드
  전체 삭제.

검증: `pnpm typecheck` (execution-adapter 가 컴파일되는지 — routed 참조 0).

### D6. EDIT `packages/server/src/auto-reply/__tests__/execution-adapter.test.ts` — 라우터 테스트 4건 삭제

> ✅ **Q1 해소 (2026-05-26 승인): 4건 전부 삭제** — 라우터 하위시스템이 사라지니 라우터 테스트도 검증 대상 소멸.

삭제 대상 (Q1 확정):

- L1 import 에서 `type LlmRouter, type RouterDecision` 제거 (`Runner` 는 유지). `RouterDecision`/`LlmRouter`
  를 쓰던 곳이 아래 테스트뿐이므로 함께 사라짐.
- L496-505 `mockRouter` helper 삭제.
- L507-519 `allowedToolNames 빈 배열이면 ... tools 미전달` 삭제 (라우터 제거 → 전체 도구 노출이 정상).
- L521-536 `라우터 실패(throw) 시 inferRole 폴백` 삭제 (plan 명시 1건).
- L538-561 `Phase 35: execute 의 signal 을 라우터로 전달` 삭제.
- L564-592 `Phase 34 라우팅 로깅` describe 전체 삭제.

→ execution-adapter 테스트 감소 = **4** (plan 의 1 이 아님). 신 baseline 영향은 D7 / 최종 검증에서 실측 재산정.

대안 (Q1 답이 "보존/재작성"): 일부를 "라우터 없이 전체 도구 노출" 동작 검증으로 재작성. 답 확정 후 이 단계 확정.

### D7. 고아 확인 + 밀스톤 D 검증

```bash
grep -rn "createLlmRouter\|LlmRouter\|inferRole\|routerLlm\|keywordFallback\|ModelRole\|routeToChain\|ROUTER_MODEL_ID" \
  packages/server/src packages/agent/src    # llm-router 삭제 후 0건 (단 models/routing.ts 의 ModelRole 정의는
                                            #  유지되므로 그 1곳은 예외 — grep 결과에서 routing.ts 만 남으면 정상)
pnpm typecheck
tsc --build
pnpm test --run    # 신 baseline 실측 → 최종 검증에서 plan §6 와 대조
pnpm lint
```

> 부팅 후 기본 모델이 sonnet 으로 spawn 되는지 (`provider.initialized` / spawn `--model` 로깅) 확인.
> analyze_market 만 opus (밀스톤 B inner runner modelId='opus').

커밋: `refactor(phase41): remove dead LLM router subsystem, static sonnet default (OpenClaw-aligned)`

---

## 밀스톤 E — KIS→Toss BrokerageClient 추상화 (경계만, Toss 실구현 X)

> 목표: `KisClient` 타입 종속을 `BrokerageClient` 인터페이스로 대체. SyncService 타입 완화 + skills.ts 에
> `BROKERAGE_PROVIDER` 분기 마련. 도구/RPC/storage/NormalizedHolding 불변. baseline 영향 없음 (기존 KIS 테스트 회귀만).

### E1. CREATE `packages/skills-finance/src/brokerage/types.ts` — BrokerageClient 인터페이스

벤더 중립 인터페이스 + provider 타입. `NormalizedHolding` 는 이미 `kis/types.ts` 에 있고 벤더 중립이므로 거기서
re-export (중복 정의 X).

```ts
// packages/skills-finance/src/brokerage/types.ts
import type { NormalizedHolding } from './kis/types.js';

/** 벤더 중립 브로커리지 클라이언트. 구현: KisClient (Toss 는 API 발급 후 별 phase). */
export interface BrokerageClient {
  /** read-only: 정규화된 보유 종목 조회 (벤더별 raw → NormalizedHolding 변환은 구현 내부). */
  fetchHoldings(): Promise<readonly NormalizedHolding[]>;
}

/** 브로커리지 벤더 선택자 (env BROKERAGE_PROVIDER). */
export type BrokerageProvider = 'kis' | 'toss';
```

### E2. EDIT `packages/skills-finance/src/brokerage/kis/client.ts` — `KisClient implements BrokerageClient`

`fetchHoldings()` 추가 (기존 `fetchBalances()` + `fetchNormalizedHoldings` 정규화 위임). `fetchNormalizedHoldings`
(holdings.ts) 는 내부 헬퍼로 유지.

import + class 선언 (L1-4, L41 변경):

```ts
// packages/skills-finance/src/brokerage/kis/client.ts
import type { BrokerageClient } from '../types.js';
import { KisTokenManager } from './auth.js';
import { fetchNormalizedHoldings } from './holdings.js';
import type { NormalizedHolding } from './types.js';
import type { KisCredentials } from './types.js';
import { KisError } from './types.js';
```

> ⚠️ 순환 의존 주의: `types.ts` → `kis/types.js` (NormalizedHolding), `kis/client.ts` → `../types.js`
> (BrokerageClient). `client.ts` → `holdings.js` → `client.js` (KisClient 타입). holdings.ts 가 `import type
{ KisClient }` 이므로 type-only → 런타임 순환 아님. 구현 시 `tsc --build` 로 순환 경고 확인.

`KisClient` class (L41) — `implements BrokerageClient` + `fetchHoldings()` 추가:

```ts
export class KisClient implements BrokerageClient {
  private readonly bucket: TokenBucket;
  constructor(
    private readonly creds: KisCredentials,
    private readonly tokens: KisTokenManager,
    private readonly fetchFn: typeof fetch = fetch,
    now: () => number = Date.now,
    private readonly sleep: (ms: number) => Promise<void> = (ms) =>
      new Promise((r) => setTimeout(r, ms)),
  ) {
    this.bucket = new TokenBucket(creds.env === 'prod' ? 5 : 20, now);
  }

  /** Phase 41: BrokerageClient 구현 — fetchBalances + normalize 위임. */
  async fetchHoldings(): Promise<readonly NormalizedHolding[]> {
    return fetchNormalizedHoldings(this);
  }

  /** read-only: 한국 + 해외 잔고 원응답을 함께 조회. */
  async fetchBalances(): Promise<KisRawBalances> {
    // ... 기존 본문 불변 ...
  }
  // ... withRetry / get 불변 ...
}
```

> `fetchNormalizedHoldings(this)` — holdings.ts 의 시그니처 `(client: KisClient, now?)` 에 `this` (KisClient)
> 주입. 기존 시그니처 불변 (KisClient 타입 그대로).

### E3. CREATE `packages/skills-finance/src/brokerage/index.ts` — barrel

```ts
// packages/skills-finance/src/brokerage/index.ts
export type { BrokerageClient, BrokerageProvider } from './types.js';
export * from './kis/index.js';
export { registerBrokerageTools } from './tools.js';
export type { BrokerageToolDeps } from './tools.js';
```

### E4. EDIT `packages/skills-finance/src/index.ts` — brokerage barrel 경유 export

L27-29 의 직접 export 를 brokerage barrel 경유로 교체 (+ BrokerageClient/BrokerageProvider 노출):

```ts
// Phase 41: brokerage barrel 경유 (BrokerageClient/BrokerageProvider 포함).
export * from './brokerage/index.js';
// ↑ 기존 3줄 (export * from './brokerage/kis/index.js'; / registerBrokerageTools / BrokerageToolDeps) 대체
```

> `brokerage/index.ts` 가 kis/index + tools 를 모두 re-export 하므로 기존 export surface 보존 + 신규 타입 추가.

### E5. EDIT `packages/server/src/services/brokerage-sync-service.ts` — 타입 완화

`KisClient` import → `BrokerageClient`. `deps.client: KisClient` → `BrokerageClient`. 본문
`fetchNormalizedHoldings(this.deps.client)` → `this.deps.client.fetchHoldings()`. `fetchNormalizedHoldings`
import 제거.

```ts
// packages/server/src/services/brokerage-sync-service.ts
import type { DatabaseSync } from 'node:sqlite';
import type { FinClawLogger } from '@finclaw/infra';
import type { BrokerageClient } from '@finclaw/skills-finance';
import { replaceAllHoldings } from '@finclaw/storage';
import type { BrokerageSyncPort } from '@finclaw/types';
// ↑ { type KisClient, fetchNormalizedHoldings } import 제거
```

`BrokerageSyncDeps` (L15-21):

```ts
export interface BrokerageSyncDeps {
  readonly db: DatabaseSync;
  readonly client: BrokerageClient;
  readonly logger: FinClawLogger;
  readonly resolvePortfolioId: () => string;
}
```

`run()` 본문 (L29 변경):

```ts
const holdings = await this.deps.client.fetchHoldings();
```

> `replaceAllHoldings` / `source='kis'` 회계 / 로깅 / `BrokerageSyncResult` 불변. `markets` 집계도 불변
> (`h.market` 은 NormalizedHolding 필드).

### E6. EDIT `packages/server/src/composition/skills.ts` — BROKERAGE_PROVIDER 분기

`KisClient`/`KisTokenManager` import 는 유지 (kis 분기에서 씀). `BrokerageProvider` import 추가. KIS env 읽기 +
`new KisClient` 배선 (L167-211) 을 `BROKERAGE_PROVIDER` (기본 'kis') 분기 뒤로. `toss` 선택 시 미구현 로그 + skip.

import (L16-28 에 BrokerageProvider 추가):

```ts
import {
  KeyRotator,
  KisClient,
  KisTokenManager,
  readKeyArray,
  registerAlertTools,
  registerBrokerageTools,
  registerMarketTools,
  registerNewsTools,
  type AlertSkillHandle,
  type BrokerageProvider,
  type MarketSkillHandle,
  type NewsSkillHandle,
} from '@finclaw/skills-finance';
```

브로커리지 배선 (L165-244 교체) — provider 분기:

```ts
// Phase 33 B-4/B-6 / Phase 41: 브로커리지 read-only 잔고 동기화. BROKERAGE_PROVIDER (기본 kis) 분기.
const brokerageProvider = (process.env.BROKERAGE_PROVIDER ?? 'kis') as BrokerageProvider;

/** 1인 사용자 기본 portfolio 보장 — 없으면 'default' 생성. */
const resolveDefaultPortfolioId = (): string => {
  const existing = storage.db
    .prepare('SELECT id FROM portfolios ORDER BY updated_at ASC LIMIT 1')
    .get() as { id: string } | undefined;
  if (existing) {
    return existing.id;
  }
  storage.db
    .prepare(`INSERT INTO portfolios (id, name, currency, updated_at) VALUES (?, ?, ?, ?)`)
    .run('default', 'Default', 'USD', Date.now());
  return 'default';
};

let brokerageSyncService: BrokerageSyncService | undefined;
let kisEnv: 'prod' | 'vts' = 'prod';

if (brokerageProvider === 'toss') {
  // Phase 41: Toss Open API 미발급/스펙 미공개 — 인터페이스 경계만. 실 구현은 별 phase.
  logger.warn('brokerage.provider_unimplemented', {
    event: 'brokerage.provider_unimplemented',
    provider: 'toss',
    note: 'Toss brokerage client not implemented (awaiting Open API). Skipping brokerage tools.',
  });
} else {
  // provider === 'kis' (기본)
  const kisAppKey = process.env.KIS_APP_KEY;
  const kisAppSecret = process.env.KIS_APP_SECRET;
  const kisAccountNo = process.env.KIS_ACCOUNT_NO;
  const kisAccountProductCode = process.env.KIS_ACCOUNT_PRODUCT_CODE ?? '01';
  kisEnv = (process.env.KIS_ENV ?? 'prod') as 'prod' | 'vts';

  if (kisAppKey && kisAppSecret && kisAccountNo) {
    const creds = {
      env: kisEnv,
      appKey: kisAppKey,
      appSecret: kisAppSecret,
      accountNo: kisAccountNo,
      accountProductCode: kisAccountProductCode,
    };
    const kisClient = new KisClient(creds, new KisTokenManager(creds));
    brokerageSyncService = new BrokerageSyncService({
      db: storage.db,
      client: kisClient,
      logger,
      resolvePortfolioId: resolveDefaultPortfolioId,
    });
    const syncService = brokerageSyncService;
    registerBrokerageTools(toolRegistry, {
      syncHoldings: async () => {
        const r = await syncService.run();
        return { holdingsCount: r.holdingsCount, marketsScanned: r.marketsScanned };
      },
    });
    logger.info('Brokerage (KIS) tools registered', { env: kisEnv });

    // Phase 33 C / Phase 40: news-brief seed — CLI 모드는 seed skip (brokerage_sync_holdings MCP deny).
    const isCliMode = (finclawConfig.provider ?? 'claude-cli') === 'claude-cli';
    if (isCliMode) {
      logger.warn('news_brief.seed_skipped_cli', {
        event: 'news_brief.seed_skipped_cli',
        note: 'read-only CLI mode denies brokerage_sync_holdings (humans-only); the holdings brief needs it. Seed skipped — use SDK mode for the scheduled brief.',
      });
    } else if (getSchedule(storage.db, NEWS_BRIEF_SCHEDULE_ID) === null) {
      const briefCron = '0 0 * * *';
      const briefNext = computeNextRunAt(parseCron(briefCron), Date.now());
      addSchedule(storage.db, {
        id: NEWS_BRIEF_SCHEDULE_ID,
        name: 'Daily holdings news brief',
        cron: briefCron,
        agentId: createAgentId('default'),
        prompt: NEWS_BRIEF_PROMPT,
        deliveryChannel: 'web',
        deliveryTarget: 'broadcast',
        enabled: true,
        nextRunAt: briefNext === null ? undefined : (briefNext as Timestamp),
      });
      logger.info('Seeded news-brief-daily schedule', {
        event: 'schedule.seeded',
        id: NEWS_BRIEF_SCHEDULE_ID,
        cron: briefCron,
      });
    }
  } else {
    logger.info('KIS not configured — skipping brokerage tools');
  }
}
```

> ⚠️ `SkillsBundle.kisEnv` 필드 (L62) 는 유지 — `let kisEnv` 를 함수 스코프로 끌어올려 toss 분기에서도 기본
> 'prod' 로 초기화 (위 코드). main.ts 가 kisEnv 를 소비하면 회귀 없음 (구현 시 `grep -n kisEnv main.ts` 확인).
> news-brief seed 로직은 D3(news-brief 범위 밖)에 따라 **현 동작 그대로 보존** (재설계 X) — kis 분기 내부에 유지.

### E7. 밀스톤 E 검증

```bash
grep -rn "fetchNormalizedHoldings" packages/server/src    # brokerage-sync-service 에서 0건 (client.fetchHoldings 로 대체)
pnpm typecheck
tsc --build      # 순환 의존 경고 없는지 확인 (BrokerageClient ↔ NormalizedHolding type-only)
pnpm test --run --filter @finclaw/skills-finance --filter @finclaw/server
pnpm lint
```

> `BrokerageSyncService` 가 `BrokerageClient` 타입으로 컴파일되는지, KIS 경로 회귀 없는지 확인.
> `BROKERAGE_PROVIDER` 미설정 시 기본 'kis' 로 기존 동작 동일.

커밋: `refactor(phase41): extract BrokerageClient interface (KIS impl, Toss deferred)`

---

## 최종 검증

전 밀스톤 머지 후:

```bash
pnpm format:fix          # oxfmt — package.json 키 순서 정렬 (skills-finance/agent dep 제거 반영)
tsc --build --clean && tsc --build   # dist SDK 잔재 정리 + 재빌드
pnpm typecheck
pnpm test --run          # 신 baseline 실측 — plan §6 ≈1665 (단 Q1 해석에 따라 1662 가능)
pnpm test:storage        # storage 154 불변
pnpm lint
pnpm build
```

baseline 회계 (plan §6 + Q1 보정):

- 삭제: A(sentiment 11 + loadSentimentPrompt 4) + C(summarize-text 4 + cli-fallback 2 + structured-output 2
  - providers dual-path 1) + D(llm-router 9 + routing-accuracy 1 + execution-adapter **4** [plan 1, Q1 실측 4])
    = **−38** (plan 의 −35 + Q1 차이 −3).
- 추가: B7 runner queueKey 테스트 +2 (선택).
- **예상 신 baseline ≈ unit 1664** (1700 − 38 + 2). 구현 시 실측 재산정. plan §6 의 1665 와 ±1~3.

고아 전역 확인 (전 밀스톤 후):

```bash
grep -rn "@anthropic-ai/sdk\|AnthropicAdapter\|summarizeText\|sdkFallback\|sdkAdapter\|anthropic-sdk\|createLlmRouter\|inferRole\|routerLlm" \
  packages/*/src packages/*/test    # 0건
```

---

## 롤백 절차

각 밀스톤이 독립 커밋이라 `git revert {밀스톤 커밋}` 으로 단계적 롤백 가능. 단:

- **밀스톤 C 는 비가역 의도** (plan D1) — revert 는 코드 복원만 가능, 운영상 SDK 모드 재도입은 별 결정 필요.
- D 는 C 의존 (routerLlm 배선이 C 에서 제거됨) → D revert 후 C 가 남아있으면 routerLlm 미배선이라 라우터 코드만
  복원될 뿐 동작 안 함. C+D 는 함께 revert 권장.
- E 는 독립 — 단독 revert 안전.
