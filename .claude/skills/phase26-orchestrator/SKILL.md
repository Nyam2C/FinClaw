---
name: phase26-orchestrator
description: FinClaw Phase 26(기억 & 거래 시스템) 작업 전체를 조율하는 오케스트레이터. 밀스톤 A(transactions)→B(MemoryCapture)→C(MemoryRetrieval/RAG)→D(agent_runs)→E(Web UI)의 순서·의존성·incremental QA 를 관리한다. plans/phase26/plan.md 의 작업 진행, "기억 시스템 구현", "transactions 추가", "RAG 주입", "agent.run 저장", "Phase 26 작업", "기억·거래 시스템", 그리고 후속 키워드 "다시 실행/재실행/이어서/밀스톤 X 만 다시/이전 결과 기반/보완/수정" 어느 하나라도 등장하면 반드시 이 스킬을 사용할 것. feature/memory-and-transactions 브랜치의 작업도 본 스킬 트리거.
---

# phase26-orchestrator

Phase 26 (`plans/phase26/plan.md`) 의 5개 밀스톤을 에이전트 팀으로 진행한다. 핵심 가치는 **비서의 기억 시스템**.

## Phase 0: 컨텍스트 확인 (시작 전 필수)

```
1. plans/phase26/plan.md 가 존재하는지 확인
2. _workspace/ 디렉토리 상태 확인:
   - 미존재 → 초기 실행 (Phase 1 부터 정상 진행)
   - 존재 + 사용자가 부분 수정 요청 → 부분 재실행 (해당 밀스톤 에이전트만 재호출, _workspace 유지)
   - 존재 + 사용자가 새 입력 제공 → 새 실행 (_workspace 를 _workspace_prev/ 로 이동 후 진행)
3. .claude/agents/ 의 6개 에이전트 정의 파일 존재 확인
4. 현재 git 브랜치 확인 (feature/memory-and-transactions 권장)
5. 사용자에게 진행 모드 보고 + 1초 대기 (사용자가 "그대로" 말하면 즉시 진행)
```

## Phase 1: 팀 구성

**실행 모드:** 에이전트 팀 (고정 전문가 풀)

```
TeamCreate(team_name="phase26-memory-team", members=[
  schema-architect, rpc-engineer, pipeline-engineer,
  rag-engineer, ui-engineer, qa-engineer
])
```

각 Agent 호출 시 반드시 `model: "opus"` 명시.

각 에이전트는 `.claude/agents/{name}.md` 정의를 참조. 빌트인 타입은 모두 `general-purpose`.

## Phase 2: 밀스톤 진행 (직렬 의존: A → B → C → D → E)

### 밀스톤 A — transactions 테이블 & CRUD

**리드:** schema-architect → rpc-engineer
**스킬:** finclaw-schema-migration, finclaw-rpc-design

1. schema-architect: v4 마이그레이션 + transactions 테이블 + recomputeHoldings + 기존 holdings → synthetic transaction 변환
2. rpc-engineer: finance.transaction.{add,list,update,delete} + portfolio.get 응답에 recentTransactions 추가 + portfolio.changed broadcast
3. qa-engineer (incremental): 마이그레이션 시뮬레이션 + weighted avg 정확도 + RPC ↔ storage shape

**산출물:** `_workspace/01_milestone_A_summary.md`
**진입 조건 다음 밀스톤:** qa-engineer 통과 보고

### 밀스톤 B — 기억 저장 파이프라인

**리드:** pipeline-engineer (보조: schema-architect 의 memories 테이블)
**스킬:** finclaw-pipeline-stage

1. pipeline-engineer: MemoryCaptureStage 신설 (정규식 5종) + pipeline-context 에 MemoryService 주입 + Deliver 꼬리표
2. rpc-engineer (병렬): memory.{list,delete,search} RPC (Settings UI 가 사용)
3. qa-engineer: 정규식 5종 capture + 중복 hash skip + 임베딩 장애 fallback

**산출물:** `_workspace/02_milestone_B_summary.md`

### 밀스톤 C — RAG 주입 파이프라인

