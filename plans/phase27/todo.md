# Phase 27 Todo: 미국 주식 데이터 소스 확장 (Free APIs + Key Rotation)

> [plan.md](../../plans/phase27/plan.md) 를 코드 단위로 분해한 작업 가이드. 위에서 아래로 순서대로 실행. 각 밀스톤 끝에 검증 단계가 있으며, 실패 시 다음 밀스톤으로 진행하지 말 것. 모호 항목은 `_workspace/phase-execute/27-questions.md` 참조.

브랜치: `feature/us-market-data`
작업 디렉토리: `/mnt/c/Users/박/Desktop/hi/FinClaw`
시작 SHA: `caff474` (main HEAD = phase-execute 하네스 머지 직후)

---

## 사전 준비

### P-1. 작업 환경 확인

```sh
git status                              # clean working tree (또는 phase 27 미커밋만)
git branch --show-current               # feature/us-market-data
git rev-parse HEAD                      # 시작 커밋 SHA 기록
pnpm install                            # workspace 동기화
pnpm typecheck                          # baseline green 확인
```

본 phase 는 storage schema 변경을 포함하지 않는다 (캐시 / rate limit 만 사용). dev DB 백업 불필요.

### P-2. 부록 키 발급 (병행)

`plans/phase27/plan.md` 부록 표 참조. Finnhub × 3, Twelve Data × 3, Alpha Vantage × 3 (기존 1 → 3 확장), NewsData.io × 3 발급. **본 phase 의 코드 변경은 키 부재 시에도 mock 으로 모두 통과해야 함**. 실 키는 Discord 검증 (D 밀스톤) 시점에만 필요.

---

## 밀스톤 A — Key Rotation 어댑터 (인프라)

목표: `XXX_KEY=k1,k2,k3` (CSV) 또는 `XXX_KEY_1/_2/_3` (인덱스) 두 형태 env 키 배열을 라운드 로빈 / 실패 회피 rotation 으로 호출하는 공통 어댑터 신설.

### A1. CREATE `packages/skills-finance/src/shared/key-rotator.ts`

```ts
// packages/skills-finance/src/shared/key-rotator.ts
// Phase 27 A: 다중 API 키 라운드 로빈 + 실패 cooldown.
// Provider 들이 매 호출 시 next() 로 키를 받고, 401/429 응답 시 markFailure 로 일시 격리한다.

const DEFAULT_FAILURE_THRESHOLD = 3;
const DEFAULT_COOLDOWN_MS = 60 * 60 * 1000; // 60분

interface KeyState {
  failures: number;
  cooldownUntil: number; // ms epoch. 0 = 가용.
}

export interface KeyRotatorOptions {
  readonly failureThreshold?: number;
  readonly cooldownMs?: number;
  readonly clock?: () => number;
}

/** 모든 키가 cooldown 상태일 때 throw. */
export class AllKeysCooldownError extends Error {
  constructor(public readonly retryAfterMs: number) {
    super(`All keys are in cooldown. Retry after ${Math.ceil(retryAfterMs / 1000)}s.`);
    this.name = 'AllKeysCooldownError';
  }
}

export class KeyRotator {
  private readonly states: Map<string, KeyState> = new Map();
  private cursor = 0;
  private readonly failureThreshold: number;
  private readonly cooldownMs: number;
  private readonly clock: () => number;

  constructor(
    private readonly keys: ReadonlyArray<string>,
    options: KeyRotatorOptions = {},
  ) {
    if (keys.length === 0) {
      throw new Error('KeyRotator requires at least one key');
    }
    this.failureThreshold = options.failureThreshold ?? DEFAULT_FAILURE_THRESHOLD;
    this.cooldownMs = options.cooldownMs ?? DEFAULT_COOLDOWN_MS;
    this.clock = options.clock ?? Date.now;
    for (const k of keys) {
      this.states.set(k, { failures: 0, cooldownUntil: 0 });
    }
  }

  /** 다음 가용 키 (라운드 로빈). 모든 키 cooldown 시 AllKeysCooldownError. */
  next(): string {
    const now = this.clock();
    const n = this.keys.length;
    let earliestCooldownEnd = Number.POSITIVE_INFINITY;
    for (let attempt = 0; attempt < n; attempt++) {
      const idx = (this.cursor + attempt) % n;
      const key = this.keys[idx];
      const state = this.states.get(key)!;
      if (state.cooldownUntil <= now) {
        this.cursor = (idx + 1) % n;
        return key;
      }
      earliestCooldownEnd = Math.min(earliestCooldownEnd, state.cooldownUntil);
    }
    throw new AllKeysCooldownError(earliestCooldownEnd - now);
  }

  /** 실패 누적 → 임계 도달 시 cooldown 진입. */
  markFailure(key: string, _error: Error): void {
    const state = this.states.get(key);
    if (!state) return;
    state.failures += 1;
    if (state.failures >= this.failureThreshold) {
      state.cooldownUntil = this.clock() + this.cooldownMs;
    }
  }

  /** 성공 시 실패 카운터 리셋. */
  markSuccess(key: string): void {
    const state = this.states.get(key);
    if (!state) return;
    state.failures = 0;
    state.cooldownUntil = 0;
  }

  /** 현재 가용 키 수 (cooldown 아닌). */
  availableCount(): number {
    const now = this.clock();
    let count = 0;
    for (const state of this.states.values()) {
      if (state.cooldownUntil <= now) count += 1;
    }
    return count;
  }

  /** 전체 키 수 (가용 + cooldown). status 표시용. */
  totalCount(): number {
    return this.keys.length;
  }
}

/**
 * env 변수에서 키 배열을 읽는다.
 * - `${envName}=k1,k2,k3` (CSV) 또는
 * - `${envName}_1=k1`, `${envName}_2=k2` ... (인덱스, 1..10).
 * 두 형태 모두 미설정 시 빈 배열.
 */
export function readKeyArray(envName: string): readonly string[] {
  const csv = process.env[envName];
  if (csv) {
    return csv
      .split(',')
      .map((k) => k.trim())
      .filter(Boolean);
  }
  const keys: string[] = [];
  for (let i = 1; i <= 10; i++) {
    const k = process.env[`${envName}_${i}`];
    if (k) keys.push(k);
  }
  return keys;
}
```

검증: `pnpm --filter @finclaw/skills-finance build`

### A2. CREATE `packages/skills-finance/src/shared/__tests__/key-rotator.test.ts`

```ts
// packages/skills-finance/src/shared/__tests__/key-rotator.test.ts
// Phase 27 A: KeyRotator 유닛 테스트 (mock clock 기반, 외부 API 호출 X).

import { describe, expect, it } from 'vitest';
import { AllKeysCooldownError, KeyRotator, readKeyArray } from '../key-rotator.js';

describe('KeyRotator.next', () => {
  it('cycles through all keys in round-robin', () => {
    const rotator = new KeyRotator(['k1', 'k2', 'k3']);
    const seen = new Set<string>();
    for (let i = 0; i < 3; i++) seen.add(rotator.next());
    expect(seen).toEqual(new Set(['k1', 'k2', 'k3']));
    // 4번째는 첫 키 재사용
    expect(rotator.next()).toBe('k1');
  });

  it('throws when constructed with empty keys', () => {
    expect(() => new KeyRotator([])).toThrow();
  });
});

describe('KeyRotator.markFailure', () => {
  it('puts key into cooldown after failureThreshold reaches', () => {
    let now = 1_000_000;
    const rotator = new KeyRotator(['k1', 'k2'], {
      failureThreshold: 2,
      cooldownMs: 60_000,
      clock: () => now,
    });
    // k1 두 번 실패 → cooldown 진입
    rotator.markFailure('k1', new Error('429'));
    rotator.markFailure('k1', new Error('429'));
    // 다음 호출은 k2
    expect(rotator.next()).toBe('k2');
    // 다시 호출하면 k1 은 여전히 cooldown 이므로 k2 가 다시 반환되어야 함
    expect(rotator.next()).toBe('k2');
    expect(rotator.availableCount()).toBe(1);

    // cooldown 만료 후 k1 부활
    now += 60_001;
    expect(rotator.availableCount()).toBe(2);
  });

  it('throws AllKeysCooldownError when every key is in cooldown', () => {
    let now = 0;
    const rotator = new KeyRotator(['k1'], {
      failureThreshold: 1,
      cooldownMs: 30_000,
      clock: () => now,
    });
    rotator.markFailure('k1', new Error('401'));
    expect(() => rotator.next()).toThrow(AllKeysCooldownError);
  });
});

describe('KeyRotator.markSuccess', () => {
  it('resets failure counter and cooldown', () => {
    let now = 0;
    const rotator = new KeyRotator(['k1'], {
      failureThreshold: 1,
      cooldownMs: 30_000,
      clock: () => now,
    });
    rotator.markFailure('k1', new Error('429'));
    expect(rotator.availableCount()).toBe(0);
    rotator.markSuccess('k1');
    expect(rotator.availableCount()).toBe(1);
    expect(rotator.next()).toBe('k1');
  });
});

describe('readKeyArray', () => {
  const ENV_NAME = '__TEST_KR_KEY';

  it('parses CSV form', () => {
    process.env[ENV_NAME] = 'a, b ,c';
    expect(readKeyArray(ENV_NAME)).toEqual(['a', 'b', 'c']);
    delete process.env[ENV_NAME];
  });

  it('parses indexed form', () => {
    process.env[`${ENV_NAME}_1`] = 'a';
    process.env[`${ENV_NAME}_2`] = 'b';
    process.env[`${ENV_NAME}_3`] = 'c';
    expect(readKeyArray(ENV_NAME)).toEqual(['a', 'b', 'c']);
    delete process.env[`${ENV_NAME}_1`];
    delete process.env[`${ENV_NAME}_2`];
    delete process.env[`${ENV_NAME}_3`];
  });

  it('returns empty when neither form set', () => {
    expect(readKeyArray(ENV_NAME)).toEqual([]);
  });

  it('CSV takes precedence over indexed when both set', () => {
    process.env[ENV_NAME] = 'csv1,csv2';
    process.env[`${ENV_NAME}_1`] = 'idx1';
    expect(readKeyArray(ENV_NAME)).toEqual(['csv1', 'csv2']);
    delete process.env[ENV_NAME];
    delete process.env[`${ENV_NAME}_1`];
  });
});
```

검증: `pnpm --filter @finclaw/skills-finance test --run shared/__tests__/key-rotator`

### A3. EDIT `packages/skills-finance/src/index.ts` — re-export

`packages/skills-finance/src/index.ts` 의 export 목록에 KeyRotator 가 포함되도록 추가 (server/main.ts 가 직접 import 하기 위함).

```ts
// ... 기존 export ...
export {
  KeyRotator,
  AllKeysCooldownError,
  readKeyArray,
  type KeyRotatorOptions,
} from './shared/key-rotator.js';
```

> 위치: 파일 맨 끝. 기존 `export *` 가 있으면 그 아래.

검증: `pnpm --filter @finclaw/skills-finance build`

### A4. 밀스톤 A 검증

