# Phase 16 Review: 금융 스킬 — 시장 데이터

> todo.md 기반 구현 코드 리뷰. 구현 완료 상태, 코드 품질 이슈, 리팩토링 사항을 기록한다.

---

## 1. TODO 대비 구현 완료 상태

### 사전 작업 (P-1 ~ P-3)

| 단계 | 파일                                 | 상태    | 비고                                                                        |
| ---- | ------------------------------------ | ------- | --------------------------------------------------------------------------- |
| P-1  | `storage/src/tables/market-cache.ts` | ✅ 완료 | `getStaleCachedData` 추가, todo.md 코드와 일치                              |
| P-1  | `storage/src/index.ts`               | ✅ 완료 | barrel export에 `getCachedData`, `setCachedData`, `getStaleCachedData` 추가 |
| P-2  | `skills-finance/package.json`        | ✅ 완료 | `@finclaw/agent`, `@finclaw/infra`, `zod` 의존성 추가                       |
| P-3  | `skills-finance/tsconfig.json`       | ✅ 완료 | `../infra`, `../agent` references 추가                                      |

### 구현 (Step 1 ~ 10)

| 단계    | 파일                                | 상태    | 비고                                                                                                   |
| ------- | ----------------------------------- | ------- | ------------------------------------------------------------------------------------------------------ |
| Step 1  | `market/types.ts`                   | ✅ 완료 | todo.md 코드와 일치. import 경로만 `@finclaw/types/finance.js` → `@finclaw/types`로 변경 (올바른 수정) |
| Step 2  | `market/provider-registry.ts`       | ✅ 완료 | `createDefaultRegistry`에 `async` 추가 (todo.md 주의사항 반영). import 경로 동일하게 수정              |
| Step 3  | `market/providers/frankfurter.ts`   | ✅ 완료 | todo.md 코드와 일치                                                                                    |
| Step 4  | `market/providers/coingecko.ts`     | ✅ 완료 | todo.md 코드와 일치                                                                                    |
| Step 5  | `market/providers/alpha-vantage.ts` | ✅ 완료 | todo.md 코드와 일치                                                                                    |
| Step 6  | `market/normalizer.ts`              | ✅ 완료 | Zod 스키마 기반 정규화. import `zod/v4` 사용                                                           |
| Step 7  | `market/cache.ts`                   | ✅ 완료 | MarketCache + RateLimiter 구현, graceful degradation 포함                                              |
| Step 8  | `market/charts.ts`                  | ✅ 완료 | 스파크라인 생성, 리샘플링, 통화 포맷                                                                   |
| Step 9  | `market/formatters.ts`              | ✅ 완료 | 시세/환율/차트 포맷팅                                                                                  |
| Step 10 | `market/index.ts`                   | ✅ 완료 | 4개 도구 등록, 스킬 메타데이터 export                                                                  |
| —       | `src/index.ts`                      | ✅ 완료 | barrel export 업데이트                                                                                 |

### 테스트 (T-1 ~ T-4)

| 단계 | 파일                                     | 상태    | 비고                                                  |
| ---- | ---------------------------------------- | ------- | ----------------------------------------------------- |
| T-1  | `market/normalizer.test.ts`              | ✅ 완료 | AV/CoinGecko/Frankfurter 정규화 + 에러 케이스         |
| T-2  | `market/cache.test.ts`                   | ✅ 완료 | 캐시 HIT/MISS, stale fallback, 일별 한도, RateLimiter |
| T-3  | `market/charts.test.ts`                  | ✅ 완료 | 빈 배열, 상승/하락 추세, width, 리샘플링              |
| T-4  | `market/providers/alpha-vantage.test.ts` | ✅ 완료 | supports, getQuote, rate limit, getHistorical         |

**결론:** 모든 단계(P-1~P-3, Step 1~10, T-1~T-4) 구현 완료. 14개 소스 파일 + 4개 테스트 파일 = 18개 파일.

---

## 2. 코드 품질 이슈

### I-1. [High] index.ts — 도구 executor에 try-catch 없음

**위치:** `market/index.ts:97-100`, `:122-125`, `:148-153`, `:182-187`

