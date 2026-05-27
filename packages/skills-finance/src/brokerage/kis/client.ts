// packages/skills-finance/src/brokerage/kis/client.ts
import type { BrokerageClient } from '../types.js';
import { KisTokenManager } from './auth.js';
import { fetchNormalizedHoldings } from './holdings.js';
import type { KisCredentials, NormalizedHolding } from './types.js';
import { KisError } from './types.js';

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

export class KisClient implements BrokerageClient {
  private readonly bucket: TokenBucket;
  constructor(
    private readonly creds: KisCredentials,
    private readonly tokens: KisTokenManager,
    private readonly fetchFn: typeof fetch = fetch,
    now: () => number = Date.now,
    /** 테스트에서 backoff 지연 단축 주입 가능. 기본 setTimeout. */
    private readonly sleep: (ms: number) => Promise<void> = (ms) =>
      new Promise((r) => setTimeout(r, ms)),
  ) {
    this.bucket = new TokenBucket(creds.env === 'prod' ? 5 : 20, now);
  }

  /** Phase 41: BrokerageClient 구현 — fetchBalances + normalize 위임. */
  async fetchHoldings(): Promise<readonly NormalizedHolding[]> {
    return fetchNormalizedHoldings(this);
  }

  /** read-only: 한국 + 해외 잔고 원응답을 함께 조회. */
  async fetchBalances(): Promise<KisRawBalances> {
    const [domestic, overseas] = await Promise.all([
      this.withRetry(() =>
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
      ),
      this.withRetry(() =>
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
      ),
    ]);
    return { domestic, overseas };
  }

  /**
   * Phase 33 D2: 회복 정책. recoverable KisError 만 재시도(max 3).
   * - token_expired/auth: 토큰 무효화 후 재발급 재시도
   * - rate_limit: exponential backoff (1→2→4s)
   * - network/server: 고정 500ms
   * auth(non-recoverable)/그 외는 즉시 throw.
   */
  private async withRetry<T>(fn: () => Promise<T>, attempt = 0): Promise<T> {
    try {
      return await fn();
    } catch (err) {
      if (err instanceof KisError && err.recoverable && attempt < 3) {
        if (err.kind === 'token_expired' || err.kind === 'auth') {
          this.tokens.invalidate();
        }
        const delay = err.kind === 'rate_limit' ? 1000 * 2 ** attempt : 500;
        await this.sleep(delay);
        return this.withRetry(fn, attempt + 1);
      }
      throw err;
    }
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
