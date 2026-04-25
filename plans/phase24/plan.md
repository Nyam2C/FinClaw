# Phase 24 — 모델 역할 라우팅 (Model Role Routing)

## Context

Phase 23 에서 `finance.*` / `agent.run` RPC 가 배선되면서 Claude 호출 경로가 채팅 1개에서 **채팅 + 직접 RPC + 자동화 스크립트 + Web UI + TUI + 스킬 내부 LLM 호출** 로 넓어졌다. 그러나 현재 전체 요청이 `claude-sonnet-4-5` 고정(`packages/server/src/main.ts:74-79` `DEFAULT_MODEL`)이거나, 일부 스킬 내부 호출은 `claude-sonnet-4-20250514` (구버전 ID, 카탈로그 부재) 하드코딩 상태라 다음 문제가 발생한다.

1. **비용 낭비** — 단순 시세 조회도 Sonnet, 복잡한 포트폴리오 분석도 Sonnet. 호출량 증가 시 토큰 비용 폭발.
2. **지연 낭비** — "AAPL 얼마야?" 같은 결정론적 조회에 Sonnet 2-5초 지연. Haiku면 수백 ms.
3. **안전 구멍** — `analyze_market` 같이 금융 판단이 필요한 도구도 Sonnet/Haiku 로 처리 가능한 상태. 환각 위험.
4. **인프라 유휴** — `BUILT_IN_MODELS` 에 Opus 4.7 / Sonnet 4.6 / Haiku 4.5 3종, `DEFAULT_FALLBACK_CHAIN`, `runWithModelFallback` 인프라는 이미 존재. 단지 **선택 로직이 없음**. 카탈로그(`catalog-data.ts`)에 inputPerMillion/outputPerMillion 가격 테이블도 박혀 있어 비용 추적 즉시 가능.
5. **사각지대** — `analyze_market` 도구가 내부에서 Anthropic SDK 를 직접 호출(`packages/skills-finance/src/news/analysis/market-analysis.ts:42`)하고, `sentiment` 분석도 동일 패턴(`sentiment.ts:124`)이다. 이 두 호출은 라우팅·fallback 인프라 우회 + 모델 ID 구버전 + ProfileHealthMonitor 추적 누락.

본 Phase의 목표는 **요청의 역할(A)과 사용될 도구의 최소 요구사항(C)을 결합해 모델을 자동 선택**하는 라우터를 도입하고, **모든 Anthropic SDK 호출 site (외부 진입 4개 + 스킬 내부 2개)** 를 라우터에 연결하는 것. 신규 모델 추가는 없고, 기존 카탈로그·fallback 인프라 위에 선택 레이어 1개를 얹는다.

**사용자 결정 사항** (2026-04-24 / 2026-04-26 Q&A):

