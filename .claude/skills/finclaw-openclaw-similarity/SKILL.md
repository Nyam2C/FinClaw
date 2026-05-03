---
name: finclaw-openclaw-similarity
description: FinClaw 가 OpenClaw(/mnt/c/Users/박/Desktop/hi/openclaw) 의 핵심 패턴을 얼마나 충실히 모방했는지, 어디가 정당한 단순화이고 어디가 위험한 누락인지를 4축(아키텍처/런타임/메모리/인터페이스) 으로 1:1 매핑 비교하여 한 장의 종합 보고서로 답한다. "OpenClaw 비교", "유사도 검토", "모방 충실도", "OpenClaw 와 얼마나 닮았나", "두 레포 비교", "FinClaw 가 OpenClaw 잘 따라했나", "정당한 단순화 vs 누락", "금융 도메인 합체 품질" 같은 요청 시 반드시 이 스킬을 사용한다. 후속 키워드: "다시 비교", "재비교", "이어서 비교", "특정 영역만 다시 비교", "이전 비교 기반 보완", "비교 보고서 업데이트", "{축} 비교만 다시". 단순 사실 질문(예: "OpenClaw 의 src 안에 뭐가 있어") 은 직접 응답.
---

# FinClaw ↔ OpenClaw Similarity Orchestrator

## 핵심 목표

FinClaw 의 현재 구현이 OpenClaw 의 핵심 패턴을 얼마나 충실히 재현했는지, 그리고 축소·변형이 정당한지를 **단방향 1:1 매핑** (OpenClaw 패턴 → FinClaw 대응) 으로 평가하여 한 장의 종합 보고서로 답한다.

**기존 `finclaw-maturity-audit` 와의 차이:**

- maturity-audit = "현대 AI 비서 표준" 일반 비교 (점수 0-5)
- 본 스킬 = "OpenClaw 라는 특정 레포" 와 1:1 매핑 (라벨 + 유사도 % + 매핑 매트릭스)

두 하네스는 트리거 키워드가 분리되며 독립 실행된다.

## 산출물

- `_workspace/openclaw-similarity/SUMMARY.md` — 사용자가 받는 종합 보고서
- `_workspace/openclaw-similarity/architecture.md` — 모노레포/패키지/빌드 비교
- `_workspace/openclaw-similarity/runtime-tools.md` — Agent/Tool/Skill/Provider 비교
- `_workspace/openclaw-similarity/memory-knowledge.md` — Memory/RAG/Storage 비교
- `_workspace/openclaw-similarity/interface-channels.md` — 채널/Gateway/UI 비교

## 핵심 입력 (모든 comparator 가 사용)

- **OpenClaw 레포**: `/mnt/c/Users/박/Desktop/hi/openclaw`
- **FinClaw 레포**: 현재 작업 디렉토리
- **비교 평가 rubric**: `.claude/skills/finclaw-openclaw-similarity/references/comparison-rubric.md`
- **OpenClaw 모듈 인덱스**: `.claude/skills/finclaw-openclaw-similarity/references/openclaw-pattern-map.md`

## Phase 0: 컨텍스트 확인

워크플로우 시작 시:

1. `_workspace/openclaw-similarity/` 디렉토리 존재 여부 확인
2. 분기:
   - **미존재** → 초기 실행: 4 comparator 모두 신규 작성
   - **존재 + 사용자가 부분 영역만 다시 요청** (예: "메모리 비교만 다시") → 부분 재실행: 해당 영역만 재호출, 나머지 재사용, SUMMARY 갱신
   - **존재 + 사용자가 전체 재실행 요청** → `_workspace/openclaw-similarity/` 를 `_workspace/openclaw-similarity_prev_{YYYYMMDD-HHMM}/` 로 이동 후 신규 실행
   - **존재 + 사용자 피드백** → 해당 영역 comparator 에게 피드백 전달, 개선 모드로 재호출 (이전 산출물 기반으로 수정)