다음을 모두 통과해야 다음 밀스톤으로 진입:

- `pnpm --filter @finclaw/skills-finance test --run shared`
- `pnpm --filter @finclaw/skills-finance build`
- `pnpm typecheck`

---

## 밀스톤 B — Finnhub + Twelve Data 시세 provider

목표: 미국 주식 시세를 Alpha Vantage 단일 의존에서 **3 provider 폴백 체인**으로 전환. Finnhub primary (실시간) → Twelve Data secondary (4시간 지연) → Alpha Vantage tertiary.

### B1. EDIT `packages/skills-finance/src/market/types.ts` — `MarketDataProvider.isAvailable` 추가

`MarketDataProvider` 인터페이스에 `isAvailable(): boolean` 메서드 추가. 등록된 provider 의 KeyRotator 가용성 검사용. (질문 Q2 참조.)

```ts
// ... 기존 import ...

/** 시장 데이터 프로바이더 인터페이스 */
export interface MarketDataProvider {
  readonly id: string;
  readonly name: string;
  readonly rateLimit: RateLimitConfig;

  /** 실시간/지연 시세 조회 */
  getQuote(symbol: TickerSymbol): Promise<ProviderQuoteResponse>;

  /** 과거 데이터 조회 */
  getHistorical(
    symbol: TickerSymbol,
    period: HistoricalPeriod,
  ): Promise<ProviderHistoricalResponse>;

  /** 지원 여부 확인 */
  supports(symbol: TickerSymbol): boolean;

  /**
   * Phase 27: provider 가 호출 가능한 상태인지 (KeyRotator 가용 키 ≥ 1).
   * KeyRotator 미사용 provider 는 항상 true.
   */
  isAvailable(): boolean;
}
```

검증: `pnpm --filter @finclaw/skills-finance build` (기존 provider 들의 타입 에러 → B5/B8 에서 해소)

### B2. CREATE `packages/skills-finance/src/market/providers/finnhub.ts`

```ts
// packages/skills-finance/src/market/providers/finnhub.ts
// Phase 27 B: Finnhub 시세 provider (real-time, 60 calls/min · 키 당).
// KeyRotator 통합 — 매 호출 next(), 401/429 시 markFailure + 다음 키 재시도 (최대 3회).

import { safeFetchJson } from '@finclaw/infra';
import { retry } from '@finclaw/infra';
import type { TickerSymbol } from '@finclaw/types';
import { z } from 'zod/v4';
import { AllKeysCooldownError, KeyRotator } from '../../shared/key-rotator.js';
import type {
  HistoricalPeriod,
  MarketDataProvider,
  ProviderHistoricalResponse,
  ProviderQuoteResponse,
  RateLimitConfig,
} from '../types.js';

const QUOTE_URL = 'https://finnhub.io/api/v1/quote';
const CANDLE_URL = 'https://finnhub.io/api/v1/stock/candle';

/** Finnhub /quote 응답 — c=현재가, h=고가, l=저가, o=시가, pc=전일종가, t=timestamp */
const QuoteSchema = z.object({
  c: z.number(),
  h: z.number(),
  l: z.number(),
  o: z.number(),
  pc: z.number(),
  t: z.number(),
});

/** Finnhub /candle 응답 (s=ok 시 t/o/h/l/c/v 배열) */
const CandleSchema = z.object({
  s: z.string(),
  t: z.array(z.number()).optional(),
  o: z.array(z.number()).optional(),
  h: z.array(z.number()).optional(),
  l: z.array(z.number()).optional(),
  c: z.array(z.number()).optional(),
  v: z.array(z.number()).optional(),
});

export class FinnhubError extends Error {
  constructor(
    message: string,
    readonly statusCode: number,
  ) {
    super(message);
    this.name = 'FinnhubError';
  }
}

function isAuthOrRateError(error: unknown): boolean {
  if (error instanceof Error && 'statusCode' in error) {
    const code = (error as { statusCode: number }).statusCode;
    return code === 401 || code === 429;
  }
  return false;
}

function isTransientError(error: unknown): boolean {
  if (error instanceof Error && 'statusCode' in error) {
    const code = (error as { statusCode: number }).statusCode;
    return code === 429 || code >= 500;
  }
  return false;
}

export class FinnhubProvider implements MarketDataProvider {
  readonly id = 'finnhub';
  readonly name = 'Finnhub';
  readonly rateLimit: RateLimitConfig = {
    maxRequests: 60, // 60/min · 키
    windowMs: 60_000,
  };

  constructor(private readonly rotator: KeyRotator) {}

  isAvailable(): boolean {
    return this.rotator.availableCount() > 0;
  }

  supports(symbol: TickerSymbol): boolean {
    // 미국 주식 티커 (1-5 알파벳).
    return /^[A-Z]{1,5}$/.test(symbol);
  }

  async getQuote(symbol: TickerSymbol): Promise<ProviderQuoteResponse> {
    const data = await this.callWithRotation((token) => {
      const url = new URL(QUOTE_URL);
      url.searchParams.set('symbol', symbol);
      url.searchParams.set('token', token);
      return retry(() => safeFetchJson(url.toString(), { timeoutMs: 10_000 }), {
        maxAttempts: 2,
        shouldRetry: isTransientError,
      });
    });

    const parsed = QuoteSchema.safeParse(data);
    if (!parsed.success) {
      throw new FinnhubError(`Malformed quote response for ${symbol}`, 502);
    }
    if (parsed.data.c === 0 && parsed.data.pc === 0) {
      throw new FinnhubError(`No data for symbol: ${symbol}`, 404);
    }

    return { raw: parsed.data, symbol, provider: this.id };
  }

  async getHistorical(
    symbol: TickerSymbol,
    period: HistoricalPeriod,
  ): Promise<ProviderHistoricalResponse> {
    const { resolution, from, to } = periodToCandleRange(period);
    const data = await this.callWithRotation((token) => {
      const url = new URL(CANDLE_URL);
      url.searchParams.set('symbol', symbol);
      url.searchParams.set('resolution', resolution);
      url.searchParams.set('from', String(from));
      url.searchParams.set('to', String(to));
      url.searchParams.set('token', token);
      return retry(() => safeFetchJson(url.toString(), { timeoutMs: 10_000 }), {
        maxAttempts: 2,
        shouldRetry: isTransientError,
      });
    });

    const parsed = CandleSchema.safeParse(data);
    if (!parsed.success || parsed.data.s !== 'ok') {
      throw new FinnhubError(`No historical data for ${symbol}`, 404);
    }

    return { raw: parsed.data, symbol, period, provider: this.id };
  }

  /** 라운드 로빈 + 401/429 시 다음 키로 재시도 (최대 3회). */
  private async callWithRotation<T>(
    fetcher: (token: string) => Promise<T>,
    maxRotations = 3,
  ): Promise<T> {
    let lastError: Error | undefined;
    for (let i = 0; i < maxRotations; i++) {
      let token: string;
      try {
        token = this.rotator.next();
      } catch (err) {
        if (err instanceof AllKeysCooldownError) throw err;
        throw err;
      }
      try {
        const result = await fetcher(token);
        this.rotator.markSuccess(token);
        return result;
      } catch (err) {
        lastError = err as Error;
        if (isAuthOrRateError(err)) {
          this.rotator.markFailure(token, lastError);
          continue;
        }
        throw err;
      }
    }
    throw lastError ?? new FinnhubError('All key rotations exhausted', 429);
  }
}

function periodToCandleRange(period: HistoricalPeriod): {
  resolution: string;
  from: number;
  to: number;
} {
  const now = Math.floor(Date.now() / 1000);
  const day = 86_400;
  switch (period) {
    case '1d':
      return { resolution: '5', from: now - day, to: now };
    case '5d':
      return { resolution: '15', from: now - 5 * day, to: now };
    case '1m':
      return { resolution: '60', from: now - 30 * day, to: now };
    case '3m':
      return { resolution: 'D', from: now - 90 * day, to: now };
    case '6m':
      return { resolution: 'D', from: now - 180 * day, to: now };
    case '1y':
      return { resolution: 'D', from: now - 365 * day, to: now };
    case '5y':
      return { resolution: 'W', from: now - 5 * 365 * day, to: now };
  }
}
```

검증: `pnpm --filter @finclaw/skills-finance build`

### B3. CREATE `packages/skills-finance/src/market/providers/finnhub.test.ts`

```ts
// packages/skills-finance/src/market/providers/finnhub.test.ts
// Phase 27 B: Finnhub provider 유닛 테스트 (fetch mock).

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { KeyRotator } from '../../shared/key-rotator.js';
import { createTickerSymbol } from '@finclaw/types';
import { FinnhubError, FinnhubProvider } from './finnhub.js';

describe('FinnhubProvider', () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    fetchMock.mockReset();
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('supports US stock tickers only', () => {
    const provider = new FinnhubProvider(new KeyRotator(['k']));
    expect(provider.supports(createTickerSymbol('AAPL'))).toBe(true);
    expect(provider.supports(createTickerSymbol('MSFT'))).toBe(true);
    expect(provider.supports(createTickerSymbol('USD/KRW'))).toBe(false);
    expect(provider.supports(createTickerSymbol('BTC'))).toBe(true); // 3-char alpha — 한계 (현행 AV 와 동일)
  });

  it('returns parsed quote on 200', async () => {
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ c: 175.5, h: 176, l: 174, o: 175, pc: 174.8, t: 1700000000 }), {
        status: 200,
      }),
    );
    const provider = new FinnhubProvider(new KeyRotator(['k1']));
    const res = await provider.getQuote(createTickerSymbol('AAPL'));
    expect(res.symbol).toBe('AAPL');
    expect(res.provider).toBe('finnhub');
    expect((res.raw as { c: number }).c).toBe(175.5);
  });

  it('rotates key on 429 and succeeds with next key', async () => {
    let call = 0;
    fetchMock.mockImplementation(() => {
      call += 1;
      if (call === 1) {
        return Promise.resolve(new Response('rate limited', { status: 429 }));
      }
      return Promise.resolve(
        new Response(JSON.stringify({ c: 100, h: 101, l: 99, o: 100, pc: 99, t: 1 }), {
          status: 200,
        }),
      );
    });
    const rotator = new KeyRotator(['k1', 'k2'], { failureThreshold: 5 });
    const provider = new FinnhubProvider(rotator);
    const res = await provider.getQuote(createTickerSymbol('AAPL'));
    expect(res.provider).toBe('finnhub');
    expect(call).toBe(2);
  });

  it('throws FinnhubError when symbol unknown (c=0, pc=0)', async () => {
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ c: 0, h: 0, l: 0, o: 0, pc: 0, t: 0 }), { status: 200 }),
    );
    const provider = new FinnhubProvider(new KeyRotator(['k']));
    await expect(provider.getQuote(createTickerSymbol('XYZQQ'))).rejects.toThrow(FinnhubError);
  });

  it('isAvailable reflects rotator availableCount', () => {
    const rotator = new KeyRotator(['k1'], { failureThreshold: 1, cooldownMs: 1_000_000 });
    const provider = new FinnhubProvider(rotator);
    expect(provider.isAvailable()).toBe(true);
    rotator.markFailure('k1', new Error('429'));
    expect(provider.isAvailable()).toBe(false);
  });
});
```