모든 도구 executor가 `getQuoteFromState` / `getChartFromState`를 직접 호출하며 try-catch가 없다. API 에러나 `No provider found` 에러가 unhandled rejection으로 전파된다.

```typescript
// AS-IS (index.ts:97-100)
const executor: ToolExecutor = async (input) => {
  const quote = await getQuoteFromState(state, input.symbol as string);
  return { content: formatQuote(quote), isError: false };
};
```

에이전트 도구 실행기는 `{ content: string, isError: true }`를 반환하여 에러를 사용자에게 표시해야 한다. 현재 구현에서는 에러가 executor 밖으로 전파되므로, ToolRegistry의 에러 핸들링 정책에 따라 다르지만 최소한 사용자 친화적 에러 메시지를 반환하는 것이 바람직하다.

**수정:** 각 executor를 try-catch로 감싸서 `{ content: error.message, isError: true }`를 반환.

---

### I-2. [High] cache.ts:59-63 — 심볼 타입 추론 휴리스틱이 fragile

**위치:** `market/cache.ts:59-63`

```typescript
const ttl = symbol.includes('/')
  ? CACHE_TTL.FOREX
  : /^[A-Z]{1,5}$/.test(symbol)
    ? CACHE_TTL.QUOTE
    : CACHE_TTL.CRYPTO;
```

심볼 문자열 패턴으로 TTL을 결정하는 로직이 fragile하다:

- `GOOGL`은 5글자이므로 QUOTE, 그러나 `MATIC`(5글자)은 암호화폐 — 패턴이 동일
- 마켓 접미사(`SMSN.KS`)가 포함된 주식 심볼은 CRYPTO TTL을 받게 됨

`provider.id`가 이미 `getQuote()` 파라미터로 전달되고 있으므로, provider.id 기반으로 TTL을 결정하는 것이 정확하다.

**수정:**

```typescript
const ttlMap: Record<string, number> = {
  'alpha-vantage': CACHE_TTL.QUOTE,
  coingecko: CACHE_TTL.CRYPTO,
  frankfurter: CACHE_TTL.FOREX,
};
const ttl = ttlMap[provider.id] ?? CACHE_TTL.QUOTE;
```

---

### I-3. [Medium] charts.ts + formatters.ts — `formatCurrency` / `formatPrice` 함수 중복

**위치:** `market/charts.ts:85-106` vs `market/formatters.ts:44-65`

두 함수의 로직이 완전히 동일하다:

- 통화 심볼 매핑 (`USD: '$'`, `KRW: '₩'`, ...)
- 크기별 포맷팅 (`>=1M → 'M'`, `>=1K → 'K'`, `<1 → 6자리`, 기본 2자리`)

DRY 위반.

**수정:** `formatters.ts`의 `formatPrice`를 export하고, `charts.ts`에서 import하여 사용. `charts.ts`의 로컬 `formatCurrency` 함수 제거.

---

### I-4. [Medium] normalizer.ts:163 — `response.raw as Record<...>` loose 캐스트

**위치:** `market/normalizer.ts:163`

```typescript
function normalizeAlphaVantageHistorical(response: ProviderHistoricalResponse): MarketHistorical {
  const data = response.raw as Record<string, Record<string, Record<string, string>>>;
```

Alpha Vantage historical 응답에 대해 Zod validation 없이 `as` 캐스트만 사용한다. Quote 정규화(`normalizeAlphaVantageQuote`)에서는 `AVGlobalQuoteSchema.safeParse`를 쓰고 있으므로 일관성이 없다.

동일 파일의 `:193`도 동일한 문제:

```typescript
function normalizeCoinGeckoHistorical(response: ProviderHistoricalResponse): MarketHistorical {
  const data = response.raw as { prices: Array<[number, number]>; ... };
```

잘못된 응답이 들어오면 런타임에 `undefined` 접근 에러가 발생할 수 있다.

**수정:** historical 응답용 Zod 스키마를 정의하고 `safeParse`로 검증.

---

### I-5. [Medium] index.ts:59 — `normalize()` 호출 시 ad-hoc 타입 강제 캐스트

**위치:** `market/index.ts:59`

```typescript
(raw) => normalizeQuote(raw as { raw: unknown; symbol: typeof symbol; provider: string }),
```

`MarketCache.getQuote`의 `normalize` 콜백에서 `raw` 파라미터(`unknown`)를 `ProviderQuoteResponse`로 캐스트한다. 그러나 `raw`는 실제로 `provider.getQuote(symbol)`의 반환값이 아니라, 그 안의 `raw` 필드도 아닌 전체 응답 객체이다.

`MarketCache.getQuote`에서 `provider.getQuote(symbol)`이 반환하는 값이 바로 `raw`로 전달되므로, `normalize` 콜백의 시그니처를 `(raw: unknown) => ProviderMarketQuote`에서 `(response: ProviderQuoteResponse) => ProviderMarketQuote`로 변경하거나, cache.ts 내부에서 타입을 맞추는 것이 낫다.

---

### I-6. [Low] charts.ts:51, formatters.ts:10,17,35 — 불필요한 `as string` 캐스트

**위치:** 여러 곳

```typescript
// charts.ts:51
formatCurrency(latest.close, currency as string);

// formatters.ts:10
const price = formatPrice(quote.price, quote.currency as string);

// formatters.ts:35
const [from, to] = (quote.symbol as string).split('/');
```

`CurrencyCode`와 `TickerSymbol`은 `string`의 branded type이므로 `as string` 없이 `string`을 요구하는 함수에 전달 가능하다. 단, 브랜드 타입의 구현에 따라 필요할 수 있으므로 확인 필요.

---

### I-7. [Low] cache.ts:137 — RateLimiter의 +100ms 매직 넘버

**위치:** `market/cache.ts:137`

```typescript
const waitMs = Math.max(50, oldestInWindow + this.config.windowMs - now + 100);
```

`+100ms`가 왜 필요한지 주석이 없다. jitter나 클록 정밀도 보정이라면 그 의도를 명시해야 한다.

---

## 3. 리팩토링 사항

### R-1. `formatCurrency`를 한 곳에서만 정의

`formatters.ts`의 `formatPrice`를 export하고, `charts.ts`에서 import하여 `formatCurrency` 로컬 함수를 제거한다. (I-3 해소)

변경 파일:

- `market/formatters.ts`: `formatPrice`를 `export function`으로 변경
- `market/charts.ts`: `import { formatPrice } from './formatters.js'` 추가, 로컬 `formatCurrency` 함수 삭제, 호출부를 `formatPrice`로 변경

---

### R-2. cache.ts TTL 선택을 provider.id 기반으로 변경

심볼 패턴 매칭(`/^[A-Z]{1,5}$/`) 대신 `provider.id`로 TTL을 결정한다. (I-2 해소)

변경 파일:

- `market/cache.ts:59-63`: provider.id → TTL 매핑으로 교체

---

### R-3. normalizer.ts historical 정규화에 Zod 스키마 적용

`normalizeAlphaVantageHistorical`과 `normalizeCoinGeckoHistorical`에서 `as` 캐스트 대신 Zod 스키마로 검증한다. (I-4 해소)

변경 파일:

- `market/normalizer.ts`: AV Time Series, CoinGecko market_chart 응답 스키마 추가 및 `safeParse` 적용

---

## 요약

| 구분           | 건수 | High | Medium | Low |
| -------------- | ---- | ---- | ------ | --- |
| 코드 품질 이슈 | 7    | 2    | 3      | 2   |
| 리팩토링 사항  | 3    | —    | —      | —   |

**전체 평가:** 모든 TODO 항목이 구현 완료되었고, todo.md의 코드와 높은 일치도를 보인다. import 경로를 `@finclaw/types/finance.js` → `@finclaw/types`로 적절히 수정한 점, `createDefaultRegistry`에 `async`를 추가한 점 등 todo.md의 주의사항이 반영되었다. High 이슈 2건(executor try-catch, TTL 휴리스틱)은 런타임 안정성에 직접 영향하므로 우선 수정이 필요하다.
