# Phase 31 — Todo

`plans/phase31/plan.md` 의 6 밀스톤 + 통합 테스트.

## 밀스톤 A — Top-of-Hour Stagger (1h)

- [ ] `packages/server/src/automation/stagger.ts` 신규 — OpenClaw `src/cron/stagger.ts:1-47` 이식 (`CronSchedule` import 제거 + 인자 타입 단순화)
- [ ] `packages/server/src/automation/scheduler.ts:134` 부근 — `findDueSchedules` 후 `resolveCronStaggerMs` 적용 + jitter > 0 이면 이번 폴링 skip
- [ ] `packages/server/test/automation/stagger.test.ts` 신규 — 4 테스트 (정각 매칭, 5분 간격 미매칭, 매 2시간 매칭, 명시 staggerMs 우선)
- [ ] `pnpm test --filter @finclaw/server -- stagger` 통과

## 밀스톤 B — Schedule Error Backoff (30m)

- [ ] `packages/server/src/automation/scheduler.ts` 상단 — `ERROR_BACKOFF_SCHEDULE_MS` 배열 + `errorBackoffMs(consecutiveErrors)` 함수 (OpenClaw `src/cron/service/timer.ts:107-119` 이식 + export)
- [ ] `scheduler.ts:289-310` retry 자리 — `error && nextMs !== null` 조건에서 `backoffNextMs = Date.now() + errorBackoffMs(failures)` 로 nextMs override
- [ ] `schedule.backoff_applied` 로그 이벤트 추가
- [ ] `packages/server/test/automation/scheduler.backoff.test.ts` 신규 — 7 테스트 (1~5차 실패 + cap + 0 defensive)
- [ ] `pnpm test --filter @finclaw/server -- backoff` 통과

## 밀스톤 C — Compaction 배선 (30m)

- [ ] `packages/server/src/auto-reply/stages/context.ts` — `evaluateContextWindow` + `compactContext` import + 호출 (system prompt 빌드 후 execute stage 직전)
- [ ] `pipeline-context.ts` — `tokenCounter` + `summarizer` 의존성 추가
- [ ] `packages/server/src/main.ts` — anthropic adapter 의 token counter + summarize 함수 주입
- [ ] `packages/server/test/auto-reply/stages/context.compaction.test.ts` 신규 — 2 테스트 (under critical / at critical)
- [ ] `grep -rn 'compactContext\|evaluateContextWindow' packages/server packages/agent --include='*.ts'` 결과에 `auto-reply/stages/context.ts` 포함 확인

## 밀스톤 D — Tool-Loop 2-Detector (4h)

- [ ] `packages/agent/src/agents/tools/loop-detector.ts` 신규 — OpenClaw `src/agents/tool-loop-detection.ts:1-360` 중 generic_repeat + global_circuit_breaker 부분만 이식 (~180 LOC)
  - [ ] `stableStringify` + `digestStable` (sha256)
  - [ ] `hashToolCall(toolName, params)` + `hashToolResult(result, error)`
  - [ ] `getNoProgressStreak(history, toolName, argsHash)`
  - [ ] `detectToolCallLoop` — warning(10) / critical(20) / global(30) 등급
  - [ ] `appendHistory` (max 30)
- [ ] `packages/agent/src/agents/tools/registry.ts:124-133` — 기존 `LOOP_THRESHOLD`, `LOOP_WINDOW_MS`, `isToolLoop` 함수 제거
- [ ] `registry.ts:295-297` — `console.warn` 제거 + `detectToolCallLoop` 호출로 교체
- [ ] `registry.ts` — `callHistory: ToolCallRecord[]` + `warningKeysSeen: Set<string>` 인스턴스 필드 추가
- [ ] `registry.ts` — tool 실행 후 `appendHistory` 호출
- [ ] critical level 시 `tool.loop_blocked` 에러 반환 + warning level 시 dedupe 로그
- [ ] `packages/agent/test/tools/loop-detector.test.ts` 신규 — 6 테스트 (hash 안정성, threshold, streak break)
- [ ] `pnpm test --filter @finclaw/agent -- loop-detector` 통과

## 밀스톤 E — Session Tool-Result Guard (1h)