- 역할 분류: **`fetch / chat / analysis / summarize`** 4개 + `automation` **직교 플래그**. `report` 는 `analysis` 로 흡수.
- 결합 규칙: **`max(A.preferred, ...C.minModels)`** — 강한 쪽(상위 모델)이 이김. C 는 하한선, A 는 기본값.
- 사용자 override: `modelHint` 로 A 만 대체 가능, **C 하한선은 뚫지 않음** (보수). 예: 사용자가 `modelHint: 'haiku'` 줘도 `analyze_market` 쓰이면 Opus 승격.
- 도구 스캔 시점: **"보수적 선스캔"** — 세션에 등록된 모든 도구의 min 중 최대를 초기에 선택. (방안 (b) 턴별 동적 승격은 복잡도 대비 이득 미미로 제외.)
- Haiku 로 금융 판단 절대 금지 — `analyze_market`, `get_portfolio_summary` 는 minModel=Opus 로 강제.
- **TUI 진입점(`executeForTui`)** 도 라우팅 대상에 포함. 사용자가 명시한 모델은 `userHint` 로 취급 — C 하한선 적용. (B1 결정)
- **`chat.start.model`** 은 세션 default, **`chat.send.modelHint`** 는 메시지 단위 override. 둘 다 줬을 때 send hint 가 우선. (B2 결정, 밀스톤 F 와 짝)
- **chat.send 라우팅 시점**: 매 메시지마다 라우터 호출. 도구 세트가 세션 중 동적으로 변할 가능성 + in-process 비용 무시 가능. (B3 결정)
- **스킬 내부 LLM 호출 모델 ID 통일**: `claude-sonnet-4-20250514` → `claude-sonnet-4-6` 카탈로그 동기화. 본 phase 의 밀스톤 C 안에서 시그니처 변경과 함께 처리. (B4 결정)
- **스킬 내부 LLM 호출 라우팅 배선**: `analyzeMarket()`, sentiment 분석 함수 시그니처에 `modelRef` 주입. **단 프롬프트는 코드에 둔 채로 모델만 라우팅** — 프롬프트 외부화는 phase25 책임. (B5 결정)
- **Fallback 도 minModel 준수 (strict)**: 라우팅으로 Opus 선택된 후 Opus 다운 시 **Sonnet/Haiku 로 내려가지 않고 명시적 에러**. 도구의 minModel 이 더 낮으면(예: `get_portfolio_summary` minModel=sonnet) 그 하한선까지만 fallback. 사용자에게는 "분석 일시 불가 — 상위 모델 사용 불가능, 잠시 후 재시도" 로 응답. 환각 금지 원칙(Haiku 로 금융 판단 절대 금지) 보존이 가용성보다 우선. (B6 결정)

---

## 밀스톤 A — 역할 프로파일 인프라

### 목표

`config.yaml` 에 역할별 선호 모델 선언. 런타임에 읽어 라우터에 주입.

### 전제

- `packages/config/src/zod-schema.ts` 는 Zod 기반. 확장 용이.
- `packages/types/src/config.ts` 에 `FinClawConfig` 타입 존재. `routing` 필드 부재 — 신규 추가.
- 현재 모델 지정은 `main.ts:74-79` `DEFAULT_MODEL` 상수뿐.

### 작업

**파일**:

- `packages/types/src/config.ts` (수정, ~25 LOC — `RoutingConfig` 타입 추가)
- `packages/config/src/zod-schema.ts` (수정, ~40 LOC — Zod 스키마)
- `packages/config/src/defaults.ts` (수정, ~20 LOC — 기본값)
- `config.example.json5` (수정, routing 섹션 주석 예시 추가)

**스키마 형태**:

```yaml
routing:
  roles:
    fetch: { preferred: haiku, maxTokens: 1024 }
    chat: { preferred: sonnet, maxTokens: 4096 }
    analysis: { preferred: opus, maxTokens: 8192 }
    summarize: { preferred: haiku, maxTokens: 2048 }
  automation:
    strictFallback: true # 자동화 시 fallback chain 을 한 단계 좁게
    logVerbose: true # 자동화 실행은 전량 감사 로그
  override:
    allowClientHint: true # modelHint 허용 여부
    respectMinModel: true # C 하한선 준수 (항상 true 권장)
```

**기본값** (config 생략 시):

- fetch=haiku / chat=sonnet / analysis=opus / summarize=haiku
- automation.strictFallback=true / logVerbose=true
- override.allowClientHint=true / respectMinModel=true

### 검증

- 기동 시 `logger.info({event: 'routing.loaded', table: {...}})` 형태로 라우팅 테이블 출력
- 잘못된 role 값(`foobar`) → Zod 검증 실패로 기동 중단, 친절한 에러 메시지
- config 미제공 시 기본값 로드 + "routing config not found, using defaults" 경고

---

## 밀스톤 B — 스킬 minModel 메타

### 목표

각 도구가 자신의 최소 모델 요구사항을 선언. 라우터가 스캔 가능.

### 전제

- `packages/types/src/skill.ts` 에 통합 `SkillMetadata` 타입 **부재** (현재 `SkillDefinition`, `SkillCommand`, `SkillTool` 만 정의). 각 스킬이 자체 객체 리터럴로 메타데이터 export 중 (`MARKET_SKILL_METADATA`/`NEWS_SKILL_METADATA`/`ALERT_SKILL_METADATA`/`GENERAL_SKILL_METADATA`).
- 각 메타의 `tools` 필드는 문자열 배열. 도구별 개별 메타데이터 없음.
- 즉 본 밀스톤은 **확장이 아니라 통합 타입 신설 + 객체 배열 전환**.

