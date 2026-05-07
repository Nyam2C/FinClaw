---
name: finclaw-phase-execute
description: FinClaw phase 의 plan.md 부터 review.md 까지 자동으로 돌리는 풀 사이클 하네스. 3단계 — (1) phase-todo-architect 가 plan.md 를 코드 단위 todo.md 로 분해 → 사용자 승인 → 저장 (2) phase-implementer 가 todo.md 를 밀스톤 단위로 구현하고 각 밀스톤 검증 통과 시 커밋 (3) finclaw-phase-finalize 자동 연쇄 호출로 review.md 초안 생성 → 사용자 승인 → 저장. "phase 시작", "phase {NN} 작업해줘", "plan 부터 review 까지", "phase 풀 사이클", "phase 27 처음부터 끝까지" 같은 요청 시 반드시 이 스킬을 사용한다. 후속 키워드: "todo 만 다시", "step 5 부터 다시", "phase 27 이어서", "review 만 다시", "이전 실행 기반 보완". 모드 B (자동 코드 변경) — 단, todo.md 저장 + review.md 저장 두 곳에 사용자 승인 게이트.
---

# FinClaw Phase Execute Orchestrator

## 핵심 목표

phase 의 `plan.md` 만 있는 상태에서 시작해 **todo.md 분해 → 코드 구현 → review.md 작성** 까지 자동으로. 안전 게이트는 두 곳:

1. todo.md 가 plans/ 에 저장되기 전 → 사용자 검토
2. review.md 가 plans/ 에 저장되기 전 → 사용자 검토 (기존 finalize 동작)

코드 자체는 모드 B (자동 적용 + 커밋). 단, 검증 실패하면 즉시 정지하고 사용자 결정 대기.

## 트리거 vs 비트리거

**트리거**: "phase 27 시작해줘", "phase 27 plan 부터 review 까지", "phase 풀 사이클", "phase 27 처음부터 끝까지", "이번 phase 자동으로 돌려". 후속 — "todo 만 다시", "step 5 부터 다시", "이어서".

**비트리거**:

- plan.md 작성 자체 (이건 사람이 직접 — 결정·트레이드오프가 결정적)
- 단일 파일 수정 ("이 함수 정리" — 직접 Edit)
- review.md 만 (이미 phase 가 끝나서 검토만) → `finclaw-phase-finalize` 가 적합
- 신규 phase 폴더 생성 자체 (사용자가 plan.md 부터 직접 작성)

## Phase 0: 컨텍스트 확인

오케스트레이터 시작 시 다음을 결정한다.

1. **대상 phase 번호 확인**
   - 사용자 발화에서 추출
   - 미명시면 plans/ 최신 phase 폴더로 추정 + 사용자 확인
2. **입력 검증**
   - `plans/phase{NN}/plan.md` 존재 여부 — 없으면 즉시 종료, 사용자에게 plan.md 작성 요청
   - `plans/phase{NN}/todo.md` 존재 여부 — 있으면 architect 단계 건너뛰기 결정 (사용자 확인)
   - `plans/phase{NN}/review.md` 존재 여부 — 있으면 implementer 단계까지 건너뛰기 결정 (사용자 확인)
3. **이전 산출물 확인**
   - `_workspace/phase-execute/{phase}-*.md` 존재 여부
   - 사용자 부분 수정 요청 ("todo 만 다시", "step 5 부터") → 해당 단계만 재실행
   - 사용자 새 입력 (전체 다시) → `_workspace/phase-execute/` 를 `_workspace_prev/` 로 이동
   - 미존재 → 초기 실행
4. **base SHA 결정**
   - phase 작업 시작 시점의 커밋 (이전 phase 마지막 커밋 또는 현재 main)
   - 추정 후 사용자 확인 ("base SHA `{sha}` 로 진행할게요. 다른 base 라면 알려주세요.")
5. **branch 확인**
   - 현재 브랜치가 main 이면 경고 (직접 main 에 커밋하지 않음)
   - phase 전용 브랜치 (예: `feature/us-market-data`) 권장 — 미존재 시 `git switch -c feature/{phase 도메인}` 제안

