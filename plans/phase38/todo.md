# Phase 38 Todo: FinClaw Claude 전용 확정 (dead multi-provider 흔적 + dead config 제거)

> plan.md 의 밀스톤 A/B 를 코드 단위로 분해. **전부 동작 0 변화(dead 제거)** — typecheck/build/test 가 안전망. 신규 기능·신규 테스트 없음.
>
> **★ 절대 유지(제거 X):** `gateway/openai-compat/*`(inbound OpenAI 호환 API, 내부 Claude, `openai` 패키지 미사용) · `storage/embeddings/{provider,openai}.ts` 의 `EmbeddingMode='openai'`(RAG 임베딩, ProviderId 아님) · dual-path(`anthropic-sdk`/`claude-cli`) · `provider-normalize.ts`·catalog machinery(좁힌 ProviderId 로 유지).
>
> **★ ProviderId 좁히기 = `'openai'` 만 제거** → `'anthropic' | 'claude-cli'`. **`'claude-cli'` 유지**(CLI 어댑터 `claude-cli/adapter.ts:19` 가 `providerId='claude-cli'` 사용). 리터럴 `'anthropic'` 단일로 좁히면 깨짐 — 금지.
>
> **⚠ 결정 보류 — `_workspace/phase-execute/38-questions.md` 참조:**
>
> - **Q1 (추천안 반영됨)**: plan 미기재 테스트 2건 동반 처리 — `test/providers/openai.test.ts` 삭제 + `test/catalog.test.ts` 모델 개수 단언 수정. (A3·A8 단계)
> - **Q2 (추천안 반영됨)**: `fallback.test.ts` cross-provider 게이트 fixture 를 `as ProviderId` 캐스트로 보존. (A7 단계)
> - **Q4 (기본값 반영됨)**: `FinanceConfig.portfolios` 는 dead 로 보이나 plan 범위 외 → **유지**. (밀스톤 B 에서 건드리지 않음)
> - **Q3 (미결정)**: dead finance config 제거가 strictObject 때문에 살아있는 검증 회귀망(URL 거부·배열 issue path)을 건드림 → **B4~B6 단계는 결정 전까지 잠정안**. 아래 `[보류:Q3]` 마킹된 단계는 사용자 승인 후 확정.

---

## 사전 준비

없음. 기존 코드 제거뿐 — 의존성 추가·schema bump·신규 패키지 없음. (단 밀스톤 A 에서 `openai` dep **제거** 후 `pnpm install` 로 lockfile 갱신 — A6 단계.)

---

## 밀스톤 A — dead OpenAI LLM 공급자 표면 제거

> 목표: `OpenAIAdapter`(chat 어댑터) + 그 export + `openai` npm dep + 관련 테스트 케이스 + 카탈로그 gpt-4o/mini + `ProviderId` 의 `'openai'` + `ENV_KEY_MAP`/`health.test` 정합. 전부 dead(검증됨) — typecheck 가 누락 ripple 포착.
>
> 권장 순서: 데이터·테스트 먼저 정리(A1~A3) → 타입 좁히기(A4~A5) → dep/lockfile(A6) → ripple 테스트 수정(A7~A8) → 검증(A9). 중간 상태에서도 typecheck 가능하도록 배치.

### A1. DELETE `packages/agent/src/providers/openai.ts`

삭제 대상: 전체 파일 (`OpenAIAdapter` 클래스 + `toOpenAIMessages`/`toOpenAITools`/`wrapOpenAIError` 헬퍼, LOC 1-216).

dead 근거: `new OpenAIAdapter` 호출 0 (factory 가 `anthropic-sdk`/`claude-cli` 만 생성). `from 'openai'` 가 이 파일 + 그 테스트에서만.

영향:

- `packages/agent/src/index.ts:71` export → A2 에서 제거.
- `packages/agent/src/providers/structured-output.test.ts` import/케이스 → A3 에서 제거.
- `packages/agent/test/providers/openai.test.ts` 전체 → A3(b) 에서 삭제.

