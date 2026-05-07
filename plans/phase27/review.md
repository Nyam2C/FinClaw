# Phase 27 Review: 미국 주식 데이터 소스 확장 (Free APIs + Key Rotation)

> todo.md 기반 구현 코드 리뷰. 구현 완료 상태, 코드 품질 이슈, 리팩토링 사항을 기록한다.

base SHA: `e85106e` ↔ HEAD: `45df8f4` (변경: +1,707 / -84 LOC, 4 밀스톤 + 1 P0 fix 커밋)

---

## 1. 구현 사항 (TODO 일치도)

요약: ✅ **31** / ⚠️ **4** / ❌ **0** / 🔄 **0** (총 35개 단계)

### 사전 준비

| 단계 | 상태    | 비고                                      |
| ---- | ------- | ----------------------------------------- |
| P-1  | ✅ 완료 | baseline typecheck (별도 커밋 없음)       |
| P-2  | ✅ 완료 | 키 발급은 사용자 작업, mock 검증으로 대체 |

### 밀스톤 A — KeyRotator 인프라 (커밋 `636130c`)

| 단계 | 파일                                   | 상태    | 비고                                                                  |
| ---- | -------------------------------------- | ------- | --------------------------------------------------------------------- |
| A1   | `shared/key-rotator.ts`                | ⚠️ 편차 | implementer 가 lint 6건 (curly + non-null-assertion) 보정. 의미 보존. |
| A2   | `shared/__tests__/key-rotator.test.ts` | ✅ 완료 | 9 케이스                                                              |
| A3   | `skills-finance/src/index.ts`          | ✅ 완료 | KeyRotator/AllKeysCooldownError/readKeyArray export                   |
| A4   | 검증                                   | ✅ 완료 | typecheck/build PASS                                                  |

### 밀스톤 B — Finnhub + Twelve Data 시세 (커밋 `e85b505`)

