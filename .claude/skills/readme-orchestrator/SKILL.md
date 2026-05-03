---
name: readme-orchestrator
description: FinClaw 의 README.md 를 코드 진실에 고정하여 작성·갱신하는 오케스트레이터. 4 explorer(positioner / feature-cataloger / architecture-mapper / ops-documenter)를 병렬 실행 → author 합성 → verifier 검증 → author 수정 → 사용자 승인 후 README.md 반영. "README 작성", "README 갱신", "README 다시 만들어", "README 의 X 섹션만 다시", "이전 README 기반 보완", "재작성", "리드미", "프로젝트 소개 문서" 같은 요청 시 반드시 이 스킬을 사용. 단순한 한 줄 수정(예: 오타)은 직접 편집 가능.
---

# README Orchestrator

FinClaw README.md 를 코드 기반으로 작성/갱신한다. **fan-out → synthesis → verification → synthesis** 패턴, 서브에이전트 모드.

## Phase 0: 컨텍스트 확인

가장 먼저 다음을 확인한다:

1. `_workspace/readme/` 디렉토리 존재?
2. 사용자 요청이 다음 중 어느 것인가:
   - **초기 작성:** \_workspace/readme 비었거나 없음
   - **부분 재실행:** 사용자가 특정 섹션만 다시 (예: "환경변수 섹션만 다시")
   - **새 실행:** 사용자가 새 입력/방향 제공 → 기존 \_workspace 를 `_workspace_prev/` 로 이동
   - **검증 후 수정만:** 02_author_draft.md 가 있고 verifier 만 다시 돌리려는 경우

분기 결과를 한 줄로 사용자에게 보고하고 진행.

## Phase 1: 4 Explorer 병렬 수집

다음 4 서브에이전트를 **단일 메시지에 4 Agent 호출** 로 병렬 실행한다 (`run_in_background: true` + `model: "opus"`):

| 에이전트                   | 산출물                                       |
| -------------------------- | -------------------------------------------- |
| readme-product-positioner  | `_workspace/readme/01_positioner_dossier.md` |
| readme-feature-cataloger   | `_workspace/readme/02_features_catalog.md`   |
| readme-architecture-mapper | `_workspace/readme/03_architecture_map.md`   |
| readme-ops-documenter      | `_workspace/readme/04_ops_manual.md`         |

각 에이전트에게는 다음을 prompt 로 전달:

- 산출물 파일 경로
- 작업 디렉토리: `/mnt/c/Users/박/Desktop/hi/FinClaw`
- "다른 explorer 와 통신 없이 독립 작업" 명시
- 후속 재실행이면 "기존 결과를 baseline 으로 사용" 명시

**부분 재실행 시:** 해당 도메인의 explorer 만 재호출.

## Phase 2: Author 합성

`readme-author` 서브에이전트 1 개 호출 (foreground, `model: "opus"`).

prompt 에 4 dossier 경로를 명시. 산출물: `_workspace/readme/02_author_draft.md`.

## Phase 3: Verifier 검증

`readme-verifier` 서브에이전트 1 개 호출 (foreground, `model: "opus"`).

산출물: `_workspace/readme/05_verifier_report.md`. (번호 02 가 author draft 와 겹치지 않도록 05 사용.)

## Phase 4: Author 수정

verifier report 를 읽고 author 가 필요한 경우 재호출되어 외과적 수정.

산출물: `_workspace/readme/04_author_final.md`.

verifier report 의 "사실 오류" 0 건이면 02_author_draft.md 가 곧 final 이므로 단순 복사.

## Phase 5: 사용자 승인 후 README.md 반영

**중요:** README.md 덮어쓰기는 hard-to-reverse 액션이다. 반드시 다음 절차를 따른다:

1. 04_author_final.md 와 기존 README.md 의 diff 를 사용자에게 요약 보고 (변경된 섹션, 삭제된 섹션, 추가된 섹션 — 각 1 줄).
2. 사용자에게 명시적 승인 요청 ("이대로 README.md 덮어쓸까요?").
3. 승인 시에만 `cp _workspace/readme/04_author_final.md README.md`.
4. `_workspace/readme/` 는 보존 (감사 추적 + 후속 재실행 baseline).

## 데이터 전달 프로토콜

- **반환값:** 서브에이전트 호출 결과는 main 에서 status 만 확인.
- **파일 기반:** 모든 산출물은 `_workspace/readme/{phase}_{role}_{artifact}.md`.
- 메시지 기반/태스크 기반 통신 없음 (서브에이전트 모드).

## 에러 핸들링

| 상황                                 | 처리                                                                                                                                       |
| ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------ |
| explorer 1 개 실패                   | 1 회 재시도 → 재실패 시 author 호출 시 "X dossier 누락" 명시하고 진행, README 에 해당 섹션은 비워두지 않고 author 가 "정보 부족" 으로 표기 |
| verifier 가 사실 오류 5 개 이상 보고 | author 재호출 1 회 → 여전히 5 개 이상이면 사용자 보고 후 진행 여부 결정                                                                    |
| 사용자가 README 덮어쓰기 거부        | \_workspace/readme/04_author_final.md 만 보존하고 종료                                                                                     |
| `_workspace/readme/` 권한 오류       | 즉시 사용자 보고                                                                                                                           |

## 테스트 시나리오

**정상 흐름:**

1. 사용자: "README 다시 작성해"
2. orchestrator: 4 explorer 병렬 실행 → 4 dossier 생성
3. author: draft 작성
4. verifier: 사실 오류 2 건 보고
5. author: 수정 → final
6. orchestrator: diff 요약 → 사용자 승인 → README.md 갱신

**부분 재실행:**

1. 사용자: "README 의 환경변수 섹션만 다시 — `FINCLAW_DB_PATH` 가 변경됐어"
2. orchestrator: ops-documenter 만 재실행
3. author: 04_ops_manual 만 새로 읽고 final 의 해당 섹션만 외과적 수정
4. verifier: 변경된 섹션만 검증
5. 사용자 승인 → README.md 갱신

**에러 흐름:**

1. ops-documenter 가 .env.example 을 못 찾아 실패
2. orchestrator 1 회 재시도
3. 재실패 → author 에 "ops dossier 누락, 기존 README 의 ops 섹션 보존" 지시
4. verifier 가 ops 섹션 검증 skip 표기
5. 사용자에게 ops 부분 미갱신 명시 후 승인 요청
