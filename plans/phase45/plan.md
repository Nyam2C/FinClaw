# Phase 45 계획 — audit-driven dead-code sweep (114 actionable)

> 작성 2026-05-31 · base = main `16939cf` (phase44 머지) · 선행: `plans/phase45/kickoff.md`, `_workspace/decl-audit/unused-report.md`(114 항목 + 카테고리×패키지×근거)
> 상태: **초안 — 사용자 승인 대기.** 승인 후 todo.md 분해 → 밀스톤 구현 → review.md.

## 0. 확정 결정 (열린 질문 → 잠정)

> kickoff §4 의 열린 질문에 대한 plan 안. 사용자 검토 시 조정.

- **T3(41) 디폴트** = **prod 미소비 = 동반 제거**. "테스트가 의도 보장용"인 케이스만 case-by-case 로 KEEP (인터페이스 확장점·계약 명세 등 명백한 사유 있을 때만, review 에 사유 기록).
- **인터페이스 트림** = **포함**. `CommandRegistry.execute` 등 인터페이스에까지 노출된 dead 는 인터페이스 계약 축소 동반.
- **분량 처리** = **45 안에서 시도, 초과 시 M-C 만 phase46 이월**. M-A → M-B 는 phase45 안 완료 필수.
- **재검증 강도** = **phase44 동일 + 매 마일스톤 build 게이트 강제** (phase42 교훈: tsgo + vitest 만으론 broken build 누락). 별도 추가 게이트 없음.

## 1. 안전 원칙 (감사 false-positive 의 가드)

> 감사 신뢰도는 높으나 (12 에이전트 + 동적 dispatch 감사 + 추출기 버그 1건 수정), 100% 아님. 따라서:

1. **삭제 전 재검증:** 각 심볼 삭제 직전 `rg "\bSYMBOL\b" packages/*/src` 로 비-self · 비-test 소비처 0 재확인. 소비처 발견 시 **삭제 보류 + review 에 기록**(감사 오판). 추가로 동적 dispatch 패턴 (`Registry.get(name)`, 문자열 키, 동적 import) 도 grep 으로 확인.
2. **레이어 바텀업 제거:** types → infra → storage → agent → skills → gateway → server → clients. 하위 레이어 제거 후 게이트 통과해야 상위로(소비처 cascade 가 즉시 드러남).
3. **밀스톤마다 전체 게이트:** `pnpm format && pnpm lint && pnpm typecheck && pnpm exec tsc --build && pnpm test --run` 전부 (phase42 교훈).
4. **삭제 동반 정리:** 심볼 삭제 시 배럴 re-export·전용 테스트·import 동반 제거(고아 금지). 단 §3 — 무관 인접 코드 불변.
5. **보존 불변 (재검증으로 확인):** 메모리 RAG · cron · read-only · 매수=사람 · thin orchestrator(phase43) 이 쓰는 심볼은 "dead 아님". 감사가 KEEP 처리했지만 삭제 인접 영역에 닿으면 한 번 더 확인.
6. **인터페이스 트림 분리 작업:** 인터페이스 메서드 제거는 별도 step 으로 분리 (구현체 cascade 추적 필요).

## 2. 마일스톤

### M-A — T1 무참조 39개 (바텀업, 패키지별 서브밀스톤)

가장 안전. 참조 0 또는 reexport-only. 인접 cascade 없음(인터페이스 트림 케이스만 제외).

서브밀스톤 = 레이어 바텀업, 각 종료 시 전체 게이트:

- **A-1 types (4)** — `TimeInterval`(finance.ts:53) · `WsEvent`/`GatewayStatus`(gateway.ts:87,131) · `BroadcastChannel`(notification.ts:43) + `types/index.ts` 배럴 정리. 모두 reexport-only, type-only 라 cascade 없음.
- **A-2 infra (4)** — `EventMap`(events.ts:16) · `createFlushFn`(logger-transports.ts:92) · `defaultLoggerFactory`(logger.ts:112) · `ConcurrencyLaneManager.resetGeneration`(concurrency-lane.ts:175). 메서드 트림 시 내부 사용 0 재확인.
- **A-3 storage (3)** — `updateConversation`(conversations.ts:146) · `deleteCachedEmbeddings`(embeddings.ts:51) · `listConversations`(conversations.ts:249) reexport + `storage/index.ts` 배럴.
- **A-4 config (2)** — `now`(sessions/store.ts:119) reexport · `ValidatedFinClawConfig`(zod-schema.ts:182) reexport + 배럴.
- **A-5 agent (2)** — `ToolGroup` · `ToolInputSchema`(agents/tools 배럴) reexport-only. agent 배럴 트림.
- **A-6 skills-finance (9)** — `*_SKILL_METADATA` 3종 (alerts/market/news index.ts) · `ProviderRegistry.{resolveWithFallback,list}`(provider-registry.ts:31,36) · `PortfolioStore.{upsertPortfolio,deletePortfolio,upsertHolding,removeHolding}`(portfolio/store.ts:47,61,67,88). 메타 3종 export 제거 + skills-finance/index.ts 트림. PortfolioStore 쓰기 4종은 메서드 트림 (포트폴리오 read-only 와 정합 — 보존 불변 일치).
- **A-7 skills-general (1)** — `GENERAL_SKILL_METADATA`(index.ts:47). skills-finance 패턴과 일관.
- **A-8 gateway (2)** — `WsOutboundMessage`(rpc/types.ts:94) · `resetVersionCache`(version.ts:29) + gateway 배럴.
- **A-9 server (12, 인터페이스 트림 포함)** — `PipelineError`(auto-reply/errors.ts:12) · `CommandStageResult`(stages/command.ts:6) · `PluginExports`/`resetJiti`(plugins/loader.ts:26,72) · `ProcessLifecycle.shutdown`(process/lifecycle.ts:44) · `PluginLoadError`/`bridgeHooksToEventBus`(plugins 배럴) · process/errors.ts 4 클래스(`SpawnError`/`SpawnTimeoutError`/`LaneClearedError`/`QueueFullError`) reexport + `InMemoryCommandRegistry.execute`(commands/registry.ts:111) **+ `CommandRegistry.execute` 인터페이스 트림**.

### M-B — T2 죽은 군집 34개 (연결 컴포넌트 단위)

prod 가 참조하나 그 참조 자체가 미도달 = 자기들끼리만 참조하는 섬. 한 심볼 제거 시 군집 전체 동반.

- **B-1 types (7)** — `actionable-unused.json` 의 types T2 항목으로 컴포넌트 식별 후 일괄.
- **B-2 infra (19)** — 가장 큰 군집. 컴포넌트별 식별 (utility 묶음, helper 묶음 등) → 단위별 제거.
- **B-3 agent (3)** — 작은 군집 3개 별도 처리.
- **B-4 config (3)** — 동일.
- **B-5 storage (1)** + **server (1)** — 합쳐서 마무리.

> 각 군집 = **재검증 → 외부 진입 0 확인 → 일괄 제거 → 게이트**. 감사 결과 + actionable-unused.json 의 islanding 근거를 1차 소스로 사용.

### M-C — T3 테스트만 41개 (case-by-case, phase46 이월 허용)

prod 소비 0 + test 만. **디폴트 = 동반 제거**, KEEP 케이스 review 에 사유 기록.

- **C-1 infra (16)** — 가장 큰 비중. 테스트 유틸 (`is-main` 등) 도 포함 — TEST_FIXTURE 로 판정되어 KEEP 된 것과 구분 필요(원본 감사가 이미 분리, 본 16 은 진짜 dead).
- **C-2 types (7)** + **agent (6)** + **gateway (4)** + **storage (4)** + **config (3)** + **server (1)** — 합산 25.

> M-C 가 phase45 안 못 끝나면 **남은 만큼 phase46 이월** (kickoff §4 결정).

## 3. 리스크

- **감사 false positive (37 검증된 추출기 버그 + 추가 가능):** 동적 dispatch / polymorphism / framework 미인식. M-B 의 island 가 가장 위험 (한 인터페이스 사각이 30+ 오탐 연쇄 가능 — `InMemoryToolRegistry.execute` 케이스 참고). 안전 원칙 1 (재검증) 으로 차단.
- **인터페이스 트림 cascade:** `CommandRegistry.execute` 트림 시 구현체 cascade — A-9 마지막에 배치 + 별 step.
- **배럴 정리 누락:** 각 심볼 삭제 시 `types/index.ts` · `infra/index.ts` 등 배럴 동반 정리. 누락 시 typecheck 가 잡지만, 명시적 step 으로 안전.
- **분량:** 114 항목 + cascade. 45 안에서 M-A + M-B 완료 목표, M-C 는 best-effort + 이월.
- **phase44 와 중복 검증:** phase44 가 grep-based 로 일부 제거했을 수 있음. 첫 재검증 시 "이미 제거됨" 발견 → 해당 항목 skip + review 기록.

## 4. 검증 / 컨벤션

- 서브밀스톤마다 1 커밋, subject ASCII. 각 종료 시 전체 게이트(format/lint/typecheck/**build**/test).
- 삭제 커밋 = `refactor(phase45): remove dead <area> (<count> items)` 형식 + 본문에 제거 심볼·재검증 근거(감사 카테고리·근거 source).
- 보류 커밋 = 없음 (보류는 review.md 에만 기록, false positive 로 KEEP).
- §3 외과적 — 인벤토리에 없는 코드 불변. false positive 는 삭제 말고 review 기록.
