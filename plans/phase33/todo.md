# Phase 33 Todo: 한투 KIS 잔고 동기화 + 뉴스 요약 메모리화 (FINAL)

> plan.md 의 밀스톤 A~E 를 코드 단위로 분해한 작업 가이드.
> **본 todo 는 plan.md 의 "## 인스펙션 보강 (post-phase32, base `567c07f`)" §B-0~B-7 을 OVERRIDE 기준으로 채택한다.** 밀스톤 본문(B3 의 action/payload schedule, C2 의 createMemory/archiveOlderThan/tags, D1 의 config/loader.ts 등)의 어긋난 서술은 보강이 정정한 형태로만 반영했다.
>
> **★ 전역 전제 (§B-0, 사용자 확정):** phase33 자동화는 **SDK 모드 전용**(`provider` 미지정 또는 `anthropic-sdk`). CLI 모드(`provider:'claude-cli'`)는 `tool_use` 를 yield 하지 않아 skills-finance 전체가 비활성(`main.ts:458-467` `provider.cli_tools_disabled` 경고) → KIS sync·뉴스 요약 tool 이 침묵한다. 별도 "SDK 강제" 코드는 불필요(기본값이 SDK)하나, 각 완료조건에 "CLI 모드 비양립" 을 명시한다. 비용 0(CLI)는 수동 대화 전용.

---

## 사전 준비

### P-1. 브랜치 / base 확인

- 브랜치 `feature/kis-sync-news-memory`, base `567c07f`(phase31+32 머지 main). 신규 작업 없음 — 확인만.
- `SCHEMA_VERSION` 현재 11(`packages/storage/src/database.ts:23`). 본 phase 에서 **v11→v12** 신규(§B-5/B-7).

검증: `git rev-parse --abbrev-ref HEAD` → `feature/kis-sync-news-memory`

### P-2. 의존 그래프 확인 (역방향 금지)

- KIS 어댑터는 `@finclaw/skills-finance` 에 신규 → 의존 가능: `types`, `storage`. (server 역참조 X)
- brokerage tool 등록·sync RPC·news-memorizer 는 `@finclaw/server` (skills-finance ← server 정방향).
- workspace dep 추가 없음 (skills-finance 는 이미 types/storage 의존). 신규 deps 불필요 — KIS 는 `fetch`(node 내장) 사용.

검증: `cat packages/skills-finance/package.json | grep -A6 dependencies`

---

## 밀스톤 A — KIS Auth + Read-only Adapter

> plan.md 밀스톤 A 그대로. `skills-finance/src/brokerage/kis/` 신규. **read-only 4 endpoint 만** — order/cancel/modify 가 코드에 존재하지 않게 한다. KIS 어댑터는 `market/providers/*` + provider-registry 패턴(§B-7) 을 따른다. **모든 테스트는 fetch mock(외부 키·네트워크 금지, CLAUDE.md feedback).**

### A1. CREATE `packages/skills-finance/src/brokerage/kis/types.ts` — KIS 도메인 타입

```ts
// packages/skills-finance/src/brokerage/kis/types.ts

/** KIS 환경. prod=실전, vts=모의투자. */
export type KisEnv = 'prod' | 'vts';

/** KIS Open API credentials (read-only). */
export interface KisCredentials {
  readonly env: KisEnv;
  readonly appKey: string;
  readonly appSecret: string;
  readonly accountNo: string; // CANO (8자리)
  readonly accountProductCode: string; // ACNT_PRDT_CD (2자리, 보통 '01')
}

/**
 * KIS 응답을 FinClaw 도메인으로 정규화한 보유 종목.
 * §B-5: market/currentPrice/currency/asOf 는 portfolio_holdings 컬럼에 없음 →
 * 이 타입은 **메모리 내부용**. DB 저장은 (quantity, average_cost, source) 만.
 */
export interface NormalizedHolding {
  readonly symbol: string;
  readonly market: 'KR' | 'US';
  readonly quantity: number;
  readonly averagePrice: number;
  readonly currentPrice: number | null;
  readonly currency: 'KRW' | 'USD';
  readonly asOf: number; // unix ms
}

/** KIS API 에러 분류 (밀스톤 D 회복 정책에서 사용). */
export type KisErrorKind =
  | 'token_expired'
  | 'rate_limit'
  | 'network'
  | 'auth' // 401/403 non-recoverable
  | 'server'; // 5xx

export class KisError extends Error {
  constructor(
    readonly kind: KisErrorKind,
    message: string,
    readonly recoverable: boolean,
    readonly statusCode?: number,
  ) {
    super(message);
    this.name = 'KisError';
  }
}
```

검증: `pnpm --filter @finclaw/skills-finance exec tsgo --noEmit` (단계별; 최종은 build)

### A2. CREATE `packages/skills-finance/src/brokerage/kis/auth.ts` — 토큰 발급/캐시/갱신

- POST `/oauth2/tokenP` → `access_token`(24h). 인메모리 캐시 + 만료 5분 전 사전 갱신 + 동시 요청 1회만 갱신(in-flight promise 공유 = mutex).
- baseUrl: prod=`https://openapi.koreainvestment.com:9443`, vts=`https://openapivts.koreainvestment.com:29443`.

```ts
// packages/skills-finance/src/brokerage/kis/auth.ts
import type { KisCredentials } from './types.js';
import { KisError } from './types.js';

const BASE_URL: Record<KisCredentials['env'], string> = {
  prod: 'https://openapi.koreainvestment.com:9443',
  vts: 'https://openapivts.koreainvestment.com:29443',
};

const REFRESH_MARGIN_MS = 5 * 60_000; // 만료 5분 전 사전 갱신

interface CachedToken {
  readonly token: string;
  readonly expiresAt: number; // unix ms
}

export class KisTokenManager {
  private cached: CachedToken | null = null;
  private inflight: Promise<string> | null = null;

  constructor(
    private readonly creds: KisCredentials,
    /** 테스트에서 mock fetch 주입. 기본 globalThis.fetch. */
    private readonly fetchFn: typeof fetch = fetch,
    private readonly now: () => number = Date.now,
  ) {}

  baseUrl(): string {
    return BASE_URL[this.creds.env];
  }

  /** 유효 토큰 반환. 만료 임박/없음이면 갱신 (동시 호출은 inflight 공유). */
  async getToken(): Promise<string> {
    const t = this.now();
    if (this.cached && this.cached.expiresAt - REFRESH_MARGIN_MS > t) {
      return this.cached.token;
    }
    if (this.inflight) {
      return this.inflight;
    }
    this.inflight = this.refresh().finally(() => {
      this.inflight = null;
    });
    return this.inflight;
  }

  private async refresh(): Promise<string> {
    const res = await this.fetchFn(`${this.baseUrl()}/oauth2/tokenP`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        grant_type: 'client_credentials',
        appkey: this.creds.appKey,
        appsecret: this.creds.appSecret,
      }),
    });
    if (!res.ok) {
      const recoverable = res.status >= 500;
      throw new KisError(
        recoverable ? 'server' : 'auth',
        `KIS token issue failed: ${res.status}`,
        recoverable,
        res.status,
      );
    }
    const json = (await res.json()) as { access_token: string; expires_in: number };
    const expiresAt = this.now() + json.expires_in * 1000;
    this.cached = { token: json.access_token, expiresAt };
    return json.access_token;
  }

  /** 테스트/회복용 — 캐시 무효화 후 다음 호출에서 재발급. */
  invalidate(): void {
    this.cached = null;
  }
}
```

검증: `pnpm --filter @finclaw/skills-finance exec tsgo --noEmit`

### A3. CREATE `packages/skills-finance/src/brokerage/kis/client.ts` — fetch wrapper + rate limit + read-only endpoint