## Phase 1: Plan → Todo (서브 에이전트)

**실행 모드: 서브 에이전트** (단일 작업, 팀 통신 불필요)

`Agent` 도구로 `phase-todo-architect` 직접 호출 (`subagent_type: general-purpose`, `model: opus`).

입력:

- phase 번호
- `plans/phase{NN}/plan.md`
- pnpm-workspace.yaml, tsconfig.json, packages/\*/package.json

출력:

- `_workspace/phase-execute/{phase}-todo-draft.md`
- 옵션: `_workspace/phase-execute/{phase}-questions.md` (모호함 발견 시)

**게이트 1 — 사용자 승인:**

1. 메인이 사용자에게 todo-draft.md 위치 + 핵심 분해 요약 (밀스톤 N개, 단계 N개, 변경 예상 LOC) 보고
2. 사용자 옵션:
   - "그대로 진행" → `plans/phase{NN}/todo.md` 로 Write + Phase 2 진입
   - "수정 후 진행" → 사용자 피드백 받아 architect 재호출 (부분 수정), 다시 게이트 1
   - "todo 까지만, 구현은 나중에" → todo.md 저장 후 종료

`questions.md` 가 있으면 사용자 답변 받기 전까지 진행 보류.

## Phase 2: Todo → 코드 (서브 에이전트, 밀스톤 단위 검증)

**실행 모드: 서브 에이전트**

`Agent` 도구로 `phase-implementer` 호출. 한 번에 전체 todo.md 를 받지만, 내부적으로 밀스톤 단위로 자체 정지·재개:

- 밀스톤 A 완료 → typecheck/test 통과 → 커밋 → 밀스톤 B 시작
- 검증 실패 → SendMessage 로 즉시 보고 → 오케스트레이터 정지

오케스트레이터는 implementer 의 진행을 모니터링하고:

- 한 밀스톤이 30분 이상 끝나지 않으면 진행 상황 확인 (SendMessage)
- 검증 실패 보고 받으면 사용자에게 알림 + 결정 대기:
  - "수정해서 재시도" → architect 에 피드백 → todo.md 부분 수정 → implementer 재개
  - "이 밀스톤 건너뛰고 다음" → implementer 에게 다음 밀스톤부터 재개 (위험 — review 단계에 ❌ 로 표시됨)
  - "정지" → 현재 상태로 중단, 다음 세션에서 재개 가능

출력:

- git 커밋 (밀스톤마다)
- `_workspace/phase-execute/{phase}-implementer-log.md`

**게이트 2 — 명시적 사용자 게이트는 없음** (밀스톤 검증이 자동 게이트). 사용자가 명시 요청 시 ("밀스톤마다 확인") 추가 게이트 가능.

## Phase 3: Review (기존 `finclaw-phase-finalize` 연쇄)

implementer 가 모든 밀스톤을 완료하고 마지막 커밋이 끝나면 자동으로 `finclaw-phase-finalize` 스킬 트리거:

- base SHA = phase 시작 시점
- 대상 phase = 본 작업의 phase 번호
- 옵션: e2e/live 미포함 (기본)

`finclaw-phase-finalize` 가 자체 워크플로우로:

- `phase-refactor-expert` + `phase-qa-engineer` 병렬 실행
- review-draft.md 통합
- **게이트 3** (사용자 승인) → `plans/phase{NN}/review.md` 저장

## Phase 4: 마무리 옵션 (사용자)

review.md 가 저장되면 메인이 사용자에게 후속 옵션 제시:

1. **PR 생성**: 현재 브랜치를 push + `gh pr create` (PR 본문 = review.md 요약)
2. **다음 phase 시작**: 새 plan.md 가 있으면 본 스킬 재호출 가능
3. **종료**: 작업 보존, PR 은 사용자가 직접

자동 PR 생성은 기본 X — 사용자 명시 요청 시만.

## 데이터 전달 프로토콜