### 작업

**파일**:

- `packages/types/src/skill.ts` (수정, ~50 LOC — `ToolMetadata` + `SkillMetadata` 통합 타입 신설)
- `packages/skills-finance/src/market/index.ts` (수정, ~20 LOC — line 232~ 메타 객체 도구 배열 전환)
- `packages/skills-finance/src/news/index.ts` (수정, ~20 LOC — line 80~)
- `packages/skills-finance/src/alerts/index.ts` (수정, ~20 LOC — line 130~)
- `packages/skills-general/src/index.ts` (수정, ~15 LOC — line 38~)
- `packages/skills-finance/src/news/index.test.ts` 등 (수정 또는 신설, ~25 LOC — 신/구 형식 둘 다 파싱 테스트)

**타입 신설**:

```ts
// packages/types/src/skill.ts
export interface ToolMetadata {
  readonly name: string;
  readonly minModel?: 'haiku' | 'sonnet' | 'opus';
  readonly reason?: string; // 감사용 (예: "금융 판단 — 환각 위험")
}

export interface SkillMetadata {
  readonly name: string;
  readonly description: string;
  readonly version: string;
  readonly requires: { env: string[]; optionalEnv?: string[] };
  readonly tools: ReadonlyArray<ToolMetadata>;
}
```

**도구별 minModel 지정**:

| 스킬    | 도구                  | minModel | 사유                       |
| ------- | --------------------- | -------- | -------------------------- |
| market  | get_stock_price       | haiku    | 구조화 조회                |
| market  | get_crypto_price      | haiku    | 구조화 조회                |
| market  | get_forex_rate        | haiku    | 구조화 조회                |
| market  | get_market_chart      | haiku    | 데이터 포매팅              |
| news    | get_financial_news    | haiku    | 리스트 반환                |
| news    | analyze_market        | **opus** | 금융 판단, 환각 방지       |
| news    | get_portfolio_summary | sonnet   | 포트 요약 (판단 일부 포함) |
| alerts  | set_alert             | haiku    | CRUD                       |
| alerts  | list_alerts           | haiku    | CRUD                       |
| alerts  | remove_alert          | haiku    | CRUD                       |
| alerts  | get_alert_history     | haiku    | 조회                       |
| general | get_current_datetime  | haiku    | 순수 함수                  |
| general | web_fetch             | haiku    | 단순 fetch                 |
| general | read_local_file       | haiku    | 단순 fetch                 |

**하위 호환**: `tools: string[]` 기존 형식도 파싱 가능하게 Zod union. 누락 도구는 `minModel: 'haiku'` 기본값.

### 검증

- 각 skill 패키지 빌드 성공 (`tsc --build`)
- 타입 테스트: `MARKET_SKILL_METADATA.tools[0].minModel` 접근 가능
- 단위 테스트: SkillMetadata 파싱 — 구 형식/신 형식 둘 다 통과

---

## 밀스톤 C — 라우터 구현

### 목표

역할 + 도구 세트 + 사용자 hint 로 모델 결정하는 순수 함수 + Runner 배선.

### 전제

- `packages/agent/src/models/selection.ts` 에 `resolveModel` 존재 — unresolved → resolved 만 처리 (라우팅 없음). 시그니처: `resolveModel(ref, catalog, aliasIndex, defaultModelId?) → ResolvedModel`.
- `packages/agent/src/models/fallback.ts` 의 `runWithModelFallback` 은 이미 fallback chain 처리 중 (라인 60-144).
- `RunnerExecutionAdapter.execute()` (`packages/server/src/auto-reply/execution-adapter.ts:143-172`) 에서 fallbackChain 활성화 — 라우터 끼워넣기 핵심 위치.
- `RunnerExecutionAdapter.executeForTui()` (라인 203-245) 는 외부에서 model 직접 수령 — 라우팅 적용 시 `userHint` 로 변환.
- `chat.send` (chat.ts:63-105) 는 현재 session.model 직접 사용. modelHint 파라미터 부재.
- `agent.run` (agent.ts:109-221) 은 `deps.defaultModel` 고정. role 파라미터 부재.

