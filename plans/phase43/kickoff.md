# Phase 43 킥오프 — 에이전트 라우팅 재설계 + dead-code 제거

> 작성 2026-05-29 · base = main `e3af851` (phase42 머지: type slim + route_task 토대 + routing cascade 제거)
> 상태: **초안 — plan.md 가 열린 질문 해소 후 사용자 승인 게이트.**
> 선행 입력: `plans/phase42/review.md`, `_workspace/phase42-codebase-report/REPORT.md`(전체 레포 dead-code 감사 77건).
> X/FinTwit 소셜 신호 계획(구 phase43)은 `plans/phasex/` 로 파킹 — 본 재설계 이후 별도 phase.

## 목표 (사용자 확정)

FinClaw 를 사용자가 의도하는 **단일 에이전트 흐름**에 맞게 재구성하고, 그 과정에서 필요없는 코드를 제거한다.

```
Discord 채팅
  → OSS 메인 에이전트 (claude CLI, 구독 토큰)
  → [채팅 판단 · 작업 분류]
  → 함수 (결정적, LLM 0)         ┐
  → 서브에이전트 (좁은 컨텍스트 LLM) ┘
  → 서브에이전트/함수 작업 결과를 반환
```

핵심 = **메인 에이전트는 "분류·위임"에 집중하고, 실제 작업은 함수 또는 좁은 서브에이전트가 수행**한다. phase42 가 깐 `route_task` 디스패처가 이 흐름의 토대다 (현재 `market_analysis` 1 intent 만 sub-agent 로 구현).

## 불변식 / 보존 (건드리지 않음)

- **메모리 = RAG 그대로.** `auto-reply/stages/{memory-capture,memory-retrieval,context}.ts` + `storage/{search(hybrid vector+FTS),embeddings}` 구조 유지. 재설계 대상 아님.
- **cron = 설정·작동 분리 유지.** 설정 수신 = OSS 메인 에이전트의 `schedule_manage` 도구(skills-general), 작동 = `automation/{scheduler,delivery}`. **이미 이 구조** — 보존·정리만.
- read-only 우선 · 환각 방지 · 매수=사람만 · 1인 감사 가능성 · 키 없이 부팅(구독 OAuth).

## 재구성 대상 (rebuild)

- **라우팅/분류/dispatch 계층.** 메인 에이전트가 어떤 입력을 직접 처리하고 어떤 것을 `route_task`(함수/서브에이전트)로 위임하는지의 경계. 현재는 단순 도구(`get_stock_price`·`get_market_chart`·alerts 등)가 **직접 도구**로 남아 route_task 와 역할이 겹친다 — 이 중복을 목표 흐름에 맞게 정리.
- **route_task intent 모델 확장.** phase42 가 이연한 `price_lookup`(함수)·`chart_data` 등. intent enum 하드코딩 → (검토) `prompts/sub-agents/*.md` frontmatter 동적 구성.
- **서브에이전트 정의 구조.** 좁은 system prompt + 좁은 도구 세트를 어디에 어떻게 정의할지 (phase42 결정1 `AgentProfile`/`agentDir` 토대와 연결).

## 제거 대상 (dead-code)

감사 보고서(`_workspace/phase42-codebase-report/REPORT.md`, 77 finding) + phase42 이연 orphan 을 1차 입력으로, 목표 아키텍처에 불필요한 코드를 제거한다. 우선 후보:

- phase42 부산물: `buildDispatcher`(agent) 의 test-only `toolDefinitions` 반환, `defaultModel`/`ANALYZE_MARKET_FALLBACK_MODEL` dead plumbing, `skill.ts` minModel stale 주석.
- 기존 백로그: 압축 서브시스템(`agent/agents/context/`), `auth:resolve` 이벤트, `forceToolChoice`/`forceToolName` plumbing.
- 감사 net-new 후보(우선순위·범위는 plan 이 결정): 부팅 안전장치 4종(회귀 의심 — 제거 아닌 **의도성 확인 먼저**), server `services/{hooks,security,daemon}`, 플러그인 슬롯, web 관찰성 UI, storage messages/alerts 테이블(+latent bug), 배럴 over-export.

## 범위 (한눈에)

- **IN:** 메인 에이전트 분류·위임 경계 재설계, route_task intent 확장(함수/서브에이전트), 서브에이전트 정의 구조, 목표 아키텍처에 불필요한 dead-code 제거.
- **OUT:** 메모리 RAG 재설계(보존), cron 구조 변경(보존·정리만), X/FinTwit 소셜 신호(phasex 파킹 → 후속 phase), KR 국내주식(스코프 밖), 신규 외부 데이터소스.

## plan.md 가 해소할 열린 질문

1. **분류·위임 경계** — 메인 에이전트가 직접 도구를 얼마나 보유하나? (a) 거의 0, 모든 도메인 작업을 route_task 로 / (b) trivial 은 직접, 무거운 것만 route_task / (c) 현행 유지 + route_task 점진 확장.
2. **함수 vs 서브에이전트 분류 기준** — 어떤 intent 가 결정적 함수이고 어떤 게 LLM 서브에이전트인가.
3. **분류 방식** — 메인 에이전트 ReAct 가 intent 선택(현행) vs 별도 분류 단계.
4. **dead-code 제거 공격성** — 회귀 의심 부팅 안전장치·미완 확장 토대(플러그인 슬롯·세션 클러스터)를 제거 vs 보존. §3(외과적) 존중.
5. **phase 분할** — 43 안에 라우팅 재설계 + dead-code 를 다 넣을지, 44 로 분할할지.

## 산출물

이 kickoff + `plan.md`(설계·마일스톤) → 사용자 승인 → `todo.md` 분해 → 밀스톤 구현 → `review.md`. (43 안에 다 못 끝내면 44 로 이월 — 사용자 허용.)
