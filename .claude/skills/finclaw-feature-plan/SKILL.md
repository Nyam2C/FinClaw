---
name: finclaw-feature-plan
description: FinClaw 에 새 기능/외부 데이터소스를 붙이기 전, 외부 git/OSS 프로젝트를 리서치·비교하고 그 근거 위에 plans/phaseNN/{kickoff,plan}.md 초안을 작성하는 "리서치-설계" 하네스. finclaw-phase-execute 의 상류 빈자리(= plan.md 를 *만드는* 단계)를 메운다. 4단계 — (1) integration-analyst 가 FinClaw 코드를 읽어 통합 계약 작성 (2) oss-research-scout 다수가 레인별로 git/web 을 병렬 조사 (3) feature-comparison-synthesizer 가 비교 매트릭스 + 추천 → 사용자 검토 (4) feature-phase-plan-author 가 집 양식으로 kickoff+plan 초안 → 사용자 승인. "기능 리서치", "이 기능 어떻게 구현하지", "git 에서 찾아서 비교", "외부 라이브러리/MCP 조사", "새 데이터소스 통합 계획", "phase 계획 만들어줘", "plan.md 초안", "X/트위터 연동 조사" 같은 요청 시 반드시 이 스킬을 사용한다. 후속 키워드: "다시 조사", "재조사", "추천만 다시", "특정 레인만 다시", "비교 보완", "plan 초안만 다시", "이전 리서치 기반 보완". 비트리거: plan.md 가 이미 있어 구현만 하면 됨(→ finclaw-phase-execute), 단순 사실 질문(직접 응답), 단일 라이브러리 1회 검색(직접 WebSearch).
---

# FinClaw Feature Plan Orchestrator (리서치 → phase 계획)

## 핵심 목표

"이 기능 어떻게 만들지?" 에서 시작해 **외부 OSS 비교 근거 → 실행 가능한 phase 계획 초안**까지 자동으로 잇는다. 산출물(`plans/phaseNN/{kickoff,plan}.md`)은 곧바로 `finclaw-phase-execute` 가 todo 로 분해할 수 있는 형태다.

안전 게이트 두 곳:

1. synthesizer 의 **추천 보고서**가 나온 직후 → 사용자 검토(방향 확정)
2. plan-author 의 **plan 초안**이 저장된 직후 → 사용자 승인(머지/구현 착수 결정)

코드는 만들지 않는다. 이 하네스의 출력은 _문서_ 다.

## 트리거 vs 비트리거

**트리거**: "X 연동 어떻게 구현할지 git 찾아보고 계획 세워줘", "새 데이터소스 붙이는 phase 계획 만들어줘", "이 기능 외부 라이브러리 비교해서 plan 초안". 후속 — "추천만 다시", "scout 레인 X만 다시", "plan 초안만 다시".

**비트리거**:

- `plan.md` 가 이미 있고 구현만 → `finclaw-phase-execute`
- 단순 사실 질문("snscrape 살아있어?") → 직접 WebSearch 1회
- 단일 파일 수정 → 직접 Edit

## 실행 모드 — 서브 에이전트 (fan-out → 순차 파이프라인), 파일 기반 핸드오프

에이전트 팀(SendMessage 자체 조율) 대신 **서브 에이전트 + 파일 핸드오프**를 쓴다. 근거: 리서치 레인은 서로 독립적이라 조사 도중 상호 통신이 품질을 높이지 않고(팬아웃/팬인), analyst→scout→synthesizer→author 는 엄격한 순차 의존(파이프라인)이며 각 단계가 앞 단계의 *파일*을 소비한다. 팀 통신 오버헤드가 이득 없음. 단, scout 단계는 `run_in_background: true` 로 **병렬 fan-out**.

모든 `Agent` 호출은 `model: "opus"`. 빌트인 타입 `general-purpose` 사용(코드 읽기 + WebSearch/WebFetch + 파일 쓰기 필요).

## Phase 0: 컨텍스트 확인