### 작업

**파일**:

- `packages/agent/src/models/routing.ts` (신설, ~150 LOC)
- `packages/agent/src/models/routing.test.ts` (신설, ~220 LOC — B1/B2/B3/B5 케이스 추가)
- `packages/types/src/gateway.ts` (수정, ~15 LOC — `chat.send` 의 `modelHint`, `agent.run` 의 `role` 파라미터 추가)
- `packages/server/src/main.ts` (수정, ~30 LOC — 라우터 인스턴스 주입, DEFAULT_MODEL 정정 위치 74-79)
- `packages/server/src/gateway/rpc/methods/chat.ts` (수정, ~25 LOC — role='chat' 태깅, `modelHint` 처리, 매 메시지 라우팅)
- `packages/server/src/gateway/rpc/methods/agent.ts` (수정, ~25 LOC — role 파라미터, default 'analysis')
- `packages/server/src/auto-reply/execution-adapter.ts` (수정, ~40 LOC — `execute()` role 태깅 + `executeForTui()` 의 model 인자 → userHint 변환)
- `packages/skills-finance/src/news/analysis/market-analysis.ts` (수정, ~25 LOC — `analyzeMarket()` 시그니처에 `modelRef` 추가, 모델 ID `claude-sonnet-4-20250514` 제거)
- `packages/skills-finance/src/news/analysis/sentiment.ts` (수정, ~20 LOC — sentiment 분석 함수 시그니처에 `modelRef` 추가, 동일 모델 ID 정정)
- `packages/skills-finance/src/news/index.ts` (수정, ~15 LOC — 도구 등록 시 라우터 호출하여 modelRef 결정 후 주입)

**핵심 API**:

```ts
// packages/agent/src/models/routing.ts
export type ModelRole = 'fetch' | 'chat' | 'analysis' | 'summarize';

export interface RouteRequest {
  role: ModelRole;
  automation?: boolean;
  availableTools: ReadonlyArray<ToolMetadata>; // 이번 실행에 등록된 모든 도구
  userHint?: 'haiku' | 'sonnet' | 'opus';
}

export interface RouteDecision {
  model: ModelRef;
  reason: string; // 감사용 ("A=haiku, C.max=haiku, hint=none → haiku")
  overriddenBy: 'role' | 'tool_min' | 'hint';
}

export function resolveModelForRequest(req: RouteRequest, cfg: RoutingConfig): RouteDecision;
```

**결합 로직**:

1. `A = cfg.roles[req.role].preferred` — 역할 선호
2. `C = max(req.availableTools.map(t => t.minModel ?? 'haiku'))` — 도구 하한
3. `hint = req.userHint` (있으면)
4. 최종 = `max(hint ?? A, C)` — 단 `cfg.override.respectMinModel=true` 시 C 무시 못 함
5. `automation=true` 면 fallback chain 을 `cfg.automation.strictFallback` 기반으로 조정 (밀스톤 D)

**호출 지점**:

| 진입점                         | role                                                  | hint 출처                                 | 비고                                     |
| ------------------------------ | ----------------------------------------------------- | ----------------------------------------- | ---------------------------------------- |
| `chat.send`                    | 'chat'                                                | `modelHint` 파라미터 (B2: send > start)   | 매 메시지마다 라우터 호출 (B3)           |
| `chat.start`                   | —                                                     | `model` 파라미터는 세션 default 로만 저장 | 라우팅은 send 시점에                     |
| `agent.run`                    | 신규 `role` 파라미터, default 'analysis'              | —                                         | role 파라미터는 신규 추가                |
| `auto-reply` (Discord/Channel) | 'chat' 기본, "분석"/"리포트" 키워드면 'analysis' 승격 | —                                         | 단순 휴리스틱, Phase 27+ 에서 classifier |
| `executeForTui`                | session 기반 'chat'                                   | 외부 model 인자 → `userHint` 변환 (B1)    | C 하한선 적용                            |
| `analyze_market` 내부 LLM      | 'analysis' 강제 (도구 minModel=opus 와 정합)          | —                                         | 시그니처에 modelRef 주입 (B5)            |
| `sentiment` 내부 LLM           | 'fetch' (구조화 한 줄 응답)                           | —                                         | 시그니처에 modelRef 주입 (B5)            |
| `finance.*` RPC                | —                                                     | —                                         | Claude 직접 호출 없음, 라우팅 대상 아님  |

