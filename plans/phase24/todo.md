# Phase 24: 모델 역할 라우팅 — Todo

## 개요

Phase 23 에서 진입점이 채팅·RPC·자동화·Web·TUI·스킬 내부 LLM 까지 6종으로 늘어난 위에, **요청의 역할(A) + 도구 minModel(C) → max(A,C)** 로 모델을 자동 선택하는 라우터를 도입. 모든 Anthropic SDK 호출 site 6개를 라우터에 연결. 신규 모델 추가 없음 — 기존 카탈로그·fallback 위에 선택 레이어 1개.

**수정 21개 + 신규 5개 = 26개 파일, ~1,200 LOC**

### 전제 (변경되지 않는 인프라)

- `BUILT_IN_MODELS` (Opus 4.7 / Sonnet 4.6 / Haiku 4.5), `DEFAULT_FALLBACK_CHAIN` — 그대로 사용
- `runWithModelFallback` (fallback.ts:60-144) — 시그니처에 `floor` 추가만, chain 순회 로직은 그대로
- `resolveModel` (selection.ts:28-78) — 그대로 사용
- `RunnerExecutionAdapter.execute()` (execution-adapter.ts:143-172) — 라우터 끼워넣을 핵심 위치
- `InMemoryToolRegistry.list()` (registry.ts:206-208) — 보수적 선스캔 진입점

### 실행 순서

```
밀스톤 A — config 인프라
  Todo 1 (RoutingConfig 타입)             — 독립
  Todo 2 (Zod 스키마 + 기본값)            — Todo 1 필요
  Todo 3 (config.example.json5 예시)      — Todo 2 필요
  Todo 4 (기동 시 라우팅 테이블 로그)     — Todo 2 필요

밀스톤 B — 스킬 메타
  Todo 5 (SkillMetadata/ToolMetadata 타입) — 독립
  Todo 6 (market 메타 전환)                — Todo 5 필요
  Todo 7 (news 메타 전환)                  — Todo 5 필요
  Todo 8 (alerts 메타 전환)                — Todo 5 필요
  Todo 9 (general 메타 전환)               — Todo 5 필요
  Todo 10 (메타 파싱 단위 테스트)          — Todo 6-9 필요

밀스톤 C — 라우터 + 호출 site 배선
  Todo 11 (routing.ts 라우터 신설)         — Todo 1, 5 필요
  Todo 12 (routing.test.ts)                — Todo 11 필요
  Todo 13 (gateway.ts modelHint/role)      — 독립
  Todo 14 (main.ts 라우터 주입)            — Todo 11 필요
  Todo 15 (chat.ts 매 메시지 라우팅)       — Todo 13, 14 필요
  Todo 16 (agent.ts role 파라미터)         — Todo 13, 14 필요
  Todo 17 (execution-adapter 라우팅)       — Todo 14 필요
  Todo 18 (market-analysis modelRef 주입)  — Todo 11, 14 필요
  Todo 19 (sentiment modelRef 주입)        — Todo 11, 14 필요
  Todo 20 (news/index 라우터 의존성)       — Todo 18, 19 필요

밀스톤 D — Fallback strict
  Todo 21 (fallback.ts floor + 에러)        — Todo 11 필요
  Todo 22 (fallback.test.ts floor 케이스)   — Todo 21 필요
  Todo 23 (chat/agent 에러 캐치)            — Todo 15, 16, 21 필요
  Todo 24 (스킬 내부 에러 캐치)             — Todo 18, 19, 21 필요

밀스톤 E — 감사 로그 & status
  Todo 25 (recordResult 시그니처 영향 범위) — 사전 grep
  Todo 26 (ProfileState.byModel)            — Todo 25 필요
  Todo 27 (runner.ts 구조화 로그)           — Todo 11 필요
  Todo 28 (status-command 모델 분포)        — Todo 26 필요
  Todo 29 (스킬 recordResult 호출 추가)     — Todo 26 필요

밀스톤 F — UI override (Stretch)
  Todo 30 (app-chat.ts 모델 hint 버튼)      — Todo 13 필요

최종 검증
  Todo 31 (E2E 시나리오 8개 수동 검증)
```

권장: **A → B → C → D → E → F → 31**. 각 밀스톤 끝에 `pnpm build && pnpm test` 로 실 동작 확인.

### 각 Milestone 정지 조건

- **A 후**: 기동 시 `logger.info({event: 'routing.loaded', table})` 출력. 잘못된 role config → Zod 검증 실패로 기동 중단.
- **B 후**: `MARKET_SKILL_METADATA.tools[0].minModel` 접근 가능. 신/구 형식 둘 다 파싱 통과.
- **C 후**: chat.send → `{role, chosenModel, reason}` 로그. role=fetch + analyze_market → opus 승격 검증. analyze_market 내부 호출도 `claude-sonnet-4-6` 카탈로그 모델 사용.
- **D 후**: Opus mock 503 + minModel=opus 도구 → `ModelFloorExhaustedError` → 사용자 한국어 메시지. floor=haiku 일반 채팅은 정상 fallback.
- **E 후**: `!finclaw status` → 모델 분포·비용·fallback 카운트 출력. 스킬 내부 호출도 ProfileHealthMonitor 에 기록.
- **F 후 (Stretch)**: 웹 UI 에서 메시지 옆 "Opus로 다시" 버튼 → 같은 메시지가 modelHint='opus' 로 재실행.
- **Todo 31 후**: 실제 시나리오 8개 전부 통과.

---

## Todo 1: RoutingConfig 타입 추가 ✅

### 파일 목록

| 작업 | 파일 경로                      | LOC |
| ---- | ------------------------------ | --- |
| 수정 | `packages/types/src/config.ts` | +25 |

### 주의사항

- `FinClawConfig` 인터페이스에 routing 필드 신규 추가. 기존 필드 (gateway, agents, channels, session, logging, models, plugins, finance, meta) 건드리지 말 것.
- `ModelTier = 'haiku' | 'sonnet' | 'opus'` 는 이미 catalog 어딘가에 있을 가능성 — 먼저 grep 후 재정의 회피. 없으면 본 파일에 신설.
- `automation`, `override` 는 nested object — `Partial<>` 으로 감싸 모든 필드를 optional 로 (기본값으로 채워짐).

### 작업 단계

1. 파일 시작부 또는 적절한 위치에 ModelTier import:

   ```ts
   // packages/types/src/config.ts
   export type ModelTier = 'haiku' | 'sonnet' | 'opus';
   ```

   (이미 다른 곳에 있으면 그곳에서 import)

2. `RoutingConfig` 타입 추가:

   ```ts
   export interface RoleProfile {
     readonly preferred: ModelTier;
     readonly maxTokens: number;
   }

   export interface RoutingConfig {
     readonly roles: {
       readonly fetch: RoleProfile;
       readonly chat: RoleProfile;
       readonly analysis: RoleProfile;
       readonly summarize: RoleProfile;
     };
     readonly automation: {
       readonly strictFallback: boolean;
       readonly logVerbose: boolean;
     };
     readonly override: {
       readonly allowClientHint: boolean;
       readonly respectMinModel: boolean;
     };
   }
   ```

3. `FinClawConfig` 에 추가:

   ```ts
   export interface FinClawConfig {
     // ... 기존 필드
     readonly routing?: RoutingConfig; // 미지정 시 기본값
   }
   ```

### 검증

```bash
pnpm --filter @finclaw/types build
# 빌드 성공
```

---

## Todo 2: Zod 스키마 + 기본값 ✅

### 파일 목록

| 작업 | 파일 경로                           | LOC |
| ---- | ----------------------------------- | --- |
| 수정 | `packages/config/src/zod-schema.ts` | +40 |
| 수정 | `packages/config/src/defaults.ts`   | +20 |

### 주의사항

- 파일명이 `schema.ts` 가 아니라 **`zod-schema.ts`** — 자주 헷갈림.
- Zod v4 사용 (`zod/v4` import). `z.object({...}).optional().default(...)` 패턴.
- `RoutingConfig` 가 **전체** optional 이므로 정의 시 모든 nested 필드에 `.default()` 권장.
- defaults.ts 의 DEFAULTS 객체에 `routing` 필드 추가 — Todo 1 의 RoutingConfig 형태에 맞춰.

### 작업 단계

1. `zod-schema.ts` 에 RoutingConfig Zod 스키마:

   ```ts
   const ModelTierSchema = z.enum(['haiku', 'sonnet', 'opus']);

   const RoleProfileSchema = z.object({
     preferred: ModelTierSchema,
     maxTokens: z.number().int().positive(),
   });

   const RoutingConfigSchema = z
     .object({
       roles: z
         .object({
           fetch: RoleProfileSchema.default({ preferred: 'haiku', maxTokens: 1024 }),
           chat: RoleProfileSchema.default({ preferred: 'sonnet', maxTokens: 4096 }),
           analysis: RoleProfileSchema.default({ preferred: 'opus', maxTokens: 8192 }),
           summarize: RoleProfileSchema.default({ preferred: 'haiku', maxTokens: 2048 }),
         })
         .default({}),
       automation: z
         .object({
           strictFallback: z.boolean().default(true),
           logVerbose: z.boolean().default(true),
         })
         .default({}),
       override: z
         .object({
           allowClientHint: z.boolean().default(true),
           respectMinModel: z.boolean().default(true),
         })
         .default({}),
     })
     .default({});
   ```

