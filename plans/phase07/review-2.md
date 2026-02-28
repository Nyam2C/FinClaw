# Phase 7 TODO-2 코드 리뷰

> 세션 관리 + 컨텍스트 관리 & 시스템 프롬프트
>
> 수정 2개 + 소스 7개 + 테스트 3개 = 12 작업 (Step 1~13, Step 1은 수정)

---

## 1. 명세 일치 체크리스트

| Step | 설명                                       | 파일                                                    | 일치   |
| ---- | ------------------------------------------ | ------------------------------------------------------- | ------ |
| 1    | FinClawEventMap에 session/context 이벤트 6종 | `packages/infra/src/events.ts:81-89`                    | ✅     |
| 2    | Write Lock                                 | `packages/agent/src/agents/session/write-lock.ts`       | ✅     |
| 3    | Transcript Repair                          | `packages/agent/src/agents/session/transcript-repair.ts`| ✅ \*  |
| 4    | session/index.ts 배럴                       | `packages/agent/src/agents/session/index.ts`            | ✅     |
| 5    | Context Window Guard                       | `packages/agent/src/agents/context/window-guard.ts`     | ✅ \*  |
| 6    | Compaction                                 | `packages/agent/src/agents/context/compaction.ts`       | ✅ \*  |
| 7    | context/index.ts 배럴                       | `packages/agent/src/agents/context/index.ts`            | ✅     |
| 8    | System Prompt Builder                      | `packages/agent/src/agents/system-prompt.ts`            | ✅     |
| 9    | Skills Manager (스텁)                       | `packages/agent/src/agents/skills/manager.ts`           | ✅     |
| 10   | agent/index.ts 배럴 업데이트                | `packages/agent/src/index.ts`                           | ✅     |
| 11   | write-lock.test.ts                         | `packages/agent/test/write-lock.test.ts`                | ✅     |
| 12   | transcript-repair.test.ts                  | `packages/agent/test/transcript-repair.test.ts`         | ✅     |
| 13   | compaction.test.ts                         | `packages/agent/test/compaction.test.ts`                | ✅ \*  |

**결론: 모든 Step(1~13) 구현 완료, 코드 내용이 todo-2.md 명세와 일치.**

### 명세 대비 세부 차이 6건 (의도적 개선, 기능 동일)

1. **import 순서** — 전 파일 공통
   - 명세: `node:*` 먼저 → `@finclaw/*` 뒤에
   - 구현: `@finclaw/*` 먼저 → `node:*` 뒤에
   - oxlint `sort-imports` 규칙에 맞춘 것으로 보임. 기능 무관.

2. **`transcript-repair.ts:88`** — 명세 `.slice(0, i).filter(...).at(-1)` → 구현 `.findLast(...)`
   - 중간 배열 생성 없이 뒤에서부터 탐색. 기능 동일, 성능 향상.
   - Node 22+에서 지원.

3. **`transcript-repair.ts:180,200,219`** — 명세 `.sort()` → 구현 `.toSorted()`
   - review-1에서 발견된 것과 동일 패턴. 원본 배열 불변 유지.

4. **`window-guard.ts:51`** — 명세 `maxOutputTokens` → 구현 `_maxOutputTokens`
   - 함수 시그니처에 포함되어 있으나 본문에서 미사용. `_` 접두사로 린트 경고 회피.

5. **`compaction.ts:154-167`** — 명세 `var preservedSystem` → 구현 `let preservedSystem`
   - 명세가 if/else 분기에서 `var`를 사용한 것은 명백한 결함. 구현이 `let`으로 올바르게 수정.
   - `var`의 호이스팅과 블록 스코핑 부재를 회피.

6. **`compaction.test.ts:109-119`** — summarize 테스트 데이터 수정 (명세 버그 수정)
   - 명세: `'A'.repeat(200)`, `targetTokens: 50` → `safeTarget = floor(50/1.2) - 4096 = -4055`
   - `safeTarget`이 음수이므로 `tokenCounter(summary) <= safeTarget`이 항상 false → summarize 3단계 전부 실패 → truncate-oldest 폴백 → `result.summary`가 undefined → 테스트 실패
   - 구현: `'A'.repeat(40000)`, `targetTokens: 6000` → `safeTarget = 5000 - 4096 = 904` → mockSummarizer의 짧은 결과가 통과 → 테스트 성공
   - **명세의 산술 오류를 정확히 수정한 것.**

---

## 2. 발견된 이슈 (3건)

### 이슈 1: repairTranscript — 단순 offset 계산의 정확성 한계 (중간)

**위치:** `transcript-repair.ts:186`

```typescript
offset = -sortedDuplicates.length;
```

중복 제거 후 나머지 작업(empty tool 교체, orphan 삽입, missing 삽입)의 인덱스를 보정할 때 "제거된 중복 수"를 일괄 차감한다. 이는 **모든 중복이 대상 인덱스보다 앞에** 있을 때만 정확.

**시나리오:** 중복이 index 5에서 제거되고, empty tool이 index 3에 있을 때:
- 실제: index 3은 이동하지 않음 (뒤의 요소만 shift)
- 계산: `adjustedIdx = 3 + (-1) = 2` → 잘못된 위치 참조

**현실 영향:** 중복과 다른 손상이 동시에, 중복이 뒤쪽에 있을 때만 발생. 일반적 트랜스크립트에서는 드문 조합이지만, 방어적 코드가 바람직.

**심각도:** 중간 (엣지 케이스 정확성)
**참고:** 명세와 동일한 로직이므로 명세 수준의 설계 이슈.

---

### 이슈 2: write-lock.ts — 재진입 해제 시 시그널 핸들러 미정리 (중간)

**위치:** `write-lock.ts:154-166` (재진입 경로의 release 함수)