검증: A9 의 `pnpm typecheck` 에서 dangling import 일괄 확인.

### A2. EDIT `packages/agent/src/index.ts` — `OpenAIAdapter` export 제거

`:70-71` 의 두 export 중 `OpenAIAdapter` 줄만 제거. `AnthropicAdapter` 는 유지.

```ts
// ─── providers ───
export { getBreakerForProvider, resetBreakers } from './providers/adapter.js';
export type { ProviderAdapter, ProviderRequestParams } from './providers/adapter.js';
export { AnthropicAdapter } from './providers/anthropic.js';
// (삭제) export { OpenAIAdapter } from './providers/openai.js';
```

→ 실제로는 `export { OpenAIAdapter } from './providers/openai.js';` 한 줄 삭제.

검증: `pnpm --filter @finclaw/agent build`

### A3. EDIT/DELETE — OpenAIAdapter 테스트 케이스 제거

#### A3 (a). EDIT `packages/agent/src/providers/structured-output.test.ts` — OpenAIAdapter 케이스 제거, Anthropic 유지

`:7` `import OpenAI from 'openai';` 제거, `:10` `import { OpenAIAdapter } from './openai.js';` 제거, `:65-97` OpenAIAdapter describe 케이스(`it('OpenAIAdapter passes tool_choice...`) 제거. **`:6` `import Anthropic`, `:9` `import { AnthropicAdapter }`, `:13`/`:45` AnthropicAdapter 케이스 2개는 유지.**

결과 파일 (Anthropic 케이스 2개만 남김):

```ts
// packages/agent/src/providers/structured-output.test.ts
// Phase 30 B8: forceToolChoice 가 어댑터 → SDK 호출 body 에 반영되는지.
//
// 외부 API 호출 없이 SDK 의 stream/create 메서드를 vi.spyOn 으로 가로채 호출 인자 검증.

import Anthropic from '@anthropic-ai/sdk';
import { describe, expect, it, vi } from 'vitest';
import { AnthropicAdapter } from './anthropic.js';

describe('Phase 30 B8 — forceToolChoice in providers', () => {
  it('AnthropicAdapter passes tool_choice: { type: "tool", name }', async () => {
    // ... 기존 :13-43 본문 그대로 ...
  });

  it('AnthropicAdapter omits tool_choice when forceToolChoice missing', async () => {
    // ... 기존 :45-63 본문 그대로 ...
  });
});
```

> 변경 핵심: (1) `import OpenAI from 'openai';` 삭제 (2) `import { OpenAIAdapter } from './openai.js';` 삭제 (3) `:65-97` 의 세 번째 `it(...)` 블록 통째 삭제. 기존 두 Anthropic `it` 블록 본문은 손대지 않음.

#### A3 (b). DELETE `packages/agent/test/providers/openai.test.ts` — [Q1 추천안]

삭제 대상: 전체 파일 (LOC 1-54). `import { OpenAIAdapter } from '../../src/providers/openai.js'` + `vi.mock('openai', ...)` + OpenAIAdapter stream/chat 단위 테스트.

dead 근거: 어댑터 + `openai` dep 제거 시 import 자체가 깨짐. 어댑터를 지우면 이 테스트는 검증 대상이 사라짐 (plan: "test 수는 OpenAIAdapter 케이스 제거분만큼 감소(정당)").

> **[Q1]** plan 미기재. 미응답 시 이 삭제로 진행.

검증: `pnpm --filter @finclaw/agent test --run`

### A4. EDIT `packages/agent/src/models/catalog-data.ts` — gpt-4o / gpt-4o-mini 엔트리 2개 제거

`:68` 주석(`// Phase 29 A: OpenAI 모델 ...`) 포함, `:69-106` 의 두 `ModelEntry`(`gpt-4o`, `gpt-4o-mini`) 제거. `BUILT_IN_MODELS` 는 Claude 3종만 남김. **`DEFAULT_FALLBACK_CHAIN`(`:109-114`)은 이미 Claude 3종이라 불변.**