3. **OpenClaw 갱신 확인**: 마지막 실행 이후 OpenClaw 측 코드가 바뀌었는지 `git -C /mnt/c/Users/박/Desktop/hi/openclaw log --since=<이전실행시각> --oneline` 로 확인. 큰 변경이 있으면 사용자에게 통보.

## Phase 1: 사전 정찰 (오케스트레이터가 직접 수행)

4 comparator 를 띄우기 전, 양쪽 레포의 거시 측정값 수집:

```bash
# OpenClaw
find /mnt/c/Users/박/Desktop/hi/openclaw/src -name "*.ts" -not -path "*/node_modules/*" | wc -l
du -sh /mnt/c/Users/박/Desktop/hi/openclaw/{src,extensions,ui,skills,apps,packages}
ls /mnt/c/Users/박/Desktop/hi/openclaw/src | wc -l

# FinClaw
find packages -name "*.ts" -not -path "*/node_modules/*" -not -path "*/dist/*" | wc -l
du -sh packages
ls packages | wc -l
```

이 측정값을 4 comparator 에게 task 메시지에 공유하여 시작 비용 절감.

## Phase 2: 4 comparator 병렬 spawn (서브 에이전트 모드)

**실행 모드: 서브 에이전트 (병렬)** — 4 comparator 를 `Agent` 도구로 동시 spawn.

이유:

- 4 산출물은 서로 독립적이며 사이에 실시간 합의가 거의 불필요
- 합의가 필요한 경계(예: agent 패키지가 아키텍처인지 런타임인지)는 사전에 rubric/pattern-map 에서 정의됨
- 팀 통신 오버헤드 < 병렬 가속 이득
- 병렬 실행으로 사용자 대기 시간 단축

**spawn 파라미터 (각 comparator):**

```
Agent({
  subagent_type: "<auditor-name>",
  model: "opus",
  run_in_background: true,
  description: "OpenClaw vs FinClaw <영역> 비교",
  prompt: <아래 표준 프롬프트>
})
```

`subagent_type` 매핑:

| 영역                    | subagent_type                | 산출물                                                 |
| ----------------------- | ---------------------------- | ------------------------------------------------------ |
| A. Architecture         | `architecture-auditor`       | `_workspace/openclaw-similarity/architecture.md`       |
| B. Runtime & Tools      | `runtime-tools-auditor`      | `_workspace/openclaw-similarity/runtime-tools.md`      |
| C. Memory & Knowledge   | `memory-knowledge-auditor`   | `_workspace/openclaw-similarity/memory-knowledge.md`   |
| D. Interface & Channels | `interface-channels-auditor` | `_workspace/openclaw-similarity/interface-channels.md` |

### 표준 프롬프트 (각 comparator 에 전달, 영역만 치환)

```
**모드: comparison** (OpenClaw ↔ FinClaw 1:1 매핑 비교)
**대상: OpenClaw**
**영역: {Architecture | Runtime & Tools | Memory & Knowledge | Interface & Channels}}

평가 기준은 다음 두 파일에 정의되어 있다. 반드시 먼저 읽고 시작하라:
- `.claude/skills/finclaw-openclaw-similarity/references/comparison-rubric.md` (평가 형식·라벨·점수 산식)
- `.claude/skills/finclaw-openclaw-similarity/references/openclaw-pattern-map.md` (OpenClaw 모듈 인덱스, 본 영역의 시작점)

기존 maturity-audit 의 출력 형식(점수 0-5)이 아니라, comparison-rubric.md 의 매핑 매트릭스 + 5라벨 + 유사도 % 형식을 따른다.

레포 경로:
- OpenClaw: /mnt/c/Users/박/Desktop/hi/openclaw
- FinClaw: 현재 작업 디렉토리

산출물 경로: `_workspace/openclaw-similarity/{영역소문자-슬러그}.md`
- architecture → architecture.md
- runtime & tools → runtime-tools.md
- memory & knowledge → memory-knowledge.md
- interface & channels → interface-channels.md

사전 측정값:
{Phase 1 측정 결과}

작업 원칙:
- OpenClaw 가 source-of-truth (단방향 매핑)
- 양쪽 코드를 직접 읽고 인용 (추측 금지)
- 패턴 카탈로그 10~20 항목 추출 → 라벨링 → 본질성 부여 → 가중 평균 점수
- 의도된 누락 vs 우발 누락은 plans/, README, CLAUDE.md, project_use_case.md 의 명시 근거로 분류
- 금융 도메인 합체는 Diverged 의 강한 형태로 평가

이전 산출물(`_workspace/openclaw-similarity/{슬러그}.md`)이 있으면 읽고 사용자 피드백 기반 개선. 처음부터 다시 쓰지 말 것.
```

