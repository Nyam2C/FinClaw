# Phase 45 kickoff — audit-driven dead-code sweep

> 작성 2026-05-31 · base = main `16939cf` (phase44 머지) · 인벤토리 = `_workspace/decl-audit/unused-report.md`

## 목표

phase44 가 grep-based sweep 으로 8 영역(C1~C8) 정리했지만, 이후 12 에이전트 교차 검증 + 동적 dispatch 감사 + 추출기 자체 버그 수정한 **신뢰도 높은 인벤토리**가 산출되었다. 114 actionable 항목을 카테고리(T1/T2/T3)로 안전 제거. = "phase44 의 추가 그라운드 청소, 단 결정론적 인벤토리 기반."

## 인벤토리 (감사 결론)

```
1,756 선언
 ├─ 1,307  도달=사용 (KEEP)
 └─   449  미도달 후보
        ├─ 114  ★진짜 미사용 (actionable)      ← phase45 대상
        ├─ 237  오탐 (KEEP, 동적 dispatch 등)
        ├─  96  제한 사용 (KEEP)
        └─   2  수동 해소
```

**114 = T1(39) + T2(34) + T3(41)**, 패키지별 분포 — infra 39 · types 18 · server 14 · agent 11 · skills-finance 9 · config 8 · storage 8 · gateway 6 · skills-general 1. channel-discord/tui/web actionable = 0.

## 3 마일스톤

### M-A — T1 무참조 39개 (가장 안전)

참조 0 또는 reexport-only. 인접 cascade 없음.

- infra (4): `ConcurrencyLaneManager.resetGeneration`, `EventMap`, `createFlushFn`, `defaultLoggerFactory`
- types (4): `TimeInterval`, `WsEvent`, `GatewayStatus`, `BroadcastChannel`
- server (12): `InMemoryCommandRegistry.execute` (+ interface 트림), `PipelineError`, `CommandStageResult`, `PluginExports`, `resetJiti`, `ProcessLifecycle.shutdown`, `PluginLoadError`, `bridgeHooksToEventBus`, `SpawnError`/`SpawnTimeoutError`/`LaneClearedError`/`QueueFullError`
- skills-finance (9): `ALERT_/MARKET_/NEWS_SKILL_METADATA` reexport, `ProviderRegistry.resolveWithFallback`/`list`, `PortfolioStore.{upsertPortfolio,deletePortfolio,upsertHolding,removeHolding}`
- storage (3): `updateConversation`, `deleteCachedEmbeddings`, `listConversations` reexport
- config (2): `now` reexport, `ValidatedFinClawConfig` reexport
- gateway (2): `WsOutboundMessage`, `resetVersionCache`
- agent (2): `ToolGroup`/`ToolInputSchema` reexport
- skills-general (1): `GENERAL_SKILL_METADATA`

### M-B — T2 죽은 군집 34개 (cascade 주의)

prod 가 참조하나 그 참조 자체가 어떤 진입점에서도 도달 불가 = 자기들끼리만 참조하는 섬. 연결 컴포넌트 단위 제거.

- infra 19, types 7, agent 3, config 3, server 1, storage 1
- 작업 단위 = 컴포넌트별 (개별 심볼 아닌 군집)

### M-C — T3 테스트만 41개 (코드+테스트 동반 결정)

prod 소비 0, 테스트만 사용. 의도성(테스트 가능성 보장) 확인 후 KEEP 또는 코드+테스트 동반 제거.

- infra 16, types 7, agent 6, gateway 4, config 3, storage 4, server 1
- **각 심볼 결정 = "테스트가 의도 보장용 (인터페이스 확장점) vs 죽은 코드의 테스트"**

## 보존 (불변)

- 메모리 RAG · cron · read-only · 매수=사람 · 키없이부팅 · thin orchestrator(phase43)
- 237 false positive (DYNAMIC_DISPATCH 91 + POLYMORPHIC 78 + FRAMEWORK 68) 유지
- 96 제한 사용 (TEST_FIXTURE 74 + PUBLIC_API 22) 유지

## plan.md 가 해소할 열린 질문

1. **T3(41) 공격성** — 테스트가 의도 보장 = KEEP / prod 미소비 = 동반 제거. 어느 쪽 디폴트?
2. **인터페이스 트림** — `CommandRegistry.execute` (T1 server) 는 인터페이스에까지 노출 → 계약 축소 같이 할지.
3. **분량 처리** — 114 항목 + cascade 검증으로 phase45 초과 가능. 초과 시 M-C 만 phase46 로 / T2 중 위험군만 분리.
4. **재검증 강도** — phase44 와 동일 (삭제 직전 grep) / + 추가 검증(test 실행 / build 등 게이트 단계 추가).

## 산출물

이 kickoff + `plan.md`(마일스톤·안전 원칙·리스크) → 승인 → `todo.md` → 구현 → `review.md`. 45 초과 시 46 이월 허용.