2. `FinClawConfigSchema` 에 routing 필드 추가:

   ```ts
   export const FinClawConfigSchema = z.object({
     // ... 기존 필드
     routing: RoutingConfigSchema.optional(),
   });
   ```

3. `defaults.ts` 의 DEFAULTS 객체에 routing 추가:

   ```ts
   routing: {
     roles: {
       fetch: { preferred: 'haiku', maxTokens: 1024 },
       chat: { preferred: 'sonnet', maxTokens: 4096 },
       analysis: { preferred: 'opus', maxTokens: 8192 },
       summarize: { preferred: 'haiku', maxTokens: 2048 },
     },
     automation: { strictFallback: true, logVerbose: true },
     override: { allowClientHint: true, respectMinModel: true },
   },
   ```

### 검증

```bash
pnpm --filter @finclaw/config build
pnpm --filter @finclaw/config test
# 잘못된 role 값으로 테스트 추가: { roles: { foobar: {...} } } → Zod 거부
```

---

## Todo 3: config.example.json5 라우팅 예시 ✅

### 파일 목록

| 작업 | 파일 경로              | LOC |
| ---- | ---------------------- | --- |
| 수정 | `config.example.json5` | +25 |

### 주의사항

- YAML 이 **아니라 JSON5** 임을 잊지 말 것 (주석 가능, 트레일링 콤마 가능).
- 사용자가 직접 보는 예시 파일이므로 한국어 주석 친절하게.

### 작업 단계

`config.example.json5` 끝부분에 routing 섹션 추가 (다른 섹션 사이 적절한 위치):

```json5
// 모델 역할 라우팅 — 요청 성격에 맞게 Haiku/Sonnet/Opus 자동 선택
// (Phase 24)
"routing": {
  "roles": {
    "fetch": { "preferred": "haiku", "maxTokens": 1024 },     // 시세·뉴스 등 단순 조회
    "chat": { "preferred": "sonnet", "maxTokens": 4096 },     // 일반 대화
    "analysis": { "preferred": "opus", "maxTokens": 8192 },   // 시장 분석·금융 판단
    "summarize": { "preferred": "haiku", "maxTokens": 2048 }, // 내부 요약 (사용자 직접 호출 X)
  },
  "automation": {
    "strictFallback": true,  // 자동화 실행 시 fallback chain 한 단계 좁게
    "logVerbose": true,      // 자동화 실행은 전량 감사 로그
  },
  "override": {
    "allowClientHint": true, // 사용자가 modelHint 로 모델 선호 표현 가능
    "respectMinModel": true, // 도구의 minModel 하한선 준수 (분석 도구는 무조건 Opus 이상)
  },
},
```

### 검증

```bash
node -e "console.log(require('json5').parse(require('fs').readFileSync('config.example.json5','utf-8')))"
# 파싱 성공
```

---

## Todo 4: 기동 시 라우팅 테이블 로그 ✅

### 파일 목록

| 작업 | 파일 경로                     | LOC |
| ---- | ----------------------------- | --- |
| 수정 | `packages/server/src/main.ts` | +15 |

### 주의사항

- 라우팅 테이블은 사용자가 "어떤 role 이 어떤 모델에 매핑됐나" 한 번에 보는 진단 로그.
- 다른 기동 로그(채널 마운트, 도구 등록) 직후, 모델 라우터 인스턴스 생성 전에 출력.

### 작업 단계

`main.ts` 의 config 로드 직후, agent 인스턴스화 전에:

```ts
// config 로드 직후
const routing = config.routing ?? DEFAULT_ROUTING;

logger.info(
  {
    event: 'routing.loaded',
    table: {
      fetch: routing.roles.fetch.preferred,
      chat: routing.roles.chat.preferred,
      analysis: routing.roles.analysis.preferred,
      summarize: routing.roles.summarize.preferred,
    },
    automation: routing.automation,
    override: routing.override,
  },
  'Model routing table loaded',
);
```

config 미제공 시:

```ts
if (!config.routing) {
  logger.warn({ event: 'routing.config_missing' }, 'routing config not found, using defaults');
}
```

### 검증

```bash
tsx packages/server/src/main.ts 2>&1 | grep routing.loaded
# 한 줄 출력 확인
```

---

## Todo 5: SkillMetadata / ToolMetadata 타입 신설 ✅

### 파일 목록

| 작업 | 파일 경로                     | LOC |
| ---- | ----------------------------- | --- |
| 수정 | `packages/types/src/skill.ts` | +50 |

### 주의사항

- **현재 `SkillMetadata` 타입 자체가 부재** — 각 스킬이 자체 객체 리터럴로 export. 본 todo 는 **통합 타입 신설**.
- 기존 `SkillDefinition`, `SkillCommand`, `SkillTool` 타입 건드리지 말 것 (다른 곳에서 사용 중).
- 하위 호환을 위해 `tools` 필드는 union 으로: `string[]` (구 형식) | `ToolMetadata[]` (신 형식). 런타임 정규화 함수도 함께 export.

### 작업 단계

```ts
// packages/types/src/skill.ts (파일 끝부분에 추가)

import type { ModelTier } from './config.js';

export interface ToolMetadata {
  readonly name: string;
  readonly minModel?: ModelTier;
  readonly reason?: string; // 감사용 사유
}

export interface SkillMetadata {
  readonly name: string;
  readonly description: string;
  readonly version: string;
  readonly requires: {
    readonly env: ReadonlyArray<string>;
    readonly optionalEnv?: ReadonlyArray<string>;
  };
  readonly tools: ReadonlyArray<ToolMetadata>;
}

/** 구 형식 (string[]) 도 받아 정규화. 누락 도구는 minModel 미지정으로 기본 haiku. */
export type SkillMetadataInput = Omit<SkillMetadata, 'tools'> & {
  readonly tools: ReadonlyArray<string | ToolMetadata>;
};

export function normalizeSkillMetadata(input: SkillMetadataInput): SkillMetadata {
  return {
    ...input,
    tools: input.tools.map((t) => (typeof t === 'string' ? { name: t } : t)),
  };
}
```

### 검증

```bash
pnpm --filter @finclaw/types build
# 빌드 성공
```

---

## Todo 6: market 메타 객체 배열 전환 ✅

### 파일 목록

| 작업 | 파일 경로                                     | LOC |
| ---- | --------------------------------------------- | --- |
| 수정 | `packages/skills-finance/src/market/index.ts` | +20 |

### 주의사항

- `MARKET_SKILL_METADATA` 는 line 232~ 에 `as const` 객체. `tools` 필드를 string[] 에서 객체 배열로 전환.
- `as const` 유지 — 타입 추론 좁힘 보존.
- 4개 도구 모두 minModel=haiku (구조화 조회).
- `SkillMetadataInput` 형식이 아니라 `SkillMetadata` 직접 사용도 가능 — 어느 쪽이든 OK.

### 작업 단계

```ts
// packages/skills-finance/src/market/index.ts:232~ 부근

import type { SkillMetadata } from '@finclaw/types';

export const MARKET_SKILL_METADATA: SkillMetadata = {
  name: 'market-data',
  description: '주식, 암호화폐, 외환 시장 데이터를 조회하고 차트를 생성합니다.',
  version: '1.0.0',
  requires: {
    env: [],
    optionalEnv: ['ALPHA_VANTAGE_KEY', 'COINGECKO_KEY', 'FRANKFURTER_KEY'],
  },
  tools: [
    { name: 'get_stock_price', minModel: 'haiku', reason: '구조화 조회' },
    { name: 'get_crypto_price', minModel: 'haiku', reason: '구조화 조회' },
    { name: 'get_forex_rate', minModel: 'haiku', reason: '구조화 조회' },
    { name: 'get_market_chart', minModel: 'haiku', reason: '데이터 포매팅' },
  ],
} as const;
```

### 검증

```bash
pnpm --filter @finclaw/skills-finance build
# 빌드 성공
node -e "const m = require('./packages/skills-finance/dist/index.js'); console.log(m.MARKET_SKILL_METADATA.tools[0])"
# { name: 'get_stock_price', minModel: 'haiku', reason: '구조화 조회' }
```

---

## Todo 7: news 메타 객체 배열 전환 ✅

### 파일 목록

| 작업 | 파일 경로                                   | LOC |
| ---- | ------------------------------------------- | --- |
| 수정 | `packages/skills-finance/src/news/index.ts` | +20 |

### 주의사항

- `NEWS_SKILL_METADATA` 는 line 80~ 부근.
- `analyze_market` 은 **opus 강제** (금융 판단, 환각 방지). reason 명시 중요.
- `get_portfolio_summary` 는 sonnet (포트 요약은 일부 판단 포함).

### 작업 단계

