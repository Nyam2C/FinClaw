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