1. **feature slug 결정** — 기능에서 짧은 kebab slug 추출(예: `x-fintwit`). 작업 디렉토리는 `_workspace/feature-research/{slug}/`.
2. **대상 phase 번호 결정** — `plans/` 최신 번호 +1 을 기본 추정. **단, 최신 plan 이 다음 번호를 예약했는지 확인**(예: phase40 plan 이 "phase41 = SDK 제거" 라고 적어둠) → 충돌 시 사용자에게 "이 기능을 phase{N} 으로 할지, 예약된 작업 뒤 phase{N+1} 으로 할지" 확인. 번호 미확정이면 plan-author 를 호출하지 않는다.
3. **이전 산출물 확인** — `_workspace/feature-research/{slug}/` 존재 여부:
   - 미존재 → 초기 실행
   - 존재 + 부분 수정 요청("추천만 다시", "레인 X만") → 해당 단계만 재호출
   - 존재 + 전체 재실행 → 기존 폴더를 `_workspace_prev/feature-research/{slug}/` 로 이동 후 새로
4. **base SHA / branch 확인** — 현재 main HEAD 를 plan 의 base 로. 현재 브랜치가 main 이면 plan 저장은 OK(문서 초안)이나, 구현은 별도 브랜치 권장임을 핸드오프에 명시.
5. **입력 정리** — 사용자에게 받은 제약(리스크 선호·정보 범위)을 한 곳에 적어 analyst/scout 에 전달.

## Phase 1: 통합 컨텍스트 (analyst, 서브)

`Agent`(general-purpose, opus)로 `finclaw-integration-analyst` 호출. 프롬프트에 "`.claude/agents/finclaw-integration-analyst.md` 를 읽고 그 역할로 동작하라" + 기능 설명 + 제약 + slug 전달.

- 출력: `_workspace/feature-research/{slug}/00-integration-contract.md`
- 이 파일이 나오기 전엔 scout 를 띄우지 않는다(평가 기준이 됨).

## Phase 2: 외부 리서치 fan-out (scout ×N, 서브 병렬)

`00-integration-contract.md` §5(평가 기준)와 정보 범위로 **레인 분할**(`references/research-rubric.md` 의 레인 분류 참조). 각 레인마다 `oss-research-scout` 를 `run_in_background: true` 로 병렬 spawn.

- 레인 예시(이번 X 도메인): ① X 무인증 접근 라이브러리, ② 기성 X/소셜 MCP 서버, ③ cashtag·감성 OSS, ④ FinTwit 계정 피드 / StockTwits 등 제3자.
- 각 출력: `_workspace/feature-research/{slug}/10-scout-{lane}.md`
- 모든 scout 종료까지 대기(백그라운드 완료 알림). 하나라도 빈약하면 쿼리 보강 재호출 1회.

## Phase 3: 비교·추천 (synthesizer, 서브) + 게이트 1

`feature-comparison-synthesizer` 호출 → `_workspace/feature-research/{slug}/20-comparison-and-recommendation.md`.

**게이트 1 — 사용자 검토:** 메인이 한 줄 결론 + 매트릭스 핵심 + 추천 아키텍처(A/B/C) + 최대 리스크 + plan 미결 항목 수를 보고. 사용자 옵션:

- "이 방향으로 plan 작성" → Phase 4
- "추천 바꿔/특정 레인 재조사" → 해당 단계 재호출 후 다시 게이트 1
- "여기까지 (보고서만)" → 종료

## Phase 4: 계획 작성 (plan-author, 서브) + 게이트 2

phase 번호 확정 상태에서 `feature-phase-plan-author` 호출 → `plans/phase{NN}/kickoff.md` + `plan.md` 초안(헤더에 "초안 — 승인 대기").

**게이트 2 — 사용자 승인:** 메인이 마일스톤 요약·go/no-go 항목·스코프 OUT 을 보고. 사용자:

- "승인" → 초안 헤더의 "승인 대기" 유지 여부는 사용자 결정(보통 사용자가 직접 다듬어 확정). 핸드오프 안내(Phase 5).
- "수정" → 해당 섹션만 plan-author 재호출.

## Phase 5: 핸드오프