| 전략   | 적용                                                                                                                    |
| ------ | ----------------------------------------------------------------------------------------------------------------------- |
| 파일   | `_workspace/phase-execute/{phase}-{todo-draft,implementer-log,questions}.md`, 그리고 `plans/phase{NN}/{todo,review}.md` |
| 메시지 | implementer 의 검증 실패 / architect 의 모호함 발견 시 즉시 SendMessage                                                 |
| 태스크 | 밀스톤마다 TaskCreate / TaskUpdate (오케스트레이터가 모니터링)                                                          |
| 반환값 | 서브 에이전트 (architect/implementer) 의 종료 메시지                                                                    |

## 에러 핸들링

| 상황                           | 대응                                                                            |
| ------------------------------ | ------------------------------------------------------------------------------- |
| plan.md 부재                   | 즉시 종료, 사용자에게 plan.md 작성 요청                                         |
| todo.md 이미 존재              | 사용자 확인 — 덮어쓰기 / 건너뛰고 Phase 2 진입 / 종료                           |
| review.md 이미 존재            | 사용자 확인 — finalize 가 draft 만 만들고 머지는 사용자 결정 (기존 동작)        |
| architect 가 questions.md 생성 | 진행 보류, 사용자 답변 대기                                                     |
| implementer 검증 실패          | 즉시 정지, 사용자 결정 대기 (수정 / 건너뛰기 / 종료)                            |
| 커밋 lefthook 실패             | format:fix → 재시도. conventional 실패 시 ASCII subject 로 재시도.              |
| 부분 재실행 ("step 5 부터")    | implementer 에게 시작 단계 + base SHA 전달. 이전 단계 변경 의존 시 사용자 확인. |
| 현재 브랜치가 main             | 경고, phase 전용 브랜치 생성 제안. 사용자 명시 동의 없이 main 에 커밋 X.        |
| finalize 단계 실패             | implementer 까지 완료된 상태로 사용자에게 보고. review 만 별도로 재시도 가능.   |

## 팀 크기

서브 에이전트 모드 — architect 1, implementer 1, finalize 가 자체 팀 (refactor + qa). 본 오케스트레이터 자체는 팀 안 만듦. 팀 모드 오버헤드 불필요 (architect 와 implementer 는 순차 의존).

## 테스트 시나리오

### 정상: phase 27 풀 사이클

1. 사용자: "phase 27 시작해줘"
2. 메인 — plan.md 존재 확인, todo.md / review.md 미존재, base SHA 추정 + 브랜치 확인 (`feature/us-market-data`)
3. `phase-todo-architect` 호출 → `_workspace/phase-execute/27-todo-draft.md` 생성
4. 메인이 사용자에게 분해 요약 보고 ("밀스톤 4개, 단계 18개, 예상 +400 LOC")
5. 사용자: "진행" → `plans/phase27/todo.md` 저장
6. `phase-implementer` 호출 → 밀스톤 A 적용 → 검증 PASS → 커밋 → ... → 밀스톤 D 완료
7. 자동으로 `finclaw-phase-finalize` 트리거
8. refactor + qa 병렬 → review-draft.md
9. 메인이 핵심 발견 보고
10. 사용자: "그대로" → `plans/phase27/review.md` 저장
11. 메인: "PR 생성할까요?" → 사용자 결정

### 부분 재실행: todo 만 다시

1. 사용자: "phase 27 todo 다시 작성해줘"
2. 메인 — `_workspace/phase-execute/27-todo-draft.md` 존재 확인
3. `phase-todo-architect` 만 재호출, implementer / finalize 는 호출 X
4. 게이트 1 → 사용자 결정

### 에러: 밀스톤 B 검증 실패

1. implementer 가 밀스톤 B 끝에 typecheck FAIL → SendMessage
2. 메인이 에러 인용 보고 + 옵션:
   - "todo.md 의 B3 단계가 잘못됨 → architect 가 수정"
   - "내가 직접 수정 후 재개"
   - "정지"
3. 사용자 선택대로 분기

## 참고

- todo 분해 컨벤션: `references/todo-decomposition-guide.md`
- 구현 프로토콜: `references/implementation-protocol.md`
- finalize 연쇄 호출 후의 review.md 포맷: `.claude/skills/finclaw-phase-finalize/references/review-md-template.md`