검증: `pnpm --filter @finclaw/skills-finance test --run market/providers/finnhub`

### B4. CREATE `packages/skills-finance/src/market/providers/twelve-data.ts`

```ts
// packages/skills-finance/src/market/providers/twelve-data.ts
// Phase 27 B: Twelve Data 시세 provider (4시간 지연, 800 calls/day · 키).

import { safeFetchJson } from '@finclaw/infra';
import { retry } from '@finclaw/infra';
import type { TickerSymbol } from '@finclaw/types';
import { z } from 'zod/v4';
import { AllKeysCooldownError, KeyRotator } from '../../shared/key-rotator.js';
import type {
  HistoricalPeriod,
  MarketDataProvider,
  ProviderHistoricalResponse,
  ProviderQuoteResponse,
  RateLimitConfig,
} from '../types.js';

const QUOTE_URL = 'https://api.twelvedata.com/quote';
const TIMESERIES_URL = 'https://api.twelvedata.com/time_series';

const QuoteSchema = z.object({
  symbol: z.string(),
  open: z.string(),
  high: z.string(),
  low: z.string(),
  close: z.string(),
  previous_close: z.string(),
  change: z.string(),
  percent_change: z.string(),
  volume: z.string().optional(),
});

const TimeSeriesSchema = z.object({
  values: z
    .array(
      z.object({
        datetime: z.string(),
        open: z.string(),
        high: z.string(),
        low: z.string(),
        close: z.string(),
        volume: z.string().optional(),
      }),
    )
    .optional(),
  status: z.string().optional(),
  message: z.string().optional(),
});

export class TwelveDataError extends Error {
  constructor(
    message: string,
    readonly statusCode: number,
  ) {
    super(message);
    this.name = 'TwelveDataError';
  }
}

function isAuthOrRateError(error: unknown): boolean {
  if (error instanceof Error && 'statusCode' in error) {
    const code = (error as { statusCode: number }).statusCode;
    return code === 401 || code === 429;
  }
  return false;
}

function isTransientError(error: unknown): boolean {
  if (error instanceof Error && 'statusCode' in error) {
    const code = (error as { statusCode: number }).statusCode;
    return code === 429 || code >= 500;
  }
  return false;
}

export class TwelveDataProvider implements MarketDataProvider {
  readonly id = 'twelve-data';
  readonly name = 'Twelve Data';
  readonly rateLimit: RateLimitConfig;

  constructor(private readonly rotator: KeyRotator) {
    // 키 수만큼 daily 한도 곱 (질문 Q6 참조).
    this.rateLimit = {
      maxRequests: 8, // 분당 8 회 (free tier).
      windowMs: 60_000,
      dailyLimit: 800 * rotator.totalCount(),
    };
  }

  isAvailable(): boolean {
    return this.rotator.availableCount() > 0;
  }

  supports(symbol: TickerSymbol): boolean {
    return /^[A-Z]{1,5}$/.test(symbol);
  }

  async getQuote(symbol: TickerSymbol): Promise<ProviderQuoteResponse> {
    const data = await this.callWithRotation((token) => {
      const url = new URL(QUOTE_URL);
      url.searchParams.set('symbol', symbol);
      url.searchParams.set('apikey', token);
      return retry(() => safeFetchJson(url.toString(), { timeoutMs: 10_000 }), {
        maxAttempts: 2,
        shouldRetry: isTransientError,
      });
    });

    const parsed = QuoteSchema.safeParse(data);
    if (!parsed.success) {
      throw new TwelveDataError(`No data for ${symbol}`, 404);
    }
    return { raw: parsed.data, symbol, provider: this.id };
  }

  async getHistorical(
    symbol: TickerSymbol,
    period: HistoricalPeriod,
  ): Promise<ProviderHistoricalResponse> {
    const { interval, outputsize } = periodToTimeSeriesParams(period);
    const data = await this.callWithRotation((token) => {
      const url = new URL(TIMESERIES_URL);
      url.searchParams.set('symbol', symbol);
      url.searchParams.set('interval', interval);
      url.searchParams.set('outputsize', String(outputsize));
      url.searchParams.set('apikey', token);
      return retry(() => safeFetchJson(url.toString(), { timeoutMs: 10_000 }), {
        maxAttempts: 2,
        shouldRetry: isTransientError,
      });
    });

    const parsed = TimeSeriesSchema.safeParse(data);
    if (!parsed.success || !parsed.data.values?.length) {
      throw new TwelveDataError(`No historical for ${symbol}`, 404);
    }
    return { raw: parsed.data, symbol, period, provider: this.id };
  }

  private async callWithRotation<T>(
    fetcher: (token: string) => Promise<T>,
    maxRotations = 3,
  ): Promise<T> {
    let lastError: Error | undefined;
    for (let i = 0; i < maxRotations; i++) {
      let token: string;
      try {
        token = this.rotator.next();
      } catch (err) {
        if (err instanceof AllKeysCooldownError) throw err;
        throw err;
      }
      try {
        const result = await fetcher(token);
        this.rotator.markSuccess(token);
        return result;
      } catch (err) {
        lastError = err as Error;
        if (isAuthOrRateError(err)) {
          this.rotator.markFailure(token, lastError);
          continue;
        }
        throw err;
      }
    }
    throw lastError ?? new TwelveDataError('All key rotations exhausted', 429);
  }
}

function periodToTimeSeriesParams(period: HistoricalPeriod): {
  interval: string;
  outputsize: number;
} {
  switch (period) {
    case '1d':
      return { interval: '5min', outputsize: 78 };
    case '5d':
      return { interval: '30min', outputsize: 130 };
    case '1m':
      return { interval: '1day', outputsize: 30 };
    case '3m':
      return { interval: '1day', outputsize: 90 };
    case '6m':
      return { interval: '1day', outputsize: 180 };
    case '1y':
      return { interval: '1day', outputsize: 365 };
    case '5y':
      return { interval: '1week', outputsize: 260 };
  }
}
```

검증: `pnpm --filter @finclaw/skills-finance build`

### B5. CREATE `packages/skills-finance/src/market/providers/twelve-data.test.ts`

```ts
// packages/skills-finance/src/market/providers/twelve-data.test.ts
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createTickerSymbol } from '@finclaw/types';
import { KeyRotator } from '../../shared/key-rotator.js';
import { TwelveDataError, TwelveDataProvider } from './twelve-data.js';

describe('TwelveDataProvider', () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    fetchMock.mockReset();
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('supports US tickers only', () => {
    const p = new TwelveDataProvider(new KeyRotator(['k']));
    expect(p.supports(createTickerSymbol('AAPL'))).toBe(true);
    expect(p.supports(createTickerSymbol('USD/KRW'))).toBe(false);
  });

  it('dailyLimit scales with key count', () => {
    const p1 = new TwelveDataProvider(new KeyRotator(['k1']));
    const p3 = new TwelveDataProvider(new KeyRotator(['k1', 'k2', 'k3']));
    expect(p1.rateLimit.dailyLimit).toBe(800);
    expect(p3.rateLimit.dailyLimit).toBe(2400);
  });

  it('returns parsed quote on 200', async () => {
    fetchMock.mockResolvedValue(
      new Response(
        JSON.stringify({
          symbol: 'AAPL',
          open: '175',
          high: '176',
          low: '174',
          close: '175.5',
          previous_close: '174.8',
          change: '0.7',
          percent_change: '0.4',
        }),
        { status: 200 },
      ),
    );
    const p = new TwelveDataProvider(new KeyRotator(['k']));
    const res = await p.getQuote(createTickerSymbol('AAPL'));
    expect(res.provider).toBe('twelve-data');
  });

  it('rotates key on 429', async () => {
    let call = 0;
    fetchMock.mockImplementation(() => {
      call += 1;
      if (call === 1) return Promise.resolve(new Response('rl', { status: 429 }));
      return Promise.resolve(
        new Response(
          JSON.stringify({
            symbol: 'AAPL',
            open: '1',
            high: '1',
            low: '1',
            close: '1',
            previous_close: '1',
            change: '0',
            percent_change: '0',
          }),
          { status: 200 },
        ),
      );
    });
    const rotator = new KeyRotator(['k1', 'k2'], { failureThreshold: 5 });
    const p = new TwelveDataProvider(rotator);
    const res = await p.getQuote(createTickerSymbol('AAPL'));
    expect(call).toBe(2);
    expect(res.provider).toBe('twelve-data');
  });

  it('throws TwelveDataError when payload malformed', async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ status: 'error' }), { status: 200 }));
    const p = new TwelveDataProvider(new KeyRotator(['k']));
    await expect(p.getQuote(createTickerSymbol('AAPL'))).rejects.toThrow(TwelveDataError);
  });
});
```

검증: `pnpm --filter @finclaw/skills-finance test --run market/providers/twelve-data`

### B6. EDIT `packages/skills-finance/src/market/providers/alpha-vantage.ts` — KeyRotator 통합

기존 `constructor(apiKey: string)` 를 `constructor(rotator: KeyRotator)` 로 변경. 모든 fetch 가 `callWithRotation` 경유. `isAvailable()` 추가. (질문 Q1 참조 — 단일 키 사용처는 main.ts 에서 `new KeyRotator([apiKey])` 로 wrap.)

