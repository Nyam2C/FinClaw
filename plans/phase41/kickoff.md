# Phase 41 킥오프 — SDK 런타임 제거 + analyze_market CLI 재배선 + KIS→Toss 추상화

> 작성 2026-05-26 · base = main `dea0a0d` (phase40 #75 머지 직후).
> **사전 조사 완료. plan.md 미작성 — 다음 세션이 이 kickoff + `_workspace/phase41-scope.md` 읽고 plan.md 설계.**

## 목표

phase40 으로 "키 없이 구독+MCP 구동"은 달성. phase41 은 **휴면 상태로 남긴 Anthropic SDK 잔재를 정리**하고, 마지막 SDK 직접 호출(`analyze_market`)을 구독(CLI)로 재배선한다. 더불어 브로커리지를 KIS 종속에서 **벤더 중립 인터페이스**로 빼 토스증권 교체 길을 연다(토스 실 구현은 API 발급 후).

## 사전 조사 결론 (`_workspace/phase41-scope.md` 상세)

### A. SDK 실호출은 5곳뿐

- `agent/src/providers/anthropic.ts` (AnthropicAdapter + summarizer) — phase40 D 에서 **키 없으면 미생성**. 제거 시 dual-path 안전판 + compaction 요약기 상실.
- `skills-finance/src/news/analysis/market-analysis.ts:86` `client.messages.create` — **analyze_market 의 유일 LLM 지점 → 재배선 대상.**
- `skills-finance/src/news/analysis/sentiment.ts:14` `analyzeSentiment` — **src 호출처 0건 = 죽은 코드** (CLAUDE.md §3: 삭제는 본 kickoff 로 승인).
- SDK dep: `agent/package.json` + `skills-finance/package.json`. skills-finance 분(analyze_market+sentiment) 정리하면 그 패키지 dep 완전 제거 가능.

### B. analyze_market → runCliAgent

- 출력이 **이미 JSON 프롬프트 + Zod(`AnalysisResponseSchema`)** → CLI 텍스트 응답 그대로 파싱 가능. systemPrompt/userPrompt → `runCliAgent({systemPrompt, prompt, modelId:'opus'})`.
- ★ **중첩 spawn 데드락 실재**: outer ReAct(`runCliAgent`, queue key `claude`) → MCP `tools/call` → analyze_market → inner `runCliAgent`(같은 key) → 영구 대기. **회피 필수: inner 전용 queue key + stateless 1-shot(세션 비공유).**

### C. KIS → Toss 추상화

- read-only 확정(잔고 조회만, 주문 X). KIS 종속은 `kis/{auth,client,holdings}.ts` + `composition/skills.ts` 배선 **4곳뿐**. 도구·gateway RPC·`BrokerageSyncService`·`NormalizedHolding` 은 **이미 벤더 중립**.
- 경계선 = `KisClient` 타입. **`BrokerageClient` 인터페이스 1개 추출** + SyncService 타입 완화 + `skills.ts` 에 provider 분기(`BROKERAGE_PROVIDER` env) 마련까지. **Toss 실 구현은 API 발급+스펙 확보 후 별 phase** (지금 지어내면 환각).

## plan.md 가 결정할 것 (감독 포인트)

1. **SDK 제거 범위** — analyze_market 재배선 후:
   - (a) skills-finance 의 SDK 의존만 제거 (안전, 점진) vs
   - (b) AnthropicAdapter + summarizer + `@anthropic-ai/sdk` **전면 제거** (dual-path 안전판·compaction 상실 — 키 다시 넣어도 SDK 모드 불가).
   - → 사용자 결정 필요. phase40 은 "휴면 유지"였으므로 (b)는 비가역. 권고: analyze_market+sentiment 부터(저위험), AnthropicAdapter 전면 제거는 별도 판단.
2. **analyze_market 데드락 회피 설계** — inner queue key 분리 방식 확정.
3. **sentiment.ts 죽은 코드 삭제** — 승인됨(본 kickoff). 단 import/test 고아 확인.
4. **KIS→Toss 추상화 깊이** — `BrokerageClient` 인터페이스까지만 (과설계 금지). 토스 var 명은 스펙 나와야 확정.
5. **news-brief CLI 모드** — 현재 brokerage_sync(read-only deny) 의존이라 CLI 모드 seed skip. 유지 vs 재설계 별도 결정.

## 스탠딩 리스크

- AnthropicAdapter 전면 제거 = 비가역(되돌리기 어려움). 점진적 접근 권장.
- 토스 Open API 미발급/미공개 → 실 구현 불가, 추상화 경계까지만.
- analyze_market 중첩 spawn = 비용(구독, 사용자 OK)·지연·데드락 — 설계로 회피.

## 컨벤션

- 테스트 baseline: unit **1700** / storage 154 (phase40 머지 후). mock-only 유지(실 키/네트워크/라이브 CLI 금지 — 수동 분리).
- 각 밀스톤: typecheck+build+test+lint green, 밀스톤당 1커밋.
- 외과적 변경(CLAUDE.md §3). plan/todo 가 요구 안 한 인접 코드 비건드림.
- 참고: `_workspace/phase41-scope.md` (전수 조사), `plans/phase40/review.md` (phase40 §7 다음 phase 후보).
