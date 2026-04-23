# Phase 24 — 모델 역할 라우팅 (Model Role Routing)

## Context

Phase 23 에서 `finance.*` / `agent.run` RPC 가 배선되면 Claude 호출 경로가 채팅 1개에서 **채팅 + 직접 RPC + 자동화 스크립트 + Web UI** 로 넓어진다. 그러나 현재 전체 요청이 `claude-sonnet-4-5` 고정(`packages/server/src/main.ts:72` `DEFAULT_MODEL`)이라 다음 문제가 발생한다.

1. **비용 낭비** — 단순 시세 조회도 Sonnet, 복잡한 포트폴리오 분석도 Sonnet. 호출량 증가 시 토큰 비용 폭발.
2. **지연 낭비** — "AAPL 얼마야?" 같은 결정론적 조회에 Sonnet 2-5초 지연. Haiku면 수백 ms.
3. **안전 구멍** — `analyze_market` 같이 금융 판단이 필요한 도구도 Sonnet/Haiku 로 처리 가능한 상태. 환각 위험.
4. **인프라 유휴** — `BUILT_IN_MODELS` 에 Opus/Sonnet/Haiku 3종, `DEFAULT_FALLBACK_CHAIN`, `runWithModelFallback` 인프라는 이미 존재. 단지 **선택 로직이 없음**.

본 Phase의 목표는 **요청의 역할(A)과 사용될 도구의 최소 요구사항(C)을 결합해 모델을 자동 선택**하는 라우터를 도입하는 것. 신규 모델 추가는 없고, 기존 카탈로그·fallback 인프라 위에 선택 레이어 1개를 얹는다.

**사용자 결정 사항** (2026-04-24 Q&A):

- 역할 분류: **`fetch / chat / analysis / summarize`** 4개 + `automation` **직교 플래그**. `report` 는 `analysis` 로 흡수.
- 결합 규칙: **`max(A.preferred, ...C.minModels)`** — 강한 쪽(상위 모델)이 이김. C 는 하한선, A 는 기본값.
- 사용자 override: `modelHint` 로 A 만 대체 가능, **C 하한선은 뚫지 않음** (보수). 예: 사용자가 `modelHint: 'haiku'` 줘도 `analyze_market` 쓰이면 Opus 승격.
- 도구 스캔 시점: **"보수적 선스캔"** — 세션에 등록된 모든 도구의 min 중 최대를 초기에 선택. (방안 (b) 턴별 동적 승격은 복잡도 대비 이득 미미로 제외.)
- Haiku 로 금융 판단 절대 금지 — `analyze_market`, `get_portfolio_summary` 는 minModel=Opus 로 강제.

---

## 밀스톤 A — 역할 프로파일 인프라

### 목표

`config.yaml` 에 역할별 선호 모델 선언. 런타임에 읽어 라우터에 주입.

### 전제

- `packages/config/src/schema.ts` 는 Zod 기반. 확장 용이.
- `packages/types/src/config.ts` 에 `FinClawConfig` 타입 존재.
- 현재 모델 지정은 `main.ts:72` `DEFAULT_MODEL` 상수뿐.

### 작업

**파일**:

- `packages/types/src/config.ts` (수정, ~25 LOC — `RoutingConfig` 타입 추가)
- `packages/config/src/schema.ts` (수정, ~40 LOC — Zod 스키마)
- `packages/config/src/defaults.ts` (수정, ~20 LOC — 기본값)
- `examples/finclaw.yaml` (수정, routing 섹션 주석 예시 추가)

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

- `SkillMetadata` 는 현재 단순 객체 (`packages/skills-finance/src/market/index.ts:232` 등). `name/description/version/requires/tools` 필드만.
- `tools` 는 문자열 배열 — 도구별 개별 메타데이터 없음. **확장 필요**.

### 작업

**파일**:

- `packages/types/src/skill.ts` (수정, ~30 LOC — `ToolMetadata` 타입 도입)
- `packages/skills-finance/src/market/index.ts` (수정, ~20 LOC)
- `packages/skills-finance/src/news/index.ts` (수정, ~20 LOC)
- `packages/skills-finance/src/alerts/index.ts` (수정, ~20 LOC)
- `packages/skills-general/src/index.ts` (수정, ~15 LOC)

**타입 변경**:

```
SkillMetadata.tools: string[]
  ↓
SkillMetadata.tools: Array<{
  name: string;
  minModel?: 'haiku' | 'sonnet' | 'opus';
  reason?: string;  // 감사용 사유 (예: "금융 판단 — 환각 위험")
}>
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

- `packages/agent/src/models/selection.ts` 에 `resolveModel` 존재 — unresolved → resolved 만 처리 (라우팅 없음)
- Runner 는 `runnerFactory(dispatcher)` 로 세션별 생성.

### 작업

**파일**:

- `packages/agent/src/models/routing.ts` (신설, ~150 LOC)
- `packages/agent/src/models/routing.test.ts` (신설, ~200 LOC)
- `packages/server/src/main.ts` (수정, ~30 LOC — 라우터 인스턴스 주입)
- `packages/server/src/gateway/rpc/methods/chat.ts` (수정, ~20 LOC — role 태깅)
- `packages/server/src/gateway/rpc/methods/agent.ts` (수정, ~20 LOC — role 태깅)
- `packages/server/src/gateway/rpc/methods/finance.ts` (수정, ~10 LOC — `analyze_market` 호출 경로에만 role)
- `packages/server/src/auto-reply/execution-adapter.ts` (수정, ~20 LOC — role 태깅)

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

- `chat.send` → role='chat'
- `agent.run` → role 파라미터 or 'analysis' 기본
- `auto-reply` (Discord/Channel) → role='chat' 기본, 메시지에 "분석"/"리포트" 키워드면 'analysis' 승격 (단순 휴리스틱, Phase 26+ 에서 classifier 로)
- `finance.*` RPC — Claude 직접 호출 없으므로 라우팅 대상 아님 (스킬이 자체 처리)

### 검증

- 단위 테스트 30+ 케이스:
  - role=fetch + 도구 없음 → haiku
  - role=fetch + analyze_market 포함 → opus (C 승격)
  - role=chat + 일반 도구만 → sonnet
  - role=chat + hint=opus → opus
  - role=analysis + hint=haiku → opus (hint 무시, A 승리)
  - automation=true → strictFallback 적용 확인
- Integration: chat.send 호출 → 로그에 `{role: 'chat', chosenModel: 'claude-sonnet-4-6', reason: '...'}` 출력

---

## 밀스톤 D — Fallback 분리 (Selection vs Recovery)

### 목표

"초기 모델 선택" 과 "장애 시 downgrade" 를 코드 경로에서 구분. 로그 명확.

### 전제

- 현재 `runWithModelFallback` 은 초기 모델 받아 실행 + 에러 시 `DEFAULT_FALLBACK_CHAIN` 순회. 두 책임이 섞임.
- 로그에 "왜 이 모델을 골랐나" 가 안 드러남.

### 작업

**파일**:

- `packages/agent/src/models/fallback.ts` (수정, ~60 LOC)
- `packages/agent/src/models/selection.ts` (수정, ~20 LOC)

**변경 내용**:

- 초기 선택 = 밀스톤 C 의 `resolveModelForRequest` 결과
- Fallback = 실행 중 에러 발생 시만 발동
- 로그에 `selectionPath: 'routing' | 'fallback'` 필드 추가
- `automation.strictFallback=true` 면 fallback chain 을 한 단계 좁게 (예: Opus → Sonnet 만 허용, Haiku 까지 안 내려감 — 무인 실행에서 판단 품질 보호)

### 검증

- 라우팅으로 Opus 선택 → Anthropic API 정상 응답 → 로그 `selectionPath: 'routing'`
- Opus 과부하 → Sonnet 으로 전환 → 로그 `selectionPath: 'fallback', from: 'opus', to: 'sonnet'`
- `automation=true` 에서 Opus → Sonnet 까지만, Haiku 로 내려가지 않음

---

## 밀스톤 E — 감사 로그 & status 확장

### 목표

모든 Claude 호출에 라우팅 정보 기록. `!finclaw status` 에서 모델 분포 확인 가능.

### 전제

- `ProfileHealthMonitor` 에 호출 카운트 이미 존재.
- `!finclaw status` 는 Phase 22 todo 8 에서 채널/모델/API health 출력 기능 추가됨 (`packages/server/src/auto-reply` 내).

### 작업

**파일**:

- `packages/agent/src/execution/Runner.ts` 또는 실행 진입점 (수정, ~30 LOC — 구조화 로그)
- `packages/agent/src/auth/health.ts` (수정, ~40 LOC — per-model 집계 필드)
- `packages/server/src/auto-reply/status-command.ts` 또는 상응 파일 (수정, ~50 LOC)

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

- `packages/types/src/gateway.ts` (수정, ~10 LOC — `modelHint` 파라미터)
- `packages/server/src/gateway/rpc/methods/chat.ts` (수정, ~15 LOC)
- `packages/server/src/gateway/rpc/methods/agent.ts` (수정, ~15 LOC)
- `packages/web/src/views/chat-view.ts` (수정, ~30 LOC — "Opus로 다시" 버튼)

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
- `pnpm test` — routing.test.ts 전 케이스 통과.
- 실제 대화 시나리오 6개 수동 검증:
  1. "AAPL 얼마야?" → Haiku 선택
  2. "이 뉴스가 내 포트에 미치는 영향 분석해줘" → Opus 선택
  3. "안녕" → Sonnet 선택
  4. 크론 자동화 스크립트 → Haiku 기본, Opus 필요 시 승격
  5. "오늘 뉴스 요약해" → Haiku 선택
  6. hint='haiku' 로 복잡 분석 요청 → 실제는 Opus (C 승리)
- `!finclaw status` 에 모델 분포·비용 표시.
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
3. **비용 추적 정확도** — token 사용량 × 단가 테이블. 단가는 어디서? `catalog-data.ts` 에 하드코딩 vs 외부 파일. 기본 "catalog-data.ts 하드코딩, 분기별 수동 갱신" 제안.
