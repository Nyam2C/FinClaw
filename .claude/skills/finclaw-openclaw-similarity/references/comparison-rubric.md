# OpenClaw 1:1 비교 룰릭

`finclaw-openclaw-similarity` 스킬이 사용. 4 auditor 가 각자 축별로 이 룰릭에 따라 OpenClaw → FinClaw 1:1 매핑을 채운다.

## 1. 비교의 본질

**OpenClaw 가 source-of-truth (단방향).** 비교는:

1. OpenClaw 의 패턴/모듈/결정을 추출
2. FinClaw 에서 그것에 대응하는 것을 찾음
3. 라벨 부착 (Faithful / Adapted / Diverged / Missing / Misimplemented)
4. 영역 유사도 % 산정

OpenClaw 가 안 가진 것을 FinClaw 가 가졌다면 (예: 금융 도메인 합체) 그것은 별도 섹션 "FinClaw 독자 추가" 로 기록 — 비교의 주축은 OpenClaw 가 가진 것.

## 2. 매핑 라벨 (각 매핑 셀)

| 라벨               | 의미                                                                  | 예시                                                                    |
| ------------------ | --------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| **Faithful**       | OpenClaw 패턴을 충실 재현                                             | OpenClaw 의 ChannelDock 추상화를 FinClaw 가 그대로                      |
| **Adapted**        | OpenClaw 패턴을 정당하게 단순화/축소                                  | OpenClaw 8 채널 vs FinClaw 의 Discord+TUI+Web 3채널 (1인 사용자에 정당) |
| **Diverged**       | OpenClaw 와 다른 의도적 차별화                                        | FinClaw 의 거래 이력 / 포트폴리오 (금융 특화)                           |
| **Missing**        | OpenClaw 가 가진 핵심 기능이 빠짐 (이유 명시 시 정당, 미명시 시 위험) | FinClaw 에 MCP 클라이언트 부재                                          |
| **Misimplemented** | 모방 시도했으나 의미가 달라짐                                         | (해당 시 명시)                                                          |

## 3. 유사도 점수 (각 축별)

각 auditor 가 자기 축에 대해 0–100% 유사도 점수 산정.

| %      | 의미                              |
| ------ | --------------------------------- |
| 90–100 | 매우 유사 — 핵심 패턴 거의 동일   |
| 70–89  | 유사 — 핵심 패턴 일치 + 일부 차이 |
| 50–69  | 부분 유사 — 절반 정도 일치        |
| 30–49  | 차별화 — 다른 결정이 더 많음      |
| 10–29  | 거의 무관 — OpenClaw 와 본질 다름 |
| 0–9    | 완전 분기                         |

**산정 기준:**

- 영역 항목별 라벨 가중 평균 (Faithful = 1.0, Adapted = 0.7, Diverged = 0.4, Missing = 0.0, Misimplemented = 0.2)
- 각 항목 가중치는 영역 핵심도에 따라 (auditor 판단)

## 4. 출력 형식 (각 auditor)

각 auditor 는 자기 축 산출물에 다음 6 섹션 작성:

```markdown
# {축 이름} — FinClaw ↔ OpenClaw 비교

## 한 줄 결론

FinClaw 의 {축} 은 OpenClaw 와 X% 유사하며, 핵심 분기점은 {1줄}.

## OpenClaw → FinClaw 매핑 매트릭스

| OpenClaw 항목        | FinClaw 대응                     | 라벨    | 사유                                          |
| -------------------- | -------------------------------- | ------- | --------------------------------------------- |
| (예: 패키지 분리 7+) | 11 패키지 (types/config/.../web) | Adapted | OpenClaw 의 분리 원칙 유지 + 1 패키지 더 분할 |
| ...                  |                                  |         |                                               |

## 카테고리별 분석

### Faithful (충실 모방)

- ...

### Adapted (정당한 단순화)

- ...

### Diverged (의도적 차별화)

- ...

### Missing (FinClaw 에 빠진 것)

- ... (이유 명시 여부 + 위험도)

### Misimplemented (모방 시도, 의미 어긋남)

- ...

## FinClaw 독자 추가 (OpenClaw 에 없는 FinClaw 의 것)

- 금융 도메인 합체 (transactions, portfolio_holdings, alerts) — 정당성 평가 1줄

## 영역 유사도 점수

| 산정 항목   | 가중치 | 라벨    | 점수    |
| ----------- | ------ | ------- | ------- |
| 패키지 분리 | 0.3    | Adapted | 0.7     |
| ...         |        |         |         |
| **종합**    |        |         | **NN%** |

## 측정값

- 비교 항목 수: NN
- OpenClaw 측 LOC / 파일 수, FinClaw 측 LOC / 파일 수

## FinClaw 의 진화 분기점

- {축에서 FinClaw 가 OpenClaw 와 다르게 간 결정} + 사유 1-2줄
```

## 5. 작업 원칙

- **OpenClaw 측 시작** — 각 auditor 는 `references/openclaw-pattern-map.md` 의 해당 축 섹션을 시작점으로 OpenClaw 의 핵심 모듈/결정을 추출. 그 후 FinClaw 매핑을 찾음.
- **숫자 우선** — 각 셀은 정성 1줄 + 정량 (LOC, 파일 수, 함수 수, 의존성 수). 가능한 한 측정.
- **정당성 평가 포함** — Diverged / Missing 항목은 단순 차이 기록이 아니라 "정당한 단순화인지 위험한 누락인지" 라벨 부착.
- **1인 사용자 + 학습 산출물 정체성 반영** — OpenClaw 가 가진 멀티 사용자 기능, 학습 인프라가 FinClaw 에 없다면 `Missing` 라벨이지만 정당한 단순화로 판정.

## 6. 합의 (의견 충돌 시)

auditor 간 매핑 충돌:

- A 가 "Faithful" 이라 보고, B 가 "Adapted" 라 보면 → SendMessage 로 1회 합의 시도
- 합의 불가 시 신디사이저가 양측 명시: "auditor A 는 Faithful, B 는 Adapted, 사용자 판단"

라벨 자체에 대한 의문이 있으면 본 룰릭 §2 의 정의로 돌아가서 해소.

## 7. 비대상 항목

다음은 본 비교에서 명시적으로 제외:

- OpenClaw 의 멀티 사용자 / 멀티 테넌시 (FinClaw 1인 사용자 정체성)
- OpenClaw 의 모바일/데스크톱 앱 `apps/{ios,android,macos}` (FinClaw 모바일 비대상)
- ML 학습 인프라 (FinClaw 비대상)

비대상 항목은 매핑 매트릭스에 행으로 두지 말고 `Missing (정당한 비대상)` 라벨로 처리.
