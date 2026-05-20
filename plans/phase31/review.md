# Phase 31 Review: Runtime Resilience — OpenClaw Adoption (Critical Fix Pack)

> todo.md 기반 구현 코드 리뷰. 구현 완료 상태, 코드 품질 이슈, 리팩토링 사항을 기록한다.

base SHA: `edce9ef` ↔ HEAD: `33834f4` (변경 LOC: +1247 / -34, 6 커밋)

OpenClaw 검증 패턴 6건(Stagger / Backoff / Compaction wiring / Tool-Loop / Tool-Result Guard / Schedule Tool)을 이식. 밀스톤별 1 커밋.

---

## 1. 구현 사항 (TODO 일치도)

집계: ✅ 27 / ⚠️ 8 / ❌ 0 (총 35 단계). ⚠️ 8건은 전부 정당한 재해석(아키텍처 실측 반영)이며 각 밀스톤 목표는 달성됨.

### 사전 준비

| 단계 | 파일/근거               | 상태    | 비고                                                                           |
| ---- | ----------------------- | ------- | ------------------------------------------------------------------------------ |
| P-1  | 의존성 추가 0           | ✅ 완료 | crypto 내장, anthropic-ai/sdk·zod 기존 dep                                     |
| P-2  | architect 코드 교차확인 | ✅ 완료 | 실측 라인 todo 반영                                                            |
| P-3  | test 디렉토리 4개 신규  | ✅ 완료 | server/test/automation, agent/test/{tools,agents/session}, skills-general/test |

### 밀스톤 A — Top-of-Hour Stagger

| 단계 | 파일:라인                                  | 상태    | 비고                                                            |
| ---- | ------------------------------------------ | ------- | --------------------------------------------------------------- |
| A1   | `server/src/automation/stagger.ts:1-48`    | ✅ 완료 | OpenClaw 1:1. oxlint curly 위해 브레이스만 추가 (behavior 무변) |
| A2   | `scheduler.ts:184-198` skip-and-reevaluate | ✅ 완료 | `schedule.staggered` 로그. 이번 분 skip + 다음 분 재평가        |
| A3   | `test/automation/stagger.test.ts`          | ✅ 완료 | 7 case                                                          |
| A4   | grep 검증                                  | ✅ 완료 | resolveCronStaggerMs = 2                                        |

### 밀스톤 B — Schedule Error Backoff

| 단계 | 파일:라인                                   | 상태    | 비고                                                                                                                                 |
| ---- | ------------------------------------------- | ------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| B1   | `scheduler.ts:81-92` errorBackoffMs export  | ✅ 완료 | [30s,1m,5m,15m,60m]                                                                                                                  |
| B2   | `scheduler.ts:362-377` override             | ⚠️ 편차 | todo `fresh?.consecutiveFailures+1` → 실제 `s.consecutiveFailures+1` (fresh 는 markScheduleRun 이후라 이 지점 미정의, 값 동일). 정당 |
| B3   | `test/automation/scheduler.backoff.test.ts` | ✅ 완료 | 7 case (1~5th + cap + 0 defensive)                                                                                                   |
| B4   | grep 검증                                   | ✅ 완료 | errorBackoffMs/backoff_applied = 4                                                                                                   |

### 밀스톤 C — Compaction 배선 (재해석 핵심)