```ts
// packages/skills-finance/src/news/index.ts:80~ 부근

export const NEWS_SKILL_METADATA: SkillMetadata = {
  name: 'news-analysis',
  description: '금융 뉴스 수집, AI 시장 분석, 포트폴리오 추적을 제공합니다.',
  version: '1.0.0',
  requires: {
    env: [],
    optionalEnv: ['NEWSAPI_KEY', 'ALPHA_VANTAGE_KEY', 'ANTHROPIC_API_KEY'],
  },
  tools: [
    { name: 'get_financial_news', minModel: 'haiku', reason: '리스트 반환' },
    { name: 'analyze_market', minModel: 'opus', reason: '금융 판단, 환각 방지' },
    { name: 'get_portfolio_summary', minModel: 'sonnet', reason: '포트 요약 (판단 일부 포함)' },
  ],
} as const;
```

### 검증

```bash
pnpm --filter @finclaw/skills-finance build && \
  node -e "const m = require('./packages/skills-finance/dist/index.js'); console.log(m.NEWS_SKILL_METADATA.tools.find(t => t.name === 'analyze_market'))"
# { name: 'analyze_market', minModel: 'opus', reason: '금융 판단, 환각 방지' }
```

---

## Todo 8: alerts 메타 객체 배열 전환 ✅

### 파일 목록

| 작업 | 파일 경로                                     | LOC |
| ---- | --------------------------------------------- | --- |
| 수정 | `packages/skills-finance/src/alerts/index.ts` | +20 |

### 주의사항

- `ALERT_SKILL_METADATA` 는 line 130~. 4개 도구 모두 haiku.
- 알림 설정 자체에는 LLM 판단 거의 없음.

### 작업 단계

```ts
// packages/skills-finance/src/alerts/index.ts:130~

export const ALERT_SKILL_METADATA: SkillMetadata = {
  name: 'alert-system',
  description: '금융 이벤트 조건부 알림 시스템. 가격, 변동률, 거래량, 뉴스 키워드 모니터링.',
  version: '1.0.0',
  requires: { env: [], optionalEnv: [] },
  tools: [
    { name: 'set_alert', minModel: 'haiku', reason: 'CRUD' },
    { name: 'list_alerts', minModel: 'haiku', reason: 'CRUD' },
    { name: 'remove_alert', minModel: 'haiku', reason: 'CRUD' },
    { name: 'get_alert_history', minModel: 'haiku', reason: '조회' },
  ],
} as const;
```

### 검증

```bash
pnpm --filter @finclaw/skills-finance build
```

---

## Todo 9: general 메타 객체 배열 전환 ✅

### 파일 목록

| 작업 | 파일 경로                              | LOC |
| ---- | -------------------------------------- | --- |
| 수정 | `packages/skills-general/src/index.ts` | +15 |

### 주의사항

- `GENERAL_SKILL_METADATA` 는 line 38~. 3개 도구 모두 haiku (순수 함수, 단순 fetch).

### 작업 단계

```ts
// packages/skills-general/src/index.ts:38~

export const GENERAL_SKILL_METADATA: SkillMetadata = {
  name: 'general',
  description: '날짜·웹 fetch·로컬 파일 등 범용 유틸리티.',
  version: '1.0.0',
  requires: { env: [], optionalEnv: [] },
  tools: [
    { name: 'get_current_datetime', minModel: 'haiku', reason: '순수 함수' },
    { name: 'web_fetch', minModel: 'haiku', reason: '단순 fetch' },
    { name: 'read_local_file', minModel: 'haiku', reason: '단순 fetch' },
  ],
} as const;
```

### 검증

```bash
pnpm --filter @finclaw/skills-general build
```

---

## Todo 10: 메타 파싱 단위 테스트 ✅

### 파일 목록

| 작업 | 파일 경로                                             | LOC |
| ---- | ----------------------------------------------------- | --- |
| 신설 | `packages/types/src/__tests__/skill-metadata.test.ts` | +60 |

### 주의사항

- 신/구 형식 둘 다 파싱 통과 검증.
- `normalizeSkillMetadata` 가 누락 도구 minModel 을 기본 haiku 로 채우는 것은 **아니다** — 본 plan 결정상 누락 시 minModel 미지정 (라우터에서 기본값 처리). 단위 테스트 기준 일관.

### 작업 단계

```ts
// packages/types/src/__tests__/skill-metadata.test.ts
import { describe, it, expect } from 'vitest';
import { normalizeSkillMetadata, type SkillMetadataInput } from '../skill.js';

describe('normalizeSkillMetadata', () => {
  it('신 형식: ToolMetadata 객체 배열 그대로 통과', () => {
    const input: SkillMetadataInput = {
      name: 'x',
      description: 'd',
      version: '1.0',
      requires: { env: [] },
      tools: [{ name: 'foo', minModel: 'opus', reason: 'r' }],
    };
    const result = normalizeSkillMetadata(input);
    expect(result.tools[0]).toEqual({ name: 'foo', minModel: 'opus', reason: 'r' });
  });

  it('구 형식: string[] → ToolMetadata 변환', () => {
    const input: SkillMetadataInput = {
      name: 'x',
      description: 'd',
      version: '1.0',
      requires: { env: [] },
      tools: ['foo', 'bar'],
    };
    const result = normalizeSkillMetadata(input);
    expect(result.tools).toEqual([{ name: 'foo' }, { name: 'bar' }]);
  });

  it('혼합 형식: 일부 string, 일부 객체', () => {
    const input: SkillMetadataInput = {
      name: 'x',
      description: 'd',
      version: '1.0',
      requires: { env: [] },
      tools: ['foo', { name: 'bar', minModel: 'sonnet' }],
    };
    const result = normalizeSkillMetadata(input);
    expect(result.tools[0]).toEqual({ name: 'foo' });
    expect(result.tools[1]).toEqual({ name: 'bar', minModel: 'sonnet' });
  });
});
```

### 검증

```bash
pnpm --filter @finclaw/types test
```

---

## Todo 11: routing.ts 라우터 신설 ✅

### 파일 목록

| 작업 | 파일 경로                              | LOC  |
| ---- | -------------------------------------- | ---- |
| 신설 | `packages/agent/src/models/routing.ts` | +150 |

### 주의사항

- **순수 함수** — 외부 의존성 (네트워크, DB, fs) 없음. 테스트 용이성.
- `resolveModel` (selection.ts) 와 다른 책임 — selection 은 ID 해석, routing 은 역할/도구 기반 선택. 두 함수 합치지 말 것.
- `ModelTier` 비교를 위해 순서 정의: `haiku < sonnet < opus`.

### 작업 단계

```ts
// packages/agent/src/models/routing.ts
import type { ModelTier, RoutingConfig, ToolMetadata } from '@finclaw/types';

const TIER_RANK: Record<ModelTier, number> = { haiku: 0, sonnet: 1, opus: 2 };
const RANK_TO_TIER: ReadonlyArray<ModelTier> = ['haiku', 'sonnet', 'opus'];

export type ModelRole = 'fetch' | 'chat' | 'analysis' | 'summarize';

export interface RouteRequest {
  readonly role: ModelRole;
  readonly automation?: boolean;
  readonly availableTools: ReadonlyArray<ToolMetadata>;
  readonly userHint?: ModelTier;
}

export interface RouteDecision {
  readonly tier: ModelTier;
  readonly floor: ModelTier; // fallback chain 절단용
  readonly reason: string;
  readonly overriddenBy: 'role' | 'tool_min' | 'hint';
}

export function maxTier(...tiers: ReadonlyArray<ModelTier | undefined>): ModelTier {
  let max = 0;
  for (const t of tiers) {
    if (t === undefined) continue;
    max = Math.max(max, TIER_RANK[t]);
  }
  return RANK_TO_TIER[max];
}

export function computeFloor(tools: ReadonlyArray<ToolMetadata>): ModelTier {
  if (tools.length === 0) return 'haiku';
  return maxTier(...tools.map((t) => t.minModel ?? 'haiku'));
}

/**
 * 역할(A) + 도구 최대 minModel(C) + 사용자 hint → 모델 결정.
 * - max(hint ?? A, C) 가 기본
 * - cfg.override.respectMinModel=true 시 hint 가 C 미만이어도 C 승리 (보수)
 * - cfg.override.allowClientHint=false 시 hint 무시
 */
export function resolveModelForRequest(req: RouteRequest, cfg: RoutingConfig): RouteDecision {
  const a = cfg.roles[req.role].preferred;
  const c = computeFloor(req.availableTools);
  const hintAllowed = cfg.override.allowClientHint;
  const hint = hintAllowed ? req.userHint : undefined;

  // hint 우선 + C 하한선
  let chosen: ModelTier;
  let overriddenBy: 'role' | 'tool_min' | 'hint';

  if (hint !== undefined) {
    const candidate = maxTier(hint, c);
    chosen = candidate;
    if (candidate === c && c !== hint) {
      overriddenBy = 'tool_min';
    } else {
      overriddenBy = 'hint';
    }
  } else {
    const candidate = maxTier(a, c);
    chosen = candidate;
    overriddenBy = candidate === c && c !== a ? 'tool_min' : 'role';
  }

  return {
    tier: chosen,
    floor: c,
    reason: `A=${a}, C=${c}, hint=${hint ?? 'none'} → ${chosen} (${overriddenBy})`,
    overriddenBy,
  };
}

/** ModelTier 를 카탈로그 모델 ID 로 변환. catalog-data.ts 의 BUILT_IN_MODELS 참조. */
export function tierToModelId(tier: ModelTier): string {
  switch (tier) {
    case 'haiku':
      return 'claude-haiku-4-5-20251001';
    case 'sonnet':
      return 'claude-sonnet-4-6';
    case 'opus':
      return 'claude-opus-4-7';
  }
}
```