- **read-only 만 export.** grep `order|cancel|modify` 결과 0 (완료조건).
- token bucket rate limit: 실전 5/s, 모의 20/s. exponential backoff 는 밀스톤 D 의 회복 정책에서 client 호출자가 적용(여기선 단순 token bucket + 429 시 KisError 'rate_limit').
- TR_ID 매핑(plan A3 표): 한국 잔고 `TTTC8434R`(prod)/`VTTC8434R`(vts), 해외 잔고 `TTTS3012R`(prod)/`VTTS3012R`(vts).

```ts
// packages/skills-finance/src/brokerage/kis/client.ts
import type { KisCredentials } from './types.js';
import { KisError } from './types.js';
import { KisTokenManager } from './auth.js';

/** 간단 token bucket — 초당 capacity 만큼 충전. */
class TokenBucket {
  private tokens: number;
  private last: number;
  constructor(
    private readonly capacityPerSec: number,
    private readonly now: () => number = Date.now,
  ) {
    this.tokens = capacityPerSec;
    this.last = now();
  }
  async take(): Promise<void> {
    const t = this.now();
    this.tokens = Math.min(
      this.capacityPerSec,
      this.tokens + ((t - this.last) / 1000) * this.capacityPerSec,
    );
    this.last = t;
    if (this.tokens < 1) {
      throw new KisError('rate_limit', 'KIS rate limit (local bucket)', true, 429);
    }
    this.tokens -= 1;
  }
}

const TR_ID = {
  domesticBalance: { prod: 'TTTC8434R', vts: 'VTTC8434R' },
  overseasBalance: { prod: 'TTTS3012R', vts: 'VTTS3012R' },
} as const;

export interface KisRawBalances {
  readonly domestic: unknown; // inquire-balance (KR) 원응답
  readonly overseas: unknown; // inquire-balance (US) 원응답
}

export class KisClient {
  private readonly bucket: TokenBucket;
  constructor(
    private readonly creds: KisCredentials,
    private readonly tokens: KisTokenManager,
    private readonly fetchFn: typeof fetch = fetch,
    now: () => number = Date.now,
  ) {
    this.bucket = new TokenBucket(creds.env === 'prod' ? 5 : 20, now);
  }

  /** read-only: 한국 + 해외 잔고 원응답을 함께 조회. */
  async fetchBalances(): Promise<KisRawBalances> {
    const [domestic, overseas] = await Promise.all([
      this.get(
        '/uapi/domestic-stock/v1/trading/inquire-balance',
        TR_ID.domesticBalance[this.creds.env],
        {
          CANO: this.creds.accountNo,
          ACNT_PRDT_CD: this.creds.accountProductCode,
          AFHR_FLPR_YN: 'N',
          OFL_YN: '',
          INQR_DVSN: '02',
          UNPR_DVSN: '01',
          FUND_STTL_ICLD_YN: 'N',
          FNCG_AMT_AUTO_RDPT_YN: 'N',
          PRCS_DVSN: '01',
          CTX_AREA_FK100: '',
          CTX_AREA_NK100: '',
        },
      ),
      this.get(
        '/uapi/overseas-stock/v1/trading/inquire-balance',
        TR_ID.overseasBalance[this.creds.env],
        {
          CANO: this.creds.accountNo,
          ACNT_PRDT_CD: this.creds.accountProductCode,
          OVRS_EXCG_CD: 'NASD', // 미국 통합
          TR_CRCY_CD: 'USD',
          CTX_AREA_FK200: '',
          CTX_AREA_NK200: '',
        },
      ),
    ]);
    return { domestic, overseas };
  }

  private async get(path: string, trId: string, query: Record<string, string>): Promise<unknown> {
    await this.bucket.take();
    const token = await this.tokens.getToken();
    const url = `${this.tokens.baseUrl()}${path}?${new URLSearchParams(query).toString()}`;
    const res = await this.fetchFn(url, {
      method: 'GET',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${token}`,
        appkey: this.creds.appKey,
        appsecret: this.creds.appSecret,
        tr_id: trId,
        custtype: 'P',
      },
    });
    if (!res.ok) {
      if (res.status === 401 || res.status === 403) {
        throw new KisError('auth', `KIS auth failed: ${res.status}`, false, res.status);
      }
      if (res.status === 429) {
        throw new KisError('rate_limit', 'KIS rate limit', true, 429);
      }
      throw new KisError(
        'server',
        `KIS request failed: ${res.status}`,
        res.status >= 500,
        res.status,
      );
    }
    return res.json();
  }
}
```

검증: `grep -nE '\b(order|cancel|modify)\b' packages/skills-finance/src/brokerage/kis/client.ts` → 결과 없어야 함 (완료조건)

### A4. CREATE `packages/skills-finance/src/brokerage/kis/holdings.ts` — 정규화 (한국/해외 normalizer)

KIS 응답 `output1[]`(보유 종목 배열) → `NormalizedHolding[]`. 한국·해외 응답 키가 달라 두 normalizer.

```ts
// packages/skills-finance/src/brokerage/kis/holdings.ts
import type { KisRawBalances, KisClient } from './client.js';
import type { NormalizedHolding } from './types.js';

/** 한국 inquire-balance output1 행 (필요 필드만). */
interface DomesticRow {
  pdno: string; // 종목코드 (6자리)
  hldg_qty: string; // 보유수량
  pchs_avg_pric: string; // 매입평균가격
  prpr: string; // 현재가
}

/** 해외 inquire-balance output1 행. */
interface OverseasRow {
  ovrs_pdno: string; // 해외 종목코드 (티커)
  ovrs_cblc_qty: string; // 해외 잔고 수량
  pchs_avg_pric: string; // 매입평균
  now_pric2: string; // 현재가
}

function num(s: string | undefined): number {
  const n = Number(s ?? '0');
  return Number.isFinite(n) ? n : 0;
}

export function normalizeDomestic(raw: unknown, asOf: number): NormalizedHolding[] {
  const rows = ((raw as { output1?: DomesticRow[] })?.output1 ?? []).filter(
    (r) => num(r.hldg_qty) > 0,
  );
  return rows.map((r) => ({
    symbol: r.pdno,
    market: 'KR' as const,
    quantity: num(r.hldg_qty),
    averagePrice: num(r.pchs_avg_pric),
    currentPrice: r.prpr ? num(r.prpr) : null,
    currency: 'KRW' as const,
    asOf,
  }));
}

export function normalizeOverseas(raw: unknown, asOf: number): NormalizedHolding[] {
  const rows = ((raw as { output1?: OverseasRow[] })?.output1 ?? []).filter(
    (r) => num(r.ovrs_cblc_qty) > 0,
  );
  return rows.map((r) => ({
    symbol: r.ovrs_pdno,
    market: 'US' as const,
    quantity: num(r.ovrs_cblc_qty),
    averagePrice: num(r.pchs_avg_pric),
    currentPrice: r.now_pric2 ? num(r.now_pric2) : null,
    currency: 'USD' as const,
    asOf,
  }));
}

/** client 로 잔고 조회 후 한국+해외 정규화 병합. */
export async function fetchNormalizedHoldings(
  client: KisClient,
  now: () => number = Date.now,
): Promise<NormalizedHolding[]> {
  const asOf = now();
  const balances: KisRawBalances = await client.fetchBalances();
  return [
    ...normalizeDomestic(balances.domestic, asOf),
    ...normalizeOverseas(balances.overseas, asOf),
  ];
}
```

검증: `pnpm --filter @finclaw/skills-finance exec tsgo --noEmit`

### A5. CREATE `packages/skills-finance/src/brokerage/kis/index.ts` — public surface

```ts
// packages/skills-finance/src/brokerage/kis/index.ts
export type { KisCredentials, KisEnv, NormalizedHolding, KisErrorKind } from './types.js';
export { KisError } from './types.js';
export { KisTokenManager } from './auth.js';
export { KisClient } from './client.js';
export type { KisRawBalances } from './client.js';
export { fetchNormalizedHoldings, normalizeDomestic, normalizeOverseas } from './holdings.js';
```

그리고 `packages/skills-finance/src/index.ts` 에 re-export 추가 (server 가 단일 import 경로로 사용):

```ts
// packages/skills-finance/src/index.ts (말미에 추가)
export * from './brokerage/kis/index.js';
```

검증: `pnpm --filter @finclaw/skills-finance build`

### A6. CREATE `packages/skills-finance/test/brokerage/kis/holdings.test.ts` — mock fixture 테스트

- **fetch mock only.** 실제 KIS 키/네트워크 없이 통과.
- 케이스: (1) 한국 정규화 (2) 해외 정규화 (3) qty=0 행 제외 (4) 토큰 만료→자동 갱신 (1회만 issue 호출) (5) rate limit 초과 시 KisError('rate_limit') (6) 401 → KisError('auth', recoverable:false).

```ts
// packages/skills-finance/test/brokerage/kis/holdings.test.ts
import { describe, expect, it, vi } from 'vitest';
import {
  KisClient,
  KisError,
  KisTokenManager,
  fetchNormalizedHoldings,
  normalizeDomestic,
  normalizeOverseas,
} from '../../../src/brokerage/kis/index.js';
import type { KisCredentials } from '../../../src/brokerage/kis/index.js';

