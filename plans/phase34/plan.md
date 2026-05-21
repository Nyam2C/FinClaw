# Phase 34 — LLM 오케스트레이터 라우팅 (키워드 휴리스틱 폐기)

> 현재 `execution-adapter.ts` 의 키워드 기반 role 추론을 LLM 라우터로 대체.
> "안녕" 같은 잡담에 시세 도구 13개가 노출되는 문제를 의도(intent) 단위로 차단.

## 동기

- 현재 `inferRole()` 은 한국어 키워드 매칭(`분석`, `가격`, `시세` …) — 패러프레이즈·영어·신조어에 취약
- chat 으로 falls through 한 발화에 sonnet-min 도구 13개가 그대로 노출 → LLM 이 over-eager 하게 호출
- 사용자 결정: **속도는 양보, 비용 절감 우선**. 라우터가 "도구 불필요" 로 판단하면 본 호출에서 도구 정의 자체를 빼서 인풋 토큰 ↓

## 핵심 아이디어

1. 메인 LLM 호출 직전에 **소형 라우터 LLM 1회 호출** (Haiku 고정)
2. 라우터 출력: `{ intent, modelTier, allowedToolGroups }`
3. 메인 호출은 **라우터 결정 그대로** 따름 — 키워드 추론·`respectMinModel` 필터 폐기
4. 실행 LLM 은 여전히 단일 (멀티-에이전트 위계 X). "에이전트 호출" 은 도구 그룹 선택과 동치.

## 라우터 출력 스키마 (초안)

```ts
{
  intent: 'greeting' | 'fetch' | 'analysis' | 'portfolio' | 'memory' | 'other',
  modelTier: 'haiku' | 'sonnet' | 'opus',
  allowedToolGroups: ('quote' | 'news' | 'alert' | 'portfolio' | 'utility')[],
  // 빈 배열이면 도구 정의 미전달 — chit-chat 비용 최소화
  reason: string  // 디버깅 로그용
}
```

## 밀스톤

- **A. 라우터 prompt + 호출 헬퍼** — `packages/agent/src/router/llm-router.ts` 신규. Haiku + JSON mode + 캐시. 1-2일.
- **B. execution-adapter 통합** — `inferRole`/`applyRouting` 폐기, 라우터 결과 주입. 도구 정의 필터를 group 단위로. 1일.
- **C. 라우팅 결정 로깅** — `pipeline.routed` 이벤트 확장 (intent/tier/groups/reason). 0.5일.
- **D. 비용·정확도 검증** — 같은 발화 100건을 키워드 vs LLM 라우터로 비교. 토큰·tool_call 수 기록. 1일.

## 의도적 비대상

- 멀티 에이전트 (각자 다른 LLM) — 본 phase 는 라우터만, 실행은 단일 LLM 유지
- 라우터 결과 캐싱 — 같은 발화 재호출 거의 없음, 복잡도만 증가
- 라우터 자체의 fallback chain — Haiku 단일 고정, 실패 시 키워드 라우팅으로 폴백

## 완료 조건

- [ ] "안녕" 발화에 도구 정의 미전달 (DB log 검증)
- [ ] "삼성전자 어때?" 발화에 quote+news+analysis 그룹 노출 (현재 키워드는 chat fall-through)
- [ ] 라우터 추가 비용 ≤ 메시지당 $0.0005 (Haiku 평균 인풋 200tok 기준)
- [ ] 100건 샘플에서 over-call(불필요 도구) 70% 이상 감소

## 추정

개발 3-4일. 검증 1일.

---

## 전제

- Phase 33 (KIS 동기화 + 뉴스 메모리화) 완료 후 진입 — 라우팅 결정에 portfolio_holdings 동기화 상태가 컨텍스트로 들어갈 수 있음.
- Phase 33 의 "FINAL 약속" 은 본 phase 추가로 해제됨. 사용자 결정에 따라 phase34 가 새 finish line.

---

## 인스펙션 보강 (post-phase33 사실 검증, 2026-05-21)

> 본 plan 은 phase33 이전에 작성됨. phase31(resilience)+32(dual-path)+33(KIS+news) 반영 후 코드 실측으로 교정. **본 보강은 아래 본문(밀스톤 A~D, 라우터 스키마)의 어긋난 서술을 OVERRIDE 한다.** 밀스톤 A~D 범위는 불변, 통합지점·CLI 상호작용만 재grounding. (검증 13항목: 일치 4 · 어긋남 9. 사용자 결정 2건 확정.)

### ★ B-0. 라우터 provider = SDK Haiku 고정 (dual-path 안 따름, 확정)

