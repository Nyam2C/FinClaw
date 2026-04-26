# Phase 27 — 미국 주식 데이터 소스 확장 (Free APIs + Key Rotation)

## Context

Phase 24 의 모델 라우팅이 완성됐으나, 실 환경에서 **Alpha Vantage 단일 키 무료 25/day 한도 즉시 도달**. 실 검증 시 SPY/QQQ/DIA 동시 조회 → rate limit → agent.run 분석에 시세 데이터 빈약 → LLM "데이터 한계" 안내로 끝남.

**사용자 결정 (Phase 27 시작 전):**

- **미국 주식 + 영문 뉴스에만 집중** — 한국 시장 / 코인 / 한국어 뉴스는 Phase 27 범위 외.
- **API 키 3개씩 발급** — KeyRotator 라운드 로빈으로 일일 한도 3 배 활용.
- **읽기 전용 원칙 유지** — 시세 / 차트 / 뉴스 / sentiment 만.
- **라이트 plan** — todo.md 분리 없음. 본 plan.md 단일 문서로 작업.
- **기존 인프라 최대 활용** — ManagedAuthProfile 라운드 로빈 / RateLimiter SQLite / Circuit Breaker 모두 재사용.

---

## 사전 조사 결과 (Sub-agent 4 병렬)

### 미국 주식 시세

| Provider          | 무료 한도     | 지연      | 키 3개 한도     | 비고                                     |
| ----------------- | ------------- | --------- | --------------- | ---------------------------------------- |
| **Finnhub**       | 60 calls/min  | Real-time | ~3,600 calls/hr | WebSocket 지원, 가장 관대. **Primary**   |
| **Twelve Data**   | 800 calls/day | 4 시간    | 2,400 calls/day | 명확한 daily cap, 단순. **Secondary**    |
| Alpha Vantage     | 25 calls/day  | EOD       | 75 calls/day    | 현행 유지, 종목 뉴스 + sentiment 백업용  |
| ~~Yahoo Finance~~ | -             | -         | -               | 2017 공식 종료, 비공식 스크래핑 — 채택 X |
| ~~IEX Cloud~~     | -             | -         | -               | 2024-08 종료                             |

### 영문 금융 뉴스

| Provider         | 무료 한도       | sentiment | 비고                                         |
| ---------------- | --------------- | --------- | -------------------------------------------- |
| **NewsData.io**  | 200 credits/day | 유료만    | 87K+ 소스. 키 3개 = 600/day. **TOP 추천**    |
| **Finnhub News** | 시세 키 공유    | ✅ 포함   | sentiment 자동 첨부, 시세 키 재사용 (비용 0) |
| **GNews**        | 100 req/day     | X         | 60K+ 소스. 단순 가입. 옵션                   |

---

## 기존 인프라 (재사용)

Sub-agent 코드 조사 결과:

- **`MarketDataProvider` 인터페이스 명확** — 신규 provider 추가 ~120 LOC
- **`@finclaw/agent/src/auth/profiles.ts` 라운드 로빈 `selectNext()` 이미 구현** — KeyRotator 의 핵심 패턴 재사용
- **`MarketCache.RateLimiter` SQLite 일별 카운터 + 슬라이딩 윈도우** — 자정 자동 만료
- **Circuit Breaker (`@finclaw/infra/src/circuit-breaker.ts`)** — 실패 자동 차단
- **`isTransientError()` + 지수 백오프** — 429 / 5xx 재시도

---

## 밀스톤 A — Key Rotation 어댑터 (필수 인프라)

### 목표

`.env` 의 `XXX_KEY=k1,k2,k3` (CSV) 또는 `XXX_KEY_1/_2/_3` (인덱스) 형태 키 배열을 읽어 라운드 로빈 / 실패 회피 rotation 으로 호출하는 공통 어댑터 신설.

### 작업

**파일:**

- `packages/skills-finance/src/shared/key-rotator.ts` (신설, ~80 LOC)
- `packages/skills-finance/src/shared/__tests__/key-rotator.test.ts` (신설, ~60 LOC)
- `packages/server/src/main.ts` (수정, ~20 LOC — env 키 배열 파싱)

**KeyRotator 인터페이스:**

```ts
export class KeyRotator {
  constructor(private keys: ReadonlyArray<string>);
  /** 다음 키 선택 (라운드 로빈). 모두 cooldown 시 throw. */
  next(): string;
  /** 키별 실패 카운트 — 임계 (기본 3) 초과 시 cooldown (기본 60 분) */
  markFailure(key: string, error: Error): void;
  markSuccess(key: string): void;
  /** 가용 키 수 */
  availableCount(): number;
}
```