```ts
// packages/agent/src/models/catalog-data.ts
import type { ModelEntry } from './catalog.js';

/**
 * 내장 모델 카탈로그 데이터 (3종 — Claude 전용, Phase 38)
 *
 * TODO(M6): config.models.definitions에서 읽어 registerModel()로 등록하는 초기화 로직 추가.
 * 이 하드코딩 데이터는 폴백 기본값으로만 유지할 것.
 */
export const BUILT_IN_MODELS: readonly ModelEntry[] = [
  {
    id: 'claude-opus-4-7',
    // ... 기존 opus 엔트리 그대로 (:11-29) ...
  },
  {
    id: 'claude-sonnet-4-6',
    // ... 기존 sonnet 엔트리 그대로 (:30-48) ...
  },
  {
    id: 'claude-haiku-4-5-20251001',
    // ... 기존 haiku 엔트리 그대로 (:49-67) ...
  },
  // (삭제) Phase 29 A: gpt-4o + gpt-4o-mini 엔트리 2개 (:68-106)
];

/** 권장 폴백 체인 순서 */
export const DEFAULT_FALLBACK_CHAIN = [
  'claude-opus-4-7',
  'claude-sonnet-4-6',
  'claude-haiku-4-5-20251001',
] as const;
```

> 변경 핵심: `:68-106`(주석 1줄 + gpt 엔트리 2개) 삭제. JSDoc 의 "(6종)" → "(3종 — Claude 전용, Phase 38)" 로 한 줄 갱신. Claude 3 엔트리·FALLBACK_CHAIN 무손상.

검증: `pnpm --filter @finclaw/agent build`

### A5. EDIT — `ProviderId` 좁히기 + `ENV_KEY_MAP` 정합

#### A5 (a). EDIT `packages/agent/src/models/catalog.ts` — `'openai'` 제거

`:4` 의 union 에서 `'openai'` 만 제거. **`'claude-cli'` 유지.**

```ts
// packages/agent/src/models/catalog.ts

/** 모델 제공자 식별자 */
export type ProviderId = 'anthropic' | 'claude-cli';
```

> `ModelEntry.provider: ProviderId`, `ModelCatalog.getModelsByProvider(provider: ProviderId)` 등은 시그니처 불변 — union 만 좁아짐. 좁힌 직후 컴파일 안 되는 곳은 A5(b)·A7 에서 처리, 나머지는 A9 typecheck 가 포착.

검증: A9 typecheck (이 단계 단독으로는 ENV_KEY_MAP 미정합으로 빨강 — A5(b) 와 한 커밋).

#### A5 (b). EDIT `packages/agent/src/auth/resolver.ts` — `ENV_KEY_MAP` 의 openai 엔트리 제거

`ENV_KEY_MAP: Record<ProviderId, string>` 가 union 완전성을 요구 → `'openai'` 제거 시 openai 엔트리도 제거해야 정합. `:34` `openai: 'OPENAI_API_KEY',` 줄 제거.

```ts
/** 제공자별 환경변수 이름 매핑 */
const ENV_KEY_MAP: Record<ProviderId, string> = {
  anthropic: 'ANTHROPIC_API_KEY',
  // (삭제) openai: 'OPENAI_API_KEY',
  // Phase 32 W5: claude-cli 는 OAuth(구독) 인증이라 API 키 미사용 — 이 resolver 경로를 타지 않음.
  // ProviderId 유니온 완전성 위해 매핑만 둠 (Anthropic 백엔드).
  'claude-cli': 'ANTHROPIC_API_KEY',
};
```

> `Record<ProviderId, string>` 는 좁힌 union 의 모든 키를 **요구** — `'openai'` 키가 남아있으면 "Object literal may only specify known properties" 에러. 제거가 정합 조건.

검증: `pnpm --filter @finclaw/agent typecheck` (resolver 단독 정합 확인)