- `ANTHROPIC_API_KEY` 는 provider 모드 무관 무조건 required (`main.ts:181`). `sdkAdapter = new AnthropicAdapter(anthropicKey)` 는 CLI 모드에서도 항상 생성됨 (`main.ts:275`).
- **선례**: phase32 F summarizer 가 "항상 SDK adapter" (`main.ts:625-626`). 라우터도 동일 — `createProviderAdapter` 의 dual-path(CLI) 가 아니라 `sdkAdapter.chatCompletion()` 으로 Haiku(`claude-haiku-4-5-20251001`, `routing.ts:127-129`) 직호출.
- **이유**: CLI 모드는 JSON 강제 출력 파싱 불안정 + `#cliSessionId` 세션 오염 위험. 라우터는 도구 미사용이라 SDK 고정이 결정론적. Haiku tier 라 SDK 과금이어도 ≤$0.0005 목표 부합.
- **결론**: CLI 모드여도 **라우터만은 SDK Haiku**.

### ★ B-1. tool group 5개 미존재 → `allowedToolNames` 화이트리스트 (확정)

- plan 의 `quote|news|alert|portfolio|utility` 5개 group 은 코드에 **전무**. 실제 `ToolGroupId` = `finance|system|web|data|communication|mcp|custom`(`groups.ts:6-13`)이고 **모든 금융 도구가 `group:'finance'` 단일**(market/news/alerts/brokerage tools.ts 12곳).
- **확정(사용자)**: 라우터 출력을 `allowedToolGroups` 가 아니라 **`allowedToolNames: string[]`(도구명 화이트리스트)** 로 재정의. 기존 `applyRouting` 이 이미 `allowedToolNames` 로 `exposedTools` 필터(`execution-adapter.ts:225-227,481,495`) → 자연 정합. groups.ts 세분화는 범위 확장 → 비대상.
- 라우터는 `intent → {modelTier, allowedToolNames}` 매핑. 빈 배열이면 도구 정의 미전달(`buildParams.tools=undefined`, `execution-adapter.ts:253` / TUI `:387`).

### ★ B-2. inferRole 폐기 vs 키워드 폴백 → 폴백용 잔존 (확정)

- plan L34 "키워드 폐기" ↔ L42 "실패 시 키워드 폴백" 충돌.
- **확정(사용자)**: `inferRole`(`execution-adapter.ts:67-76`)을 **라우터 실패/타임아웃 시 fallback 으로만 잔존**, 정상 경로에선 비활성. plan §비대상의 "키워드 폴백" 의도와 일치.

### B-3. 폐기 대상 정확화 (makeRouterHelper / applyTuiRouting / respectMinModel)

- 키워드 경로 = `makeRouterHelper`(`router-helper.ts:13`) → `resolveModelForRequest`(`models/routing.ts:64`, `respectMinModel` 필터 L72-75). main.ts:218-228 주입. LLM 라우터가 이 경로를 **대체**(공존 X, 단 B-2 폴백 잔존).
- **`applyRouting`(`execution-adapter.ts:464`) + `applyTuiRouting`(`:502`) 2개 모두** 대체 대상 (plan 은 1개만 언급).
- `respectMinModel` 은 execution-adapter 가 아니라 `models/routing.ts:72-75`. 폐기 대상은 "키워드 role + minModel 자동승격" 로직. **`exposedTools` 필터(`:225`) 자체는 라우터의 allowedToolNames 를 받는 통합점으로 재사용**.

### C-0. `pipeline.routed` 는 이벤트 아니라 로그 라인 (밀스톤 C 정정)

- `FinClawEventMap`(`infra/src/events.ts`)에 `pipeline:routed` **없음**. 현재 `logger.info('pipeline.routed', {...})` 로그 라인(`execution-adapter.ts:486-493`) + TUI `tui.routed`(`:530-538`).
- 밀스톤 C "이벤트 확장" → **기존 로그 라인에 intent/tier/allowedToolNames/reason 필드 추가**(최소 변경, 권장). events.ts 신규 이벤트는 불요.

### D-0. JSON mode 부재 + 비용 검증 인프라 (밀스톤 A/D 정정)

- Anthropic 전용 JSON mode 없음. `chatCompletion(): Promise<unknown>`(`adapter.ts:26`)은 tools 미전달(`anthropic.ts:73` TODO). 라우터 JSON 출력 = **프롬프트 강제 + JSON.parse + zod 스키마 검증 + 1회 재시도**.
- 밀스톤 D: agent_runs `tokens_input/output`(`agent-runs.ts:13-14`) + `tool_calls_json`(L83) + profileHealth byModel + `calculateEstimatedCost`(`execution-adapter.ts:305-315`) 재사용. **단 라우터 자체 Haiku 토큰은 메인 호출과 별도 누적/로깅** 해야 "≤$0.0005" 완료조건 검증 가능.

### 어휘 매핑 (intent ↔ ModelRole)

- 라우터 intent `greeting|fetch|analysis|portfolio|memory|other` ↔ 기존 `ModelRole = fetch|chat|analysis|summarize`(`routing.ts:7`). 라우터 intent → `{modelTier, allowedToolNames}` 매핑 테이블이 신규 산출물. ModelRole 은 내부 routing config 에만 잔존.