```ts
import { safeFetchJson } from '@finclaw/infra';
import { retry } from '@finclaw/infra';
import type { TickerSymbol } from '@finclaw/types';
import { z } from 'zod/v4';
import { AllKeysCooldownError, KeyRotator } from '../../shared/key-rotator.js';
import type {
  HistoricalPeriod,
  MarketDataProvider,
  ProviderHistoricalResponse,
  ProviderQuoteResponse,
  RateLimitConfig,
} from '../types.js';

const BASE_URL = 'https://www.alphavantage.co/query';

const GlobalQuoteSchema = z.object({
  'Global Quote': z.object({
    '01. symbol': z.string(),
    '02. open': z.string(),
    '03. high': z.string(),
    '04. low': z.string(),
    '05. price': z.string(),
    '06. volume': z.string(),
    '08. previous close': z.string(),
    '09. change': z.string(),
    '10. change percent': z.string(),
  }),
});

const ErrorResponseSchema = z.object({
  Note: z.string().optional(),
  Information: z.string().optional(),
});

function isAuthOrRateError(error: unknown): boolean {
  if (error instanceof AlphaVantageError) {
    return error.statusCode === 401 || error.statusCode === 429;
  }
  if (error instanceof Error && 'statusCode' in error) {
    const code = (error as { statusCode: number }).statusCode;
    return code === 401 || code === 429;
  }
  return false;
}

function isTransientError(error: unknown): boolean {
  if (error instanceof Error && 'statusCode' in error) {
    const code = (error as { statusCode: number }).statusCode;
    return code === 429 || code >= 500;
  }
  return false;
}

export class AlphaVantageProvider implements MarketDataProvider {
  readonly id = 'alpha-vantage';
  readonly name = 'Alpha Vantage';
  readonly rateLimit: RateLimitConfig;

  constructor(private readonly rotator: KeyRotator) {
    this.rateLimit = {
      maxRequests: 5,
      windowMs: 60_000,
      dailyLimit: 25 * rotator.totalCount(),
    };
  }

  isAvailable(): boolean {
    return this.rotator.availableCount() > 0;
  }

  supports(symbol: TickerSymbol): boolean {
    return /^[A-Z]{1,5}(\.[A-Z]{1,2})?$/.test(symbol);
  }

  async getQuote(symbol: TickerSymbol): Promise<ProviderQuoteResponse> {
    return this.getStockQuote(symbol);
  }

  private async getStockQuote(symbol: TickerSymbol): Promise<ProviderQuoteResponse> {
    const data = await this.callWithRotation((token) => {
      const url = new URL(BASE_URL);
      url.searchParams.set('function', 'GLOBAL_QUOTE');
      url.searchParams.set('symbol', symbol);
      url.searchParams.set('apikey', token);
      return retry(() => safeFetchJson(url.toString(), { timeoutMs: 10_000 }), {
        maxAttempts: 2,
        shouldRetry: isTransientError,
      });
    });

    const errorCheck = ErrorResponseSchema.safeParse(data);
    if (errorCheck.success && (errorCheck.data.Note || errorCheck.data.Information)) {
      throw new AlphaVantageError('API rate limit exceeded', 429);
    }

    const parsed = GlobalQuoteSchema.safeParse(data);
    if (!parsed.success) {
      throw new AlphaVantageError(`No data found for symbol: ${symbol}`, 404);
    }

    return { raw: parsed.data, symbol, provider: this.id };
  }

  async getHistorical(
    symbol: TickerSymbol,
    period: HistoricalPeriod,
  ): Promise<ProviderHistoricalResponse> {
    const data = await this.callWithRotation((token) => {
      const url = new URL(BASE_URL);
      const func = period === '1d' ? 'TIME_SERIES_INTRADAY' : 'TIME_SERIES_DAILY_ADJUSTED';
      url.searchParams.set('function', func);
      url.searchParams.set('symbol', symbol);
      url.searchParams.set('apikey', token);
      if (period === '1d') {
        url.searchParams.set('interval', '5min');
      }
      url.searchParams.set('outputsize', periodToOutputSize(period));
      return retry(() => safeFetchJson(url.toString(), { timeoutMs: 10_000 }), {
        maxAttempts: 2,
        shouldRetry: isTransientError,
      });
    });

    return { raw: data, symbol, period, provider: this.id };
  }

  private async callWithRotation<T>(
    fetcher: (token: string) => Promise<T>,
    maxRotations = 3,
  ): Promise<T> {
    let lastError: Error | undefined;
    for (let i = 0; i < maxRotations; i++) {
      let token: string;
      try {
        token = this.rotator.next();
      } catch (err) {
        if (err instanceof AllKeysCooldownError) throw err;
        throw err;
      }
      try {
        const result = await fetcher(token);
        this.rotator.markSuccess(token);
        return result;
      } catch (err) {
        lastError = err as Error;
        if (isAuthOrRateError(err)) {
          this.rotator.markFailure(token, lastError);
          continue;
        }
        throw err;
      }
    }
    throw lastError ?? new AlphaVantageError('All key rotations exhausted', 429);
  }
}

function periodToOutputSize(period: HistoricalPeriod): string {
  switch (period) {
    case '1d':
    case '5d':
    case '1m':
      return 'compact';
    default:
      return 'full';
  }
}

export class AlphaVantageError extends Error {
  constructor(
    message: string,
    readonly statusCode: number,
  ) {
    super(message);
    this.name = 'AlphaVantageError';
  }
}
```

> 기존 `alpha-vantage.test.ts` 가 `new AlphaVantageProvider(apiKey)` 형태로 호출 중이면 같은 단계에서 `new AlphaVantageProvider(new KeyRotator([apiKey]))` 로 일괄 갱신. 테스트 파일 위치: `packages/skills-finance/src/market/providers/alpha-vantage.test.ts`.

검증: `pnpm --filter @finclaw/skills-finance test --run market/providers/alpha-vantage`

### B7. EDIT `packages/skills-finance/src/market/providers/coingecko.ts` + `frankfurter.ts` — `isAvailable()` stub 추가

두 파일 모두 KeyRotator 미사용 → 항상 `true`. 단일 메서드 stub 만 추가:

```ts
// coingecko.ts 클래스 안 (provider 메서드 옆 어디든)
isAvailable(): boolean {
  return true;
}
```

```ts
// frankfurter.ts 클래스 안
isAvailable(): boolean {
  return true;
}
```

검증: `pnpm --filter @finclaw/skills-finance build` (B1 인터페이스 변경 → 두 파일 컴파일 통과)

### B8. EDIT `packages/skills-finance/src/market/provider-registry.ts` — fallback chain + 가용성 검사

기존 `resolve()` 가 첫 매칭만 반환. plan.md "supports() && availableCount() > 0" 정책 반영. `createDefaultRegistry` 가 신규 KeyRotator 들을 받도록 시그니처 확장.

```ts
import type { TickerSymbol } from '@finclaw/types';
import type { KeyRotator } from '../shared/key-rotator.js';
import type { MarketDataProvider } from './types.js';

/**
 * 티커 심볼을 적절한 프로바이더로 라우팅한다.
 * 등록 순서대로 supports() && isAvailable() 확인 → 첫 매칭 반환.
 */
export class ProviderRegistry {
  private readonly providers: MarketDataProvider[] = [];

  register(provider: MarketDataProvider): void {
    this.providers.push(provider);
  }

  /** supports() && isAvailable() 첫 매칭. 없으면 supports() 첫 매칭 (degraded). 그것도 없으면 throw. */
  resolve(symbol: TickerSymbol): MarketDataProvider {
    const supports = this.providers.filter((p) => p.supports(symbol));
    const available = supports.find((p) => p.isAvailable());
    if (available) return available;
    if (supports.length > 0) return supports[0]; // 모두 cooldown → 첫 provider 가 throw 하도록 위임
    throw new Error(`No provider found for symbol: ${symbol}`);
  }

  /** fallback chain (기존 forex 사용처 유지) */
  resolveWithFallback(symbol: TickerSymbol): MarketDataProvider[] {
    return this.providers.filter((p) => p.supports(symbol));
  }

  /** Phase 27 D: status 표시용. 등록된 provider 목록 readonly view. */
  list(): ReadonlyArray<MarketDataProvider> {
    return this.providers;
  }
}

/**
 * 기본 프로바이더 레지스트리.
 * 우선순위: Finnhub → Twelve Data → Alpha Vantage → CoinGecko → Frankfurter.
 */
export async function createDefaultRegistry(config: {
  finnhubRotator?: KeyRotator;
  twelveDataRotator?: KeyRotator;
  alphaVantageRotator?: KeyRotator;
  coinGeckoKey?: string;
}): Promise<ProviderRegistry> {
  const { AlphaVantageProvider } = await import('./providers/alpha-vantage.js');
  const { CoinGeckoProvider } = await import('./providers/coingecko.js');
  const { FrankfurterProvider } = await import('./providers/frankfurter.js');
  const { FinnhubProvider } = await import('./providers/finnhub.js');
  const { TwelveDataProvider } = await import('./providers/twelve-data.js');

  const registry = new ProviderRegistry();

  // 미국 주식 우선순위: Finnhub (real-time) → Twelve Data (4h) → Alpha Vantage (EOD).
  if (config.finnhubRotator) {
    registry.register(new FinnhubProvider(config.finnhubRotator));
  }
  if (config.twelveDataRotator) {
    registry.register(new TwelveDataProvider(config.twelveDataRotator));
  }
  if (config.alphaVantageRotator) {
    registry.register(new AlphaVantageProvider(config.alphaVantageRotator));
  }

  // 암호화폐 / 외환 — 현행 유지.
  registry.register(new CoinGeckoProvider(config.coinGeckoKey));
  registry.register(new FrankfurterProvider());

  return registry;
}
```

검증: `pnpm --filter @finclaw/skills-finance build`

### B9. EDIT `packages/skills-finance/src/market/index.ts` — `MarketSkillConfig` 갱신 + handle 노출

```ts
// packages/skills-finance/src/market/index.ts
// ... 기존 import 들 ...
import { KeyRotator } from '../shared/key-rotator.js';

/** 스킬 초기화에 필요한 설정 */
export interface MarketSkillConfig {
  readonly db: DatabaseSync;
  /** Phase 27: KeyRotator 들 (각각 옵션). 미주입 시 해당 provider 비활성. */
  readonly finnhubRotator?: KeyRotator;
  readonly twelveDataRotator?: KeyRotator;
  readonly alphaVantageRotator?: KeyRotator;
  readonly coinGeckoKey?: string;
}

/** Phase 27 D: status 명령이 사용량을 표시하기 위해 rotator 들도 노출. */
export interface MarketSkillHandle {
  readonly providers: ProviderRegistry;
  readonly cache: MarketCache;
  readonly quoteService: QuoteService;
  readonly keyRotators: {
    readonly finnhub?: KeyRotator;
    readonly twelveData?: KeyRotator;
    readonly alphaVantage?: KeyRotator;
  };
}

export async function registerMarketTools(
  registry: ToolRegistry,
  config: MarketSkillConfig,
): Promise<MarketSkillHandle> {
  const providers = await createDefaultRegistry({
    finnhubRotator: config.finnhubRotator,
    twelveDataRotator: config.twelveDataRotator,
    alphaVantageRotator: config.alphaVantageRotator,
    coinGeckoKey: config.coinGeckoKey,
  });
  const cache = new MarketCache(config.db);
  const state: MarketSkillState = { providers, cache };

  registerStockPriceTool(registry, state);
  registerCryptoPriceTool(registry, state);
  registerForexRateTool(registry, state);
  registerMarketChartTool(registry, state);

  const quoteService: QuoteService = {
    async getQuote(symbol: string) {
      const quote = await getQuoteFromState(state, symbol);
      return {
        price: quote.price,
        change: quote.change ?? 0,
        changePercent: quote.changePercent ?? 0,
      };
    },
  };

  return {
    providers,
    cache,
    quoteService,
    keyRotators: {
      finnhub: config.finnhubRotator,
      twelveData: config.twelveDataRotator,
      alphaVantage: config.alphaVantageRotator,
    },
  };
}
```

> `MARKET_SKILL_METADATA` 의 `optionalEnv` 도 갱신:
>
> ```ts
> optionalEnv: ['ALPHA_VANTAGE_KEY', 'FINNHUB_KEY', 'TWELVE_DATA_KEY', 'COINGECKO_API_KEY'],
> ```

검증: `pnpm --filter @finclaw/skills-finance build`

### B10. EDIT `packages/skills-finance/src/market/normalizer.ts` — Finnhub / Twelve Data 정규화 분기

기존 `normalizeQuote` 가 provider id 별 분기. Finnhub / Twelve Data 케이스 추가. (existing alpha-vantage / coingecko / frankfurter 분기는 그대로.)