const CREDS: KisCredentials = {
  env: 'vts',
  appKey: 'test-key',
  appSecret: 'test-secret',
  accountNo: '50000000',
  accountProductCode: '01',
};

// 실제 KIS 응답 구조 모방 (값은 placeholder).
const DOMESTIC_FIXTURE = {
  output1: [
    { pdno: '005930', hldg_qty: '10', pchs_avg_pric: '70000', prpr: '72000' },
    { pdno: '000660', hldg_qty: '0', pchs_avg_pric: '0', prpr: '0' }, // qty=0 → 제외
  ],
};
const OVERSEAS_FIXTURE = {
  output1: [{ ovrs_pdno: 'NVDA', ovrs_cblc_qty: '5', pchs_avg_pric: '800', now_pric2: '900' }],
};

function jsonRes(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status });
}

describe('KIS normalizers', () => {
  it('정규화: 한국 잔고 + qty=0 제외', () => {
    const out = normalizeDomestic(DOMESTIC_FIXTURE, 1_700_000_000_000);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ symbol: '005930', market: 'KR', quantity: 10, currency: 'KRW' });
  });
  it('정규화: 해외 잔고', () => {
    const out = normalizeOverseas(OVERSEAS_FIXTURE, 1_700_000_000_000);
    expect(out[0]).toMatchObject({ symbol: 'NVDA', market: 'US', quantity: 5, currency: 'USD' });
  });
});

describe('KIS client (mock fetch)', () => {
  it('토큰 만료 → 자동 갱신 (issue 1회)', async () => {
    let issueCalls = 0;
    const fetchFn = vi.fn(async (url: string | URL) => {
      const u = String(url);
      if (u.endsWith('/oauth2/tokenP')) {
        issueCalls++;
        return jsonRes({ access_token: 'tok', expires_in: 86400 });
      }
      return jsonRes(u.includes('domestic') ? DOMESTIC_FIXTURE : OVERSEAS_FIXTURE);
    }) as unknown as typeof fetch;

    const tokens = new KisTokenManager(CREDS, fetchFn);
    const client = new KisClient(CREDS, tokens, fetchFn);
    const holdings = await fetchNormalizedHoldings(client);
    expect(holdings).toHaveLength(2);
    expect(issueCalls).toBe(1); // 동일 호출 안에서 토큰 재발급 1회만
  });

  it('401 → KisError(auth, non-recoverable)', async () => {
    const fetchFn = vi.fn(async (url: string | URL) => {
      const u = String(url);
      if (u.endsWith('/oauth2/tokenP')) return jsonRes({ access_token: 'tok', expires_in: 86400 });
      return jsonRes({ msg: 'forbidden' }, 401);
    }) as unknown as typeof fetch;
    const tokens = new KisTokenManager(CREDS, fetchFn);
    const client = new KisClient(CREDS, tokens, fetchFn);
    await expect(client.fetchBalances()).rejects.toMatchObject({
      kind: 'auth',
      recoverable: false,
    });
  });
});
```

검증: `pnpm --filter @finclaw/skills-finance test --run brokerage`

### A7. 밀스톤 A 검증

다음을 모두 통과해야 다음 밀스톤으로:

- `pnpm --filter @finclaw/skills-finance build`
- `pnpm --filter @finclaw/skills-finance test --run brokerage`
- `grep -rnE '\b(order|cancel|modify)\b' packages/skills-finance/src/brokerage/kis/` → **0건** (read-only 보증, 완료조건)

---

## 밀스톤 B — Holdings Sync (KIS-as-tool) + source 컬럼 마이그레이션

> **§B-5/B-4/B-0 OVERRIDE.** plan B 본문의 "덮어씀"·`replaceAllHoldings(holdings)`·B3 action/payload schedule 은 다음으로 교정:
>
> - `portfolio_holdings` 에 `source TEXT NOT NULL DEFAULT 'tx'`('kis'|'tx') 추가 (**v11→v12**).
> - `recomputeHoldings` 는 `WHERE source='tx'` 만 DELETE/재계산 → KIS row 보존.
> - KIS sync 는 `source='kis'` 로 직접 INSERT (신규 `replaceAllHoldings`).
> - KIS sync 는 **agent tool**(`brokerage_sync_holdings`) — schedule action/payload 컬럼은 존재하지 않음(§B-4). 뉴스 cron prompt 가 tool 호출.

### B1. EDIT `packages/storage/src/database.ts` — v12 마이그레이션 (source 컬럼)

(1) `SCHEMA_VERSION` bump + (2) fresh DB DDL 의 `portfolio_holdings` 에 source 컬럼 + (3) MIGRATIONS[12] ALTER.

```ts
// database.ts:23
const SCHEMA_VERSION = 12;
```

```ts
// database.ts:148-155 — CREATE TABLE portfolio_holdings (fresh DB DDL)
CREATE TABLE IF NOT EXISTS portfolio_holdings (
  portfolio_id TEXT NOT NULL,
  symbol       TEXT NOT NULL,
  quantity     REAL NOT NULL,
  average_cost REAL NOT NULL,
  source       TEXT NOT NULL DEFAULT 'tx' CHECK (source IN ('tx','kis')),
  PRIMARY KEY (portfolio_id, symbol),
  FOREIGN KEY (portfolio_id) REFERENCES portfolios(id) ON DELETE CASCADE
);
```

```ts
// database.ts MIGRATIONS — 11: 블록 직후, 닫는 `};` 앞에 추가
  // Phase 33 B-5: portfolio_holdings.source — 'tx'(거래 파생) | 'kis'(브로커 동기화) 구분.
  // recomputeHoldings 가 KIS row 를 wipe 하지 않도록 분리.
  12: (db: DatabaseSync) => {
    const cols = db.prepare(`PRAGMA table_info('portfolio_holdings')`).all() as Array<{ name: string }>;
    if (!cols.some((c) => c.name === 'source')) {
      // 기존 row 는 모두 transactions 파생 → DEFAULT 'tx'.
      db.exec(
        `ALTER TABLE portfolio_holdings ADD COLUMN source TEXT NOT NULL DEFAULT 'tx' CHECK (source IN ('tx','kis'));`,
      );
    }
  },
```

> 주의: `database.migration.storage.test.ts` 의 기존 `describe('schema migration v5 → v11')` 와 `expect(upgraded.schemaVersion).toBe(11)` 는 **12 로 갱신해야 회귀 통과**(B6 테스트 단계에서 처리).

검증: `pnpm --filter @finclaw/storage build`

### B2. EDIT `packages/storage/src/transactions.ts` — `recomputeHoldings` 가 tx 영역만 처리 + `replaceAllHoldings` 신규

`recomputeHoldings` DELETE 와 INSERT 를 `source='tx'` 한정으로 교정 (KIS row 보존):

```ts
// transactions.ts:100-101 — DELETE 를 source='tx' 한정
// 1) 현재 tx-파생 holdings 만 비우기 (KIS row 보존 — Phase 33 B-5)
db.prepare(`DELETE FROM portfolio_holdings WHERE portfolio_id = ? AND source = 'tx'`).run(
  portfolioId,
);
```

```ts
// transactions.ts:153-156 — INSERT 에 source='tx' 명시
const insert = db.prepare(
  `INSERT INTO portfolio_holdings (portfolio_id, symbol, quantity, average_cost, source)
       VALUES (?, ?, ?, ?, 'tx')`,
);
```

파일 말미에 KIS 영역 전면 교체 메서드 신규 (Q2 가정: kis 영역만 DELETE 후 재INSERT):

```ts
// transactions.ts (말미에 추가)

