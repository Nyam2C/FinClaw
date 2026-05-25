# Phase 39 킥오프 — gateway 패키지 추출 (옵션 C)

> 다음 세션용 시작 문구. 작성 2026-05-26, base = main HEAD `6a408b7` (phase38 #73 머지 직후).
> **이 노트는 plans/phase39/plan.md 가 아직 없는 상태의 사전 조사 메모다. 먼저 plan.md 부터 설계할 것.**

## 할 일

`packages/server/src/gateway/` (전체 57 .ts · 테스트 포함 · ~9.9K LOC) → 신규 워크스페이스 패키지 **`@finclaw/gateway`** 로 분리.
phase36(main() 모듈화 898→433)이 옵션 C 의 선행작업을 끝냈으므로 자연스러운 후속.

## 진행 방식 (감독 필요 — 자동 풀사이클 금지)

코드부터 짜지 말고 **`plans/phase39/plan.md` 부터 같이 설계**한다. 의존그래프·순환참조·tsconfig references·build 파이프라인 재구성이 얽혀 무감독 머지에 부적합 (메모리 `project_phase31_34_merged` §gateway 후보, phase36 plan §옵션 B/C 비대상 사유와 동일). plan.md 승인 후에야 todo → 구현(phase-execute) 진입.

## 실측 사실 (다시 조사 불필요)

**진입점 / 의존**

- gateway 본체 생성은 `main.ts:292 createGatewayServer(...)` **단 한 곳** (깨끗한 단일 진입점).
- 워크스페이스 의존: `@finclaw/types(28) · infra(22) · storage(13) · agent(5) · skills-finance(2)`.

**핵심 블로커 = server ↔ gateway 순환참조**
server 가 gateway 를 import 하므로(`main.ts:292`), 추출 후 `@finclaw/gateway` 는 `@finclaw/server` 를 import 하면 안 됨. 그런데 현재 gateway 가 server 형제 모듈을 끌어쓰는 교차 import 가 존재:

- **VALUE import (런타임 결합 — 진짜 작업, 순환참조 직격):**
  - `gateway/rpc/methods/agent.ts:24` → `auto-reply/tool-dispatcher-adapter` (`buildDispatcher`)
  - `gateway/rpc/methods/agent.ts:26` → `prompts/loader` (`loadPrompt`, `requireFrontmatterKeys`)
  - `gateway/rpc/methods/schedule.ts:16-19` → `automation/cron` (`parseCron`, `nextRunAt`, `CronParseError`)
- **TYPE-only import (쉬움 — DI 역전 / @finclaw/types 승격으로 해소):**
  - `auto-reply/execution-adapter`(RunnerExecutionAdapter — chat.ts·server.ts·agent.ts), `auto-reply/router-helper`(RouterHelper), `auto-reply/agent-memory-hook`(AttachMemoryService), `observability/tracer`(FinclawTracer), `automation/scheduler`(SchedulerService), `services/brokerage-sync-service`(BrokerageSyncService).

## plan.md 가 반드시 결정할 것 (감독 포인트)

1. **순환참조 해소 전략 택1+:**
   - (a) value 헬퍼(tool-dispatcher-adapter / prompts/loader / automation/cron)를 하위 공유 패키지로 이동 — 단 auto-reply/automation 은 server 코어(pipeline)도 쓰므로 이동 방향 주의.
   - (b) context 통한 함수 주입(DI 역전) — type-only 결합은 이미 context.ts 로 대부분 DI 됨, value 3건만 함수 주입으로 전환.
   - (c) 부분 추출 — transport/rpc-dispatch/auth/broadcaster 만 `@finclaw/gateway` 로, server 결합이 있는 `rpc/methods/*` 는 server 잔존.
2. tsconfig project references · `package.json` 신규 패키지 배선 · build 파이프라인.
3. type-only 결합을 `@finclaw/types` 로 올릴지 여부.

## 스탠딩 리스크 (잊지 말 것)

**실 키 부팅 e2e 미검증 = #1 미검증 리스크** (phase35~38 누적, 메모리 명시). gateway 는 startup 임계 경로 → 추출 후 키 보유자가 `pnpm dev` smoke 1회(Gateway listening 로그 + Discord 온라인 + 스케줄러 기동) 필수. plan §리스크 + review 에 명시.

> 참고: 메모리는 기능/추출 작업보다 이 부팅 smoke 를 **먼저** 권장. gateway 추출은 사용자가 명시 선택한 phase39 범위이므로 진행하되, 추출 전 1회·추출 후 1회 smoke 를 plan 에 못박을 것.

## 컨벤션

- 테스트 baseline: unit **1679** / storage (phase38 기준). **mock-only 스탠스 유지** (실 키/네트워크 호출 금지).
- 각 밀스톤: `pnpm typecheck` + `pnpm build` + `pnpm test --run` + `pnpm test:storage` + `pnpm lint` green, 밀스톤당 1커밋.
- 순수 추출이 목표면 동작·로그·API 불변이 성공 기준 (phase36 패턴).