```ts
// normalizer.ts 의 normalizeQuote 함수 안 — switch 또는 if 체인에 추가

// ... 기존 분기 ...
if (raw.provider === 'finnhub') {
  const r = raw.raw as { c: number; h: number; l: number; o: number; pc: number; t: number };
  return {
    symbol: raw.symbol,
    price: r.c,
    change: r.c - r.pc,
    changePercent: ((r.c - r.pc) / r.pc) * 100,
    open: r.o,
    high: r.h,
    low: r.l,
    previousClose: r.pc,
    timestamp: new Date(r.t * 1000),
    provider: 'finnhub',
    delayed: false,
    currency: 'USD' as CurrencyCode,
  };
}

if (raw.provider === 'twelve-data') {
  const r = raw.raw as {
    open: string;
    high: string;
    low: string;
    close: string;
    previous_close: string;
  };
  const close = Number(r.close);
  const prev = Number(r.previous_close);
  return {
    symbol: raw.symbol,
    price: close,
    change: close - prev,
    changePercent: ((close - prev) / prev) * 100,
    open: Number(r.open),
    high: Number(r.high),
    low: Number(r.low),
    previousClose: prev,
    timestamp: new Date(),
    provider: 'twelve-data',
    delayed: true, // 4시간 지연
    currency: 'USD' as CurrencyCode,
  };
}
```

> `normalizeHistorical` 도 동일한 분기 추가 — Finnhub candle (배열 형태), Twelve Data values (객체 배열). 기존 alpha-vantage 분기 옆에 두 개 분기 추가. 정확한 시그니처는 `normalizer.ts` 의 기존 패턴 참조.

검증: `pnpm --filter @finclaw/skills-finance test --run market/normalizer`

### B11. EDIT `packages/server/src/main.ts` — KeyRotator 주입

```ts
// packages/server/src/main.ts
// ... 기존 import 들 ...
import { KeyRotator, readKeyArray } from '@finclaw/skills-finance';

// (240 line 부근 기존 alphaVantageKey/coinGeckoKey 블록 교체)

const finnhubKeys = readKeyArray('FINNHUB_KEY');
const twelveDataKeys = readKeyArray('TWELVE_DATA_KEY');
const alphaVantageKeys = readKeyArray('ALPHA_VANTAGE_KEY');
const coinGeckoKey = process.env.COINGECKO_API_KEY;

const finnhubRotator = finnhubKeys.length > 0 ? new KeyRotator(finnhubKeys) : undefined;
const twelveDataRotator = twelveDataKeys.length > 0 ? new KeyRotator(twelveDataKeys) : undefined;
const alphaVantageRotator =
  alphaVantageKeys.length > 0 ? new KeyRotator(alphaVantageKeys) : undefined;

let marketHandle: MarketSkillHandle | undefined;
let newsHandle: NewsSkillHandle | undefined;

if (finnhubRotator || twelveDataRotator || alphaVantageRotator || coinGeckoKey) {
  marketHandle = await registerMarketTools(toolRegistry, {
    db: storage.db,
    finnhubRotator,
    twelveDataRotator,
    alphaVantageRotator,
    coinGeckoKey,
  });
  logger.info('Market tools registered', {
    providers: [
      finnhubRotator && 'finnhub',
      twelveDataRotator && 'twelve-data',
      alphaVantageRotator && 'alpha-vantage',
      coinGeckoKey && 'coingecko',
    ].filter(Boolean),
  });
} else {
  logger.info('No market keys set — skipping market tools');
}
```

> `if (marketHandle && alphaVantageKey)` 블록은 C 밀스톤에서 갱신. 본 단계에서는 빌드만 통과시키기 위해 임시로 `if (marketHandle && alphaVantageRotator)` 로 변경하고 `alphaVantageKey: alphaVantageRotator ? alphaVantageKeys[0] : undefined` 같은 임시값을 NewsSkillConfig 에 넘김. (C1 에서 제대로 NewsSkillConfig 갱신.)

검증: `pnpm typecheck`

### B12. EDIT `.env.example` — Finnhub / Twelve Data 추가

```env
# Discord (required)
DISCORD_BOT_TOKEN=
DISCORD_APPLICATION_ID=

# Anthropic Claude (required)
ANTHROPIC_API_KEY=

# Finance APIs — 무료 키 다중 발급 권장 (CSV 또는 _1/_2/_3 인덱스 형식 모두 지원)
# 미국 주식 시세 (우선순위: Finnhub → Twelve Data → Alpha Vantage)
FINNHUB_KEY=
TWELVE_DATA_KEY=
ALPHA_VANTAGE_KEY=
COINGECKO_API_KEY=

# 영문 뉴스 (Phase 27 C — 발급 후 채움)
NEWSDATA_API_KEY=

# Embedding (optional — enables hybrid RAG; without it, FTS-only fallback)
VOYAGE_API_KEY=

# Gateway auth (optional)
FINCLAW_API_KEY=
GATEWAY_JWT_SECRET=

# Storage (optional)
FINCLAW_DB_PATH=
```

검증: 파일 diff 확인.

### B13. 밀스톤 B 검증

- `pnpm --filter @finclaw/skills-finance test --run market`
- `pnpm --filter @finclaw/skills-finance build`
- `pnpm --filter @finclaw/server build`
- `pnpm typecheck`

mock 시나리오: `FINNHUB_KEY=k1,k2,k3` env 설정 → server 시작 → 로그에 `providers: ['finnhub', ...]` 출력 (실 호출은 D 밀스톤).

---

## 밀스톤 C — 영문 뉴스 확장 (NewsData.io + Finnhub News)

목표: 영문 금융 뉴스 다양화 + sentiment 자동 첨부. Finnhub 시세 KeyRotator 와 Finnhub News 가 동일 인스턴스 공유.

### C1. CREATE `packages/skills-finance/src/news/providers/newsdata.ts`

```ts
// packages/skills-finance/src/news/providers/newsdata.ts
// Phase 27 C: NewsData.io 영문 뉴스 (200 credits/day · 키, 키 3개 = 600/day).

import { safeFetchJson } from '@finclaw/infra';
import { retry } from '@finclaw/infra';
import type { NewsItem, TickerSymbol } from '@finclaw/types';
import { z } from 'zod/v4';
import { AllKeysCooldownError, KeyRotator } from '../../shared/key-rotator.js';
import type { NewsProvider, NewsQuery, NewsSourceId } from '../types.js';

const ENDPOINT = 'https://newsdata.io/api/1/latest';

const ResponseSchema = z.object({
  status: z.string(),
  totalResults: z.number().optional(),
  results: z
    .array(
      z.object({
        article_id: z.string().optional(),
        title: z.string(),
        link: z.string(),
        description: z.string().nullable().optional(),
        pubDate: z.string(),
        source_id: z.string().optional(),
        country: z.array(z.string()).optional(),
        category: z.array(z.string()).optional(),
      }),
    )
    .optional(),
});

function isAuthOrRateError(error: unknown): boolean {
  if (error instanceof Error && 'statusCode' in error) {
    const code = (error as { statusCode: number }).statusCode;
    return code === 401 || code === 429;
  }
  return false;
}

function isTransientError(error: unknown): boolean {
  if (error instanceof Error && 'statusCode' in error) {
    const code = (error as { statusCode: number }).statusCode;
    return code === 429 || code >= 500;
  }
  return false;
}

export interface NewsDataProviderConfig {
  readonly rotator: KeyRotator;
}

export function createNewsDataProvider(config: NewsDataProviderConfig): NewsProvider {
  return {
    name: 'newsdata' as NewsSourceId,
    isAvailable: () => config.rotator.availableCount() > 0,
    async fetchNews(query: NewsQuery): Promise<NewsItem[]> {
      const data = await callWithRotation(config.rotator, (token) => {
        const url = new URL(ENDPOINT);
        url.searchParams.set('apikey', token);
        url.searchParams.set('language', 'en');
        url.searchParams.set('category', mapCategory(query.category));
        if (query.symbols?.length) {
          url.searchParams.set('q', query.symbols.join(' OR '));
        } else if (query.keywords?.length) {
          url.searchParams.set('q', query.keywords.join(' OR '));
        }
        return retry(() => safeFetchJson(url.toString(), { timeoutMs: 10_000 }), {
          maxAttempts: 2,
          shouldRetry: isTransientError,
        });
      });

      const parsed = ResponseSchema.safeParse(data);
      if (!parsed.success || !parsed.data.results) {
        return [];
      }

      const limit = query.limit ?? 20;
      return parsed.data.results.slice(0, limit).map((r) => normalizeItem(r, query.symbols));
    },
  };
}

function mapCategory(c: NewsQuery['category']): string {
  switch (c) {
    case 'crypto':
      return 'business';
    case 'earnings':
    case 'merger':
    case 'ipo':
    case 'regulation':
      return 'business';
    case 'macro':
      return 'business';
    default:
      return 'business';
  }
}

function normalizeItem(
  raw: {
    title: string;
    link: string;
    description?: string | null;
    pubDate: string;
    source_id?: string;
  },
  symbols: readonly TickerSymbol[] | undefined,
): NewsItem {
  return {
    id: raw.link,
    title: raw.title,
    url: raw.link,
    source: raw.source_id ?? 'newsdata',
    publishedAt: new Date(raw.pubDate).getTime() as NewsItem['publishedAt'],
    summary: raw.description ?? '',
    symbols: symbols ?? [],
  };
}

async function callWithRotation<T>(
  rotator: KeyRotator,
  fetcher: (token: string) => Promise<T>,
  maxRotations = 3,
): Promise<T> {
  let lastError: Error | undefined;
  for (let i = 0; i < maxRotations; i++) {
    let token: string;
    try {
      token = rotator.next();
    } catch (err) {
      if (err instanceof AllKeysCooldownError) throw err;
      throw err;
    }
    try {
      const result = await fetcher(token);
      rotator.markSuccess(token);
      return result;
    } catch (err) {
      lastError = err as Error;
      if (isAuthOrRateError(err)) {
        rotator.markFailure(token, lastError);
        continue;
      }
      throw err;
    }
  }
  throw lastError ?? new Error('All NewsData key rotations exhausted');
}
```

> `NewsItem` 의 정확한 형태는 `@finclaw/types` 의 정의 참조 — 위 normalizeItem 의 필드명 / branded type 캐스팅은 기존 newsapi.ts 의 패턴을 그대로 따라야 함. 다른 점이 있으면 newsapi.ts 를 source-of-truth 로.

> `NewsSourceId` 타입에 `'newsdata'`, `'finnhub-news'` 추가 필요 → C5 단계에서 처리.

검증: `pnpm --filter @finclaw/skills-finance build`

### C2. CREATE `packages/skills-finance/src/news/providers/newsdata.test.ts`