### 검증

```bash
pnpm --filter @finclaw/agent build
```

---

## Todo 12: routing.test.ts ✅

### 파일 목록

| 작업 | 파일 경로                                   | LOC  |
| ---- | ------------------------------------------- | ---- |
| 신설 | `packages/agent/src/models/routing.test.ts` | +220 |

### 주의사항

- 단위 테스트 30+ 케이스. 핵심 의사결정(B1-B6) 모두 커버.
- `resolveModelForRequest` 가 순수 함수이므로 mock 불필요 — config + request 객체만으로 검증.

### 작업 단계

```ts
// packages/agent/src/models/routing.test.ts
import { describe, it, expect } from 'vitest';
import { resolveModelForRequest, computeFloor, maxTier } from './routing.js';
import type { RoutingConfig, ToolMetadata } from '@finclaw/types';

const DEFAULT_CFG: RoutingConfig = {
  roles: {
    fetch: { preferred: 'haiku', maxTokens: 1024 },
    chat: { preferred: 'sonnet', maxTokens: 4096 },
    analysis: { preferred: 'opus', maxTokens: 8192 },
    summarize: { preferred: 'haiku', maxTokens: 2048 },
  },
  automation: { strictFallback: true, logVerbose: true },
  override: { allowClientHint: true, respectMinModel: true },
};

const PRICE_TOOL: ToolMetadata = { name: 'get_stock_price', minModel: 'haiku' };
const ANALYZE_TOOL: ToolMetadata = { name: 'analyze_market', minModel: 'opus' };
const PORTFOLIO_TOOL: ToolMetadata = { name: 'get_portfolio_summary', minModel: 'sonnet' };

describe('maxTier', () => {
  it('undefined 무시', () => {
    expect(maxTier('haiku', undefined, 'sonnet')).toBe('sonnet');
  });
  it('전부 undefined → haiku', () => {
    expect(maxTier(undefined)).toBe('haiku');
  });
  it('opus 가 최강', () => {
    expect(maxTier('haiku', 'opus', 'sonnet')).toBe('opus');
  });
});

describe('computeFloor', () => {
  it('도구 없음 → haiku', () => {
    expect(computeFloor([])).toBe('haiku');
  });
  it('analyze_market 포함 → opus', () => {
    expect(computeFloor([PRICE_TOOL, ANALYZE_TOOL])).toBe('opus');
  });
  it('portfolio + price → sonnet (max)', () => {
    expect(computeFloor([PRICE_TOOL, PORTFOLIO_TOOL])).toBe('sonnet');
  });
  it('minModel 미지정 → haiku 처리', () => {
    expect(computeFloor([{ name: 'foo' }])).toBe('haiku');
  });
});

describe('resolveModelForRequest — 기본 케이스', () => {
  it('role=fetch + 도구 없음 → haiku', () => {
    const r = resolveModelForRequest({ role: 'fetch', availableTools: [] }, DEFAULT_CFG);
    expect(r.tier).toBe('haiku');
    expect(r.overriddenBy).toBe('role');
  });

  it('role=fetch + analyze_market 포함 → opus (C 승리)', () => {
    const r = resolveModelForRequest(
      { role: 'fetch', availableTools: [PRICE_TOOL, ANALYZE_TOOL] },
      DEFAULT_CFG,
    );
    expect(r.tier).toBe('opus');
    expect(r.overriddenBy).toBe('tool_min');
  });

  it('role=chat + 일반 도구만 → sonnet', () => {
    const r = resolveModelForRequest({ role: 'chat', availableTools: [PRICE_TOOL] }, DEFAULT_CFG);
    expect(r.tier).toBe('sonnet');
  });

  it('role=analysis → opus', () => {
    const r = resolveModelForRequest({ role: 'analysis', availableTools: [] }, DEFAULT_CFG);
    expect(r.tier).toBe('opus');
  });
});

describe('resolveModelForRequest — userHint (B2 검증)', () => {
  it('hint=opus + role=chat → opus', () => {
    const r = resolveModelForRequest(
      { role: 'chat', availableTools: [PRICE_TOOL], userHint: 'opus' },
      DEFAULT_CFG,
    );
    expect(r.tier).toBe('opus');
    expect(r.overriddenBy).toBe('hint');
  });

  it('hint=haiku + analyze_market → opus (C 승리, hint 무시)', () => {
    const r = resolveModelForRequest(
      { role: 'chat', availableTools: [ANALYZE_TOOL], userHint: 'haiku' },
      DEFAULT_CFG,
    );
    expect(r.tier).toBe('opus');
    expect(r.overriddenBy).toBe('tool_min');
  });

  it('allowClientHint=false → hint 무시', () => {
    const cfg = { ...DEFAULT_CFG, override: { ...DEFAULT_CFG.override, allowClientHint: false } };
    const r = resolveModelForRequest({ role: 'fetch', availableTools: [], userHint: 'opus' }, cfg);
    expect(r.tier).toBe('haiku');
  });
});

describe('resolveModelForRequest — floor 반환 (B6 검증 준비)', () => {
  it('analyze_market → floor=opus', () => {
    const r = resolveModelForRequest({ role: 'chat', availableTools: [ANALYZE_TOOL] }, DEFAULT_CFG);
    expect(r.floor).toBe('opus');
  });

  it('일반 도구만 → floor=haiku', () => {
    const r = resolveModelForRequest({ role: 'chat', availableTools: [PRICE_TOOL] }, DEFAULT_CFG);
    expect(r.floor).toBe('haiku');
  });
});

describe('자동화 플래그', () => {
  it('automation=true 는 결정 결과에 표시 (밀스톤 D 에서 사용)', () => {
    const r = resolveModelForRequest(
      { role: 'analysis', automation: true, availableTools: [] },
      DEFAULT_CFG,
    );
    expect(r.tier).toBe('opus');
    // automation 플래그는 호출자가 fallback 단계에서 사용
  });
});
```

### 검증

```bash
pnpm --filter @finclaw/agent test routing.test
# 30+ 케이스 통과
```

---

## Todo 13: gateway.ts 에 modelHint / role 파라미터 ✅

### 파일 목록

| 작업 | 파일 경로                       | LOC |
| ---- | ------------------------------- | --- |
| 수정 | `packages/types/src/gateway.ts` | +15 |

### 주의사항

- `chat.send` 의 params 에 `modelHint?: ModelTier` 추가.
- `agent.run` 의 params 에 `role?: ModelRole` 추가.
- 둘 다 optional — 기존 호출자 영향 없음.

### 작업 단계

```ts
// packages/types/src/gateway.ts (해당 메서드 타입에 추가)

import type { ModelTier } from './config.js';

// chat.send 파라미터
export interface ChatSendParams {
  readonly sessionId: string;
  readonly message: string;
  readonly idempotencyKey?: string;
  readonly modelHint?: ModelTier; // 신규
}

// agent.run 파라미터
export interface AgentRunParams {
  readonly agentId: string;
  readonly prompt: string;
  readonly timeoutMs?: number;
  readonly stream?: boolean;
  readonly role?: 'fetch' | 'chat' | 'analysis' | 'summarize'; // 신규
}
```

(실제 파일 구조에 따라 인터페이스 이름 다를 수 있음 — 기존 타입 확인 후 그 자리에 필드 추가)

### 검증

```bash
pnpm --filter @finclaw/types build
```

---

## Todo 14: main.ts 라우터 인스턴스 주입 ✅

### 파일 목록

| 작업 | 파일 경로                     | LOC |
| ---- | ----------------------------- | --- |
| 수정 | `packages/server/src/main.ts` | +30 |

### 주의사항

- 라우터는 stateless — config 와 toolRegistry 만 받으면 됨. 싱글톤 인스턴스 1개 충분.
- `agentDeps`, `RunnerExecutionAdapter`, RPC handlers (chat/agent) 모두 라우터 의존성 받게 변경.

### 작업 단계

1. main.ts 상단에 import:

   ```ts
   import { resolveModelForRequest, tierToModelId, type RouteRequest } from '@finclaw/agent';
   ```

2. config 로드 후 라우터 helper 정의:

   ```ts
   const routerHelper = (req: RouteRequest) => {
     const decision = resolveModelForRequest(req, config.routing ?? DEFAULT_ROUTING);
     return { decision, modelId: tierToModelId(decision.tier) };
   };
   ```

3. agentDeps, executionAdapter 인스턴스화 시 routerHelper 전달:

   ```ts
   const adapter = new RunnerExecutionAdapter({
     // 기존 필드
     router: routerHelper,
   });

   const agentDeps = {
     // 기존 필드
     router: routerHelper,
   };
   ```

