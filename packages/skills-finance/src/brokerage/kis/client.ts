// packages/skills-finance/src/brokerage/kis/client.ts
import { KisTokenManager } from './auth.js';
import type { KisCredentials } from './types.js';
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
