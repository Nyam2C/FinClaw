---
name: finclaw-phase-finalize
description: FinClaw 의 plans/phase{NN}/ 구현이 끝난 직후 호출하는 phase 종결 하네스. phase-refactor-expert + phase-qa-engineer 2 에이전트를 병렬 실행하여 (1) 리팩토링 후보 (2) TODO 대비 구현 일치도 + typecheck/vitest/lint + 경계면 교차 검증 을 산출하고, 메인이 두 결과를 통합해 review.md 초안을 작성한다. "phase 마무리", "phase 리뷰", "리팩토링/qa", "review.md 작성", "phase 완료", "phase {NN} 검토", "phase 끝났어 검토해줘" 같은 요청 시 반드시 이 스킬을 사용한다. 후속 키워드: "다시 검토", "재검토", "phase {NN} 다시", "리팩토링만 다시", "qa 만 다시", "이전 검토 보완", "review.md 다시". 직접 코드 수정·자동 review.md 저장 X. 사용자 승인 후 plans/phase{NN}/review.md 로 머지.
---

# FinClaw Phase Finalize Orchestrator

## 핵심 목표

**plans/phase{NN}/ 의 todo.md 까지 채워진 phase 의 구현이 끝난 직후** 에 호출. 코드를 리팩토링하지 않고, review.md 도 자동 저장하지 않는다. 두 에이전트가 병렬로 분석하고, 메인이 통합해서 사용자에게 초안을 보여준다. 사용자 승인 후에만 `plans/phase{NN}/review.md` 로 머지.

핵심 원칙: **모드 A — 보고서만, 자동 적용 X**.

## 트리거 vs 비트리거

**트리거**: "phase 29 끝났어 리뷰해줘", "phase 마무리", "리팩토링/qa 돌려줘", "review.md 작성", "phase 완료 체크". 후속 — "다시 검토", "리팩토링만 다시".

**비트리거**: 새 phase 의 plan.md 작성 (planning 단계 — 별도 작업), 단일 파일 리팩토링 ("이 함수 좀 정리해줘" — 직접 Edit), 기존 review.md 의 한 줄 수정 (직접 Edit), 코드베이스 전체 dead code 감사 (별도 하네스 후보).

## Phase 0: 컨텍스트 확인

오케스트레이터 시작 시 다음을 결정한다.

1. **대상 phase 번호 확인**
   - 사용자 발화에서 추출 ("phase 29")
   - 미명시면 → `git status` 의 변경 영역과 plans/ 최신 폴더로 추정 + 사용자에게 확인 요청
2. **이전 산출물 확인**
   - `_workspace/phase-review/{phase}-{refactor,qa}.md` 존재 여부
   - 사용자 부분 수정 요청 ("리팩토링만 다시") → 해당 에이전트만 재호출
   - 사용자 새 입력 (전체 다시) → 기존 `_workspace/phase-review/` 를 `_workspace_prev/phase-review/` 로 이동 후 새 실행
   - 미존재 → 초기 실행
3. **base SHA 결정**
   - phase 작업이 시작된 시점의 커밋. 일반적으로 직전 phase 의 마지막 커밋 또는 phase 의 plan.md 가 추가된 커밋의 부모.
   - 추정 후 사용자에게 확인 요청 (한 줄: "base SHA 를 `<sha>` 로 잡고 진행할게요. 다른 base 라면 알려주세요.")
4. **옵션 확인**
   - e2e/live 테스트 포함 여부 (기본 X)
   - QA 검증 끼우는 시점 — 빌드/타입/유닛/스토리지 항상, 나머지는 사용자 옵션

## Phase 1: 입력 수집

다음 파일을 메인에서 읽어 두 에이전트의 공통 입력으로 준비한다.

- `plans/phase{NN}/plan.md`
- `plans/phase{NN}/todo.md` (없으면 plan.md 만)
- `git diff <base>...HEAD` 의 변경 파일 목록 + 통계 (LOC)
- `pnpm-workspace.yaml`, `tsconfig.json` (refactor 의존 그래프 분석용)

todo.md 가 없으면 사용자에게 알리고 진행 (정밀도 낮음 명시).

## Phase 2: 병렬 분석 (에이전트 팀 모드)

**실행 모드: 에이전트 팀**

`TeamCreate` 로 2 명 팀 구성:

- `phase-refactor-expert` (general-purpose, model: opus)
- `phase-qa-engineer` (general-purpose, model: opus)

`TaskCreate` 로 작업 할당:

- task A: refactor 분석 → `_workspace/phase-review/{phase}-refactor.md`
- task B: QA 검증 → `_workspace/phase-review/{phase}-qa.md`

두 에이전트는 SendMessage 로 cross-validate:

- refactor 가 dead code 후보 발견 → qa 가 `grep -r` + 테스트 import 분석으로 확인
- qa 가 테스트 누락 발견 → refactor 가 해당 함수의 사용 빈도 / 우선순위 평가
- 충돌은 보고서에 양측 입장 병기 (단정 금지)