**env 패턴 (둘 다 지원):**

```
ALPHA_VANTAGE_KEY=key1,key2,key3       # CSV
ALPHA_VANTAGE_KEY_1=key1               # 인덱스
ALPHA_VANTAGE_KEY_2=key2
ALPHA_VANTAGE_KEY_3=key3
FINNHUB_KEY=k1,k2,k3
TWELVE_DATA_KEY=k1,k2,k3
NEWSDATA_API_KEY=k1,k2,k3
GNEWS_API_KEY=k1,k2,k3                 # 옵션
```

**main.ts 헬퍼:**

```ts
function readKeyArray(envName: string): readonly string[] {
  const csv = process.env[envName];
  if (csv)
    return csv
      .split(',')
      .map((k) => k.trim())
      .filter(Boolean);
  const keys: string[] = [];
  for (let i = 1; i <= 10; i++) {
    const k = process.env[`${envName}_${i}`];
    if (k) keys.push(k);
  }
  return keys;
}
```

**검증:** 단위 테스트 — 키 3개 → next() 3 회 모두 다른 키, 4번째 1번 재사용. markFailure 후 키 skip. 모두 cooldown 시 throw.

---

## 밀스톤 B — Finnhub + Twelve Data 시세 provider

### 목표

미국 주식 시세를 Alpha Vantage 단일 의존에서 **3 provider 폴백 체인**으로 전환. Finnhub primary (실시간) → Twelve Data secondary (4시간 지연) → Alpha Vantage tertiary.

### 작업

**파일:**

- `packages/skills-finance/src/market/providers/finnhub.ts` (신설, ~140 LOC)
- `packages/skills-finance/src/market/providers/finnhub.test.ts` (신설, ~80 LOC, mock 기반)
- `packages/skills-finance/src/market/providers/twelve-data.ts` (신설, ~140 LOC)
- `packages/skills-finance/src/market/providers/twelve-data.test.ts` (신설, ~80 LOC)
- `packages/skills-finance/src/market/providers/alpha-vantage.ts` (수정, ~20 LOC — KeyRotator 통합)
- `packages/skills-finance/src/market/provider-registry.ts` (수정, ~15 LOC — 신규 등록 + 우선순위)
- `packages/skills-finance/src/market/index.ts` (수정, ~10 LOC — config 필드)
- `packages/server/src/main.ts` (수정, ~25 LOC — KeyRotator 주입)
- `.env.example` (수정, ~6 LOC)

**Finnhub 구현 핵심:**

- 엔드포인트: `https://finnhub.io/api/v1/quote?symbol={SYM}&token={KEY}`
- 응답: `{ c: 현재가, h: 고가, l: 저가, o: 시가, pc: 전일종가, t: timestamp }`
- KeyRotator 통합: 매 호출 `keyRotator.next()`, 429/401 시 `markFailure` + 다음 키 재시도 (최대 3회)
- rateLimit: `{ maxRequests: 60, windowMs: 60_000 }` (키 당)

**Twelve Data 구현 핵심:**

- 엔드포인트: `https://api.twelvedata.com/quote?symbol={SYM}&apikey={KEY}`
- daily 한도 800 → 키 3개 = 2,400/day
- rateLimit: `{ dailyLimit: 800 }` (키 당)

**provider-registry.ts 우선순위 정책:**

```ts
// supports() 매칭 + 가용성 검사로 fallback chain
registry.register(new FinnhubProvider(finnhubRotator)); // primary (real-time)
registry.register(new TwelveDataProvider(twelveDataRotator)); // secondary (4h delay)
registry.register(new AlphaVantageProvider(avRotator)); // tertiary (EOD)
// CoinGecko / Frankfurter 는 현행 유지 (코인 / 외환 도구 자동 등록)
```

**resolve(symbol) 동작:** 첫 번째 `supports(symbol) === true && rotator.availableCount() > 0` 인 provider 반환. Finnhub 가용이면 항상 Finnhub.

**검증:** 단위 테스트 + 실 환경 — Discord "AAPL 얼마야?" 호출 후 로그에 `provider: 'finnhub'` + 실시간 (지연 1초 미만) 시세 확인.

---

## 밀스톤 C — 영문 뉴스 확장 (NewsData.io + Finnhub News)

### 목표

영문 금융 뉴스 다양화 + sentiment 자동 첨부. Phase 24 의 한 줄 답변 한계 극복.

### 작업

**파일:**