### A6. EDIT `packages/agent/package.json` — `openai` 의존성 제거 + lockfile 갱신

`:19` `"openai": "^4",` 제거. `@anthropic-ai/sdk`/`@finclaw/*`/`zod` 유지.

```json
{
  "name": "@finclaw/agent",
  ...
  "dependencies": {
    "@anthropic-ai/sdk": "^0.91.1",
    "@finclaw/infra": "workspace:*",
    "@finclaw/types": "workspace:*",
    "zod": "^4.0.0"
  }
}
```

이후:

1. `pnpm format:fix` — oxfmt 가 package.json 키 순서 재정렬(직접 편집 후 필수).
2. `pnpm install` — lockfile(`pnpm-lock.yaml`)에서 `openai` 트리 제거. **변경된 lockfile 을 밀스톤 A 커밋에 포함.**

검증:

- `grep -rn "from 'openai'" packages --include=*.ts | grep -v node_modules` → **0줄** (A1·A3 제거 후). 임베딩/openai-compat 은 `from 'openai'` import 가 없으므로 무영향.
- `pnpm install --frozen-lockfile` 가 통과(lockfile 동기화 확인).

### A7. EDIT `packages/agent/test/fallback.test.ts` — cross-provider fixture `as ProviderId` 보존 — [Q2 추천안]

`:283-291` `mixedResolve` 의 `provider` 변수가 `'openai' | 'anthropic'` 로 추론되어 `ResolvedModel.provider`(=`ProviderId`)에 대입됨. ProviderId 좁히기 후 `'openai'` ∉ union → typecheck 에러. **테스트 의도(non-Claude 가 섞인 체인을 cross-provider 게이트가 거르는지)를 보존**하기 위해 `as ProviderId` 캐스트.

상단 import 에 `ProviderId` 타입 추가 (기존 `ResolvedModel` import 줄 근처):

```ts
// ... 기존 import ...
import type { ProviderId } from '../src/models/catalog.js';
// (또는 기존 selection.js import 에 합류 — ResolvedModel 가 거기서 오면)
```

fixture 수정:

```ts
// anthropic 1개 + openai 1개 + anthropic 1개 chain. (Phase 38: ProviderId 는 Claude 전용으로 좁혀졌으나,
// cross-provider 게이트 자체는 유지 — 'openai' 리터럴을 ProviderId 로 캐스트해 게이트 로직만 검증.)
const mixedResolve = (ref: { raw: string }): ResolvedModel => {
  const provider = (ref.raw.startsWith('gpt') ? 'openai' : 'anthropic') as ProviderId;
  return {
    entry: { id: ref.raw, provider } as unknown as ResolvedModel['entry'],
    provider,
    modelId: ref.raw,
    resolvedFrom: 'id',
  };
};
```

> 변경 핵심: `const provider = ... as ProviderId;` 로 캐스트 1곳 + import 1줄. `:293-344` 의 두 `it` 케이스(`allowCrossProvider=false`/`=true`)와 `gpt-4o` raw 문자열 fixture 는 그대로 — `runWithModelFallback` 의 `allowCrossProvider` 게이트 회귀망 유지.
>
> **[Q2]** 미응답 시 이 캐스트안으로 진행. (대안: describe 블록 삭제 — 게이트 회귀망 손실, 비추천.)

검증: `pnpm --filter @finclaw/agent test --run -- fallback`

### A8. EDIT `packages/agent/test/catalog.test.ts` — 모델 개수 단언 수정 — [Q1 추천안]

gpt-4o/mini 제거로 `listModels()` 가 3종이 됨. `:8-10` 의 5종 단언을 3종으로. `:23-27` `getModelsByProvider('anthropic')` length 3 단언은 narrowing/제거 무관 → **유지**.

```ts
it('내장 모델 3종을 모두 조회한다 (Claude 전용 — Phase 38)', () => {
  expect(catalog.listModels()).toHaveLength(3);
});
```