첫 번째 잠금 획득 시 시그널 핸들러(`onSignal`)가 등록되고, 반환된 `release`에서 `process.removeListener`로 정리한다. 그러나 재진입 경로(line 154-166)의 `release` 함수에는 시그널 핸들러 정리 코드가 없다.

**시나리오:**
```
lock1 = acquire(reentrant=true)   // SIGINT/SIGTERM 핸들러 등록, count=1
lock2 = acquire(reentrant=true)   // count=2, 다른 release 함수 반환
lock1.release()                   // count 2→1, 반환 (핸들러 정리 안 함)
lock2.release()                   // count 1→0, unlink + delete 수행, 핸들러 정리 안 함!
```

`lock2.release()`는 재진입 경로의 release 함수이므로 `process.removeListener(onSignal)`을 호출하지 않는다. `onSignal`은 첫 번째 release의 클로저에만 존재.

**영향:** 시그널 핸들러가 프로세스 수명 동안 누적. 장기 실행 프로세스에서 잠금 획득/해제가 반복되면 핸들러 누수.
**완화:** 테스트에서는 `lock2.release()` → `lock1.release()` 순서로 호출하여 문제가 드러나지 않음.

**심각도:** 중간 (핸들러 누수, 장기 실행 환경에서만 표면화)
**참고:** 명세와 동일한 구조이므로 명세 수준의 설계 이슈.

---

### 이슈 3: compaction.ts — safeTarget 음수 가능 (낮음)

**위치:** `compaction.ts:176-177`

```typescript
const safeTarget =
  Math.floor(options.targetTokens / SAFETY_MARGIN) - SUMMARIZATION_OVERHEAD_TOKENS;
```

`targetTokens`가 약 4916 이하(`ceil(4096 * 1.2)`)이면 `safeTarget`이 음수가 된다. 이 경우 summarize 1~2단계가 항상 실패하여 3단계(truncate-oldest)로 폴백된다.

**영향:** 기능적으로 안전 (폴백 체인이 동작). 다만 의도는 "summarize 시도 후 폴백"인데, 작은 targetTokens에서는 summarize를 시도조차 못 하고 무조건 폴백한다. `safeTarget = Math.max(0, ...)` 클램핑을 추가하면 summarize 가능 여부를 실질적으로 판별할 수 있다.

**심각도:** 낮음 (graceful degradation 동작, 명세의 테스트 버그에서 이미 표면화되어 수정됨)

---

## 3. 테스트 커버리지 요약

| 테스트 파일                 | 테스트 수 | 커버 대상                                                              |
| --------------------------- | --------- | ---------------------------------------------------------------------- |
| `write-lock.test.ts`        | 7         | 획득/이중잠금/해제/재획득/stale(시간)/stale(PID)/재진입                |
| `transcript-repair.test.ts` | 10        | detect: 정상/중복/orphan/missing/empty/sequence + repair: 4개 복구전략 |
| `compaction.test.ts`        | 7         | 불필요시 skip/truncate-tools/truncate-oldest/summarize/hybrid/preserve/폴백 |

총 24개 테스트. 주요 분기 커버됨.

**테스트 미커버 영역:**
- window-guard.ts (`evaluateContextWindow`) — 테스트 없음. 순수 함수이므로 단위 테스트 추가 용이.
- system-prompt.ts (`buildSystemPrompt`) — 테스트 없음. 출력 형식 검증이 필요할 수 있음.
- skills/manager.ts (`InMemorySkillManager`) — 테스트 없음. CRUD 로직이 단순하여 우선순위 낮음.

---

## 4. 종합 판정

**구현 상태: 완료 ✅**

- 명세 13개 Step 전부 구현, 코드 품질 양호
- 명세 대비 차이 6건 모두 의도적 개선 (lint 준수, 불변성, 성능, 명세 버그 수정)
- 발견 이슈 3건 중 실제 런타임 버그는 없으나, 이슈 1(offset 계산)과 이슈 2(핸들러 누수)는 향후 정확성 보장을 위해 수정 권장
- compaction.test.ts의 summarize 테스트 데이터 수정은 명세의 산술 오류를 정확히 교정한 올바른 판단

---

## 5. 리팩토링 발견 사항

### 발견 1: repairTranscript offset을 인덱스별로 정확히 계산

현재 blanket offset 대신, 각 대상 인덱스에 대해 "해당 인덱스보다 앞에서 제거된 중복 수"를 계산:

```typescript
// before (현재)
offset = -sortedDuplicates.length;
// ... adjustedIdx = idx + offset;

// after (제안)
function countRemovedBefore(idx: number, removed: number[]): number {
  return removed.filter(r => r < idx).length;
}
// ... adjustedIdx = idx - countRemovedBefore(idx, sortedDuplicates);
```

### 발견 2: 재진입 잠금의 시그널 핸들러 정리를 공유 클로저로 통합

재진입 경로의 release에서도 시그널 핸들러를 정리할 수 있도록, `onSignal` 참조를 `heldLocks` 맵에 저장하거나, 첫 번째 획득 시 등록된 핸들러 정리 함수를 공유:

```typescript
interface HeldLock {
  lockPath: string;
  pid: number;
  count: number;
  cleanupSignals?: () => void;  // 추가
}
```

### 발견 3: window-guard, system-prompt, skills/manager 테스트 추가

세 모듈 모두 테스트가 없음. todo-2 명세에 포함되지 않았으므로 구현 누락은 아니지만, Phase 7 완료 전에 커버리지 보강 권장:
- `evaluateContextWindow`: threshold 경계값 테스트 (safe/warning/critical/exceeded)
- `buildSystemPrompt`: mode별 섹션 포함 여부, priority 정렬 순서
- `InMemorySkillManager`: load/unload/getTools 기본 CRUD