4. RPC 핸들러 등록 시 routerHelper 전달.

### 검증

```bash
tsx packages/server/src/main.ts &
sleep 3
# routing.loaded 로그 출력 + 정상 기동
```

---

## Todo 15: chat.ts 매 메시지 라우팅 + modelHint ✅

### 파일 목록

| 작업 | 파일 경로                                         | LOC |
| ---- | ------------------------------------------------- | --- |
| 수정 | `packages/server/src/gateway/rpc/methods/chat.ts` | +25 |

### 주의사항

- B3 결정: 매 메시지마다 라우터 호출 (세션 1회 X).
- `chat.send` 핸들러 내부에서 `toolRegistry.list()` 로 도구 세트 스캔 → `RouteRequest` 구성 → 라우터 호출 → 결정된 모델 ID 를 Runner 에 전달.
- B2 결정: chat.start.model 은 세션 default. send.modelHint 가 있으면 send 가 우선.

### 작업 단계

```ts
// packages/server/src/gateway/rpc/methods/chat.ts:63~ 주변 (chat.send 핸들러)

registerMethod('chat.send', async (params, ctx) => {
  const { sessionId, message, modelHint } = parseParams(params);
  const session = await sessionStore.get(sessionId);

  // 매 메시지마다 라우터 호출
  const tools = ctx.toolRegistry.list().map((t) => t.definition.metadata);
  const { decision, modelId } = ctx.router({
    role: 'chat',
    availableTools: tools,
    userHint: modelHint, // session.model 은 무시 (B2: send hint 우선)
    automation: false,
  });

  logger.info({
    event: 'chat.send.routed',
    sessionId,
    role: 'chat',
    chosenModel: modelId,
    floor: decision.floor,
    reason: decision.reason,
  });

  // 기존 흐름에 model 인자만 교체
  const result = await execute({
    session,
    message,
    model: { id: modelId /* ... */ },
    floor: decision.floor, // Todo 21 의 fallback floor
  });

  return { messageId: result.messageId };
});
```

### 검증

```bash
curl -X POST http://localhost:3000/rpc -d '{"jsonrpc":"2.0","method":"chat.send","params":{"sessionId":"...","message":"AAPL 얼마야?"},"id":1}'
# 로그: chat.send.routed { chosenModel: 'claude-haiku-4-5-20251001', floor: 'haiku' }
```

---

## Todo 16: agent.ts role 파라미터 ✅

### 파일 목록

| 작업 | 파일 경로                                          | LOC |
| ---- | -------------------------------------------------- | --- |
| 수정 | `packages/server/src/gateway/rpc/methods/agent.ts` | +25 |

### 주의사항

- `agent.run` 핸들러에 `role` 파라미터 추가. default 'analysis' (대부분의 agent.run 호출이 분석성).
- agent 별 도구 세트 — `agentToolRegistry.list(agentId)` 로 스캔 (agent 단위 도구 그룹 적용).

### 작업 단계

```ts
// packages/server/src/gateway/rpc/methods/agent.ts:109~ (agent.run 핸들러)

const RunSchema = z.object({
  agentId: z.string(),
  prompt: z.string(),
  timeoutMs: z.number().optional(),
  stream: z.boolean().optional(),
  role: z.enum(['fetch', 'chat', 'analysis', 'summarize']).default('analysis'),
});

registerMethod('agent.run', async (params, ctx) => {
  const parsed = RunSchema.parse(params);
  const tools = ctx.toolRegistry.listForAgent(parsed.agentId);

  const { decision, modelId } = ctx.router({
    role: parsed.role,
    availableTools: tools.map((t) => t.metadata),
    automation: ctx.fromCron === true,
  });

  logger.info({
    event: 'agent.run.routed',
    agentId: parsed.agentId,
    role: parsed.role,
    chosenModel: modelId,
    reason: decision.reason,
  });

  // 기존 큐잉 흐름에 model 주입
  return await runQueue.enqueue(parsed.agentId, async () => {
    return await runner.execute({
      prompt: parsed.prompt,
      model: { id: modelId },
      floor: decision.floor,
    });
  });
});
```

### 검증

```bash
curl -X POST http://localhost:3000/rpc -d '{"jsonrpc":"2.0","method":"agent.run","params":{"agentId":"finclaw-partner","prompt":"AAPL 분석"},"id":1}'
# 로그: agent.run.routed { role: 'analysis', chosenModel: 'claude-opus-4-7' }
```

---

## Todo 17: execution-adapter 라우팅 적용 ✅

### 파일 목록

| 작업 | 파일 경로                                             | LOC |
| ---- | ----------------------------------------------------- | --- |
| 수정 | `packages/server/src/auto-reply/execution-adapter.ts` | +40 |

### 주의사항

- B1 결정: `executeForTui()` 의 외부 model 인자를 `userHint` 로 변환.
- `execute()` (파이프라인용) 은 메시지 키워드에 따라 role 추론 — 단순 휴리스틱.
- 키워드 매칭: "분석", "리포트", "판단" → 'analysis' 승격. 그 외 'chat'.

### 작업 단계

```ts
// packages/server/src/auto-reply/execution-adapter.ts

const ANALYSIS_KEYWORDS = ['분석', '리포트', '판단', 'analyze', 'report'];

function inferRole(message: string): ModelRole {
  const lower = message.toLowerCase();
  if (ANALYSIS_KEYWORDS.some((kw) => lower.includes(kw))) return 'analysis';
  return 'chat';
}

class RunnerExecutionAdapter {
  async execute(ctx: PipelineMsgContext): Promise<ExecutionResult> {
    const role = inferRole(ctx.message);
    const tools = this.toolRegistry.list().map((t) => t.metadata);

    const { decision, modelId } = this.router({
      role,
      availableTools: tools,
      automation: ctx.fromAutomation === true,
    });

    logger.info({ event: 'pipeline.routed', role, chosenModel: modelId });

    return await runner.execute({ /* ... */ model: { id: modelId }, floor: decision.floor });
  }

  async executeForTui(args: { sessionKey: string; agentId: string; model: ModelRef; ... }): Promise<...> {
    const tools = this.toolRegistry.list().map((t) => t.metadata);
    const userHint = modelRefToTier(args.model); // ModelRef → ModelTier 변환

    const { decision, modelId } = this.router({
      role: 'chat', // TUI 는 일반 채팅 기본
      availableTools: tools,
      userHint, // 사용자 명시 → hint
    });

    logger.info({ event: 'tui.routed', userHint, chosenModel: modelId });

    return await runner.execute({ /* ... */ model: { id: modelId }, floor: decision.floor });
  }
}

function modelRefToTier(ref: ModelRef): ModelTier {
  if (ref.model.includes('opus')) return 'opus';
  if (ref.model.includes('sonnet')) return 'sonnet';
  return 'haiku';
}
```

### 검증

```bash
# Pipeline 경로
node -e "/* simulate auto-reply with '분석해줘' message */"
# 로그: pipeline.routed { role: 'analysis', chosenModel: 'claude-opus-4-7' }

# TUI 경로
# TUI 클라이언트에서 model='haiku' 명시 + analyze_market 도구 호출 시나리오
# 로그: tui.routed { userHint: 'haiku', chosenModel: 'claude-opus-4-7' } ← C 하한선 적용 (B1)
```

---

## Todo 18: market-analysis modelRef 주입 ✅

### 파일 목록

| 작업 | 파일 경로                                                      | LOC |
| ---- | -------------------------------------------------------------- | --- |
| 수정 | `packages/skills-finance/src/news/analysis/market-analysis.ts` | +25 |

### 주의사항

- 시그니처에 `modelRef: ModelRef` 추가. 기존 `claude-sonnet-4-20250514` 하드코딩 제거.
- 라우터는 호출자(Todo 20)에서 결정 후 modelRef 만 주입.
- 응답 검증 (`AnalysisResponseSchema`) 은 그대로.

### 작업 단계

```ts
// packages/skills-finance/src/news/analysis/market-analysis.ts:19~

import type { ModelRef } from '@finclaw/types';

export async function analyzeMarket(
  client: Anthropic,
  news: readonly NewsItem[],
  options: AnalysisOptions,
  modelRef: ModelRef,  // 신규
): Promise<MarketAnalysis> {
  const depth = options.depth ?? 'standard';
  const language = options.language ?? 'ko';

  const newsDigest = /* 기존 */;
  const systemPrompt = buildAnalysisSystemPrompt(depth, language);
  const userPrompt = buildAnalysisUserPrompt(/* 기존 */);

  const message = await client.messages.create({
    model: modelRef.model,  // 하드코딩 제거
    max_tokens: depth === 'brief' ? 500 : depth === 'detailed' ? 2000 : 1000,
    system: systemPrompt,
    messages: [{ role: 'user', content: userPrompt }],
  });

  // 이하 기존
}
```

### 검증

```bash
grep -n "claude-sonnet-4-20250514" packages/skills-finance/src/news/analysis/market-analysis.ts
# 결과 없음
```

---

## Todo 19: sentiment modelRef 주입 ✅

### 파일 목록