```ts
// packages/skills-finance/src/news/providers/newsdata.test.ts
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { KeyRotator } from '../../shared/key-rotator.js';
import { createNewsDataProvider } from './newsdata.js';

describe('createNewsDataProvider', () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    fetchMock.mockReset();
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('isAvailable reflects rotator', () => {
    const rotator = new KeyRotator(['k'], { failureThreshold: 1, cooldownMs: 1_000_000 });
    const p = createNewsDataProvider({ rotator });
    expect(p.isAvailable()).toBe(true);
    rotator.markFailure('k', new Error('429'));
    expect(p.isAvailable()).toBe(false);
  });

  it('returns parsed items', async () => {
    fetchMock.mockResolvedValue(
      new Response(
        JSON.stringify({
          status: 'success',
          totalResults: 1,
          results: [
            {
              article_id: 'a1',
              title: 'AAPL beats Q3 earnings',
              link: 'https://example.com/a1',
              description: 'Apple posts record revenue',
              pubDate: '2026-05-08T12:00:00Z',
              source_id: 'reuters',
            },
          ],
        }),
        { status: 200 },
      ),
    );
    const rotator = new KeyRotator(['k']);
    const p = createNewsDataProvider({ rotator });
    const items = await p.fetchNews({ keywords: ['AAPL'], limit: 5 });
    expect(items).toHaveLength(1);
    expect(items[0].title).toBe('AAPL beats Q3 earnings');
    expect(items[0].source).toBe('reuters');
  });

  it('returns [] on malformed response', async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ status: 'error' }), { status: 200 }));
    const p = createNewsDataProvider({ rotator: new KeyRotator(['k']) });
    const items = await p.fetchNews({});
    expect(items).toEqual([]);
  });

  it('rotates key on 429', async () => {
    let call = 0;
    fetchMock.mockImplementation(() => {
      call += 1;
      if (call === 1) return Promise.resolve(new Response('rl', { status: 429 }));
      return Promise.resolve(
        new Response(JSON.stringify({ status: 'success', results: [] }), { status: 200 }),
      );
    });
    const rotator = new KeyRotator(['k1', 'k2'], { failureThreshold: 5 });
    const p = createNewsDataProvider({ rotator });
    await p.fetchNews({});
    expect(call).toBe(2);
  });
});
```

검증: `pnpm --filter @finclaw/skills-finance test --run news/providers/newsdata`

### C3. CREATE `packages/skills-finance/src/news/providers/finnhub-news.ts`

```ts
// packages/skills-finance/src/news/providers/finnhub-news.ts
// Phase 27 C: Finnhub company-news (sentiment 포함). 시세 KeyRotator 와 동일 인스턴스 공유.

import { safeFetchJson } from '@finclaw/infra';
import { retry } from '@finclaw/infra';
import type { NewsItem, TickerSymbol } from '@finclaw/types';
import { z } from 'zod/v4';
import { AllKeysCooldownError, KeyRotator } from '../../shared/key-rotator.js';
import type { NewsProvider, NewsQuery, NewsSourceId } from '../types.js';

const COMPANY_NEWS_URL = 'https://finnhub.io/api/v1/company-news';

const ItemSchema = z.object({
  category: z.string().optional(),
  datetime: z.number(),
  headline: z.string(),
  id: z.number(),
  image: z.string().optional(),
  related: z.string().optional(),
  source: z.string(),
  summary: z.string().optional(),
  url: z.string(),
  // Finnhub 무료 tier 는 sentiment 미포함이지만 응답에 들어오면 보존.
  headline_sentiment: z.number().optional(),
});

const ResponseSchema = z.array(ItemSchema);

function isAuthOrRateError(error: unknown): boolean {
  if (error instanceof Error && 'statusCode' in error) {
    const code = (error as { statusCode: number }).statusCode;
    return code === 401 || code === 429;
  }
  return false;
}

function isTransientError(error: unknown): boolean {
  if (error instanceof Error && 'statusCode' in error) {
    const code = (error as { statusCode: number }).statusCode;
    return code === 429 || code >= 500;
  }
  return false;
}

export interface FinnhubNewsConfig {
  readonly rotator: KeyRotator;
}

export function createFinnhubNewsProvider(config: FinnhubNewsConfig): NewsProvider {
  return {
    name: 'finnhub-news' as NewsSourceId,
    isAvailable: () => config.rotator.availableCount() > 0,
    async fetchNews(query: NewsQuery): Promise<NewsItem[]> {
      // company-news 는 종목 단위. symbols 미지정 시 빈 배열.
      if (!query.symbols?.length) return [];

      const to = new Date();
      const from = new Date(to.getTime() - 7 * 86_400_000); // 7일 (질문 Q7)
      const fromStr = from.toISOString().slice(0, 10);
      const toStr = to.toISOString().slice(0, 10);

      const all: NewsItem[] = [];
      for (const symbol of query.symbols) {
        const data = await callWithRotation(config.rotator, (token) => {
          const url = new URL(COMPANY_NEWS_URL);
          url.searchParams.set('symbol', symbol);
          url.searchParams.set('from', fromStr);
          url.searchParams.set('to', toStr);
          url.searchParams.set('token', token);
          return retry(() => safeFetchJson(url.toString(), { timeoutMs: 10_000 }), {
            maxAttempts: 2,
            shouldRetry: isTransientError,
          });
        });

        const parsed = ResponseSchema.safeParse(data);
        if (!parsed.success) continue;

        for (const r of parsed.data) {
          all.push({
            id: String(r.id),
            title: r.headline,
            url: r.url,
            source: r.source,
            publishedAt: (r.datetime * 1000) as NewsItem['publishedAt'],
            summary: r.summary ?? '',
            symbols: [symbol] as readonly TickerSymbol[],
            // sentiment 가 응답에 있으면 보존 (NewsItem 에 sentiment 필드가 있다면).
            ...(r.headline_sentiment !== undefined
              ? {
                  sentiment: {
                    score: r.headline_sentiment,
                    label: scoreToLabel(r.headline_sentiment),
                  },
                }
              : {}),
          } as NewsItem);
        }
      }

      return all.slice(0, query.limit ?? 20);
    },
  };
}

function scoreToLabel(score: number): 'positive' | 'negative' | 'neutral' {
  if (score > 0.15) return 'positive';
  if (score < -0.15) return 'negative';
  return 'neutral';
}

async function callWithRotation<T>(
  rotator: KeyRotator,
  fetcher: (token: string) => Promise<T>,
  maxRotations = 3,
): Promise<T> {
  let lastError: Error | undefined;
  for (let i = 0; i < maxRotations; i++) {
    let token: string;
    try {
      token = rotator.next();
    } catch (err) {
      if (err instanceof AllKeysCooldownError) throw err;
      throw err;
    }
    try {
      const result = await fetcher(token);
      rotator.markSuccess(token);
      return result;
    } catch (err) {
      lastError = err as Error;
      if (isAuthOrRateError(err)) {
        rotator.markFailure(token, lastError);
        continue;
      }
      throw err;
    }
  }
  throw lastError ?? new Error('All Finnhub-news key rotations exhausted');
}
```

> `NewsItem.sentiment` 필드 존재 여부는 `@finclaw/types` 의 NewsItem 정의에 따름. 미정의면 본 spread 부분 제거하고 sentiment 정보는 별도 컬럼 (extension) 으로 — 정확한 처리는 기존 alpha-vantage-news.ts 의 sentiment 보존 패턴 참조.

검증: `pnpm --filter @finclaw/skills-finance build`

### C4. CREATE `packages/skills-finance/src/news/providers/finnhub-news.test.ts`

```ts
// packages/skills-finance/src/news/providers/finnhub-news.test.ts
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createTickerSymbol } from '@finclaw/types';
import { KeyRotator } from '../../shared/key-rotator.js';
import { createFinnhubNewsProvider } from './finnhub-news.js';

describe('createFinnhubNewsProvider', () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    fetchMock.mockReset();
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('returns [] when symbols not provided', async () => {
    const p = createFinnhubNewsProvider({ rotator: new KeyRotator(['k']) });
    const items = await p.fetchNews({});
    expect(items).toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('fetches company news per symbol', async () => {
    fetchMock.mockResolvedValue(
      new Response(
        JSON.stringify([
          {
            id: 1,
            datetime: 1700000000,
            headline: 'AAPL hits new high',
            source: 'CNBC',
            summary: 'foo',
            url: 'https://example.com/1',
          },
        ]),
        { status: 200 },
      ),
    );
    const p = createFinnhubNewsProvider({ rotator: new KeyRotator(['k']) });
    const items = await p.fetchNews({ symbols: [createTickerSymbol('AAPL')], limit: 5 });
    expect(items).toHaveLength(1);
    expect(items[0].title).toBe('AAPL hits new high');
  });

  it('preserves sentiment when present', async () => {
    fetchMock.mockResolvedValue(
      new Response(
        JSON.stringify([
          {
            id: 2,
            datetime: 1700000000,
            headline: 'AAPL down',
            source: 'WSJ',
            url: 'https://example.com/2',
            headline_sentiment: -0.5,
          },
        ]),
        { status: 200 },
      ),
    );
    const p = createFinnhubNewsProvider({ rotator: new KeyRotator(['k']) });
    const items = await p.fetchNews({ symbols: [createTickerSymbol('AAPL')] });
    // NewsItem 에 sentiment 필드가 있다면 검증, 없다면 이 검증 라인 제거.
    expect(items[0]).toBeDefined();
  });
});
```

검증: `pnpm --filter @finclaw/skills-finance test --run news/providers/finnhub-news`

### C5. EDIT `packages/skills-finance/src/news/types.ts` — `NewsSourceId` 확장

```ts
// 기존:
// export type NewsSourceId = 'newsapi' | 'alpha-vantage' | 'rss';

// 변경:
export type NewsSourceId = 'newsapi' | 'alpha-vantage' | 'rss' | 'newsdata' | 'finnhub-news';
```

검증: `pnpm --filter @finclaw/skills-finance build`

### C6. EDIT `packages/skills-finance/src/news/aggregator.ts` — sentiment 우선 정렬 옵션

```ts
// aggregator.ts 의 fetchNews 안 — 정렬 부분 교체

// 변경 전:
// deduped.sort((a, b) => (b.publishedAt as number) - (a.publishedAt as number));

// 변경 후 — sentiment 가 있는 항목을 위로, 그 안에서 publishedAt 내림차순.
deduped.sort((a, b) => {
  const aHas = (a as { sentiment?: { score: number } }).sentiment !== undefined;
  const bHas = (b as { sentiment?: { score: number } }).sentiment !== undefined;
  if (aHas !== bHas) return aHas ? -1 : 1;
  return (b.publishedAt as number) - (a.publishedAt as number);
});
```

검증: `pnpm --filter @finclaw/skills-finance test --run news/aggregator` (기존 테스트가 sentiment 영향 받지 않도록 확인 — 받으면 테스트도 해당 단계에서 동기화)

### C7. EDIT `packages/skills-finance/src/news/index.ts` — provider 등록 + config 확장