| 단계 | 파일:라인                                                         | 상태      | 비고                                                                                                                         |
| ---- | ----------------------------------------------------------------- | --------- | ---------------------------------------------------------------------------------------------------------------------------- |
| C1   | `agent/src/execution/token-fn.ts` approxTokenCount                | ✅ 완료   | char/4                                                                                                                       |
| C2   | `anthropic.ts:259-271` summarizeText + AnthropicAdapter.summarize | ⚠️ 편차   | server 에 SDK dep 미포함 → adapter 메서드 경유 (P-1 준수). summarizeText export 도 유지                                      |
| C3   | `agent/src/index.ts` re-export                                    | ✅ 완료   | summarizeText + approxTokenCount                                                                                             |
| C4   | `pipeline-context.ts:58-62` + `pipeline.ts:66-69`                 | ✅ 완료   | tokenCounter/summarizer readonly 필드                                                                                        |
| C5   | `execution-adapter.ts:667-722` maybeCompactMessages               | ⚠️ 재해석 | todo `stages/context.ts` 가정 → 실제 execution-adapter (context.ts 는 transcript 없음). **목표 달성**, 실 시그니처 정확 사용 |
| C6   | `main.ts:499,518-519` wiring                                      | ⚠️ 편차   | baseCtx 직접 주입 → AutoReplyPipeline deps 주입. 정당                                                                        |
| C7   | `test/auto-reply/execution-adapter.compaction.test.ts`            | ⚠️ 재해석 | maybeCompactMessages 단위 테스트 3 case (mock summarizer). 목표 달성                                                         |
| C8   | grep 검증                                                         | ✅ 완료   | dead code → live (execution-adapter.ts)                                                                                      |

### 밀스톤 D — Tool-Loop 2-Detector

| 단계 | 파일:라인                                 | 상태    | 비고                                                                                                                                                                                                       |
| ---- | ----------------------------------------- | ------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| D1   | `loop-detector.ts:1-146`                  | ✅ 완료 | sha256 + stableStringify + getNoProgressStreak + detectToolCallLoop + appendHistory                                                                                                                        |
| D2   | `registry.ts:285-311` 호출 + 구 코드 제거 | ⚠️ 편차 | verdict stage `'loop-detector'` string, logger 부재로 `tool:loop:detected` bus 이벤트. **목표(console.warn → sha256 detector + circuit breaker) 달성**. callTimestamps/LOOP_THRESHOLD/isToolLoop 전부 제거 |
| D3   | `test/tools/loop-detector.test.ts`        | ✅ 완료 | 8 case (threshold 10/20/30 + streak break + cap)                                                                                                                                                           |
| D4   | grep 검증                                 | ✅ 완료 | isToolLoop/LOOP_THRESHOLD/callTimestamps/console.warn-loop = 0                                                                                                                                             |

### 밀스톤 E — Session Tool-Result Guard