> 변경 핵심: `:8` describe 텍스트 + `:9` `toHaveLength(5)` → `toHaveLength(3)`. `:23-27`(anthropic 3 필터)·`:29-38`(extendedThinking/numericalReasoning 필터, Claude 모델로 여전히 충족)·나머지 케이스는 무손상.
>
> **[Q1]** plan 미기재. 미응답 시 이 수정으로 진행.

검증: `pnpm --filter @finclaw/agent test --run -- catalog`

### A9. EDIT `packages/server/src/gateway/health.test.ts` — `'openai'` 인자 → `'anthropic'`

`createProviderHealthChecker(providerName: string, checkFn)` — **param 타입은 `string`** (ProviderId 아님). 즉 `'openai'` 가 타입 에러를 내진 않으나, Claude 전용 확정 정합상 `:97` 의 `'openai'` 리터럴을 `'anthropic'` 으로 교체(plan §"health.test.ts:97 정합").

```ts
    it('TTL 경과 후 재확인', async () => {
      vi.useFakeTimers();
      const checkFn = vi.fn().mockResolvedValue(undefined);
      const checker = createProviderHealthChecker('anthropic', checkFn);
      // ... 기존 본문 그대로 ...
```

> `:86`(`'anthropic'`), `:109`(`'provider-x'`) 케이스는 무관 — `:97` 한 곳만. 테스트 단언(`provider:openai` 문자열 비교 등)은 이 케이스가 `checkFn` 호출 횟수만 보므로 이름 교체에 영향 없음. (단언이 `'provider:openai'` 를 기대하지 않음 — 재확인됨.)

검증: `pnpm --filter @finclaw/server test --run -- health`

### A10. 밀스톤 A 검증

다음을 모두 통과해야 밀스톤 B 로 진입 (= 1 커밋):

- `pnpm typecheck` — **핵심 안전망**. ProviderId 좁히기 ripple 전수 포착 (`Record<ProviderId>`·`ResolvedModel.provider`·`getModelsByProvider` 호출처 등 컴파일 안 되는 곳).
- `pnpm build` — project references 전파 확인 (agent → server/tui/web).
- `pnpm test --run` — OpenAIAdapter/catalog/fallback 케이스 제거·수정 반영, 그 외 불변.
- `pnpm test:storage`
- `pnpm lint` — dead import/var 잔여 0 확인 (`pnpm format:fix` 후).
- `grep -rn "from 'openai'" packages --include=*.ts | grep -v node_modules` = 0줄.
- `pnpm install --frozen-lockfile` 통과 (lockfile 동기화).

> 커밋 메시지(ASCII subject — feedback): `refactor(phase38): remove dead OpenAI LLM provider surface (Claude-only)`

---

## 밀스톤 B — de-speculate + dead config 제거

> 목표: `runner.ts:190` truncate 주석을 Claude 전용 문구로 + dead finance config(`dataProviders`/`newsFeeds`/`alertDefaults` + 하위 타입 + zod 필드 + 동반 테스트) 제거. `portfolios`(Q4)·`PortfolioConfig`·`HoldingConfig`·`PortfolioSchema`·`HoldingSchema` 는 **유지**(plan 범위 외).

### B1. EDIT `packages/agent/src/execution/runner.ts` — truncate 주석 de-speculate

`:190-191` 의 "multi-provider 도입 시 ... 동적 산정 필요" 투기 문구 제거. **하드코딩 `HARD_MAX_TOOL_RESULT_CHARS`(400K) 값·로직은 불변** — 주석만.

```ts
// 고정 400K (Claude 200K 컨텍스트의 ~50%). FinClaw 는 Claude 전용(anthropic-sdk / claude-cli)이라
// 단일 모델 가정으로 충분 — 모델별 동적 산정 불요.
return truncateToolResult(block, HARD_MAX_TOOL_RESULT_CHARS);
```

> 변경 핵심: 주석 2줄만 교체. `truncateToolResult(...)` 호출·`HARD_MAX_TOOL_RESULT_CHARS` 상수 무손상. OpenClaw `calculateMaxToolResultChars` 언급 제거.