| 작업 | 파일 경로                                                | LOC |
| ---- | -------------------------------------------------------- | --- |
| 수정 | `packages/skills-finance/src/news/analysis/sentiment.ts` | +20 |

### 주의사항

- 동일 패턴. 시그니처에 `modelRef: ModelRef` 추가.
- sentiment 은 role='fetch' (구조화 한 줄 응답) 라 라우터에서 보통 haiku 선택. 단 도구 minModel=opus 인 도구가 함께 등록되어 있으면 floor=opus 까지 승격.

### 작업 단계

```ts
// packages/skills-finance/src/news/analysis/sentiment.ts:113~

export async function analyzeSentiment(
  client: Anthropic,
  news: readonly NewsItem[],
  ruleBasedHint: number,
  modelRef: ModelRef,  // 신규
): Promise<NewsSentiment> {
  const digest = /* 기존 */;

  const message = await client.messages.create({
    model: modelRef.model,  // 하드코딩 제거
    max_tokens: 200,
    system: `You are a financial sentiment analyzer. Analyze news headlines and return JSON: {"score": -1.0~1.0, "label": "very_negative|negative|neutral|positive|very_positive", "confidence": 0.0~1.0}. Rule-based hint score: ${ruleBasedHint.toFixed(2)}.`,
    messages: [{ role: 'user', content: `Analyze sentiment of these headlines:\n${digest}` }],
  });

  // 이하 기존
}
```

### 검증

```bash
grep -rn "claude-sonnet-4-20250514" packages/skills-finance/
# 결과 없음 (Todo 18 + 19 합치면 코드베이스 grep 0건)
```

---

## Todo 20: news/index 라우터 의존성 주입 ✅

### 파일 목록

| 작업 | 파일 경로                                   | LOC |
| ---- | ------------------------------------------- | --- |
| 수정 | `packages/skills-finance/src/news/index.ts` | +15 |

### 주의사항

- `registerAnalyzeMarketTool` 호출 시 라우터를 주입받아 도구 실행 시점에 modelRef 결정.
- 도구 실행 시점 = 외부 LLM 이 도구 호출 결정한 직후. 이때 라우터 호출하여 role='analysis' (analyze_market) 또는 role='fetch' (sentiment) 로 modelRef 결정.

### 작업 단계

```ts
// packages/skills-finance/src/news/index.ts:60~ (도구 등록)

import { resolveModelForRequest, tierToModelId } from '@finclaw/agent';

export interface NewsSkillConfig {
  // 기존
  readonly router?: RouterHelper; // 신규
  readonly routingConfig?: RoutingConfig;
}

export async function registerNewsTools(
  registry: ToolRegistry,
  config: NewsSkillConfig,
): Promise<NewsSkillHandle> {
  // ... 기존

  if (config.anthropicApiKey && config.router) {
    const client = new Anthropic({ apiKey: config.anthropicApiKey });

    registerAnalyzeMarketTool(registry, {
      newsAggregator,
      client,
      executor: async (newsItems, options) => {
        // 도구 실행 시점에 라우터 호출
        const { decision } = config.router!({
          role: 'analysis',
          availableTools: [{ name: 'analyze_market', minModel: 'opus' }],
        });
        const modelRef: ModelRef = {
          provider: 'anthropic',
          model: tierToModelId(decision.tier),
          /* ... */
        };
        return await analyzeMarket(client, newsItems, options, modelRef);
      },
    });

    // sentiment 도 동일 패턴
  }

  return { aggregator: newsAggregator, portfolioStore };
}
```

### 검증

```bash
# 통합 테스트: analyze_market 호출 → 내부 LLM 이 routing 으로 결정된 모델 사용
# 로그: { event: 'tool.execute', tool: 'analyze_market', model: 'claude-opus-4-7' }
```

---

## Todo 21: fallback.ts floor 파라미터 + ModelFloorExhaustedError ✅

### 파일 목록

| 작업 | 파일 경로                               | LOC |
| ---- | --------------------------------------- | --- |
| 수정 | `packages/agent/src/models/fallback.ts` | +80 |

### 주의사항

- B6 결정: floor 미만으로 chain 절단.
- 기존 `runWithModelFallback` 의 chain 순회 로직은 보존 — `floor` 파라미터로 chain 사전 필터링만 추가.
- 새 에러 타입 `ModelFloorExhaustedError` 신설.

### 작업 단계

```ts
// packages/agent/src/models/fallback.ts:60~

import type { ModelTier } from '@finclaw/types';

export class ModelFloorExhaustedError extends Error {
  constructor(
    public readonly floor: ModelTier,
    public readonly chainAttempted: ReadonlyArray<string>,
    public readonly lastError: Error,
  ) {
    super(`No model at or above tier ${floor} succeeded. Attempted: ${chainAttempted.join(', ')}`);
    this.name = 'ModelFloorExhaustedError';
  }
}

const TIER_RANK: Record<ModelTier, number> = { haiku: 0, sonnet: 1, opus: 2 };

function modelIdToTier(modelId: string): ModelTier {
  if (modelId.includes('opus')) return 'opus';
  if (modelId.includes('sonnet')) return 'sonnet';
  return 'haiku';
}

export interface FallbackConfig {
  readonly chain: ReadonlyArray<string>;
  readonly floor: ModelTier; // B6: 신규 — chain 절단 하한선
  readonly fallbackOn?: (err: unknown) => boolean;
  readonly maxRetries?: number;
  readonly automation?: boolean;
  readonly strictFallback?: boolean;
}

export async function runWithModelFallback<T>(
  config: FallbackConfig,
  fn: (model: ResolvedModel) => Promise<T>,
  resolve: (ref: UnresolvedModelRef) => ResolvedModel,
): Promise<FallbackResult<T>> {
  const floorRank = TIER_RANK[config.floor];

  // floor 미만 모델 사전 제거
  let effectiveChain = config.chain.filter((id) => TIER_RANK[modelIdToTier(id)] >= floorRank);

  // automation + strictFallback: floor 위 한 단계 더 좁힘 (예: floor=sonnet → chain 에서 haiku 외에도 sonnet 까지만)
  if (config.automation && config.strictFallback) {
    const top = effectiveChain[0];
    if (top) {
      const topRank = TIER_RANK[modelIdToTier(top)];
      effectiveChain = effectiveChain.filter((id) => TIER_RANK[modelIdToTier(id)] >= topRank - 0); // 동일 tier 만 = 사실상 1개
      // (해석에 따라 -1 까지 허용하는 옵션도 가능. 본 plan 은 동일 tier 만 시도.)
    }
  }

  if (effectiveChain.length === 0) {
    throw new ModelFloorExhaustedError(
      config.floor,
      [],
      new Error('chain is empty after floor filter'),
    );
  }

  // 기존 chain 순회 로직 (CircuitBreaker 등 그대로)
  let lastError: Error | undefined;
  const attempted: string[] = [];
  for (const modelId of effectiveChain) {
    attempted.push(modelId);
    try {
      const resolved = resolve({ id: modelId });
      const result = await fn(resolved);
      return { ok: true, model: resolved, result };
    } catch (err) {
      lastError = err as Error;
      if (config.fallbackOn && !config.fallbackOn(err)) throw err;
      // 다음 모델 시도
    }
  }

  throw new ModelFloorExhaustedError(config.floor, attempted, lastError ?? new Error('unknown'));
}
```

### 검증

```bash
pnpm --filter @finclaw/agent build
pnpm --filter @finclaw/agent test fallback
```

---

## Todo 22: fallback.test.ts floor 케이스 ✅

### 파일 목록

| 작업 | 파일 경로                                    | LOC |
| ---- | -------------------------------------------- | --- |
| 수정 | `packages/agent/src/models/fallback.test.ts` | +50 |

### 작업 단계

```ts
describe('runWithModelFallback — floor (B6)', () => {
  const RESOLVE = (ref: UnresolvedModelRef) => ({ id: ref.id /* ... */ }) as ResolvedModel;

  it('floor=opus + Opus 만 실패 → ModelFloorExhaustedError, Sonnet/Haiku 시도 안 함', async () => {
    const fn = vi.fn().mockRejectedValue(new Error('503'));
    await expect(
      runWithModelFallback(
        {
          chain: ['claude-opus-4-7', 'claude-sonnet-4-6', 'claude-haiku-4-5-20251001'],
          floor: 'opus',
        },
        fn,
        RESOLVE,
      ),
    ).rejects.toThrow(ModelFloorExhaustedError);
    expect(fn).toHaveBeenCalledTimes(1); // Opus 만 시도
  });

  it('floor=sonnet + Opus 503 → Sonnet 시도 → 성공', async () => {
    const fn = vi.fn().mockRejectedValueOnce(new Error('503')).mockResolvedValueOnce('ok');
    const result = await runWithModelFallback(
      { chain: ['claude-opus-4-7', 'claude-sonnet-4-6'], floor: 'sonnet' },
      fn,
      RESOLVE,
    );
    expect(result.ok).toBe(true);
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('floor=haiku + 일반 채팅 → Sonnet 다운 시 Haiku 까지 정상', async () => {
    const fn = vi
      .fn()
      .mockRejectedValueOnce(new Error('503'))
      .mockRejectedValueOnce(new Error('503'))
      .mockResolvedValueOnce('ok');
    const result = await runWithModelFallback(
      {
        chain: ['claude-opus-4-7', 'claude-sonnet-4-6', 'claude-haiku-4-5-20251001'],
        floor: 'haiku',
      },
      fn,
      RESOLVE,
    );
    expect(result.ok).toBe(true);
  });

  it('automation=true + strictFallback + floor=sonnet → Sonnet 외 시도 안 함', async () => {
    const fn = vi.fn().mockRejectedValue(new Error('503'));
    await expect(
      runWithModelFallback(
        {
          chain: ['claude-sonnet-4-6', 'claude-haiku-4-5-20251001'],
          floor: 'sonnet',
          automation: true,
          strictFallback: true,
        },
        fn,
        RESOLVE,
      ),
    ).rejects.toThrow(ModelFloorExhaustedError);
  });
});
```