승인 후 메인이 안내: "`plans/phase{NN}/plan.md` 준비됨. 구현은 `finclaw-phase-execute` 로 `phase {NN} 시작` 하면 todo 분해 → 코드 → review 로 이어집니다. 별도 feature 브랜치 권장." **자동으로 finclaw-phase-execute 를 호출하지 않는다** — plan 승인과 구현 착수는 분리.

## 데이터 전달 프로토콜

| 전략   | 적용                                                                                                                     |
| ------ | ------------------------------------------------------------------------------------------------------------------------ |
| 파일   | `_workspace/feature-research/{slug}/{00-contract,10-scout-*,20-comparison}.md`, 최종 `plans/phase{NN}/{kickoff,plan}.md` |
| 반환값 | 각 서브 에이전트 종료 메시지(핵심 요약) — 메인이 게이트 보고에 사용                                                      |
| 태스크 | scout fan-out 시 레인별 TaskCreate/Update 로 진행 추적(선택)                                                             |

중간 산출물(`_workspace/feature-research/`)은 보존 — 사후 감사·후속 재실행용.

## 에러 핸들링

| 상황                           | 대응                                                                               |
| ------------------------------ | ---------------------------------------------------------------------------------- |
| analyst 가 핵심 파일 못 찾음   | grep 재시도 지시, 그래도 없으면 "추정" 표기하고 진행(은폐 금지)                    |
| scout 레인 결과 빈약           | 쿼리 보강 1회 재호출, 그래도 없으면 "유지 OSS 없음" 결론 + synthesizer 신뢰도 하향 |
| 모든 후보가 계약 미통과        | synthesizer 가 "직접 구현 범위 + 비용" 으로 결론, plan 이 그걸 마일스톤화          |
| phase 번호 미확정              | plan-author 호출 보류, 사용자에게 번호 확인                                        |
| phase 번호가 예약과 충돌       | 사용자 확인(이 기능 vs 예약 작업 우선순위)                                         |
| 사용자 리스크 선호와 추천 충돌 | synthesizer 가 선호 우선하되 리스크 명시, 충돌을 게이트 1에서 보고                 |
| 상충 조사 결과(scout 간)       | 삭제 금지 — synthesizer 가 둘 다 병기, 근거 강한 쪽 추천                           |

## 팀 크기

서브 에이전트 모드 — analyst 1, scout N(레인 수, 보통 3~4), synthesizer 1, author 1. 본 오케스트레이터는 팀을 만들지 않는다(순차 파이프라인 + fan-out 에 팀 통신 불필요).

## 테스트 시나리오

### 정상: X/FinTwit 통합 계획

1. 사용자: "X 에서 보유종목 감성 받아오는 거 git 찾아보고 phase 계획 세워줘"
2. 메인 — slug `x-fintwit`, 최신 plans=phase40(phase41 예약됨) → 번호 사용자 확인
3. analyst → `00-integration-contract.md` (MCP 호스트·ToolRegistry·불변식·도구 표면)
4. scout ×4 병렬 → `10-scout-*.md`
5. synthesizer → `20-comparison-and-recommendation.md`, 게이트 1 보고
6. 사용자: "C 아키텍처로 plan" → plan-author → `plans/phase{NN}/{kickoff,plan}.md` 초안
7. 게이트 2 → 사용자 승인 → 핸드오프 안내

### 부분 재실행: 추천만 다시

1. 사용자: "scout 결과는 두고 추천만 다시 해줘"
2. 메인 — `10-scout-*.md` 존재 확인, synthesizer 만 재호출, 게이트 1

### 에러: 한 레인에 유지 OSS 없음

1. scout(기성 X-MCP 레인) 가 "유지되는 OSS 없음" 결론
2. synthesizer 가 해당 경로 신뢰도 하향, 다른 레인 추천으로 수렴
3. 게이트 1 에서 "이 레인은 비었음" 명시 보고

## 참고

- 리서치 레인 분류 + scout 평가 기준: `references/research-rubric.md`
- FinClaw plan/kickoff 집 양식: `references/finclaw-plan-house-style.md`
- 하류 연결: `.claude/skills/finclaw-phase-execute/SKILL.md`