/** Phase 33 B-5: KIS 동기화 결과로 source='kis' holdings 를 전면 교체. tx 영역은 무관. */
export interface KisHoldingInput {
  symbol: string;
  quantity: number;
  averageCost: number;
}

export function replaceAllHoldings(
  db: DatabaseSync,
  portfolioId: string,
  holdings: readonly KisHoldingInput[],
): void {
  db.exec('BEGIN IMMEDIATE');
  try {
    // KIS 영역만 비우기 → 매도되어 응답에서 빠진 종목 자동 정리. tx 영역 보존.
    db.prepare(`DELETE FROM portfolio_holdings WHERE portfolio_id = ? AND source = 'kis'`).run(
      portfolioId,
    );
    const insert = db.prepare(
      `INSERT INTO portfolio_holdings (portfolio_id, symbol, quantity, average_cost, source)
       VALUES (?, ?, ?, ?, 'kis')
       ON CONFLICT(portfolio_id, symbol) DO UPDATE SET
         quantity = excluded.quantity, average_cost = excluded.average_cost, source = 'kis'`,
    );
    for (const h of holdings) {
      if (h.quantity > 0) {
        insert.run(portfolioId, h.symbol, h.quantity, h.averageCost);
      }
    }
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}
```

> 참고(§B-5): `skills-finance/src/news/portfolio/store.ts:73` `upsertHolding` 의 INSERT 는 source 미지정 → DEFAULT 'tx' 로 흡수. 손대지 않음(질문 Q1). `ON CONFLICT` 시 KIS row 를 tx 로 덮을 이론적 가능성은 1인·단일계좌 전제에서 무시.

검증: `pnpm --filter @finclaw/storage build`

### B3. EDIT `packages/storage/src/index.ts` — `replaceAllHoldings` export

```ts
// index.ts — recomputeHoldings export(L93 부근) 옆에 추가
  recomputeHoldings,
  replaceAllHoldings,
```

그리고 type re-export 가 모이는 곳에 `export type { KisHoldingInput } from './transactions.js';` 추가.

검증: `pnpm --filter @finclaw/storage build`

### B4. CREATE `packages/storage/src/portfolio-holdings.migration.storage.test.ts` — v11→v12 + KIS row 보존

- (1) v11 DB 수동 생성(source 컬럼 없음) → openDatabase → v12, source='tx' DEFAULT 채워짐 + idempotency(두 번 열어도 OK).
- (2) **핵심: KIS row 보존** — source='kis' row 직접 INSERT 후 `addTransaction`/`recomputeHoldings` 호출 → KIS row 가 살아있고 tx row 만 재계산되는지.
- (3) `replaceAllHoldings` 가 kis 영역만 교체(tx 보존, 매도 종목 정리).

```ts
// packages/storage/src/portfolio-holdings.migration.storage.test.ts
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import * as sqliteVec from 'sqlite-vec';
import { describe, expect, it } from 'vitest';
import { openDatabase } from './database.js';
import { addTransaction, recomputeHoldings, replaceAllHoldings } from './transactions.js';

function seedV11(path: string): void {
  const db = new DatabaseSync(path, { allowExtension: true });
  sqliteVec.load(db);
  db.enableLoadExtension(false);
  db.exec(`CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);`);
  db.exec(
    `CREATE TABLE portfolios (id TEXT PRIMARY KEY, name TEXT NOT NULL, currency TEXT NOT NULL DEFAULT 'USD', updated_at INTEGER NOT NULL);`,
  );
  db.exec(
    `CREATE TABLE portfolio_holdings (portfolio_id TEXT NOT NULL, symbol TEXT NOT NULL, quantity REAL NOT NULL, average_cost REAL NOT NULL, PRIMARY KEY (portfolio_id, symbol));`,
  );
  db.prepare(
    `INSERT INTO portfolios (id,name,currency,updated_at) VALUES ('p1','main','USD',?)`,
  ).run(Date.now());
  db.prepare(
    `INSERT INTO portfolio_holdings (portfolio_id,symbol,quantity,average_cost) VALUES ('p1','AAPL',3,100)`,
  ).run();
  db.prepare(`INSERT INTO meta (key,value) VALUES ('schema_version','11')`).run();
  db.close();
}

describe('portfolio_holdings v11 → v12 (source 컬럼)', () => {
  it('마이그레이션: 기존 row 는 source=tx, idempotent', () => {
    const dir = mkdtempSync(join(tmpdir(), 'phase33-mig-'));
    const path = join(dir, 'db.sqlite');
    try {
      seedV11(path);
      const up = openDatabase({ path, enableWAL: false });
      expect(up.schemaVersion).toBe(12);
      const row = up.db
        .prepare(`SELECT source FROM portfolio_holdings WHERE symbol='AAPL'`)
        .get() as { source: string };
      expect(row.source).toBe('tx');
      up.close();
      // 재오픈 idempotent
      const up2 = openDatabase({ path, enableWAL: false });
      expect(up2.schemaVersion).toBe(12);
      up2.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('recomputeHoldings 는 KIS row 를 보존한다', () => {
    const dir = mkdtempSync(join(tmpdir(), 'phase33-kis-'));
    const path = join(dir, 'db.sqlite');
    try {
      seedV11(path);
      const { db, close } = openDatabase({ path, enableWAL: false });
      // KIS row 직접 주입
      db.prepare(
        `INSERT INTO portfolio_holdings (portfolio_id,symbol,quantity,average_cost,source) VALUES ('p1','NVDA',5,800,'kis')`,
      ).run();
      // 사용자 수동 거래 → recomputeHoldings 트리거
      addTransaction(db, {
        portfolioId: 'p1',
        symbol: 'AAPL' as never,
        action: 'buy',
        quantity: 2,
        price: 110,
        currency: 'USD' as never,
        executedAt: Date.now() as never,
        source: 'manual',
      });
      const kis = db
        .prepare(`SELECT quantity FROM portfolio_holdings WHERE symbol='NVDA' AND source='kis'`)
        .get() as { quantity: number } | undefined;
      expect(kis?.quantity).toBe(5); // 보존됨
      close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('replaceAllHoldings 는 kis 영역만 전면 교체', () => {
    const dir = mkdtempSync(join(tmpdir(), 'phase33-rep-'));
    const path = join(dir, 'db.sqlite');
    try {
      seedV11(path);
      const { db, close } = openDatabase({ path, enableWAL: false });
      db.prepare(
        `INSERT INTO portfolio_holdings (portfolio_id,symbol,quantity,average_cost,source) VALUES ('p1','OLD',1,1,'kis')`,
      ).run();
      replaceAllHoldings(db, 'p1', [{ symbol: 'NVDA', quantity: 5, averageCost: 800 }]);
      const old = db.prepare(`SELECT 1 FROM portfolio_holdings WHERE symbol='OLD'`).get();
      const tx = db.prepare(`SELECT source FROM portfolio_holdings WHERE symbol='AAPL'`).get() as {
        source: string;
      };
      expect(old).toBeUndefined(); // 매도 종목 정리
      expect(tx.source).toBe('tx'); // tx 영역 보존
      close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
```

검증: `pnpm --filter @finclaw/storage test --run portfolio-holdings.migration`

### B5. CREATE `packages/server/src/services/brokerage-sync-service.ts` — KIS 응답 → portfolio_holdings replace

KIS client 조회 → `replaceAllHoldings(source='kis')`. portfolio 미존재 시 기본 portfolio 생성/조회 (1인 사용자, finance.ts 의 portfolio 조회 패턴 재사용). market='US' 의 USD 평단은 그대로 저장(환산 없음 — Q6).

```ts
// packages/server/src/services/brokerage-sync-service.ts
import type { DatabaseSync } from 'node:sqlite';
import type { FinClawLogger } from '@finclaw/infra';
import { replaceAllHoldings } from '@finclaw/storage';
import { type KisClient, fetchNormalizedHoldings } from '@finclaw/skills-finance';

export interface BrokerageSyncResult {
  readonly syncedAt: number;
  readonly holdingsCount: number;
  readonly marketsScanned: ReadonlyArray<'KR' | 'US'>;
  readonly errors: ReadonlyArray<{ market: string; message: string }>;
}

export interface BrokerageSyncDeps {
  readonly db: DatabaseSync;
  readonly client: KisClient;
  readonly logger: FinClawLogger;
  /** 1인 사용자 기본 portfolio id 조회/보장. */
  readonly resolvePortfolioId: () => string;
}

export class BrokerageSyncService {
  constructor(private readonly deps: BrokerageSyncDeps) {}

  /** read-only KIS 호출 + holdings(source='kis') 전면 교체. */
  async run(): Promise<BrokerageSyncResult> {
    const syncedAt = Date.now();
    const holdings = await fetchNormalizedHoldings(this.deps.client);
    const portfolioId = this.deps.resolvePortfolioId();
    replaceAllHoldings(
      this.deps.db,
      portfolioId,
      holdings.map((h) => ({
        symbol: h.symbol,
        quantity: h.quantity,
        averageCost: h.averagePrice,
      })),
    );
    const markets = [...new Set(holdings.map((h) => h.market))];
    this.deps.logger.info('brokerage.sync.completed', {
      event: 'brokerage.sync.completed',
      holdingsCount: holdings.length,
      markets,
    });
    return { syncedAt, holdingsCount: holdings.length, marketsScanned: markets, errors: [] };
  }
}
```

검증: `pnpm --filter @finclaw/server build`

### B6. EDIT `packages/storage/src/database.migration.storage.test.ts` — 기대 버전 11→12 회귀 갱신

```ts
// describe 제목 + assertion (외과적: 숫자만)
describe('schema migration v5 → v12', () => {
  // ...
  expect(upgraded.schemaVersion).toBe(12);
```

> CLAUDE.md §3: 어긋난 숫자만 수정. 다른 검증 로직은 손대지 않음.

검증: `pnpm --filter @finclaw/storage test --run database.migration`

### B7. CREATE `packages/skills-finance/src/brokerage/tools.ts` — `brokerage_sync_holdings` agent tool (§B-4)

KIS sync 를 **agent tool** 로 등록 (market/index.ts 의 `register*Tool` 패턴). cron prompt 가 호출. `requiresApproval:false`, `isTransactional:false`(read-only KIS), `accessesSensitiveData:true`(계좌), `isExternal:true`.

```ts
// packages/skills-finance/src/brokerage/tools.ts
import type { RegisteredToolDefinition, ToolExecutor, ToolRegistry } from '@finclaw/agent';

export interface BrokerageToolDeps {
  /** server 의 BrokerageSyncService.run 을 감싼 콜백 (skills-finance→server 역참조 회피). */
  readonly syncHoldings: () => Promise<{
    holdingsCount: number;
    marketsScanned: readonly string[];
  }>;
}

export function registerBrokerageTools(registry: ToolRegistry, deps: BrokerageToolDeps): void {
  const def: RegisteredToolDefinition = {
    name: 'brokerage_sync_holdings',
    description:
      '한국투자증권(KIS) 계좌의 보유 종목 잔고를 조회하여 포트폴리오를 동기화합니다. read-only(매매 없음). 뉴스 요약 전에 호출하여 최신 보유 종목을 확보하세요.',
    inputSchema: { type: 'object', properties: {}, required: [] },
    group: 'finance',
    requiresApproval: false,
    isTransactional: false,
    accessesSensitiveData: true,
    isExternal: true,
    timeoutMs: 30_000,
  };
  const executor: ToolExecutor = async () => {
    try {
      const r = await deps.syncHoldings();
      return {
        content: `잔고 동기화 완료: ${r.holdingsCount}개 종목 (시장: ${r.marketsScanned.join(', ') || '없음'})`,
        isError: false,
      };
    } catch (error) {
      return { content: error instanceof Error ? error.message : String(error), isError: true };
    }
  };
  registry.register(def, executor, 'skill');
}
```

`packages/skills-finance/src/index.ts` 에 export 추가:

```ts
export { registerBrokerageTools } from './brokerage/tools.js';
export type { BrokerageToolDeps } from './brokerage/tools.js';
```

검증: `pnpm --filter @finclaw/skills-finance build`

### B8. CREATE `packages/server/test/services/brokerage-sync-service.test.ts` — mock KIS client

- mock `KisClient.fetchBalances` (fetch mock 주입한 KisClient 또는 stub) → run() → in-memory DB 의 portfolio_holdings 에 source='kis' row 적재 검증.

```ts
// packages/server/test/services/brokerage-sync-service.test.ts
import { describe, expect, it, vi } from 'vitest';
import { openDatabase } from '@finclaw/storage';
import { KisClient, KisTokenManager } from '@finclaw/skills-finance';
import type { KisCredentials } from '@finclaw/skills-finance';
import { BrokerageSyncService } from '../../src/services/brokerage-sync-service.js';

const CREDS: KisCredentials = {
  env: 'vts',
  appKey: 'k',
  appSecret: 's',
  accountNo: '50000000',
  accountProductCode: '01',
};
const noopLogger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as never;

function res(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status });
}

describe('BrokerageSyncService', () => {
  it('KIS 응답 → portfolio_holdings(source=kis) 적재', async () => {
    const fetchFn = vi.fn(async (url: string | URL) => {
      const u = String(url);
      if (u.endsWith('/oauth2/tokenP')) return res({ access_token: 't', expires_in: 86400 });
      if (u.includes('domestic'))
        return res({
          output1: [{ pdno: '005930', hldg_qty: '10', pchs_avg_pric: '70000', prpr: '72000' }],
        });
      return res({
        output1: [
          { ovrs_pdno: 'NVDA', ovrs_cblc_qty: '5', pchs_avg_pric: '800', now_pric2: '900' },
        ],
      });
    }) as unknown as typeof fetch;

    const { db, close } = openDatabase({ path: ':memory:', enableWAL: false });
    db.prepare(
      `INSERT INTO portfolios (id,name,currency,updated_at) VALUES ('p1','main','USD',?)`,
    ).run(Date.now());
    const client = new KisClient(CREDS, new KisTokenManager(CREDS, fetchFn), fetchFn);
    const svc = new BrokerageSyncService({
      db,
      client,
      logger: noopLogger,
      resolvePortfolioId: () => 'p1',
    });

    const r = await svc.run();
    expect(r.holdingsCount).toBe(2);
    const rows = db
      .prepare(`SELECT symbol, source FROM portfolio_holdings ORDER BY symbol`)
      .all() as Array<{ symbol: string; source: string }>;
    expect(rows.every((x) => x.source === 'kis')).toBe(true);
    close();
  });
});
```

검증: `pnpm --filter @finclaw/server test --run brokerage-sync-service`

### B9. 밀스톤 B 검증

- `pnpm --filter @finclaw/storage build && pnpm --filter @finclaw/skills-finance build && pnpm --filter @finclaw/server build`
- `pnpm --filter @finclaw/storage test --run portfolio-holdings.migration database.migration`
- `pnpm --filter @finclaw/server test --run brokerage-sync-service`
- `pnpm typecheck` (회귀 0)

---

## 밀스톤 C — News Brief 자동 메모리화 (onRunComplete hook)

> **§B-1/B-2/B-3 OVERRIDE.** plan C 본문의 `createMemory`/`tags`/`archiveOlderThan`/`memory-capture.ts`/`schedule.tags`/`delivery.ts 후속 hook` 은 모두 교정:
>
> - 저장 = `addMemoryWithEmbedding(db, entry, provider)`. metadata JSON 에 `{kind:'news-brief',symbol,briefDate}` (tags 컬럼 없음).
> - archival 코드 **없음** — 신선도 반감기 90일 자연 감쇠만(`FRESHNESS_HALF_LIFE_DAYS`). archived 컬럼은 후속.
> - 적재 hook = `scheduler.ts:411 onRunComplete` → `main.ts:640 deliveryHook` 분기. `memory-capture.ts` 재사용 X.
> - schedule 식별 = id 화이트리스트 `'news-brief-daily'` (schedule.tags 없음; Q3).

### C1. CREATE `packages/server/src/services/news-memorizer.ts` — agent_runs.output → memories

- `parseSymbolSections(output)` : `## SYMBOL (YYYY-MM-DD)` 헤딩 분할 (Q4 가정).
- 각 섹션 → `addMemoryWithEmbedding(db, entry, provider)`, type='financial', metadata `{kind:'news-brief',symbol,briefDate,sourceAgentRunId}`.
- embeddingProvider 없으면 `addMemory`(FTS-only) fallback. 파싱 0 섹션 → skip + warn.

```ts
// packages/server/src/services/news-memorizer.ts
import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type { FinClawLogger } from '@finclaw/infra';
import type { EmbeddingProvider } from '@finclaw/storage';
import { addMemory, addMemoryWithEmbedding } from '@finclaw/storage';
import { createSessionKey, type MemoryEntry, type Timestamp } from '@finclaw/types';

const SECTION_RE = /^##\s+([A-Z0-9.]{1,12})\s+\((\d{4}-\d{2}-\d{2})\)\s*$/gm;

export interface SymbolSection {
  readonly symbol: string;
  readonly briefDate: string;
  readonly summary: string;
}

/** `## SYMBOL (YYYY-MM-DD)` 헤딩으로 본문을 심볼별 섹션 분할. */
export function parseSymbolSections(output: string): SymbolSection[] {
  const matches = [...output.matchAll(SECTION_RE)];
  const sections: SymbolSection[] = [];
  for (let i = 0; i < matches.length; i++) {
    const m = matches[i];
    const start = (m.index ?? 0) + m[0].length;
    const end = i + 1 < matches.length ? (matches[i + 1].index ?? output.length) : output.length;
    const summary = output.slice(start, end).trim();
    if (summary.length > 0) {
      sections.push({ symbol: m[1], briefDate: m[2], summary });
    }
  }
  return sections;
}

export interface NewsMemorizerDeps {
  readonly db: DatabaseSync;
  readonly embeddingProvider?: EmbeddingProvider;
  readonly logger: FinClawLogger;
  /** memories.session_key — cron 적재용 고정 키. */
  readonly sessionKey?: string;
}

export class NewsMemorizer {
  constructor(private readonly deps: NewsMemorizerDeps) {}

  /** scheduler onRunComplete 에서 호출. output 을 심볼별 financial memory 로 적재. */
  async absorb(args: { agentRunId: string | null; output: string }): Promise<number> {
    const sections = parseSymbolSections(args.output);
    if (sections.length === 0) {
      this.deps.logger.warn('news_memorizer.no_sections', {
        event: 'news_memorizer.no_sections',
        agentRunId: args.agentRunId,
      });
      return 0;
    }
    const sessionKey = createSessionKey(this.deps.sessionKey ?? 'news-brief');
    let stored = 0;
    for (const s of sections) {
      const entry: MemoryEntry = {
        id: randomUUID(),
        sessionKey,
        content: `[${s.briefDate}] ${s.symbol} 뉴스 요약: ${s.summary}`,
        type: 'financial',
        createdAt: Date.now() as Timestamp,
        metadata: {
          kind: 'news-brief',
          symbol: s.symbol,
          briefDate: s.briefDate,
          sourceAgentRunId: args.agentRunId,
        },
      };
      // content sha256 dedup 은 addMemory 가 자동 처리.
      if (this.deps.embeddingProvider) {
        await addMemoryWithEmbedding(this.deps.db, entry, this.deps.embeddingProvider);
      } else {
        addMemory(this.deps.db, entry);
      }
      stored++;
    }
    this.deps.logger.info('news_memorizer.absorbed', {
      event: 'news_memorizer.absorbed',
      agentRunId: args.agentRunId,
      stored,
    });
    return stored;
  }
}
```

검증: `pnpm --filter @finclaw/server build`

### C2. CREATE `packages/agent/src/prompts/news-brief.ts` — 출력 포맷 강제 prompt (§plan C3)

cron prompt 가 `## {SYMBOL} ({YYYY-MM-DD})` 포맷을 강제하도록. agent 패키지에 상수로(server 가 schedule prompt 로 주입).

```ts
// packages/agent/src/prompts/news-brief.ts

/**
 * Phase 33 C3: 매일 뉴스 브리프 cron prompt.
 * 출력 포맷을 강제 → news-memorizer 의 parseSymbolSections 가 심볼별로 적재한다.
 * §B-4: 먼저 brokerage_sync_holdings 로 잔고를 갱신 후 보유 종목 뉴스 요약.
 */
export const NEWS_BRIEF_PROMPT = `먼저 brokerage_sync_holdings 도구로 보유 종목 잔고를 동기화하라.
그다음 각 보유 종목에 대해 지난 24시간 뉴스를 조사하고 한국어로 요약하라.

반드시 아래 포맷을 종목마다 정확히 지켜라 (자동 적재에 사용된다):

## {티커 또는 종목코드} ({오늘 날짜 YYYY-MM-DD})
어제 대비 변화와 핵심 뉴스를 3~5문장으로 요약.

예:
## NVDA (2026-05-21)
어제 대비 ... 핵심 뉴스 ...

## 005930 (2026-05-21)
삼성전자 관련 ...

보유 종목이 없으면 "보유 종목 없음" 만 출력하라.`;

/** §B-3: news-memorizer 가 식별하는 고정 schedule id (Q3). */
export const NEWS_BRIEF_SCHEDULE_ID = 'news-brief-daily';
```

> `packages/agent/src/index.ts` 에 re-export 확인/추가 (prompts barrel 존재 시 따름).

검증: `pnpm --filter @finclaw/agent build`

### C3. EDIT `packages/server/src/main.ts` — onRunComplete 에 news-memorizer 분기 + brokerage tool 배선

(1) §B-6 KIS 키 로드 + 미설정 시 skip (밀스톤 D D1 과 함께; 여기선 sync service/tool 배선만), (2) `NEWS_BRIEF_SCHEDULE_ID` 매칭 시 absorb.

`onRunComplete`(main.ts:640) 분기 추가:

```ts
// main.ts — NewsMemorizer 인스턴스 (scheduler 생성 전, embeddingProvider 가용 시점)
const newsMemorizer = new NewsMemorizer({
  db: storage.db,
  embeddingProvider,
  logger,
  sessionKey: 'news-brief',
});
```

```ts
// main.ts:640 — onRunComplete 콜백 확장 (deliveryHook 호출은 유지)
    onRunComplete: async (args) => {
      if (deliveryHook) {
        await deliveryHook(args);
      }
      // Phase 33 C: news-brief schedule 출력만 memories 로 적재 (§B-3 id 화이트리스트).
      if (args.schedule.id === NEWS_BRIEF_SCHEDULE_ID && !args.error) {
        try {
          await newsMemorizer.absorb({ agentRunId: args.agentRunId, output: args.output });
        } catch (memErr) {
          logger.warn('news_memorizer.failed', {
            event: 'news_memorizer.failed',
            error: (memErr as Error).message,
          });
        }
      }
    },
```

brokerage tool 배선 (§B-4/B-6) — market/news 등록(main.ts:351-411) 패턴 옆에 추가:

```ts
// main.ts — KIS 키 로드 + 미설정 시 brokerage 등록 skip (market/news L361-382 패턴)
const kisAppKey = process.env.KIS_APP_KEY;
const kisAppSecret = process.env.KIS_APP_SECRET;
const kisAccountNo = process.env.KIS_ACCOUNT_NO;
const kisAccountProductCode = process.env.KIS_ACCOUNT_PRODUCT_CODE ?? '01';
const kisEnv = (process.env.KIS_ENV ?? 'prod') as 'prod' | 'vts';

let brokerageSyncService: BrokerageSyncService | undefined;
if (kisAppKey && kisAppSecret && kisAccountNo) {
  const creds = {
    env: kisEnv,
    appKey: kisAppKey,
    appSecret: kisAppSecret,
    accountNo: kisAccountNo,
    accountProductCode: kisAccountProductCode,
  };
  const kisClient = new KisClient(creds, new KisTokenManager(creds));
  brokerageSyncService = new BrokerageSyncService({
    db: storage.db,
    client: kisClient,
    logger,
    resolvePortfolioId: () => resolveDefaultPortfolioId(storage.db), // 기존 finance.ts portfolio 조회 헬퍼 재사용/추출
  });
  registerBrokerageTools(toolRegistry, {
    syncHoldings: async () => {
      const r = await brokerageSyncService!.run();
      return { holdingsCount: r.holdingsCount, marketsScanned: r.marketsScanned };
    },
  });
  logger.info('Brokerage (KIS) tools registered', { env: kisEnv });
} else {
  logger.info('KIS not configured — skipping brokerage tools');
}
```

> import 추가: `KisClient`, `KisTokenManager`, `registerBrokerageTools` (`@finclaw/skills-finance`), `BrokerageSyncService`(`./services/brokerage-sync-service.js`), `NewsMemorizer`(`./services/news-memorizer.js`), `NEWS_BRIEF_SCHEDULE_ID`(`@finclaw/agent`).
> `resolveDefaultPortfolioId` — finance.ts:55-65 의 portfolio 조회 로직을 storage 헬퍼로 추출하거나 main 내 inline (1인 사용자 기본 portfolio 보장).

검증: `pnpm --filter @finclaw/server build`

### C4. CREATE `packages/server/test/services/news-memorizer.test.ts` — 파싱 + 적재 + 회상

- (1) parseSymbolSections: 2섹션 분할 + 빈 섹션 제외.
- (2) absorb: in-memory DB(embeddingProvider 없음=FTS) → memories 2 row, type='financial', metadata.kind='news-brief'.
- (3) dedup: 동일 content 재적재 → row 증가 0.
- (4) 회상: 적재 후 `searchFts(db,'NVDA')` 또는 retrieval service 가 해당 memory 발견 (신선도 days=1 → 임계 0.65 통과). FTS-only 경로로 검증.

```ts
// packages/server/test/services/news-memorizer.test.ts
import { describe, expect, it, vi } from 'vitest';
import { openDatabase } from '@finclaw/storage';
import { NewsMemorizer, parseSymbolSections } from '../../src/services/news-memorizer.js';

const noopLogger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as never;

const OUTPUT = `## NVDA (2026-05-21)
어제 대비 5% 상승. 데이터센터 수요 강세.

## AAPL (2026-05-21)
WWDC 기대감으로 보합.`;

describe('news-memorizer', () => {
  it('parseSymbolSections 분할', () => {
    const s = parseSymbolSections(OUTPUT);
    expect(s).toHaveLength(2);
    expect(s[0]).toMatchObject({ symbol: 'NVDA', briefDate: '2026-05-21' });
  });

  it('absorb → financial memory 적재 + metadata.kind', async () => {
    const { db, close } = openDatabase({ path: ':memory:', enableWAL: false });
    const m = new NewsMemorizer({ db, logger: noopLogger }); // embeddingProvider 없음 → FTS only
    const n = await m.absorb({ agentRunId: 'run-1', output: OUTPUT });
    expect(n).toBe(2);
    const rows = db.prepare(`SELECT type, metadata FROM memories ORDER BY content`).all() as Array<{
      type: string;
      metadata: string;
    }>;
    expect(rows.every((r) => r.type === 'financial')).toBe(true);
    expect(JSON.parse(rows[0].metadata).kind).toBe('news-brief');
    close();
  });

  it('동일 content dedup', async () => {
    const { db, close } = openDatabase({ path: ':memory:', enableWAL: false });
    const m = new NewsMemorizer({ db, logger: noopLogger });
    await m.absorb({ agentRunId: 'r1', output: OUTPUT });
    await m.absorb({ agentRunId: 'r2', output: OUTPUT });
    const count = db.prepare(`SELECT COUNT(*) c FROM memories`).get() as { c: number };
    expect(count.c).toBe(2); // 중복 적재 안 됨
    close();
  });

  it('0 섹션 → skip', async () => {
    const { db, close } = openDatabase({ path: ':memory:', enableWAL: false });
    const m = new NewsMemorizer({ db, logger: noopLogger });
    const n = await m.absorb({ agentRunId: 'r', output: '뉴스 없음' });
    expect(n).toBe(0);
    close();
  });
});
```

검증: `pnpm --filter @finclaw/server test --run news-memorizer`

### C5. 밀스톤 C 검증

- `pnpm --filter @finclaw/agent build && pnpm --filter @finclaw/server build`
- `pnpm --filter @finclaw/server test --run news-memorizer`
- `pnpm typecheck`

---

## 밀스톤 D — Secret 관리 + 에러 회복 + 수동 sync 가시성

> **§B-6 OVERRIDE.** `config/loader.ts` 없음 → main.ts `process.env`(C3 에서 이미 KIS 키 로드). 본 밀스톤은 (1) redact 패턴 (2) 에러 회복 (3) 수동 sync RPC + web 가시성.

### D1. EDIT `packages/agent/src/agents/tools/result-guard.ts` — KIS Bearer 토큰 redact

```ts
// result-guard.ts:26-30 — FINANCIAL_REDACT_PATTERNS 에 KIS Bearer 추가
export const FINANCIAL_REDACT_PATTERNS: readonly RegExp[] = [
  /\b\d{4}[-\s]?\d{4}[-\s]?\d{4}[-\s]?\d{4}\b/g, // 카드번호
  /\b\d{3}-\d{2}-\d{4}\b/g, // SSN
  /\b\d{10,14}\b/g, // 계좌번호 (10-14자리)
  /Bearer\s+[A-Za-z0-9._-]{20,}/g, // Phase 33 D: KIS access token (Bearer eyJ...)
];
```

검증: `pnpm --filter @finclaw/agent test --run result-guard` (기존 테스트 + 신규 케이스 추가 권장)

### D2. EDIT `packages/skills-finance/src/brokerage/kis/client.ts` — 에러 회복 (retry + backoff)

plan D2 표: token_expired→재발급+retry1, rate_limit→backoff(1→2→4, max3), network→retry1, auth→non-recoverable. `get()` 호출을 `withRetry` 로 감싼다 (KisError.recoverable + kind 기반).

```ts
// client.ts — get() 내부를 retry 래퍼로. (간략 골격)
  private async withRetry<T>(fn: () => Promise<T>, attempt = 0): Promise<T> {
    try {
      return await fn();
    } catch (err) {
      if (err instanceof KisError && err.recoverable && attempt < 3) {
        if (err.kind === 'token_expired' || err.kind === 'auth') this.tokens.invalidate();
        const delay = err.kind === 'rate_limit' ? 1000 * 2 ** attempt : 500;
        await new Promise((r) => setTimeout(r, delay));
        return this.withRetry(fn, attempt + 1);
      }
      throw err;
    }
  }
```

> `fetchBalances` 의 각 `get` 을 `this.withRetry(() => this.get(...))` 로 감싼다. token_expired 는 KIS 가 특정 코드(EGW00123 등) 로 반환 — auth get 에서 토큰 만료 시 invalidate 후 재시도. test 에서 만료 시뮬레이션.

검증: `pnpm --filter @finclaw/skills-finance test --run brokerage`

### D3. EDIT `packages/server/src/gateway/rpc/methods/brokerage.ts` — 수동 sync RPC (web 버튼용, 최소)

§B-4 에서 자동화는 tool 이지만, web settings 의 "수동 sync 버튼" 은 RPC 가 필요(Q5). 최소 1개: `brokerage.sync.run`(현 user 기준, dryRun 없이) + `brokerage.health.get`(마지막 sync/토큰 상태).

```ts
// packages/server/src/gateway/rpc/methods/brokerage.ts (신규, 최소)
import type { DatabaseSync } from 'node:sqlite';
import type { BrokerageSyncService } from '../../../services/brokerage-sync-service.js';

export interface BrokerageRpcDeps {
  readonly db: DatabaseSync;
  readonly syncService?: BrokerageSyncService; // KIS 미설정 시 undefined
}

export function registerBrokerageRpc(/* register fn, deps */): void {
  // brokerage.sync.run: syncService?.run() — 미설정 시 not_configured 에러
  // brokerage.health.get: 마지막 sync 시각(holdings source='kis' max?) + KIS env 표시
  // (Zod 스키마는 packages/types/src/gateway.ts 에 input:{} output:{...} 추가)
}
```

> Zod 스키마 + 등록은 기존 finance/memory RPC 등록 패턴(`gateway/rpc/methods/*` + `types/src/gateway.ts`) 따름. 1인 사용자라 input 은 `{}`.

검증: `pnpm --filter @finclaw/server build`

### D4. EDIT `packages/web/src/components/settings-view.ts` — Brokerage 섹션 (plan D3)

- 마지막 동기화 시각, KIS 환경(prod/vts), 수동 sync 버튼(`brokerage.sync.run` 호출), 최근 결과. 계좌번호 표시 시 마스킹(`12345***`).

검증: `pnpm --filter @finclaw/web build`

### D5. EDIT `.env.example` + `README.md` — KIS 환경변수 문서화

```sh
# .env.example (추가)
# 한국투자증권 KIS Open API (read-only 잔고 동기화). 미설정 시 brokerage 기능 비활성.
KIS_ENV=prod              # prod(실전) | vts(모의)
KIS_APP_KEY=
KIS_APP_SECRET=
KIS_ACCOUNT_NO=           # CANO (8자리)
KIS_ACCOUNT_PRODUCT_CODE=01
```

README 환경변수 섹션에 동일 + "자동화는 SDK 모드 전용(§B-0): provider 미지정 또는 anthropic-sdk. CLI 모드에서는 KIS sync/뉴스 tool 이 비활성" 명시.

검증: `grep -q KIS_APP_KEY .env.example`

### D6. 밀스톤 D 검증

- `pnpm --filter @finclaw/agent test --run result-guard`
- `pnpm --filter @finclaw/skills-finance test --run brokerage`
- `pnpm --filter @finclaw/server build && pnpm --filter @finclaw/web build`
- 완료조건: `.env` 미설정 시 server 정상 부팅 + "KIS not configured" 로그 (수동 검증 / 통합 테스트 E2)

---

## 밀스톤 E (개발분) — 통합 시나리오 테스트

> plan 밀스톤 E 는 7일 무중단 검증(개발 X, 사용자 운영). 본 todo 는 그 전 단계의 **자동화 가능한 통합 테스트**(매일 시나리오 mock)만 코드로 포함. 실제 7일 검증은 사용자 운영 체크리스트(plan E)로 위임.

### E1. CREATE `packages/server/test/integration/daily-brief.test.ts` — 매일 시나리오 mock

흐름 mock: (1) KIS mock 잔고 → `brokerage_sync_holdings`(tool) 또는 sync service → holdings(source='kis') 적재 → (2) news output(고정 포맷) → onRunComplete 가 `NEWS_BRIEF_SCHEDULE_ID` 매칭 → news-memorizer absorb → (3) memories 에 N row → (4) 다음날 retrieval 이 심볼 회상 (FTS-only 경로).

> scheduler 전체 기동 대신 onRunComplete 콜백을 직접 호출하는 경량 통합(외부 API·LLM mock). CLAUDE.md feedback: 키 없이 통과.

검증: `pnpm --filter @finclaw/server test --run daily-brief`

### E2. CREATE `packages/server/test/integration/kis-not-configured.test.ts` — 미설정 graceful

- KIS env 미설정 상태에서 brokerage tool 등록 skip 경로 + "KIS not configured" 로그 검증 (main 부팅 일부 또는 등록 헬퍼 단위).

검증: `pnpm --filter @finclaw/server test --run kis-not-configured`

### E3. 밀스톤 E(개발분) 검증

- `pnpm --filter @finclaw/server test --run integration`
- plan E 의 7일 운영 체크리스트는 사용자 수행 (코드 작업 아님). todo 범위 외임을 명시.

---

## 최종 검증

다음을 모두 통과해야 phase33 구현 완료:

- `pnpm typecheck` (회귀 0)
- `pnpm test --run` (전체 unit)
- `pnpm test:storage` (마이그레이션 v11→v12 + KIS row 보존 포함)
- `pnpm lint`
- `pnpm build`
- `pnpm format:fix` (oxfmt 가 package.json/소스 재정렬 — 강제 형식 X)
- lefthook pre-commit(typecheck + format) 통과
- read-only 보증: `grep -rnE '\b(order|cancel|modify)\b' packages/skills-finance/src/brokerage/` → 0건
- **CLI 모드 비양립 확인(§B-0):** `provider:'claude-cli'` 부팅 시 `provider.cli_tools_disabled` 경고가 brokerage tool 도 포함(toolCount 반영) — 자동화는 SDK 모드에서만.

---

## 롤백 절차

각 밀스톤이 독립 커밋이라면 `git revert {밀스톤 커밋}` 으로 단계적 롤백.

- 밀스톤 B(v12 마이그레이션)는 **DB 스키마 변경 포함** — revert 시 코드는 되돌아가나 이미 v12 로 올라간 DB 의 `source` 컬럼은 남는다(ALTER ADD COLUMN, NOT NULL DEFAULT 라 무해). 코드가 v11 로 돌아가도 `SELECT` 는 source 컬럼 무시하므로 호환. 단 `recomputeHoldings` 의 `WHERE source='tx'` 가 사라지면 KIS row 가 다시 wipe 될 수 있으므로, KIS 사용 중이면 B 단독 revert 비권장.
- 밀스톤 A/C/D 는 신규 파일·additive 변경 위주 → revert 안전.

---

## 보강 8개 반영 매핑 (검증용)

| 보강                     | 반영 위치                                                                                      |
| ------------------------ | ---------------------------------------------------------------------------------------------- |
| ★ B-0 (SDK 전용)         | 전역 전제(머리말) + 각 밀스톤 완료조건 + 최종 검증의 "CLI 비양립" + D5 README                  |
| B-1 (metadata)           | C1 `addMemoryWithEmbedding` + metadata `{kind,symbol,briefDate}`, C4 테스트                    |
| B-2 (archival=신선도)    | C 머리말 + C1 (명시적 archival 코드 없음)                                                      |
| B-3 (onRunComplete hook) | C3 (`main.ts:640` 분기, id 화이트리스트), C2 `NEWS_BRIEF_SCHEDULE_ID`, memory-capture 재사용 X |
| ★ B-4 (KIS-as-tool)      | B7 `registerBrokerageTools`, C2 prompt, C3 배선 (schedule action/payload 미사용)               |
| ★ B-5 (source 컬럼)      | B1 v12 마이그레이션, B2 recomputeHoldings/replaceAllHoldings, B4 storage test                  |
| B-6 (config/secret)      | C3 main.ts process.env 로드 + skip, D1 redact, D5 .env.example                                 |
| B-7 (라인/버전)          | B1 v11→v12, C3 memory-retrieval transactions=365-383 무변경, A KIS=providers 패턴              |