### 검증

```bash
pnpm --filter @finclaw/agent test fallback
```

---

## Todo 23: chat / agent 에러 캐치 ✅

### 파일 목록

| 작업 | 파일 경로                                          | LOC |
| ---- | -------------------------------------------------- | --- |
| 수정 | `packages/server/src/gateway/rpc/methods/chat.ts`  | +10 |
| 수정 | `packages/server/src/gateway/rpc/methods/agent.ts` | +10 |

### 주의사항

- `ModelFloorExhaustedError` 캐치 → 사용자에게 한국어 메시지로 응답.
- 503 retry-after 60초 표준.

### 작업 단계

```ts
// chat.ts
import { ModelFloorExhaustedError } from '@finclaw/agent';

try {
  const result = await execute(/* ... */);
  return { messageId: result.messageId };
} catch (err) {
  if (err instanceof ModelFloorExhaustedError) {
    logger.warn({
      event: 'chat.send.floor_exhausted',
      floor: err.floor,
      attempted: err.chainAttempted,
    });
    throw new RpcError(
      503,
      '분석 일시 불가 — 상위 모델 사용 불가능합니다. 약 60초 후 재시도해 주세요.',
      {
        retryAfterSec: 60,
        floor: err.floor,
      },
    );
  }
  throw err;
}

// agent.ts 동일 패턴
```

### 검증

```bash
# Anthropic API mock 으로 503 강제
# chat.send → JSON-RPC error code 503 + 한국어 메시지
```

---

## Todo 24: 스킬 내부 에러 캐치 ✅

### 파일 목록

| 작업 | 파일 경로                                                      | LOC |
| ---- | -------------------------------------------------------------- | --- |
| 수정 | `packages/skills-finance/src/news/analysis/market-analysis.ts` | +10 |
| 수정 | `packages/skills-finance/src/news/analysis/sentiment.ts`       | +10 |
| 수정 | `packages/skills-finance/src/news/index.ts`                    | +5  |

### 주의사항

- 도구 실행 시 `ModelFloorExhaustedError` 캐치 → 도구 결과로 `{ ok: false, reason: 'model_unavailable', retryAfterSec: 60 }` 반환.
- 외부 LLM 이 이 결과를 받아 사용자에게 자연어로 안내 (시스템 프롬프트 가이드 — Todo 27 와 짝).

### 작업 단계

```ts
// news/index.ts 의 analyze_market executor

executor: async (newsItems, options) => {
  try {
    const { decision } = config.router!({ role: 'analysis', availableTools: [...] });
    const modelRef = { /* ... */ };
    const result = await analyzeMarket(client, newsItems, options, modelRef);
    return { ok: true, data: result };
  } catch (err) {
    if (err instanceof ModelFloorExhaustedError) {
      return {
        ok: false,
        reason: 'model_unavailable',
        retryAfterSec: 60,
        message: 'Opus 모델 일시 불가. 약 60초 후 재시도 가능.',
      };
    }
    throw err;
  }
},
```

### 검증

```bash
# Opus mock 503 + analyze_market 호출
# 도구 결과: { ok: false, reason: 'model_unavailable', retryAfterSec: 60 }
```

---

## Todo 25: recordResult 시그니처 영향 범위 사전 측정 ✅

### 파일 목록

| 작업     | 파일 경로 | LOC |
| -------- | --------- | --- |
| (조사만) | -         | 0   |

### 주의사항

- Todo 26 진행 전에 `ProfileHealthMonitor.recordResult` 호출 site 전수 grep.
- 영향 범위 큰 경우 시그니처 변경 vs overload 둘 중 선택.

### 작업 단계

```bash
grep -rn "recordResult\|\.recordResult(" packages/ --include="*.ts" --exclude-dir=dist | grep -v ".test.ts"
# 결과 분석:
# - N 곳에서 호출 → 모두 modelId, tokens 인자 추가 필요
# - 또는 신 메서드 recordModelResult() 추가하고 기존 recordResult 그대로 두는 옵션
```

### 검증

호출 site 목록을 본 todo 메모에 기록. Todo 26 시작 시 참조.

---

## Todo 26: ProfileState.byModel 신설 + recordResult 시그니처 ✅

### 파일 목록

| 작업 | 파일 경로                           | LOC |
| ---- | ----------------------------------- | --- |
| 수정 | `packages/agent/src/auth/health.ts` | +80 |

### 주의사항

- `ProfileState` 에 `byModel: Map<modelId, ModelStats>` 추가.
- `ModelStats = { calls, successCount, errorCount, totalCostUsd, fallbacks }`.
- `recordResult(profileId, success)` → `recordResult(profileId, { success, modelId, tokens, cost, isFallback })`.

### 작업 단계

```ts
// packages/agent/src/auth/health.ts:47~

export interface ModelStats {
  calls: number;
  successCount: number;
  errorCount: number;
  totalCostUsd: number;
  fallbacks: number;
}

interface ProfileState {
  records: HealthRecord[];
  byModel: Map<string, ModelStats>; // 신규
}

export interface RecordOptions {
  readonly success: boolean;
  readonly modelId: string;
  readonly tokens: { input: number; output: number };
  readonly costUsd: number;
  readonly isFallback?: boolean;
}

export class ProfileHealthMonitor {
  // ...
  recordResult(profileId: string, options: RecordOptions): void {
    const state = this.getOrCreateState(profileId);
    state.records.push({
      /* 기존 */
    });

    // per-model 집계
    const stats = state.byModel.get(options.modelId) ?? {
      calls: 0,
      successCount: 0,
      errorCount: 0,
      totalCostUsd: 0,
      fallbacks: 0,
    };
    stats.calls += 1;
    if (options.success) stats.successCount += 1;
    else stats.errorCount += 1;
    stats.totalCostUsd += options.costUsd;
    if (options.isFallback) stats.fallbacks += 1;
    state.byModel.set(options.modelId, stats);
  }

  getModelBreakdown(profileId: string, sinceMs: number = 60 * 60 * 1000): Map<string, ModelStats> {
    // 최근 sinceMs 동안의 모델별 분포
    // 단순히 byModel 반환 또는 records 기반 시간 필터링
    return this.getOrCreateState(profileId).byModel;
  }
}
```

### 검증

```bash
pnpm --filter @finclaw/agent test health
```

---

## Todo 27: runner.ts 구조화 로그 + 시스템 프롬프트 가이드 ✅

### 파일 목록

| 작업 | 파일 경로                                | LOC |
| ---- | ---------------------------------------- | --- |
| 수정 | `packages/agent/src/execution/runner.ts` | +40 |
| 수정 | `packages/server/src/main.ts`            | +5  |

### 주의사항

- 모든 LLM 호출 후 구조화 로그 출력: role, chosenModel, selectionPath, reason, tokens, cost, durationMs.
- 시스템 프롬프트에 도구 결과 `model_unavailable` 처리 가이드 1줄 추가 (밀스톤 D 의 phase24 이행 항목, phase25 외부화 시 흡수).

### 작업 단계

1. runner.ts 의 LLM 호출 직후:

   ```ts
   logger.info({
     event: 'agent.execution',
     role: ctx.role,
     automation: ctx.automation,
     chosenModel: model.id,
     selectionPath: ctx.fromFallback ? 'fallback' : 'routing',
     reason: ctx.routingReason,
     availableTools: ctx.tools.map((t) => t.name),
     userHint: ctx.userHint ?? null,
     tokens: { input: response.usage.input_tokens, output: response.usage.output_tokens },
     durationMs: Date.now() - startMs,
     cost: { usd: computeCost(model.id, response.usage) },
   });
   ```

2. main.ts 의 `DEFAULT_SYSTEM_PROMPT` 에 한 줄 추가:

   ```ts
   const DEFAULT_SYSTEM_PROMPT = [
     // ... 기존
     '',
     '## 도구 결과 처리',
     '도구가 `{ ok: false, reason: "model_unavailable" }` 반환 시: 가짜 분석 결과를 만들지 말고 어느 모델이 일시 불가하며 언제 재시도 가능한지 사용자에게 한국어로 안내한다.',
     // ... 기존
   ].join('\n');
   ```

### 검증