| 단계 | 파일:라인                                       | 상태    | 비고                                                                                                                                                                   |
| ---- | ----------------------------------------------- | ------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| E1   | `tool-result-guard.ts:1-111`                    | ⚠️ 편차 | `Anthropic.ToolResultBlockParam` 고정 → generic `<T extends ToolResultLike>` (camelCase/snake 양방향 통과). 정당한 개선. ⚠️ **applyToolResultGuard 미배선** (§4 P1 #1) |
| E2   | `session/index.ts` re-export                    | ✅ 완료 | truncate\*/HARD_MAX/MIN_KEEP/SUFFIX                                                                                                                                    |
| E3   | `runner.ts:174-192` guard + 이벤트              | ⚠️ 편차 | logger 부재로 `tool:result:truncated` bus 이벤트. camelCase toolUseId 보존. push 직전 truncate                                                                         |
| E4   | `test/agents/session/tool-result-guard.test.ts` | ✅ 완료 | 8 case (snake block 으로도 통과 → 양방향 검증)                                                                                                                         |
| E5   | grep + typecheck                                | ✅ 완료 | 통과                                                                                                                                                                   |

### 밀스톤 F — Schedule Agent Tool (재해석 핵심)

| 단계 | 파일:라인                                                  | 상태      | 비고                                                                                                            |
| ---- | ---------------------------------------------------------- | --------- | --------------------------------------------------------------------------------------------------------------- |
| F1   | `types/src/schedule-rpc.ts` ScheduleRpc + 8 타입           | ✅ 완료   | create/list/delete/testCron                                                                                     |
| F2   | `types/src/index.ts` re-export                             | ✅ 완료   | export type \*                                                                                                  |
| F3   | `skills-general/src/schedule-tool.ts` registerScheduleTool | ⚠️ 재해석 | Zod `{ok,data}` → RegisteredToolDefinition + ToolResult (zod dep 없음). tool명 `schedule_manage`. **목표 달성** |
| F4   | `skills-general/src/index.ts`                              | ⚠️ 편차   | rpc 필수 → `config.scheduleRpc?` optional. 정당                                                                 |
| F5   | `main.ts:271-318` scheduleRpc adapter                      | ⚠️ 재해석 | standalone 핸들러 export 없음 → storage + cron 직접 호출 adapter. 정당                                          |
| F6   | `skills-general/test/schedule-tool.test.ts`                | ⚠️ 편차   | InMemoryToolRegistry 등록 후 execute → {isError,content}. 5 case. 목표 달성                                     |
| F7   | grep + typecheck + lint                                    | ✅ 완료   | 통과                                                                                                            |

### 통합 테스트 + 최종 검증

| 단계     | 상태              | 비고                                                            |
| -------- | ----------------- | --------------------------------------------------------------- |
| IT-1/2/3 | ⚠️ 부분(설계대로) | e2e(라이브 키·실서버) 자동화 제외. 각 구성요소 유닛 커버 (§3.5) |
| 최종검증 | ✅ 완료           | test/typecheck/lint/build 전부 PASS, grep 조건 전부 충족        |

---

## 2. 자동화 검증 결과

| 명령                | 결과                     | 비고                                                       |
| ------------------- | ------------------------ | ---------------------------------------------------------- |
| `pnpm typecheck`    | ✅ PASS                  | 0 에러                                                     |
| `pnpm test --run`   | ✅ 1589 pass / 0 fail    | 177 files (메인 1차 결과와 일치)                           |
| `pnpm test:storage` | ✅ 144 pass / 0 fail     | 21 files                                                   |
| `pnpm lint`         | ✅ 0 warnings / 0 errors | 536 files / 126 rules                                      |
| `pnpm build`        | ✅ PASS                  | tsc --build exit 0                                         |
| mock-only 격리      | ✅ PASS                  | ANTHROPIC/KIS/DISCORD/FINNHUB 키 전부 unset 상태 전체 통과 |

신규 테스트 6 파일 / 38 case 전부 실질 단언 (빈 테스트·skip·it.todo 0건). summarizer/RPC 전부 `vi.fn()` mock — 실 API 호출 테스트 0건.

---

## 3. 경계면 검증 (PASS 6/6, 불일치 0)

### 3.1 C — PipelineMsgContext ↔ main.ts ↔ maybeCompactMessages

- ✅ shape 일치. `main.ts:518-519` → AutoReplyPipeline deps(`pipeline.ts:66-69`) → `:344-345` ctx 전파 → execution-adapter `:670` → maybeCompactMessages(`:240`). 미주입 시 passthrough.

### 3.2 C — evaluateContextWindow / compactContext 시그니처

- ✅ `evaluateContextWindow(entries, contextWindow, maxOutputTokens, {warningThreshold,criticalThreshold,reserveTokens}, tokenCounter)` ↔ `window-guard.ts:48-54` 일치. 반환 `currentTokens`/`maxTokens`/`status` 실재.
- ✅ `compactContext(entries, {strategy,targetTokens,preserveRecentMessages,preserveSystemPrompt}, summarizer, tokenCounter)` ↔ `compaction.ts:126-131` 일치. 반환 `compactedEntries`/`beforeTokens`/`afterTokens`/`strategy` 실재.
- 주의(정당): todo 의사코드의 `{warnRatio}`/`result.entries`/`usedTokens,effectiveMax`는 실제 API 미존재 — implementer 가 실 시그니처로 교정.

### 3.3 D — registry.ts ↔ loop-detector.ts

- ✅ `detectToolCallLoop`/`appendHistory`/`hashToolCall`/`hashToolResult` 일치. loop override 가 `tool:policy:verdict` emit 이전 발생 → 다운스트림이 최종 verdict 관찰. 9-stage 호환.

### 3.4 E — runner.ts ↔ guard / F — schedule-tool ↔ ScheduleRpc ↔ main.ts

- ✅ E: `truncateToolResult(block, HARD_MAX)` generic spread 로 camelCase toolUseId 보존.
- ✅ F: `rpc.testCron/create/list/delete` ↔ ScheduleRpc(`schedule-rpc.ts:47-52`) ↔ main.ts adapter(`:271-316`) 3면 일치. 반환 필드(`id`,`nextRunAt`,`status`,`consecutiveFailures`) 실재.

### 3.5 이벤트 — emit ↔ FinClawEventMap

- ✅ `tool:loop:detected`(name,detector,count) ↔ events.ts:81, `tool:result:truncated`(callId,originalChars,maxChars) ↔ events.ts:83, `tool:policy:verdict`(name,verdict,stage:string) ↔ events.ts:77 전부 일치.

### IT 시나리오 커버리지

- IT-1 (stagger/backoff/compaction/schedule-create): ✅ 4개 유닛 존재
- IT-2 (loop critical/circuit_breaker): ✅ loop-detector.test 30 threshold case. registry 통합 deny 는 코드 검증
- IT-3 (400KB truncate): ✅ guard.test 500K→≤400K. runner 이벤트 emit 은 코드 검증

---

## 4. 리팩토링 사항

### P0 — 즉시 (병합 전)

**없음.** typecheck/test(1589 pass)/lint(0) 전부 통과, 정확성 결함·경계 위반·과도한 에러 처리 없음.

### P1 — 권장 (다음 phase 안에)

1. **`agent/src/agents/session/tool-result-guard.ts:95-111` + `session/index.ts:16` — `applyToolResultGuard` 미배선 죽은 코드**
   - 문제: export + barrel 재노출됐으나 프로덕션 호출처 0. 실제 truncation 은 `runner.ts:175-191` 이 per-block `truncateToolResult` 직접 호출. 테스트조차 import 안 함.
   - 근거: CLAUDE.md §2(미사용 추상화 금지) + §3(자기 변경으로 미사용된 함수 제거). **이번 phase 가 새로 만든 추상화**.
   - 제안: 정의+re-export 제거, **또는** runner per-block 루프를 `applyToolResultGuard` 로 대체(OpenClaw `truncateOversizedToolResultsInMessages` 에 더 근접). 둘 중 하나 — 정의만 떠 있는 현 상태가 최악.

2. **`tool-result-guard.ts` — 고정 maxChars vs OpenClaw 동적 30% (의도적 단순화, 미문서화)**
   - OpenClaw `calculateMaxToolResultChars(contextWindow)` 는 윈도우 30% 와 400K 중 작은 값 사용. FinClaw 는 항상 400K 고정.
   - 단일 모델(Claude 200K = 400K 가드 ~50%)에선 안전. `runner.ts:190` 에 의도 주석 1줄 권장 (multi-provider 시 동적 도입).

3. **`anthropic.ts:259-271` summarizeText 빈 응답 silent fallback**
   - 비-text 블록/빈 content 시 `''` 반환 → `compactContext` 1단계가 `tokenCounter('')=0` 으로 "요약 성공" 오판 → 전체 대화가 빈 요약으로 치환될 위험.
   - 실서버에서만 발생(unit 미포착). 빈 결과 시 throw → compactContext 폴백(2/3단계)으로 넘기는 게 안전.
   - **QA cross-check 결과**: §6 P2 와 동일 영역. 차단 아님. 다음 phase 검토 권장.

4. **`execution-adapter.ts:386` executeForTui 경로 compaction 미적용 (비대칭)**
   - `execute()` 는 maybeCompactMessages 통과, `executeForTui()` 는 미적용. Discord 1인 환경이라 scope 내 정당하나 같은 클래스 내 보호 수준 차이는 향후 혼란 소지. 지금은 보류 권장.

### P2 — 선택 (선호 차이)

1. `tool-result-guard.ts:12-15` TRUNCATION_SUFFIX 에서 OpenClaw ⚠️ 이모지 제거 — 정당(CLAUDE.md 이모지 정책). "OpenClaw 원본 그대로" 주석이 미세 부정확.
2. `loop-detector.ts:1-2` 헤더 주석 — 4-detector 중 2종 드롭(poll/ping-pong 은 FinClaw 미해당 도구 전용) 사유 보강 권장.
3. `loop-detector.ts:52-60` hashToolResult — OpenClaw `formatErrorForHash` 미이식. registry 가 항상 `new Error(string)` 만 넘겨 실무 동등. 정당.
4. `execution-adapter.ts:652-658` toTranscriptEntry timestamp 매 호출 현재시각 — 토큰 계산에 미사용이라 무해.
5. `schedule-tool.ts:109` 마지막 unknown action fallback — enum + zod 검증이 차단해 도달 불가. 잉여(1줄이라 실익 작음).
6. registry loop-detection / runner truncate 이벤트 **통합 유닛 부재** — 순수 함수만 커버, registry/runner 경로는 코드 검증만. InMemoryToolRegistry 31회 주입 통합 유닛 1개 추가 시 D 회귀 안전망 강화.
7. main.ts compaction 실 wiring 유닛 부재 — 키 의존이라 정당, §3 경계면으로 보증.

---

## 5. 범위 밖 발견 (참고)

> 삭제·수정 권장 X — 기록만.

- `compaction.ts:176-178` 기존 TODO(targetTokens≤~4916 시 safeTarget 음수) — Phase 26 산출. phase 31 경로(targetTokens=100K)에선 발생 불가. 범위 외.
- `runner.ts:236-237`, `anthropic.ts:73,183-185` 기존 TODO(L3)/L4 주석 — 무관, 손대지 않음.
- `automation/cron.ts` CronParseError 외 다른 cron 헬퍼 에러 타입 일관성 미확인 — 범위 외.

---

## 6. scope creep 의심

**없음.** 모든 변경 줄이 밀스톤 A~F 또는 직접 배선(events.ts 2 이벤트, index re-export, pipeline deps 주입)에 연결. 인접 코드 "개선"·무관 리팩토링 없음. (lint curly/non-null 수정은 자기 변경분 정리 — §3 위반 아님.)

---

## 7. 위험 신호

**P0/P1 차단 위험 없음.** 빌드·테스트·타입·lint 전부 green, 외부 호출 유닛 0건.

유일한 잠재 런타임 위험: P1 #3 (summarizeText 빈 응답 → 컨텍스트 손실) — 실서버 비정상 응답 시에만 발생, 다음 phase 검토.

---

## 8. 다음 phase 후보 (제안)

- P1 #1 (applyToolResultGuard 죽은 코드) 즉시 정리 또는 runner 루프 대체.
- P1 #3 (summarizeText 빈 응답 throw) — 안전한 폴백.
- P2 #6 (registry loop / runner truncate 통합 유닛) — D/E 회귀 안전망.
- Phase 32 트랙(plan.md 비대상): Backend-as-CLI, FailoverError, Cache Trace, Markdown 1차 source, Phase 30 잔여.

---

## 9. 측정값

- 변경 파일 수: 25 (신규 9 src + 5 test, 수정 11)
- 변경 LOC: +1247 / -34
- 새 테스트 수: 38 case (6 파일)
- 커밋: 6 (`160cec0` A · `897fbb3` B · `e22605f` C · `eb31dbb` D · `faa3f53` E · `33834f4` F)
- 검토 소요: refactor ~3.6분 / qa ~10.5분 (병렬)
- review-draft 생성 일시: 2026-05-20

---

## 10. 권고 — 머지 가능 여부

**판정: ✅ 머지 가능**

- P0 0건. 자동화 6/6 PASS. 경계면 6/6 일치. mock 격리 OK. ❌ 미구현 0건.
- ⚠️ 8건은 전부 정당한 재해석(아키텍처 실측) — architect 가 위임한 "inspect-and-decide" 범위 내. 목표 달성 확인.
- 머지 후 다음 phase 권장: P1 #1 (applyToolResultGuard 죽은 코드 정리) — CLAUDE.md §3 위반이므로 빠른 후속 권장.