**리드:** rag-engineer (배선: pipeline-engineer)
**스킬:** finclaw-rag-injection, finclaw-pipeline-stage

1. rag-engineer: searchRelevantMemories 알고리즘 (임계값 0.65 / 신선도 / 상한 3 / 심볼 추출 / 감사 로그)
2. pipeline-engineer: MemoryRetrievalStage 배선 (Context 직후)
3. rag-engineer: system prompt "사용자 배경지식" 섹션 빌더 → finance-context 또는 등가에 통합
4. qa-engineer: 임계값 컷 / 신선도 / 심볼 거래 동시 주입 / 빈 결과 시 섹션 생략

**산출물:** `_workspace/03_milestone_C_summary.md`

### 밀스톤 D — agent.run 결과 저장 & RAG 통합

**리드:** schema-architect → rag-engineer → rpc-engineer
**스킬:** finclaw-schema-migration (agent_runs 테이블), finclaw-rag-injection (memory 훅)

1. schema-architect: agent_runs 테이블 (v4 마이그레이션 안에 포함 또는 v4 보강)
2. rag-engineer: attachMemoryFromAgentRun 훅 (output > 100자 + 오류 없음 → memories 저장)
3. rpc-engineer: agent.run 핸들러에 훅 호출 + agent.runs.{list,get} RPC + agent-runs.ts 신설
4. qa-engineer: agent.run → agent_runs + memories 양쪽 기록 / 오류 시 memory 미저장 / RAG 검색에서 financial 매칭

**산출물:** `_workspace/04_milestone_D_summary.md`

### 밀스톤 E — Web UI 확장

**리드:** ui-engineer
**스킬:** finclaw-rpc-design (참조)

1. ui-engineer: portfolio-view 거래 이력 탭 + transaction-form 모달 + portfolio.changed 자동 갱신
2. ui-engineer: settings-view 재작성 (기억 목록 + 에이전트 실행 이력 + 라우팅 통계 placeholder)
3. ui-engineer: app-gateway 에 신규 RPC 래퍼
4. qa-engineer: e2e — 외부 RPC 거래 추가 → UI 자동 갱신, 기억 삭제 → DB+벡터 인덱스 동시 제거

**산출물:** `_workspace/05_milestone_E_summary.md`

## Phase 3: 통합 검증 (밀스톤 E 후)

`plan.md` 의 "전체 시나리오 수동 검증" 6항목을 qa-engineer 가 e2e 로 자동화:

1. transaction.add → Portfolio 뷰 반영
2. !finclaw remember → memories 저장
3. "내 선호가 뭐였지?" → preference 주입
4. agent.run AAPL 분석 → 결과 저장
5. 다음 대화 "저번 AAPL 분석 요약" → RAG 주입
6. Settings 기억 삭제 → 검색에서 제외

**완료 조건 (plan.md):**

- 5개 밀스톤 완료
- `pnpm test` 전체 통과
- `tsgo --noEmit` 통과
- `pnpm lint` 통과
- 감사 로그에서 주입 기억 id 추적 가능

## Phase 4: 사용자 피드백 수집

E2E 시나리오 통과 후 사용자에게:

- "결과에서 개선할 부분이 있나요?"
- "에이전트 팀 구성이나 워크플로우에서 바꾸고 싶은 점이 있나요?"

피드백 → 진화 (Phase 5).

## Phase 5: 진화 (피드백 기반)

피드백 유형 → 수정 대상:

- 결과물 품질 → 해당 에이전트의 스킬 (finclaw-\*.md)
- 에이전트 역할 → `.claude/agents/{name}.md`
- 워크플로우 순서 → 본 스킬 (orchestrator)
- 트리거 누락 → 본 스킬의 description

모든 변경은 `CLAUDE.md` 의 "## 하네스: Phase 26" 섹션 변경 이력에 기록.

## 데이터 전달 프로토콜