- [ ] `packages/agent/src/agents/session/tool-result-guard.ts` 신규 — OpenClaw `src/agents/pi-embedded-runner/tool-result-truncation.ts:43-140` 이식
  - [ ] 상수: `HARD_MAX_TOOL_RESULT_CHARS=400_000`, `MIN_KEEP_CHARS=2_000`, `TRUNCATION_SUFFIX`
  - [ ] `truncateToolResultText(text, maxChars, options)` — 줄바꿈 경계 자르기
  - [ ] `truncateToolResult(block, maxChars)` — Anthropic SDK `ToolResultBlockParam` 형식 (string 또는 array content)
  - [ ] `applyToolResultGuard(messages, maxChars)` — 메시지 배열 일괄 처리
- [ ] `packages/agent/src/agents/session/index.ts` — re-export
- [ ] `packages/agent/src/execution/runner.ts` — tool_result append 직전 `truncateToolResult` 호출 + `tool_result.truncated` 로그
- [ ] `packages/agent/test/agents/session/tool-result-guard.test.ts` 신규 — 6 테스트 (under/over limit, 줄바꿈 경계, minKeep, multi-block share, string content)
- [ ] `pnpm test --filter @finclaw/agent -- tool-result-guard` 통과

## 밀스톤 F — Schedule Agent Tool (4h)

- [ ] `packages/skills-general/src/schedule-tool.ts` 신규 — Zod schema (3 action: create/list/delete) + `createScheduleTool(rpc)` factory
- [ ] schedule.manage description 작성 (자연어 → cron 변환 가이드 + UTC 명시)
- [ ] cron 사전 검증 — `rpc.testCron` 호출 후 create
- [ ] `packages/skills-general/src/index.ts` — `registerGeneralTools(deps)` 에 `createScheduleTool(deps.rpc)` 추가
- [ ] `packages/server/src/main.ts` — RPC 클라이언트 (in-process) 생성 후 `deps.rpc` 로 주입
- [ ] `packages/skills-general/test/schedule-tool.test.ts` 신규 — 4 테스트 (create 정상, missing fields, invalid cron, list)
- [ ] e2e: Discord 에서 "매일 오전 9시에 한국 주가 알려줘" 발화 후 `schedule.list` 결과에 1건 보임 확인
- [ ] `pnpm test --filter @finclaw/skills-general -- schedule-tool` 통과

## 통합 테스트

- [ ] **시나리오 1 (12시 보고)**: schedule.create → 매분 폴러 → stagger 분산 → agent.run → Discord delivery → 실패 시 backoff → critical 시 compaction
- [ ] **시나리오 2 (도구 무한 호출)**: `market.fetch({symbol:'AAPL'})` 동일 결과 30회 → 31회째 차단
- [ ] **시나리오 3 (거대 tool result)**: AAPL 5년치 일봉 mock → 400KB truncate + 로그 확인 + Anthropic 400 회귀 0

## 최종 검증

- [ ] `pnpm test` 전체 통과 (회귀 0)
- [ ] `pnpm typecheck` 0 에러
- [ ] `pnpm lint` 0 경고
- [ ] git diff 검토 — 변경 외 무관 라인 없음 (CLAUDE.md §3 외과적 변경)
- [ ] PHASE31_DONE.md 작성 (선택)
- [ ] CLAUDE.md 변경 이력 추가 (선택)

## 메모

- **OpenClaw 가져온 코드 출처 (참조용)**:
  - Stagger: `/mnt/c/Users/박/Desktop/hi/openclaw/src/cron/stagger.ts:1-47`
  - Backoff: `/mnt/c/Users/박/Desktop/hi/openclaw/src/cron/service/timer.ts:107-119`
  - Tool-Loop: `/mnt/c/Users/박/Desktop/hi/openclaw/src/agents/tool-loop-detection.ts:1-360`
  - Tool-Result Guard: `/mnt/c/Users/박/Desktop/hi/openclaw/src/agents/pi-embedded-runner/tool-result-truncation.ts:1-140`
  - Schedule Tool: `/mnt/c/Users/박/Desktop/hi/openclaw/src/agents/tools/cron-tool.ts:1-200` (TypeBox → Zod 변환)
- **본 Phase 비대상 (Phase 32 별도)**: Backend-as-CLI, FailoverError, Cache Trace, Markdown 1차 source.
- **사용자 컨텍스트**: Claude Max + Discord only + 1인. plan.md 의 "사용자 컨텍스트" 섹션 참조.