타임아웃: 한 에이전트가 30분 이상 응답 없으면 SendMessage 로 진행 상황 확인. 1 회 재시도 후 부분 결과로 진행.

## Phase 3: 통합 (메인)

두 에이전트 산출물 + 기존 review.md 포맷 (`references/review-md-template.md`) 을 합쳐 초안 생성:

`_workspace/phase-review/{phase}-review-draft.md`

통합 규칙:

1. **TODO 일치도** (qa 산출물) → review.md `## 1. 구현 사항` 섹션에 그대로 포함
2. **자동화 검증** (qa) → `## 2. 자동화 검증 결과` 신규 섹션
3. **경계면 교차** (qa) → `## 3. 경계면 검증` 신규 섹션
4. **리팩토링 후보** (refactor) → `## 4. 리팩토링 사항 (P0/P1/P2)` 섹션
5. **scope creep / 범위 밖 발견** (refactor) → `## 5. 범위 밖 발견 (참고)` 섹션
6. **위험 신호** (양측) → `## 6. 위험 신호` 신규 섹션 (있을 때만)
7. **다음 phase 후보** (양측 제안) → `## 7. 다음 phase 후보` (있을 때만)

기존 `plans/phase{NN}/review.md` 가 이미 있으면 **덮어쓰지 않고** `_workspace/phase-review/{phase}-review-draft.md` 로만 제출. 사용자가 머지 결정.

## Phase 4: 사용자 승인 + 머지

메인이 사용자에게 보고:

- 초안 위치 (`_workspace/phase-review/{phase}-review-draft.md`)
- 핵심 발견 3-5 줄 요약 (P0 항목, 자동화 실패, 경계면 불일치 위주)
- 머지 옵션 제시:
  - "그대로 `plans/phase{NN}/review.md` 로 저장" → Write
  - "특정 섹션만 수정 후 저장" → 사용자 피드백 받아 부분 재작성
  - "리팩토링/QA 일부 다시" → Phase 2 부분 재실행

사용자 명시 승인 없이는 plans/ 에 쓰지 않는다.

## 데이터 전달 프로토콜

| 전략   | 적용                                                                        |
| ------ | --------------------------------------------------------------------------- |
| 메시지 | refactor ↔ qa cross-validate (SendMessage)                                  |
| 태스크 | TaskCreate / TaskUpdate 로 진행 단계 공유                                   |
| 파일   | `_workspace/phase-review/{phase}-{refactor,qa,review-draft}.md` 약속된 경로 |

`_workspace/phase-review/` 는 한 phase 당 한 set 만 유지. 다음 phase 작업 시 자동 archive 안 함 (사용자가 \_workspace_prev/ 로 이동 결정).

## 에러 핸들링

| 상황                     | 대응                                                               |
| ------------------------ | ------------------------------------------------------------------ |
| todo.md 부재             | plan.md 만으로 진행, "정밀도 제한" 명시                            |
| base SHA 불명            | 직전 phase 마지막 커밋 추정 + 사용자 확인                          |
| typecheck 실패           | qa 가 결과 인용, refactor 는 영향 받지 않고 진행                   |
| 한 에이전트 실패         | 1 회 재시도, 재실패면 부분 결과로 진행 (review-draft 에 누락 명시) |
| 사용자 phase 번호 미명시 | git status + plans/ 로 추정 + 확인 요청                            |
| 기존 review.md 존재      | 덮어쓰기 X, draft 만 제출                                          |

## 팀 크기

2 명 — 작업 규모로는 소규모 (5-10 작업), 가이드라인 권장 (2-3명) 부합.

## 테스트 시나리오

### 정상: phase 29 가 막 구현 완료

1. 사용자: "phase 29 마무리해줘"
2. 메인 — base SHA = phase28 머지 커밋 추정, 사용자 확인 OK
3. plan.md / todo.md / git diff 수집
4. TeamCreate (refactor + qa), 병렬 실행
5. 두 산출물 → review-draft.md 통합
6. 메인이 P0 항목 3개 요약 보고 + 머지 옵션 제시
7. 사용자: "그대로 저장" → `plans/phase29/review.md` Write

### 부분 재실행: 리팩토링만 다시

1. 사용자: "phase 29 리팩토링 다시 봐줘"
2. 메인 — `_workspace/phase-review/29-refactor.md` 존재 확인 → 재실행 모드
3. `phase-refactor-expert` 만 호출 (qa 결과는 재사용)
4. `_workspace/phase-review/29-refactor.md` 갱신 → review-draft 재합성
5. 사용자 승인 후 review.md 머지

### 에러: typecheck 실패

1. qa 가 typecheck FAIL 발견 → SendMessage 로 즉시 메인에 보고
2. 메인이 사용자에게 알림 ("phase 29 가 빌드를 깨뜨렸음 — 머지 보류 권장")
3. 사용자 결정 — 수정 후 재실행 / 그대로 review.md 저장 (위험 신호 명시)

## 참고

- 리팩토링 체크리스트: `references/refactor-criteria.md`
- QA 체크리스트: `references/qa-checklist.md`
- review.md 템플릿: `references/review-md-template.md`