| 전략                               | 사용처                                               |
| ---------------------------------- | ---------------------------------------------------- | ------------------------------- |
| 메시지 (`SendMessage`)             | 팀원 간 실시간 합의 (스키마 결정 → RPC 응답 합의 등) |
| 태스크 (`TaskCreate`/`TaskUpdate`) | 밀스톤 작업 단위, 의존성 (`addBlockedBy`), QA 위임   |
| 파일 (`_workspace/{NN}_{milestone  | agent}\_\*.md`)                                      | 밀스톤 산출물, 다음 밀스톤 입력 |
| 코드 (실제 파일 변경)              | 최종 산출물                                          |

`_workspace/` 명명 규칙: `01_milestone_A_summary.md`, `01_schema-architect_migration.md`, `02_milestone_B_summary.md`, ...

## 에러 핸들링

- 에이전트 작업 1회 실패 → 재시도 1회 → 그래도 실패면 해당 결과 없이 다음 밀스톤 보고서에 누락 명시
- 상충 데이터(예: 두 에이전트가 다른 RPC 시그니처 제안) → 삭제 X, 본 스킬이 사용자에게 결정 요청
- 마이그레이션 실패 → 즉시 중단, schema-architect 에게 통보 + 사용자 보고 (데이터 손실 위험)
- qa-engineer 가 결함 발견 → 해당 밀스톤 차단 (다음 밀스톤 진입 X)

## 후속 작업 키워드 (재실행 트리거)

다음 키워드가 등장하면 본 스킬이 트리거되어야 함:

- "Phase 26", "phase26", "phase 26"
- "기억 시스템", "기억·거래", "memory & transactions"
- "transactions 추가", "거래 이력 추가"
- "RAG 주입", "사용자 배경지식 주입"
- "agent.run 저장", "agent_runs"
- "feature/memory-and-transactions" 브랜치 작업
- 후속: "다시 실행", "재실행", "이어서", "밀스톤 X 만 다시", "이전 결과 기반", "보완", "수정"
- 부분 재실행: "밀스톤 A 만", "RPC 만 다시", "테스트 다시"

## 테스트 시나리오

### 정상 흐름

입력: "Phase 26 진행하자"

1. Phase 0 컨텍스트 확인 → 초기 실행
2. Phase 1 팀 구성 (6명)
3. 밀스톤 A → B → C → D → E 순차 진행, 각 밀스톤마다 QA
4. Phase 3 통합 검증
5. Phase 4 피드백 수집
6. CLAUDE.md 변경 이력 갱신 (필요 시)

### 에러 흐름 (마이그레이션 실패)

입력: "Phase 26 진행"

1. 밀스톤 A 의 schema-architect 작업 중 v3→v4 마이그레이션 SQL 오류
2. 자동 재시도 1회, 동일 실패
3. 본 스킬이 즉시 중단, 사용자에게 보고:
   - 실패 지점, 에러 메시지, schema-architect 의 가설, 추천 대응 (수동 수정/롤백/포기)
4. 사용자 결정 대기, B/C/D/E 진입 X

### 부분 재실행 흐름

입력: "밀스톤 C 의 임계값을 0.7 로 올려서 다시"

1. Phase 0 에서 \_workspace/ 존재 + 부분 수정 요청 감지
2. rag-engineer 만 재호출, 다른 에이전트 X
3. qa-engineer 가 C 시나리오만 재검증
4. CLAUDE.md 변경 이력에 "임계값 0.65 → 0.7 튜닝" 기록

## CLAUDE.md 4원칙 강제

각 에이전트는 작업 전 본 4원칙을 한 번 읊는다 (반복적 자기점검):

1. 코딩 전에 생각 — 추측 금지, 가정 명시, 불명확 시 멈춤
2. 단순함 — 추측성 코드/유연성/에러 처리 최소
3. 외과적 변경 — 인접 코드 "개선" 금지, 변경된 모든 줄은 사용자 요청에 직접 연결
4. 목표 기반 — 검증 가능한 성공 기준 정의

## 참고

- `plans/phase26/plan.md` — 작업 명세
- `.claude/agents/*.md` — 6개 에이전트 정의
- `.claude/skills/finclaw-*.md` — 5개 전문가 스킬
- `MEMORY.md` — 사용자 제약 (mock-only 테스트, ASCII commit subject 등)
- `CLAUDE.md` — 4원칙 + 하네스 변경 이력
