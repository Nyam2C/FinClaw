# OpenClaw ↔ FinClaw 비교 평가 Rubric

이 문서는 4 comparator 가 공통으로 따르는 비교 평가 표준이다. 각 comparator 는 자기 영역(아키텍처/런타임/메모리/인터페이스)에 대해 본 rubric 의 출력 형식을 따른다.

## 1. 비교 대상의 본질

- **OpenClaw** = "현재 최고 주가의 multi-channel AI 게이트웨이". 거대 src 트리, 모바일 앱 포함, 80+ 외부 도메인 스킬. 패턴의 source-of-truth.
- **FinClaw** = OpenClaw 를 모방하면서 **금융 도메인을 합체한 사용자 1인용 비서**. pnpm 11 패키지로 정돈, 채널 1~3개로 축소.

평가 목표 = "FinClaw 가 OpenClaw 의 핵심 패턴을 얼마나 충실히 재현했는가" + "축소·변형이 정당한가".

## 2. 매핑 분류 (라벨)

각 OpenClaw 패턴/모듈/기능에 대해 FinClaw 의 대응을 다음 5개 라벨 중 하나로 분류한다.

| 라벨                                  | 정의                                                                                                         | 예시                                                                                                                                |
| ------------------------------------- | ------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------- |
| **Faithful** (충실)                   | 구조·이름·분리 방식이 거의 일치. 단순 축소가 아닌 "동일한 모델".                                             | OpenClaw `src/auto-reply/` 의 stage 파이프라인 패턴 → FinClaw `packages/server/src/auto-reply/stages/` 의 Normalize→Command→ACK→... |
| **Adapted** (정당한 단순화)           | 본질 패턴 유지하며 스코프/표면을 축소. 사용자 1인 제약·금융 도메인 한정으로 정당화 가능.                     | OpenClaw 의 다중 채널(Discord/Slack/Telegram/WhatsApp/Line/Signal/iMessage) → FinClaw 의 Discord 단일 채널                          |
| **Diverged** (의도적 차별화)          | OpenClaw 패턴을 알면서 다른 길을 선택. 금융 도메인 통합·감사 가능성 우선·읽기 전용 원칙 등 설계 의도가 분명. | OpenClaw 의 자유 도메인 skill 풀 → FinClaw 의 `skills-finance` 도메인 특화                                                          |
| **Missing** (누락)                    | OpenClaw 에 있는 핵심 패턴을 FinClaw 가 갖추지 않음. **누락이 의도인지 우발인지** 반드시 분류.               | OpenClaw 의 plugin-sdk 또는 MCP 클라이언트 부재, OpenClaw 의 compaction.ts 부재                                                     |
| **Misimplemented** (오해 / 잘못 모방) | OpenClaw 패턴을 따라했으나 본질을 놓침. 구조는 비슷하나 효과·안정성·확장성이 떨어지는 형태.                  | (예시 후보) tool-input-buffer 가 부분 streaming 만 구현하고 partial JSON 회복은 누락                                                |

**라벨링 규칙:**

- 한 패턴이 여러 라벨에 걸치면 가장 강한 라벨 1개를 고른다 (Misimplemented > Missing > Diverged > Adapted > Faithful 순으로 강함).
- "누락이 의도/우발 인지" 판단은 plans/, README, CLAUDE.md, project_use_case.md 의 명시 의사 결정을 근거로 한다. 명시 근거가 없으면 "우발 (근거 부족)" 으로 표기.

## 3. 유사도 점수

각 영역(축) 별로 0~100% 의 단일 유사도 점수를 부여한다. 산식:

```
similarity = weighted_avg(label_score) for each mapped pattern
  Faithful = 100
  Adapted = 75
  Diverged = 50  (의도적이면 평가의 "감점" 보다는 "차별화"; 점수는 50 으로 중립)
  Missing = 25  (Critical missing 은 0)
  Misimplemented = 10
```

가중치는 패턴의 **본질성**으로 부여:

- Critical = 3 (있어야 비서가 동작)
- Important = 2 (현대 비서 표준)
- Nice-to-have = 1 (편의·풍부함)

## 4. 출력 형식 (각 comparator)

산출물 경로: `_workspace/openclaw-similarity/{영역}.md`

```markdown
# {영역} Comparison

## 한 줄 결론

{유사도 점수 X% — 핵심 평가 요약}

## OpenClaw → FinClaw 매핑 매트릭스

| OpenClaw 패턴/모듈  | OpenClaw 경로   | FinClaw 대응     | FinClaw 경로                           | 라벨     | 본질성   | 비고                                                     |
| ------------------- | --------------- | ---------------- | -------------------------------------- | -------- | -------- | -------------------------------------------------------- |
| auto-reply pipeline | src/auto-reply/ | stage 파이프라인 | packages/server/src/auto-reply/stages/ | Faithful | Critical | normalize→command→ack→context→execute→deliver 6단계 동일 |
| ...                 | ...             | ...              | ...                                    | ...      | ...      | ...                                                      |

## 카테고리별 분석

### Faithful (충실 모방)

- **{패턴}**: {설명, 코드 인용}
- ...

### Adapted (정당한 단순화)

- **{패턴}**: {OpenClaw 의 X → FinClaw 의 Y. 정당화 근거: …}

### Diverged (의도적 차별화)

- **{패턴}**: {차별화의 설계 의도. 금융 도메인/감사 가능성/읽기 전용 등}

### Missing (누락)

**의도된 누락:**

- **{패턴}**: {근거: plans/X/plan.md 또는 CLAUDE.md L#}

**우발적/근거 부족 누락:**

- **{패턴}**: {위험성, OpenClaw 의 어떤 가치를 잃는가}

### Misimplemented (오해 / 잘못 모방)

- **{패턴}**: {OpenClaw 가 의도한 효과 vs FinClaw 의 현재 동작 차이}

## 측정값

- OpenClaw 측: 파일 수, LOC 추정, 모듈 수
- FinClaw 측: 파일 수, LOC 추정, 모듈 수
- 압축률(FinClaw / OpenClaw)

## 영역 유사도 점수

- 가중 평균: **X%**
- 패턴 수: Faithful N1 / Adapted N2 / Diverged N3 / Missing N4 / Misimplemented N5
```

## 5. 작업 원칙

- **추측 금지** — 양쪽 모두 코드를 직접 읽고 인용. 라벨에 의심이 있으면 "근거 부족" 으로 표기.
- **OpenClaw 가 source-of-truth** — FinClaw 의 패턴을 일반화해서 OpenClaw 에 매칭하지 말 것. OpenClaw 의 패턴을 추출 → FinClaw 매핑을 찾는 단방향 검사.
- **사용자 제약 반영** — 사용자 1인용 / 직접 학습 비대상 / 감사 가능성 우선이라는 FinClaw 제약을 정당화 근거로 활용. 단, 모든 누락을 이 제약으로 변호하지 말 것 (라벨이 Adapted 인지 Missing 인지를 엄격히 구분).
- **금융 도메인 합체** = Diverged 의 강한 형태. 금융 통합 자체가 OpenClaw 에 없는 것을 더하는 작업이므로, 이 영역의 품질은 별도 평가.

## 6. 합의 (의견 충돌 시)

- 두 comparator 가 같은 모듈에 다른 라벨을 매기면 SendMessage 로 즉시 합의.
- 합의 실패 시 "Disputed" 라벨로 표기하고 양쪽 의견 병기.

## 7. 비대상 항목

다음은 평가에서 제외:

- OpenClaw 의 모바일 앱(apps/ios, apps/android, apps/macos) — FinClaw 는 의도적으로 모바일 비대상
- OpenClaw 의 fine-tuning / online learning 관련 (CLAUDE.md "직접 학습 비대상")
- OpenClaw 의 Live API 키가 필요한 backend (byteplus/chutes 등 외부 OAuth) — 사용자 1인 환경에서 의미 없음