- `packages/skills-finance/src/news/providers/newsdata.ts` (신설, ~120 LOC)
- `packages/skills-finance/src/news/providers/newsdata.test.ts` (신설, ~70 LOC)
- `packages/skills-finance/src/news/providers/finnhub-news.ts` (신설, ~120 LOC, Finnhub 시세 키 재사용)
- `packages/skills-finance/src/news/providers/finnhub-news.test.ts` (신설, ~70 LOC)
- `packages/skills-finance/src/news/aggregator.ts` (수정, ~10 LOC — sentiment 우선 정렬 옵션)
- `packages/skills-finance/src/news/index.ts` (수정, ~15 LOC — provider 등록)
- `packages/server/src/main.ts` (수정, ~15 LOC — KeyRotator 공유)
- `.env.example` (수정, ~3 LOC)

**NewsData.io 핵심:**

- 엔드포인트: `https://newsdata.io/api/1/latest?apikey={KEY}&category=business&language=en`
- 200 credits/day × 키 3개 = 600/day
- KeyRotator 통합 (NewsData 전용 인스턴스)
- 응답: `[{ title, link, description, pubDate, source_id, country, category }]`

**Finnhub News 핵심:**

- 엔드포인트: `https://finnhub.io/api/v1/company-news?symbol={SYM}&from={DATE}&to={DATE}&token={KEY}`
- sentiment 점수 자동 포함 (`headline_sentiment`)
- **Finnhub 시세 KeyRotator 와 동일 인스턴스 공유** — 추가 키 발급 불필요, rate limit 통합 추적
- 종목 단위 뉴스 (general_news 엔드포인트는 별도)

**aggregator 변경:**

- 기존 `fetchNews({ symbols, keywords, category, limit })` 시그니처 유지
- 내부적으로 sentiment 가 있는 항목 우선 정렬 (`headline_sentiment > 0` ↑)
- 5분 캐시 정책 유지

**검증:** Discord "AAPL 뉴스" → finnhub-news (sentiment 포함) + newsdata.io (광범위 소스) 결과 mix. 각 항목에 sentiment label 표시.

---

## 밀스톤 D — 캐시 정책 + 일일 한도 모니터링 + 검증

### 목표

신규 provider 들의 캐시 TTL 정합성 + status 명령에 일일 사용량 표시 + 실 환경 시나리오 검증.

### 작업

**파일:**

- `packages/skills-finance/src/market/cache.ts` (수정, ~30 LOC — provider 별 TTL)
- `packages/server/src/auto-reply/commands/status.ts` (수정, ~25 LOC — provider 한도 표시)

**캐시 TTL 정책:**

- Finnhub real-time → **5 초**
- Twelve Data 4h delay → **5 분**
- Alpha Vantage EOD → **30 분**
- 뉴스 (모든 provider) → **15 분**

**`!finclaw status` 확장:**

```
**FinClaw 상태**
- ...
**API 한도 (오늘)**
- Finnhub:     [▓▓▓░░░░░░░] 234 / 60×3 calls/min · 가용 키 3/3
- Twelve Data: [▓▓░░░░░░░░] 320 / 2400/day      · 가용 키 3/3
- Alpha V:     [▓▓▓▓░░░░░░] 28  / 75/day        · 가용 키 3/3
- NewsData.io: [▓░░░░░░░░░] 45  / 600/day       · 가용 키 3/3
- Finnhub News: (시세와 키 공유)
```

**검증 시나리오 (실 환경, Discord):**

| 시나리오           | 입력                      | 기대 동작                                            |
| ------------------ | ------------------------- | ---------------------------------------------------- |
| 미국 주식 (실시간) | "AAPL 얼마야?"            | provider=finnhub, 지연 1 초 미만, fetch role → Haiku |
| 미국 주식 차트     | "AAPL 차트 1년"           | provider=finnhub or twelve-data, 차트 데이터 반환    |
| 동시 다종목        | "SPY QQQ DIA 비교"        | 3 종목 모두 시세 응답, rate limit 도달 X             |
| Finnhub 한도 도달  | 60 회 연속 (or mock 강제) | 키 2 로 rotation, 끊김 없음                          |
| 모든 키 cooldown   | (mock 강제)               | DailyLimitExceededError → 한국어 안내 메시지         |
| 미국 종목 뉴스     | "AAPL 뉴스"               | finnhub-news + newsdata.io mix, sentiment 포함       |
| 종합 분석          | "AAPL 분석해줘"           | analyze_market → Opus + 시세/뉴스/sentiment 종합     |
| status 한도 출력   | "!finclaw status"         | 4 provider 사용량 + 가용 키 수 표시                  |

---

## 영향 범위 추정