### 검증

- 단위 테스트 30+ 케이스:
  - role=fetch + 도구 없음 → haiku
  - role=fetch + analyze_market 포함 → opus (C 승격)
  - role=chat + 일반 도구만 → sonnet
  - role=chat + hint=opus → opus
  - role=analysis + hint=haiku → opus (hint 무시, A 승리)
  - automation=true → strictFallback 적용 확인
  - **B1 검증**: `executeForTui` 에 model='haiku' 인자 + analyze_market 포함 → opus (hint 무시, C 승리)
  - **B2 검증**: chat.start.model='sonnet' + chat.send.modelHint='opus' → opus 선택
  - **B3 검증**: 같은 세션 내 메시지 1=일반도구, 메시지 2=analyze_market → 메시지별로 다른 모델 선택
  - **B5 검증**: analyze_market 호출 → 내부 LLM 이 라우터 결정 모델로 호출, 모델 ID 가 카탈로그(`claude-sonnet-4-6` 등)와 일치
- Integration: chat.send 호출 → 로그에 `{role: 'chat', chosenModel: 'claude-sonnet-4-6', reason: '...'}` 출력
- Integration: analyze_market 호출 → 외부 routing 로그 + 내부 routing 로그 둘 다 출력 (이중 호출 추적)

---

## 밀스톤 D — Fallback 분리 (Selection vs Recovery)

### 목표

"초기 모델 선택" 과 "장애 시 downgrade" 를 코드 경로에서 구분. 로그 명확.

### 전제

- 현재 `runWithModelFallback` 은 초기 모델 받아 실행 + 에러 시 `DEFAULT_FALLBACK_CHAIN` 순회. 두 책임이 섞임.
- 로그에 "왜 이 모델을 골랐나" 가 안 드러남.

### 작업

**파일**:

- `packages/agent/src/models/fallback.ts` (수정, ~80 LOC — `floor` 파라미터, `ModelFloorExhaustedError`)
- `packages/agent/src/models/fallback.test.ts` (수정 또는 신설, ~50 LOC — floor 절단 케이스)
- `packages/agent/src/models/selection.ts` (수정, ~20 LOC)
- `packages/agent/src/index.ts` (수정, `ModelFloorExhaustedError` re-export)
- `packages/server/src/gateway/rpc/methods/chat.ts`, `agent.ts` (수정, 각 ~10 LOC — 에러 캐치 + 사용자 메시지 변환)
- `packages/skills-finance/src/news/analysis/market-analysis.ts`, `sentiment.ts` (수정, 각 ~10 LOC — 에러 캐치 + 도구 결과 변환)

**변경 내용**:

- 초기 선택 = 밀스톤 C 의 `resolveModelForRequest` 결과
- Fallback = 실행 중 에러 발생 시만 발동
- **Fallback chain 을 도구 세트의 `max(minModel)` 으로 절단 (B6)** — 라우팅이 Opus 선택했고 도구 minModel 이 opus 이면 fallback chain 은 `[opus]` 만. Sonnet/Haiku 로 내려가지 않음.
- `runWithModelFallback` 시그니처에 `floor: ModelTier` 파라미터 추가. 라우터가 결정한 도구 세트의 `max(minModel)` 을 floor 로 전달.
- chain 전부 소진 시 `ModelFloorExhaustedError` throw — 호출자(chat/agent/스킬)가 사용자에게 "분석 일시 불가" 메시지로 변환.
- `automation.strictFallback=true` 는 floor 위에서 한 단계 더 좁힘 (예: floor=sonnet 인 경우 chain `[sonnet]` 만, opus 만 가능). 일반 모드(automation=false) 는 floor 까지 자유.
- 로그에 `selectionPath: 'routing' | 'fallback'`, `floor: ModelTier`, `chainAttempted: [...]` 필드 추가