## Phase 3: 모니터링 및 부분 합의

- 각 comparator 가 산출물을 파일로 저장하면 background 알림 수신
- 산출물 도착 시 빠르게 스캔하여 명백한 라벨 충돌(같은 모듈에 다른 라벨) 만 점검
- 충돌 발견 시: 해당 두 comparator 를 다시 호출하여 SendMessage 가 아닌 task 메시지로 합의 요청 (서브 에이전트 모드이므로)

## Phase 4: 메인이 직접 SUMMARY 합성

오케스트레이터(메인)가 4 산출물을 읽고 직접 합성한다. 별도 synthesizer 에이전트를 spawn 하지 않는다 (오버헤드 절감).

`_workspace/openclaw-similarity/SUMMARY.md` 구조:

```markdown
# FinClaw ↔ OpenClaw 구현 유사도 종합 보고서

생성: {YYYY-MM-DD HH:mm}
OpenClaw 버전: {package.json version} / 마지막 커밋 {hash}
FinClaw 브랜치: {git branch} / 마지막 커밋 {hash}

## 한 줄 결론

{전체 유사도 X% — "충실 모방 / 정당 단순화 / 도메인 합체" 의 비율 요약 + 위험 신호 N개}

## 통합 유사도 카드

| 영역                    | 유사도 | Faithful | Adapted | Diverged | Missing | Misimpl. |
| ----------------------- | ------ | -------- | ------- | -------- | ------- | -------- |
| A. Architecture         | X%     | n        | n       | n        | n       | n        |
| B. Runtime & Tools      | X%     | n        | n       | n        | n       | n        |
| C. Memory & Knowledge   | X%     | n        | n       | n        | n       | n        |
| D. Interface & Channels | X%     | n        | n       | n        | n       | n        |
| **종합**                | **X%** | N        | N       | N        | N       | N        |

## 잘 모방한 영역 (Top N — Faithful 중 본질성 Critical/Important)

1. **{패턴}** ({영역}) — {OpenClaw → FinClaw 1줄 요약}
2. ...

## 정당한 단순화 (Top N — Adapted 중 본질성 Critical/Important)

1. **{패턴}** ({영역}) — OpenClaw {원형} → FinClaw {축소형}. 정당화: {plans/CLAUDE.md 근거}
2. ...

## 의도적 차별화 (Diverged — 금융 도메인 합체 등)

1. **{패턴}** ({영역}) — {차별화의 설계 의도}
2. ...

## 위험 신호: 누락된 핵심 (Missing 중 본질성 Critical, 우발/근거 부족)

| 우선순위 | 패턴 | 영역 | OpenClaw 의 가치 | FinClaw 위험 | 보완 추정 작업량 |
| -------- | ---- | ---- | ---------------- | ------------ | ---------------- |
| ...      |

## 오해 / 잘못 모방 (Misimplemented)

| 패턴 | 영역 | OpenClaw 의 의도 | FinClaw 의 현재 동작 | 수정 방향 |

## 금융 도메인 통합 품질

- 통합 지점: {transactions, portfolio, market alerts, news, ...}
- OpenClaw 의 generic 도메인 패턴을 깼는가, 확장했는가?
- 평가: {등급} — {근거}

## 거시 측정값 비교

| 메트릭              | OpenClaw | FinClaw | 비율 |
| ------------------- | -------- | ------- | ---- |
| TS 파일 수          | ...      | ...     | ...  |
| 핵심 src LOC        | ...      | ...     | ...  |
| 모듈 수             | ...      | ...     | ...  |
| 채널 수             | ...      | ...     | ...  |
| 프로바이더 수       | ...      | ...     | ...  |
| 외부 도메인 스킬 수 | ...      | ...     | ...  |

## 결론과 권고

- **잘한 점**: {3줄}
- **즉시 보완 권장**: {Critical missing top 3 — Phase 29/30 후보}
- **두고 봐도 되는 갭**: {Adapted/Diverged — 사용자 1인 제약 고려}
- **금융 도메인 통합의 다음 단계**: {권고}

## 부록: 4개 세부 보고서

- [Architecture](architecture.md)
- [Runtime & Tools](runtime-tools.md)
- [Memory & Knowledge](memory-knowledge.md)
- [Interface & Channels](interface-channels.md)
```