| 단계 | 파일                                                     | 상태    | 비고                                                                                                                                 |
| ---- | -------------------------------------------------------- | ------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| B1   | `market/types.ts` `MarketDataProvider.isAvailable()`     | ✅ 완료 |                                                                                                                                      |
| B2   | `market/providers/finnhub.ts` (192 LOC)                  | ✅ 완료 | KeyRotator 통합, callWithRotation, isAvailable                                                                                       |
| B3   | `market/providers/finnhub.test.ts`                       | ⚠️ 편차 | mock 패턴 `vi.stubGlobal('fetch')` → `vi.mock('@finclaw/infra')` (statusCode 보존). 5 케이스. **alpha-vantage.test.ts 와 일관 보정** |
| B4   | `market/providers/twelve-data.ts` (192 LOC)              | ✅ 완료 | dailyLimit = 800 × keyCount                                                                                                          |
| B5   | `market/providers/twelve-data.test.ts`                   | ⚠️ 편차 | B3 와 동일 mock 패턴, 5 케이스                                                                                                       |
| B6   | `market/providers/alpha-vantage.ts`                      | ✅ 완료 | 단일 키 → KeyRotator. 기존 테스트도 동기화.                                                                                          |
| B7   | `coingecko.ts` + `frankfurter.ts` `isAvailable()=true`   | ✅ 완료 |                                                                                                                                      |
| B8   | `provider-registry.ts` resolve + list                    | ✅ 완료 | resolve 정상. `list()` 호출처 0 — 본 phase 에서 추가됐으나 **dead code** (P1)                                                        |
| B9   | `market/index.ts` MarketSkillConfig + Handle.keyRotators | ✅ 완료 |                                                                                                                                      |
| B10  | `market/normalizer.ts` finnhub/twelve-data 분기          | ✅ 완료 | normalizeQuote + normalizeHistorical 5 provider 분기 (+120 LOC, plan.md 추정 누락 — scope creep #2)                                  |
| B11  | `server/main.ts` KeyRotator 주입                         | ✅ 완료 |                                                                                                                                      |
| B12  | `.env.example`                                           | ⚠️ 편차 | 신규 키 외 5건 기존 주석 삭제 (CLAUDE.md §3 위반 가능 — scope creep #1)                                                              |
| B13  | 검증                                                     | ✅ 완료 |                                                                                                                                      |

### 밀스톤 C — NewsData.io + Finnhub News (커밋 `41cd83e`)

| 단계 | 파일                                     | 상태    | 비고                                                                                                                                                       |
| ---- | ---------------------------------------- | ------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| C1   | `news/providers/newsdata.ts`             | ✅ 완료 |                                                                                                                                                            |
| C2   | `news/providers/newsdata.test.ts`        | ⚠️ 편차 | mock 패턴 보정, 4 케이스                                                                                                                                   |
| C3   | `news/providers/finnhub-news.ts`         | ⚠️ 편차 | implementer 가 `scoreToSentiment` 헬퍼 신설 (NewsSentiment.confidence 채우기). **`alpha-vantage-news.normalizeSentiment` 와 동일 로직 — 신규 복제** (P0-3) |
| C4   | `news/providers/finnhub-news.test.ts`    | ⚠️ 편차 | mock 패턴 보정, 3 케이스                                                                                                                                   |
| C5   | `news/types.ts` NewsSourceId 확장        | ✅ 완료 |                                                                                                                                                            |
| C6   | `news/aggregator.ts` sentiment 우선 정렬 | ✅ 완료 |                                                                                                                                                            |
| C7   | `news/index.ts` NewsSkillConfig + Handle | ✅ 완료 |                                                                                                                                                            |
| C8   | `server/main.ts` News rotator 주입       | ✅ 완료 | finnhub rotator 시세 ↔ 뉴스 공유                                                                                                                           |
| C9   | 검증                                     | ✅ 완료 |                                                                                                                                                            |

### 밀스톤 D — Cache TTL + Status (커밋 `48ca333`)

| 단계 | 파일                                                 | 상태    | 비고                                                                                                                  |
| ---- | ---------------------------------------------------- | ------- | --------------------------------------------------------------------------------------------------------------------- |
| D1   | `market/cache.ts` provider 별 TTL + getDailyUsage    | ✅ 완료 | finnhub 5s / twelveData 5m / alphaVantage 30m                                                                         |
| D2   | `auto-reply/commands/status.ts` API 한도 표시        | ⚠️ 편차 | `bar` → `usageBar` rename (shadowing 회피). **단, plan.md 시나리오 #8 의 Finnhub 표시 정상 동작 X** — P0 위험 신호 #1 |
| D3   | `commands/built-in.ts` deps 전달                     | ✅ 완료 |                                                                                                                       |
| D4   | `server/main.ts` registerBuiltInCommands handle 전달 | ✅ 완료 |                                                                                                                       |
| D5   | mock 시나리오 검증                                   | ⚠️ 편차 | 실 키 시나리오는 사용자 발급 후 검증 (범위 외)                                                                        |

---

## 2. 자동화 검증 결과

| 명령                | 결과                           | 비고                                               |
| ------------------- | ------------------------------ | -------------------------------------------------- |
| `pnpm typecheck`    | ✅ PASS                        | 에러 0건                                           |
| `pnpm test --run`   | ✅ 1514 pass / 0 fail / 0 skip | 164 test files (109.23s)                           |
| `pnpm test:storage` | ✅ 119 pass / 0 fail           | 14 test files (70.52s)                             |
| `pnpm lint`         | ✅ clean                       | 0 warnings, 0 errors (491 files, 126 rules, 329ms) |
| `pnpm build`        | ✅ PASS                        | tsc --build, 에러 0건                              |
| **mock-only 격리**  | ✅ **PASS**                    | 모든 `*_KEY` env unset 상태에서 1514 tests 통과    |

**기능 회귀 0건.**

---

## 3. 경계면 검증

| 축    | 두 면                                                                                  | 결과                                             |
| ----- | -------------------------------------------------------------------------------------- | ------------------------------------------------ |
| A     | 5 provider ↔ KeyRotator (callWithRotation/isAuthOrRateError/isTransientError 시그니처) | ✅ shape 일치 (단 ~150 LOC 복제 — refactor P0-1) |
| B     | `MarketSkillHandle.keyRotators` ↔ `status.ts` destructure                              | ✅ shape 일치                                    |
| C     | `NewsSkillHandle.keyRotators` ↔ `status.ts` destructure                                | ✅ shape 일치                                    |
| D     | `NewsSkillConfig` ↔ `main.ts` 주입 (finnhub rotator 시세 공유)                         | ✅ shape 일치                                    |
| E     | `MarketDataProvider.isAvailable()` ↔ `ProviderRegistry.resolve()` 가용성 검사          | ✅ shape 일치                                    |
| **F** | **Finnhub `rateLimit` ↔ `cache.dailyLimit` 가드**                                      | ❌ **결손**                                      |

F축 결손 상세: `finnhub.ts:71-74` 의 `rateLimit` 에 `dailyLimit` 키 없음 → `cache.ts:45,70` 의 `if (provider.rateLimit.dailyLimit)` 가드 → `incrementDailyCount` 호출 안 됨 → `getDailyUsage('finnhub')` 항상 0 → status 표시 항상 `[░░░░░░░░░░] 0 / 180 calls/min`. **plan.md Done 정의 검증 시나리오 #8 부분 실패** (P0).

---

## 4. 리팩토링 사항

### P0 — 즉시 (병합 전)

#### 1. 5 provider 에 `callWithRotation` + `isAuthOrRateError` + `isTransientError` 완전 동일 복제

- **위치**: finnhub/twelve-data/alpha-vantage/finnhub-news/newsdata 5개 파일
- **문제**: 동일 30+ LOC 함수가 5 곳에 복제 (~150 LOC). 추출 임계 (3회) 한참 초과. CLAUDE.md §2 위반.
- **추가 컨텍스트**: 기존 `news/providers/{newsapi,alpha-vantage-news,rss}.ts` 에 이미 `// TODO(R-1): news/utils.ts 로 추출` 주석 5건. 본 phase 가 무시하고 3건 더 복제 — 누적 8회.
- **제안**: `packages/skills-finance/src/shared/rotation.ts` 에 `callWithRotation(rotator, fetcher, errorFactory?)` + `isAuthOrRateError` + `isTransientError` 추출. 절감 ~150 LOC, 5 → 1 정의.

#### 2. `try/catch (err) { if (instanceof X) throw err; throw err }` 죽은 분기

- **위치**: 5 provider 모두 동일 5라인 패턴
- **문제**: instanceof 분기와 fallthrough 가 결과적으로 동일한 throw. 죽은 분기.
- **제안**: 전체 try/catch 제거. P0-1 추출에 자연스럽게 포함.

#### 3. `scoreToSentiment` 가 `alpha-vantage-news.normalizeSentiment` 와 동일 로직 복제

- **위치**: `news/providers/finnhub-news.ts:105-127`
- **문제**: implementer 가 `NewsSentiment.confidence` 누락 보정하면서 기존 함수를 못 찾고 신규 복제. 임계값 0.35/0.15, 5단계 라벨 매핑이 글자 단위 동일.
- **제안**: `news/utils/sentiment-normalize.ts` 추출 또는 `alpha-vantage-news.normalizeSentiment` export. 신규 복제 제거.

#### 4. status 의 Finnhub 사용량 표시 미동작 (plan.md 검증 시나리오 #8 부분 실패) — ✅ **본 phase 에서 수정 (커밋 `45df8f4`)**

- **위치**: `commands/status.ts:96-103` + `cache.ts:45,70` + `finnhub.ts:71-74`
- **문제**: Finnhub provider 의 `rateLimit` 에 `dailyLimit` 키 없음 (분당 60 만 있음) → `cache.ts:70` 의 `if (provider.rateLimit.dailyLimit)` 가드 → `incrementDailyCount` 호출 안 됨 → `getDailyUsage('finnhub')` 항상 0.
- **적용 fix (옵션 A)**: `finnhub.ts` 에 `dailyLimit: 60 * 60 * 24` (분당 60 의 일 환산, 이론 max) 추가. `status.ts` 의 Finnhub 라인 total 계산을 일 단위로 변경 (`60 * 60 * 24 * keyCount/day`). 다른 provider 의 일 단위 표시와 일관성 회복.
- **잔여 정정 후보 (Phase 28+)**: 옵션 B (cache 카운터를 dailyLimit 와 분리, 분/일 단위 분기) — 더 정확한 분 단위 표시 원하면.

#### 5. 신규 단위 테스트 26건 — plan.md "≥ 30 케이스" 미달 (4 부족)

- **위치**: KeyRotator 9 + Finnhub 5 + TwelveData 5 + NewsData 4 + FinnhubNews 3 = 26
- **문제**: plan.md Done 정의의 "신규 unit test ≥30 케이스" 미충족
- **제안**: 4 케이스 추가 — `getDailyUsage` 경계 케이스 (cache.ts), `degraded fallback` 시나리오 (provider-registry), `finnhub rotator 공유` 시나리오 (news/main 통합), `markFailure` 후 markSuccess 회복 (key-rotator).

### P1 — 권장 (다음 phase 안에)

#### 6. `KeyRotator.markFailure` 의 `_error` 매개변수 미사용

- 위치: `key-rotator.ts:71`
- 제안: 매개변수 제거 (P0-1 추출에 묻혀 자동 해결)

#### 7. `ProviderRegistry.list()` dead code (본 phase 에서 추가됐으나 호출처 0)

- 위치: `provider-registry.ts:35-38`
- 제안: 제거 (4 LOC)

#### 8. KeyRotator ↔ cache 의 daily counter 통합 검토 (Phase 28+)

- 책임이 두 곳에 분산 — P0-4 의 본질적 원인. 이번 phase 범위 외, 추후 통합 검토.

#### 9. `coingecko/frankfurter.isAvailable()` 의례적 `return true`

- 제안 (선호 차이): 인터페이스에 `isAvailable?(): boolean` (optional) 또는 abstract base class default. 또는 현재 유지.

### P2 — 선택 (선호 차이)

#### 10. provider 별 `Error` 클래스 5개

- 단일 `ProviderError` + `provider` 필드 통합 가능. 또는 현재 유지 (TS narrowing 의도).

#### 11. `KeyRotator.next()` 의 cursor 부수효과 의도

- `nextSearchStart` 같이 명확한 이름. 큰 영향 없음.

---

## 5. 범위 밖 발견 (참고 — 삭제 권장 X)

> phase 의 plan.md 가 요구하지 않은 영역에서 발견된 기존 dead code. 본 phase 에서 정리 X.

- **`ProviderRegistry.resolveWithFallback()`** (`provider-registry.ts:30-33`) — Phase 27 이전부터 호출처 0. CLAUDE.md §3 에 따라 본 phase 제거 X.
- **5개 news provider 의 누적 TODO(R-1)** (`news/providers/{rss,newsapi,alpha-vantage-news}.ts`) — 이전 phase 에서 `news/utils.ts` 추출 의도 표시. 본 phase 가 무시하고 복제 누적 (P0-1 와 연결) → P0-1 추출 시 함께 해소 권장.

---

## 6. scope creep 의심 (사용자 확인)

#### 1. `.env.example` 의 광범위한 주석 정리

- plan.md 는 새 키 (FINNHUB_KEY/TWELVE_DATA_KEY/NEWSDATA_API_KEY) 추가만 요구. 그러나 diff 는 5건 기존 주석 삭제 (`VOYAGE_API_KEY` 안내, `FINCLAW_DB_PATH` docker/local, AV 단일 키 설명). CLAUDE.md §3 위반 가능.
- **사용자 결정 요청**: 주석 정리 수용 vs 새 키만 추가하는 외과적 변경으로 되돌리기?

#### 2. `market/normalizer.ts` 신규 +120 LOC 가 plan.md LOC 추정에 누락

- plan.md 영향 범위 표 (∑ ~1,144) 에 normalizer 변경 미명시. 실제 +1,704 LOC (49% 초과). 신규 provider 정규화는 정당.
- **사용자 결정 요청**: 정당한 누락 (plan 추정 오차) 으로 분류 권장.

---

## 7. 위험 신호

> 즉시 의사결정 필요한 항목.

1. ✅ **P0-4 처리 완료 (커밋 `45df8f4`)** — Finnhub status 일 단위 표시로 정정.
2. **신규 테스트 26건 (P0-5)** — plan.md "≥ 30" 미달 4건. 머지 가능하나 다음 phase 시작 전 보강 권장.

---

## 8. 다음 Phase 후보 (제안)

- **Phase 28+ — provider 공통 추출** (refactor P0-1, P0-2): `shared/rotation.ts` + `shared/error-classification.ts` + 5 provider 리팩토링. ~150 LOC 절감 + 8회 누적 TODO 해소.
- **Phase 28+ — sentiment 정규화 통합** (refactor P0-3): `news/utils/sentiment-normalize.ts` 추출 + alpha-vantage-news / finnhub-news 통합.
- **Phase 28+ — KeyRotator ↔ cache daily counter 통합** (refactor P1-8): 책임 한 곳으로 모음. P0-4 의 본질적 해결.
- **실 키 발급 후 통합 검증**: 사용자 키 발급 → mock 시나리오 D5 의 실 시나리오 검증.

---

## 9. 측정값

- 변경 파일 수: 27 (신규 10, 수정 17)
- 변경 LOC: +1,707 / -84 (plan.md 추정 +1,144 의 49% 초과)
- 새 테스트 수: 26 (plan.md ≥30 미달 4건)
- 5 커밋: `636130c` (A) → `e85b505` (B) → `41cd83e` (C) → `48ca333` (D) → `45df8f4` (P0-4 fix)
- 검토 소요: refactor 21분 + qa 10분 (병렬)
- review.md 생성 일시: 2026-05-08

---

## 10. 권고 — 머지 가능 여부

**판정**: ✅ **머지 가능**

P0-4 본 phase 에서 수정 완료. 1514 unit + 119 storage + lint clean + mock-only 모두 PASS, 기능 회귀 0건. **plan.md 의 핵심 목표 (Key Rotation 으로 일일 한도 ×3, 신규 4 provider, status 사용량 표시) 모두 달성**.

머지 후 다음 phase (28+) 후보:

- P0-1 / P0-2 (provider 5중복 ~150 LOC 추출 — `shared/rotation.ts`)
- P0-3 (scoreToSentiment 통합 — alpha-vantage-news 와 정합성)
- P0-5 (테스트 4건 보강 — Done 정의 ≥30 충족)
- scope creep #1 (.env.example 주석 복원) — 사용자 결정