**에러 처리**:

- `ModelFloorExhaustedError` → `chat.send` / `agent.run` 응답: 한국어 사용자 메시지 + 503 retry-after 힌트
- 스킬 내부 호출(analyzeMarket/sentiment) 도 동일 에러 → 도구 결과로 `{ ok: false, reason: 'model_unavailable', retryAfterSec: 60 }` 반환
- **시스템 프롬프트 가이드 1줄 추가** — 외부 LLM 이 도구 결과 `{ ok: false, reason: 'model_unavailable' }` 를 받으면 가짜 분석 결과를 만들지 말고 "어느 모델이 죽었고 언제 재시도 가능한지" 한국어로 안내하도록. `DEFAULT_SYSTEM_PROMPT` (`main.ts:81-103`) 의 환각 금지 원칙 아래에 명시. **phase25 (프롬프트 외부화) 와 짝** — phase24 에서 한 줄 추가, phase25 에서 `.md` 외부화 시 자연스럽게 흡수.

### 검증

- 라우팅으로 Opus 선택 → Anthropic API 정상 응답 → 로그 `selectionPath: 'routing'`
- Opus 과부하 + 도구 minModel=opus → Sonnet 으로 내려가지 않고 `ModelFloorExhaustedError` → 사용자에게 "분석 일시 불가" 응답 (B6)
- Opus 과부하 + 도구 minModel=sonnet (예: get_portfolio_summary) → Sonnet 으로 fallback → 로그 `selectionPath: 'fallback', from: 'opus', to: 'sonnet'`
- `automation=true` + floor=sonnet → Sonnet 외 시도 안 함, opus 다운 시 즉시 floor 도달 에러
- 일반 채팅(role=chat, 일반 도구만 = floor=haiku) → Sonnet 다운 시 Haiku 까지 정상 fallback
- `analyze_market` 호출 + Opus 다운 → 도구 결과 `{ ok: false, reason: 'model_unavailable' }` + 외부 LLM 이 사용자에게 친절히 안내

---

## 밀스톤 E — 감사 로그 & status 확장

### 목표

모든 Claude 호출에 라우팅 정보 기록. `!finclaw status` 에서 모델 분포 확인 가능.

### 전제

- `packages/agent/src/auth/health.ts:47-135` `ProfileHealthMonitor` — `ProfileState` 가 **profileId 단위 기록만**. 모델별 카운트/비용 집계 구조 없음. `byModel` 필드 신설 필요.
- `packages/server/src/auto-reply/commands/status.ts` 가 `!finclaw status` 처리. 현재는 단일 `defaultModel` 만 출력 — fallback chain 분포 미포함.
- `recordResult(profileId, success)` 시그니처 변경 시 호출 site 전체 영향 사전 검증 필요.

### 작업

**파일**:

- `packages/agent/src/execution/runner.ts` (수정, ~40 LOC — 구조화 로그 + routing 정보 포함)
- `packages/agent/src/auth/health.ts` (수정, ~80 LOC — `ProfileState.byModel: Map<modelId, {calls, cost, fallbacks, errors}>` 신설, `recordResult` 시그니처에 `modelId`/`tokens` 추가)
- `packages/agent/src/auth/health.test.ts` (수정 또는 신설, ~30 LOC — per-model 집계 검증)
- `packages/server/src/auto-reply/commands/status.ts` (수정, ~50 LOC — 모델 분포 출력)
- `packages/skills-finance/src/news/analysis/market-analysis.ts`, `sentiment.ts` (수정, ~10 LOC 각 — recordResult 호출 추가)

**로그 스키마**:

