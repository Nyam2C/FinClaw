---
name: finclaw-maturity-audit
description: FinClaw 의 구현 규모·아키텍처가 현대 AI 비서(Claude.ai, ChatGPT, Letta/MemGPT, Hermes, OpenDevin, MCP 표준) 수준에 도달했는지 종합 감사한다. "성숙도 감사", "현대 AI 비서 수준 평가", "FinClaw 가 OpenClaw/헤르메스 같은 비서급인가", "부족한 점 분석", "갭 분석", "아키텍처 감사", "에이전트 시스템 평가", "기능 비교 매트릭스" 같은 요청 시 반드시 이 스킬을 사용한다. 후속 키워드: "다시 감사", "재평가", "이어서 감사", "특정 영역만 다시", "이전 감사 기반 보완", "보고서 업데이트". 단순 사실 질문(예: "패키지가 몇 개야") 은 직접 응답.
---

# FinClaw Maturity Audit Orchestrator

## 핵심 목표

FinClaw 의 현재 구현이 현대 AI 비서 표준에 비해 어디에 있고, 무엇이 부족한지 한 장의 종합 보고서로 답한다. 사용자는 본인 1명, ML 학습 인프라(fine-tuning/RLHF)는 비대상이지만 **사용자 본인의 학습 동기는 인정** 한다는 제약을 반영한다.

## 산출물

- `_workspace/audit/SUMMARY.md` — 사용자가 받는 단일 종합 보고서
- `_workspace/audit/architecture.md` — Architecture audit 세부
- `_workspace/audit/runtime-tools.md` — Runtime & Tools 세부
- `_workspace/audit/memory-knowledge.md` — Memory & Knowledge 세부
- `_workspace/audit/interface-channels.md` — Interface & Channels 세부

## Phase 0: 컨텍스트 확인

워크플로우 시작 시:

1. `_workspace/audit/` 디렉토리 존재 여부 확인
2. 분기:
   - **미존재** → 초기 실행: 4 audit 모두 신규 작성
   - **존재 + 사용자가 부분 영역만 다시 요청** → 부분 재실행: 해당 audit 만 재호출, 나머지는 재사용, SUMMARY 갱신
   - **존재 + 사용자가 전체 재실행 요청** → `_workspace/audit/` 를 `_workspace/audit_prev_{타임스탬프}/` 로 이동 후 신규 실행
   - **존재 + 사용자 피드백** → 해당 영역 audit 에이전트에게 피드백 전달, 개선 모드로 재호출

## Phase 1: 도메인 사전 점검 (오케스트레이터가 수행)

5인 팀을 띄우기 전, 가벼운 사전 정찰:

- `git log --oneline -30` 으로 최근 phase 진행 확인
- `find packages -name "package.json" -not -path "*/node_modules/*"` 로 패키지 수 측정
- `wc -l packages/*/src/**/*.ts 2>/dev/null` 로 LOC 대략 측정 (선택)
- `ls plans/phase*/plan.md 2>/dev/null | wc -l` 로 phase 수 확인

이 측정값을 팀에게 SendMessage 로 공유하여 audit 효율을 높인다.

## Phase 2: 팀 구성 및 작업 분배

**실행 모드: 에이전트 팀** — 4 specialist + 1 lead synthesizer.

```
TeamCreate(team_name="finclaw-maturity-audit", description="FinClaw 현대 AI 비서 성숙도 감사")
```

오케스트레이터(이 스킬을 호출한 메인)가 직접 lead synthesizer 역할을 수행하거나, `maturity-synthesizer` 에이전트를 lead 로 spawn 한다. 본 프로젝트에서는 **메인이 직접 lead** 가 되어 4명의 specialist 만 spawn 한다 (오버헤드 절감).

### 작업 카탈로그 (TaskCreate 로 4개 등록)

| ID  | 제목                       | owner                      | 산출물                                   |
| --- | -------------------------- | -------------------------- | ---------------------------------------- |
| A   | Architecture audit         | architecture-auditor       | `_workspace/audit/architecture.md`       |
| B   | Runtime & Tools audit      | runtime-tools-auditor      | `_workspace/audit/runtime-tools.md`      |
| C   | Memory & Knowledge audit   | memory-knowledge-auditor   | `_workspace/audit/memory-knowledge.md`   |
| D   | Interface & Channels audit | interface-channels-auditor | `_workspace/audit/interface-channels.md` |