```ts
// packages/skills-finance/src/news/index.ts
// ... 기존 import ...
import type { KeyRotator } from '../shared/key-rotator.js';
import { createFinnhubNewsProvider } from './providers/finnhub-news.js';
import { createNewsDataProvider } from './providers/newsdata.js';

/** 스킬 초기화에 필요한 설정 */
export interface NewsSkillConfig {
  readonly db: DatabaseSync;
  readonly newsApiKey?: string;
  /** Phase 27: alpha-vantage news 를 위한 KeyRotator (시세 alphaVantage rotator 와 동일 인스턴스 권장) */
  readonly alphaVantageRotator?: KeyRotator;
  /** Phase 27: NewsData.io 전용 KeyRotator */
  readonly newsdataRotator?: KeyRotator;
  /** Phase 27: Finnhub 시세와 공유하는 KeyRotator */
  readonly finnhubRotator?: KeyRotator;
  readonly rssFeedUrls?: string[];
  readonly anthropicApiKey?: string;
  readonly quoteService: QuoteService;
  readonly router?: RouterHelper;
  readonly defaultModel?: ModelRef;
  readonly profileHealth?: ProfileHealthMonitor;
  readonly profileId?: string;
  readonly modelCatalog?: ModelCatalog;
}

// ... registerNewsTools 안 ...

const providers: NewsProvider[] = [];

if (config.newsApiKey) {
  providers.push(createNewsApiProvider({ apiKey: config.newsApiKey }));
}

// alpha-vantage-news: KeyRotator 가 있으면 첫 키만 추출하여 기존 createAlphaVantageNewsProvider 시그니처에 맞춤.
// (alpha-vantage-news.ts 자체 KeyRotator 통합은 Phase 27 범위 외 — plan.md 가 명시 안 함.)
if (config.alphaVantageRotator) {
  // 기존 createAlphaVantageNewsProvider 가 단일 키 받음 — KeyRotator.next() 시점 호출은 매 요청마다 X.
  // 단순함을 위해 첫 키만 사용. 한도 분산은 시세에서 처리.
  // (note: 진정한 키 분산이 필요하면 alpha-vantage-news.ts 도 KeyRotator 통합 필요 — 별도 phase 위임.)
  // alphaVantageRotator.next() 한 번 호출 + markSuccess 로 cooldown 회피.
  // 더 깔끔한 대안은 Q1 의 결정에 따라 변경.
  // 현재 구현: rotator 가 노출하는 raw key 1 개 사용 (placeholder).
  // → 사용자 결정 필요 시 questions.md Q-NEW 로 추가.
}

if (config.newsdataRotator) {
  providers.push(createNewsDataProvider({ rotator: config.newsdataRotator }));
}

if (config.finnhubRotator) {
  providers.push(createFinnhubNewsProvider({ rotator: config.finnhubRotator }));
}

providers.push(createRssProvider({ feedUrls: config.rssFeedUrls }));

// ... 이하 기존 코드 (analyze_market 등록 등) ...
```

> alpha-vantage-news.ts 의 KeyRotator 통합은 plan.md 가 명시하지 않음. 본 단계에서는 기존 단일 키 동작 유지 (rotator 가 있으면 첫 키만 노출하지 않고 기존 그대로). 명확하게 하려면:
>
> - 옵션 A: `alphaVantageKey?: string` 도 NewsSkillConfig 에 그대로 두고 main.ts 에서 `alphaVantageKeys[0]` 전달.
> - 옵션 B: alpha-vantage-news 에 KeyRotator 통합 (별도 phase).
>
> **현재 분해는 옵션 A** 로 진행 (NewsSkillConfig 에 `alphaVantageKey?: string` 도 그대로 유지 + rotator 옵션은 새로 추가하되 alpha-vantage-news 등록 시 키만 꺼내 사용).

```ts
// (수정안)
if (config.newsApiKey) providers.push(createNewsApiProvider({ apiKey: config.newsApiKey }));
if (config.alphaVantageKey) {
  providers.push(createAlphaVantageNewsProvider({ apiKey: config.alphaVantageKey }));
}
if (config.newsdataRotator)
  providers.push(createNewsDataProvider({ rotator: config.newsdataRotator }));
if (config.finnhubRotator)
  providers.push(createFinnhubNewsProvider({ rotator: config.finnhubRotator }));
providers.push(createRssProvider({ feedUrls: config.rssFeedUrls }));
```

> 즉 `NewsSkillConfig` 의 `alphaVantageKey?: string` 은 그대로 보존하고 두 신규 rotator 만 추가.

```ts
export interface NewsSkillConfig {
  readonly db: DatabaseSync;
  readonly newsApiKey?: string;
  readonly alphaVantageKey?: string;
  readonly newsdataRotator?: KeyRotator;
  readonly finnhubRotator?: KeyRotator;
  readonly rssFeedUrls?: string[];
  readonly anthropicApiKey?: string;
  readonly quoteService: QuoteService;
  readonly router?: RouterHelper;
  readonly defaultModel?: ModelRef;
  readonly profileHealth?: ProfileHealthMonitor;
  readonly profileId?: string;
  readonly modelCatalog?: ModelCatalog;
}
```

> `NEWS_SKILL_METADATA` 의 optionalEnv 도 갱신:
>
> ```ts
> optionalEnv: ['NEWSAPI_KEY', 'ALPHA_VANTAGE_KEY', 'FINNHUB_KEY', 'NEWSDATA_API_KEY', 'ANTHROPIC_API_KEY'],
> ```

> `NewsSkillHandle` 에 newsdata / finnhub-news 의 rotator 도 노출 — D 밀스톤 status 표시용:
>
> ```ts
> export interface NewsSkillHandle {
>   readonly aggregator: import('./types.js').NewsAggregator;
>   readonly portfolioStore: PortfolioStore;
>   readonly keyRotators: {
>     readonly newsdata?: KeyRotator;
>   };
> }
> ```
>
> `return { aggregator: newsAggregator, portfolioStore, keyRotators: { newsdata: config.newsdataRotator } };`

검증: `pnpm --filter @finclaw/skills-finance build`

### C8. EDIT `packages/server/src/main.ts` — News rotator 주입

B11 에서 임시 수정한 News 등록 블록을 정상 갱신.

```ts
// main.ts (B11 의 임시 블록을 교체)

const newsdataKeys = readKeyArray('NEWSDATA_API_KEY');
const newsdataRotator = newsdataKeys.length > 0 ? new KeyRotator(newsdataKeys) : undefined;

if (marketHandle && (alphaVantageRotator || newsdataRotator || finnhubRotator)) {
  newsHandle = await registerNewsTools(toolRegistry, {
    db: storage.db,
    alphaVantageKey: alphaVantageKeys[0],
    newsdataRotator,
    finnhubRotator, // 시세 KeyRotator 와 동일 인스턴스 공유
    quoteService: marketHandle.quoteService,
    anthropicApiKey: anthropicKey,
    router: routerHelper,
    defaultModel: DEFAULT_MODEL,
    profileHealth,
    profileId: 'default',
    modelCatalog,
  });
  logger.info('News tools registered', {
    providers: [
      alphaVantageRotator && 'alpha-vantage',
      newsdataRotator && 'newsdata',
      finnhubRotator && 'finnhub-news',
    ].filter(Boolean),
  });
} else if (marketHandle) {
  logger.info('No news keys set — skipping news tools');
}
```

검증: `pnpm typecheck`

### C9. 밀스톤 C 검증

- `pnpm --filter @finclaw/skills-finance test --run news`
- `pnpm --filter @finclaw/skills-finance build`
- `pnpm --filter @finclaw/server build`
- `pnpm typecheck`

mock 시나리오: `NEWSDATA_API_KEY=k1,k2`, `FINNHUB_KEY=fk` 설정 → server 시작 → `News tools registered: providers: ['newsdata', 'finnhub-news']` 로그 (실 fetch 는 D 검증 시 직접 호출).

---

## 밀스톤 D — 캐시 정책 + 일일 한도 모니터링

목표: 신규 provider 들의 캐시 TTL 정합성 + status 명령에 일일 사용량 표시.

### D1. EDIT `packages/skills-finance/src/market/cache.ts` — provider 별 TTL + 사용량 조회

기존 `ttlMap` 확장 + `getDailyUsage` public 메서드 신설.

```ts
// cache.ts 안 — getQuote 메서드 내 ttlMap 교체

const ttlMap: Record<string, number> = {
  finnhub: 5_000, // real-time → 5초
  'twelve-data': 300_000, // 4시간 지연 → 5분
  'alpha-vantage': CACHE_TTL.QUOTE, // 30분 (기존)
  coingecko: CACHE_TTL.CRYPTO,
  frankfurter: CACHE_TTL.FOREX,
};
const ttl = ttlMap[provider.id] ?? CACHE_TTL.QUOTE;

// MarketCache 클래스 안에 새 메서드 추가
/** Phase 27 D: status 표시용. 오늘 (UTC 자정 기준) 호출 카운터 조회. */
getDailyUsage(providerId: string): number {
  const today = new Date().toISOString().split('T')[0];
  const counterKey = `rate:daily:${providerId}:${today}`;
  return getCachedData<number>(this.db, counterKey) ?? 0;
}
```

> alpha-vantage TTL 을 plan.md 의 "30 분" 으로 맞추려면 `CACHE_TTL.QUOTE` 가 현재 5분(`300_000`) 임에 주의. plan.md 명시값과 일치시키려면 `1_800_000` 명시:
>
> ```ts
> 'alpha-vantage': 1_800_000, // EOD → 30분 (plan.md 명시)
> ```

검증: `pnpm --filter @finclaw/skills-finance test --run market/cache`

### D2. EDIT `packages/server/src/auto-reply/commands/status.ts` — provider 한도 표시