```json
{
  "event": "agent.execution",
  "role": "analysis",
  "automation": false,
  "chosenModel": "claude-opus-4-7",
  "selectionPath": "routing",
  "reason": "A=opus, C.max=opus, hint=none",
  "availableTools": ["analyze_market", "get_stock_price"],
  "userHint": null,
  "tokens": { "input": 1240, "output": 823, "cacheHit": 0.4 },
  "durationMs": 4201,
  "cost": { "usd": 0.0234 }
}
```

**`!finclaw status` 출력 추가**:

```
최근 1시간 모델 분포:
  Opus    ▓▓▓▓▓░░░░░  12회 ($0.52)
  Sonnet  ▓▓▓▓▓▓▓▓░░  34회 ($0.18)
  Haiku   ▓▓▓▓▓▓▓▓▓▓  120회 ($0.04)
  Fallback 발동: 2회 (opus → sonnet)
```

### 검증

- 10회 임의 호출 → 로그에 각 호출 routing 정보 기록
- `!finclaw status` → 모델별 카운트/비용 출력
- ProfileHealthMonitor.getStatus() 에 per-model breakdown 포함

---

## 밀스톤 F — 사용자 override (Stretch)

### 목표

사용자가 "이 답은 Opus 로 해줘" 식으로 모델 강제 가능.

### 전제

- 밀스톤 A 의 `override.allowClientHint` 설정 기반.
- `respectMinModel=true` 유지 (C 하한 뚫지 않음).

### 작업

**파일**:

- `packages/types/src/gateway.ts` (밀스톤 C 에서 이미 `modelHint`/`role` 추가됨 — 본 밀스톤은 UI 만)
- `packages/server/src/gateway/rpc/methods/chat.ts` (밀스톤 C 에서 처리 완료 — 본 밀스톤 영향 없음)
- `packages/server/src/gateway/rpc/methods/agent.ts` (동일)
- `packages/web/src/app-chat.ts` (수정, ~30 LOC — "Opus로 다시" 버튼, 메시지별 modelHint 송신)
- `packages/web/src/views/` 산하 (필요 시 신규 컴포넌트 — 모델 선택 드롭다운)

**동작**:

- `chat.send({message, modelHint: 'opus'})` → routing 시 A 를 opus 로 대체
- C 가 더 높으면 C 승리 (변화 없음)
- `allowClientHint=false` config 시 hint 무시 + 경고 로그

### 검증

- hint=opus → 로그에 `userHint: 'opus'`, 실제 호출 모델 opus
- hint=haiku + analyze_market → opus (C 승리)
- allowClientHint=false → hint 무시

---

## 완료 조건 (Phase 24 Done When)

- 밀스톤 A/B/C/D/E 전부 완료. F 는 Stretch.
- 기동 시 routing table 로그 출력.
- `pnpm test` — routing.test.ts 전 케이스 통과 (B1/B2/B3/B5 검증 포함).
- **스킬 내부 LLM 호출 모델 ID 통일** — `claude-sonnet-4-20250514` 코드베이스에서 grep 결과 0건.
- **TUI 라우팅 검증** — `executeForTui` 경로에서도 C 하한선 적용.
- 실제 대화 시나리오 8개 수동 검증:
  1. "AAPL 얼마야?" → Haiku 선택
  2. "이 뉴스가 내 포트에 미치는 영향 분석해줘" → Opus 선택 (외부 + 내부 분석 둘 다)
  3. "안녕" → Sonnet 선택
  4. 크론 자동화 스크립트 → Haiku 기본, Opus 필요 시 승격
  5. "오늘 뉴스 요약해" → Haiku 선택
  6. hint='haiku' 로 복잡 분석 요청 → 실제는 Opus (C 승리)
  7. **TUI 에서 model='haiku' 명시 + analyze_market 호출 → Opus 승격** (B1)
  8. **chat.start.model='sonnet' + chat.send.modelHint='opus' → Opus 선택** (B2)
- `!finclaw status` 에 모델 분포·비용·fallback 발동 횟수 표시.
- `tsgo --noEmit`, `pnpm lint` 통과.

---

## 범위 외 (Phase 26 이후)