작업은 **모두 병렬로 시작**한다 (의존 관계 없음). Agent 호출 시 반드시 `model: "opus"` + `subagent_type: <agent name>`.

### 각 에이전트에 보낼 공통 컨텍스트

```
- rubric 위치: /.claude/skills/finclaw-maturity-audit/references/rubric.md
- 산출물 경로: _workspace/audit/{영역}.md
- 사용자 제약:
  * 사용자 1인 전용 (멀티 테넌시/RBAC/SSO 결손 우선순위 ↓)
  * ML 학습 인프라 (fine-tuning/RLHF/online learning) 비대상 — 평가 제외
  * **사용자 학습 동기 인정** — 학습/craftsmanship 가치도 평가 차원에 포함, ROI 계산 시 학습 산출물 가치 가산
  * 감사 가능성·환각 방지·읽기 전용 가중치 ↑
  * 외부 공유 가능성 열려있음 (README/Docker/배포 인프라 결손은 갭으로 인정)
- 스타일: 점수 (0-5) + Critical/Important/Nice-to-have 라벨 + 코드 경로 인용
- 사전 측정값: {Phase 1 결과}
```

## Phase 3: 모니터링 및 중재

- audit 완료 통보를 SendMessage / TaskUpdate 로 받음
- 충돌 발생 시 (예: 패키지 경계 해석 차이) lead 가 SendMessage 로 합의 유도
- 모든 audit 완료 시 Phase 4 로

## Phase 4: 종합 보고서 작성

lead (메인) 가 4개 산출물을 읽고 `_workspace/audit/SUMMARY.md` 작성. 구조는 `agents/maturity-synthesizer.md` 의 템플릿을 따른다.

핵심 요소:

1. **한 줄 결론** — 등급 (Beta / MVP / Production-grade / Industry-leading) + 1문장 요약
2. **통합 점수 카드** — 8개 영역 평균
3. **강점 Top 5**
4. **갭 우선순위** — Critical 순으로 표 (영향, 작업량 추정, 발견 audit, 코드 경로)
5. **현대 비서 비교 매트릭스** — Claude.ai / ChatGPT / Letta / Hermes 류 vs FinClaw
6. **다음 단계 로드맵** — Phase 29 / 30 제안

## Phase 5: 사용자 보고

메인 채팅에서:

- 한 줄 결론 + 점수 카드 (요약본)
- Critical 갭 3개 인용
- 전체 SUMMARY 경로 안내

전체 산출물을 채팅에 dump 하지 않는다. SUMMARY.md 를 보도록 유도.

## Phase 6: 진화

사용자 피드백이 들어오면:

- "이 갭은 의도적이야" → SUMMARY 의 해당 갭에 "intentional" 라벨 추가, 점수 영향 재계산
- "X 영역 더 깊게" → 해당 audit 만 재호출 (개선 모드)
- "비교 대상에 Y 추가" → rubric.md 갱신 후 영향받는 audit 재호출

## 에러 핸들링

- audit 1회 실패 → 재시도 1회 → 그래도 실패 시 SUMMARY 에 "감사 미완 (사유)" 명시
- 측정 명령 실패 → 정성 평가로 대체, "근거 부족" 라벨

## 테스트 시나리오

### 정상 흐름

1. 사용자: "FinClaw 가 현대 AI 비서급인지 감사해"
2. Phase 0: `_workspace/audit/` 미존재 → 초기 실행
3. Phase 1: 사전 측정 (패키지 11, phase 28+, LOC 대략)
4. Phase 2: TeamCreate + 4 audit 병렬 spawn
5. Phase 3: 모두 완료
6. Phase 4: SUMMARY.md 작성
7. Phase 5: 채팅에 요약 + 경로 안내

### 부분 재실행

1. 사용자: "메모리 영역만 다시 봐, 자기-편집 메모리 결손이 critical 이라고 했는데 사실 의도적이야"
2. Phase 0: `_workspace/audit/` 존재 → 부분 재실행
3. memory-knowledge-auditor 만 재호출 + 피드백 전달
4. SUMMARY.md 만 갱신

### 에러 흐름

1. 사용자: "감사해줘"
2. runtime-tools-auditor 가 1회 실패 → 재시도 → 또 실패
3. SUMMARY 에 "Runtime audit 미완: <사유>" 명시
4. 다른 3 영역 결과만으로 부분 SUMMARY 작성, 사용자에게 미완 영역 통보
