---
name: finclaw-openclaw-similarity
description: FinClaw 가 OpenClaw(/mnt/c/Users/박/Desktop/hi/openclaw) 의 핵심 패턴을 얼마나 충실히 모방했는지, 어디가 정당한 단순화이고 어디가 위험한 누락인지를 4축(아키텍처·런타임·메모리·인터페이스) 으로 1:1 매핑 비교(라벨 + 영역 유사도 %) 하여 한 장의 종합 보고서로 답한다. "OpenClaw 비교", "유사도 검토", "모방 충실도", "OpenClaw 와 얼마나 닮았나", "두 레포 비교", "FinClaw 가 OpenClaw 잘 따라했나", "정당한 단순화 vs 누락", "금융 도메인 합체 품질" 같은 요청 시 반드시 이 스킬을 사용한다. 후속 키워드: "다시 비교", "재비교", "이어서 비교", "특정 영역만 다시 비교", "이전 비교 기반 보완", "비교 보고서 업데이트", "{축} 비교만 다시". 단순 사실 질문(예: "OpenClaw 의 src 안에 뭐가 있어") 은 직접 응답.
---

# FinClaw ↔ OpenClaw 1:1 유사도 오케스트레이터

## 핵심 목표

FinClaw 의 현재 구현이 OpenClaw 의 핵심 패턴을 얼마나 충실히 재현했는지, 그리고 축소·변형이 정당한지를 **단방향 1:1 매핑** (OpenClaw 패턴 → FinClaw 대응) 으로 평가하여 한 장의 종합 보고서로 답한다.

**비교 대상:**

- **OpenClaw** (원조, source-of-truth) — `/mnt/c/Users/박/Desktop/hi/openclaw` (3,300+ 파일, 256K LOC, 범용 멀티 채널 AI 플랫폼)
- **FinClaw** (자기, 비교 주체) — 현재 작업 디렉토리 (462 ts, ~56K LOC, 금융 특화)

**비교 안 하는 것:**

- 외부 빅테크 비서 (Claude.ai/ChatGPT/Letta/Hermes) — FinClaw 가 1인 개인 금융 도구 + OpenClaw 학습 산출물이라는 정체성에 부적합한 비교 대상
- 다른 \*claw 변종 (miclaw, picoclaw 등) — 정보 비대칭 (코드 비공개 또는 미클론) 으로 비교 가치 낮음

OpenClaw 가 source-of-truth 단방향이라는 점에 집중. OpenClaw 의 패턴을 추출 → FinClaw 매핑을 찾는 순서로 작업.

## 산출물

- `_workspace/openclaw-similarity/SUMMARY.md` — **사용자가 받는 종합 보고서** (한 줄 결론 + 영역 유사도 + 매핑 매트릭스)
- `_workspace/openclaw-similarity/architecture.md` — 모노레포·패키지·빌드 1:1 비교
- `_workspace/openclaw-similarity/runtime-tools.md` — Agent·Tool·Skill·Provider 1:1 비교
- `_workspace/openclaw-similarity/memory-knowledge.md` — Memory·RAG·Storage 1:1 비교
- `_workspace/openclaw-similarity/interface-channels.md` — Channels·Gateway·UI 1:1 비교

## 핵심 입력 (모든 auditor 가 사용)

- **OpenClaw 레포**: `/mnt/c/Users/박/Desktop/hi/openclaw`
- **FinClaw 레포**: 현재 작업 디렉토리
- **참조 가이드**: `references/comparison-rubric.md` (라벨/유사도 %), `references/openclaw-pattern-map.md` (OpenClaw 모듈 인덱스 4축)

## Phase 0: 컨텍스트 확인

스킬 트리거 시:

1. `_workspace/openclaw-similarity/` 존재 여부 확인
2. `/mnt/c/Users/박/Desktop/hi/openclaw` 접근 가능 확인 (없으면 사용자에게 보고하고 중단)
3. 사용자 요청 유형:
   - **초기 실행**: `_workspace/` 미존재 → 전체 4축 비교
   - **부분 재실행**: "{축} 비교만 다시" → 해당 auditor 만 재호출
   - **새 실행**: "처음부터 다시" → 기존 `_workspace/` 를 `_workspace_prev_{date}/` 로 이동
4. 결정한 모드를 사용자에게 한 줄로 알리고 진행

## Phase 1: 감사 팀 구성

**실행 모드:** 에이전트 팀 (TeamCreate)

5명 팀:

- 4 auditor (병렬): `architecture-auditor`, `runtime-tools-auditor`, `memory-knowledge-auditor`, `interface-channels-auditor`
- 1 신디사이저 (리더): `openclaw-similarity-synthesizer`

```
TeamCreate(team_name: "openclaw-similarity-team", members: [
  architecture-auditor,
  runtime-tools-auditor,
  memory-knowledge-auditor,
  interface-channels-auditor,
  openclaw-similarity-synthesizer  # 리더
])
```

모두 `model: "opus"`.

## Phase 2: 4 auditor 병렬 실행

각 auditor 의 task 메시지에 다음 정보 포함:

- **모드: openclaw-1to1-comparison**
- **비교 형식**: `references/comparison-rubric.md` 의 1:1 매핑 형식
- **모듈 인덱스 시작점**: `references/openclaw-pattern-map.md` 의 해당 축 섹션
- **산출 경로**: `_workspace/openclaw-similarity/{축}.md`

| Task    | 담당                       | 산출                    |
| ------- | -------------------------- | ----------------------- |
| audit-A | architecture-auditor       | `architecture.md`       |
| audit-B | runtime-tools-auditor      | `runtime-tools.md`      |
| audit-C | memory-knowledge-auditor   | `memory-knowledge.md`   |
| audit-D | interface-channels-auditor | `interface-channels.md` |

각 auditor 는 자기 축의 OpenClaw 패턴을 인덱스 기반으로 추출 → FinClaw 매핑을 찾는다. 라벨(Faithful/Adapted/Diverged/Missing/Misimplemented) 부착 + 영역 유사도 % 산정.

## Phase 3: 통합 및 보고

`openclaw-similarity-synthesizer` 가:

1. 4 축 산출물 정독
2. 매핑 매트릭스 통합 → SUMMARY.md
3. 영역별 유사도 % + 한 줄 결론
4. **FinClaw 의 진화 분기점** (OpenClaw 와 다르게 간 결정 사슬 + 사유)
5. **정당성 평가**: Diverged / Missing 항목마다 정당한 차별화/단순화 vs 위험한 누락 라벨

## Phase 4: 사용자 응답 + 정리

신디사이저가 보고서를 사용자에게 전달 → TeamDelete → `_workspace/` 보존 (재실행 시 incremental).

## 데이터 흐름

```
사용자 요청
   │
   ▼
Phase 0 (컨텍스트 확인)
   │
   ▼
Phase 1 (TeamCreate, 5명)
   │
   ▼
Phase 2 (4 auditor 병렬)
   ├── architecture       → architecture.md
   ├── runtime-tools      → runtime-tools.md
   ├── memory-knowledge   → memory-knowledge.md
   └── interface-channels → interface-channels.md
                              │
                              ▼
Phase 3 (신디사이저 통합)
   │ → SUMMARY.md (매핑 매트릭스 + 진화 분기점 + FinClaw 정당성)
   ▼
Phase 4 (사용자 보고 + 팀 정리)
```

## 에러 핸들링

| 에러                 | 대응                                                          |
| -------------------- | ------------------------------------------------------------- |
| OpenClaw 레포 미접근 | 사용자에게 보고 + 중단                                        |
| auditor 1명 실패     | 1회 재시도 → 재실패 시 신디사이저가 "X 축 누락" 명시하고 진행 |
| auditor 간 라벨 충돌 | 신디사이저가 SendMessage 로 명확화 → 합의 불가 시 양측 명시   |

## 테스트 시나리오

**정상 흐름:**

1. 사용자: "OpenClaw 와 비교해줘"
2. Phase 0 → 초기 실행 결정 + OpenClaw 레포 접근 확인
3. 4 auditor 병렬 실행
4. 신디사이저 통합 → SUMMARY.md
5. 사용자: 영역 유사도 + 한 줄 결론 + FinClaw 정당성 평가 수신

**부분 재실행:**

1. 사용자: "런타임 축만 다시"
2. Phase 0 → runtime-tools-auditor 만 재호출
3. 신디사이저가 SUMMARY.md 갱신 (런타임 영역만)

## 산출물 위치

- 중간: `_workspace/openclaw-similarity/{architecture,runtime-tools,memory-knowledge,interface-channels}.md`
- 최종: `_workspace/openclaw-similarity/SUMMARY.md`

## 참조

- `references/comparison-rubric.md` — 라벨, 유사도 %, 1:1 매핑 형식, 출력 템플릿
- `references/openclaw-pattern-map.md` — OpenClaw 모듈 인덱스 (4축 시작점)