작성 후 사용자에게 핵심 결과(한 줄 결론 + 통합 카드 + 위험 신호 + 결론) 를 채팅에 직접 요약해 보고. SUMMARY.md 의 전체 본문은 파일로 보관.

## Phase 5: 사용자 피드백 수렴

SUMMARY 보고 후 사용자에게 묻는다:

- "라벨링이나 점수에 이의가 있나요?"
- "특정 영역을 더 깊이 보고 싶나요?"
- "위험 신호 중 즉시 보완할 것을 plans/phase29 로 만들까요?"

피드백은:

- 라벨 변경 → 해당 comparator 재호출 (Phase 2 부분 재실행)
- 깊이 추가 → 해당 영역만 재호출
- plans 작성 → 별도 Phase 26-orchestrator 또는 직접 plans/ 작성

## 에러 핸들링

- comparator 1회 실패 → 1회 재시도. 2회 실패 → 해당 영역을 "비교 미완" 으로 표시하고 SUMMARY 에 명시.
- OpenClaw 측 파일을 읽지 못함(권한, 경로) → 사용자에게 즉시 보고 후 작업 중단.
- 라벨 충돌 → SUMMARY 에 "Disputed" 로 표기하고 양쪽 의견 병기.
- 측정 명령 실패 → 비고에 "측정 불가" 명시 후 정성 평가만 사용.

## 테스트 시나리오

### 정상 흐름

1. 사용자: "OpenClaw 와 FinClaw 비교해줘"
2. 본 스킬 트리거
3. Phase 0: `_workspace/openclaw-similarity/` 미존재 확인 → 신규 실행
4. Phase 1: 양쪽 거시 측정 (TS 파일 수, LOC, 모듈 수)
5. Phase 2: 4 comparator 병렬 spawn (background)
6. Phase 3: 산출물 4개 도착, 라벨 충돌 1건 발견 → 합의 호출
7. Phase 4: SUMMARY 합성 + 사용자 보고
8. Phase 5: 사용자 피드백 수렴

### 부분 재실행 흐름

1. 사용자: "메모리 비교만 다시 해줘. 자기-편집 메모리 부분이 약해 보여"
2. 본 스킬 트리거 (후속 키워드 매칭)
3. Phase 0: `_workspace/openclaw-similarity/memory-knowledge.md` 존재 확인 → 부분 재실행
4. Phase 2: `memory-knowledge-auditor` 만 spawn, 사용자 피드백 ("자기-편집 메모리 부분 강화") 을 prompt 에 주입, 이전 산출물 읽고 개선 지시
5. Phase 4: SUMMARY 의 Memory 행만 갱신
6. 사용자 보고

### 에러 흐름 (OpenClaw 갱신)

1. 사용자: "비교 다시 해줘"
2. Phase 0: `_workspace/openclaw-similarity/` 존재. OpenClaw 마지막 커밋이 이전 실행 이후 50개 변경됨을 감지
3. 사용자에게 "OpenClaw 가 50 커밋 갱신됨. 전체 재실행 권장. 진행?" 확인
4. 승인 시 `_workspace/openclaw-similarity_prev_{타임스탬프}/` 로 이동, 신규 실행