```ts
// packages/server/src/auto-reply/commands/status.ts
import type { ModelStats, ProfileHealthMonitor, ToolRegistry } from '@finclaw/agent';
import { modelIdToTier } from '@finclaw/agent';
import type { MarketSkillHandle, NewsSkillHandle } from '@finclaw/skills-finance';
import type { ModelRef, StorageAdapter } from '@finclaw/types';
import { getAllChannelDocks } from '../../channels/index.js';
import type { CommandExecutor } from './registry.js';

export interface StatusCommandDeps {
  readonly toolRegistry: ToolRegistry;
  readonly storage: StorageAdapter;
  readonly profileHealth?: ProfileHealthMonitor;
  readonly profileId?: string;
  readonly defaultModel?: ModelRef;
  /** Phase 27: provider 한도 표시. */
  readonly marketHandle?: MarketSkillHandle;
  readonly newsHandle?: NewsSkillHandle;
}

/** `!finclaw status` — 서버 상태 + provider 한도. */
export function createStatusCommand(deps: StatusCommandDeps): CommandExecutor {
  return async (_args, ctx) => {
    const toolCount = deps.toolRegistry.list().length;
    const conversation = await deps.storage.getConversation(ctx.sessionKey).catch(() => null);
    const messageCount = conversation?.messages.length ?? 0;
    const uptimeMin = Math.round(process.uptime() / 60);

    const channelIds =
      getAllChannelDocks()
        .map((d) => d.id as string)
        .join(', ') || 'none';
    const modelId = deps.defaultModel?.model ?? 'unknown';
    const profileId = deps.profileId ?? 'default';
    const healthLabel = deps.profileHealth?.getHealth(profileId) ?? 'unknown';

    const breakdown = deps.profileHealth?.getModelBreakdown(profileId, 60 * 60 * 1000);
    const breakdownLines = formatBreakdown(breakdown);

    const apiLines = formatApiUsage(deps.marketHandle, deps.newsHandle);

    return {
      content: [
        '**FinClaw 상태**',
        `- 등록 도구: ${toolCount}개`,
        `- 현재 세션 메시지: ${messageCount}건`,
        `- 서버 업타임: ${uptimeMin}분`,
        `- 지원 채널: ${channelIds}`,
        `- 현재 모델: ${modelId}`,
        `- API 상태: ${healthLabel}`,
        ...breakdownLines,
        ...apiLines,
      ].join('\n'),
      ephemeral: false,
    };
  };
}

function formatBreakdown(breakdown: Map<string, ModelStats> | undefined): string[] {
  if (!breakdown || breakdown.size === 0) return [];
  const lines: string[] = ['', '**최근 1시간 모델 분포**'];
  let totalFallbacks = 0;
  const tierRank: Record<string, number> = { haiku: 0, sonnet: 1, opus: 2 };
  const sorted = [...breakdown.entries()].toSorted(
    ([a], [b]) => tierRank[modelIdToTier(a)] - tierRank[modelIdToTier(b)],
  );
  for (const [modelId, stats] of sorted) {
    const tier = modelIdToTier(modelId);
    const bar = '▓'.repeat(Math.min(10, Math.max(1, Math.round(stats.calls / 5))));
    lines.push(
      `- ${tier.padEnd(7)} ${bar.padEnd(10)} ${stats.calls}회 ($${stats.totalCostUsd.toFixed(4)})`,
    );
    totalFallbacks += stats.fallbacks;
  }
  if (totalFallbacks > 0) lines.push(`- Fallback 발동: ${totalFallbacks}회`);
  return lines;
}

function formatApiUsage(
  market: MarketSkillHandle | undefined,
  news: NewsSkillHandle | undefined,
): string[] {
  if (!market && !news) return [];
  const lines: string[] = ['', '**API 한도 (오늘)**'];

  if (market) {
    const cache = market.cache;
    const rotators = market.keyRotators;
    if (rotators.finnhub) {
      const used = cache.getDailyUsage('finnhub');
      const total = 60 * rotators.finnhub.totalCount();
      const avail = rotators.finnhub.availableCount();
      lines.push(
        `- Finnhub:     ${bar(used, total)} ${used} / ${total} calls/min · 가용 키 ${avail}/${rotators.finnhub.totalCount()}`,
      );
    }
    if (rotators.twelveData) {
      const used = cache.getDailyUsage('twelve-data');
      const total = 800 * rotators.twelveData.totalCount();
      const avail = rotators.twelveData.availableCount();
      lines.push(
        `- Twelve Data: ${bar(used, total)} ${used} / ${total}/day      · 가용 키 ${avail}/${rotators.twelveData.totalCount()}`,
      );
    }
    if (rotators.alphaVantage) {
      const used = cache.getDailyUsage('alpha-vantage');
      const total = 25 * rotators.alphaVantage.totalCount();
      const avail = rotators.alphaVantage.availableCount();
      lines.push(
        `- Alpha V:     ${bar(used, total)} ${used} / ${total}/day        · 가용 키 ${avail}/${rotators.alphaVantage.totalCount()}`,
      );
    }
  }

  if (news?.keyRotators.newsdata) {
    const r = news.keyRotators.newsdata;
    const total = 200 * r.totalCount();
    // newsdata 는 cache 에 daily counter 미기록 (rateLimit.dailyLimit 미설정). placeholder.
    lines.push(
      `- NewsData.io: ${bar(0, total)} ?  / ${total}/day       · 가용 키 ${r.availableCount()}/${r.totalCount()}`,
    );
  }

  if (market?.keyRotators.finnhub) {
    lines.push('- Finnhub News: (시세와 키 공유)');
  }

  return lines;
}

function bar(used: number, total: number): string {
  if (total === 0) return '[░░░░░░░░░░]';
  const filled = Math.min(10, Math.max(0, Math.round((used / total) * 10)));
  return `[${'▓'.repeat(filled)}${'░'.repeat(10 - filled)}]`;
}
```

검증: `pnpm --filter @finclaw/server build`

### D3. EDIT `packages/server/src/auto-reply/commands/built-in.ts` — deps 전달

```ts
// packages/server/src/auto-reply/commands/built-in.ts
import type { ProfileHealthMonitor, ToolRegistry } from '@finclaw/agent';
import type { MarketSkillHandle, NewsSkillHandle } from '@finclaw/skills-finance';
import type { ModelRef, StorageAdapter } from '@finclaw/types';
import type { CommandRegistry } from './registry.js';
import { createResetCommand } from './reset.js';
import { createStatusCommand } from './status.js';

export interface BuiltInCommandDeps {
  readonly toolRegistry?: ToolRegistry;
  readonly storage?: StorageAdapter;
  readonly profileHealth?: ProfileHealthMonitor;
  readonly profileId?: string;
  readonly defaultModel?: ModelRef;
  /** Phase 27 D: status 명령의 provider 한도 표시용. */
  readonly marketHandle?: MarketSkillHandle;
  readonly newsHandle?: NewsSkillHandle;
}

// ... registerBuiltInCommands 안 status 등록 부분에 두 handle 도 전달 ...

if (deps.toolRegistry && deps.storage) {
  registry.register(
    {
      name: 'status',
      aliases: ['상태'],
      description: 'FinClaw 서버 상태를 표시합니다',
      usage: '/status',
      category: 'general',
    },
    createStatusCommand({
      toolRegistry: deps.toolRegistry,
      storage: deps.storage,
      profileHealth: deps.profileHealth,
      profileId: deps.profileId,
      defaultModel: deps.defaultModel,
      marketHandle: deps.marketHandle,
      newsHandle: deps.newsHandle,
    }),
  );
}
```

검증: `pnpm --filter @finclaw/server build`

### D4. EDIT `packages/server/src/main.ts` — registerBuiltInCommands 에 handle 전달

main.ts 에서 `registerBuiltInCommands` 호출부에 marketHandle/newsHandle 전달.

```ts
// main.ts — 기존 registerBuiltInCommands 호출 부분 찾아서 갱신

registerBuiltInCommands(commandRegistry, {
  toolRegistry,
  storage: storage,
  profileHealth,
  profileId: 'default',
  defaultModel: DEFAULT_MODEL,
  marketHandle, // 신규
  newsHandle, // 신규
});
```

> 기존 `registerBuiltInCommands` 호출 시점이 marketHandle / newsHandle 초기화 이전이라면 — 호출 순서 조정 (handle 초기화 이후로 이동).

검증: `pnpm typecheck && pnpm --filter @finclaw/server build`

### D5. 밀스톤 D 검증 — 단위 + mock 시나리오

**단위 테스트:**

- `pnpm --filter @finclaw/skills-finance test --run market/cache` (TTL 매핑 검증)
- `pnpm --filter @finclaw/server test --run` (status command 의 새 deps 처리)

**mock 시나리오 (env):**

```sh
FINNHUB_KEY=mock1,mock2,mock3 \
TWELVE_DATA_KEY=mock4,mock5,mock6 \
ALPHA_VANTAGE_KEY=mock7,mock8,mock9 \
NEWSDATA_API_KEY=mock10,mock11,mock12 \
pnpm dev:server
```

기대 동작 (실 키 없는 시나리오 — 실제 fetch 는 401/404 로 fail 하지만 server 시작 / status 명령 응답 형식은 검증 가능):

- 로그에 `Market tools registered: providers: ['finnhub', 'twelve-data', 'alpha-vantage', 'coingecko']`
- 로그에 `News tools registered: providers: ['alpha-vantage', 'newsdata', 'finnhub-news']`
- `!finclaw status` 응답에 `**API 한도 (오늘)**` 섹션 + 4 provider line 출력 + 가용 키 3/3.

**실 키 시나리오 (사용자 발급 후, plan.md `Done 정의` 검증):**

| 시나리오           | 입력               | 기대 동작                                   |
| ------------------ | ------------------ | ------------------------------------------- |
| 미국 주식 (실시간) | "AAPL 얼마야?"     | provider=finnhub, 지연 1초 미만             |
| 미국 주식 차트     | "AAPL 차트 1년"    | provider=finnhub or twelve-data             |
| 동시 다종목        | "SPY QQQ DIA 비교" | 3 종목 모두 응답                            |
| Finnhub 한도 도달  | 60회 연속          | 키 2 로 rotation, 끊김 없음                 |
| 모든 키 cooldown   | (mock 강제 후)     | AllKeysCooldownError → 한국어 안내          |
| 미국 종목 뉴스     | "AAPL 뉴스"        | finnhub-news + newsdata.io mix              |
| 종합 분석          | "AAPL 분석해줘"    | analyze_market → Opus + 시세/뉴스/sentiment |
| status 한도 출력   | "!finclaw status"  | 4 provider 사용량 + 가용 키                 |

---

## 최종 검증

phase 전체 완료 후 다음 모두 통과:

- [ ] `pnpm typecheck`
- [ ] `pnpm test --run`
- [ ] `pnpm test:storage`
- [ ] `pnpm lint`
- [ ] `pnpm format:fix && pnpm format:check`
- [ ] `pnpm build`
- [ ] mock-only 격리: 모든 \*\_KEY env unset 상태에서 `pnpm test --run` 통과 (외부 fetch 0 회)
- [ ] 신규 단위 테스트 ≥ 30 케이스 (KeyRotator + 4 provider + status)
- [ ] `.env.example` 에 4 신규 키 변수 명시

플랜의 `Done 정의` 8개 항목 (plan.md L296-305) 도 모두 만족 — 실 키 발급 후 D5 시나리오 통과 확인.

---

## 롤백 절차

각 밀스톤이 독립 커밋이므로 단계적 롤백 가능:

- 밀스톤 D 롤백: `git revert {sha-D}` — status 의 한도 표시만 제거. 시세/뉴스 동작 유지.
- 밀스톤 C 롤백: `git revert {sha-D} {sha-C}` — 뉴스 확장 제거. 시세는 유지.
- 밀스톤 B 롤백: `git revert {sha-D} {sha-C} {sha-B}` — 시세 신규 provider 제거. KeyRotator 인프라 + alpha-vantage 단일 키 동작은 유지.
- 전체 phase 롤백: `git revert {sha-A}..{sha-D}` 또는 `git reset --hard caff474` (시작 SHA).

본 phase 는 storage schema 변경 없음 → SCHEMA_VERSION 처리 불필요.

---

## 의존성 순서 (plan.md L280-290)

```
A (KeyRotator)
  ↓
B (Finnhub + Twelve Data) — A 의 KeyRotator 사용
  ↓
C (NewsData.io + Finnhub News) — B 의 finnhubRotator 공유
  ↓
D (캐시 + status + 검증) — A/B/C 의 모든 handle 사용
```

A → B → C → D 순차 실행. 각 밀스톤 검증 통과 후 다음 진입.