```bash
# 임의 호출 → 로그에 모든 필드 출력
# 도구 model_unavailable 시뮬레이션 → 외부 LLM 이 사용자에게 자연어 안내
```

---

## Todo 28: status-command 모델 분포 출력 ✅

### 파일 목록

| 작업 | 파일 경로                                           | LOC |
| ---- | --------------------------------------------------- | --- |
| 수정 | `packages/server/src/auto-reply/commands/status.ts` | +50 |

### 작업 단계

```ts
// status.ts 의 출력 부분에 추가

const breakdown = healthMonitor.getModelBreakdown(profileId, 60 * 60 * 1000);
let modelLines = '\n최근 1시간 모델 분포:\n';
for (const [modelId, stats] of breakdown.entries()) {
  const tier = modelIdToTier(modelId);
  const bar = '▓'.repeat(Math.min(10, stats.calls / 5));
  modelLines += `  ${tier.padEnd(8)} ${bar.padEnd(10)} ${stats.calls}회 ($${stats.totalCostUsd.toFixed(2)})\n`;
}

const fallbackTotal = [...breakdown.values()].reduce((sum, s) => sum + s.fallbacks, 0);
if (fallbackTotal > 0) {
  modelLines += `  Fallback 발동: ${fallbackTotal}회\n`;
}

return [, /* 기존 출력 */ modelLines].join('\n');
```

### 검증

```
!finclaw status
# 출력에 "최근 1시간 모델 분포: ... Opus 12회 ($0.52) ..." 포함
```

---

## Todo 29: 스킬 recordResult 호출 추가 ✅

### 파일 목록

| 작업 | 파일 경로                                                      | LOC |
| ---- | -------------------------------------------------------------- | --- |
| 수정 | `packages/skills-finance/src/news/analysis/market-analysis.ts` | +10 |
| 수정 | `packages/skills-finance/src/news/analysis/sentiment.ts`       | +10 |

### 주의사항

- 스킬 내부 LLM 호출도 ProfileHealthMonitor 에 기록되어야 모델 분포에 포함됨.
- healthMonitor 인스턴스를 시그니처로 받거나 (Todo 18 의 newsConfig 에 추가) 또는 client 옆에 dep 주입.

### 작업 단계

```ts
// market-analysis.ts:42 직후
try {
  const startMs = Date.now();
  const message = await client.messages.create({
    /* ... */
  });
  config.healthMonitor?.recordResult('skill-news-analyze', {
    success: true,
    modelId: modelRef.model,
    tokens: { input: message.usage.input_tokens, output: message.usage.output_tokens },
    costUsd: computeCost(modelRef.model, message.usage),
  });
  // 이하 응답 파싱
} catch (err) {
  config.healthMonitor?.recordResult('skill-news-analyze', {
    success: false,
    modelId: modelRef.model /* ... */,
  });
  throw err;
}
```

### 검증

```bash
# analyze_market 호출 후 !finclaw status → 모델 분포에 skill 호출 포함
```

---

## Todo 30: app-chat.ts 모델 hint 버튼 (Stretch) ⬜

### 파일 목록

| 작업 | 파일 경로                      | LOC |
| ---- | ------------------------------ | --- |
| 수정 | `packages/web/src/app-chat.ts` | +30 |

### 주의사항

- B2/F 결정: 메시지별 `modelHint` 송신 가능.
- 응답 메시지 옆에 "Opus로 다시" 버튼 (현재 응답 모델이 Opus 미만일 때만 표시).

### 작업 단계

```ts
// app-chat.ts 의 메시지 렌더링 부분

renderMessage(msg: Message) {
  const buttons = [];
  if (msg.role === 'assistant' && msg.modelTier !== 'opus') {
    buttons.push(html`
      <button @click=${() => this.retryWith(msg, 'opus')}>Opus로 다시</button>
    `);
  }
  return html`
    <div class="msg ${msg.role}">
      ${msg.content}
      ${buttons}
    </div>
  `;
}

async retryWith(originalMsg: Message, hint: ModelTier) {
  await this.gateway.chatSend({
    sessionId: this.sessionId,
    message: this.findUserMessageBefore(originalMsg).content,
    modelHint: hint,
  });
}
```

### 검증

브라우저에서 일반 채팅 → 응답 옆 "Opus로 다시" → 같은 질문 Opus 로 재호출.

---

## Todo 31: E2E 시나리오 8개 수동 검증 ⬜

### 시나리오

1. **단순 시세** — "AAPL 얼마야?" → 로그 chosenModel='claude-haiku-4-5-20251001', floor='haiku'
2. **분석 요청** — "이 뉴스가 내 포트에 미치는 영향 분석해줘" → 외부 LLM Opus + 내부 analyze_market Opus
3. **인사** — "안녕" → Sonnet 선택, 일반 응답
4. **자동화 분석** — 크론 → agent.run({ role: 'analysis', automation: true }) → Opus, 성공 시 정상, 실패 시 strict (Sonnet 으로 안 내려감)
5. **요약** — "오늘 뉴스 요약해" → analysis 추론 → Opus
6. **hint 무시** — chat.send({ modelHint: 'haiku' }) + analyze_market 도구 → Opus (C 승리)
7. **TUI hint** — TUI 클라이언트에서 model='haiku' + analyze_market → Opus 승격 (B1)
8. **chat.start vs send** — start({ model: 'sonnet' }) → send({ modelHint: 'opus' }) → Opus (B2)

### 검증

각 시나리오:

```bash
# 시나리오 1
curl -X POST .../rpc -d '{"method":"chat.send","params":{"message":"AAPL 얼마야?"}, ...}'
# 로그 확인: chat.send.routed { chosenModel: 'claude-haiku-4-5-20251001' }
```

8개 모두 통과 시 Phase 24 완료.

---

## 부록: 자주 쓰는 커맨드

```bash
# 빌드
pnpm build

# 타입 체크
pnpm typecheck

# 테스트
pnpm test
pnpm test routing.test
pnpm test fallback.test

# 포맷
pnpm format:fix

# 린트
pnpm lint

# 기동
tsx packages/server/src/main.ts

# RPC 호출 예시
curl -X POST http://localhost:3000/rpc \
  -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","method":"chat.send","params":{"sessionId":"...","message":"test"},"id":1}'
```

## 부록: 모델 ID 매핑

| Tier   | 카탈로그 ID                 | 가격 (input / output per 1M) |
| ------ | --------------------------- | ---------------------------- |
| haiku  | `claude-haiku-4-5-20251001` | $0.8 / $4                    |
| sonnet | `claude-sonnet-4-6`         | $3 / $15                     |
| opus   | `claude-opus-4-7`           | $15 / $75                    |

## 부록: Phase 25 인계 항목

본 phase 에서 처리하지 않고 phase25 에서 흡수할 항목:

- **시스템 프롬프트 외부화** — Todo 27 에서 한 줄 추가했지만, phase25 에서 `prompts/finclaw.system.ko.md` 로 옮기면 깔끔해짐.
- **`analyze_market` 6 변형 프롬프트 외부화** — `buildAnalysisSystemPrompt` 함수 → `.md` 6 파일.
- **sentiment 시스템 프롬프트 외부화** — `{{ruleHint}}` 변수 치환 형태로.
- **페르소나 통합** — `agent.ts` 의 AGENTS 메타와 `DEFAULT_SYSTEM_PROMPT` 의 정체성 부분이 단일 진실에서 파생되도록.

## 부록: Phase 24 후속 정리 ✅

E2E 검증 직전 코드베이스 하드코딩 스캔 (sub-agent 4개 병렬) 으로 발견된 항목 처리 결과:

### 처리 완료 (테스트 직전 핫픽스)

- **Deprecated 모델 ID 일괄 교체** ✅
  - `claude-sonnet-4-20250514` → `claude-sonnet-4-6` (catalog 와 일치)
  - `claude-sonnet-4-5` → `claude-sonnet-4-6`
  - `claude-haiku-4-20250414` → `claude-haiku-4-5-20251001`
  - 영향: `config/defaults.ts`, `server/main.ts`, `gateway/openai-compat/adapter.ts`, `config.example.json5`, 그리고 5개 테스트 파일.
  - 라우터 활성 시 model 필드는 항상 router 결정으로 덮어쓰지만, fallback 경로(routing config 미설정 시) 가 카탈로그 미존재 ID 로 503 에러 나는 것을 방지.

### 향후 정리 후보 (별도 PR 권장 — 기능에는 영향 없음)

- **TIER_RANK 3곳 중복** — `agent/models/routing.ts`, `agent/models/fallback.ts`, `server/auto-reply/commands/status.ts`. routing.ts 에서 export 하여 통합.
- **ModelRole 타입 중복** — `routing.ts` TS 유니온 vs `agent.ts` Zod 리터럴. 단일 진실 출처 통합.
- **fallback 파라미터 중복** — `execution-adapter.ts` 의 `maxRetriesPerModel: 1`, `retryBaseDelayMs: 500` 이 execute / executeForTui 두 블록에 동일.
- **`'dev-secret'` JWT fallback** — `main.ts:62`. 로컬 테스트엔 무영향이나, production 배포 전 환경변수 강제화 또는 production-mode 검증 로직 필요.