검증: `pnpm --filter @finclaw/agent build`

### B2. EDIT `packages/types/src/config.ts` — `FinanceConfig` dead 필드 3개 + 하위 타입 3개 제거

`FinanceConfig`(`:162-167`)에서 `dataProviders`/`newsFeeds`/`alertDefaults` 3필드 제거, **`portfolios` 유지**(Q4). 하위 타입 `DataProviderConfig`(`:169-174`)/`NewsFeedConfig`(`:176-180`)/`AlertDefaultsConfig`(`:182-185`) 제거. **`PortfolioConfig`(`:187-190`)/`HoldingConfig`(`:192-197`) 유지.**

```ts
export interface FinanceConfig {
  portfolios?: Record<string, PortfolioConfig>;
}

// (삭제) DataProviderConfig / NewsFeedConfig / AlertDefaultsConfig

export interface PortfolioConfig {
  name: string;
  holdings: HoldingConfig[];
}

export interface HoldingConfig {
  symbol: string;
  quantity: number;
  avgCost?: number;
  currency?: string;
}
```

> 변경 핵심: `FinanceConfig` 에서 3줄 제거(portfolios 만 남김) + `DataProviderConfig`/`NewsFeedConfig`/`AlertDefaultsConfig` 인터페이스 3개 삭제. Portfolio/Holding 타입 무손상.

검증: `pnpm --filter @finclaw/types build`

### B3. EDIT `packages/config/src/zod-schema.ts` — `FinanceSchema` dead 필드 + dead 스키마 제거

`FinanceSchema`(`:150-163`)에서 `dataProviders`/`newsFeeds`/`alertDefaults` 3필드 제거, **`portfolios` 유지**. dead 스키마 정의 `DataProviderSchema`(`:86-92`)/`AlertDefaultsSchema`(`:94-98`) 제거. **`HoldingSchema`(`:100-106`)/`PortfolioSchema`(`:108-112`) 유지**(portfolios 가 참조).

```ts
// (삭제) DataProviderSchema (:86-92)
// (삭제) AlertDefaultsSchema (:94-98)

/** 보유 종목 스키마 */
const HoldingSchema = z.strictObject({
  // ... 기존 유지 ...
});

/** 포트폴리오 스키마 */
const PortfolioSchema = z.strictObject({
  // ... 기존 유지 ...
});

// ...

/** 금융 설정 스키마 */
const FinanceSchema = z.strictObject({
  portfolios: z.record(z.string(), PortfolioSchema).optional(),
});
```

> 변경 핵심: `FinanceSchema` 가 `portfolios` 단일 필드 strictObject 로 축소. `DataProviderSchema`/`AlertDefaultsSchema` 2개 삭제 + 그 위 주석. `Holding`/`Portfolio` 스키마는 portfolios 가 쓰므로 유지. `newsFeeds` 는 인라인 정의(`:152-160`)였으므로 별도 스키마 삭제 불요 — `FinanceSchema` 에서 필드만 제거하면 됨.
>
> **⚠ strictObject 주의**: `FinanceSchema` 가 미지정 키를 거부 → B4~B6 의 테스트에서 `dataProviders` 등을 넘기면 검증 실패. 동반 수정 필수.

검증: `pnpm --filter @finclaw/config build`

### B4. EDIT `packages/config/test/zod-schema.test.ts` — dead 필드 사용 케이스 동반 수정 — [보류:Q3]

`:31-34`(finance 유효 케이스), `:60-67`(잘못된 URL 거부), `:69-76`(유효 URL 허용)이 `dataProviders`/`alertDefaults` 를 사용 → strictObject 가 거부하게 됨. **결정 보류(Q3)** — 아래는 **추천안 (A) 회귀망 보존** 기준 잠정 스니펫.

(a) `:31-34` 유효 케이스 — finance 를 살아있는 `portfolios` 로 교체:

```ts
      finance: {
        portfolios: { main: { name: 'Main', holdings: [{ symbol: 'AAPL', quantity: 10 }] } },
      },
```

(b) `:60-67`/`:69-76` URL 거부·허용 — `DataProviderSchema.baseUrl(z.url())` 가 사라지므로 **다른 살아있는 `z.url()` 필드로 대상 이전 필요**. zod-schema 내 `z.url()` 잔존 필드 확인 후 결정 (예: `newsFeeds.url` 도 제거되므로 finance 내 url 검증처가 사라짐 → `gateway`/`web` 등 타 섹션 url 또는 케이스 제거).

> **[보류:Q3]** (a) 는 추천안대로 잠정 반영 가능. (b) 는 살아있는 url 필드 매핑이 plan 범위를 건드릴 수 있어 **사용자 결정 필수** — (A) 대상 이전 vs (B) URL 검증 케이스 삭제. 결정 전 이 단계 확정 보류.

검증: `pnpm --filter @finclaw/config test --run`

### B5. EDIT `packages/config/test/defaults.test.ts` — `:47-55` finance.dataProviders 케이스 — [보류:Q3]

`:49` `dataProviders: [{ name: 'test', apiKey: 'key' }]` + `:53` `result.finance?.dataProviders` 단언이 dead 필드 의존. 케이스 의도는 "기본값에 없는 섹션은 그대로 통과". 살아있는 finance 필드(`portfolios`)로 교체:

```ts
it('기본값에 없는 섹션은 그대로 통과한다', () => {
  const user: FinClawConfig = {
    finance: {
      portfolios: { main: { name: 'Main', holdings: [] } },
    },
  };
  const result = applyDefaults(user);
  expect(result.finance?.portfolios?.main).toBeDefined();
});
```

> **[보류:Q3]** 추천안 (A). 미결정 시 잠정.

검증: `pnpm --filter @finclaw/config test --run`

### B6. EDIT `packages/config/test/validation.test.ts` + `packages/types/test/config.test.ts` — dead 필드 의존 케이스 — [보류:Q3]

(a) `validation.test.ts:33-39` — "배열 내부 에러를 수집한다" 가 `finance.dataProviders:[{name:123}]` 에 의존. dead 필드 제거 시 strictObject 가 "unknown key" 로 먼저 거부 → 테스트 의도(배열 element issue path `[0]`)가 변질. **살아있는 배열 필드로 대상 이전** (예: `models.fallbacks` string[] 또는 `portfolios` 내 holdings 배열):

```ts
it('배열 내부 에러를 수집한다', () => {
  const result = validateConfig({
    finance: { portfolios: { p: { name: 'x', holdings: [{ symbol: 1 }] } } },
  });
  expect(result.valid).toBe(false);
  const arrayIssue = result.issues.find((i) => i.path.includes('[0]'));
  expect(arrayIssue).toBeDefined();
});
```

(b) `types/test/config.test.ts:20` — `finance: { dataProviders: [] }` 타입 리터럴 → 타입 에러. 살아있는 필드로:

```ts
      finance: { portfolios: {} },
```

> **[보류:Q3]** 추천안 (A) 회귀망 보존. (a) 의 holdings 배열로 issue-path 검증을 옮기는 게 의도 보존에 최적. 미결정 시 잠정.

검증: `pnpm --filter @finclaw/config test --run` + `pnpm --filter @finclaw/types test --run`

### B7. 밀스톤 B 검증

다음을 모두 통과 (= 1 커밋):

- `pnpm typecheck`
- `pnpm build`
- `pnpm test --run` — 특히 `@finclaw/config`, `@finclaw/types` 의 finance 관련 케이스 수정 반영.
- `pnpm test:storage`
- `pnpm lint`
- `validateConfigStrict({...})` 가 정상(완료조건) — config 패키지 테스트로 커버.

> 커밋 메시지: `refactor(phase38): de-speculate truncate comment + remove dead finance config`

---

## 최종 검증

phase 전체 완료 후 다음 모두 통과:

- [ ] `pnpm typecheck`
- [ ] `pnpm test --run` (test 수는 OpenAIAdapter/openai.test.ts 케이스 제거분만큼 감소 — 정당. 그 외 불변.)
- [ ] `pnpm test:storage`
- [ ] `pnpm lint`
- [ ] `pnpm build`
- [ ] **mock-only 격리**: API 키 unset 상태에서 `pnpm test --run` 통과 (동작 불변 — 외부 호출 없음).
- [ ] `grep -rn "from 'openai'" packages --include=*.ts | grep -v node_modules` = **0줄** (임베딩/openai-compat 무영향 — 둘 다 `from 'openai'` import 없음).
- [ ] `ProviderId` = `'anthropic' | 'claude-cli'`. `grep -rn "'openai'" packages/agent/src packages/server/src --include=*.ts` 에 LLM provider 용 잔존 0 (임베딩 `EmbeddingMode='openai'` 는 별 타입 — 제외).
- [ ] CLI 어댑터 `claude-cli/adapter.ts:19` `providerId='claude-cli'` 정상 (좁힌 union 에 포함).
- [ ] 카탈로그에 non-Claude 모델 0, `DEFAULT_FALLBACK_CHAIN` 불변(Claude 3종).
- [ ] **유지 확인**: `gateway/openai-compat/*` 빌드·테스트 green (gpt-4o→claude 매핑 테스트 포함 — 제거 대상 아님), `storage/embeddings` green, dual-path provider green.
- [ ] `pnpm install --frozen-lockfile` 통과 (lockfile 동기화).

---

## 정리

- A1(파일 삭제) + A2(export 제거)로 `OpenAIAdapter` 가 완전 소거 → 고아 import/심볼 잔여 0 (lint 로 확인).
- A6 `openai` dep 제거 후 `node_modules` 의 openai 트리는 `pnpm install` 이 정리.
- 자체 생성 외 dead code(execution:_/agent:run:_ 이벤트·always-NULL 컬럼·DefaultPipelineObserver 등)는 **본 phase 비대상** — 건드리지 않음(plan §의도적 비대상).

---

## 롤백 절차

각 밀스톤이 독립 커밋 → 단계적 롤백:

- 밀스톤 B 롤백: `git revert {sha-B}` — 주석·dead config 만 복원 (provider 표면은 제거 유지).
- 밀스톤 A 롤백: `git revert {sha-B} {sha-A}` — provider 표면 + dep + config 전부 복원. **단 A 롤백 시 `pnpm install` 재실행 필요**(lockfile 에 openai 재추가).
- 전체 phase 롤백: phase38 시작 SHA(현재 main HEAD, phase37 #72 머지 후)로 `git reset` 또는 `git revert {sha-A}..{sha-B}`.

> storage 마이그레이션 없음 — SCHEMA_VERSION 처리 불요.

---

## 분해 품질 self-check

- [x] 두 밀스톤 모두 독립 커밋 가능 (A: provider 표면, B: 주석+config). A 단독 적용 후 typecheck green 설계.
- [x] 각 밀스톤 끝 검증 단계(A10, B7).
- [x] 제거뿐이라 CREATE 없음 — DELETE/EDIT 에 위치(라인)+영향+검증 명시.
- [x] plan 범위 외 변경: **portfolios·openai-compat·임베딩·machinery 전부 유지**. plan 미기재 ripple(openai.test.ts·catalog.test.ts·fallback.test.ts·config 테스트)은 typecheck/test 가 강제하는 **불가피한 동반 수정** → Q1~Q3 로 명시.
- [x] 외부 API 의존 테스트: 신규 없음. 기존 mock(`vi.mock('openai')` 포함 파일은 삭제) 유지.
- [x] 마이그레이션 없음.
- [x] 롤백 절차 명시 (A 롤백 시 lockfile 재설치 주의 포함).
- [x] 모호함(Q3) questions.md 분리 + todo 에 `[보류:Q3]` 마킹, 추측 X.