| 항목                  | LOC        | 신규 파일 |
| --------------------- | ---------- | --------- |
| KeyRotator + 테스트   | +140       | 2         |
| Finnhub + 테스트      | +220       | 2         |
| Twelve Data + 테스트  | +220       | 2         |
| Alpha Vantage 수정    | +20        | 0         |
| NewsData.io + 테스트  | +190       | 2         |
| Finnhub News + 테스트 | +190       | 2         |
| aggregator / index    | +25        | 0         |
| provider-registry     | +15        | 0         |
| symbol-resolver       | -          | 0         |
| main.ts               | +60        | 0         |
| 캐시 + status         | +55        | 0         |
| .env.example          | +9         | 0         |
| **합계**              | **~1,144** | **10**    |

**Phase 24 (1,594 LOC) 의 ~72% 규모.**

---

## 의존성 / 순서

```
A (KeyRotator)
  ↓
B (Finnhub + Twelve Data)
  ↓
C (NewsData.io + Finnhub News)  ← Finnhub 키 B 와 공유
  ↓
D (캐시 + status + 검증)
```

권장: **A → B → C → D** 순차. B 검증 후 C 시작 (provider 패턴 확정 후 뉴스에 적용).

---

## Done 정의

- [ ] `XXX_KEY=k1,k2,k3` 또는 `XXX_KEY_1/_2/_3` 두 형식 모두 동작
- [ ] Discord "AAPL 얼마야?" → Finnhub primary, 실시간 시세
- [ ] Discord "SPY QQQ DIA 동시 비교" → rate limit 없이 3 종목 응답
- [ ] Discord "AAPL 뉴스" → sentiment 포함 뉴스 ≥ 5 건
- [ ] `!finclaw status` 에 4 provider 일일 사용량 표시
- [ ] Finnhub 60/min 한도 도달 시 키 rotation 으로 끊김 없음
- [ ] 모든 키 cooldown 시 DailyLimitExceededError → 한국어 안내
- [ ] 신규 단위 테스트 ≥ 30 케이스 (mock 기반, 실 키 불필요)
- [ ] build / lint / format / test 통과
- [ ] review.md 작성 + PR 머지

---

## 범위 외 (Phase 28+ 인계)

- **한국 시장** — KOSPI/KOSDAQ, KIS OpenAPI, 한국 RSS. Phase 27 시점엔 미국 주식만.
- **암호화폐** — 현행 CoinGecko 도구는 그대로 두되 **신규 작업 없음**. Binance WS 도 미진행.
- **외환** — Frankfurter 현행 유지, ExchangeRate-API 백업 추가 안 함.
- **WebSocket 실시간 시세** — Phase 28 의 Finnhub WS 통합 검토.
- **거래 API** — 모든 broker 의 매수/매도 API — 읽기 전용 원칙 영구 제외.
- **옵션 / 선물 / SEC 공시 / 펀더멘털** — 시세 + 뉴스만. 기업 정보 / 재무제표는 Phase 29+.

### 기존 코드 처리 (별도 결정)

현재 등록된 도구 중 Phase 27 범위 외:

- `get_crypto_price` (CoinGecko) — **유지** (사용자가 갑자기 BTC 물어봐도 동작)
- `get_forex_rate` (Frankfurter) — **유지** (USD/KRW 환율 등 미국 주식 사용자도 자주 사용)

→ 기존 도구 제거는 별도 PR. Phase 27 은 **추가만 하고 제거 안 함**.

---

## 부록: 사용자가 발급해야 할 무료 키

| 서비스        | 발급 페이지                                  | 권장 수량 | 비고                         |
| ------------- | -------------------------------------------- | --------- | ---------------------------- |
| Finnhub       | https://finnhub.io/register                  | 3         | 시세 + 뉴스 공유 (가장 중요) |
| Twelve Data   | https://twelvedata.com/                      | 3         | 시세 백업                    |
| Alpha Vantage | https://www.alphavantage.co/support/#api-key | 3         | 현행 1 → 3 으로 확장         |
| NewsData.io   | https://newsdata.io/register                 | 3         | 영문 뉴스                    |
| GNews (옵션)  | https://gnews.io/register                    | 3         | 추가 뉴스 백업 (선택)        |

**총 12~15 개 키. 사용자 발급 작업: ~20 분.** 모두 즉시 발급, 승인 대기 없음.

---

## 부록: 약관 / 합법성 점검

- ✅ Finnhub, Twelve Data, NewsData.io, GNews — 약관상 개인 비상업 사용 명시 허용
- ✅ Alpha Vantage — 이미 사용 중, 동일
- ❌ ~~Yahoo Finance 비공식~~ — 약관 위반 위험으로 제외
- ✅ 본 phase 는 **합법 무료 API 만 사용**. 회색 지대 옵션은 채택하지 않음.