- **동적 classifier**: 입력 길이·복잡도 기반 자동 role 추론 (현재는 호출 site 에서 명시 태깅)
- **모델별 가격 테이블 실시간 갱신**: 현재는 catalog-data.ts 하드코딩
- **사용자 커스텀 프로파일**: "conservative" / "aggressive" 등 여러 프리셋 스위칭
- **Per-user 라우팅**: 멀티 유저 시 사용자별 선호 모델 (현재 혼자 씀)
- **A/B 비교**: 같은 질문을 두 모델에 동시 질의 후 비교 UI
- **비용 budget 제한**: 월 상한 설정 시 자동 다운그레이드

---

## 오픈 질문 (Phase 24 진행 중 확정)

1. **role 추론 휴리스틱** — auto-reply(Discord) 에서 메시지 내용으로 role 자동 판정 규칙. 키워드 기반 간단히? 아니면 항상 'chat' 고정? 기본 "키워드 매칭 최소 세트: 분석/리포트/판단 → analysis, 나머지 chat" 제안.
2. **summarize 역할 진입점** — 명시적으로 summarize 역할을 태깅할 호출 site 가 현재 없음. (a) 내부 파이프라인의 히스토리 요약 전용 vs (b) 사용자가 "요약해" 하면 태깅. 기본 "(a) 내부 전용, 사용자 요약 요청은 analysis" 제안.
3. **비용 추적 정확도** — token 사용량 × 단가 테이블. 단가는 어디서? `catalog-data.ts` 에 하드코딩 vs 외부 파일. 기본 "catalog-data.ts 하드코딩 유지, 분기별 수동 갱신" — 카탈로그에 이미 inputPerMillion/outputPerMillion 박혀 있음.
4. **`recordResult` 시그니처 변경 영향** — 호출 site 가 N 곳일 때 모두 갱신 필요. 사전에 grep 으로 영향 범위 측정 필요. (밀스톤 E 시작 시 첫 작업.)
5. **스킬 내부 LLM 호출 라우팅 의존성** — `analyzeMarket(client, news, options)` 시그니처에 `modelRef` 추가 시 호출자(`packages/skills-finance/src/news/index.ts`) 가 라우터를 어떻게 받는가? skill 등록 시점에 라우터 주입 vs 호출 시점에 modelRef 사전 결정 후 주입. 기본 "도구 등록 시 라우터 의존성 주입, 도구 실행 시점에 role='analysis' 로 라우터 호출하여 modelRef 결정".

---

## 변경 이력

- **2026-04-26**: Phase 24 plan 재검토 후 구체화.
  - Context 의 `main.ts:72` → `74-79` 정정
  - 사각지대 항목(스킬 내부 LLM 호출) 추가
  - B1-B5 결정사항 5건 사용자 결정 사항에 흡수
  - 밀스톤 A: `schema.ts` → `zod-schema.ts`, `examples/finclaw.yaml` → `config.example.json5` 정정
  - 밀스톤 B: SkillMetadata "확장" → "신설" 워딩 정정, LOC ~85 → ~150
  - 밀스톤 C: 호출 지점 표 확장 (TUI/스킬 내부 LLM/chat.start vs send 추가), LOC ~280 → ~340
  - 밀스톤 E: `ProfileState.byModel` 신설 명시, LOC ~120 → ~200
  - 밀스톤 F: `web/views/chat-view.ts` → `web/src/app-chat.ts` 정정
  - 완료 조건에 시나리오 7-8 추가 (B1/B2 검증)
- **2026-04-26 (2차)**: B6 결정 흡수 — fallback strict 정책.
  - `runWithModelFallback` 에 `floor` 파라미터 + `ModelFloorExhaustedError` 도입
  - 밀스톤 D: chain 절단 로직, 에러 처리 명세 추가, LOC ~80 → ~180
  - Opus 다운 + minModel=opus 도구 → Sonnet/Haiku 로 내려가지 않고 명시적 에러 (사용자 응답 한국어)
  - 환각 금지 원칙(Haiku 로 금융 판단 절대 금지) 보존이 가용성보다 우선
